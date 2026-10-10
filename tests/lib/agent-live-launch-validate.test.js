/**
 * Tests for scripts/lib/agent-live-launch-validate.js
 *
 * Run with: node tests/lib/agent-live-launch-validate.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PERMISSION_MODES,
  LIMITS,
  parseAllowedRoots,
  resolveCwd,
  validateRunRequest,
  validateFollowUp
} = require('../../scripts/lib/agent-live-launch-validate');

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

const CATALOG = Object.freeze([
  Object.freeze({ name: 'plan', file: '/repo/commands/plan.md' }),
  Object.freeze({ name: 'orch-add-feature', file: '/repo/commands/orch-add-feature.md' })
]);

function runTests() {
  console.log('\n=== Testing agent-live-launch-validate.js ===\n');
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => (test(name, fn) ? passed++ : failed++);

  // macOS os.tmpdir() lives under /var -> /private/var, so always realpath.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-validate-')));
  const projectDir = path.join(base, 'project');
  const otherDir = path.join(base, 'other');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(otherDir);
  const filePath = path.join(projectDir, 'a-file.txt');
  fs.writeFileSync(filePath, 'x');
  const linkToEtc = path.join(projectDir, 'link-to-etc');
  const linkInside = path.join(projectDir, 'link-inside');
  fs.symlinkSync('/etc', linkToEtc);
  fs.symlinkSync(projectDir, linkInside);
  const roots = Object.freeze([projectDir]);

  // A fake $HOME so folder-containment tests never touch the real home directory.
  const fakeHome = path.join(base, 'home');
  for (const sub of ['.ssh', '.claude', '.config', 'Library/LaunchAgents', 'proj/.hidden', 'proj/.git', 'proj/src', 'projects/app']) {
    fs.mkdirSync(path.join(fakeHome, sub), { recursive: true });
  }
  const homeOpts = Object.freeze({ home: fakeHome });
  const homeRoots = Object.freeze([fakeHome]);
  const GENERIC_CWD_ERROR = 'cwd is not an allowed project folder';

  try {
    console.log('constants:');
    check('PERMISSION_MODES and LIMITS are frozen with the contract values', () => {
      assert.deepStrictEqual([...PERMISSION_MODES], ['plan', 'acceptEdits']);
      assert.ok(Object.isFrozen(PERMISSION_MODES));
      assert.deepStrictEqual({ ...LIMITS }, { task: 8000, message: 4000, model: 64 });
      assert.ok(Object.isFrozen(LIMITS));
    });

    console.log('\nparseAllowedRoots:');
    check('defaults to the realpath of the home directory', () => {
      assert.deepStrictEqual(parseAllowedRoots({}), [fs.realpathSync(os.homedir())]);
    });

    check('parses colon-separated roots and realpaths them', () => {
      const out = parseAllowedRoots({ ECC_LIVE_ALLOWED_ROOTS: `${linkInside}:${otherDir}` });
      assert.deepStrictEqual(out, [projectDir, otherDir]);
    });

    check('drops missing, relative, empty and "/" roots (fails closed, no fallback)', () => {
      const env = { ECC_LIVE_ALLOWED_ROOTS: `/:relative/dir::${path.join(base, 'nope')}:${filePath}` };
      assert.deepStrictEqual(parseAllowedRoots(env), []);
    });

    check('a root that vanishes or cannot be stat-ed after realpath is skipped, never thrown', () => {
      const realStat = fs.statSync;
      fs.statSync = target => {
        if (String(target) === projectDir) throw Object.assign(new Error('ENOENT: raced away'), { code: 'ENOENT' });
        return realStat(target);
      };
      try {
        assert.deepStrictEqual(parseAllowedRoots({ ECC_LIVE_ALLOWED_ROOTS: `${projectDir}:${otherDir}` }), [otherDir]);
      } finally {
        fs.statSync = realStat;
      }
    });

    check('model names: LIMITS.model characters accepted, one more rejected', () => {
      const request = model => validateRunRequest({ command: 'plan', task: 't', cwd: projectDir, model }, { catalog: CATALOG, roots });
      assert.strictEqual(request('m'.repeat(LIMITS.model)).ok, true);
      assert.strictEqual(request('m'.repeat(LIMITS.model + 1)).ok, false);
    });

    console.log('\nresolveCwd:');
    check('accepts a directory inside an allowed root and returns the realpath', () => {
      assert.deepStrictEqual(resolveCwd(projectDir, roots), { ok: true, value: projectDir });
    });

    check('accepts a symlink inside the root pointing to another dir inside the root', () => {
      assert.deepStrictEqual(resolveCwd(linkInside, roots), { ok: true, value: projectDir });
    });

    check('accepts a tmp dir under ECC_LIVE_ALLOWED_ROOTS', () => {
      const sub = path.join(projectDir, 'nested');
      fs.mkdirSync(sub);
      const parsed = parseAllowedRoots({ ECC_LIVE_ALLOWED_ROOTS: base });
      assert.deepStrictEqual(resolveCwd(sub, parsed), { ok: true, value: sub });
    });

    check('rejects relative, empty, non-string and NUL-containing paths', () => {
      for (const bad of ['relative/dir', '.', '', null, undefined, 42, {}, `${projectDir}\0x`]) {
        const r = resolveCwd(bad, roots);
        assert.strictEqual(r.ok, false, JSON.stringify(bad));
        assert.strictEqual(r.code, 'bad_cwd');
        assert.strictEqual(typeof r.error, 'string');
      }
    });

    check('rejects a missing path and a file that is not a directory', () => {
      assert.strictEqual(resolveCwd(path.join(projectDir, 'missing'), roots).ok, false);
      assert.strictEqual(resolveCwd(filePath, roots).ok, false);
    });

    check('rejects a directory outside the allowed roots', () => {
      assert.strictEqual(resolveCwd(otherDir, roots).ok, false);
      assert.strictEqual(resolveCwd(base, roots).ok, false);
    });

    check('rejects "/", /etc, /System, /usr, /var, /private even if listed as roots', () => {
      const evilRoots = ['/', '/etc', '/System', '/usr', '/var', '/private'];
      for (const dir of ['/', '/etc', '/System', '/usr', '/var', '/private']) {
        assert.strictEqual(resolveCwd(dir, roots).ok, false, dir);
        assert.strictEqual(resolveCwd(dir, evilRoots).ok, false, `${dir} with evil roots`);
      }
    });

    check('rejects a path under /etc even if /etc is (mis)configured as a root', () => {
      assert.strictEqual(resolveCwd('/etc/ssh', ['/etc', '/private/etc']).ok, false);
    });

    check('rejects a symlink inside the root that points to /etc after realpath', () => {
      const r = resolveCwd(linkToEtc, roots);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'bad_cwd');
    });

    check('rejects $HOME/.. and ../ traversal out of the root', () => {
      const home = fs.realpathSync(os.homedir());
      assert.strictEqual(resolveCwd(path.join(os.homedir(), '..'), [home]).ok, false);
      assert.strictEqual(resolveCwd(path.join(projectDir, '..'), roots).ok, false);
      assert.strictEqual(resolveCwd(path.join(projectDir, '..', 'other'), roots).ok, false);
    });

    check('does not treat a sibling with a shared name prefix as inside the root', () => {
      const sibling = path.join(base, 'project-evil');
      fs.mkdirSync(sibling);
      assert.strictEqual(resolveCwd(sibling, roots).ok, false);
    });

    check('rejects everything when no roots are configured', () => {
      assert.strictEqual(resolveCwd(projectDir, []).ok, false);
    });

    console.log('\nresolveCwd folder containment (H2) and generic errors (L1):');
    check('rejects the home directory itself when home is the matched root', () => {
      const r = resolveCwd(fakeHome, homeRoots, homeOpts);
      assert.deepStrictEqual([r.ok, r.code, r.error], [false, 'bad_cwd', GENERIC_CWD_ERROR]);
    });

    check('rejects the home directory even when reached through a symlink or a different root', () => {
      const homeLink = path.join(base, 'home-link');
      fs.symlinkSync(fakeHome, homeLink);
      assert.strictEqual(resolveCwd(homeLink, homeRoots, homeOpts).ok, false);
      assert.strictEqual(resolveCwd(fakeHome, [base], homeOpts).ok, false);
    });

    check('rejects dot-directories under home: ~/.ssh, ~/.claude, ~/.config, ~/proj/.git, ~/proj/.hidden', () => {
      for (const sub of ['.ssh', '.claude', '.config', 'proj/.git', 'proj/.hidden']) {
        const r = resolveCwd(path.join(fakeHome, sub), homeRoots, homeOpts);
        assert.deepStrictEqual([r.ok, r.code, r.error], [false, 'bad_cwd', GENERIC_CWD_ERROR], sub);
      }
    });

    check('rejects anything beneath a hidden segment, via a symlink too', () => {
      const deep = path.join(fakeHome, '.ssh', 'keys');
      fs.mkdirSync(deep);
      assert.strictEqual(resolveCwd(deep, homeRoots, homeOpts).ok, false);
      const sneaky = path.join(fakeHome, 'projects', 'sneaky');
      fs.symlinkSync(path.join(fakeHome, '.ssh'), sneaky);
      assert.strictEqual(resolveCwd(sneaky, homeRoots, homeOpts).ok, false);
    });

    check('rejects ~/Library and everything under it', () => {
      for (const sub of ['Library', 'Library/LaunchAgents']) {
        assert.strictEqual(resolveCwd(path.join(fakeHome, sub), homeRoots, homeOpts).ok, false, sub);
      }
      // ...even when a more specific explicit root would otherwise contain it
      assert.strictEqual(resolveCwd(path.join(fakeHome, 'Library', 'LaunchAgents'), [path.join(fakeHome, 'Library')], homeOpts).ok, false);
    });

    check('Library check is case-insensitive on macOS', () => {
      if (process.platform !== 'darwin') return;
      const upper = path.join(fakeHome, 'LIBRARY', 'LaunchAgents');
      if (!fs.existsSync(upper)) return; // case-sensitive volume: nothing to alias
      assert.strictEqual(resolveCwd(upper, homeRoots, homeOpts).ok, false);
    });

    check('protected system trees and root containment are matched case-insensitively on macOS', () => {
      if (process.platform !== 'darwin' || !fs.existsSync('/ETC')) return; // case-sensitive volume: nothing to alias
      for (const dir of ['/ETC/ssh', '/Usr/bin', '/SYSTEM/Library']) {
        assert.strictEqual(resolveCwd(dir, [path.dirname(dir)], homeOpts).ok, false, dir);
      }
      assert.deepStrictEqual(resolveCwd(projectDir, [projectDir.toUpperCase()], homeOpts), { ok: true, value: projectDir });
    });

    check('accepts ordinary project folders under home: ~/projects/app, ~/proj, ~/proj/src', () => {
      for (const sub of ['projects/app', 'proj', 'proj/src']) {
        const dir = path.join(fakeHome, sub);
        assert.deepStrictEqual(resolveCwd(dir, homeRoots, homeOpts), { ok: true, value: dir }, sub);
      }
    });

    check('an explicitly configured non-home root may equal the cwd, even if it is a dot-folder', () => {
      assert.deepStrictEqual(resolveCwd(projectDir, roots, homeOpts), { ok: true, value: projectDir });
      const dotRoot = path.join(fakeHome, '.config');
      assert.deepStrictEqual(resolveCwd(dotRoot, [dotRoot], homeOpts), { ok: true, value: dotRoot });
    });

    check('parseAllowedRoots defaults to the injected home', () => {
      assert.deepStrictEqual(parseAllowedRoots({}, { home: fakeHome }), [fakeHome]);
    });

    check('validateRunRequest forwards the home option to the cwd gate', () => {
      const request = cwd => validateRunRequest({ command: 'plan', task: 't', cwd }, { catalog: CATALOG, roots: homeRoots, home: fakeHome });
      assert.strictEqual(request(path.join(fakeHome, 'projects', 'app')).ok, true);
      for (const dir of [fakeHome, path.join(fakeHome, '.ssh')]) assert.strictEqual(request(dir).code, 'bad_cwd');
    });

    check('every cwd failure returns the identical generic error so existence cannot be probed', () => {
      const cases = [
        'relative/dir', '', null, undefined, 42, `${projectDir}\0x`, // malformed
        path.join(projectDir, 'missing'), filePath, // missing / not a directory
        otherDir, base, // outside the roots
        '/etc', '/', linkToEtc, // protected
        path.join(projectDir, '..', 'definitely-not-there') // missing and outside
      ];
      const results = cases.map(c => resolveCwd(c, roots, homeOpts));
      for (const r of results) {
        assert.deepStrictEqual([r.ok, r.code, r.error], [false, 'bad_cwd', GENERIC_CWD_ERROR]);
      }
    });

    console.log('\nvalidateRunRequest:');
    const valid = () => ({ command: 'plan', task: 'Add login', cwd: projectDir });
    const run = body => validateRunRequest(body, { catalog: CATALOG, roots });

    check('accepts a minimal valid body and applies defaults', () => {
      const r = run(valid());
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.value.item, CATALOG[0]);
      assert.strictEqual(r.value.task, 'Add login');
      assert.strictEqual(r.value.cwd, projectDir);
      assert.strictEqual(r.value.permissionMode, 'plan');
      assert.strictEqual(r.value.model, null);
    });

    check('accepts acceptEdits and a valid model', () => {
      const r = run({ ...valid(), permissionMode: 'acceptEdits', model: 'claude-sonnet-4-5[1m]' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.value.permissionMode, 'acceptEdits');
      assert.strictEqual(r.value.model, 'claude-sonnet-4-5[1m]');
    });

    check('returns a frozen result and does not mutate the body', () => {
      const body = Object.freeze(valid());
      const r = run(body);
      assert.ok(Object.isFrozen(r) && Object.isFrozen(r.value));
      assert.deepStrictEqual(body, valid());
    });

    check('unknown command -> 404 unknown_command (including path-like names)', () => {
      for (const command of ['nope', '../plan', '/plan', 'plan ']) {
        const r = run({ ...valid(), command });
        assert.strictEqual(r.ok, false, command);
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.code, 'unknown_command');
      }
    });

    check('non-string or missing command -> 400', () => {
      for (const command of [undefined, null, 5, ['plan'], {}]) {
        const r = run({ ...valid(), command });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 400);
      }
    });

    check('rejects non-object bodies', () => {
      for (const body of [null, undefined, 'x', 42, [], true]) {
        const r = run(body);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 400);
      }
    });

    check('rejects empty, whitespace, non-string and oversize tasks', () => {
      for (const task of ['', '   \n\t', undefined, null, 7, { a: 1 }, 'x'.repeat(LIMITS.task + 1)]) {
        const r = run({ ...valid(), task });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 400);
      }
      assert.strictEqual(run({ ...valid(), task: 'x'.repeat(LIMITS.task) }).ok, true);
    });

    check('rejects NUL bytes in task, model, command and cwd', () => {
      assert.strictEqual(run({ ...valid(), task: 'a\0b' }).ok, false);
      assert.strictEqual(run({ ...valid(), model: 'a\0b' }).ok, false);
      assert.strictEqual(run({ ...valid(), command: 'plan\0' }).ok, false);
      assert.strictEqual(run({ ...valid(), cwd: `${projectDir}\0` }).ok, false);
    });

    check('rejects bypassPermissions, auto, dontAsk, Plan, default and junk permission modes', () => {
      for (const permissionMode of ['bypassPermissions', 'auto', 'dontAsk', 'Plan', 'default', '', 'plan ', null, 1, ['plan']]) {
        const r = run({ ...valid(), permissionMode });
        assert.strictEqual(r.ok, false, JSON.stringify(permissionMode));
        assert.strictEqual(r.status, 400);
      }
    });

    check('rejects bad models (flags, spaces, shell chars, too long, non-string)', () => {
      const bad = ['--help', '-x', 'a b', 'a;b', '$(id)', 'a/b', '', 'x'.repeat(LIMITS.model + 1), 5, {}];
      for (const model of bad) {
        const r = run({ ...valid(), model });
        assert.strictEqual(r.ok, false, JSON.stringify(model));
        assert.strictEqual(r.status, 400);
      }
      assert.strictEqual(run({ ...valid(), model: 'x'.repeat(LIMITS.model) }).ok, true);
    });

    check('maps cwd problems to 400 bad_cwd', () => {
      for (const cwd of [undefined, 'relative', '/etc', '/', linkToEtc, otherDir]) {
        const r = run({ ...valid(), cwd });
        assert.strictEqual(r.ok, false, String(cwd));
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.code, 'bad_cwd');
      }
    });

    console.log('\nvalidateFollowUp:');
    check('accepts a message with no permission override', () => {
      assert.deepStrictEqual(validateFollowUp({ message: 'continue' }), {
        ok: true,
        value: { message: 'continue', permissionMode: null }
      });
    });

    check('accepts plan and acceptEdits overrides (acceptEdits is not an escalation when the run already uses it)', () => {
      for (const permissionMode of PERMISSION_MODES) {
        const r = validateFollowUp({ message: 'go', permissionMode }, { currentMode: 'acceptEdits' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.value.permissionMode, permissionMode);
      }
    });

    check('plan -> acceptEdits needs confirmEscalation: true, else 400 escalation_unconfirmed (M6)', () => {
      const body = { message: 'go', permissionMode: 'acceptEdits' };
      for (const extra of [{}, { confirmEscalation: false }, { confirmEscalation: 'true' }, { confirmEscalation: 1 }, { confirmEscalation: null }]) {
        const r = validateFollowUp({ ...body, ...extra }, { currentMode: 'plan' });
        assert.deepStrictEqual([r.ok, r.status, r.code], [false, 400, 'escalation_unconfirmed'], JSON.stringify(extra));
      }
      const unknownMode = validateFollowUp(body); // fails closed when the caller cannot say what the run uses now
      assert.strictEqual(unknownMode.code, 'escalation_unconfirmed');
      const ok = validateFollowUp({ ...body, confirmEscalation: true }, { currentMode: 'plan' });
      assert.deepStrictEqual(ok, { ok: true, value: { message: 'go', permissionMode: 'acceptEdits' } });
    });

    check('confirmEscalation is not needed for plan, for no override, or when already in acceptEdits', () => {
      assert.strictEqual(validateFollowUp({ message: 'go', permissionMode: 'plan' }, { currentMode: 'plan' }).ok, true);
      assert.strictEqual(validateFollowUp({ message: 'go' }, { currentMode: 'plan' }).ok, true);
      assert.strictEqual(validateFollowUp({ message: 'go', permissionMode: 'acceptEdits' }, { currentMode: 'acceptEdits' }).ok, true);
    });

    check('rejects empty, oversize, NUL and non-string messages', () => {
      for (const message of ['', '  ', undefined, null, 3, 'a\0b', 'x'.repeat(LIMITS.message + 1)]) {
        const r = validateFollowUp({ message });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 400);
      }
      assert.strictEqual(validateFollowUp({ message: 'x'.repeat(LIMITS.message) }).ok, true);
    });

    check('rejects permission modes outside the allowlist and non-object bodies', () => {
      for (const permissionMode of ['bypassPermissions', 'auto', 'dontAsk', 'Plan', '', 5]) {
        assert.strictEqual(validateFollowUp({ message: 'x', permissionMode }).ok, false, String(permissionMode));
      }
      for (const body of [null, undefined, 'x', [], 1]) {
        assert.strictEqual(validateFollowUp(body).ok, false);
      }
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (require.main === module) {
  process.exit(runTests() ? 0 : 1);
}

module.exports = { runTests };
