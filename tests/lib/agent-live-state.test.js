/**
 * Tests for scripts/lib/agent-live-state.js
 *
 * Run with: node tests/lib/agent-live-state.test.js
 */

const assert = require('assert');
const { buildSnapshot, stageForAgentType, MAIN_AGENT_ID } = require('../../scripts/lib/agent-live-state');
const { buildScenario } = require('../../scripts/lib/agent-live-demo');

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

const S = 'sess-1';
let clock = 1_000_000;
const ev = (type, extra = {}) => {
  clock += 100;
  return { ts: clock, type, session_id: S, ...extra };
};

function runScenarioEvents() {
  let ts = 1_000_000;
  return buildScenario().map(step => {
    ts += step.delayMs;
    return { ...step.event, ts };
  });
}

function runTests() {
  console.log('\n=== Testing agent-live-state.js ===\n');
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => (test(name, fn) ? passed++ : failed++);

  console.log('stageForAgentType:');
  check('maps reviewers, tdd, planner, security, build, docs, default', () => {
    assert.strictEqual(stageForAgentType('code-reviewer'), 'review');
    assert.strictEqual(stageForAgentType('typescript-reviewer'), 'review');
    assert.strictEqual(stageForAgentType('tdd-guide'), 'tdd');
    assert.strictEqual(stageForAgentType('planner'), 'plan');
    assert.strictEqual(stageForAgentType('architect'), 'plan');
    assert.strictEqual(stageForAgentType('security-reviewer'), 'security');
    assert.strictEqual(stageForAgentType('go-build-resolver'), 'build');
    assert.strictEqual(stageForAgentType('doc-updater'), 'docs');
    assert.strictEqual(stageForAgentType('general-purpose'), 'implement');
  });

  console.log('\nbuildSnapshot:');
  check('creates a session with a main agent on session_start', () => {
    const snap = buildSnapshot([ev('session_start', { cwd: '/repo' })], clock);
    assert.strictEqual(snap.sessions.length, 1);
    assert.strictEqual(snap.sessions[0].cwd, '/repo');
    assert.strictEqual(snap.sessions[0].agents[0].id, MAIN_AGENT_ID);
  });

  check('records the task prompt and marks intake active', () => {
    const snap = buildSnapshot([ev('session_start'), ev('prompt', { prompt: 'Add login' })], clock);
    const s = snap.sessions[0];
    assert.strictEqual(s.task.text, 'Add login');
    assert.strictEqual(s.stages.find(st => st.id === 'intake').status, 'active');
    assert.strictEqual(s.agents[0].status, 'running');
  });

  check('tool_start/tool_end pair attaches to main and computes duration', () => {
    const events = [ev('session_start'), ev('tool_start', { tool_name: 'Read', tool_use_id: 't1', target: 'a.ts' }), ev('tool_end', { tool_name: 'Read', tool_use_id: 't1' })];
    const main = buildSnapshot(events, clock).sessions[0].agents[0];
    assert.strictEqual(main.toolCount, 1);
    assert.strictEqual(main.tools[0].status, 'ok');
    assert.strictEqual(main.tools[0].durationMs, 100);
    assert.strictEqual(main.currentTool, null);
    assert.strictEqual(main.status, 'idle');
  });

  check('tool_fail increments errorCount and marks the span error', () => {
    const events = [ev('session_start'), ev('tool_start', { tool_name: 'Bash', tool_use_id: 'b1' }), ev('tool_fail', { tool_name: 'Bash', tool_use_id: 'b1', error: 'boom' })];
    const main = buildSnapshot(events, clock).sessions[0].agents[0];
    assert.strictEqual(main.errorCount, 1);
    assert.strictEqual(main.tools[0].status, 'error');
    assert.strictEqual(buildSnapshot(events, clock).sessions[0].counts.errors, 1);
  });

  check('matches tool_end to the open tool by name when tool_use_id is missing', () => {
    const events = [ev('session_start'), ev('tool_start', { tool_name: 'Grep' }), ev('tool_start', { tool_name: 'Read' }), ev('tool_end', { tool_name: 'Grep' })];
    const main = buildSnapshot(events, clock).sessions[0].agents[0];
    assert.strictEqual(main.tools[0].status, 'ok');
    assert.strictEqual(main.tools[1].status, 'running');
    assert.strictEqual(main.currentTool.name, 'Read');
  });

  check('Agent spawn + SubagentStart links description and parent tool; stop marks done', () => {
    const events = [
      ev('session_start'),
      ev('prompt', { prompt: 'feature' }),
      ev('tool_start', { tool_name: 'Agent', tool_use_id: 'sp1', subagent_type: 'planner', description: 'Plan it' }),
      ev('subagent_start', { agent_id: 'A1', agent_type: 'planner' }),
      ev('tool_start', { tool_name: 'Read', tool_use_id: 'r1', agent_id: 'A1', target: 'x.ts' }),
      ev('tool_end', { tool_name: 'Read', tool_use_id: 'r1', agent_id: 'A1' }),
      ev('subagent_stop', { agent_id: 'A1' }),
      ev('tool_end', { tool_name: 'Agent', tool_use_id: 'sp1' })
    ];
    const s = buildSnapshot(events, clock).sessions[0];
    const planner = s.agents.find(a => a.id === 'A1');
    assert.ok(planner, 'planner agent exists');
    assert.strictEqual(planner.description, 'Plan it');
    assert.strictEqual(planner.parentToolUseId, 'sp1');
    assert.strictEqual(planner.toolCount, 1);
    assert.strictEqual(planner.status, 'done');
    assert.strictEqual(planner.stage, 'plan');
    assert.strictEqual(s.stages.find(st => st.id === 'plan').status, 'done');
    assert.strictEqual(s.stages.find(st => st.id === 'intake').status, 'done');
    assert.strictEqual(s.counts.agents, 1);
  });

  check('runtime without Subagent hooks still yields a virtual agent from the Agent tool', () => {
    const events = [
      ev('session_start'),
      ev('tool_start', { tool_name: 'Task', tool_use_id: 'sp2', subagent_type: 'code-reviewer', description: 'Review' }),
      ev('tool_end', { tool_name: 'Task', tool_use_id: 'sp2' })
    ];
    const s = buildSnapshot(events, clock).sessions[0];
    const virtual = s.agents.find(a => a.id === 'virtual-sp2');
    assert.ok(virtual, 'virtual agent exists');
    assert.strictEqual(virtual.type, 'code-reviewer');
    assert.strictEqual(virtual.status, 'done');
    assert.strictEqual(s.stages.find(st => st.id === 'review').status, 'done');
  });

  check('stage is active while a subagent is running', () => {
    const events = [ev('session_start'), ev('tool_start', { tool_name: 'Agent', tool_use_id: 'sp3', subagent_type: 'security-reviewer' }), ev('subagent_start', { agent_id: 'S1', agent_type: 'security-reviewer' })];
    const s = buildSnapshot(events, clock).sessions[0];
    assert.strictEqual(s.stages.find(st => st.id === 'security').status, 'active');
    assert.strictEqual(s.counts.running, 2);
  });

  check('git commit via Bash marks the commit stage done', () => {
    const events = [ev('session_start'), ev('tool_start', { tool_name: 'Bash', tool_use_id: 'c1', target: 'git commit -m "x"' }), ev('tool_end', { tool_name: 'Bash', tool_use_id: 'c1', target: 'git commit -m "x"' })];
    assert.strictEqual(buildSnapshot(events, clock).sessions[0].stages.find(st => st.id === 'commit').status, 'done');
  });

  check('stop sets session waiting; session_end finalizes all agents', () => {
    const events = [ev('session_start'), ev('prompt', { prompt: 'x' }), ev('subagent_start', { agent_id: 'Z', agent_type: 'tdd-guide' }), ev('stop'), ev('session_end', { reason: 'exit' })];
    const s = buildSnapshot(events, clock).sessions[0];
    assert.strictEqual(s.status, 'ended');
    assert.ok(s.agents.every(a => a.status === 'done'));
    assert.ok(s.endedAt);
  });

  check('groups events by session and sorts most recently active first', () => {
    const events = [
      { ts: 1, type: 'session_start', session_id: 'old' },
      { ts: 2, type: 'session_start', session_id: 'new' },
      { ts: 3, type: 'prompt', session_id: 'new', prompt: 'p' }
    ];
    const snap = buildSnapshot(events, 10);
    assert.deepStrictEqual(snap.sessions.map(s => s.id), ['new', 'old']);
  });

  check('session carries harness and model from its first events', () => {
    const snap = buildSnapshot([ev('session_start', { harness: 'cursor', model: 'gpt-x' }), ev('prompt', { prompt: 'p' })], clock);
    assert.strictEqual(snap.sessions[0].harness, 'cursor');
    assert.strictEqual(snap.sessions[0].model, 'gpt-x');
    assert.strictEqual(buildSnapshot([ev('session_start')], clock).sessions[0].harness, 'claude');
  });

  check('ignores malformed events', () => {
    const snap = buildSnapshot([null, {}, { type: 'tool_start' }, ev('session_start')], clock);
    assert.strictEqual(snap.sessions.length, 1);
  });

  check('does not mutate input events', () => {
    const events = [ev('session_start'), ev('prompt', { prompt: 'p' })];
    const frozen = events.map(e => Object.freeze({ ...e }));
    buildSnapshot(frozen, clock);
    assert.deepStrictEqual(frozen, events);
  });

  console.log('\ndemo scenario:');
  check('full demo scenario reduces to 4 subagents, parallel review+security, commit done', () => {
    const events = runScenarioEvents();
    const s = buildSnapshot(events, events[events.length - 1].ts + 1).sessions[0];
    assert.strictEqual(s.counts.agents, 4);
    assert.deepStrictEqual(s.agents.slice(1).map(a => a.type), ['planner', 'tdd-guide', 'code-reviewer', 'security-reviewer']);
    assert.ok(s.agents.every(a => a.status === 'done'), 'all agents done');
    assert.strictEqual(s.stages.find(st => st.id === 'commit').status, 'done');
    assert.strictEqual(s.status, 'ended');
    assert.strictEqual(s.counts.errors, 1, 'the RED-phase test failure is the only error');
    const review = s.agents.find(a => a.type === 'code-reviewer');
    const security = s.agents.find(a => a.type === 'security-reviewer');
    assert.ok(review.startedAt < security.endedAt && security.startedAt < review.endedAt, 'review and security overlap in time');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (require.main === module) {
  process.exit(runTests() ? 0 : 1);
}

module.exports = { runTests };
