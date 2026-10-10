/**
 * Tests for the Launcher HTTP surface wired into scripts/agent-live-dashboard.js
 * (scripts/lib/agent-live-launch-routes.js). Boots the real server on an
 * ephemeral port with a FAKE runner: the real `claude` is never spawned.
 *
 * Run with: node tests/scripts/agent-live-launch-routes.test.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createServer, parseArgs } = require('../../scripts/agent-live-dashboard');
const { createLaunchRoutes } = require('../../scripts/lib/agent-live-launch-routes');

const RUN_ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); return true; })
    .catch(err => { console.log(`  ✗ ${name}`); console.log(`    Error: ${err.message}`); return false; });
}

function fakeRunner() {
  const calls = { start: [], followUp: [], stop: [], stopAll: 0 };
  const self = { storedCwd: '/x', storedMode: 'plan' };
  const record = overrides => Object.freeze({ sessionId: RUN_ID, status: 'running', command: 'plan', cwd: self.storedCwd, permissionMode: self.storedMode, ...overrides });
  const raise = code => { const e = new Error(code); e.code = code; throw e; };
  return Object.assign(self, {
    calls,
    nextError: null,
    nextThrow: null,
    start(value) { calls.start.push(value); if (this.nextThrow) throw this.nextThrow; if (this.nextError) raise(this.nextError); return record({ command: value.item.name }); },
    followUp(id, value) { calls.followUp.push({ id, value }); if (this.nextError) raise(this.nextError); return record({}); },
    stop(id) { calls.stop.push(id); if (this.nextError) raise(this.nextError); return record({ status: 'stopped' }); },
    list() { return [record({})]; },
    get(id) { return id === RUN_ID ? record({}) : null; },
    stopAll() { calls.stopAll += 1; }
  });
}

function request(port, { method = 'GET', pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const sent = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: sent }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* html or empty */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function withServer(options, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-live-launch-'));
  const root = fs.realpathSync(dir);
  const work = path.join(root, 'project');
  fs.mkdirSync(work);
  const eventsPath = path.join(root, 'events.jsonl');
  fs.writeFileSync(eventsPath, '');
  const runner = fakeRunner();
  runner.storedCwd = work;
  const { server, host } = createServer({ eventsPath, runner, allowedRoots: [root], ...options });
  await new Promise(resolve => server.listen(0, host, resolve));
  const port = server.address().port;
  try {
    return await fn({ port, runner, work, root });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function tokenOf(port) {
  const page = await request(port, { pathname: '/' });
  const match = page.text.match(/<meta name="ecc-live-token" content="([0-9a-f]*)">/);
  return { page, token: match ? match[1] : null };
}

const readHeaders = token => ({ 'x-ecc-live-token': token });

const postHeaders = (port, token, extra = {}) => ({
  'content-type': 'application/json',
  origin: `http://127.0.0.1:${port}`,
  'x-ecc-live-token': token,
  ...extra
});

async function runTests() {
  console.log('\n=== Testing agent-live launcher routes ===\n');
  let passed = 0;
  let failed = 0;
  const check = async (name, fn) => ((await test(name, fn)) ? passed++ : failed++);

  console.log('flags:');
  await check('--launch and ECC_LIVE_LAUNCH=1 enable launching, default is off', () => {
    assert.strictEqual(parseArgs(['node', 'x']).launch, false);
    assert.strictEqual(parseArgs(['node', 'x', '--launch']).launch, true);
    process.env.ECC_LIVE_LAUNCH = '1';
    try { assert.strictEqual(parseArgs(['node', 'x']).launch, true); } finally { delete process.env.ECC_LIVE_LAUNCH; }
  });

  console.log('\nlaunch disabled (default):');
  await withServer({ launch: false }, async ({ port, runner, work }) => {
    await check('catalog says disabled with no items, runs empty, no token in HTML', async () => {
      const catalog = await request(port, { pathname: '/api/launch/catalog' });
      assert.deepStrictEqual([catalog.status, catalog.json.enabled, catalog.json.items], [200, false, []]);
      assert.deepStrictEqual((await request(port, { pathname: '/api/launch/runs' })).json, { runs: [] });
      assert.strictEqual((await request(port, { pathname: `/api/launch/runs/${RUN_ID}` })).json.code, 'unknown_run');
      const { token } = await tokenOf(port);
      assert.strictEqual(token, '');
    });
    await check('every POST is 403 launch_disabled and the runner is never called', async () => {
      for (const pathname of ['/api/launch/runs', `/api/launch/runs/${RUN_ID}/follow-up`, `/api/launch/runs/${RUN_ID}/stop`]) {
        const res = await request(port, { method: 'POST', pathname, headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: { command: 'plan', task: 't', cwd: work } });
        assert.deepStrictEqual([res.status, res.json.code], [403, 'launch_disabled'], pathname);
      }
      assert.strictEqual(runner.calls.start.length + runner.calls.followUp.length + runner.calls.stop.length, 0);
    });
    await check('existing /api/catalog agent map is unchanged', async () => {
      const res = await request(port, { pathname: '/api/catalog' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.json.planner || Object.keys(res.json).length > 10);
    });
  });

  console.log('\nlaunch enabled:');
  await withServer({ launch: true }, async ({ port, runner, work, root }) => {
    const { page, token } = await tokenOf(port);
    await check('HTML carries a 64-hex token, a strict CSP with a nonce, and nonce on every script tag', () => {
      assert.ok(/^[0-9a-f]{64}$/.test(token), 'token');
      const csp = page.headers['content-security-policy'];
      const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
      assert.ok(nonce, 'nonce in csp');
      assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no unsafe-inline scripts');
      assert.ok(/frame-ancestors 'none'/.test(csp));
      assert.strictEqual(page.headers['x-frame-options'], 'DENY');
      const scripts = page.text.match(/<script[^>]*>/g) || [];
      assert.ok(scripts.length > 0 && scripts.every(tag => tag.includes(`nonce="${nonce}"`)), 'all scripts nonced');
    });
    await check('token differs per server start and is not in any API response', async () => {
      const catalog = await request(port, { pathname: '/api/launch/catalog' });
      assert.ok(!catalog.text.includes(token));
      assert.ok(!(await request(port, { pathname: '/api/snapshot' })).text.includes(token));
    });
    await check('catalog lists real workflows without exposing file paths', async () => {
      const res = await request(port, { pathname: '/api/launch/catalog' });
      const names = res.json.items.map(i => i.name);
      for (const expected of ['orch-add-feature', 'feature-dev', 'plan', 'code-review', 'security-scan']) assert.ok(names.includes(expected), expected);
      assert.deepStrictEqual(res.json.permissionModes, ['plan', 'acceptEdits']);
      assert.ok(!res.text.includes('/commands/'), 'no filesystem path leaks');
    });

    const good = { command: 'plan', task: 'design the thing', cwd: work, permissionMode: 'plan' };

    await check('valid POST returns 201 and the runner receives the validated value', async () => {
      const res = await request(port, { method: 'POST', pathname: '/api/launch/runs', headers: postHeaders(port, token), body: good });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.json.run.sessionId, RUN_ID);
      const call = runner.calls.start[0];
      assert.deepStrictEqual([call.item.name, call.task, call.cwd, call.permissionMode], ['plan', 'design the thing', work, 'plan']);
    });
    await check('write guard: missing token, wrong token, evil Origin, no Origin, text/plain are all rejected before the runner', async () => {
      const before = runner.calls.start.length;
      const cases = [
        [{ ...postHeaders(port, token), 'x-ecc-live-token': undefined }, 'bad_token'],
        [postHeaders(port, 'f'.repeat(64)), 'bad_token'],
        [postHeaders(port, token, { origin: 'http://evil.test' }), null], // blocked earlier by the loopback gate
        [postHeaders(port, token, { origin: undefined }), 'bad_origin'],
        [postHeaders(port, token, { 'content-type': 'text/plain' }), 'bad_content_type']
      ];
      for (const [headers, code] of cases) {
        const res = await request(port, { method: 'POST', pathname: '/api/launch/runs', headers, body: good });
        if (code) assert.strictEqual(res.json.code, code, code);
        else assert.strictEqual(res.json.error, 'loopback only');
        assert.ok([403, 415].includes(res.status));
      }
      assert.strictEqual(runner.calls.start.length, before);
    });
    await check('validation errors: forbidden permission modes, unknown command, cwd outside roots, NUL, oversize body', async () => {
      const post = body => request(port, { method: 'POST', pathname: '/api/launch/runs', headers: postHeaders(port, token), body });
      for (const mode of ['bypassPermissions', 'auto', 'dontAsk', 'Plan']) assert.strictEqual((await post({ ...good, permissionMode: mode })).status, 400, mode);
      assert.strictEqual((await post({ ...good, command: 'rm -rf' })).status, 404);
      assert.strictEqual((await post({ ...good, cwd: '/etc' })).status, 400);
      assert.strictEqual((await post({ ...good, cwd: path.dirname(root) })).status, 400);
      assert.strictEqual((await post({ ...good, task: 'a\u0000b' })).status, 400);
      const big = await request(port, { method: 'POST', pathname: '/api/launch/runs', headers: postHeaders(port, token), body: JSON.stringify({ ...good, task: 'x'.repeat(70000) }) });
      assert.strictEqual(big.status, 413);
    });
    await check('runner errors map to 429 / 404 / 409', async () => {
      const post = (pathname, body) => request(port, { method: 'POST', pathname, headers: postHeaders(port, token), body });
      runner.nextError = 'too_many_runs';
      assert.strictEqual((await post('/api/launch/runs', good)).status, 429);
      runner.nextError = 'unknown_run';
      assert.strictEqual((await post(`/api/launch/runs/${RUN_ID}/follow-up`, { message: 'go' })).status, 404);
      runner.nextError = 'run_active';
      assert.strictEqual((await post(`/api/launch/runs/${RUN_ID}/follow-up`, { message: 'go' })).status, 409);
      runner.nextError = 'not_running';
      assert.strictEqual((await post(`/api/launch/runs/${RUN_ID}/stop`, {})).status, 409);
      runner.nextError = null;
    });
    await check('unknown errors are logged redacted+clipped (no token, no body) and answered with a generic 500', async () => {
      const logged = [];
      const realError = console.error;
      console.error = (...args) => logged.push(args);
      let res;
      try {
        runner.nextThrow = new Error(`spawn exploded sk-abcdefgh12345678 ${'e'.repeat(400)}`);
        res = await request(port, { method: 'POST', pathname: '/api/launch/runs', headers: postHeaders(port, token), body: { ...good, task: 'UNIQUE-TASK-MARKER' } });
        runner.nextError = 'too_many_runs';
        runner.nextThrow = null;
        await request(port, { method: 'POST', pathname: '/api/launch/runs', headers: postHeaders(port, token), body: good });
      } finally {
        console.error = realError;
        runner.nextThrow = null;
        runner.nextError = null;
      }
      assert.deepStrictEqual([res.status, res.json.code], [500, 'launch_failed']);
      assert.ok(!res.text.includes('exploded'), 'generic body');
      assert.strictEqual(logged.length, 1, 'runner-coded errors are not logged');
      assert.strictEqual(logged[0][0], '[AgentLive] launch failed:');
      assert.ok(logged[0][1].startsWith('spawn exploded <REDACTED>'), logged[0][1]);
      assert.ok(logged[0][1].length <= 200);
      assert.ok(!JSON.stringify(logged).includes(token) && !JSON.stringify(logged).includes('UNIQUE-TASK-MARKER'));
    });
    await check('stop accepts an empty body; every other write still rejects it with 400 bad_json', async () => {
      const post = pathname => request(port, { method: 'POST', pathname, headers: postHeaders(port, token) });
      const stopped = await post(`/api/launch/runs/${RUN_ID}/stop`);
      assert.strictEqual(stopped.status, 202);
      assert.ok(runner.calls.stop.includes(RUN_ID));
      for (const pathname of ['/api/launch/runs', `/api/launch/runs/${RUN_ID}/follow-up`]) {
        const res = await post(pathname);
        assert.deepStrictEqual([res.status, res.json.code], [400, 'bad_json'], pathname);
      }
      const bad = await request(port, { method: 'POST', pathname: `/api/launch/runs/${RUN_ID}/stop`, headers: postHeaders(port, token), body: '{nope' });
      assert.deepStrictEqual([bad.status, bad.json.code], [400, 'bad_json']);
    });
    await check('M2: run data GETs need the token (403 bad_token without or with a wrong one); catalog stays open', async () => {
      for (const pathname of ['/api/launch/runs', `/api/launch/runs/${RUN_ID}`, '/api/launch/runs/00000000-0000-4000-8000-000000000000']) {
        for (const headers of [{}, readHeaders('f'.repeat(64)), readHeaders('')]) {
          const res = await request(port, { pathname, headers });
          assert.deepStrictEqual([res.status, res.json.code], [403, 'bad_token'], pathname);
          assert.ok(!res.text.includes(RUN_ID) || pathname.includes(RUN_ID), 'no run data in the refusal');
        }
      }
      const list = await request(port, { pathname: '/api/launch/runs', headers: readHeaders(token) });
      assert.deepStrictEqual([list.status, list.json.runs.length], [200, 1]);
      assert.strictEqual((await request(port, { pathname: '/api/launch/catalog' })).status, 200);
    });
    await check('M6: switching to acceptEdits needs confirmEscalation: true', async () => {
      const post = (body, pathname = `/api/launch/runs/${RUN_ID}/follow-up`) => request(port, { method: 'POST', pathname, headers: postHeaders(port, token), body });
      const before = runner.calls.followUp.length;
      const refused = await post({ message: 'go', permissionMode: 'acceptEdits' });
      assert.deepStrictEqual([refused.status, refused.json.code], [400, 'escalation_unconfirmed']);
      assert.strictEqual((await post({ message: 'go', permissionMode: 'acceptEdits', confirmEscalation: 'yes' })).status, 400);
      assert.strictEqual(runner.calls.followUp.length, before, 'runner untouched');
      const ok = await post({ message: 'go', permissionMode: 'acceptEdits', confirmEscalation: true });
      assert.strictEqual(ok.status, 202);
      assert.deepStrictEqual(runner.calls.followUp.pop().value, { message: 'go', permissionMode: 'acceptEdits' });
      assert.strictEqual((await post({ message: 'go' })).status, 202); // staying in the current mode needs no confirmation
      runner.calls.followUp.length = 0;
      runner.storedMode = 'acceptEdits';
      try { assert.strictEqual((await post({ message: 'go', permissionMode: 'acceptEdits' })).status, 202); } finally { runner.storedMode = 'plan'; }
    });
    await check('M6: the stored cwd is re-validated before a follow-up; a folder that no longer qualifies is refused', async () => {
      const post = () => request(port, { method: 'POST', pathname: `/api/launch/runs/${RUN_ID}/follow-up`, headers: postHeaders(port, token), body: { message: 'go' } });
      const before = runner.calls.followUp.length;
      const gone = path.join(root, 'deleted-later');
      for (const stored of ['/etc', path.dirname(root), gone, path.join(root, 'project', 'x.txt')]) {
        runner.storedCwd = stored;
        const res = await post();
        assert.deepStrictEqual([res.status, res.json.code, res.json.error], [400, 'bad_cwd', 'cwd is not an allowed project folder'], stored);
      }
      assert.strictEqual(runner.calls.followUp.length, before, 'runner untouched');
      runner.storedCwd = work;
      assert.strictEqual((await post()).status, 202);
      runner.calls.followUp.length = 0;
    });
    await check('follow-up on an unknown run is 404 before anything else runs', async () => {
      const res = await request(port, { method: 'POST', pathname: '/api/launch/runs/00000000-0000-4000-8000-000000000000/follow-up', headers: postHeaders(port, token), body: { message: 'go' } });
      assert.deepStrictEqual([res.status, res.json.code], [404, 'unknown_run']);
    });
    await check('follow-up and stop succeed with 202; message and mode are validated first', async () => {
      const post = (pathname, body) => request(port, { method: 'POST', pathname, headers: postHeaders(port, token), body });
      assert.strictEqual((await post(`/api/launch/runs/${RUN_ID}/follow-up`, { message: 'approve the plan', permissionMode: 'acceptEdits', confirmEscalation: true })).status, 202);
      assert.deepStrictEqual(runner.calls.followUp.pop().value, { message: 'approve the plan', permissionMode: 'acceptEdits' });
      assert.strictEqual((await post(`/api/launch/runs/${RUN_ID}/follow-up`, { message: '' })).status, 400);
      assert.strictEqual((await post(`/api/launch/runs/${RUN_ID}/follow-up`, { message: 'x', permissionMode: 'bypassPermissions' })).status, 400);
      assert.strictEqual((await post(`/api/launch/runs/${RUN_ID}/stop`, {})).status, 202);
    });
    await check('non-UUID ids and unknown routes are 404; GET run works', async () => {
      assert.strictEqual((await request(port, { pathname: '/api/launch/runs/not-a-uuid' })).status, 404);
      assert.strictEqual((await request(port, { pathname: '/api/launch/runs/..%2f..%2fetc' })).status, 404);
      assert.strictEqual((await request(port, { pathname: '/api/launch/nope' })).status, 404);
      assert.strictEqual((await request(port, { pathname: `/api/launch/runs/${RUN_ID}`, headers: readHeaders(token) })).json.run.sessionId, RUN_ID);
      assert.strictEqual((await request(port, { pathname: '/api/launch/runs/00000000-0000-4000-8000-000000000000', headers: readHeaders(token) })).status, 404);
    });
    await check('snapshot payload includes a launcher summary linking runs to session ids', async () => {
      const snap = (await request(port, { pathname: '/api/snapshot' })).json;
      assert.deepStrictEqual(snap.launcher, { enabled: true, runs: [{ sessionId: RUN_ID, status: 'running', command: 'plan' }] });
    });
  });

  console.log('\nmaxConcurrent source:');
  await check('catalog maxConcurrent: explicit option, else runner.maxConcurrent, else 3', async () => {
    const reported = async (extra, runner) => {
      let body = null;
      const routes = createLaunchRoutes({ enabled: true, runner, catalog: [], roots: [], allowedHosts: [], token: 't', ...extra });
      const res = { writeHead() {}, end(text) { body = JSON.parse(text); } };
      await routes.handle({ method: 'GET' }, res, new URL('http://x/api/launch/catalog'));
      return body.maxConcurrent;
    };
    assert.strictEqual(await reported({ maxConcurrent: 9 }, { maxConcurrent: 5, list: () => [] }), 9);
    assert.strictEqual(await reported({}, { maxConcurrent: 5, list: () => [] }), 5);
    assert.strictEqual(await reported({}, { list: () => [] }), 3);
  });

  console.log('\nlifecycle:');
  await check('closing the server stops every run; --demo never enables launching', async () => {
    let stopped = 0;
    await withServer({ launch: true }, async ({ runner }) => { runner.stopAll = () => { stopped += 1; }; });
    assert.strictEqual(stopped, 1);
    await withServer({ launch: true, demo: true }, async ({ port }) => {
      assert.strictEqual((await request(port, { pathname: '/api/launch/catalog' })).json.enabled, false);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (require.main === module) {
  runTests().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { runTests };
