'use strict';

/**
 * Agent Live State — pure reducer that turns the JSONL event stream written by
 * scripts/hooks/agent-live-tracker.js into a renderable snapshot:
 *
 *   events[] -> { sessions: [{ id, task, status, agents[], stages[], feed[] }] }
 *
 * Shared by the dashboard server (snapshot per SSE tick) and the test suite.
 * Everything here is immutable: reducers return new objects.
 */

const MAIN_AGENT_ID = 'main';
const SPAWN_TOOLS = new Set(['Agent', 'Task']);
const FEED_LIMIT = 200;

const STAGE_ORDER = Object.freeze([
  { id: 'intake', label: 'Intake' },
  { id: 'plan', label: 'Plan' },
  { id: 'tdd', label: 'TDD' },
  { id: 'implement', label: 'Implement' },
  { id: 'build', label: 'Build' },
  { id: 'review', label: 'Review' },
  { id: 'security', label: 'Security' },
  { id: 'e2e', label: 'E2E' },
  { id: 'docs', label: 'Docs' },
  { id: 'commit', label: 'Commit' }
]);

const STAGE_RULES = Object.freeze([
  { stage: 'security', test: /security|sanitizer/i },
  { stage: 'plan', test: /^(planner|plan|architect|code-architect|code-explorer|spec-miner|gan-planner|explore)$/i },
  { stage: 'tdd', test: /tdd|test-analyzer/i },
  { stage: 'build', test: /build-resolver|build-fix/i },
  { stage: 'review', test: /reviewer|review|silent-failure|comment-analyzer|type-design|simplifier|gan-evaluator/i },
  { stage: 'e2e', test: /e2e/i },
  { stage: 'docs', test: /doc-updater|docs-lookup/i }
]);

function stageForAgentType(agentType) {
  const type = String(agentType || '');
  for (const rule of STAGE_RULES) {
    if (rule.test.test(type)) return rule.stage;
  }
  return 'implement';
}

function isCommitCommand(target) {
  return /\bgit\s+(commit|push)\b/.test(String(target || ''));
}

function createAgent(id, type, startedAt, extra = {}) {
  return {
    id,
    type: type || 'unknown',
    label: extra.label || type || id,
    description: extra.description || '',
    parentToolUseId: extra.parentToolUseId || null,
    status: 'running',
    startedAt,
    endedAt: null,
    currentTool: null,
    tools: [],
    toolCount: 0,
    errorCount: 0
  };
}

function createSession(id, event) {
  return {
    id,
    harness: event.harness || 'claude',
    model: event.model || null,
    cwd: event.cwd || '',
    startedAt: event.ts,
    lastEventAt: event.ts,
    endedAt: null,
    status: 'active',
    task: null,
    agents: { [MAIN_AGENT_ID]: createAgent(MAIN_AGENT_ID, 'orchestrator', event.ts, { label: 'Main session' }) },
    pendingSpawns: [],
    commitSeen: false,
    feed: []
  };
}

function withAgent(session, agent) {
  return { ...session, agents: { ...session.agents, [agent.id]: agent } };
}

function pushFeed(session, entry) {
  const feed = [...session.feed, entry];
  return { ...session, feed: feed.length > FEED_LIMIT ? feed.slice(feed.length - FEED_LIMIT) : feed };
}

function resolveAgentId(session, event) {
  if (event.agent_id && session.agents[event.agent_id]) return event.agent_id;
  if (event.agent_id) return event.agent_id;
  return MAIN_AGENT_ID;
}

function ensureAgent(session, agentId, event) {
  if (session.agents[agentId]) return session;
  const label = agentId === MAIN_AGENT_ID ? 'Main session' : `subagent ${agentId.slice(0, 8)}`;
  return withAgent(session, createAgent(agentId, event.agent_type || 'subagent', event.ts, { label }));
}

function reduceToolStart(session, event) {
  const agentId = resolveAgentId(session, event);
  const base = ensureAgent(session, agentId, event);
  const agent = base.agents[agentId];
  const tool = {
    id: event.tool_use_id || `${event.tool_name}-${event.ts}-${agent.tools.length}`,
    name: event.tool_name,
    target: event.target || '',
    startedAt: event.ts,
    endedAt: null,
    status: 'running'
  };
  const nextAgent = {
    ...agent,
    status: 'running',
    currentTool: tool,
    tools: [...agent.tools, tool],
    toolCount: agent.toolCount + 1
  };
  let next = withAgent(base, nextAgent);

  if (SPAWN_TOOLS.has(event.tool_name) && event.subagent_type) {
    next = {
      ...next,
      pendingSpawns: [
        ...next.pendingSpawns,
        { toolUseId: tool.id, type: event.subagent_type, description: event.description || '', ts: event.ts, parent: agentId }
      ]
    };
  }
  return pushFeed(next, feedEntry(event, agentId, `${event.tool_name} ${event.target || ''}`.trim()));
}

