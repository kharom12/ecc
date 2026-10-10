/**
 * Tests for redactSecrets (scripts/lib/agent-live-events.js, implemented in
 * agent-live-redact.js) and for redactText's whole-text handling of PEM blocks.
 *
 * Run with: node tests/lib/agent-live-redact.test.js
 */

const assert = require('assert');
const { redact, redactSecrets } = require('../../scripts/lib/agent-live-events');
const { redactText } = require('../../scripts/lib/agent-live-runner-stream');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

const PEM_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV\nZZZZsecretbodyZZZZ==';
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`;
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

function runTests() {
  console.log('\n=== Testing agent-live redaction (M7) ===\n');
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => (test(name, fn) ? passed++ : failed++);
  const gone = (input, ...leaks) => {
    const out = redactSecrets(input);
    for (const leak of leaks) assert.ok(!out.includes(leak), `${JSON.stringify(leak)} survived in ${JSON.stringify(out)}`);
    assert.ok(out.includes('<REDACTED>'), `no marker in ${JSON.stringify(out)}`);
    return out;
  };

  console.log('assignments:');
  check('password with colon, equals, JSON and quoted forms', () => {
    gone('password: hunter2', 'hunter2');
    gone('PASSWORD = hunter2', 'hunter2');
    gone('{"password":"hunter2","user":"bob"}', 'hunter2');
    gone('{ "password" : "hunter2" }', 'hunter2');
    gone("password: 'hunter2'", 'hunter2');
    gone('db_password=hunter2 next', 'hunter2');
    assert.ok(gone('{"password":"hunter2","user":"bob"}', 'hunter2').includes('"user":"bob"'));
  });
  check('api_key / apikey / secret / token with = or : (also prefixed, JSON, camelCase)', () => {
    for (const input of ['api_key=abc123xyz', 'API-KEY: abc123xyz', 'apikey = abc123xyz', 'secret: abc123xyz', 'client_secret=abc123xyz',
      'token=abc123xyz', 'auth_token: abc123xyz', 'GITHUB_TOKEN=abc123xyz', '"api_key": "abc123xyz"', '"accessToken":"abc123xyz"', 'x-api-key: abc123xyz']) {
      gone(input, 'abc123xyz');
    }
  });
  check('AWS secret access key assignments (env, ini, JSON)', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    gone(`AWS_SECRET_ACCESS_KEY=${secret}`, secret);
    gone(`aws_secret_access_key = ${secret}`, secret);
    gone(`export AWS_SECRET_ACCESS_KEY="${secret}"`, secret);
    gone(`{"SecretAccessKey": "${secret}"}`, secret);
  });
  check('assignment redaction stops at the value: the rest of the line and later lines survive', () => {
    const out = gone('token=abc123xyz, retries=3\nnext line', 'abc123xyz');
    assert.ok(out.includes('retries=3') && out.endsWith('\nnext line'), out);
  });

  console.log('\nstandalone tokens:');
  check('Bearer tokens', () => {
    gone('curl -H "X: Bearer abcdef0123456789.xyz-abc" url', 'abcdef0123456789');
    gone('sent Bearer 9f8a7b6c5d4e3f2a1b0c', '9f8a7b6c5d4e');
  });
  check('Slack tokens xoxb/xoxa/xoxp/xoxr/xoxs', () => {
    for (const kind of ['b', 'a', 'p', 'r', 's']) gone(`slack xox${kind}-1234567890-abcdefghijkl here`, '1234567890-abcdefghijkl');
  });
  check('JWTs (three base64url segments starting eyJ), alone and inside text', () => {
    gone(JWT, 'eyJhbGci', 'SflKxwRJ');
    gone(`cookie=session; id=${JWT}; path=/`, 'SflKxwRJ');
  });
  check('multi-line PEM private key blocks are redacted whole, whatever the type', () => {
    for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
      const block = `-----BEGIN ${label}-----\n${PEM_BODY}\n-----END ${label}-----`;
      const out = gone(`before\n${block}\nafter`, 'MIIEvQ', 'secretbody', 'abcdefghijklmnop');
      assert.ok(out.startsWith('before\n') && out.endsWith('\nafter'), JSON.stringify(out));
      assert.ok(!out.includes('BEGIN') && !out.includes('END'), JSON.stringify(out));
    }
  });
  check('an unterminated PEM block (truncated output) is redacted to the end', () => {
    gone(`log\n-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}`, 'MIIEvQ', 'secretbody');
  });
  check('single-line (whitespace-collapsed) PEM via redact() is masked too', () => {
    const out = redact(PEM);
    assert.ok(!out.includes('MIIEvQ') && !out.includes('secretbody'), out);
  });
  check('existing patterns still work (sk-, ghp_, AKIA, --token, Authorization)', () => {
    gone('sk-abcdefgh12345678 ghp_abcdefghijklmnop0123 AKIAABCDEFGHIJKLMNOP', 'sk-abcdefgh', 'ghp_abc', 'AKIAABC');
    gone('--token abc123 Authorization: Bearer abc.def', 'abc123', 'abc.def');
  });

  console.log('\nfalse positives and formatting:');
  check('a sentence with no secrets is untouched', () => {
    const text = 'Updated the README and ran 12 tests in 3.4s.\nThe tokenizer splits input; max_tokens: 4096 is fine.\n  The secretary sent good news to the bearer of the message.';
    assert.strictEqual(redactSecrets(text), text);
  });
  check('code and prose that merely mention the words are kept', () => {
    for (const text of ['const tokens = lex(input);', 'function checkSecret(secretValue) {}', 'ssh-keygen creates a key pair', 'Unexpected token }', 'the token is stored in the keychain', 'use apiKeyHeader() to build requests']) {
      assert.strictEqual(redactSecrets(text), text);
    }
  });
  check('whitespace is preserved: newlines, indentation, tabs around redactions', () => {
    const input = 'def f():\n    token = "abc123xyz"\n\treturn 1\n\n  password: hunter2\nend';
    const out = redactSecrets(input);
    assert.ok(out.startsWith('def f():\n    token = ') && out.includes('\n\treturn 1\n\n  password: ') && out.endsWith('\nend'), JSON.stringify(out));
    assert.ok(!out.includes('abc123xyz') && !out.includes('hunter2'));
  });
  check('redaction is idempotent and tolerates empty or non-string input', () => {
    const once = redactSecrets('password: hunter2 token=abc123xyz');
    assert.strictEqual(redactSecrets(once), once);
    assert.strictEqual(redactSecrets(''), '');
    assert.strictEqual(redactSecrets(null), '');
    assert.strictEqual(redactSecrets(undefined), '');
  });
  check('long runs of word characters are handled in linear time (no regex blow-up)', () => {
    const started = Date.now();
    redactSecrets('x'.repeat(600000));
    redactSecrets('a_'.repeat(300000));
    redactSecrets(`-----BEGIN PRIVATE KEY-----${'x'.repeat(600000)}`);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
  });

  console.log('\nredactText (whole text, before any line handling):');
  check('a PEM block is masked as a whole before trimming and clipping', () => {
    const out = redactText(`\n\nkey follows\n${PEM}\ndone`, 1000);
    assert.ok(!out.includes('MIIEvQ') && !out.includes('secretbody') && out.endsWith('\ndone'), out);
  });
  check('clipping from the end cannot expose a PEM body (the block is masked first)', () => {
    const out = redactText(`${PEM}\nx`, 60, true);
    assert.ok(!out.includes('secretbody') && !out.includes('abcdefghijklmnop'), out);
  });
  check('a PEM block whose BEGIN line was cut off by a tail buffer is still masked up to its END line', () => {
    const cut = `${PEM_BODY.slice(20)}\n-----END PRIVATE KEY-----\nlater output`;
    const out = redactText(cut, 1000, true);
    assert.ok(!out.includes('abcdefghijklmnop') && !out.includes('secretbody'), out);
    assert.ok(out.endsWith('later output'), out);
  });
  check('a PEM block split across CRLF lines is masked', () => {
    const out = redactText(PEM.replace(/\n/g, '\r\n'), 1000);
    assert.ok(!out.includes('MIIEvQ') && !out.includes('secretbody'), out);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (require.main === module) {
  process.exit(runTests() ? 0 : 1);
}

module.exports = { runTests };
