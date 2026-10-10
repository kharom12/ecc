'use strict';

/**
 * Agent Live Runner — launches and supervises headless `claude -p` runs.
 *
 * Security: prompts/messages travel on the child's stdin only, never in argv;
 * spawn uses shell:false; children run in their own process group so a stop
 * kills the whole tree. The child sees only an allowlisted environment, and the
 * ECC checkout is exposed read-only (see agent-live-runner-process.js). Records
 * are immutable and replaced on every change.
 */

const childProcess = require('child_process');
const crypto = require('crypto');
const { buildPrompt } = require('./agent-live-launch-catalog');
const { buildArgs, buildChildEnv, signalTree, waitSettled } = require('./agent-live-runner-process');
const { LINE_CAP, createLineParser, createTail, parseResultLine, redactText } = require('./agent-live-runner-stream');

const PREVIEW_LIMIT = 200;
const RESULT_LIMIT = 20000;
const STDERR_LIMIT = 8000;
const LIST_LIMIT = 50;
const RETAIN_LIMIT = 200;

const codeError = (code, message) => Object.assign(new Error(message || code), { code });
const TRUNCATED_RESULT = `The result line was too large (over ${LINE_CAP / 1024} KB) and was dropped; open the session transcript for the full output.`;
const validBudget = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

function freezeRecord(record) {
  record.turns.forEach(Object.freeze);
  Object.freeze(record.turns);
  return Object.freeze(record);
}