function closeTool(agent, event, status) {
  const index = findOpenToolIndex(agent, event);
  if (index === -1) return agent;
  const tool = { ...agent.tools[index], endedAt: event.ts, status };
  const tools = agent.tools.map((entry, i) => (i === index ? tool : entry));
  const stillRunning = tools.some(entry => entry.status === 'running');
  return {
    ...agent,
    tools,
    currentTool: stillRunning ? tools.filter(entry => entry.status === 'running').pop() : null,
    status: agent.status === 'done' ? 'done' : stillRunning ? 'running' : 'idle',
    errorCount: status === 'error' ? agent.errorCount + 1 : agent.errorCount
  };
}

function findOpenToolIndex(agent, event) {
  if (event.tool_use_id) {
    const byId = agent.tools.findIndex(tool => tool.id === event.tool_use_id && tool.status === 'running');
    if (byId !== -1) return byId;
  }
  for (let i = agent.tools.length - 1; i >= 0; i -= 1) {
    const tool = agent.tools[i];
    if (tool.status === 'running' && tool.name === event.tool_name) return i;
  }
  return -1;
}

function reduceToolEnd(session, event, status) {
  const agentId = resolveAgentId(session, event);
  const base = ensureAgent(session, agentId, event);
  const agent = closeTool(base.agents[agentId], event, status);
  let next = withAgent(base, agent);

  if (SPAWN_TOOLS.has(event.tool_name)) {
    next = settleSpawn(next, event, status);
  }
  if (event.tool_name === 'Bash' && isCommitCommand(event.target)) {
    next = { ...next, commitSeen: true };
  }
  const label = status === 'error' ? `${event.tool_name} failed` : `${event.tool_name} done`;
  return pushFeed(next, feedEntry(event, agentId, label, status === 'error' ? 'error' : 'ok'));
}

/**
 * When a spawn tool finishes, either close the linked subagent (if the runtime
 * never sent SubagentStop) or materialize a virtual agent for runtimes that do
 * not emit SubagentStart/SubagentStop at all.
 */
function settleSpawn(session, event, status) {
  const pending = session.pendingSpawns.find(spawn => spawn.toolUseId === event.tool_use_id)
    || session.pendingSpawns.find(spawn => spawn.type);
  if (!pending) return session;
  const remaining = session.pendingSpawns.filter(spawn => spawn !== pending);
  const linked = Object.values(session.agents).find(agent => agent.parentToolUseId === pending.toolUseId);
  if (linked) {
    if (linked.status === 'done') return { ...session, pendingSpawns: remaining };
    return withAgent({ ...session, pendingSpawns: remaining }, { ...linked, status: status === 'error' ? 'error' : 'done', endedAt: event.ts, currentTool: null });
  }
  const virtual = {
    ...createAgent(`virtual-${pending.toolUseId}`, pending.type, pending.ts, {
      label: pending.type,
      description: pending.description,
      parentToolUseId: pending.toolUseId
    }),
    status: status === 'error' ? 'error' : 'done',
    endedAt: event.ts
  };
  return withAgent({ ...session, pendingSpawns: remaining }, virtual);
}

function reduceSubagentStart(session, event) {
  const agentId = event.agent_id || `agent-${event.ts}`;
  const pending = session.pendingSpawns.find(spawn => spawn.type === event.agent_type && !spawn.claimed)
    || session.pendingSpawns.find(spawn => !spawn.claimed);
  const pendingSpawns = session.pendingSpawns.map(spawn => (spawn === pending ? { ...spawn, claimed: true } : spawn));
  const agent = createAgent(agentId, event.agent_type, event.ts, {
    label: event.agent_type || agentId,
    description: pending ? pending.description : '',
    parentToolUseId: pending ? pending.toolUseId : null
  });
  return pushFeed(withAgent({ ...session, pendingSpawns }, agent), feedEntry(event, agentId, `spawned ${agent.label}`, 'spawn'));
}

function reduceSubagentStop(session, event) {
  const agentId = event.agent_id;
  if (!agentId || !session.agents[agentId]) {
    return pushFeed(session, feedEntry(event, agentId || MAIN_AGENT_ID, 'subagent finished', 'done'));
  }
  const agent = { ...session.agents[agentId], status: 'done', endedAt: event.ts, currentTool: null };
  return pushFeed(withAgent(session, agent), feedEntry(event, agentId, `${agent.label} finished`, 'done'));
}

function reduceStop(session, event) {
  const main = session.agents[MAIN_AGENT_ID];
  const next = withAgent(session, { ...main, status: 'idle', currentTool: null });
  return pushFeed({ ...next, status: 'waiting' }, feedEntry(event, MAIN_AGENT_ID, 'main agent stopped (turn complete)', 'done'));
}

function reduceSessionEnd(session, event) {
  const agents = Object.fromEntries(
    Object.entries(session.agents).map(([id, agent]) => [
      id,
      agent.status === 'done' || agent.status === 'error' ? agent : { ...agent, status: 'done', endedAt: agent.endedAt || event.ts, currentTool: null }
    ])
  );
  return pushFeed({ ...session, agents, status: 'ended', endedAt: event.ts }, feedEntry(event, MAIN_AGENT_ID, `session ended${event.reason ? ` (${event.reason})` : ''}`, 'done'));
}

