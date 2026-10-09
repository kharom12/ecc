#!/usr/bin/env node
/**
 * Agent Live Install — prints (default) or merges (--write) the hook entries
 * that feed scripts/agent-live-dashboard.js into the harness's hook config.
 *
 * Usage:
 *   node scripts/agent-live-install.js                    # Claude Code, dry run
 *   node scripts/agent-live-install.js --write            # merge into ~/.claude/settings.json
 *   node scripts/agent-live-install.js --cursor           # Cursor, dry run
 *   node scripts/agent-live-install.js --cursor --write   # merge into ~/.cursor/hooks.json
 *   node scripts/agent-live-install.js [--cursor] --remove
 *
 * A backup (*.bak-agent-live) is written next to any file that is modified.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getClaudeDir } = require('./lib/utils');
const { CLAUDE_EVENT_TYPES, CURSOR_EVENT_TYPES } = require('./lib/agent-live-events');

const MARKER = 'agent-live-tracker.js';
const EVENTS = Object.keys(CLAUDE_EVENT_TYPES);
const CURSOR_EVENTS = Object.keys(CURSOR_EVENT_TYPES);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

function quoteForShell(value) {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function trackerCommand(repoRoot, eventName) {
  return `node ${quoteForShell(path.join(repoRoot, 'scripts', 'hooks', MARKER))} ${eventName}`;
}

/** Claude Code settings.json shape: { hooks: { Event: [{ matcher?, hooks: [{type, command}] }] } } */
function buildHookEntries(repoRoot) {
  return Object.fromEntries(
    EVENTS.map(eventName => {
      const entry = { hooks: [{ type: 'command', command: trackerCommand(repoRoot, eventName), timeout: 5 }] };
      return [eventName, [TOOL_EVENTS.has(eventName) ? { matcher: '.*', ...entry } : entry]];
    })
  );
}

/** Cursor hooks.json shape: { version: 1, hooks: { event: [{ command, event, description }] } } */
function buildCursorHookEntries(repoRoot) {
  return Object.fromEntries(
    CURSOR_EVENTS.map(eventName => [
      eventName,
      [{ command: trackerCommand(repoRoot, eventName), event: eventName, description: 'ECC Agent Live dashboard tracker' }]
    ])
  );
}

function isOurs(entry) {
  if (typeof entry.command === 'string') return entry.command.includes(MARKER);
  return Array.isArray(entry.hooks) && entry.hooks.some(hook => String(hook.command || '').includes(MARKER));
}

function mergeHooks(existingHooks, additions) {
  const hooks = { ...(existingHooks || {}) };
  for (const [eventName, entries] of Object.entries(additions)) {
    const kept = (hooks[eventName] || []).filter(entry => !isOurs(entry));
    hooks[eventName] = [...kept, ...entries];
  }
  return hooks;
}

function removeHooks(existingHooks) {
  return Object.fromEntries(
    Object.entries(existingHooks || {})
      .map(([eventName, entries]) => [eventName, (entries || []).filter(entry => !isOurs(entry))])
      .filter(([, entries]) => entries.length > 0)
  );
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak-agent-live`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resolveTarget(argv, repoRoot, env = process.env) {
  if (argv.includes('--cursor')) {
    const cursorDir = env.CURSOR_CONFIG_DIR && env.CURSOR_CONFIG_DIR.trim() ? env.CURSOR_CONFIG_DIR.trim() : path.join(os.homedir(), '.cursor');
    return {
      name: 'Cursor',
      filePath: path.join(cursorDir, 'hooks.json'),
      additions: buildCursorHookEntries(repoRoot),
      wrap: (settings, hooks) => ({ version: 1, ...settings, hooks }),
      restartHint: 'restart Cursor for hooks to take effect'
    };
  }
  return {
    name: 'Claude Code',
    filePath: path.join(getClaudeDir(), 'settings.json'),
    additions: buildHookEntries(repoRoot),
    wrap: (settings, hooks) => ({ ...settings, hooks }),
    restartHint: 'restart Claude Code sessions for hooks to take effect'
  };
}

function main(argv = process.argv.slice(2)) {
  const repoRoot = path.resolve(__dirname, '..');
  const target = resolveTarget(argv, repoRoot);

  if (argv.includes('--remove')) {
    const settings = readJson(target.filePath);
    writeJson(target.filePath, target.wrap(settings, removeHooks(settings.hooks)));
    console.log(`[AgentLive] removed tracker hooks from ${target.filePath}`);
    return;
  }

  if (argv.includes('--write')) {
    const settings = readJson(target.filePath);
    writeJson(target.filePath, target.wrap(settings, mergeHooks(settings.hooks, target.additions)));
    const count = Object.keys(target.additions).length;
    console.log(`[AgentLive] merged ${count} ${target.name} hook events into ${target.filePath} (backup: .bak-agent-live)`);
    console.log(`[AgentLive] ${target.restartHint}, then run: npm run dashboard:live`);
    return;
  }

  console.log(`# Merge this under "hooks" in ${target.filePath} (or run with --write):`);
  console.log(JSON.stringify({ hooks: target.additions }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[AgentLive] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { CURSOR_EVENTS, EVENTS, buildCursorHookEntries, buildHookEntries, mergeHooks, removeHooks, resolveTarget };
