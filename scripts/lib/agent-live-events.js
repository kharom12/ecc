'use strict';

/**
 * Agent Live Events — normalizes raw hook payloads from any supported harness
 * (Claude Code, Cursor) into the compact event lines the dashboard reducer
 * understands. Pure functions; no I/O.
 */

const { stripAnsi } = require('./utils');

const PROMPT_LIMIT = 400;
const TARGET_LIMIT = 160;

const HARNESSES = Object.freeze({ CLAUDE: 'claude', CURSOR: 'cursor' });

/** Claude Code hook event → event type. */
const CLAUDE_EVENT_TYPES = Object.freeze({
  SessionStart: 'session_start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool_start',
  PostToolUse: 'tool_end',
  PostToolUseFailure: 'tool_fail',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
  SessionEnd: 'session_end'
});

/**
 * Cursor hook event → event type (+ synthetic tool name where Cursor has no
 * tool concept). `instant` events have no paired "after" hook, so they emit a
 * start and an end line together.
 */
const CURSOR_EVENT_TYPES = Object.freeze({
  sessionStart: { type: 'session_start' },
  sessionEnd: { type: 'session_end' },
  beforeSubmitPrompt: { type: 'prompt' },
  beforeShellExecution: { type: 'tool_start', tool: 'Bash' },
  afterShellExecution: { type: 'tool_end', tool: 'Bash' },
  beforeMCPExecution: { type: 'tool_start', tool: 'MCP' },
  afterMCPExecution: { type: 'tool_end', tool: 'MCP' },
  beforeReadFile: { type: 'tool_start', tool: 'Read', instant: true },
  afterFileEdit: { type: 'tool_start', tool: 'Edit', instant: true },
  subagentStart: { type: 'subagent_start' },
  subagentStop: { type: 'subagent_stop' },
  stop: { type: 'stop' }
});

function redact(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/--token[= ][^ ]*/g, '--token=<REDACTED>')
    .replace(/Authorization:[: ]*[^ ]*[: ]*[^ ]*/gi, 'Authorization:<REDACTED>')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '<REDACTED>')
    .replace(/password[= ][^ ]*/gi, 'password=<REDACTED>')
    .replace(/\b(ghp|gho|ghs)_[A-Za-z0-9_]+\b/g, '<REDACTED>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '<REDACTED>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<REDACTED>');
}

