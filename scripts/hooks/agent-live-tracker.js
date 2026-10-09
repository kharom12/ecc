#!/usr/bin/env node
/**
 * Agent Live Tracker — one hook script for every Claude Code lifecycle event.
 *
 * Appends a normalized, sanitized event line to <claudeDir>/ecc-live/events.jsonl
 * so scripts/agent-live-dashboard.js can stream agent activity to a browser.
 *
 * Register for: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 * PostToolUseFailure, SubagentStart, SubagentStop, Stop, SessionEnd.
 * (Run `node scripts/agent-live-install.js` to print or merge the config.)
 *
 * Best-effort: never blocks, always exits 0, no network, sub-5ms append.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinRaw, resolveMaxStdin } = require('./hook-input');
const { appendFile, getClaudeDir, stripAnsi } = require('../lib/utils');

const LIVE_DIR_NAME = 'ecc-live';
const EVENTS_FILE_NAME = 'events.jsonl';
const ROTATE_BYTES = 20 * 1024 * 1024;
const PROMPT_LIMIT = 400;
const TARGET_LIMIT = 160;

const EVENT_TYPES = Object.freeze({
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

function getEventsPath(env = process.env) {
  if (env.ECC_LIVE_EVENTS_FILE && env.ECC_LIVE_EVENTS_FILE.trim()) {
    return path.resolve(env.ECC_LIVE_EVENTS_FILE.trim());
  }
  return path.join(getClaudeDir(), LIVE_DIR_NAME, EVENTS_FILE_NAME);
}

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

function resolveEventName(data, hint) {
  const fromPayload = data && typeof data.hook_event_name === 'string' ? data.hook_event_name : '';
  const fromEnv = process.env.CLAUDE_HOOK_EVENT_NAME || '';
  return fromPayload || hint || fromEnv || '';
}

/**
 * Normalize a raw Claude Code hook payload into a compact event line.
 * Returns null when the payload is not an event this tracker understands.
 */
function normalizeEvent(data, options = {}) {
  if (!data || typeof data !== 'object') return null;
  const eventName = resolveEventName(data, options.eventName);
  const type = EVENT_TYPES[eventName];
  if (!type) return null;

  const base = {
    ts: options.now || Date.now(),
    type,
    session_id: typeof data.session_id === 'string' ? data.session_id.slice(0, 80) : 'unknown'
  };
  if (typeof data.cwd === 'string') base.cwd = data.cwd;
  if (typeof data.agent_id === 'string') base.agent_id = data.agent_id;
  if (typeof data.agent_type === 'string') base.agent_type = data.agent_type;
  if (typeof data.parent_tool_use_id === 'string') base.parent_tool_use_id = data.parent_tool_use_id;

  switch (type) {
    case 'session_start':
      return { ...base, source: typeof data.source === 'string' ? data.source : undefined };
    case 'prompt':
      return { ...base, prompt: clip(data.prompt, PROMPT_LIMIT) };
    case 'tool_start':
    case 'tool_end':
    case 'tool_fail': {
      const toolName = typeof data.tool_name === 'string' ? data.tool_name : 'unknown';
      const input = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
      const event = { ...base, tool_name: toolName, target: describeTarget(toolName, input) };
      if (typeof data.tool_use_id === 'string') event.tool_use_id = data.tool_use_id;
      if ((toolName === 'Agent' || toolName === 'Task') && typeof input.subagent_type === 'string') {
        event.subagent_type = input.subagent_type;
        event.description = clip(input.description || '', TARGET_LIMIT);
      }
      if (type === 'tool_fail' && typeof data.error === 'string') event.error = clip(data.error, TARGET_LIMIT);
      return event;
    }
    case 'session_end':
      return { ...base, reason: typeof data.reason === 'string' ? data.reason : undefined };
    default:
      return base;
  }
}

function rotateIfLarge(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > ROTATE_BYTES) fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // File may not exist yet; nothing to rotate.
  }
}

function run(raw, options = {}) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { stderr: '[AgentLive] skipped: stdin is not JSON', exitCode: 0 };
  }

  const event = normalizeEvent(data, options);
  if (!event) return { exitCode: 0 };

  const filePath = options.eventsPath || getEventsPath();
  try {
    rotateIfLarge(filePath);
    appendFile(filePath, `${JSON.stringify(event)}\n`);
  } catch (error) {
    return { stderr: `[AgentLive] write failed: ${error.message}`, exitCode: 0 };
  }
  return { exitCode: 0, event };
}

async function cli() {
  const maxStdin = resolveMaxStdin(process.env.ECC_HOOK_INPUT_MAX_BYTES);
  const { raw } = await readStdinRaw(process.stdin, { maxStdin });
  const result = run(raw, { eventName: process.argv[2] });
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exit(0);
}

if (require.main === module) {
  cli();
}

module.exports = { EVENT_TYPES, describeTarget, getEventsPath, normalizeEvent, run };
