/**
 * Hardening tests for scripts/lib/agent-live-runner.js: child environment
 * allowlist (M5), ECC checkout write protection (H3b) and kill/stop lifecycle
 * (M3/L7). Never spawns the real `claude`: spy children or tests/fixtures/fake-claude.js.
 *
 * Run with: node tests/lib/agent-live-runner-hardening.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { spawn } = require('child_process');
const { buildChildEnv, createRunner } = require('../../scripts/lib/agent-live-runner');
const { buildPrompt: buildPromptFn } = require('../../scripts/lib/agent-live-launch-catalog');

const FAKE_CLAUDE = path.join(__dirname, '..', 'fixtures', 'fake-claude.js');
const EVENTS = '/tmp/ecc-events.jsonl';
const item = Object.freeze({ name: 'plan', file: '/opt/ecc-root/commands/plan.md' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeFakeChild(kill) {
  const child = new EventEmitter();
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); return kill ? kill(signal, child) : true; };
  return child;
}

function makeSpy(kill) {
  const calls = [];
  const spawnFn = (bin, args, opts) => {
    const child = makeFakeChild(kill);
    calls.push({ bin, args, opts, child });
    return child;
  };
  return { spawnFn, calls };
}

const allPids = new Set();
const runners = [];
const tmpDirs = [];

function fakeSpawn(knobs = {}, seen = {}) {
  return (bin, args, opts) => {
    seen.args = args;
    seen.opts = opts;
    const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], { ...opts, env: { ...opts.env, ...knobs } });
    if (child.pid) allPids.add(child.pid);
    let out = '';
    seen.init = new Promise(resolve => {
      child.stdout.on('data', chunk => {
        out += chunk;
        if (out.includes('"subtype":"init"')) resolve();
      });
    });
    return child;
  };
}

function mkRunner(overrides = {}) {
  const runner = createRunner({ eccRoot: '/opt/ecc-root', eventsPath: EVENTS, graceMs: 50, buildPromptFn, ...overrides });
  runners.push(runner);
  return runner;
}

function mkTmp() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-hardening-')));
  tmpDirs.push(dir);
  return dir;
}

function captureErrors(fn) {
  const logged = [];
  const real = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  const restore = () => { console.error = real; return logged; };
  return fn.length ? fn(restore) : (fn(), restore());
}

const startArgs = (extra = {}) => ({ item, task: 'add a widget', cwd: os.tmpdir(), permissionMode: 'plan', model: null, ...extra });
const eperm = () => Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
const esrch = () => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
const denyRule = root => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map(tool => `${tool}(/${root}/**)`).join(',');
const finishedRun = (runner, id) => waitFor(() => { const r = runner.get(id); return r && r.status !== 'running' && (r.exitCode !== null || r.signal) ? r : null; }, `run ${id}`);

async function runTests() {
  console.log('\n=== Testing agent-live-runner hardening ===\n');
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

  console.log('buildChildEnv (M5):');
  await check('passes only the allowlist: ANTHROPIC_API_KEY and PATH in; GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY, NPM_TOKEN out', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin', HOME: '/home/u', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', LC_ALL: 'C', TERM: 'xterm',
      TMPDIR: '/tmp', TZ: 'UTC', XDG_CONFIG_HOME: '/c', SSL_CERT_FILE: '/ca.pem', NODE_EXTRA_CA_CERTS: '/extra.pem',
      HTTP_PROXY: 'http://p', HTTPS_PROXY: 'http://p', NO_PROXY: 'x', http_proxy: 'http://p', https_proxy: 'http://p', no_proxy: 'x',
      ANTHROPIC_API_KEY: 'sk-ant-1', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ECC_HOOK_PROFILE: 'strict', ECC_DISABLED_HOOKS: 'a,b',
      GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'aws', AWS_ACCESS_KEY_ID: 'AKIA', OPENAI_API_KEY: 'sk-x', NPM_TOKEN: 'npm',
      SHLVL: '3', DATABASE_URL: 'postgres://u:p@h/db', SLACK_BOT_TOKEN: 'xoxb', SSH_AUTH_SOCK: '/s', GH_TOKEN: 'gh'
    }, '/events.jsonl');
    for (const kept of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'XDG_CONFIG_HOME', 'SSL_CERT_FILE',
      'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN', 'ECC_HOOK_PROFILE', 'ECC_DISABLED_HOOKS']) {
      assert.ok(kept in env, `${kept} should be passed`);
    }
    for (const dropped of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'OPENAI_API_KEY', 'NPM_TOKEN', 'SHLVL', 'DATABASE_URL', 'SLACK_BOT_TOKEN', 'SSH_AUTH_SOCK', 'GH_TOKEN']) {
      assert.ok(!(dropped in env), `${dropped} must not be passed`);
    }
    assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-ant-1');
    assert.strictEqual(env.PATH, '/usr/bin');
    assert.strictEqual(env.ECC_LIVE_EVENTS_FILE, '/events.jsonl');
  });
  await check('the runner-set events path wins over an inherited ECC_LIVE_EVENTS_FILE; no path leaves the inherited one', () => {
    assert.strictEqual(buildChildEnv({ ECC_LIVE_EVENTS_FILE: '/old' }, '/new').ECC_LIVE_EVENTS_FILE, '/new');
    assert.strictEqual(buildChildEnv({ ECC_LIVE_EVENTS_FILE: '/old' }).ECC_LIVE_EVENTS_FILE, '/old');
    assert.ok(!('ECC_LIVE_EVENTS_FILE' in buildChildEnv({ PATH: '/bin' })));
  });
  await check('is pure: does not mutate its input and tolerates null, undefined and non-string values', () => {
    const input = Object.freeze({ PATH: '/bin', GITHUB_TOKEN: 'x', HOME: undefined, TERM: 5 });
    const out = buildChildEnv(input, '/e');
    assert.deepStrictEqual(Object.keys(input), ['PATH', 'GITHUB_TOKEN', 'HOME', 'TERM']);
    assert.deepStrictEqual(out, { PATH: '/bin', ECC_LIVE_EVENTS_FILE: '/e' });
    assert.deepStrictEqual(buildChildEnv(null, null), {});
    assert.deepStrictEqual(buildChildEnv(undefined), {});
  });
  await check('the spawned child gets the filtered environment, never process.env wholesale', () => {
    const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    Object.assign(process.env, { GITHUB_TOKEN: 'ghp_leak', OPENAI_API_KEY: 'sk-leak', ANTHROPIC_API_KEY: 'sk-ant-ok' });
    const { spawnFn, calls } = makeSpy();
    try {
      mkRunner({ spawnFn }).start(startArgs());
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    const { env } = calls[0].opts;
    assert.ok(!('GITHUB_TOKEN' in env) && !('OPENAI_API_KEY' in env));
    assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-ant-ok');
    assert.strictEqual(env.PATH, process.env.PATH);
    assert.strictEqual(env.ECC_LIVE_EVENTS_FILE, EVENTS);
    calls[0].child.emit('close', 0, null);
  });

  console.log('\nECC checkout protection (H3b):');
  await check('cwd outside the checkout: --add-dir plus ONE --disallowed-tools= token with the four edit tools', () => {
    const { spawnFn, calls } = makeSpy();
    mkRunner({ spawnFn, randomUUID: () => 'ad-1' }).start(startArgs());
    assert.deepStrictEqual(calls[0].args, [
      '-p', '--session-id', 'ad-1', '--permission-mode', 'plan', '--output-format', 'stream-json', '--verbose',
      '--add-dir=/opt/ecc-root', `--disallowed-tools=${denyRule('/opt/ecc-root')}`
    ]);
    assert.ok(calls[0].args[calls[0].args.length - 1].startsWith('--disallowed-tools=Edit(//opt/ecc-root/**),Write(//opt/ecc-root/**),MultiEdit('));
    calls[0].child.emit('close', 0, null);
  });
  await check('cwd inside the checkout (itself, a subfolder, or via a symlink): no --add-dir and no deny rule', () => {
    const root = mkTmp();
    const sub = path.join(root, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const link = path.join(mkTmp(), 'into-ecc');
    fs.symlinkSync(sub, link);
    for (const cwd of [root, sub, link]) {
      const { spawnFn, calls } = makeSpy();
      mkRunner({ spawnFn, eccRoot: root, randomUUID: () => 'in-1' }).start(startArgs({ cwd }));
      assert.deepStrictEqual(calls[0].args, ['-p', '--session-id', 'in-1', '--permission-mode', 'plan', '--output-format', 'stream-json', '--verbose'], cwd);
      calls[0].child.emit('close', 0, null);
    }
  });
  await check('a sibling that merely shares the checkout name prefix is outside it', () => {
    const base = mkTmp();
    const root = path.join(base, 'ecc');
    const sibling = path.join(base, 'ecc-evil');
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    const { spawnFn, calls } = makeSpy();
    mkRunner({ spawnFn, eccRoot: root }).start(startArgs({ cwd: sibling }));
    assert.ok(calls[0].args.includes(`--add-dir=${root}`));
    assert.ok(calls[0].args.some(arg => arg.startsWith('--disallowed-tools=') && arg.includes(`Edit(/${root}/**)`)));
    calls[0].child.emit('close', 0, null);
  });
  await check('follow-up applies the same rule using the STORED cwd (outside: both flags; inside: neither)', () => {
    const root = mkTmp();
    const inside = path.join(root, 'sub');
    fs.mkdirSync(inside);
    const outside = mkTmp();
    for (const [cwd, protectedRun] of [[outside, true], [inside, false]]) {
      const { spawnFn, calls } = makeSpy();
      const runner = mkRunner({ spawnFn, eccRoot: root, randomUUID: () => 'fu-1' });
      runner.start(startArgs({ cwd }));
      calls[0].child.emit('close', 0, null);
      runner.followUp('fu-1', { message: 'again', permissionMode: null });
      const tail = calls[1].args.slice(calls[1].args.indexOf('--verbose') + 1);
      assert.deepStrictEqual(tail, protectedRun ? [`--add-dir=${root}`, `--disallowed-tools=${denyRule(root)}`] : [], cwd);
      calls[1].child.emit('close', 0, null);
    }
  });

  console.log('\nstop / stopAll / killAllNow (M3, L7):');
  await check('stopAll() resolves only after every child has settled, including a SIGTERM-ignoring one', async () => {
    const seen = {};
    const runner = mkRunner({ spawnFn: fakeSpawn({ FAKE_HANG: '1' }, seen) });
    const runs = [runner.start(startArgs()), runner.start(startArgs())];
    await seen.init;
    const pending = runner.stopAll();
    assert.ok(pending instanceof Promise);
    const t0 = Date.now();
    await pending;
    assert.ok(Date.now() - t0 >= 40, 'waited for the SIGKILL escalation');
    for (const r of runs) {
      const record = runner.get(r.sessionId);
      assert.deepStrictEqual([record.status, record.signal], ['stopped', 'SIGKILL']);
      assert.ok(!isAlive(r.pid), 'process gone when the promise resolves');
    }
  });
  await check('stopAll() with no runs resolves; calling it twice (or while stopping) is safe', async () => {
    const runner = mkRunner({ spawnFn: fakeSpawn({ FAKE_HANG: '1' }) });
    await runner.stopAll();
    const run = runner.start(startArgs());
    await Promise.all([runner.stopAll(), runner.stopAll()]);
    assert.strictEqual(runner.get(run.sessionId).status, 'stopped');
    await runner.stopAll();
  });
  await check('stopAll() stops waiting after settleWaitMs when a child never exits (no hang)', async () => {
    const { spawnFn } = makeSpy(); // spy child that never closes
    const runner = mkRunner({ spawnFn, graceMs: 5, settleWaitMs: 60 });
    runner.start(startArgs());
    const t0 = Date.now();
    await runner.stopAll();
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
  });
  await check('killAllNow() SIGKILLs every live process group synchronously, with no grace wait', async () => {
    const seen = {};
    const runner = mkRunner({ spawnFn: fakeSpawn({ FAKE_HANG: '1' }, seen), graceMs: 60000 });
    const runs = [runner.start(startArgs()), runner.start(startArgs())];
    await seen.init;
    runner.killAllNow();
    await waitFor(() => runs.every(r => !isAlive(r.pid)), 'processes killed', 3000);
    await waitFor(() => runs.every(r => runner.get(r.sessionId).status !== 'running'), 'records settled', 3000);
  });
  await check('killAllNow() is safe with zero runs and when called twice; never throws on failures', async () => {
    const empty = mkRunner();
    empty.killAllNow();
    empty.killAllNow();
    const spy = makeSpy(() => { throw eperm(); });
    const runner = mkRunner({ spawnFn: spy.spawnFn });
    runner.start(startArgs());
    const logged = captureErrors(() => { runner.killAllNow(); runner.killAllNow(); });
    assert.ok(logged.every(line => line.startsWith('[AgentLive]')), JSON.stringify(logged));
    assert.strictEqual(spy.calls[0].child.signals.filter(s => s === 'SIGKILL').length, 1, 'second call does not re-signal');
    spy.calls[0].child.emit('close', null, 'SIGKILL');
  });
  await check('a kill that fails with EPERM is logged, never silent, and the run is NOT reported stopped', () => {
    const { spawnFn, calls } = makeSpy(() => { throw eperm(); });
    const runner = mkRunner({ spawnFn, randomUUID: () => 'ep-1' });
    runner.start(startArgs());
    const logged = captureErrors(() => runner.stop('ep-1'));
    const record = runner.get('ep-1');
    assert.strictEqual(record.status, 'running');
    assert.ok(/EPERM/.test(record.stderrTail) && /stop/i.test(record.stderrTail), record.stderrTail);
    assert.ok(logged.length >= 1 && logged.every(l => l.startsWith('[AgentLive]') && l.includes('EPERM')), JSON.stringify(logged));
    assert.doesNotThrow(() => captureErrors(() => runner.stop('ep-1')), 'a failed stop can be retried');
    calls[0].child.emit('close', null, null);
  });
  await check('an EPERM reported through the child "error" event (child.kill returns false) is handled the same way', () => {
    const realKill = process.kill;
    const spy = makeSpy((_sig, child) => { child.emit('error', eperm()); return false; });
    const runner = mkRunner({ spawnFn: (...args) => Object.assign(spy.spawnFn(...args), { pid: 987654 }), randomUUID: () => 'ep-2' });
    process.kill = () => { throw esrch(); }; // nothing real may ever be signalled
    try {
      runner.start(startArgs());
      const logged = captureErrors(() => runner.stop('ep-2'));
      assert.strictEqual(runner.get('ep-2').status, 'running');
      assert.ok(/EPERM/.test(runner.get('ep-2').stderrTail));
      assert.ok(logged.some(l => l.includes('EPERM')), JSON.stringify(logged));
    } finally {
      process.kill = realKill;
    }
    spy.calls[0].child.emit('close', null, null);
  });
  await check('ESRCH (process already gone) is not an error: stopped, nothing logged', () => {
    const { spawnFn, calls } = makeSpy(() => { throw esrch(); });
    const runner = mkRunner({ spawnFn, randomUUID: () => 'es-1' });
    runner.start(startArgs());
    const logged = captureErrors(() => runner.stop('es-1'));
    assert.strictEqual(runner.get('es-1').status, 'stopped');
    assert.deepStrictEqual(logged, []);
    calls[0].child.emit('close', null, 'SIGTERM');
  });
  await check('a failing SIGKILL escalation is logged and noted on the record', async () => {
    const { spawnFn, calls } = makeSpy(signal => { if (signal === 'SIGKILL') throw eperm(); return true; });
    const runner = mkRunner({ spawnFn, randomUUID: () => 'ep-3', graceMs: 20 });
    runner.start(startArgs());
    let logged;
    await captureErrors(async restore => {
      runner.stop('ep-3');
      await waitFor(() => calls[0].child.signals.includes('SIGKILL'), 'SIGKILL attempt');
      logged = restore();
    });
    assert.ok(/EPERM/.test(runner.get('ep-3').stderrTail), runner.get('ep-3').stderrTail);
    assert.ok(logged.some(l => l.startsWith('[AgentLive]') && l.includes('SIGKILL')), JSON.stringify(logged));
    calls[0].child.emit('close', null, null);
  });

  console.log('\nprocess hygiene:');
  await check('no fake-claude process is left alive', async () => {
    await Promise.all(runners.map(r => r.stopAll()));
    runners.forEach(r => r.killAllNow());
    await waitFor(() => [...allPids].every(pid => !isAlive(pid)), 'all pids gone');
  });

  tmpDirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);
  return failed === 0;
}

if (require.main === module) {
  runTests().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { runTests };
