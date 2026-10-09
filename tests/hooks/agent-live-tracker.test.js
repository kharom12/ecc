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

const { normalizeEvent, normalizeEvents, describeTarget, run } = require('../../scripts/hooks/agent-live-tracker');
const { detectHarness } = require('../../scripts/lib/agent-live-events');
const { buildHookEntries, buildCursorHookEntries, mergeHooks, removeHooks, resolveTarget, EVENTS, CURSOR_EVENTS } = require('../../scripts/agent-live-install');
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
      assert.strictEqual(event.harness, 'claude');
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

  console.log('\ncursor harness:');
  const env = {};
  check('maps Cursor lifecycle events and uses conversation_id as the session', () => {
    const start = normalizeEvents({ hook_event_name: 'sessionStart', conversation_id: 'conv-1', workspace_roots: ['/ws'], model: 'gpt-x' }, { now: 1, env });
    assert.strictEqual(start.length, 1);
    assert.strictEqual(start[0].type, 'session_start');
    assert.strictEqual(start[0].harness, 'cursor');
    assert.strictEqual(start[0].session_id, 'conv-1');
    assert.strictEqual(start[0].cwd, '/ws');
    assert.strictEqual(start[0].model, 'gpt-x');
    const prompt = normalizeEvents({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conv-1', prompt: 'build it' }, { now: 2, env })[0];
    assert.strictEqual(prompt.type, 'prompt');
    assert.strictEqual(prompt.prompt, 'build it');
    assert.strictEqual(normalizeEvents({ hook_event_name: 'stop', conversation_id: 'conv-1' }, { now: 3, env })[0].type, 'stop');
  });

  check('maps Cursor shell and MCP hooks to Bash/MCP tool spans', () => {
    const before = normalizeEvents({ hook_event_name: 'beforeShellExecution', conversation_id: 'c', command: 'npm test' }, { now: 1, env })[0];
    assert.deepStrictEqual([before.type, before.tool_name, before.target], ['tool_start', 'Bash', 'npm test']);
    const after = normalizeEvents({ hook_event_name: 'afterShellExecution', conversation_id: 'c', command: 'npm test', output: 'ok' }, { now: 2, env })[0];
    assert.deepStrictEqual([after.type, after.tool_name], ['tool_end', 'Bash']);
    const mcp = normalizeEvents({ hook_event_name: 'beforeMCPExecution', conversation_id: 'c', server: 'github', tool: 'create_pr' }, { now: 3, env })[0];
    assert.deepStrictEqual([mcp.type, mcp.tool_name, mcp.target], ['tool_start', 'mcp:create_pr', 'github/create_pr']);
  });

  check('Cursor read/edit hooks emit an instant start+end pair', () => {
    const read = normalizeEvents({ hook_event_name: 'beforeReadFile', conversation_id: 'c', path: '/a.ts' }, { now: 1, env });
    assert.strictEqual(read.length, 2);
    assert.deepStrictEqual(read.map(e => e.type), ['tool_start', 'tool_end']);
    assert.strictEqual(read[0].tool_name, 'Read');
    assert.strictEqual(read[1].target, '/a.ts');
    const edit = normalizeEvents({ hook_event_name: 'afterFileEdit', conversation_id: 'c', file: '/b.ts' }, { now: 1, env });
    assert.strictEqual(edit[0].tool_name, 'Edit');
    assert.strictEqual(edit.length, 2);
  });

  check('Cursor subagent hooks carry agent_name as agent_type', () => {
    const start = normalizeEvents({ hook_event_name: 'subagentStart', conversation_id: 'c', agent_name: 'reviewer', generation_id: 'g1' }, { now: 1, env })[0];
    assert.deepStrictEqual([start.type, start.agent_type, start.agent_id], ['subagent_start', 'reviewer', 'g1']);
  });

  check('ignores Cursor events the dashboard does not model', () => {
    assert.deepStrictEqual(normalizeEvents({ hook_event_name: 'beforeTabFileRead', conversation_id: 'c' }, { env }), []);
    assert.deepStrictEqual(normalizeEvents({ hook_event_name: 'preCompact', conversation_id: 'c' }, { env }), []);
  });

  check('detectHarness: override > event name > env > default', () => {
    assert.strictEqual(detectHarness({}, 'PreToolUse', { ECC_LIVE_HARNESS: 'cursor' }), 'cursor');
    assert.strictEqual(detectHarness({}, 'beforeShellExecution', {}), 'cursor');
    assert.strictEqual(detectHarness({}, 'PreToolUse', { CURSOR_VERSION: '1' }), 'claude');
    assert.strictEqual(detectHarness({}, '', { CURSOR_VERSION: '1' }), 'cursor');
    assert.strictEqual(detectHarness({}, '', {}), 'claude');
  });

  check('run appends both lines of an instant pair', () => {
    const file = tmpFile();
    const result = run(JSON.stringify({ hook_event_name: 'afterFileEdit', conversation_id: 'c', path: '/x.ts' }), { eventsPath: file, env });
    assert.strictEqual(result.events.length, 2);
    assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  });

  check('CLI echoes stdin only for Cursor hooks', () => {
    const script = path.join(__dirname, '../../scripts/hooks/agent-live-tracker.js');
    const base = { encoding: 'utf8' };
    const cursor = spawnSync(process.execPath, [script, 'beforeShellExecution'], { ...base, input: '{"conversation_id":"c","command":"ls"}', env: { ...process.env, ECC_LIVE_EVENTS_FILE: tmpFile() } });
    assert.strictEqual(cursor.status, 0);
    assert.strictEqual(cursor.stdout, '{"conversation_id":"c","command":"ls"}');
    const claude = spawnSync(process.execPath, [script, 'PreToolUse'], { ...base, input: '{"session_id":"s","tool_name":"Read","tool_input":{}}', env: { ...process.env, ECC_LIVE_EVENTS_FILE: tmpFile() } });
    assert.strictEqual(claude.status, 0);
    assert.strictEqual(claude.stdout, '');
  });

  console.log('\nagent-live-install (cursor):');
  check('builds Cursor hooks.json entries for every mapped Cursor event', () => {
    const entries = buildCursorHookEntries('/repo');
    assert.deepStrictEqual(Object.keys(entries).sort(), [...CURSOR_EVENTS].sort());
    assert.strictEqual(entries.beforeShellExecution[0].event, 'beforeShellExecution');
    assert.ok(entries.stop[0].command.endsWith('agent-live-tracker.js stop'));
  });

  check('merge/remove work on Cursor flat entries and keep foreign ECC cursor hooks', () => {
    const foreign = { stop: [{ command: 'node .cursor/hooks/stop.js', event: 'stop' }] };
    const merged = mergeHooks(foreign, buildCursorHookEntries('/repo'));
    assert.strictEqual(merged.stop.length, 2);
    assert.deepStrictEqual(mergeHooks(merged, buildCursorHookEntries('/repo')), merged, 'idempotent');
    assert.deepStrictEqual(removeHooks(merged), foreign);
  });

  check('resolveTarget picks ~/.cursor/hooks.json with --cursor and honours CURSOR_CONFIG_DIR', () => {
    const target = resolveTarget(['--cursor'], '/repo', { CURSOR_CONFIG_DIR: '/cfg' });
    assert.strictEqual(target.filePath, path.join('/cfg', 'hooks.json'));
    assert.deepStrictEqual(target.wrap({}, {}), { version: 1, hooks: {} });
    assert.ok(resolveTarget([], '/repo', {}).filePath.endsWith('settings.json'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (require.main === module) {
  process.exit(runTests() ? 0 : 1);
}

module.exports = { runTests };
