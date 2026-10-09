#!/usr/bin/env node
/**
 * Agent Live Install — prints (default) or merges (--write) the hook entries
 * that feed scripts/agent-live-dashboard.js into ~/.claude/settings.json.
 *
 * Usage:
 *   node scripts/agent-live-install.js            # dry run: print the JSON to merge
 *   node scripts/agent-live-install.js --write    # merge into ~/.claude/settings.json (backup kept)
 *   node scripts/agent-live-install.js --remove   # remove previously merged entries
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getClaudeDir } = require('./lib/utils');

const MARKER = 'agent-live-tracker.js';
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd'
];

function quoteForShell(value) {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function buildHookEntries(repoRoot) {
  const script = quoteForShell(path.join(repoRoot, 'scripts', 'hooks', MARKER));
  return Object.fromEntries(
    EVENTS.map(eventName => [
      eventName,
      [
        {
          matcher: eventName.endsWith('ToolUse') || eventName === 'PostToolUseFailure' ? '.*' : undefined,
          hooks: [{ type: 'command', command: `node ${script} ${eventName}`, timeout: 5 }]
        }
      ].map(entry => (entry.matcher === undefined ? { hooks: entry.hooks } : entry))
    ])
  );
}

function isOurs(entry) {
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

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function writeSettings(settingsPath, settings) {
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, `${settingsPath}.bak-agent-live`);
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function main(argv = process.argv.slice(2)) {
  const repoRoot = path.resolve(__dirname, '..');
  const settingsPath = path.join(getClaudeDir(), 'settings.json');
  const additions = buildHookEntries(repoRoot);

  if (argv.includes('--remove')) {
    const settings = readSettings(settingsPath);
    writeSettings(settingsPath, { ...settings, hooks: removeHooks(settings.hooks) });
    console.log(`[AgentLive] removed tracker hooks from ${settingsPath}`);
    return;
  }

  if (argv.includes('--write')) {
    const settings = readSettings(settingsPath);
    writeSettings(settingsPath, { ...settings, hooks: mergeHooks(settings.hooks, additions) });
    console.log(`[AgentLive] merged ${EVENTS.length} hook events into ${settingsPath} (backup: .bak-agent-live)`);
    console.log('[AgentLive] restart Claude Code sessions for hooks to take effect, then run: npm run dashboard:live');
    return;
  }

  console.log('# Merge this under "hooks" in ' + settingsPath + ' (or run with --write):');
  console.log(JSON.stringify({ hooks: additions }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[AgentLive] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { EVENTS, buildHookEntries, mergeHooks, removeHooks };
