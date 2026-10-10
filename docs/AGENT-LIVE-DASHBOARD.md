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

## Launcher

Besides watching, the dashboard can **start** an ECC workflow for you. The
header **Launch** button opens a drawer: pick a workflow (grouped, searchable),
describe the task, choose the project folder, choose *Plan only* or *Can edit
files*, then **Start run**. The run appears on the live board as soon as its
first hook event arrives, with a control panel above the agents.

```bash
claude auth login                 # once: the launcher drives the `claude` CLI, so it must be signed in
npm run dashboard:live:launch     # same as: node scripts/agent-live-dashboard.js --launch
```

Without `--launch` (or `ECC_LIVE_LAUNCH=1`) the server stays strictly
read-only: every write endpoint answers 403 and the drawer explains how to
enable it. `--demo` never enables launching.

### How a run works

- The server spawns `claude -p` (no shell) in the folder you chose with a
  pre-assigned `--session-id`, so the run and its hook-driven session share one id.
- The prompt goes to the child on **stdin**, never argv. It is a fixed template:
  *follow the ECC workflow defined in `<repo>/commands/<name>.md` for the task
  below, honor its human gates*. Workflows are therefore found by file, so they
  work in any project, whether or not ECC is installed there.
- **Gates.** Headless runs cannot ask questions, so an `orch-*` workflow ends its
  turn at each gate. The panel then offers **Approve plan & continue**,
  **Confirm commit**, or a free-text reply. Each one resumes the same session
  with `--resume`, in the original folder. Approve and Confirm raise the mode to
  *Can edit files*; that click is the only way a run escalates from plan mode.
- **Stop** sends SIGTERM to the run's process group, then SIGKILL after 5 s.
- Runs live in memory. Restarting the dashboard stops them and forgets them.

### Safety model

| Control | Behaviour |
|---------|-----------|
| Opt-in | Writes are off unless `--launch` / `ECC_LIVE_LAUNCH=1` |
| Origin | Host must be loopback; writes need an Origin that equals `http://<Host>` exactly, port included (or `Sec-Fetch-Site: same-origin` when Origin is absent) |
| CSRF | `Content-Type: application/json` plus a per-start random token (`X-ECC-Live-Token`) embedded in the page; run data (`GET /api/launch/runs...`) needs the token too |
| Crash safety | Malformed request targets get 400. SSE streams are capped at 16. On exit, crash, SIGTERM or SIGHUP every run's process group is killed before the dashboard goes away |
| Page hardening | CSP with a per-response script nonce, `X-Frame-Options: DENY`, `frame-ancestors 'none'` |
| Permissions | Only `plan` and `acceptEdits`. Never `bypassPermissions`, `auto` or `dontAsk` |
| Folders | Absolute, existing, realpath'd, inside `ECC_LIVE_ALLOWED_ROOTS` (default: your home folder). Never a system directory, never the home folder itself, never `~/Library`, never any hidden folder (`.ssh`, `.claude`, `.config`, `.git`…). Every failure returns the same generic error so folders cannot be probed |
| Environment | The child gets an allowlist only (PATH, HOME, LANG, TERM, proxy and TLS vars, `ANTHROPIC_*`, `CLAUDE_*`, `ECC_*`). `GITHUB_TOKEN`, `AWS_*`, `OPENAI_API_KEY` and the rest are not passed |
| ECC checkout | When the folder is outside this checkout, the run gets `--add-dir` for it (so skills can be read) plus deny rules for Edit/Write on it. Commands whose real path escapes `commands/` are skipped. Bash can still write, so this is defense in depth |
| Escalation | Leaving plan mode on a follow-up needs `confirmEscalation: true` (the UI sends it only from the Approve/Confirm buttons or the explicit edit-mode choice). The stored folder is re-validated on every follow-up |
| Commands | Only names found in this repo's `commands/` |
| Limits | 3 concurrent runs, 60 min timeout, 8000-char task, 16 KB request body, bounded logs |
| Output | Results and stderr are redacted (passwords, API keys, Bearer, Slack and JWT tokens, AWS keys, PEM blocks) and clipped; env and prompts are never returned |

`acceptEdits` lets Claude change files in the chosen folder without asking.
Work on a git branch. Headless runs cannot approve extra tool use, so steps
that need Bash (tests, `git commit`) can stall unless your Claude settings
already allow them.

### Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `ECC_LIVE_LAUNCH` | off | `1` enables launching |
| `ECC_LIVE_ALLOWED_ROOTS` | `$HOME` | colon-separated folders runs may use |
| `ECC_LIVE_MAX_BUDGET_USD` | unset | passed to `claude --max-budget-usd`; not settable from the browser |

### API

| Method and path | Purpose |
|-----------------|---------|
| `GET /api/launch/catalog` | `{enabled, items, permissionModes, maxConcurrent}` |
| `POST /api/launch/runs` | `{command, task, cwd, permissionMode, model?}` returns `201 {run}` |
| `POST /api/launch/runs/:id/follow-up` | `{message, permissionMode?, confirmEscalation?}` returns `202 {run}` |
| `POST /api/launch/runs/:id/stop` | returns `202 {run}`; an empty body is fine |
| `GET /api/launch/runs`, `GET /api/launch/runs/:id` | run summaries and detail; require the token header |

Errors are `{error, code}`: 400 validation (`bad_cwd`, `escalation_unconfirmed`…),
403 guard or disabled, 404 unknown, 409 wrong state, 413 body over 64 KB,
415 content type, 429 too many runs. A run that hits its 60 minute limit ends
as `failed` with "Timed out" in its stderr.

### Known limits

- The token is readable by any process on your computer that can reach the
  loopback port. The boundary is your browser's same-origin rules plus the Host
  check, so do not enable `--launch` on a shared machine.
- Not supported on Windows: `--launch` refuses to start there.
- Cloud providers that rely on `AWS_*` or `GOOGLE_*` variables need them added
  to the allowlist in `agent-live-runner-process.js`.
- The Edit/Write deny rule syntax could not be verified without a signed-in CLI.

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
| `scripts/agent-live-launcher-ui.html` | Launcher drawer and run control panel, injected into the UI |
| `scripts/lib/agent-live-launch-*.js` | catalog, validators, write guard, routes |
| `scripts/lib/agent-live-runner*.js`, `agent-live-redact.js` | spawns and supervises `claude -p` runs, secret redaction |
| `scripts/lib/agent-live-launch-wiring.js` | runner, routes, token, CSP and page rendering for the server |
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
