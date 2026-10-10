'use strict';

/**
 * Secret masking for Agent Live text (tool targets, run results, stderr).
 * Pure; whitespace is never touched, so multi-line output keeps its newlines
 * and indentation. Every pattern anchors on a literal or a word boundary so
 * long runs of ordinary characters cannot make it slow.
 */

const REDACTED = '<REDACTED>';
const KEY_TYPE = '[A-Z0-9 ]*PRIVATE KEY';

// Names whose value is a secret: password, api_key, apikey, secret, token, access_key (any prefix, no suffix).
const SECRET_NAME = '[A-Za-z0-9_-]*(?:password|passwd|api[_-]?key|secret|token|access[_-]?key)';
const ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9_-])(["']?)(${SECRET_NAME})\\1([ \\t]*[:=][ \\t]*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;&"'}\\]]+)`,
  'gi'
);

const PEM_BLOCK = new RegExp(`-----BEGIN ${KEY_TYPE}-----[\\s\\S]*?(?:-----END ${KEY_TYPE}-----|$)`, 'g');
// A tail buffer can cut the BEGIN line off: mask the leading base64 body up to the END line.
const PEM_TAIL = new RegExp(`^[A-Za-z0-9+/=\\s]*?-----END ${KEY_TYPE}-----`);
const BEARER = /\bBearer[ \t]+(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{12,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const SLACK = /\bxox[baprs]-[A-Za-z0-9-]{8,}/g;

function maskAssignment(_match, quote, name, separator, value) {
  const q = value[0] === '"' || value[0] === "'" ? value[0] : '';
  return `${quote}${name}${quote}${separator}${q}${REDACTED}${q}`;
}

/**
 * Mask secrets (private keys, JWTs, bearer/Slack/GitHub/AWS/OpenAI-style
 * tokens, key=value and "key": "value" credentials, auth headers) in free text.
 */
function redactSecrets(text) {
  return String(text || '')
    .replace(PEM_BLOCK, REDACTED)
    .replace(PEM_TAIL, REDACTED)
    .replace(/--token[= ][^\s]*/g, '--token=<REDACTED>')
    .replace(/Authorization:[: \t]*[^\s]*[: \t]*[^\s]*/gi, 'Authorization:<REDACTED>')
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(SLACK, REDACTED)
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/password[= ]+[^\s]*/gi, 'password=<REDACTED>')
    .replace(ASSIGNMENT, maskAssignment)
    .replace(/\b(ghp|gho|ghs)_[A-Za-z0-9_]+\b/g, REDACTED)
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

module.exports = { REDACTED, redactSecrets };
