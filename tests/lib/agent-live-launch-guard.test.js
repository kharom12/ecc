/**
 * Tests for scripts/lib/agent-live-launch-guard.js
 *
 * Run with: node tests/lib/agent-live-launch-guard.test.js
 */

const assert = require('assert');
const { Readable } = require('stream');
const { createLaunchToken, checkWriteRequest, checkToken, readJsonBody } = require('../../scripts/lib/agent-live-launch-guard');

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        console.log(`  ✓ ${name}`);
        return true;
      },
      err => {
        console.log(`  ✗ ${name}`);
        console.log(`    Error: ${err.message}`);
        return false;
      }
    );
}

const HOSTS = Object.freeze(['127.0.0.1', 'localhost']);
const TOKEN = 'a'.repeat(64);

function req(headers) {
  return { headers: { 'content-type': 'application/json', 'x-ecc-live-token': TOKEN, host: '127.0.0.1:4545', origin: 'http://127.0.0.1:4545', ...headers } };
}

function without(headers, ...keys) {
  const r = req(headers);
  keys.forEach(k => delete r.headers[k]);
  return r;
}

const check = (r, opts = { allowedHosts: HOSTS, token: TOKEN }) => checkWriteRequest(r, opts);

function fakeBodyRequest(chunks, headers = {}) {
  const stream = Readable.from(chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(c))), { objectMode: false });
  stream.headers = headers;
  return stream;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected promise to reject');
}