function clip(value, limit) {
  const text = stripAnsi(redact(value)).trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Pick the one human-meaningful argument of a tool call. */
function describeTarget(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  const candidates = [
    input.file_path,
    input.notebook_path,
    input.command,
    input.pattern,
    input.url,
    input.query,
    input.description,
    input.skill,
    input.prompt
  ];
  const first = candidates.find(value => typeof value === 'string' && value.trim());
  if (first) return clip(first, TARGET_LIMIT);
  if (Array.isArray(input.file_paths)) return clip(input.file_paths.join(', '), TARGET_LIMIT);
  return '';
}

function resolveEventName(data, hint, env) {
  const fromPayload = typeof data.hook_event_name === 'string' ? data.hook_event_name : '';
  return fromPayload || hint || env.CLAUDE_HOOK_EVENT_NAME || '';
}

/** Which harness produced this payload. Explicit override wins, then event-name shape, then env. */
function detectHarness(data, eventName, env) {
  const override = String(env.ECC_LIVE_HARNESS || '').trim().toLowerCase();
  if (override) return override;
  if (CURSOR_EVENT_TYPES[eventName]) return HARNESSES.CURSOR;
  if (CLAUDE_EVENT_TYPES[eventName]) return HARNESSES.CLAUDE;
  if (env.CURSOR_VERSION || env.CURSOR_PROJECT_DIR || data.conversation_id) return HARNESSES.CURSOR;
  return HARNESSES.CLAUDE;
}

function str(value, limit = 80) {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

function normalizeClaude(data, type, base) {
  switch (type) {
    case 'session_start':
      return [{ ...base, source: str(data.source) }];
    case 'prompt':
      return [{ ...base, prompt: clip(data.prompt, PROMPT_LIMIT) }];
    case 'tool_start':
    case 'tool_end':
    case 'tool_fail': {
      const toolName = str(data.tool_name) || 'unknown';
      const input = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
      const event = { ...base, tool_name: toolName, target: describeTarget(toolName, input) };
      if (typeof data.tool_use_id === 'string') event.tool_use_id = data.tool_use_id;
      if ((toolName === 'Agent' || toolName === 'Task') && typeof input.subagent_type === 'string') {
        event.subagent_type = input.subagent_type;
        event.description = clip(input.description || '', TARGET_LIMIT);
      }
      if (type === 'tool_fail' && typeof data.error === 'string') event.error = clip(data.error, TARGET_LIMIT);
      return [event];
    }
    case 'session_end':
      return [{ ...base, reason: str(data.reason) }];
    default:
      return [base];
  }
}

function cursorTarget(spec, data) {
  if (spec.tool === 'Bash') return clip(data.command || data.args?.command || '', TARGET_LIMIT);
  if (spec.tool === 'MCP') return clip(`${data.server || data.mcp_server || 'mcp'}/${data.tool || data.mcp_tool || 'tool'}`, TARGET_LIMIT);
  return clip(data.path || data.file || data.args?.filePath || '', TARGET_LIMIT);
}

function normalizeCursor(data, spec, base) {
  const withCursor = {
    ...base,
    session_id: str(data.conversation_id) || base.session_id,
    cwd: Array.isArray(data.workspace_roots) && typeof data.workspace_roots[0] === 'string' ? data.workspace_roots[0] : base.cwd,
    model: str(data.model)
  };
  switch (spec.type) {
    case 'prompt':
      return [{ ...withCursor, prompt: clip(data.prompt || data.content || data.message || '', PROMPT_LIMIT) }];
    case 'tool_start':
    case 'tool_end': {
      const toolName = spec.tool === 'MCP' ? `mcp:${data.tool || data.mcp_tool || 'tool'}` : spec.tool;
      const event = { ...withCursor, tool_name: toolName, target: cursorTarget(spec, data) };
      if (!spec.instant) return [event];
      return [event, { ...event, type: 'tool_end' }];
    }
    case 'subagent_start':
    case 'subagent_stop':
      return [{ ...withCursor, agent_type: str(data.agent_name || data.agent) || 'subagent', agent_id: str(data.agent_id || data.generation_id || `${data.agent_name || data.agent || 'agent'}`) }];
    default:
      return [withCursor];
  }
}

/**
 * Normalize a raw hook payload into zero or more compact event lines.
 * Returns [] when the payload is not an event the dashboard understands.
 */
function normalizeEvents(data, options = {}) {
  if (!data || typeof data !== 'object') return [];
  const env = options.env || process.env;
  const eventName = resolveEventName(data, options.eventName, env);
  const harness = detectHarness(data, eventName, env);
  const spec = harness === HARNESSES.CURSOR ? CURSOR_EVENT_TYPES[eventName] : null;
  const claudeType = CLAUDE_EVENT_TYPES[eventName];
  if (!spec && !claudeType) return [];

  const base = {
    ts: options.now || Date.now(),
    type: spec ? spec.type : claudeType,
    harness,
    session_id: str(data.session_id) || 'unknown'
  };
  if (typeof data.cwd === 'string') base.cwd = data.cwd;
  if (typeof data.agent_id === 'string') base.agent_id = data.agent_id;
  if (typeof data.agent_type === 'string') base.agent_type = data.agent_type;
  if (typeof data.parent_tool_use_id === 'string') base.parent_tool_use_id = data.parent_tool_use_id;

  return spec ? normalizeCursor(data, spec, base) : normalizeClaude(data, base.type, base);
}

module.exports = {
  CLAUDE_EVENT_TYPES,
  CURSOR_EVENT_TYPES,
  HARNESSES,
  describeTarget,
  detectHarness,
  normalizeEvents
};
