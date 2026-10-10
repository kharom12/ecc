/**
 * Hardening tests for the dashboard server itself (request parsing, rebinding,
 * SSE limits, page rendering, shutdown). A FAKE runner is injected; no real
 * `claude` is spawned.
 *
 * Run with: node tests/scripts/agent-live-dashboard-hardening.test.js
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { createServer } = require('../../scripts/agent-live-dashboard');

const SCRIPT = path.join(__dirname, '../../scripts/agent-live-dashboard.js');

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); return true; })
    .catch(err => { console.log(`  ✗ ${name}`); console.log(`    Error: ${err.message}`); return false; });
}

const fakeRunner = () => ({ start() {}, followUp() {}, stop() {}, list: () => [], get: () => null, stopAll: () => Promise.resolve(), killAllNow() {} });

async function withServer(options, fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-live-hard-')));
  const eventsPath = path.join(dir, 'events.jsonl');
  fs.writeFileSync(eventsPath, '');
  const { server, host } = createServer({ eventsPath, runner: fakeRunner(), allowedRoots: [dir], ...options });
  await new Promise(resolve => server.listen(0, host, resolve));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections && server.closeAllConnections(); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Raw socket so odd request targets reach the server untouched.
function rawRequest(port, requestLine, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    const lines = [requestLine, `Host: ${headers.host || `127.0.0.1:${port}`}`, 'Connection: close', ...Object.entries(headers).filter(([k]) => k !== 'host').map(([k, v]) => `${k}: ${v}`), '', ''];
    socket.write(lines.join('\r\n'));
  });
}
const statusOf = raw => Number((raw.match(/^HTTP\/1\.1 (\d+)/) || [])[1]);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('\n=== Testing dashboard hardening ===\n');
  let passed = 0;
  let failed = 0;
  const check = async (name, fn) => ((await test(name, fn)) ? passed++ : failed++);

  console.log('request handling:');
  await withServer({ launch: true }, async port => {
    await check('malformed request targets (//, ///, //[) get 400 and the server keeps serving', async () => {
      for (const target of ['//', '///', '//[']) {
        const raw = await rawRequest(port, `GET ${target} HTTP/1.1`);
        assert.strictEqual(statusOf(raw), 400, target);
      }
      assert.strictEqual((await get(port, '/api/snapshot')).status, 200);
    });
    await check('hostile Host headers (DNS rebinding) are refused on pages, API and the stream', async () => {
      for (const target of ['/', '/api/snapshot', '/api/launch/catalog', '/events']) {
        const raw = await rawRequest(port, `GET ${target} HTTP/1.1`, { host: 'evil.test' });
        assert.strictEqual(statusOf(raw), 403, target);
        assert.ok(!/"token"|ecc-live-token" content="[0-9a-f]{64}/.test(raw), 'no token leaks');
      }
    });
    await check('SSE clients are capped; the 17th stream gets 503 and slots free up on disconnect', async () => {
      const open = [];
      for (let i = 0; i < 16; i += 1) {
        await new Promise((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port, path: '/events' }, res => { open.push({ req, res }); res.once('data', resolve); });
          req.on('error', reject);
        });
      }
      assert.strictEqual((await get(port, '/events')).status, 503);
      const first = open.shift();
      first.req.destroy();
      await new Promise(resolve => setTimeout(resolve, 100));
      const again = await new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: '/events' }, res => { resolve({ status: res.statusCode, req: r }); }); });
      assert.strictEqual(again.status, 200);
      again.req.destroy();
      open.forEach(({ req }) => req.destroy());
    });
  });

  console.log('\npage rendering:');
  await withServer({ launch: true }, async port => {
    await check('launch on: launcher fragment injected, every script nonced, token present, strict CSP', async () => {
      const page = await get(port, '/');
      assert.ok(page.text.includes('id="launcher"') && page.text.includes('id="lnStart"'), 'fragment injected');
      assert.ok(!page.text.includes('<!--ECC-LAUNCHER-->'), 'marker replaced');
      const csp = page.headers['content-security-policy'];
      const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
      const scripts = page.text.match(/<script[^>]*>/g) || [];
      assert.ok(scripts.length >= 2 && scripts.every(tag => tag.includes(`nonce="${nonce}"`)), 'all scripts nonced');
      assert.ok(/ecc-live-token" content="[0-9a-f]{64}"/.test(page.text));
      assert.ok(!/script-src[^;]*unsafe/.test(csp));
    });
    await check('nonce differs on every response', async () => {
      const a = (await get(port, '/')).headers['content-security-policy'];
      const b = (await get(port, '/')).headers['content-security-policy'];
      assert.notStrictEqual(a, b);
    });
  });
  await withServer({ launch: false }, async port => {
    await check('launch off: drawer still rendered (explains how to enable) but no token', async () => {
      const page = await get(port, '/');
      assert.ok(page.text.includes('id="lnOff"'));
      assert.ok(/ecc-live-token" content=""/.test(page.text));
    });
  });

  console.log('\nprocess lifecycle:');
  await check('SIGTERM stops a --launch dashboard promptly with exit code 0', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-live-sig-')));
    const port = await freePort();
    const child = spawn(process.execPath, [SCRIPT, '--launch', '--port', String(port), '--file', path.join(dir, 'e.jsonl')], { env: { ...process.env, ECC_LIVE_ALLOWED_ROOTS: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      let out = '';
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`dashboard did not start: ${out}`)), 8000);
        child.stdout.on('data', c => { out += c; if (out.includes('LAUNCHER ENABLED')) { clearTimeout(timer); resolve(); } });
        child.on('exit', code => reject(new Error(`exited early (${code}): ${out}`)));
      });
      const started = Date.now();
      const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.kill('SIGTERM');
      const result = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('did not exit within 5s')), 5000))]);
      assert.strictEqual(result.code, 0, `exit ${JSON.stringify(result)}`);
      assert.ok(Date.now() - started < 4000, 'prompt exit');
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (require.main === module) {
  runTests().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { runTests };
