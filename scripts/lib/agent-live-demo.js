'use strict';

/**
 * Agent Live Demo — a scripted feature task flowing through the ECC pipeline
 * (plan → tdd → implement → review ∥ security → commit), emitted as the same
 * event shapes agent-live-tracker.js writes. Used by `--demo` so the dashboard
 * can be seen without a real Claude Code session.
 */

const SESSION_ID = 'demo-session';
const CWD = '/Users/dev/projects/bukkii-salon';
const TASK = 'Thêm tính năng đặt lịch lại (reschedule) cho khách: API PATCH /bookings/:id/reschedule, kiểm tra slot trống, gửi SMS xác nhận, có test.';

function step(delayMs, event) {
  return { delayMs, event: { session_id: SESSION_ID, cwd: CWD, ...event } };
}

function tool(agentId, toolUseId, name, target, extra = {}) {
  const common = agentId === 'main' ? {} : { agent_id: agentId };
  return [
    step(extra.gapMs || 400, { type: 'tool_start', tool_name: name, tool_use_id: toolUseId, target, ...common, ...(extra.start || {}) }),
    step(extra.durationMs || 900, { type: extra.fail ? 'tool_fail' : 'tool_end', tool_name: name, tool_use_id: toolUseId, target, ...common, ...(extra.fail ? { error: extra.fail } : {}) })
  ];
}

function spawn(toolUseId, type, description, agentId, body, durationBeforeStop = 300) {
  return [
    step(500, { type: 'tool_start', tool_name: 'Agent', tool_use_id: toolUseId, target: description, subagent_type: type, description }),
    step(300, { type: 'subagent_start', agent_id: agentId, agent_type: type }),
    ...body,
    step(durationBeforeStop, { type: 'subagent_stop', agent_id: agentId, agent_type: type }),
    step(200, { type: 'tool_end', tool_name: 'Agent', tool_use_id: toolUseId, target: description })
  ];
}

/** Interleave two step lists so two subagents appear to run in parallel. */
function parallel(a, b) {
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (a[i]) out.push({ ...a[i], delayMs: Math.round(a[i].delayMs / 2) });
    if (b[i]) out.push({ ...b[i], delayMs: Math.round(b[i].delayMs / 2) });
  }
  return out;
}

function buildScenario() {
  const planner = spawn('tu-plan', 'planner', 'Plan reschedule booking feature', 'ag-planner', [
    ...tool('ag-planner', 'p1', 'Glob', 'src/bookings/**/*.ts'),
    ...tool('ag-planner', 'p2', 'Read', 'src/bookings/booking.service.ts', { durationMs: 1200 }),
    ...tool('ag-planner', 'p3', 'Read', 'src/sms/sms.client.ts'),
    ...tool('ag-planner', 'p4', 'Grep', 'findAvailableSlots'),
    ...tool('ag-planner', 'p5', 'Write', 'docs/plans/reschedule-booking.md', { durationMs: 1500 })
  ]);

  const tdd = spawn('tu-tdd', 'tdd-guide', 'Write failing tests for reschedule endpoint', 'ag-tdd', [
    ...tool('ag-tdd', 't1', 'Read', 'docs/plans/reschedule-booking.md'),
    ...tool('ag-tdd', 't2', 'Write', 'src/bookings/__tests__/reschedule.test.ts', { durationMs: 1800 }),
    ...tool('ag-tdd', 't3', 'Bash', 'npm test -- reschedule', { durationMs: 2200, fail: 'Tests failed: 4 failing (expected, RED phase)' }),
    ...tool('ag-tdd', 't4', 'Edit', 'src/bookings/booking.controller.ts', { durationMs: 1600 }),
    ...tool('ag-tdd', 't5', 'Edit', 'src/bookings/booking.service.ts', { durationMs: 2000 }),
    ...tool('ag-tdd', 't6', 'Edit', 'src/sms/templates/reschedule-confirm.ts', { durationMs: 1100 }),
    ...tool('ag-tdd', 't7', 'Bash', 'npm test -- reschedule', { durationMs: 2400 })
  ]);

  const reviewer = spawn('tu-review', 'code-reviewer', 'Review reschedule diff for quality', 'ag-review', [
    ...tool('ag-review', 'r1', 'Bash', 'git diff --stat', { durationMs: 700 }),
    ...tool('ag-review', 'r2', 'Read', 'src/bookings/booking.service.ts', { durationMs: 1400 }),
    ...tool('ag-review', 'r3', 'Read', 'src/bookings/booking.controller.ts', { durationMs: 1100 }),
    ...tool('ag-review', 'r4', 'Grep', 'TODO|FIXME', { durationMs: 600 })
  ], 600);

  const security = spawn('tu-sec', 'security-reviewer', 'Security review: input validation, IDOR on booking id', 'ag-sec', [
    ...tool('ag-sec', 's1', 'Read', 'src/bookings/booking.controller.ts', { durationMs: 1300 }),
    ...tool('ag-sec', 's2', 'Grep', 'req.params.id', { durationMs: 800 }),
    ...tool('ag-sec', 's3', 'Read', 'src/auth/guards/owner.guard.ts', { durationMs: 1500 }),
    ...tool('ag-sec', 's4', 'Bash', 'npm audit --omit=dev', { durationMs: 2000 })
  ], 900);

  return [
    step(0, { type: 'session_start', source: 'startup' }),
    step(800, { type: 'prompt', prompt: TASK }),
    ...tool('main', 'm1', 'Read', 'CLAUDE.md', { gapMs: 600 }),
    ...tool('main', 'm2', 'Glob', 'src/**/booking*', { durationMs: 700 }),
    ...planner,
    ...tool('main', 'm3', 'Read', 'docs/plans/reschedule-booking.md', { durationMs: 800 }),
    ...tdd,
    ...tool('main', 'm4', 'Bash', 'npm run typecheck', { durationMs: 1800 }),
    ...parallel(reviewer, security),
    ...tool('main', 'm5', 'Edit', 'src/bookings/booking.controller.ts', { durationMs: 1200 }),
    ...tool('main', 'm6', 'Bash', 'npm test', { durationMs: 2600 }),
    ...tool('main', 'm7', 'Bash', 'git add -A && git commit -m "feat: reschedule booking endpoint with SMS confirmation"', { durationMs: 900 }),
    step(600, { type: 'stop' }),
    step(2500, { type: 'session_end', reason: 'demo complete' })
  ];
}

/**
 * Plays the scenario by calling `emit(eventLine)` with timestamps stamped at
 * emission time. Returns a stop function. Loops when options.loop is true.
 */
function playScenario(emit, options = {}) {
  const steps = buildScenario();
  let index = 0;
  let timer = null;
  let stopped = false;

  const next = () => {
    if (stopped) return;
    if (index >= steps.length) {
      if (!options.loop) return;
      index = 0;
      if (options.onLoop) options.onLoop();
    }
    const current = steps[index];
    index += 1;
    timer = setTimeout(() => {
      emit({ ...current.event, ts: Date.now() });
      next();
    }, Math.round(current.delayMs * (options.speed || 1)));
  };

  next();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = { SESSION_ID, TASK, buildScenario, playScenario };
