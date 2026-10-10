'use strict';

/**
 * Agent Live launch validation. Every field of a launch request is untrusted:
 * this module is the single gate that turns a raw JSON body into a vetted
 * value (or a 4xx result). All results are frozen; inputs are never mutated.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { findLaunchable } = require('./agent-live-launch-catalog');

const PERMISSION_MODES = Object.freeze(['plan', 'acceptEdits']);
const LIMITS = Object.freeze({ task: 8000, message: 4000, model: 64 });
const MAX_CWD_LENGTH = 4096;
const MODEL_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._[\\]-]{0,${LIMITS.model - 1}}$`);

// System locations that may never be a working directory.
const DENIED_EXACT = Object.freeze(['/', '/etc', '/System', '/usr', '/var', '/private', '/bin', '/sbin', '/dev', '/proc', '/sys', '/Users', '/home']);
// ...and these (plus anything beneath them) are off limits too.
const DENIED_TREES = Object.freeze(['/etc', '/System', '/usr', '/bin', '/sbin', '/dev', '/proc', '/sys']);

const fail = (status, code, error) => Object.freeze({ ok: false, status, code, error });
// One generic message for every cwd problem so a caller cannot probe which paths exist.
const CWD_ERROR = 'cwd is not an allowed project folder';
const failCwd = () => Object.freeze({ ok: false, code: 'bad_cwd', error: CWD_ERROR });
const hasNul = value => value.includes('\0');

const IS_DARWIN = process.platform === 'darwin';
// macOS volumes are case-insensitive by default: fold case before comparing paths.
const fold = value => (IS_DARWIN ? value.toLowerCase() : value);
const realpath = fs.realpathSync.native || fs.realpathSync;

function safeRealpath(p) {
  try {
    return realpath(p);
  } catch (_err) {
    return null;
  }
}

/** Relative path from root to target, or null when target is not inside root. */
function relativeInside(root, target) {
  const rel = path.relative(fold(root), fold(target));
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return null;
  return rel;
}

const isInside = (root, target) => relativeInside(root, target) !== null;
const segments = rel => rel.split(path.sep).filter(Boolean);
const hasHiddenSegment = rel => segments(rel).some(segment => segment.startsWith('.'));

function withRealpaths(paths) {
  const real = paths.map(safeRealpath).filter(Boolean);
  return new Set([...paths, ...real].map(fold));
}

const deniedExact = withRealpaths(DENIED_EXACT);
const deniedTrees = [...withRealpaths(DENIED_TREES)];

function isDenied(realCwd) {
  return deniedExact.has(fold(realCwd)) || deniedTrees.some(tree => isInside(tree, realCwd));
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_err) {
    return false; // vanished or unreadable between realpath and stat: not a usable root
  }
}

function resolveHome(options) {
  return safeRealpath((options && options.home) || os.homedir());
}

function parseAllowedRoots(env = process.env, options = {}) {
  const raw = env && env.ECC_LIVE_ALLOWED_ROOTS;
  const candidates = typeof raw === 'string' && raw.length > 0 ? raw.split(path.delimiter) : [(options && options.home) || os.homedir()];
  const roots = candidates
    .filter(c => c && path.isAbsolute(c) && !hasNul(c))
    .map(safeRealpath)
    .filter(real => real && real !== path.parse(real).root && isDirectory(real));
  return [...new Set(roots)];
}

/** Home itself, ~/Library and (via the root check) hidden folders are never project folders. */
function isProtectedHomePath(real, home) {
  if (!home) return false;
  const rel = relativeInside(home, real);
  if (rel === null) return false;
  return rel === '' || fold(segments(rel)[0]) === 'library';
}

/**
 * Vet a working directory: real, a directory, not a system or home-private
 * location, and inside an allowed root without passing through a dot-folder
 * (.ssh, .git, ...) below that root. Options: { home } overrides os.homedir().
 */
function resolveCwd(cwd, roots, options = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_CWD_LENGTH) return failCwd();
  if (hasNul(cwd) || !path.isAbsolute(cwd)) return failCwd();
  const real = safeRealpath(cwd);
  if (!real || !isDirectory(real) || isDenied(real) || isProtectedHomePath(real, resolveHome(options))) return failCwd();
  const usable = (Array.isArray(roots) ? roots : []).filter(r => typeof r === 'string' && r !== path.parse(r).root);
  const allowed = usable.some(root => {
    const rel = relativeInside(root, real);
    return rel !== null && !hasHiddenSegment(rel);
  });
  return allowed ? Object.freeze({ ok: true, value: real }) : failCwd();
}

function isPlainObject(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

function checkText(value, field, limit) {
  if (typeof value !== 'string') return `${field} must be a string`;
  if (hasNul(value)) return `${field} must not contain NUL bytes`;
  if (value.trim().length === 0) return `${field} must not be empty`;
  if (value.length > limit) return `${field} exceeds ${limit} characters`;
  return null;
}

function checkPermissionMode(mode) {
  return typeof mode === 'string' && PERMISSION_MODES.includes(mode) ? null : `permissionMode must be one of: ${PERMISSION_MODES.join(', ')}`;
}

function validateRunRequest(body, { catalog, roots, home } = {}) {
  if (!isPlainObject(body)) return fail(400, 'bad_request', 'body must be a JSON object');
  const { command, task, cwd, permissionMode, model } = body;

  if (typeof command !== 'string' || hasNul(command)) return fail(400, 'bad_command', 'command must be a string');
  const item = findLaunchable(catalog, command);
  if (!item) return fail(404, 'unknown_command', 'unknown command');

  const taskError = checkText(task, 'task', LIMITS.task);
  if (taskError) return fail(400, 'bad_task', taskError);

  const mode = permissionMode === undefined ? 'plan' : permissionMode;
  const modeError = checkPermissionMode(mode);
  if (modeError) return fail(400, 'bad_permission_mode', modeError);

  const hasModel = model !== undefined && model !== null;
  if (hasModel && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) {
    return fail(400, 'bad_model', 'model is not a valid model name');
  }

  const resolved = resolveCwd(cwd, roots, { home });
  if (!resolved.ok) return fail(400, resolved.code, resolved.error);

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      item,
      task: task.trim(),
      cwd: resolved.value,
      permissionMode: mode,
      model: hasModel ? model : null
    })
  });
}

/**
 * `currentMode` is the permission mode the run uses now. Moving it to
 * acceptEdits (anything but already-acceptEdits, including unknown) needs an
 * explicit `confirmEscalation: true` in the body.
 */
function validateFollowUp(body, { currentMode } = {}) {
  if (!isPlainObject(body)) return fail(400, 'bad_request', 'body must be a JSON object');
  const { message, permissionMode, confirmEscalation } = body;

  const messageError = checkText(message, 'message', LIMITS.message);
  if (messageError) return fail(400, 'bad_message', messageError);

  const hasMode = permissionMode !== undefined && permissionMode !== null;
  if (hasMode) {
    const modeError = checkPermissionMode(permissionMode);
    if (modeError) return fail(400, 'bad_permission_mode', modeError);
    if (permissionMode === 'acceptEdits' && currentMode !== 'acceptEdits' && confirmEscalation !== true) {
      return fail(400, 'escalation_unconfirmed', 'switching to acceptEdits requires confirmEscalation: true');
    }
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({ message: message.trim(), permissionMode: hasMode ? permissionMode : null })
  });
}

module.exports = { PERMISSION_MODES, LIMITS, parseAllowedRoots, resolveCwd, validateRunRequest, validateFollowUp };
