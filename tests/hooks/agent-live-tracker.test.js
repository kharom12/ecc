/**
 * Tests for scripts/hooks/agent-live-tracker.js and scripts/agent-live-install.js
 *
 * Run with: node tests/hooks/agent-live-tracker.test.js
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizeEvent, describeTarget, run } = require('../../scripts/hooks/agent-live-tracker');
const { buildHookEntries, mergeHooks, removeHooks, EVENTS } = require('../../scripts/agent-live-install');
const { createTail, parseLines } = require('../../scripts/agent-live-dashboard');

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

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agent-live-')), 'events.jsonl');
}

function runTests() {
  console.log('\n=== Testing agent-live-tracker.js ===\n');
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => (test(name, fn) ? passed++ : failed++);

  console.log('normalizeEvent:');
  check('maps every supported hook event to a type', () => {
    const map = { SessionStart: 'session_start', UserPromptSubmit: 'prompt', PreToolUse: 'tool_start', PostToolUse: 'tool_end', PostToolUseFailure: 'tool_fail', SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop', Stop: 'stop', SessionEnd: 'session_end' };
    for (const [name, type] of Object.entries(map)) {
      const event = normalizeEvent({ hook_event_name: name, session_id: 's' }, { now: 5 });
      assert.strictEqual(event.type, type, name);
      assert.strictEqual(event.ts, 5);
    }
  });

  check('returns null for unknown events and non-objects', () => {
    assert.strictEqual(normalizeEvent({ hook_event_name: 'Notification' }), null);
    assert.strictEqual(normalizeEvent('nope'), null);
    assert.strictEqual(normalizeEvent(null), null);
  });

  check('falls back to the argv event name when the payload lacks hook_event_name', () => {
    const event = normalizeEvent({ session_id: 's' }, { eventName: 'Stop', now: 1 });
    assert.strictEqual(event.type, 'stop');
  });

  check('captures subagent_type and description for Agent/Task spawns only', () => {
    const spawn = normalizeEvent({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'u1', tool_input: { subagent_type: 'planner', description: 'Plan X', prompt: 'long prompt' } }, { now: 1 });
    assert.strictEqual(spawn.subagent_type, 'planner');
    assert.strictEqual(spawn.description, 'Plan X');
    assert.strictEqual(spawn.tool_use_id, 'u1');
    const read = normalizeEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a/b.ts', subagent_type: 'x' } }, { now: 1 });
    assert.strictEqual(read.subagent_type, undefined);
    assert.strictEqual(read.target, '/a/b.ts');
  });

  check('keeps agent attribution fields', () => {
    const event = normalizeEvent({ hook_event_name: 'PostToolUse', tool_name: 'Read', agent_id: 'A', agent_type: 'tdd-guide', parent_tool_use_id: 'P', tool_input: {} }, { now: 1 });
    assert.strictEqual(event.agent_id, 'A');
    assert.strictEqual(event.agent_type, 'tdd-guide');
    assert.strictEqual(event.parent_tool_use_id, 'P');
  });

  check('truncates and redacts prompts and targets', () => {
    const event = normalizeEvent({ hook_event_name: 'UserPromptSubmit', prompt: `use ghp_abcdefghijklmnop please ${'x'.repeat(1000)}` }, { now: 1 });
    assert.ok(event.prompt.includes('<REDACTED>'));
    assert.ok(!event.prompt.includes('ghp_'));
    assert.ok(event.prompt.length <= 400);
    const bash = normalizeEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer abc" https://x --token=zzz' } }, { now: 1 });
    assert.ok(!bash.target.includes('zzz'));
    assert.ok(!bash.target.includes('Bearer abc'));
  });

  console.log('\ndescribeTarget:');
  check('prefers file_path, then command, then pattern, then description', () => {
    assert.strictEqual(describeTarget('Edit', { file_path: 'f', command: 'c' }), 'f');
    assert.strictEqual(describeTarget('Bash', { command: 'npm test' }), 'npm test');
    assert.strictEqual(describeTarget('Grep', { pattern: 'TODO' }), 'TODO');
    assert.strictEqual(describeTarget('Agent', { description: 'd', prompt: 'p' }), 'd');
    assert.strictEqual(describeTarget('X', null), '');
  });

  console.log('\nrun:');
  check('appends one JSON line per event and never fails on bad JSON', () => {
    const file = tmpFile();
    const a = run(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/r' }), { eventsPath: file });
    const b = run('not json', { eventsPath: file });
    const c = run(JSON.stringify({ hook_event_name: 'Notification' }), { eventsPath: file });
    assert.strictEqual(a.exitCode, 0);
    assert.strictEqual(b.exitCode, 0);
    assert.ok(b.stderr.includes('not JSON'));
    assert.strictEqual(c.exitCode, 0);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(JSON.parse(lines[0]).type, 'session_start');
  });

  check('CLI reads stdin, honours ECC_LIVE_EVENTS_FILE, exits 0', () => {
    const file = tmpFile();
    const result = spawnSync(process.execPath, [path.join(__dirname, '../../scripts/hooks/agent-live-tracker.js'), 'PreToolUse'], {
      input: JSON.stringify({ session_id: 's2', tool_name: 'Read', tool_input: { file_path: 'x.ts' } }),
      env: { ...process.env, ECC_LIVE_EVENTS_FILE: file },
      encoding: 'utf8'
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const event = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    assert.strictEqual(event.type, 'tool_start');
    assert.strictEqual(event.target, 'x.ts');
  });

  console.log('\nagent-live-install:');
  check('builds entries for all lifecycle events pointing at the tracker', () => {
    const entries = buildHookEntries('/repo root');
    assert.deepStrictEqual(Object.keys(entries).sort(), [...EVENTS].sort());
    assert.ok(entries.PreToolUse[0].matcher === '.*');
    assert.strictEqual(entries.Stop[0].matcher, undefined);
    assert.ok(entries.Stop[0].hooks[0].command.includes('agent-live-tracker.js'));
    assert.ok(entries.Stop[0].hooks[0].command.includes('"'), 'path with space is quoted');
  });

  check('merge is idempotent and preserves foreign hooks; remove strips ours only', () => {
    const foreign = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] };
    const additions = buildHookEntries('/repo');
    const once = mergeHooks(foreign, additions);
    const twice = mergeHooks(once, additions);
    assert.deepStrictEqual(once, twice);
    assert.strictEqual(once.PreToolUse.length, 2);
    assert.strictEqual(once.PreToolUse[0].hooks[0].command, 'echo hi');
    const removed = removeHooks(twice);
    assert.deepStrictEqual(removed, foreign);
    assert.deepStrictEqual(foreign.PreToolUse.length, 1, 'input not mutated');
  });

  console.log('\ndashboard tail:');
  check('createTail returns only new lines and tolerates partial writes', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const tail = createTail(file);
    assert.deepStrictEqual(tail().map(e => e.a), [1, 2]);
    fs.appendFileSync(file, '{"a":3}\n{"a":');
    assert.deepStrictEqual(tail().map(e => e.a), [3]);
    fs.appendFileSync(file, '4}\n');
    assert.deepStrictEqual(tail().map(e => e.a), [4]);
    assert.deepStrictEqual(tail(), []);
    assert.deepStrictEqual(parseLines('bad\n{"ok":true}\n').length, 1);
  });

  check('createTail calls onReset when the file is truncated or rotated', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n');
    let resets = 0;
    const tail = createTail(file, { onReset: () => { resets += 1; } });
    tail();
    fs.writeFileSync(file, '{"a":9}\n');
    assert.deepStrictEqual(tail().map(e => e.a), [9]);
    assert.strictEqual(resets, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (require.main === module) {
  process.exit(runTests() ? 0 : 1);
}

module.exports = { runTests };
