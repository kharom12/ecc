/**
 * Tests for scripts/lib/agent-live-runner.js (+ agent-live-runner-stream.js)
 *
 * Never spawns the real `claude`: slice 4 uses a spy spawnFn with a fake child,
 * slices 5-7 run tests/fixtures/fake-claude.js through a wrapping spawnFn.
 *
 * Run with: node tests/lib/agent-live-runner.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { spawn } = require('child_process');
const { createRunner } = require('../../scripts/lib/agent-live-runner');
const { createLineParser, createTail, redactText } = require('../../scripts/lib/agent-live-runner-stream');
const { redact, redactSecrets } = require('../../scripts/lib/agent-live-events');
const { buildPrompt: buildPromptFn } = require('../../scripts/lib/agent-live-launch-catalog');

const FAKE_CLAUDE = path.join(__dirname, '..', 'fixtures', 'fake-claude.js');
const ECC_ROOT = '/opt/ecc-root';
const EVENTS = '/tmp/ecc-events.jsonl';
// cwd outside the checkout: the checkout is added read-only (H3b), see agent-live-runner-hardening.test.js
const DENY = `--disallowed-tools=${['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map(tool => `${tool}(/${ECC_ROOT}/**)`).join(',')}`;
const ECC_ARGS = [`--add-dir=${ECC_ROOT}`, DENY];
const HOSTILE = '"; rm -rf ~ $(x) --dangerously-skip-permissions';

const item = Object.freeze({ name: 'orch-add-feature', file: '/opt/ecc-root/commands/orch-add-feature.md' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Fake child for spy tests: pid is deliberately undefined so nothing real is ever signalled. */
function makeFakeChild() {
  const child = new EventEmitter();
  const written = [];
  child.stdin = new Writable({ write(chunk, _enc, cb) { written.push(chunk.toString()); cb(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = signal => { child.killedWith = signal; return true; };
  child.stdinText = () => written.join('');
  return child;
}

function makeSpy(factory = makeFakeChild) {
  const calls = [];
  const spawnFn = (bin, args, opts) => {
    const child = factory(bin, args, opts);
    calls.push({ bin, args, opts, child });
    return child;
  };
  return { spawnFn, calls };
}

const allPids = new Set();
const runners = [];
const tmpDirs = [];

/** Real child processes running tests/fixtures/fake-claude.js with per-test knobs. */
function fakeSpawn(knobs = {}, seen = {}) {
  return (bin, args, opts) => {
    seen.bin = bin;
    seen.args = args;
    seen.opts = opts;
    const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], { ...opts, env: { ...opts.env, ...knobs } });
    if (child.pid) allPids.add(child.pid);
    let out = '';
    seen.init = new Promise(resolve => {
      child.stdout.on('data', chunk => {
        out += chunk;
        const gc = /"subtype":"grandchild","pid":(\d+)/.exec(out);
        if (gc) { seen.grandchildPid = Number(gc[1]); allPids.add(seen.grandchildPid); }
        if (out.includes('"subtype":"init"') && (!knobs.FAKE_GRANDCHILD || seen.grandchildPid)) resolve();
      });
    });
    return child;
  };
}

function mkRunner(overrides = {}) {
  const changes = [];
  const runner = createRunner({
    eccRoot: ECC_ROOT, eventsPath: EVENTS, graceMs: 50, buildPromptFn,
    onChange: record => changes.push(record), ...overrides
  });
  runners.push(runner);
  return { runner, changes };
}

function mkTmp() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-runner-')));
  tmpDirs.push(dir);
  return dir;
}

const startArgs = (extra = {}) => ({ item, task: 'add a widget', cwd: os.tmpdir(), permissionMode: 'plan', model: null, ...extra });
const isSettled = r => Boolean(r) && r.status !== 'running' && (r.exitCode !== null || Boolean(r.signal) || r.stderrTail !== '');
const finished = (runner, id) => waitFor(() => (isSettled(runner.get(id)) ? runner.get(id) : null), `run ${id} to finish`);

async function runTests() {
  console.log('\n=== Testing agent-live-runner.js ===\n');
  let passed = 0;
  let failed = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${err.message}`);
      failed++;
    }
  };

  console.log('stream helpers:');
  await check('line parser reassembles lines split across chunks and multi-byte chars', () => {
    const lines = [];
    const parser = createLineParser(line => lines.push(line));
    const bytes = Buffer.from('{"a":"hé"}\n{"b":2}\n');
    parser.feed(bytes.subarray(0, 8));
    parser.feed(bytes.subarray(8, 15));
    parser.feed(bytes.subarray(15));
    assert.deepStrictEqual(lines, ['{"a":"hé"}', '{"b":2}']);
  });
  await check('line parser bounds a newline-less flood and recovers on the next line', () => {
    const lines = [];
    const parser = createLineParser(line => lines.push(line), 1000);
    for (let i = 0; i < 1024; i++) parser.feed('x'.repeat(1024));
    assert.ok(parser.pending() <= 1000, `pending ${parser.pending()}`);
    parser.feed('\n{"ok":1}\n');
    assert.deepStrictEqual(lines, ['{"ok":1}']);
  });
  await check('tail keeps only the last N chars; redactText redacts per line and clips', () => {
    const tail = createTail(10);
    tail.push('0123456789'); tail.push('abc');
    assert.strictEqual(tail.value(), '3456789abc');
    const text = redactText('line one sk-abcdefgh12345678\nline two', 100);
    assert.ok(!text.includes('sk-abcdefgh'));
    assert.ok(text.includes('\n'), 'newlines preserved');
    assert.strictEqual(redactText('abcdef', 3), 'abc');
    assert.strictEqual(redactText('abcdef', 3, true), 'def');
    assert.strictEqual(redactText(null, 3), '');
  });

  await check('line parser counts dropped over-cap lines and recovers', () => {
    const lines = [];
    const parser = createLineParser(line => lines.push(line), 100);
    assert.strictEqual(parser.dropped(), 0);
    parser.feed(`${'x'.repeat(500)}\n{"ok":1}\n${'y'.repeat(300)}`);
    parser.end();
    assert.deepStrictEqual(lines, ['{"ok":1}']);
    assert.strictEqual(parser.dropped(), 2);
  });
  await check('redactSecrets keeps newlines and indentation; redact still collapses whitespace', () => {
    const code = 'def f():\n    return 1\n\n\tx';
    assert.strictEqual(redactSecrets(code), code);
    assert.strictEqual(redact(code), 'def f(): return 1 x');
    const secrets = 'a sk-abcdefgh12345678\n  ghp_abcdefghijklmnop0123 AKIAABCDEFGHIJKLMNOP\npassword=hunter2\nnext\n--token abc123\nlast\nAuthorization: Bearer abc.def\nend';
    const out = redactSecrets(secrets);
    for (const leak of ['sk-abcdefgh', 'ghp_abc', 'AKIAABC', 'hunter2', 'abc123', 'abc.def']) assert.ok(!out.includes(leak), `${leak} in ${out}`);
    for (const kept of ['\nnext\n', '\nlast\n', '\nend']) assert.ok(out.includes(kept), `lost ${JSON.stringify(kept)} in ${JSON.stringify(out)}`);
  });
  await check('redactText preserves indentation, strips ANSI, redacts secrets, trims outer blank lines', () => {
    assert.strictEqual(redactText('def f():\n    return 1', 100), 'def f():\n    return 1');
    assert.strictEqual(redactText('\n\n  indented first\n    two\n\n', 100), '  indented first\n    two');
    assert.strictEqual(redactText('\u001b[31mred\u001b[0m sk-abcdefgh12345678\r\nx', 100), 'red <REDACTED>\nx');
  });

  console.log('\nstart() spawn contract (security):');
  await check('argv is EXACTLY the contract (model + budget) with --add-dir=<eccRoot> and the edit deny rule as single tokens', async () => {
    const { spawnFn, calls } = makeSpy();
    const { runner } = mkRunner({ spawnFn, randomUUID: () => 'uuid-1', maxBudgetUsd: 2.5 });
    runner.start(startArgs({ model: 'opus', permissionMode: 'acceptEdits' }));
    assert.strictEqual(calls[0].bin, 'claude');
    assert.deepStrictEqual(calls[0].args, [
      '-p', '--session-id', 'uuid-1', '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose',
      '--model', 'opus', '--max-budget-usd', '2.5', ...ECC_ARGS
    ]);
    calls[0].child.emit('close', 0, null);
  });
  await check('argv omits --model and --max-budget-usd when absent', () => {
    const { spawnFn, calls } = makeSpy();
    const { runner } = mkRunner({ spawnFn, randomUUID: () => 'uuid-2' });
    runner.start(startArgs());
    assert.deepStrictEqual(calls[0].args, [
      '-p', '--session-id', 'uuid-2', '--permission-mode', 'plan', '--output-format', 'stream-json', '--verbose', ...ECC_ARGS
    ]);
    calls[0].child.emit('close', 0, null);
  });
  await check('invalid maxBudgetUsd (NaN, 0, negative, non-numeric, Infinity) never reaches argv', () => {
    for (const bad of [NaN, 0, -1, 'abc', '2.5', Infinity, {}, null]) {
      const { spawnFn, calls } = makeSpy();
      const { runner } = mkRunner({ spawnFn, randomUUID: () => 'uuid-b', maxBudgetUsd: bad });
      runner.start(startArgs());
      assert.ok(!calls[0].args.includes('--max-budget-usd'), `budget ${String(bad)} leaked into argv`);
      calls[0].child.emit('close', 0, null);
    }
  });
  await check('uses the catalog buildPrompt by default (buildPromptFn stays an override)', async () => {
    const { spawnFn, calls } = makeSpy();
    const { runner } = mkRunner({ spawnFn, buildPromptFn: undefined });
    runner.start(startArgs());
    await waitFor(() => calls[0].child.stdin.writableFinished, 'stdin end');
    assert.strictEqual(calls[0].child.stdinText(), buildPromptFn(item, 'add a widget'));
    calls[0].child.emit('close', 0, null);
    const custom = makeSpy();
    mkRunner({ spawnFn: custom.spawnFn, buildPromptFn: (i, t) => `custom:${i.name}:${t}` }).runner.start(startArgs());
    await waitFor(() => custom.calls[0].child.stdin.writableFinished, 'stdin end');
    assert.strictEqual(custom.calls[0].child.stdinText(), 'custom:orch-add-feature:add a widget');
    custom.calls[0].child.emit('close', 0, null);
  });
  await check('maxConcurrent is exposed as a read-only property (default 3)', () => {
    assert.strictEqual(mkRunner().runner.maxConcurrent, 3);
    const { runner } = mkRunner({ maxConcurrent: 7 });
    assert.strictEqual(runner.maxConcurrent, 7);
    const descriptor = Object.getOwnPropertyDescriptor(runner, 'maxConcurrent');
    assert.strictEqual(descriptor.writable, false);
    assert.strictEqual(descriptor.configurable, false);
    assert.throws(() => { 'use strict'; runner.maxConcurrent = 99; }, TypeError);
    assert.strictEqual(runner.maxConcurrent, 7);
  });
  await check('spawn options: shell:false, cwd, detached, piped stdio, ECC_LIVE_EVENTS_FILE in env', () => {
    const { spawnFn, calls } = makeSpy();
    const { runner } = mkRunner({ spawnFn, claudeBin: '/usr/local/bin/claude' });
    runner.start(startArgs({ cwd: '/work/dir' }));
    const { bin, opts } = calls[0];
    assert.strictEqual(bin, '/usr/local/bin/claude');
    assert.strictEqual(opts.shell, false);
    assert.strictEqual(opts.cwd, '/work/dir');
    assert.strictEqual(opts.detached, process.platform !== 'win32');
    assert.deepStrictEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.strictEqual(opts.env.ECC_LIVE_EVENTS_FILE, EVENTS);
    assert.strictEqual(opts.env.PATH, process.env.PATH);
    calls[0].child.emit('close', 0, null);
  });
  await check('prompt goes to stdin (item file + task) and stdin is ended', async () => {
    const { spawnFn, calls } = makeSpy();
    const { runner } = mkRunner({ spawnFn });
    runner.start(startArgs());
    const child = calls[0].child;
    await waitFor(() => child.stdin.writableFinished, 'stdin end');
    assert.ok(child.stdinText().includes(item.file));
    assert.ok(child.stdinText().includes('add a widget'));
    child.emit('close', 0, null);
  });
  await check('hostile task appears only inside stdin, never in argv or options', async () => {
    const { spawnFn, calls } = makeSpy();
    const { runner } = mkRunner({ spawnFn, randomUUID: () => 'uuid-3' });
    runner.start(startArgs({ task: HOSTILE }));
    const { args, opts, child } = calls[0];
    await waitFor(() => child.stdin.writableFinished, 'stdin end');
    assert.ok(child.stdinText().includes(HOSTILE));
    const known = new Set(['-p', '--session-id', 'uuid-3', '--permission-mode', 'plan', '--output-format', 'stream-json', '--verbose', ...ECC_ARGS]);
    assert.ok(args.every(arg => known.has(arg)), `unexpected argv: ${JSON.stringify(args)}`);
    assert.ok(!JSON.stringify([args, opts.cwd, opts.shell]).includes('rm -rf'));
    assert.ok(!args.some(arg => arg.includes('dangerously')));
    child.emit('close', 0, null);
  });
  await check('record is stored before spawn runs and is frozen with the contract shape', () => {
    let seenInSpawn = null;
    const { runner, changes } = mkRunner({
      randomUUID: () => 'uuid-4', now: () => 1234,
      spawnFn: () => { seenInSpawn = runner.get('uuid-4'); return makeFakeChild(); }
    });
    const record = runner.start(startArgs({ task: `use sk-abcdefgh12345678 ${'y'.repeat(300)}` }));
    assert.ok(seenInSpawn, 'record visible during spawn');
    assert.strictEqual(seenInSpawn.status, 'running');
    assert.ok(Object.isFrozen(record) && Object.isFrozen(record.turns) && Object.isFrozen(record.turns[0]));
    assert.strictEqual(record.sessionId, 'uuid-4');
    assert.strictEqual(record.status, 'running');
    assert.strictEqual(record.command, 'orch-add-feature');
    assert.strictEqual(record.startedAt, 1234);
    assert.strictEqual(record.permissionMode, 'plan');
    assert.strictEqual(record.turns.length, 1);
    assert.ok(record.turns[0].prompt.length <= 200);
    assert.ok(!record.turns[0].prompt.includes('sk-abcdefgh'), 'prompt preview redacted');
    assert.ok(changes.length >= 1 && changes.every(c => Object.isFrozen(c)));
  });
  await check('sync spawn ENOENT -> status failed with clear message and the slot is freed', () => {
    const enoent = () => { const e = new Error('spawn claude ENOENT'); e.code = 'ENOENT'; throw e; };
    const { runner, changes } = mkRunner({ spawnFn: enoent, maxConcurrent: 1 });
    const first = runner.start(startArgs());
    assert.strictEqual(first.status, 'failed');
    assert.ok(/claude/.test(first.stderrTail) && /ENOENT/.test(first.stderrTail));
    assert.ok(first.endedAt !== null);
    assert.strictEqual(changes[changes.length - 1].status, 'failed');
    assert.strictEqual(runner.start(startArgs()).status, 'failed', 'no too_many_runs: slot was freed');
  });
  await check("async 'error' event (ENOENT) -> failed", async () => {
    const { spawnFn, calls } = makeSpy();
    const { runner } = mkRunner({ spawnFn, randomUUID: () => 'uuid-5' });
    runner.start(startArgs());
    const err = new Error('spawn claude ENOENT'); err.code = 'ENOENT';
    calls[0].child.emit('error', err);
    calls[0].child.emit('close', -2, null);
    const record = runner.get('uuid-5');
    assert.strictEqual(record.status, 'failed');
    assert.ok(/ENOENT/.test(record.stderrTail));
  });

  console.log('\nlifecycle with fake-claude:');
  await check('running -> done with result, costUsd, exitCode, pid, session id passed through', async () => {
    const seen = {};
    const { runner, changes } = mkRunner({ spawnFn: fakeSpawn({}, seen) });
    const started = runner.start(startArgs());
    assert.strictEqual(started.status, 'running');
    const done = await finished(runner, started.sessionId);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.exitCode, 0);
    assert.strictEqual(done.result, 'all done');
    assert.strictEqual(done.isError, false);
    assert.strictEqual(done.costUsd, 0.0123);
    assert.ok(done.endedAt >= done.startedAt);
    assert.ok(Number.isInteger(started.pid) || started.pid === null);
    assert.strictEqual(started.status, 'running', 'earlier record untouched');
    assert.deepStrictEqual(changes.map(c => c.status).filter((s, i, a) => s !== a[i - 1]), ['running', 'done']);
  });
  await check('non-zero exit -> failed; is_error result -> failed', async () => {
    const a = mkRunner({ spawnFn: fakeSpawn({ FAKE_EXIT: '3' }) });
    const failedExit = await finished(a.runner, a.runner.start(startArgs()).sessionId);
    assert.strictEqual(failedExit.status, 'failed');
    assert.strictEqual(failedExit.exitCode, 3);
    const b = mkRunner({ spawnFn: fakeSpawn({ FAKE_IS_ERROR: '1' }) });
    const failedResult = await finished(b.runner, b.runner.start(startArgs()).sessionId);
    assert.strictEqual(failedResult.status, 'failed');
    assert.strictEqual(failedResult.isError, true);
    assert.strictEqual(failedResult.exitCode, 0);
  });
  await check('a result line split mid-line and mid-UTF-8-char still parses', async () => {
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_SPLIT: '1' }) });
    const done = await finished(runner, runner.start(startArgs()).sessionId);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.result, 'split héllo');
  });
  await check('1 MB flood on stdout and stderr stays bounded and the result still parses', async () => {
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_FLOOD_BYTES: String(1024 * 1024) }) });
    const done = await finished(runner, runner.start(startArgs()).sessionId);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.result, 'all done');
    assert.ok(done.stderrTail.length <= 8000, `stderrTail ${done.stderrTail.length}`);
    assert.ok(done.result.length <= 20000);
  });
  await check('secrets are redacted in result and stderrTail', async () => {
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_SECRET: '1' }) });
    const done = await finished(runner, runner.start(startArgs()).sessionId);
    for (const text of [done.result, done.stderrTail]) {
      assert.ok(!text.includes('sk-abcdefgh'), text);
      assert.ok(!text.includes('ghp_abcdefghijklmnop'), text);
    }
    assert.ok(done.result.includes('<REDACTED>') && done.stderrTail.includes('<REDACTED>'));
  });
  await check('result and stderrTail keep newlines and indentation, strip ANSI and still redact', async () => {
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_FORMATTED: '1' }) });
    const done = await finished(runner, runner.start(startArgs()).sessionId);
    assert.ok(done.result.startsWith('def f():\n    return 1\n\n\tdone '), JSON.stringify(done.result));
    assert.ok(done.stderrTail.startsWith('Traceback:\n  File "x.py"\n    raise Boom '), JSON.stringify(done.stderrTail));
    assert.ok(!done.stderrTail.includes('\u001b'), 'ANSI stripped');
    assert.ok(done.stderrTail.includes('\n--') || done.stderrTail.includes('<REDACTED>\n'), JSON.stringify(done.stderrTail));
    for (const text of [done.result, done.stderrTail]) {
      for (const leak of ['sk-abcdefgh', 'hunter2', 'abc123', 'AKIAABCDEF']) assert.ok(!text.includes(leak), `${leak} in ${JSON.stringify(text)}`);
    }
  });
  await check('a stdout line over the 512KB cap is dropped: resultTruncated + a clear result message', async () => {
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_HUGE_RESULT_BYTES: String(600 * 1024) }) });
    const started = runner.start(startArgs());
    assert.strictEqual(started.resultTruncated, false);
    const done = await finished(runner, started.sessionId);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.resultTruncated, true);
    assert.ok(/too large|exceed/i.test(done.result) && done.result.length < 300, done.result);
  });
  await check('resultTruncated stays false when the result line itself arrived', async () => {
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_FLOOD_BYTES: String(600 * 1024) }) });
    const done = await finished(runner, runner.start(startArgs()).sessionId);
    assert.strictEqual(done.result, 'all done');
    assert.strictEqual(done.resultTruncated, false);
  });
  await check('list() is newest first and capped at 50; get() of unknown id is null', async () => {
    let clock = 0;
    const { runner } = mkRunner({ spawnFn: fakeSpawn(), now: () => ++clock, maxConcurrent: 100 });
    const ids = [];
    for (let i = 0; i < 55; i++) ids.push(runner.start(startArgs()).sessionId);
    const listed = runner.list();
    assert.strictEqual(listed.length, 50);
    assert.strictEqual(listed[0].sessionId, ids[54]);
    assert.strictEqual(runner.get('nope'), null);
    await waitFor(() => runner.list().every(r => r.status !== 'running'), 'all fake runs');
  });

  await check('list() breaks startedAt ties newest-inserted first', () => {
    const { spawnFn, calls } = makeSpy();
    let n = 0;
    const { runner } = mkRunner({ spawnFn, now: () => 1000, randomUUID: () => `tie-${++n}`, maxConcurrent: 10 });
    for (let i = 0; i < 4; i++) runner.start(startArgs());
    assert.deepStrictEqual(runner.list().map(r => r.sessionId), ['tie-4', 'tie-3', 'tie-2', 'tie-1']);
    calls.forEach(c => c.child.emit('close', 0, null));
  });
  await check('prune keeps at most 200 records, drops oldest finished first and never a running run', () => {
    const { spawnFn, calls } = makeSpy();
    let n = 0;
    const { runner } = mkRunner({ spawnFn, randomUUID: () => `p-${++n}`, maxConcurrent: 1000 });
    runner.start(startArgs()); // p-1 stays running throughout
    for (let i = 2; i <= 211; i++) {
      runner.start(startArgs());
      calls[i - 1].child.emit('close', 0, null);
    }
    assert.strictEqual(runner.get('p-1').status, 'running', 'running run is never pruned');
    assert.strictEqual(runner.get('p-2'), null);
    assert.strictEqual(runner.get('p-12'), null);
    assert.ok(runner.get('p-13'), 'running p-1 plus the 199 newest finished runs are kept (200 total)');
    assert.ok(runner.get('p-211'));
    calls[0].child.emit('close', 0, null);
  });

  console.log('\nlimits and stop (security):');
  await check('the 4th concurrent start throws too_many_runs; a slot frees when a run ends', async () => {
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_HANG: '1' }) });
    const started = [1, 2, 3].map(() => runner.start(startArgs()));
    assert.throws(() => runner.start(startArgs()), err => err.code === 'too_many_runs');
    runner.stop(started[0].sessionId);
    await finished(runner, started[0].sessionId);
    assert.strictEqual(runner.start(startArgs()).status, 'running');
    runner.stopAll();
    await waitFor(() => runner.list().every(r => r.exitCode !== null || r.signal), 'stopAll');
  });
  await check('stop() on a SIGTERM-ignoring child escalates to SIGKILL after graceMs -> stopped, no orphan', async () => {
    const seen = {};
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_HANG: '1', FAKE_GRANDCHILD: '1' }, seen) });
    const run = runner.start(startArgs());
    await seen.init;
    assert.ok(isAlive(run.pid) && isAlive(seen.grandchildPid));
    const t0 = Date.now();
    assert.strictEqual(runner.stop(run.sessionId).status, 'stopped');
    const done = await waitFor(() => { const r = runner.get(run.sessionId); return r.signal ? r : null; }, 'child exit');
    assert.strictEqual(done.status, 'stopped');
    assert.strictEqual(done.signal, 'SIGKILL');
    assert.ok(Date.now() - t0 >= 45, 'SIGKILL only after the grace period');
    await waitFor(() => !isAlive(run.pid) && !isAlive(seen.grandchildPid), 'process group gone');
  });
  await check('stop() on a cooperative child ends on SIGTERM; stop() errors are coded', async () => {
    const seen = {};
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_SLEEP_MS: '60000' }, seen), graceMs: 5000 });
    const run = runner.start(startArgs());
    await seen.init;
    runner.stop(run.sessionId);
    const done = await waitFor(() => { const r = runner.get(run.sessionId); return r.signal ? r : null; }, 'child exit');
    assert.strictEqual(done.signal, 'SIGTERM');
    assert.strictEqual(done.status, 'stopped');
    assert.throws(() => runner.stop(run.sessionId), err => err.code === 'not_running');
    assert.throws(() => runner.stop('missing'), err => err.code === 'unknown_run');
  });
  await check('timeoutMs kills through the stop path but ends failed with a "Timed out" reason', async () => {
    const seen = {};
    const { runner, changes } = mkRunner({ spawnFn: fakeSpawn({ FAKE_HANG: '1' }, seen), timeoutMs: 150 });
    const run = runner.start(startArgs());
    const done = await waitFor(() => { const r = runner.get(run.sessionId); return r.signal ? r : null; }, 'timeout kill', 5000);
    assert.strictEqual(done.status, 'failed');
    assert.strictEqual(done.isError, true);
    assert.ok(done.stderrTail.startsWith('Timed out after 150ms'), JSON.stringify(done.stderrTail));
    assert.strictEqual(done.signal, 'SIGKILL');
    assert.ok(changes.every(c => c.status !== 'stopped'), 'never reported as a user stop');
    await waitFor(() => !isAlive(run.pid), 'pid gone');
  });
  await check('timeout on a spy child: failed immediately, user stop on the same setup stays stopped', () => {
    const t = makeSpy();
    const a = mkRunner({ spawnFn: t.spawnFn, randomUUID: () => 'to-1', timeoutMs: 10 });
    a.runner.start(startArgs());
    return waitFor(() => t.calls[0].child.killedWith, 'timeout SIGTERM').then(() => {
      const record = a.runner.get('to-1');
      assert.deepStrictEqual([record.status, record.isError], ['failed', true]);
      t.calls[0].child.emit('close', null, 'SIGTERM');
      const settled = a.runner.get('to-1');
      assert.deepStrictEqual([settled.status, settled.isError], ['failed', true]);
      assert.ok(settled.stderrTail.startsWith('Timed out after 10ms'));
      const u = makeSpy();
      const b = mkRunner({ spawnFn: u.spawnFn, randomUUID: () => 'to-2' });
      b.runner.start(startArgs());
      b.runner.stop('to-2');
      u.calls[0].child.emit('close', null, 'SIGTERM');
      const stopped = b.runner.get('to-2');
      assert.deepStrictEqual([stopped.status, stopped.isError, stopped.stderrTail], ['stopped', false, '']);
    });
  });
  await check('stopAll() ends every running child and leaves no process behind', async () => {
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_HANG: '1' }) });
    const runs = [runner.start(startArgs()), runner.start(startArgs())];
    const stopped = await runner.stopAll(); // resolves once every child has settled
    assert.strictEqual(stopped.length, 2);
    assert.ok(runs.every(r => runner.get(r.sessionId).signal), 'children already exited');
    assert.ok(runs.every(r => runner.get(r.sessionId).status === 'stopped'));
    await waitFor(() => runs.every(r => !isAlive(r.pid)), 'pids gone');
  });
  await check('falls back to child.kill() when there is no pid to signal a group with', () => {
    const { spawnFn, calls } = makeSpy();
    const { runner } = mkRunner({ spawnFn, randomUUID: () => 'uuid-6', graceMs: 5 });
    runner.start(startArgs());
    runner.stop('uuid-6');
    assert.strictEqual(calls[0].child.killedWith, 'SIGTERM');
    calls[0].child.emit('close', null, 'SIGTERM');
    assert.strictEqual(runner.get('uuid-6').status, 'stopped');
  });

  console.log('\nfollowUp():');
  await check('unknown id -> unknown_run; still running -> run_active', () => {
    const { spawnFn, calls } = makeSpy();
    const { runner } = mkRunner({ spawnFn, randomUUID: () => 'uuid-7' });
    assert.throws(() => runner.followUp('nope', { message: 'hi', permissionMode: null }), err => err.code === 'unknown_run');
    runner.start(startArgs());
    assert.throws(() => runner.followUp('uuid-7', { message: 'hi', permissionMode: null }), err => err.code === 'run_active');
    calls[0].child.emit('close', 0, null);
  });
  await check('follow-up argv repeats --model <record.model> (and omits it when the run had none)', () => {
    const { spawnFn, calls } = makeSpy();
    let n = 0;
    const { runner } = mkRunner({ spawnFn, randomUUID: () => `fm-${++n}`, maxBudgetUsd: 1 });
    runner.start(startArgs({ model: 'opus' }));
    calls[0].child.emit('close', 0, null);
    runner.followUp('fm-1', { message: 'again', permissionMode: null });
    assert.deepStrictEqual(calls[1].args, [
      '-p', '--resume', 'fm-1', '--permission-mode', 'plan', '--output-format', 'stream-json', '--verbose',
      '--model', 'opus', '--max-budget-usd', '1', ...ECC_ARGS
    ]);
    calls[1].child.emit('close', 0, null);
    runner.start(startArgs());
    calls[2].child.emit('close', 0, null);
    runner.followUp('fm-2', { message: 'again', permissionMode: null });
    assert.ok(!calls[3].args.includes('--model'));
    calls[3].child.emit('close', 0, null);
  });
  await check('capacity applies to follow-ups too', async () => {
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_HANG: '1' }), maxConcurrent: 1 });
    const first = runner.start(startArgs());
    runner.stop(first.sessionId);
    await finished(runner, first.sessionId);
    const second = runner.start(startArgs());
    assert.throws(() => runner.followUp(first.sessionId, { message: 'x', permissionMode: null }), err => err.code === 'too_many_runs');
    runner.stop(second.sessionId);
  });
  await check('follow-up spawns -p --resume <id> in the STORED cwd with the message on stdin', async () => {
    const cwd = mkTmp();
    const echo = path.join(mkTmp(), 'echo.json');
    const seen = {};
    const { runner } = mkRunner({ spawnFn: fakeSpawn({ FAKE_ECHO_FILE: echo }, seen), maxBudgetUsd: 1 });
    const first = runner.start(startArgs({ cwd }));
    await finished(runner, first.sessionId);
    const turn2 = runner.followUp(first.sessionId, { message: HOSTILE, permissionMode: null });
    assert.strictEqual(turn2.status, 'running');
    await waitFor(() => runner.get(first.sessionId).status === 'done' && runner.get(first.sessionId).turns.length === 2 && runner.get(first.sessionId).exitCode === 0, 'turn 2 done');
    assert.deepStrictEqual(seen.args, [
      '-p', '--resume', first.sessionId, '--permission-mode', 'plan', '--output-format', 'stream-json', '--verbose',
      '--max-budget-usd', '1', ...ECC_ARGS
    ]);
    assert.ok(!seen.args.some(arg => arg.includes('rm -rf')), 'message never in argv');
    assert.strictEqual(seen.opts.shell, false);
    assert.strictEqual(seen.opts.cwd, cwd);
    const echoed = JSON.parse(fs.readFileSync(echo, 'utf8'));
    assert.strictEqual(echoed.cwd, cwd);
    assert.strictEqual(echoed.stdin, HOSTILE);
  });
  await check('permissionMode override is used and recorded per turn; omitted keeps the original', async () => {
    const seen = {};
    const { runner } = mkRunner({ spawnFn: fakeSpawn({}, seen) });
    const first = runner.start(startArgs({ permissionMode: 'plan' }));
    await finished(runner, first.sessionId);
    const turn2 = runner.followUp(first.sessionId, { message: 'go', permissionMode: 'acceptEdits' });
    assert.strictEqual(seen.args[seen.args.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.deepStrictEqual(turn2.turns.map(t => t.permissionMode), ['plan', 'acceptEdits']);
    await waitFor(() => runner.get(first.sessionId).turns[1].endedAt !== null, 'turn 2 end');
    runner.followUp(first.sessionId, { message: 'again', permissionMode: null });
    assert.strictEqual(seen.args[seen.args.indexOf('--permission-mode') + 1], 'acceptEdits', 'keeps latest recorded mode');
    await waitFor(() => runner.get(first.sessionId).turns.length === 3 && runner.get(first.sessionId).turns[2].endedAt !== null, 'turn 3 end');
    const record = runner.get(first.sessionId);
    assert.strictEqual(record.turns.length, 3);
    assert.strictEqual(record.turns[1].prompt, 'go');
  });
  await check('record updates are immutable: earlier records keep their old state', async () => {
    const { runner, changes } = mkRunner({ spawnFn: fakeSpawn() });
    const first = runner.start(startArgs());
    const before = runner.get(first.sessionId);
    const done = await finished(runner, first.sessionId);
    assert.notStrictEqual(before, done);
    assert.strictEqual(before.status, 'running');
    assert.strictEqual(before.result, '');
    assert.ok(Object.isFrozen(done) && Object.isFrozen(done.turns));
    assert.throws(() => { 'use strict'; done.status = 'hacked'; }, TypeError);
    const turn2 = runner.followUp(first.sessionId, { message: 'more', permissionMode: null });
    assert.strictEqual(done.turns.length, 1, 'previous record turns untouched');
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(turn2.turns.length, 2);
    assert.ok(changes.every(c => Object.isFrozen(c)));
    await waitFor(() => runner.get(first.sessionId).turns[1].endedAt !== null, 'turn 2 end');
  });

  console.log('\nprocess hygiene:');
  await check('no fake-claude process (or grandchild) is left alive', async () => {
    runners.forEach(r => r.stopAll());
    await waitFor(() => [...allPids].every(pid => !isAlive(pid)), 'all pids gone');
  });

  tmpDirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
