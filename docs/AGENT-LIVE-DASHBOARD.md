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
| `scripts/hooks/agent-live-tracker.js` | hook: normalize + append JSONL (always exit 0) |
| `scripts/lib/agent-live-state.js` | pure reducer: events → sessions/agents/stages/feed |
| `scripts/agent-live-dashboard.js` | loopback HTTP + SSE server, `--demo --loop` |
| `scripts/agent-live-ui.html` | single-file UI, light/dark, reduced-motion aware |
| `scripts/lib/agent-live-demo.js` | scripted scenario used by `--demo` |
| `scripts/agent-live-install.js` | print / merge / remove settings.json hook entries |
| `tests/lib/agent-live-state.test.js`, `tests/hooks/agent-live-tracker.test.js` | tests |

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
