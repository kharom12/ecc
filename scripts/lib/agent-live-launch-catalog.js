'use strict';

/**
 * Agent Live launch catalog: the allowlist of ECC workflow commands that the
 * dashboard may launch. Built from <root>/commands/*.md; a launch request can
 * only name an entry from this catalog, never an arbitrary path.
 */

const fs = require('fs');
const path = require('path');

const CATEGORY_RULES = Object.freeze([
  ['orch', /^orch-/],
  ['plan', /^plan/],
  ['review', /^(review|code-review)/],
  ['build', /^(build|fix)/],
  ['test', /^(test|tdd|e2e)/],
  ['security', /^security/],
  ['learn', /^(learn|evolve|instinct)/],
  ['gan', /^gan/],
  ['multi', /^multi/]
]);

function categoryFor(name) {
  const rule = CATEGORY_RULES.find(([, pattern]) => pattern.test(name));
  return rule ? rule[0] : 'other';
}

function stripQuotes(value) {
  const v = value.trim();
  const quoted = v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0];
  return quoted ? v.slice(1, -1) : v;
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields = {};
  if (!match) return fields;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = stripQuotes(kv[2]);
  }
  return fields;
}

const realpath = fs.realpathSync.native || fs.realpathSync;

/** True when `file` resolves (through symlinks) to a regular file inside the real commands directory. */
function staysInside(realDir, file) {
  try {
    const real = realpath(file);
    const rel = path.relative(realDir, real);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && fs.statSync(real).isFile();
  } catch (_err) {
    return false; // dangling link or unreadable: not launchable
  }
}

function loadLaunchCatalog(root) {
  const dir = path.join(root, 'commands');
  let entries;
  let realDir;
  try {
    realDir = realpath(dir);
    entries = fs.readdirSync(dir);
  } catch (_err) {
    return Object.freeze([]);
  }
  const items = entries
    .filter(file => file.endsWith('.md') && staysInside(realDir, path.join(dir, file)))
    .map(file => {
      const abs = path.join(dir, file);
      let text = '';
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch (_err) {
        return null;
      }
      const fm = parseFrontmatter(text);
      const name = file.slice(0, -'.md'.length);
      return Object.freeze({
        name,
        description: fm.description || '',
        category: categoryFor(name),
        argumentHint: fm['argument-hint'] || '',
        file: abs
      });
    })
    .filter(Boolean)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze(items);
}

function findLaunchable(catalog, name) {
  if (typeof name !== 'string' || !Array.isArray(catalog)) return null;
  return catalog.find(item => item.name === name) || null;
}

function buildPrompt(item, task) {
  return (
    `Follow the ECC workflow defined in ${item.file} for the task below. ` +
    'Run it end to end and honor its human gates: stop at each gate and report.\n\n' +
    `Task: ${task}`
  );
}

module.exports = { loadLaunchCatalog, findLaunchable, buildPrompt };
