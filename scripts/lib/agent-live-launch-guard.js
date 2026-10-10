'use strict';

/**
 * Agent Live write-request guard. Launching an agent from a local web page is
 * remote-code-execution-shaped, so every state-changing request must prove it
 * comes from our own page (Origin / Sec-Fetch-Site), is real JSON (blocks
 * simple cross-site form posts), and carries the per-process launch token.
 * The token is never logged or echoed back.
 */

const crypto = require('crypto');

const TOKEN_HEADER = 'x-ecc-live-token';
const DEFAULT_MAX_BODY_BYTES = 65536; // room for an 8000-character task in multi-byte text

const reject = (status, code, error) => Object.freeze({ ok: false, status, code, error });
const OK = Object.freeze({ ok: true });

function createLaunchToken() {
  return crypto.randomBytes(32).toString('hex');
}

function headerString(headers, name) {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function isAllowedOrigin(origin, allowedHosts) {
  let hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch (_err) {
    return false;
  }
  const hosts = Array.isArray(allowedHosts) ? allowedHosts : [];
  return hostname.length > 0 && (hosts.includes(hostname) || hosts.includes(hostname.replace(/^\[|\]$/g, '')));
}

/** The page is served over plain http, so a same-origin Origin is exactly `http://<Host header>`. */
function originMatchesHost(origin, host) {
  return typeof host === 'string' && host.length > 0 && origin.toLowerCase() === `http://${host.toLowerCase()}`;
}

function originAllowed(headers, allowedHosts) {
  const origin = headerString(headers, 'origin');
  if (origin !== undefined) {
    return originMatchesHost(origin, headerString(headers, 'host')) &&
      isAllowedOrigin(origin, allowedHosts) &&
      headerString(headers, 'sec-fetch-site') !== 'cross-site';
  }
  return headerString(headers, 'sec-fetch-site') === 'same-origin';
}

function tokensMatch(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  // Hash both sides so lengths always match and timingSafeEqual never throws.
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Constant-time check of the per-process token header (used by write and run-data read endpoints). */
function checkToken(req, token) {
  const headers = (req && req.headers) || {};
  if (!tokensMatch(headerString(headers, TOKEN_HEADER), token)) return reject(403, 'bad_token', 'missing or invalid launch token');
  return OK;
}

function checkWriteRequest(req, { allowedHosts, token } = {}) {
  const headers = (req && req.headers) || {};

  if (!originAllowed(headers, allowedHosts)) return reject(403, 'bad_origin', 'request origin is not allowed');

  const mediaType = (headerString(headers, 'content-type') || '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return reject(415, 'bad_content_type', 'content-type must be application/json');

  return checkToken(req, token);
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function parseObject(text, allowEmpty) {
  if (allowEmpty && text.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    throw httpError(400, 'bad_json', 'request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, 'bad_json', 'request body must be a JSON object');
  }
  return parsed;
}

/**
 * Read a JSON object body. `readJsonBody(req, maxBytes, { allowEmpty })`; the
 * options object may also be passed as the second argument. With allowEmpty an
 * empty body resolves to {} (for endpoints that take no payload).
 */
function readJsonBody(req, maxBytesOrOptions, maybeOptions) {
  const options = (maxBytesOrOptions !== null && typeof maxBytesOrOptions === 'object' ? maxBytesOrOptions : maybeOptions) || {};
  const maxBytes = typeof maxBytesOrOptions === 'number' ? maxBytesOrOptions : DEFAULT_MAX_BODY_BYTES;
  const allowEmpty = options.allowEmpty === true;
  return new Promise((resolve, reject_) => {
    const declared = Number(req.headers && req.headers['content-length']);
    const chunks = [];
    let size = 0;
    let settled = false;

    const settle = fn => value => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const done = settle(resolve);
    const fail = settle(reject_);

    if (Number.isFinite(declared) && declared > maxBytes) {
      fail(httpError(413, 'too_large', 'request body too large'));
    }

    req.on('data', chunk => {
      if (settled) return; // keep draining, buffer nothing
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        chunks.length = 0;
        fail(httpError(413, 'too_large', 'request body too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        done(parseObject(Buffer.concat(chunks).toString('utf8'), allowEmpty));
      } catch (err) {
        fail(err);
      }
    });
    req.on('error', () => fail(httpError(400, 'bad_json', 'request stream failed')));
    req.on('aborted', () => fail(httpError(400, 'bad_json', 'request aborted')));
  });
}

module.exports = { createLaunchToken, checkWriteRequest, checkToken, readJsonBody };