function createRunner(options = {}) {
  const {
    spawnFn = childProcess.spawn, claudeBin = 'claude', eccRoot, eventsPath, maxConcurrent = 3,
    timeoutMs = 3600000, graceMs = 5000, settleWaitMs = 5000, maxBudgetUsd = null, onChange = () => {},
    now = Date.now, randomUUID = crypto.randomUUID, buildPromptFn = buildPrompt
  } = options;
  if (typeof eccRoot !== 'string' || !eccRoot) throw new TypeError('createRunner: eccRoot is required');
  const budget = validBudget(maxBudgetUsd);

  const runs = new Map(); // sessionId -> immutable record
  const live = new Map(); // sessionId -> { child, timer, killTimer, stopping, settled }

  function commit(id, patch) {
    const next = freezeRecord({ ...runs.get(id), ...patch });
    runs.set(id, next);
    try {
      onChange(next);
    } catch (err) {
      console.error(`[agent-live-runner] onChange failed: ${err.message}`);
    }
    return next;
  }

  function endLastTurn(record, patch) {
    return record.turns.map((turn, index) => (index === record.turns.length - 1 ? { ...turn, ...patch } : turn));
  }

  function finish(id, patch) {
    const record = runs.get(id);
    return commit(id, { ...patch, turns: endLastTurn(record, { endedAt: patch.endedAt, exitCode: patch.exitCode }) });
  }

  function prune() {
    for (const [id, record] of runs) {
      if (runs.size <= RETAIN_LIMIT) return;
      if (!live.has(id) && record.status !== 'running') runs.delete(id);
    }
  }

  const timeoutMessage = () => `Timed out after ${timeoutMs}ms`;

  /** A kill that fails for any reason but "already gone" is logged and noted on the run, never swallowed. */
  function reportKillFailure(id, entry, signal, err) {
    console.error(`[AgentLive] failed to send ${signal} to run ${id}: ${err.code || ''} ${err.message}`.replace(/\s+/g, ' '));
    entry.killFailed = true;
    entry.note = `Could not ${signal === 'SIGKILL' ? 'kill' : 'stop'} the process (${err.code || err.message}); it may still be running.`;
    if (!entry.settled) commit(id, { stderrTail: entry.note });
  }

  /** Signal the run's process tree; false when the signal could not be delivered. */
  function sendSignal(id, entry, signal) {
    entry.lastSignal = signal;
    const err = signalTree(entry.child, signal);
    if (err) reportKillFailure(id, entry, signal, err);
    return !entry.killFailed;
  }

  /**
   * Shared kill path. A timeout reports as a failure; a user stop (default) as
   * 'stopped', but only when the signal was actually delivered.
   */
  function halt(id, entry, reason = 'stop') {
    entry.stopping = true;
    entry.timedOut = reason === 'timeout';
    entry.killFailed = false;
    clearTimeout(entry.timer);
    clearTimeout(entry.killTimer);
    const sent = sendSignal(id, entry, 'SIGTERM');
    if (sent || entry.timedOut) entry.killTimer = setTimeout(() => sendSignal(id, entry, 'SIGKILL'), graceMs);
    if (!sent && !entry.timedOut) {
      entry.stopping = false; // not stopped: the caller may retry
      return runs.get(id);
    }
    if (!entry.timedOut) return commit(id, { status: 'stopped', endedAt: now() });
    const reasonText = entry.note ? `${timeoutMessage()}\n${entry.note}` : timeoutMessage();
    return commit(id, { status: 'failed', endedAt: now(), isError: true, stderrTail: reasonText });
  }

  function launch(id, args, prompt, cwd) {
    const entry = {
      child: null, timer: null, killTimer: null, stopping: false, timedOut: false, settled: false,
      killFailed: false, killedNow: false, note: null, lastSignal: null, done: null, resolveDone: null
    };
    entry.done = new Promise(resolve => { entry.resolveDone = resolve; });
    let summary = { result: '', isError: false, costUsd: null };
    let gotResult = false;
    const parser = createLineParser(line => {
      const parsed = parseResultLine(line);
      if (parsed) { summary = parsed; gotResult = true; }
    });
    const stderr = createTail(STDERR_LIMIT * 2);

    function settle(code, signal, failure) {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      clearTimeout(entry.killTimer);
      live.delete(id);
      parser.end();
      const reason = failure || (entry.timedOut ? timeoutMessage() : null);
      const stderrTail = redactText([reason, entry.note, stderr.value()].filter(Boolean).join('\n'), STDERR_LIMIT, true);
      const broken = Boolean(reason) || (code !== 0 && !entry.stopping) || summary.isError;
      const status = entry.stopping && !entry.timedOut ? 'stopped' : broken ? 'failed' : 'done';
      const resultTruncated = !gotResult && parser.dropped() > 0;
      finish(id, {
        status, endedAt: now(), exitCode: code, signal: signal || null, stderrTail, resultTruncated,
        result: redactText(resultTruncated ? TRUNCATED_RESULT : summary.result, RESULT_LIMIT),
        isError: summary.isError || entry.timedOut, costUsd: summary.costUsd
      });
      prune();
      entry.resolveDone();
    }

    const env = buildChildEnv(process.env, eventsPath);
    let child;
    try {
      child = spawnFn(claudeBin, args, {
        cwd, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env
      });
    } catch (err) {
      live.set(id, entry);
      settle(null, null, `Failed to start ${claudeBin}: ${err.code || ''} ${err.message}`.replace(/\s+/g, ' '));
      return runs.get(id);
    }
    entry.child = child;
    live.set(id, entry);
    entry.timer = setTimeout(() => halt(id, entry, 'timeout'), timeoutMs);
    entry.timer.unref();
    child.stdout.on('data', chunk => parser.feed(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.stdin.on('error', () => {}); // EPIPE when the child exits before reading stdin; close handles the outcome
    child.on('error', err => {
      // A spawn failure (no pid) ends the run here; with a pid it is a failed signal (EPERM, ...).
      if (!child.pid) settle(null, null, `Failed to start ${claudeBin}: ${err.code || ''} ${err.message}`.replace(/\s+/g, ' '));
      else if (err.code !== 'ESRCH') reportKillFailure(id, entry, entry.lastSignal || 'signal', err);
    });
    child.on('close', (code, signal) => settle(code, signal, null));
    child.stdin.write(prompt);
    child.stdin.end();
    return child.pid ? commit(id, { pid: child.pid }) : runs.get(id);
  }

  function assertCapacity() {
    if (live.size >= maxConcurrent) throw codeError('too_many_runs', `At most ${maxConcurrent} runs may be active at once`);
  }

  const makeTurn = (prompt, permissionMode) => ({
    prompt: redactText(prompt, PREVIEW_LIMIT), permissionMode, startedAt: now(), endedAt: null, exitCode: null
  });

  function start({ item, task, cwd, permissionMode, model }) {
    assertCapacity();
    const id = randomUUID();
    const prompt = buildPromptFn(item, task);
    const args = buildArgs({ sessionId: id, permissionMode, model, budget, eccRoot, cwd });
    commit(id, {
      sessionId: id, status: 'running', pid: null, startedAt: now(), endedAt: null, exitCode: null, signal: null,
      cwd, command: item.name, permissionMode, model: model || null, turns: [makeTurn(prompt, permissionMode)],
      result: '', resultTruncated: false, isError: false, costUsd: null, stderrTail: ''
    });
    return launch(id, args, prompt, cwd);
  }

  function followUp(sessionId, { message, permissionMode } = {}) {
    const record = runs.get(sessionId);
    if (!record) throw codeError('unknown_run', 'No such run');
    if (live.has(sessionId)) throw codeError('run_active', 'Run is still active');
    assertCapacity();
    const mode = permissionMode || record.permissionMode;
    const args = buildArgs({ resume: true, sessionId, permissionMode: mode, model: record.model, budget, eccRoot, cwd: record.cwd });
    commit(sessionId, {
      status: 'running', pid: null, endedAt: null, exitCode: null, signal: null, permissionMode: mode,
      turns: [...record.turns, makeTurn(message, mode)], result: '', resultTruncated: false, isError: false,
      costUsd: null, stderrTail: ''
    });
    return launch(sessionId, args, message, record.cwd);
  }

  function stop(sessionId) {
    if (!runs.has(sessionId)) throw codeError('unknown_run', 'No such run');
    const entry = live.get(sessionId);
    if (!entry || entry.stopping) throw codeError('not_running', 'Run is not running');
    return halt(sessionId, entry);
  }

  /** Stop every live run (SIGTERM, then SIGKILL after graceMs); resolves with the records once all have settled. */
  function stopAll() {
    const entries = [...live];
    entries.forEach(([id, entry]) => { if (!entry.stopping) halt(id, entry); });
    return Promise.all(entries.map(([, entry]) => waitSettled(entry, graceMs + settleWaitMs))).then(() => entries.map(([id]) => runs.get(id)));
  }

  /** Synchronous last resort for 'exit' / crash handlers: SIGKILL every live process group now. Idempotent. */
  function killAllNow() {
    for (const [id, entry] of live) {
      if (entry.killedNow || !entry.child) continue;
      entry.killedNow = true;
      entry.stopping = true;
      clearTimeout(entry.timer);
      clearTimeout(entry.killTimer);
      sendSignal(id, entry, 'SIGKILL');
    }
  }

  const get = sessionId => runs.get(sessionId) || null;
  // reverse first so Array.sort's stability makes same-startedAt runs come out newest-inserted first
  const list = () => [...runs.values()].reverse().sort((a, b) => b.startedAt - a.startedAt).slice(0, LIST_LIMIT);

  const api = { start, followUp, stop, stopAll, killAllNow, list, get };
  Object.defineProperty(api, 'maxConcurrent', { value: maxConcurrent, enumerable: true, writable: false, configurable: false });
  return api;
}

module.exports = { buildChildEnv, createRunner };
