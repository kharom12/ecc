#!/usr/bin/env node
/**
 * Agent Live Tracker — one hook script for every lifecycle event of a
 * supported harness (Claude Code, Cursor).
 *
 * Appends normalized, sanitized event lines to <claudeDir>/ecc-live/events.jsonl
 * so scripts/agent-live-dashboard.js can stream agent activity to a browser.
 *
 * Claude Code: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 *   PostToolUseFailure, SubagentStart, SubagentStop, Stop, SessionEnd.
 * Cursor: sessionStart, sessionEnd, beforeSubmitPrompt, before/afterShellExecution,
 *   before/afterMCPExecution, beforeReadFile, afterFileEdit, subagentStart/Stop, stop.
 * (Run `node scripts/agent-live-install.js [--cursor]` to print or merge the config.)
 *
 * Best-effort: never blocks, always exits 0, no network, sub-5ms append.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readStdinRaw, resolveMaxStdin } = require('./hook-input');
const { appendFile, getClaudeDir } = require('../lib/utils');
const { CLAUDE_EVENT_TYPES, HARNESSES, describeTarget, detectHarness, normalizeEvents } = require('../lib/agent-live-events');

const LIVE_DIR_NAME = 'ecc-live';
const EVENTS_FILE_NAME = 'events.jsonl';
const ROTATE_BYTES = 20 * 1024 * 1024;

function getEventsPath(env = process.env) {
  if (env.ECC_LIVE_EVENTS_FILE && env.ECC_LIVE_EVENTS_FILE.trim()) {
    return path.resolve(env.ECC_LIVE_EVENTS_FILE.trim());
  }
  return path.join(getClaudeDir(), LIVE_DIR_NAME, EVENTS_FILE_NAME);
}

/** Backwards-compatible single-event view (first line, or null). */
function normalizeEvent(data, options = {}) {
  const events = normalizeEvents(data, options);
  return events.length ? events[0] : null;
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

  const events = normalizeEvents(data, options);
  if (!events.length) return { exitCode: 0 };

  const filePath = options.eventsPath || getEventsPath();
  try {
    rotateIfLarge(filePath);
    appendFile(filePath, events.map(event => `${JSON.stringify(event)}\n`).join(''));
  } catch (error) {
    return { stderr: `[AgentLive] write failed: ${error.message}`, exitCode: 0 };
  }
  return { exitCode: 0, event: events[0], events };
}

async function cli() {
  const maxStdin = resolveMaxStdin(process.env.ECC_HOOK_INPUT_MAX_BYTES);
  const { raw } = await readStdinRaw(process.stdin, { maxStdin });
  const result = run(raw, { eventName: process.argv[2] });
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  // Cursor hooks expect stdin echoed back on stdout; keep Claude Code stdout empty.
  const harness = result.events ? result.events[0].harness : detectHarness({}, process.argv[2], process.env);
  if (harness === HARNESSES.CURSOR) process.stdout.write(raw);
  process.exit(0);
}

if (require.main === module) {
  cli();
}

module.exports = { EVENT_TYPES: CLAUDE_EVENT_TYPES, describeTarget, getEventsPath, normalizeEvent, normalizeEvents, run };
