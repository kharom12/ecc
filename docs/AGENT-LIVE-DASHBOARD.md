# Agent Live Dashboard

Realtime browser view of what the main Claude Code session and every ECC
subagent are doing while a task runs: which agent is active, which tool it is
calling on which file, how the work maps onto the ECC pipeline
(Intake → Plan → TDD → Implement → Build → Review → Security → E2E → Docs → Commit),
and a Gantt timeline showing which agents ran in parallel.

```text
Claude Code hooks ──► scripts/hooks/agent-live-tracker.js ──► ~/.claude/ecc-live/events.jsonl
                                                                        │ tail (300ms)
                                              scripts/agent-live-dashboard.js ──► SSE ──► browser
                                                        (scripts/lib/agent-live-state.js reducer)
```

## Quick start

```bash
# 1. See it first with a scripted feature task (no hooks needed)
npm run dashboard:live:demo          # http://127.0.0.1:3457

# 2. Register the tracker hooks in ~/.claude/settings.json (backup kept)
npm run dashboard:live:install       # or: node scripts/agent-live-install.js   (dry run)

# 3. Restart Claude Code, start the live dashboard, give Claude a feature task
npm run dashboard:live
```

To remove the hooks: `node scripts/agent-live-install.js --remove`.

### Cursor

The same tracker and dashboard also watch Cursor agent sessions. Install the
Cursor hooks (written to `~/.cursor/hooks.json`, backup kept), restart Cursor,
then use the Agent panel as usual:

```bash
node scripts/agent-live-install.js --cursor            # dry run
node scripts/agent-live-install.js --cursor --write    # merge
node scripts/agent-live-install.js --cursor --remove   # undo
```

Every event carries a `harness` field (`claude` or `cursor`) and the UI shows
it in the header chip, the session dropdown and the main-session card, so you
always know which tool is running. Cursor sessions use `conversation_id` as the
session id, `workspace_roots[0]` as the cwd and keep the `model` when Cursor
sends it.

| Cursor event | Stored as |
|--------------|-----------|
| sessionStart / sessionEnd | `session_start` / `session_end` |
| beforeSubmitPrompt | `prompt` |
| beforeShellExecution / afterShellExecution | `tool_start` / `tool_end` (`Bash`) |
| beforeMCPExecution / afterMCPExecution | `tool_start` / `tool_end` (`mcp:<tool>`) |
| beforeReadFile, afterFileEdit | instant `tool_start` + `tool_end` pair (`Read`, `Edit`) |
| subagentStart / subagentStop | `subagent_start` / `subagent_stop` |
| stop | `stop` |

Cursor hooks must echo stdin to stdout; the tracker does so only for Cursor
events and keeps stdout empty for Claude Code. `ECC_LIVE_HARNESS` forces the
harness label, `CURSOR_CONFIG_DIR` overrides where the Cursor installer writes.

### Server flags

| Flag | Meaning |
|------|---------|
| `--port N` | listen port (default `3457`, or `ECC_LIVE_PORT`) |
| `--file <events.jsonl>` | tail a specific events file instead of the default |
| `--demo [--loop]` | play the scripted scenario; `--loop` replays it |
| `--hide-ended` | omit sessions whose status is `ended` from the SSE stream and `/api/snapshot` |

```bash
node scripts/agent-live-dashboard.js --hide-ended
```

The header also has a **Hide ended** toggle (off by default) that does the same
filtering in the browser and auto-selects the most recent non-ended session.
The choice is remembered per browser in `localStorage` (`ecc-live-hide-ended`).
Use the toggle for a per-browser preference and the flag when the server should
drop ended sessions for every client; with the flag on, the toggle is disabled.

Note: the demo scenario ends its session with a `session_end` event, so with
`--demo --hide-ended` (or the toggle on) the board empties when the scenario
finishes and fills again on the next `--loop` run.

## What is captured

| Claude Code event | Stored as | Used for |
|-------------------|-----------|----------|
| SessionStart / SessionEnd | `session_start` / `session_end` | session lifetime |
| UserPromptSubmit | `prompt` (≤400 chars, secrets redacted) | the task headline |
| PreToolUse / PostToolUse / PostToolUseFailure | `tool_start` / `tool_end` / `tool_fail` | per-agent tool spans, errors |
| PreToolUse on `Agent`/`Task` | `+ subagent_type, description` | linking a spawn to its subagent |
| SubagentStart / SubagentStop | `subagent_start` / `subagent_stop` | agent cards, parallelism |
| Stop | `stop` | main turn finished |

Only one argument per tool call is stored (file path, command, pattern, or
description), truncated to 160 characters and passed through the same
secret-redaction patterns as `session-activity-tracker.js`. Tool responses and
full prompts are never written.

Attribution uses `agent_id` when the runtime supplies it. If the runtime does
not emit `SubagentStart`/`SubagentStop`, the reducer still materializes a
"virtual" agent from the `Agent`/`Task` tool call so the pipeline view stays
useful, but its tool calls will appear under the main session.

## Files

| Path | Role |
|------|------|
| `scripts/hooks/agent-live-tracker.js` | hook entry point: append JSONL (always exit 0) |
| `scripts/lib/agent-live-events.js` | normalizes Claude Code and Cursor payloads, detects harness |
| `scripts/lib/agent-live-state.js` | pure reducer: events → sessions/agents/stages/feed |
| `scripts/agent-live-dashboard.js` | loopback HTTP + SSE server, `--demo --loop`, `--hide-ended` |
| `scripts/agent-live-ui.html` | single-file UI, light/dark, reduced-motion aware |
| `scripts/lib/agent-live-demo.js` | scripted scenario used by `--demo` |
| `scripts/agent-live-install.js` | print / merge / remove settings.json hook entries |
| `tests/lib/agent-live-state.test.js`, `tests/hooks/agent-live-tracker.test.js`, `tests/scripts/agent-live-dashboard.test.js` | tests |

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `ECC_LIVE_EVENTS_FILE` | `~/.claude/ecc-live/events.jsonl` | where the tracker writes and the server tails |
| `ECC_LIVE_PORT` | `3457` | dashboard port (`--port` overrides) |
| `ECC_LIVE_HOST` | `127.0.0.1` | loopback only; other values are rejected |

The events file rotates to `events.jsonl.1` past 20 MB. The server keeps at most
20 000 events in memory and drops its state when the file is truncated or rotated.

## Relationship to other ECC surfaces

- `npm run dashboard:web` / `npm run dashboard` are static catalogs of agents,
  skills, commands and hooks. They do not show runtime activity.
- `ecc2/` (Rust TUI) is the ECC 2.0 control plane that *launches* sessions. This
  dashboard instead *observes* an ordinary Claude Code session through hooks and
  needs only Node.
- `~/.claude/metrics/tool-usage.jsonl` (from `session-activity-tracker.js`) stores
  tool usage for metric sync but has no subagent or prompt events, which is why a
  separate stream exists.
