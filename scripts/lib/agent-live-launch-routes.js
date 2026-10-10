'use strict';

/**
 * Agent Live Launch Routes — the /api/launch/* HTTP surface.
 *
 * Read endpoints work whether or not launching is enabled (they report
 * enabled:false). The catalog is open (it holds no secrets); run data (the
 * run list and a single run) needs the launch token when launching is enabled,
 * because results can contain code and file contents. Every write endpoint is refused with 403 launch_disabled
 * unless the server was started with --launch, then passes the write guard
 * (Origin / content-type / token) before the body is read or validated.
 */

const { redactSecrets } = require('./agent-live-events');
const { checkToken, checkWriteRequest, readJsonBody } = require('./agent-live-launch-guard');
const { PERMISSION_MODES, resolveCwd, validateFollowUp, validateRunRequest } = require('./agent-live-launch-validate');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_CONCURRENT = 3;
const LOG_MESSAGE_LIMIT = 200;
const RUNNER_ERROR_STATUS = Object.freeze({
  too_many_runs: 429,
  unknown_run: 404,
  run_active: 409,
  not_running: 409
});

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function publicItem(item) {
  return { name: item.name, description: item.description, category: item.category, argumentHint: item.argumentHint };
}

function summarizeRuns(runner) {
  return runner.list().map(run => ({ sessionId: run.sessionId, status: run.status, command: run.command }));
}

/** Safe-to-log form of an unexpected error: secrets masked, length capped. Never includes the request. */
function describeError(error) {
  const message = redactSecrets(error && error.message ? error.message : String(error));
  return message.slice(0, LOG_MESSAGE_LIMIT);
}

function createLaunchRoutes({ enabled, runner, catalog, roots, allowedHosts, token, maxConcurrent, home }) {
  const concurrency = maxConcurrent || (runner && runner.maxConcurrent) || DEFAULT_MAX_CONCURRENT;
  const fail = (res, status, code, error, headers) => sendJson(res, status, { error, code }, headers);

  async function handleWrite(req, res, action, bodyOptions) {
    if (!enabled) return fail(res, 403, 'launch_disabled', 'Launching is disabled. Start the server with --launch.');
    const guard = checkWriteRequest(req, { allowedHosts, token });
    if (!guard.ok) return fail(res, guard.status, guard.code, guard.error);
    let body;
    try {
      body = await readJsonBody(req, undefined, bodyOptions);
    } catch (error) {
      const status = error.status || 400;
      return fail(res, status, error.code || 'bad_json', error.message, status === 413 ? { Connection: 'close' } : {});
    }
    try {
      return await action(body);
    } catch (error) {
      const status = RUNNER_ERROR_STATUS[error.code];
      if (!status) {
        console.error('[AgentLive] launch failed:', describeError(error));
        return fail(res, 500, 'launch_failed', 'Launch failed unexpectedly.');
      }
      return fail(res, status, error.code, error.message);
    }
  }

  const startRun = (req, res) => handleWrite(req, res, body => {
    const checked = validateRunRequest(body, { catalog, roots, home });
    if (!checked.ok) return fail(res, checked.status, checked.code, checked.error);
    return sendJson(res, 201, { run: runner.start(checked.value) });
  });

  const followUp = (req, res, id) => handleWrite(req, res, body => {
    const run = runner.get(id);
    if (!run) return fail(res, 404, 'unknown_run', 'No such run');
    const checked = validateFollowUp(body, { currentMode: run.permissionMode });
    if (!checked.ok) return fail(res, checked.status, checked.code, checked.error);
    // The folder may have moved, been replaced by a symlink or been removed since the run started.
    const cwd = resolveCwd(run.cwd, roots, { home });
    if (!cwd.ok) return fail(res, 400, cwd.code, cwd.error);
    return sendJson(res, 202, { run: runner.followUp(id, checked.value) });
  });

  const stopRun = (req, res, id) => handleWrite(req, res, () => sendJson(res, 202, { run: runner.stop(id) }), { allowEmpty: true });

  /** Run data is token-gated when launching is enabled; returns false after sending a 403. */
  function authorizeRead(req, res) {
    if (!enabled) return true;
    const guard = checkToken(req, token);
    if (!guard.ok) fail(res, guard.status, guard.code, guard.error);
    return guard.ok;
  }

  /** Returns true when the request was handled here. */
  async function handle(req, res, url) {
    const path = url.pathname;
    if (!path.startsWith('/api/launch/')) return false;

    if (req.method === 'GET' && path === '/api/launch/catalog') {
      sendJson(res, 200, {
        enabled,
        items: enabled ? catalog.map(publicItem) : [],
        permissionModes: PERMISSION_MODES,
        maxConcurrent: concurrency
      });
      return true;
    }
    if (req.method === 'GET' && path === '/api/launch/runs') {
      if (authorizeRead(req, res)) sendJson(res, 200, { runs: enabled ? runner.list() : [] });
      return true;
    }
    if (req.method === 'POST' && path === '/api/launch/runs') {
      await startRun(req, res);
      return true;
    }

    const match = path.match(/^\/api\/launch\/runs\/([^/]+)(?:\/(follow-up|stop))?$/);
    if (match && UUID_PATTERN.test(match[1])) {
      const [, id, verb] = match;
      if (req.method === 'GET' && !verb) {
        if (!authorizeRead(req, res)) return true;
        const run = enabled ? runner.get(id) : null;
        if (run) sendJson(res, 200, { run });
        else fail(res, 404, 'unknown_run', 'No such run.');
        return true;
      }
      if (req.method === 'POST' && verb === 'follow-up') {
        await followUp(req, res, id);
        return true;
      }
      if (req.method === 'POST' && verb === 'stop') {
        await stopRun(req, res, id);
        return true;
      }
    }
    fail(res, 404, 'not_found', 'not found');
    return true;
  }

  return { handle, summarize: () => ({ enabled, runs: enabled ? summarizeRuns(runner) : [] }) };
}

module.exports = { createLaunchRoutes };
