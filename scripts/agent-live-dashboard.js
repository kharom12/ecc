#!/usr/bin/env node
/**
 * ECC Agent Live Dashboard — realtime view of the main session and every
 * subagent while a task runs. Tails the JSONL written by
 * scripts/hooks/agent-live-tracker.js and streams snapshots over SSE.
 *
 * Usage:
 *   node scripts/agent-live-dashboard.js [--port 3457] [--file <events.jsonl>]
 *   node scripts/agent-live-dashboard.js --demo [--loop]     # scripted feature task
 *   node scripts/agent-live-dashboard.js --hide-ended         # omit ended sessions from the stream
 *   node scripts/agent-live-dashboard.js --launch             # enable the Launcher (start/stop ECC workflows from the UI)
 *
 * Open http://127.0.0.1:3457
 */

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  LOOPBACK_HOSTNAMES,
  buildAllowedHostnames,
  isAllowedHostHeader,
  isAllowedOrigin
} = require('./lib/loopback-guard');
const { buildSnapshot } = require('./lib/agent-live-state');
const { getEventsPath } = require('./hooks/agent-live-tracker');
const { playScenario } = require('./lib/agent-live-demo');
const { createLauncher } = require('./lib/agent-live-launch-wiring');

const ROOT = path.resolve(__dirname, '..');
const UI_PATH = path.join(__dirname, 'agent-live-ui.html');
const DEFAULT_PORT = 3457;
const DEFAULT_HOST = '127.0.0.1';
const POLL_MS = 300;
const HEARTBEAT_MS = 15000;
const MAX_EVENTS_IN_MEMORY = 20000;

function parseArgs(argv) {
  const args = argv.slice(2);
  const read = flag => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const port = Number.parseInt(read('--port') || process.env.ECC_LIVE_PORT || String(DEFAULT_PORT), 10);
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    file: read('--file'),
    demo: args.includes('--demo'),
    loop: args.includes('--loop'),
    hideEnded: args.includes('--hide-ended'),
    launch: args.includes('--launch') || /^(1|true|yes)$/i.test(String(process.env.ECC_LIVE_LAUNCH || '')),
    help: args.includes('--help') || args.includes('-h')
  };
}

function resolveHost(env = process.env) {
  const configured = String(env.ECC_LIVE_HOST || '').trim().toLowerCase();
  if (!configured) return DEFAULT_HOST;
  if (!LOOPBACK_HOSTNAMES.has(configured)) {
    throw new Error('[AgentLive] ECC_LIVE_HOST must be loopback-only (127.0.0.1, localhost, or ::1).');
  }
  return configured === '[::1]' ? '::1' : configured;
}

function parseLines(text) {
  return text
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Incremental JSONL tail: remembers byte offset and a partial trailing line.
 * When the file shrinks (truncate or rotation) it calls options.onReset so the
 * consumer can drop stale in-memory state before reading the fresh content.
 */
function createTail(filePath, options = {}) {
  let offset = 0;
  let partial = '';
  return () => {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return [];
    }
    if (stat.size < offset) {
      offset = 0;
      partial = '';
      if (typeof options.onReset === 'function') options.onReset();
    }
    if (stat.size === offset) return [];
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      offset = stat.size;
      const text = partial + buffer.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      partial = lastNewline === -1 ? text : text.slice(lastNewline + 1);
      return parseLines(lastNewline === -1 ? '' : text.slice(0, lastNewline + 1));
    } finally {
      fs.closeSync(fd);
    }
  };
}