async function runTests() {
  console.log('\n=== Testing agent-live-launch-guard.js ===\n');
  let passed = 0;
  let failed = 0;
  const t = async (name, fn) => ((await test(name, fn)) ? passed++ : failed++);

  console.log('createLaunchToken:');
  await t('returns 64 hex chars and is unique per call', () => {
    const a = createLaunchToken();
    const b = createLaunchToken();
    assert.ok(/^[0-9a-f]{64}$/.test(a));
    assert.notStrictEqual(a, b);
  });

  console.log('\ncheckWriteRequest:');
  await t('passes a same-origin JSON request with the right token', () => {
    assert.deepStrictEqual(check(req({})), { ok: true });
  });

  await t('accepts an Origin that equals the Host header (localhost, any port, any case)', () => {
    assert.strictEqual(check(req({ origin: 'http://localhost:9999', host: 'localhost:9999' })).ok, true);
    assert.strictEqual(check(req({ origin: 'http://LocalHost:9999', host: 'localhost:9999' })).ok, true);
    assert.strictEqual(check(req({ origin: 'http://localhost:9999', host: 'LOCALHOST:9999' })).ok, true);
    assert.strictEqual(check(req({ origin: 'http://[::1]:9999', host: '[::1]:9999' }), { allowedHosts: ['::1'], token: TOKEN }).ok, true);
  });

  await t('M4: Origin must match the Host header exactly, port included', () => {
    const mismatches = [
      { origin: 'http://localhost:3000', host: '127.0.0.1:3457' }, // other app on a loopback name
      { origin: 'http://127.0.0.1:3457', host: 'localhost:3457' }, // same machine, different name
      { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3457' }, // same host, other port
      { origin: 'http://127.0.0.1', host: '127.0.0.1:3457' }, // missing port
      { origin: 'https://127.0.0.1:3457', host: '127.0.0.1:3457' } // wrong scheme
    ];
    for (const headers of mismatches) {
      const r = check(req(headers));
      assert.deepStrictEqual([r.ok, r.status, r.code], [false, 403, 'bad_origin'], JSON.stringify(headers));
    }
    assert.strictEqual(check(req({ origin: 'http://127.0.0.1:3457', host: '127.0.0.1:3457' })).ok, true);
  });

  await t('M4: an Origin with no Host header is rejected', () => {
    assert.strictEqual(check(without({}, 'host')).code, 'bad_origin');
  });

  await t('M4: sec-fetch-site same-origin fallback only applies when Origin is absent (Host is not needed)', () => {
    assert.strictEqual(check(without({ 'sec-fetch-site': 'same-origin' }, 'origin', 'host')).ok, true);
    const mismatch = check(req({ origin: 'http://localhost:3000', host: '127.0.0.1:3457', 'sec-fetch-site': 'same-origin' }));
    assert.strictEqual(mismatch.ok, false);
  });

  await t('accepts a missing Origin only when sec-fetch-site is same-origin', () => {
    assert.strictEqual(check(without({ 'sec-fetch-site': 'same-origin' }, 'origin')).ok, true);
  });

  await t('rejects a missing Origin without sec-fetch-site (403 bad_origin)', () => {
    const r = check(without({}, 'origin'));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.code, 'bad_origin');
  });

  await t('rejects a missing Origin with cross-site, same-site or none sec-fetch-site', () => {
    for (const site of ['cross-site', 'same-site', 'none', '']) {
      const r = check(without({ 'sec-fetch-site': site }, 'origin'));
      assert.strictEqual(r.ok, false, site);
      assert.strictEqual(r.code, 'bad_origin');
    }
  });

  await t('rejects evil, null, malformed and look-alike Origins even if sec-fetch-site says same-origin', () => {
    const evil = ['http://evil.example', 'null', 'not a url', 'http://127.0.0.1.evil.example', 'http://localhost.evil.example:4545', 'http://evil.example/127.0.0.1', ''];
    for (const origin of evil) {
      const r = check(req({ origin, 'sec-fetch-site': 'same-origin' }));
      assert.strictEqual(r.ok, false, origin);
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.code, 'bad_origin');
    }
  });

  await t('rejects a cross-site fetch even with an allowed Origin', () => {
    const r = check(req({ 'sec-fetch-site': 'cross-site' }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'bad_origin');
  });

  await t('rejects non-JSON content types with 415 bad_content_type', () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonx', '']) {
      const r = check(req({ 'content-type': ct }));
      assert.strictEqual(r.ok, false, ct);
      assert.strictEqual(r.status, 415);
      assert.strictEqual(r.code, 'bad_content_type');
    }
    assert.strictEqual(check(without({}, 'content-type')).status, 415);
  });

  await t('accepts application/json with a charset parameter and mixed case', () => {
    assert.strictEqual(check(req({ 'content-type': 'Application/JSON; charset=utf-8' })).ok, true);
  });

  await t('rejects missing, wrong, shorter, longer and non-string tokens with 403 bad_token (never throws)', () => {
    const bad = [undefined, '', 'b'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), TOKEN.slice(0, 63) + 'b', ['a'.repeat(64)], 42];
    for (const token of bad) {
      const r = token === undefined ? check(without({}, 'x-ecc-live-token')) : check(req({ 'x-ecc-live-token': token }));
      assert.strictEqual(r.ok, false, String(token));
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.code, 'bad_token');
    }
  });

  await t('rejects everything when the server token is missing or empty', () => {
    for (const token of [undefined, '', null]) {
      assert.strictEqual(check(req({ 'x-ecc-live-token': '' }), { allowedHosts: HOSTS, token }).ok, false);
      assert.strictEqual(check(req({}), { allowedHosts: HOSTS, token }).ok, false);
    }
  });

  await t('does not leak the token in any rejection message', () => {
    const r = check(req({ 'x-ecc-live-token': 'wrong-token-value' }));
    assert.ok(!JSON.stringify(r).includes(TOKEN));
    assert.ok(!JSON.stringify(r).includes('wrong-token-value'));
  });

  await t('handles requests with no headers or no allowedHosts without throwing', () => {
    assert.strictEqual(check({}).ok, false);
    assert.strictEqual(check(null).ok, false);
    assert.strictEqual(check(req({}), { token: TOKEN }).ok, false);
  });

  await t('returns frozen results', () => {
    assert.ok(Object.isFrozen(check(req({}))));
    assert.ok(Object.isFrozen(check(req({ origin: 'http://evil.example' }))));
  });

  console.log('\ncheckToken (read endpoints):');
  await t('accepts only the exact token header, constant-time helper never throws', () => {
    assert.deepStrictEqual(checkToken(req({}), TOKEN), { ok: true });
    for (const bad of [undefined, '', 'b'.repeat(64), 'a'.repeat(63), ['a'.repeat(64)], 42]) {
      const r = bad === undefined ? checkToken(without({}, 'x-ecc-live-token'), TOKEN) : checkToken(req({ 'x-ecc-live-token': bad }), TOKEN);
      assert.deepStrictEqual([r.ok, r.status, r.code], [false, 403, 'bad_token'], String(bad));
    }
    assert.strictEqual(checkToken(req({}), '').ok, false);
    assert.strictEqual(checkToken(null, TOKEN).ok, false);
  });

  console.log('\nreadJsonBody:');
  await t('parses a valid JSON object body', async () => {
    const body = await readJsonBody(fakeBodyRequest(['{"a":1,', '"b":"two"}']));
    assert.deepStrictEqual(body, { a: 1, b: 'two' });
  });

  await t('handles a multi-byte character split across chunks', async () => {
    const bytes = Buffer.from('{"t":"héllo 🚀"}');
    const cut = bytes.indexOf(0xf0) + 2;
    const body = await readJsonBody(fakeBodyRequest([bytes.subarray(0, cut), bytes.subarray(cut)]));
    assert.strictEqual(body.t, 'héllo 🚀');
  });

  await t('accepts a body of exactly maxBytes', async () => {
    const payload = JSON.stringify({ x: 'y'.repeat(100) });
    const body = await readJsonBody(fakeBodyRequest([payload]), Buffer.byteLength(payload));
    assert.strictEqual(body.x.length, 100);
  });

  await t('L4: an 8000-character non-ASCII task fits the default limit (64 KB)', async () => {
    const task = '\u00e9\u4e2d\ud83d\ude80'.repeat(2000); // 8000 UTF-16 units, 18 KB of UTF-8
    assert.strictEqual(task.length, 8000);
    const payload = JSON.stringify({ command: 'plan', task, cwd: '/x' });
    assert.ok(Buffer.byteLength(payload) > 16384, 'must exceed the old 16 KB limit');
    const body = await readJsonBody(fakeBodyRequest([payload]));
    assert.strictEqual(body.task, task);
  });

  await t('rejects a body over the default 64 KB with 413 too_large', async () => {
    const err = await rejection(readJsonBody(fakeBodyRequest([JSON.stringify({ x: 'y'.repeat(64 * 1024) })])));
    assert.strictEqual(err.status, 413);
    assert.strictEqual(err.code, 'too_large');
    assert.ok(err instanceof Error);
  });

  await t('rejects oversize bodies split into many small chunks', async () => {
    const chunks = Array.from({ length: 50 }, () => 'z'.repeat(100));
    const err = await rejection(readJsonBody(fakeBodyRequest(chunks), 1000));
    assert.strictEqual(err.status, 413);
  });

  await t('rejects early when content-length already exceeds the limit', async () => {
    const err = await rejection(readJsonBody(fakeBodyRequest(['{}'], { 'content-length': '999999' })));
    assert.strictEqual(err.status, 413);
    assert.strictEqual(err.code, 'too_large');
  });

  await t('rejects invalid JSON, empty bodies and non-object JSON with 400 bad_json', async () => {
    for (const raw of ['{bad', '', '   ', 'null', '42', '"str"', '[1,2]', 'true']) {
      const err = await rejection(readJsonBody(fakeBodyRequest(raw ? [raw] : [])));
      assert.strictEqual(err.status, 400, JSON.stringify(raw));
      assert.strictEqual(err.code, 'bad_json');
    }
  });

  await t('allowEmpty resolves {} for an empty or whitespace-only body, via the 3rd or 2nd argument', async () => {
    for (const raw of [undefined, '', '   \n']) {
      assert.deepStrictEqual(await readJsonBody(fakeBodyRequest(raw ? [raw] : []), undefined, { allowEmpty: true }), {});
      assert.deepStrictEqual(await readJsonBody(fakeBodyRequest(raw ? [raw] : []), { allowEmpty: true }), {});
    }
    assert.deepStrictEqual(await readJsonBody(fakeBodyRequest(['{"a":1}']), undefined, { allowEmpty: true }), { a: 1 });
  });

  await t('allowEmpty still rejects bad JSON, non-objects and oversize bodies; empty is rejected without it', async () => {
    for (const raw of ['{bad', 'null', '42', '[1]']) {
      const err = await rejection(readJsonBody(fakeBodyRequest([raw]), undefined, { allowEmpty: true }));
      assert.deepStrictEqual([err.status, err.code], [400, 'bad_json'], raw);
    }
    const big = await rejection(readJsonBody(fakeBodyRequest(['{"x":"', 'y'.repeat(2000), '"}']), 1000, { allowEmpty: true }));
    assert.strictEqual(big.status, 413);
    const err = await rejection(readJsonBody(fakeBodyRequest([]), undefined, {}));
    assert.deepStrictEqual([err.status, err.code], [400, 'bad_json']);
  });

  await t('rejects with a 400 when the request stream errors', async () => {
    const stream = new Readable({ read() { this.destroy(new Error('socket hang up')); } });
    stream.headers = {};
    const err = await rejection(readJsonBody(stream));
    assert.strictEqual(err.status, 400);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (require.main === module) {
  runTests().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { runTests };
