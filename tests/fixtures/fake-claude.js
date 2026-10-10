#!/usr/bin/env node
'use strict';

/**
 * Fake `claude -p` for agent-live-runner tests. Reads the prompt from stdin and
 * emits stream-json lines. Behaviour is driven by env knobs:
 *   FAKE_EXIT=<n>          exit code (default 0)
 *   FAKE_SLEEP_MS=<n>      delay before emitting the result
 *   FAKE_HANG=1            ignore SIGTERM and never finish (needs SIGKILL)
 *   FAKE_GRANDCHILD=1      spawn a same-group child (announced on stdout)
 *   FAKE_FLOOD_BYTES=<n>   write n bytes of newline-less junk to stdout and stderr
 *   FAKE_SPLIT=1           write the result line in two chunks, mid UTF-8 char
 *   FAKE_SECRET=1          put secrets in the result and on stderr
 *   FAKE_IS_ERROR=1        report is_error:true in the result line
 *   FAKE_FORMATTED=1       multi-line indented result; stderr with indentation, ANSI codes and secrets
 *   FAKE_HUGE_RESULT_BYTES=<n>  result line whose payload is n bytes (to exceed the line cap)
 *   FAKE_ECHO_FILE=<path>  dump {cwd, argv, stdin} as JSON to this file
 */

const fs = require('fs');
const { spawn } = require('child_process');

const env = process.env;
const argv = process.argv.slice(2);
const emit = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
const idFlag = argv.findIndex(a => a === '--session-id' || a === '--resume');
const sessionId = idFlag >= 0 ? argv[idFlag + 1] : 'none';
const SECRETS = 'sk-abcdefgh12345678 ghp_abcdefghijklmnop0123';
const FORMATTED_RESULT = 'def f():\n    return 1\n\n\tdone sk-abcdefgh12345678';
const FORMATTED_STDERR = 'Traceback:\n  File "x.py"\n    raise \u001b[31mBoom\u001b[0m password=hunter2\n--token abc123 AKIAABCDEFGHIJKLMNOP';

if (env.FAKE_HANG) process.on('SIGTERM', () => {});
if (env.FAKE_GRANDCHILD) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  emit({ type: 'system', subtype: 'grandchild', pid: child.pid });
}
emit({ type: 'system', subtype: 'init', session_id: sessionId });
if (env.FAKE_HANG) setInterval(() => {}, 1000);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  if (env.FAKE_ECHO_FILE) fs.writeFileSync(env.FAKE_ECHO_FILE, JSON.stringify({ cwd: process.cwd(), argv, stdin }));
  if (env.FAKE_HANG) return;
  setTimeout(finish, Number(env.FAKE_SLEEP_MS || 0));
});

function flood(stream, bytes) {
  const chunk = 'x'.repeat(65536);
  for (let sent = 0; sent < bytes; sent += chunk.length) stream.write(chunk.slice(0, Math.min(chunk.length, bytes - sent)));
  stream.write('\n');
}

function finish() {
  const floodBytes = Number(env.FAKE_FLOOD_BYTES || 0);
  if (floodBytes) {
    flood(process.stdout, floodBytes);
    flood(process.stderr, floodBytes);
  }
  if (env.FAKE_SECRET) process.stderr.write(`leaked ${SECRETS}\n`);
  if (env.FAKE_FORMATTED) process.stderr.write(`${FORMATTED_STDERR}\n`);
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
  const result = env.FAKE_SPLIT ? 'split héllo'
    : env.FAKE_HUGE_RESULT_BYTES ? 'z'.repeat(Number(env.FAKE_HUGE_RESULT_BYTES))
      : env.FAKE_FORMATTED ? FORMATTED_RESULT
        : env.FAKE_SECRET ? `key ${SECRETS}` : 'all done';
  const line = Buffer.from(`${JSON.stringify({ type: 'result', result, is_error: Boolean(env.FAKE_IS_ERROR), total_cost_usd: 0.0123 })}\n`);
  if (env.FAKE_SPLIT) {
    const mid = line.indexOf(0xc3) + 1; // between the two bytes of the e-acute
    process.stdout.write(line.subarray(0, mid));
    setTimeout(() => process.stdout.write(line.subarray(mid)), 30);
  } else {
    process.stdout.write(line);
  }
  process.exitCode = Number(env.FAKE_EXIT || 0);
}