function loadAgentCatalog(root = ROOT) {
  const dir = path.join(root, 'agents');
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(
    fs.readdirSync(dir)
      .filter(file => file.endsWith('.md'))
      .map(file => {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        const line = match ? match[1].split('\n').find(entry => entry.startsWith('description:')) : null;
        const description = line ? line.slice('description:'.length).trim().replace(/^["']|["']$/g, '') : '';
        return [file.replace(/\.md$/, ''), description.slice(0, 220)];
      })
  );
}

// Server-side filter for --hide-ended; hiddenSessions counts only what the server dropped.
function omitEndedSessions(snapshot) {
  const sessions = snapshot.sessions.filter(session => session.status !== 'ended');
  return { ...snapshot, sessions, hiddenSessions: snapshot.sessions.length - sessions.length };
}

function createStore(options = {}) {
  let events = [];
  return {
    append(newEvents) {
      if (!newEvents.length) return false;
      events = [...events, ...newEvents];
      if (events.length > MAX_EVENTS_IN_MEMORY) events = events.slice(events.length - MAX_EVENTS_IN_MEMORY);
      return true;
    },
    reset() {
      events = [];
    },
    snapshot() {
      const snapshot = buildSnapshot(events);
      return options.hideEnded ? omitEndedSessions(snapshot) : snapshot;
    },
    size() {
      return events.length;
    }
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

const MAX_SSE_CLIENTS = 16;
const SHUTDOWN_GRACE_MS = 1500;

function createServer(options) {
  const host = resolveHost();
  const allowedHosts = buildAllowedHostnames(host);
  const hideEnded = Boolean(options.hideEnded);
  const store = createStore({ hideEnded });
  const catalog = loadAgentCatalog();
  const clients = new Set();
  const eventsPath = options.eventsPath;
  const tail = createTail(eventsPath, { onReset: () => store.reset() });
  let launcher = null;
  const buildPayload = () => ({
    ...store.snapshot(),
    mode: options.demo ? 'demo' : 'live',
    source: eventsPath,
    hideEnded,
    launcher: launcher ? launcher.routes.summarize() : { enabled: false, runs: [] }
  });

  const broadcast = () => {
    const payload = `data: ${JSON.stringify(buildPayload())}\n\n`;
    for (const client of clients) client.write(payload);
  };

  launcher = createLauncher({
    enabled: Boolean(options.launch) && !options.demo,
    root: ROOT,
    eventsPath,
    allowedHosts: Array.from(allowedHosts),
    onChange: broadcast,
    runner: options.runner,
    roots: options.allowedRoots
  });
  const runner = launcher.runner;

  const pump = () => {
    const sizeBefore = store.size();
    const appended = store.append(tail());
    if (appended || store.size() < sizeBefore) broadcast();
  };

  fs.watchFile(eventsPath, { interval: POLL_MS }, pump);
  pump();
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, HEARTBEAT_MS);

  const server = http.createServer((req, res) => {
    if (!isAllowedHostHeader(req.headers.host, allowedHosts) || !isAllowedOrigin(req.headers.origin, allowedHosts)) {
      sendJson(res, 403, { error: 'loopback only' });
      return;
    }
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, { error: 'bad request target' });
      return;
    }

    if (url.pathname === '/events') {
      if (clients.size >= MAX_SSE_CLIENTS) {
        sendJson(res, 503, { error: 'too many dashboard streams open' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive'
      });
      clients.add(res);
      res.write(`data: ${JSON.stringify(buildPayload())}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/snapshot') {
      sendJson(res, 200, buildPayload());
      return;
    }
    if (url.pathname === '/api/catalog') {
      sendJson(res, 200, catalog);
      return;
    }
    if (url.pathname.startsWith('/api/launch/')) {
      launcher.routes.handle(req, res, url).catch(error => {
        console.error('[AgentLive] launch route failed:', String(error && error.message).slice(0, 200));
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error', code: 'internal' });
        else res.end();
      });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      let html;
      try {
        html = fs.readFileSync(UI_PATH, 'utf8');
      } catch (error) {
        sendJson(res, 500, { error: `UI not found: ${error.message}` });
        return;
      }
      const nonce = launcher.newNonce();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': launcher.buildCsp(nonce)
      });
      res.end(launcher.renderPage(html, nonce));
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });

  server.on('close', () => {
    if (runner) runner.stopAll();
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    fs.unwatchFile(eventsPath, pump);
  });

  return { server, host, store, pump, runner, launcher };
}

function startDemo(eventsPath, loop) {
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.writeFileSync(eventsPath, '');
  const emit = event => fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
  return playScenario(emit, {
    loop,
    onLoop: () => fs.writeFileSync(eventsPath, '')
  });
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/agent-live-dashboard.js [--port N] [--file events.jsonl] [--demo] [--loop] [--hide-ended] [--launch]');
    return;
  }

  if (args.launch && process.platform === 'win32') {
    console.error('[AgentLive] --launch is not supported on Windows yet (no process-group control). Run the dashboard without it.');
    process.exit(1);
  }

  const eventsPath = args.demo
    ? path.join(os.tmpdir(), `ecc-live-demo-${process.pid}.jsonl`)
    : path.resolve(args.file || getEventsPath());

  if (!args.demo) fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  const stopDemo = args.demo ? startDemo(eventsPath, args.loop) : () => {};
  const { server, host, runner, launcher } = createServer({ eventsPath, demo: args.demo, hideEnded: args.hideEnded, launch: args.launch });

  server.listen(args.port, host, () => {
    const shownHost = host === '::1' ? '[::1]' : host;
    console.log(`[AgentLive] ${args.demo ? 'DEMO' : 'LIVE'} dashboard → http://${shownHost}:${args.port}`);
    console.log(`[AgentLive] tailing ${eventsPath}`);
    if (args.hideEnded) {
      console.log(`[AgentLive] --hide-ended: ended sessions are omitted from the stream${args.demo ? ' (the demo session ends, so the board empties when the scenario finishes)' : ''}`);
    }
    if (args.launch && args.demo) console.log('[AgentLive] --launch is ignored in --demo mode');
    if (runner) {
      console.log('[AgentLive] LAUNCHER ENABLED: the browser UI can start Claude runs (permission modes: plan, acceptEdits) inside your allowed folders');
      if (launcher.roots.length === 0) console.warn('[AgentLive] WARNING: no valid allowed folders. Check ECC_LIVE_ALLOWED_ROOTS; every launch will be refused.');
      else console.log(`[AgentLive] allowed folders: ${launcher.roots.join(', ')}`);
    }
    if (!args.demo) {
      console.log('[AgentLive] no events yet? run: node scripts/agent-live-install.js --write  (then restart Claude Code)');
    }
  });
  server.on('error', error => {
    console.error(`[AgentLive] ${error.code === 'EADDRINUSE' ? `port ${args.port} in use — try --port ${args.port + 1}` : error.message}`);
    process.exit(1);
  });

  // Run children are detached, so the dashboard must never exit while one still runs:
  // ask politely first, then SIGKILL every process group before exiting.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    stopDemo();
    if (runner) {
      const settled = Promise.resolve(runner.stopAll()).catch(() => {});
      await Promise.race([settled, new Promise(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS))]);
      if (typeof runner.killAllNow === 'function') runner.killAllNow();
    }
    if (args.demo) {
      try {
        fs.unlinkSync(eventsPath);
      } catch {
        // Already gone.
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  const crash = label => error => {
    console.error(`[AgentLive] ${label}:`, String(error && error.message ? error.message : error).slice(0, 300));
    if (runner && typeof runner.killAllNow === 'function') runner.killAllNow();
    process.exit(1);
  };
  process.on('uncaughtException', crash('uncaught exception'));
  process.on('unhandledRejection', crash('unhandled rejection'));
  process.on('exit', () => { if (runner && typeof runner.killAllNow === 'function') runner.killAllNow(); });
  process.on('SIGHUP', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { createServer, createStore, createTail, loadAgentCatalog, omitEndedSessions, parseArgs, parseLines, resolveHost };
