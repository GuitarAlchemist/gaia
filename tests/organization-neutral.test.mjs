/**
 * organization-neutral.test.mjs — no core module names the organization it runs for (#183).
 *
 * Gaia has to stay usable by another organization (#49). These gates scan every `src/*.mjs` for
 * two kinds of identity literal: the owning organization's name, in any case, and a literal
 * `github.com/<owner>/<repo>` URL. A URL built from variables (`github.com/${owner}/…`) is not a
 * literal and is not reported. A hit fails the gate unless the allowlist below names its file and
 * the exact literal around it, with a written reason. docs/organization-neutral-core.md is the rule.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

// The organization this repository is published under. Tests are not scanned, so this is the one
// place the name is spelled out.
const OWNING_ORGANIZATION = 'GuitarAlchemist';

const IDENTITY_PATTERNS = Object.freeze([
  ['ORGANIZATION_NAME', new RegExp(`\\b${OWNING_ORGANIZATION}\\b`, 'giu')],
  // An owner segment starts with a letter or a digit, so `github.com/${owner}` never matches.
  ['REPOSITORY_URL', /\bgithub\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+/giu],
]);

// At most one entry, each with the reason it must stay verbatim. An entry no hit uses fails the
// gate, so a literal that moves out of the core takes its exception with it.
const ALLOWLIST = Object.freeze([
  Object.freeze({
    file: 'epistemic-research.mjs',
    literal: 'https://github.com/GuitarAlchemist/Demerzel/schemas/contracts/epistemic-research-proposal-v0.1',
    reason: 'A published contract identifier, not configuration. Demerzel owns the '
      + 'epistemic-research-proposal schema and the receiver matches this URI verbatim; '
      + 'another organization changing it would emit a different contract, not the same one '
      + 'under its own name. Changing it is a contract version change.',
  }),
]);

/** Every identity literal in one module's text: one entry per match, with its 1-based line. */
function scanIdentityLiterals(file, text) {
  const hits = [];
  text.split(/\r?\n/u).forEach((source, index) => {
    for (const [kind, pattern] of IDENTITY_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        hits.push({ file, line: index + 1, kind, text: match[0], column: match.index, source });
      }
    }
  });
  return hits;
}

/** The allowlist entry whose literal, in the same file, contains the whole hit; otherwise null. */
function allowedBy(hit, allowlist = ALLOWLIST) {
  return allowlist.find((entry) => {
    if (entry.file !== hit.file) return false;
    for (let at = hit.source.indexOf(entry.literal); at !== -1;
      at = hit.source.indexOf(entry.literal, at + 1)) {
      if (at <= hit.column && hit.column + hit.text.length <= at + entry.literal.length) return true;
    }
    return false;
  }) ?? null;
}

/** What is wrong with an allowlist against the hits of a scan; empty when it is sound. */
function allowlistViolations(hits, allowlist) {
  const violations = hits.filter((hit) => allowedBy(hit, allowlist) === null)
    .map(({ file, line, text }) => `UNEXPLAINED ${file}:${line} ${text}`);
  if (allowlist.length > 1) violations.push(`TOO_MANY_EXCEPTIONS ${allowlist.length}`);
  for (const entry of allowlist) {
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      violations.push(`NO_REASON ${entry.file}`);
    }
    if (!hits.some((hit) => allowedBy(hit, allowlist) === entry)) violations.push(`STALE ${entry.file}`);
  }
  return violations;
}

const summary = (hits) => hits.map(({ line, kind, text }) => [line, kind, text]);

test('the scanner reports an organization literal and a literal repository URL in a synthetic module', () => {
  const fixture = [
    "export const OWNER = 'guitaralchemist';",
    "const HOME = 'https://github.com/acme/widgets';",
    'const issue = `https://github.com/${owner}/${repo}/issues/${number}`;',
    "if (url.startsWith('https://github.com/')) return;",
    'const api = `https://api.github.com/repos/${repository}`;',
  ].join('\n');

  assert.deepEqual(summary(scanIdentityLiterals('synthetic.mjs', fixture)), [
    [1, 'ORGANIZATION_NAME', 'guitaralchemist'],
    [2, 'REPOSITORY_URL', 'github.com/acme/widgets'],
  ], 'any case of the name and any literal owner/repo URL are reported; templates are not');

  const [entry] = ALLOWLIST;
  const elsewhere = scanIdentityLiterals('another-module.mjs', `const SCHEMA = '${entry.literal}';`);
  assert.equal(elsewhere.length, 2, 'the excused literal is still found in another file');
  assert.deepEqual(elsewhere.map((hit) => allowedBy(hit)), [null, null],
    'an exception covers its own file only');

  const beside = scanIdentityLiterals(entry.file,
    `const A = '${entry.literal}'; const B = 'GuitarAlchemist';`);
  assert.deepEqual(beside.filter((hit) => allowedBy(hit) === null).map((hit) => hit.text),
    ['GuitarAlchemist'], 'a second literal on the excused line is not excused');
});

test('every src module is organization-neutral, with at most one reasoned exception', () => {
  const modules = readdirSync(SRC).filter((name) => name.endsWith('.mjs')).sort();
  assert.ok(modules.length > 0, 'src/ holds modules to scan');
  const hits = modules.flatMap((name) => scanIdentityLiterals(name, readFileSync(join(SRC, name), 'utf8')));

  assert.deepEqual(allowlistViolations(hits, ALLOWLIST), [],
    'an identity literal in src/ must become an input or carry the one allowlisted reason');
  assert.ok(hits.length > 0 && hits.every((hit) => allowedBy(hit) === ALLOWLIST[0]),
    'the scan does reach the excused literal, so the exception is in use');
});

test('the allowlist refuses an unexplained hit, a second exception, a missing reason and a stale entry', () => {
  const hits = scanIdentityLiterals('core.mjs', "const HOME = 'https://github.com/acme/widgets';");
  const used = { file: 'core.mjs', literal: 'https://github.com/acme/widgets', reason: 'a reason' };

  assert.deepEqual(allowlistViolations(hits, []), ['UNEXPLAINED core.mjs:1 github.com/acme/widgets']);
  assert.deepEqual(allowlistViolations(hits, [used]), [], 'one used, reasoned exception is sound');
  assert.deepEqual(allowlistViolations(hits, [{ ...used, reason: '  ' }]), ['NO_REASON core.mjs']);
  assert.deepEqual(allowlistViolations(hits, [used, { ...used, file: 'gone.mjs' }]),
    ['TOO_MANY_EXCEPTIONS 2', 'STALE gone.mjs']);
  assert.deepEqual(allowlistViolations([], [used]), ['STALE core.mjs'],
    'an exception whose literal left the core goes with it');
});
