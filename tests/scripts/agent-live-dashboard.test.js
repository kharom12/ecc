/**
 * Tests for scripts/agent-live-dashboard.js (flag parsing and the in-memory
 * store, including the --hide-ended filter). No HTTP server is started.
 *
 * Run with: node tests/scripts/agent-live-dashboard.test.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createServer, createStore, omitEndedSessions, parseArgs } = require('../../scripts/agent-live-dashboard');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

const argv = (...flags) => ['node', 'agent-live-dashboard.js', ...flags];

let clock = 1_000_000;
const ev = (sessionId, type, extra = {}) => {
  clock += 100;
  return { ts: clock, type, session_id: sessionId, ...extra };
};

// Session "old" ends, "waiting" stops after a prompt, "live" is still active.
function mixedEvents() {
  return [
    ev('old', 'session_start', { cwd: '/tmp/old' }),
    ev('old', 'prompt', { prompt: 'done task' }),
    ev('old', 'session_end', { reason: 'exit' }),
    ev('waiting', 'session_start', { cwd: '/tmp/waiting' }),
    ev('waiting', 'prompt', { prompt: 'paused task' }),
    ev('waiting', 'stop'),
    ev('live', 'session_start', { cwd: '/tmp/live' }),
    ev('live', 'prompt', { prompt: 'running task' })
  ];
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

// Boots the real server on an ephemeral port with a fixture file and checks /api/snapshot.
async function snapshotViaHttp(hideEnded) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-live-dash-'));
  const eventsPath = path.join(dir, 'events.jsonl');
  fs.writeFileSync(eventsPath, mixedEvents().map(e => JSON.stringify(e)).join('\n') + '\n');
  const { server, host, pump } = createServer({ eventsPath, hideEnded });
  try {
    await new Promise(resolve => server.listen(0, host, resolve));
    pump();
    return await getJson(server.address().port, '/api/snapshot');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runHttpTests(check) {
  console.log('\ncreateServer /api/snapshot:');
  const plain = await snapshotViaHttp(false);
  check('payload streams every session and hideEnded=false by default', () => {
    assert.strictEqual(plain.hideEnded, false);
    assert.strictEqual(plain.mode, 'live');
    assert.deepStrictEqual(plain.sessions.map(s => s.status), ['active', 'waiting', 'ended']);
  });
  const hidden = await snapshotViaHttp(true);
  check('--hide-ended omits ended sessions from the payload and reports hiddenSessions', () => {
    assert.strictEqual(hidden.hideEnded, true);
    assert.strictEqual(hidden.hiddenSessions, 1);
    assert.deepStrictEqual(hidden.sessions.map(s => s.status), ['active', 'waiting']);
  });
}

async function runTests() {
  console.log('\n=== Testing agent-live-dashboard.js ===\n');
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => (test(name, fn) ? passed++ : failed++);

  console.log('parseArgs:');
  check('hideEnded is false by default', () => {
    assert.strictEqual(parseArgs(argv()).hideEnded, false);
  });
  check('--hide-ended sets hideEnded true', () => {
    assert.strictEqual(parseArgs(argv('--hide-ended')).hideEnded, true);
  });
  check('--hide-ended does not disturb the other flags', () => {
    const args = parseArgs(argv('--hide-ended', '--port', '4000', '--demo', '--loop', '--file', 'x.jsonl'));
    assert.strictEqual(args.hideEnded, true);
    assert.strictEqual(args.port, 4000);
    assert.strictEqual(args.demo, true);
    assert.strictEqual(args.loop, true);
    assert.strictEqual(args.file, 'x.jsonl');
    assert.strictEqual(parseArgs(argv('--port', '4000', '--hide-ended')).port, 4000);
  });

  console.log('\nomitEndedSessions:');
  check('drops only sessions with status ended, keeping order', () => {
    const snapshot = {
      generatedAt: 42,
      sessions: [{ id: 'a', status: 'active' }, { id: 'b', status: 'ended' }, { id: 'c', status: 'waiting' }]
    };
    const result = omitEndedSessions(snapshot);
    assert.deepStrictEqual(result.sessions.map(s => s.id), ['a', 'c']);
    assert.strictEqual(result.generatedAt, 42);
    assert.strictEqual(result.hiddenSessions, 1);
  });
  check('does not mutate its input and returns a new object', () => {
    const snapshot = { generatedAt: 1, sessions: [{ id: 'a', status: 'ended' }, { id: 'b', status: 'active' }] };
    const before = JSON.parse(JSON.stringify(snapshot));
    const result = omitEndedSessions(snapshot);
    assert.notStrictEqual(result, snapshot);
    assert.deepStrictEqual(snapshot, before);
  });
  check('returns an empty sessions array when every session is ended', () => {
    const result = omitEndedSessions({ generatedAt: 1, sessions: [{ id: 'a', status: 'ended' }] });
    assert.deepStrictEqual(result.sessions, []);
    assert.strictEqual(result.hiddenSessions, 1);
  });

  console.log('\ncreateStore:');
  check('snapshot includes ended sessions by default', () => {
    const store = createStore();
    store.append(mixedEvents());
    const snapshot = store.snapshot();
    assert.deepStrictEqual(snapshot.sessions.map(s => s.id), ['live', 'waiting', 'old']);
    assert.strictEqual('hiddenSessions' in snapshot, false);
  });
  check('snapshot omits ended sessions when hideEnded is true', () => {
    const store = createStore({ hideEnded: true });
    store.append(mixedEvents());
    const sessions = store.snapshot().sessions;
    assert.deepStrictEqual(sessions.map(s => s.id), ['live', 'waiting']);
    assert.ok(sessions.every(s => s.status !== 'ended'));
    assert.strictEqual(store.snapshot().hiddenSessions, 1);
  });
  check('hideEnded keeps every event in the store', () => {
    const store = createStore({ hideEnded: true });
    const events = mixedEvents();
    assert.strictEqual(store.append(events), true);
    assert.strictEqual(store.size(), events.length);
    assert.strictEqual(store.append([]), false);
  });
  check('a session hidden after session_end comes back when it is re-prompted', () => {
    const store = createStore({ hideEnded: true });
    store.append([ev('s', 'session_start'), ev('s', 'session_end')]);
    assert.deepStrictEqual(store.snapshot().sessions, []);
    store.append([ev('s', 'prompt', { prompt: 'again' })]);
    assert.deepStrictEqual(store.snapshot().sessions.map(s => s.status), ['active']);
  });
  check('reset clears the filtered snapshot', () => {
    const store = createStore({ hideEnded: true });
    store.append(mixedEvents());
    store.reset();
    assert.strictEqual(store.size(), 0);
    assert.deepStrictEqual(store.snapshot().sessions, []);
  });

  await runHttpTests(check);

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (require.main === module) {
  runTests().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { runTests };