function reducePrompt(session, event) {
  const main = session.agents[MAIN_AGENT_ID];
  const next = withAgent({ ...session, status: 'active', task: { text: event.prompt || '', receivedAt: event.ts } }, { ...main, status: 'running' });
  return pushFeed(next, feedEntry(event, MAIN_AGENT_ID, 'task received', 'prompt'));
}

function feedEntry(event, agentId, text, kind = 'tool') {
  return { ts: event.ts, agentId, kind, text: String(text).slice(0, 200) };
}

function reduceEvent(session, event) {
  switch (event.type) {
    case 'session_start':
      return pushFeed(session, feedEntry(event, MAIN_AGENT_ID, `session started${event.source ? ` (${event.source})` : ''}`, 'session'));
    case 'prompt':
      return reducePrompt(session, event);
    case 'tool_start':
      return reduceToolStart(session, event);
    case 'tool_end':
      return reduceToolEnd(session, event, 'ok');
    case 'tool_fail':
      return reduceToolEnd(session, event, 'error');
    case 'subagent_start':
      return reduceSubagentStart(session, event);
    case 'subagent_stop':
      return reduceSubagentStop(session, event);
    case 'stop':
      return reduceStop(session, event);
    case 'session_end':
      return reduceSessionEnd(session, event);
    default:
      return session;
  }
}

function reduceSessions(sessionsById, event) {
  if (!event || !event.type || !event.ts) return sessionsById;
  const sessionId = event.session_id || 'unknown';
  const existing = sessionsById[sessionId] || createSession(sessionId, event);
  const reduced = reduceEvent(existing, event);
  return {
    ...sessionsById,
    [sessionId]: {
      ...reduced,
      lastEventAt: event.ts,
      harness: reduced.harness || event.harness || 'claude',
      model: reduced.model || event.model || null,
      cwd: reduced.cwd || event.cwd || ''
    }
  };
}

function deriveStages(session) {
  const agents = Object.values(session.agents).filter(agent => agent.id !== MAIN_AGENT_ID);
  const byStage = agents.reduce((acc, agent) => {
    const stage = stageForAgentType(agent.type);
    return { ...acc, [stage]: [...(acc[stage] || []), agent] };
  }, {});
  const hasAnyAgent = agents.length > 0;
  return STAGE_ORDER.map(stage => {
    const members = byStage[stage.id] || [];
    let status = 'pending';
    if (stage.id === 'intake') {
      status = session.task ? (hasAnyAgent || session.status !== 'active' ? 'done' : 'active') : 'pending';
    } else if (stage.id === 'commit') {
      status = session.commitSeen ? 'done' : 'pending';
    } else if (stage.id === 'implement' && members.length === 0) {
      const main = session.agents[MAIN_AGENT_ID];
      const mainEdits = main.tools.filter(tool => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool.name));
      status = mainEdits.some(tool => tool.status === 'running') ? 'active' : mainEdits.length ? 'done' : 'pending';
    } else if (members.some(agent => agent.status === 'running' || agent.status === 'idle')) {
      status = 'active';
    } else if (members.some(agent => agent.status === 'error')) {
      status = 'error';
    } else if (members.length) {
      status = 'done';
    }
    return { ...stage, status, agentIds: members.map(agent => agent.id) };
  });
}

function toPublicAgent(agent, now) {
  const end = agent.endedAt || now;
  return {
    ...agent,
    stage: agent.id === MAIN_AGENT_ID ? null : stageForAgentType(agent.type),
    elapsedMs: Math.max(0, end - agent.startedAt),
    tools: agent.tools.map(tool => ({ ...tool, durationMs: Math.max(0, (tool.endedAt || now) - tool.startedAt) }))
  };
}

function toPublicSession(session, now) {
  const agents = Object.values(session.agents)
    .sort((a, b) => (a.id === MAIN_AGENT_ID ? -1 : b.id === MAIN_AGENT_ID ? 1 : a.startedAt - b.startedAt))
    .map(agent => toPublicAgent(agent, now));
  const running = agents.filter(agent => agent.status === 'running').length;
  return {
    id: session.id,
    harness: session.harness,
    model: session.model,
    cwd: session.cwd,
    status: session.status,
    task: session.task,
    startedAt: session.startedAt,
    lastEventAt: session.lastEventAt,
    endedAt: session.endedAt,
    elapsedMs: Math.max(0, (session.endedAt || now) - session.startedAt),
    counts: {
      agents: agents.length - 1,
      running,
      tools: agents.reduce((sum, agent) => sum + agent.toolCount, 0),
      errors: agents.reduce((sum, agent) => sum + agent.errorCount, 0)
    },
    stages: deriveStages(session),
    agents,
    feed: session.feed
  };
}

function buildSnapshot(events, now = Date.now()) {
  const sessionsById = events.reduce(reduceSessions, {});
  const sessions = Object.values(sessionsById)
    .map(session => toPublicSession(session, now))
    .sort((a, b) => b.lastEventAt - a.lastEventAt);
  return { generatedAt: now, sessions };
}

module.exports = {
  MAIN_AGENT_ID,
  STAGE_ORDER,
  buildSnapshot,
  deriveStages,
  reduceSessions,
  stageForAgentType
};
