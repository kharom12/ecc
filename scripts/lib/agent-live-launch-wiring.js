'use strict';

/**
 * Agent Live Launch Wiring — everything the dashboard server needs to host the
 * Launcher, kept out of agent-live-dashboard.js: runner + routes + per-start
 * token, the page CSP, and rendering of the HTML (launcher fragment injection,
 * script nonces, token meta tag).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLaunchToken } = require('./agent-live-launch-guard');
const { loadLaunchCatalog } = require('./agent-live-launch-catalog');
const { parseAllowedRoots } = require('./agent-live-launch-validate');
const { createLaunchRoutes } = require('./agent-live-launch-routes');

const FRAGMENT_PATH = path.join(__dirname, '..', 'agent-live-launcher-ui.html');
const FRAGMENT_MARKER = '<!--ECC-LAUNCHER-->';
const TOKEN_PLACEHOLDER = '<meta name="ecc-live-token" content="">';

function parseBudget(env) {
  const value = Number.parseFloat(env.ECC_LIVE_MAX_BUDGET_USD || '');
  return Number.isFinite(value) && value > 0 ? value : null;
}

function createDefaultRunner({ root, eventsPath, onChange, env }) {
  const { createRunner } = require('./agent-live-runner');
  return createRunner({ eccRoot: root, eventsPath, onChange, maxBudgetUsd: parseBudget(env) });
}

// Scripts get a per-response nonce. Styles stay 'unsafe-inline' because the UI
// sets CSS custom properties through style attributes.
function buildCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}

function readFragment(fragmentPath) {
  try {
    return fs.readFileSync(fragmentPath, 'utf8');
  } catch {
    return '';
  }
}

/** Inject the launcher fragment, nonce every script tag, and set the token. */
function renderPage(html, { nonce, token, fragmentPath = FRAGMENT_PATH }) {
  return html
    .replace(FRAGMENT_MARKER, () => readFragment(fragmentPath))
    .replace(/<script>/g, () => `<script nonce="${nonce}">`)
    .replace(TOKEN_PLACEHOLDER, () => `<meta name="ecc-live-token" content="${token}">`);
}

/**
 * @param {object} options
 *   enabled, root, eventsPath, allowedHosts (array), onChange,
 *   runner? (inject for tests), roots? (override allowed roots), env?
 */
function createLauncher(options) {
  const env = options.env || process.env;
  const enabled = Boolean(options.enabled);
  const token = enabled ? createLaunchToken() : '';
  const runner = enabled ? (options.runner || createDefaultRunner({ root: options.root, eventsPath: options.eventsPath, onChange: options.onChange, env })) : null;
  const roots = enabled ? (options.roots || parseAllowedRoots(env)) : [];
  const catalog = enabled ? loadLaunchCatalog(options.root) : [];
  const routes = createLaunchRoutes({ enabled, runner, catalog, roots, allowedHosts: options.allowedHosts, token });

  return Object.freeze({
    enabled,
    runner,
    routes,
    roots,
    token,
    newNonce: () => crypto.randomBytes(16).toString('base64'),
    buildCsp,
    renderPage: (html, nonce) => renderPage(html, { nonce, token, fragmentPath: options.fragmentPath })
  });
}

module.exports = { FRAGMENT_MARKER, TOKEN_PLACEHOLDER, buildCsp, createLauncher, parseBudget, renderPage };
