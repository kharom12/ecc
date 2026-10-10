'use strict';

/**
 * Process-level helpers for the Agent Live runner: the child environment
 * allowlist, the ECC-checkout write protection arguments and process-group
 * signalling. Kept apart from agent-live-runner.js so each stays small.
 */

const fs = require('fs');
const path = require('path');

const ENV_EXACT = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TZ', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'
]);
// SHLVL and everything else (GITHUB_TOKEN, AWS_*, OPENAI_API_KEY, NPM_TOKEN, ...) is deliberately absent.
const ENV_PREFIXES = Object.freeze(['LC_', 'XDG_', 'SSL_CERT_', 'ANTHROPIC_', 'CLAUDE_', 'ECC_']);
const WINDOWS_ENV = Object.freeze(['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH']);

const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const realpath = fs.realpathSync.native || fs.realpathSync;
const IS_DARWIN = process.platform === 'darwin';
const fold = value => (IS_DARWIN ? value.toLowerCase() : value);

function isAllowedEnvName(name) {
  if (ENV_EXACT.includes(name) || ENV_PREFIXES.some(prefix => name.startsWith(prefix))) return true;
  return process.platform === 'win32' && WINDOWS_ENV.includes(name.toUpperCase());
}

/**
 * Environment for the spawned `claude`: only the allowlisted variables of
 * `env` (never other secrets such as cloud or registry tokens), plus the
 * events file the hooks append to. Pure; `env` is not modified.
 */
function buildChildEnv(env, eventsPath) {
  const child = {};
  for (const [name, value] of Object.entries(env || {})) {
    if (typeof value === 'string' && isAllowedEnvName(name)) child[name] = value;
  }
  if (eventsPath) child.ECC_LIVE_EVENTS_FILE = eventsPath;
  return child;
}

function resolveReal(p) {
  try {
    return realpath(p);
  } catch (_err) {
    return path.resolve(p); // not on disk (yet): compare the lexical path
  }
}

function isInside(root, target) {
  const rel = path.relative(fold(root), fold(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Arguments that expose the ECC checkout (so workflow files can be read)
 * without letting the agent edit it. Nothing is added when the working
 * directory is inside the checkout: the user deliberately targets that repo.
 *
 * The deny rule is defense in depth only. `//<path>` is Claude Code's
 * permission syntax for an absolute filesystem path, but it could not be
 * verified offline, and the Bash tool can still write anywhere the process can.
 */
function eccRootArgs(eccRoot, cwd) {
  const realRoot = resolveReal(eccRoot);
  if (isInside(realRoot, resolveReal(cwd))) return [];
  const roots = [...new Set([realRoot, path.resolve(eccRoot)])];
  const rules = roots.flatMap(root => EDIT_TOOLS.map(tool => `${tool}(/${root}/**)`));
  return [`--add-dir=${eccRoot}`, `--disallowed-tools=${rules.join(',')}`];
}

/**
 * Signal a child's whole process group (POSIX) or the child itself. Never
 * throws: returns null on success or when the process is already gone (ESRCH),
 * otherwise the error (EPERM, ...) so the caller can report it.
 */
function signalTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return null;
    } catch (_err) {
      // group already gone or not a group leader: fall back to the direct child
    }
  }
  try {
    child.kill(signal);
    return null;
  } catch (err) {
    return err && err.code === 'ESRCH' ? null : err;
  }
}

/** argv for one `claude -p` turn: a new session (`--session-id`) or a resumed one (`--resume`). The prompt never goes here. */
function buildArgs({ resume = false, sessionId, permissionMode, model, budget, eccRoot, cwd }) {
  return [
    '-p', resume ? '--resume' : '--session-id', sessionId, '--permission-mode', permissionMode, '--output-format', 'stream-json', '--verbose',
    ...(model ? ['--model', model] : []), ...(budget ? ['--max-budget-usd', String(budget)] : []), ...eccRootArgs(eccRoot, cwd)
  ];
}

/** Resolves when `entry.done` does, or after `ceilingMs`: a child that survives SIGKILL must not hang shutdown. */
function waitSettled(entry, ceilingMs) {
  return new Promise(resolve => {
    const ceiling = setTimeout(resolve, ceilingMs);
    entry.done.then(() => { clearTimeout(ceiling); resolve(); });
  });
}

module.exports = { buildArgs, buildChildEnv, eccRootArgs, signalTree, waitSettled };
