'use strict';

/**
 * Bounded stream helpers for the Agent Live runner: a line-buffered stream-json
 * parser, a stderr ring buffer and format-preserving redaction. No I/O.
 */

const { StringDecoder } = require('string_decoder');
const { redactSecrets } = require('./agent-live-events');
const { stripAnsi } = require('./utils');

const LINE_CAP = 512 * 1024;

/**
 * Feed raw chunks, get whole lines. Handles lines split across chunks and
 * multi-byte characters split across chunks. A single line longer than `cap`
 * is dropped (not buffered) so memory stays bounded.
 */
function createLineParser(onLine, cap = LINE_CAP) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let dropping = false;
  let droppedCount = 0;

  function feed(chunk) {
    let text = decoder.write(chunk);
    while (text.length > 0) {
      const newline = text.indexOf('\n');
      if (newline === -1) {
        if (!dropping) buffer += text;
        if (buffer.length > cap) { buffer = ''; dropping = true; droppedCount += 1; }
        return;
      }
      const line = buffer + text.slice(0, newline);
      text = text.slice(newline + 1);
      if (dropping) {
        // already counted when the cap was first exceeded
      } else if (line.length <= cap) {
        onLine(line);
      } else {
        droppedCount += 1;
      }
      buffer = '';
      dropping = false;
    }
  }

  function end() {
    const rest = buffer + decoder.end();
    buffer = '';
    if (!dropping && rest) onLine(rest);
    dropping = false;
  }

  return { feed, end, pending: () => buffer.length, dropped: () => droppedCount };
}

/** Keeps only the last `cap` characters pushed. */
function createTail(cap) {
  const decoder = new StringDecoder('utf8');
  let value = '';
  return {
    push(chunk) { value = (value + decoder.write(chunk)).slice(-cap); },
    value: () => value
  };
}

/**
 * Strip ANSI escapes and mask secrets while keeping newlines and indentation,
 * drop leading blank lines and trailing whitespace, then clip to `limit` chars
 * from the start or end.
 */
function redactText(text, limit, fromEnd = false) {
  const clean = redactSecrets(stripAnsi(String(text || '')).replace(/\r\n/g, '\n'))
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
  if (clean.length <= limit) return clean;
  return fromEnd ? clean.slice(-limit) : clean.slice(0, limit);
}

/** Extract the final result from a stream-json line, or null for any other line. */
function parseResultLine(line) {
  if (line.charCodeAt(0) !== 123 || !line.includes('"result"')) return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // non-JSON noise on stdout is expected and ignored
  }
  if (!parsed || parsed.type !== 'result') return null;
  return {
    result: typeof parsed.result === 'string' ? parsed.result : '',
    isError: parsed.is_error === true,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null
  };
}

module.exports = { LINE_CAP, createLineParser, createTail, parseResultLine, redactText };
