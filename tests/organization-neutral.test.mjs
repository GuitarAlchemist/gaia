/**
 * organization-neutral.test.mjs — no core module names the organization it runs for (#183).
 *
 * Gaia has to stay usable by another organization (#49). These gates scan every file under `src/`,
 * comments included, for two kinds of identity literal:
 *   - the owning organization's name, in any case and anywhere, even inside a longer identifier;
 *   - a literal GitHub owner: `github.com/<owner>`, `github.com:<owner>` (SSH),
 *     `api.github.com/repos/<owner>` or `githubusercontent.com/<owner>`.
 * A URL whose owner is built from inputs (`github.com/${owner}/…`) is not a literal and is not
 * reported. A hit fails the gate unless the allowlist below names its file and the exact string
 * literal around it, with a written reason. docs/organization-neutral-core.md is the rule.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

// The organization this repository is published under. Tests are not scanned; everything below
// that needs the name builds it from this constant.
const OWNING_ORGANIZATION = 'GuitarAlchemist';

/** Fresh patterns per scan, so no caller can leave a shared `lastIndex` behind. */
const identityPatterns = () => [
  ['ORGANIZATION_NAME', new RegExp(OWNING_ORGANIZATION, 'giu')],
  // An owner segment starts with a letter or a digit, so `github.com/${owner}` never matches.
  ['GITHUB_OWNER', /\bapi\.github\.com\/repos\/[A-Za-z0-9][A-Za-z0-9-]*/giu],
  ['GITHUB_OWNER', /(?<!\bapi\.)\bgithub\.com[/:][A-Za-z0-9][A-Za-z0-9-]*/giu],
  ['GITHUB_OWNER', /\bgithubusercontent\.com\/[A-Za-z0-9][A-Za-z0-9-]*/giu],
];

// At most one entry, each with the reason it must stay verbatim. An entry no hit uses fails the
// gate, so a literal that moves out of the core takes its exception with it.
const ALLOWLIST = Object.freeze([
  Object.freeze({
    file: 'epistemic-research.mjs',
    literal: `https://github.com/${OWNING_ORGANIZATION}/Demerzel/schemas/contracts/epistemic-research-proposal-v0.1`,
    reason: 'A cross-repository contract identifier, not configuration. Demerzel\'s '
      + 'epistemic-research-proposal schema pins this exact URI as its `$id` and as the `const` of '
      + 'its `schema` property (GuitarAlchemist/Demerzel#994, still unmerged on 2026-10-01), so a '
      + 'caller-supplied value would only be rejected by the receiver. Changing it is a contract '
      + 'version change. Re-check this exception when that schema lands.',
  }),
]);

/** Every identity literal in one file's text, in reading order, with its 1-based line. */
function scanIdentityLiterals(file, text) {
  const hits = [];
  const patterns = identityPatterns();
  text.split(/\r?\n/u).forEach((source, index) => {
    for (const [kind, pattern] of patterns) {
      for (const match of source.matchAll(pattern)) {
        hits.push({ file, line: index + 1, kind, text: match[0], column: match.index, source });
      }
    }
  });
  return hits.sort((left, right) => left.line - right.line || left.column - right.column);
}

const QUOTES = new Set(["'", '"', '`']);

/**
 * The entry that excuses a hit: same file, and the hit lies wholly inside the entry's literal
 * written as a complete string literal (`'…'`, `"…"` or `` `…` ``), not inside a longer string.
 */
function allowedBy(hit, allowlist) {
  return allowlist.find((entry) => {
    if (entry.file !== hit.file) return false;
    const end = (at) => at + entry.literal.length;
    for (let at = hit.source.indexOf(entry.literal); at !== -1;
      at = hit.source.indexOf(entry.literal, at + 1)) {
      const quote = hit.source[at - 1];
      if (QUOTES.has(quote) && hit.source[end(at)] === quote
          && at <= hit.column && hit.column + hit.text.length <= end(at)) return true;
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

/** Every file under `src/`, at any depth, as a forward-slash path relative to it. */
function sourceFiles() {
  return readdirSync(SRC, { recursive: true })
    .map((name) => String(name).replaceAll('\\', '/'))
    .filter((name) => statSync(join(SRC, name)).isFile())
    .sort();
}

const summary = (hits) => hits.map(({ line, kind, text }) => [line, kind, text]);

test('the scanner reports the organization name and a literal GitHub owner in a synthetic module', () => {
  const name = OWNING_ORGANIZATION;
  const fixture = [
    `export const OWNER = '${name.toLowerCase()}';`,
    `const ${name.toUpperCase()}_APP_ID = 1; const is${name}Repo = true;`,
    `const ENCODED = 'github.com%2F${name}%2Fgaia';`,
    "const HOME = 'https://github.com/acme/widgets';",
    "const SSH = 'git@github.com:acme/widgets.git'; const ONE = `https://github.com/acme/${repo}`;",
    "const RAW = 'https://raw.githubusercontent.com/acme/widgets/main/x'; const API = 'https://api.github.com/repos/acme/widgets';",
    'const issue = `https://github.com/${owner}/${repo}/issues/${number}`;',
    "if (url.startsWith('https://github.com/')) return;",
    'const api = `https://api.github.com/repos/${repository}`;',
  ].join('\n');

  const hits = scanIdentityLiterals('synthetic.mjs', fixture);
  assert.deepEqual(summary(hits), [
    [1, 'ORGANIZATION_NAME', name.toLowerCase()],
    [2, 'ORGANIZATION_NAME', name.toUpperCase()],
    [2, 'ORGANIZATION_NAME', name],
    [3, 'ORGANIZATION_NAME', name],
    [4, 'GITHUB_OWNER', 'github.com/acme'],
    [5, 'GITHUB_OWNER', 'github.com:acme'],
    [5, 'GITHUB_OWNER', 'github.com/acme'],
    [6, 'GITHUB_OWNER', 'githubusercontent.com/acme'],
    [6, 'GITHUB_OWNER', 'api.github.com/repos/acme'],
  ],'any case of the name anywhere, and any literal owner, are reported; templated owners are not');
  assert.ok(allowlistViolations(hits, ALLOWLIST).includes(
    `UNEXPLAINED synthetic.mjs:1 ${name.toLowerCase()}`), 'the gate fails on the synthetic module');

  const entry = { file: 'core.mjs', literal: 'https://github.com/acme/widgets', reason: 'a reason' };
  const excused = (file, text) => scanIdentityLiterals(file, text).map((hit) => allowedBy(hit, [entry]) !== null);
  assert.deepEqual(excused('core.mjs', `const A = '${entry.literal}';`), [true]);
  assert.deepEqual(excused('other.mjs', `const A = '${entry.literal}';`), [false],
    'an exception covers its own file only');
  assert.deepEqual(excused('core.mjs', `const A = '${entry.literal}'; const B = '${name}';`), [true, false],
    'a second literal on the excused line is not excused');
  assert.deepEqual(excused('core.mjs', `const A = '${entry.literal}-v2';`), [false],
    'a longer string that merely contains the literal is not excused');
});

test('every src file is organization-neutral, with at most one reasoned exception', () => {
  const files = sourceFiles();
  assert.ok(files.length > 0, 'src/ holds files to scan');
  const read = (file) => readFileSync(join(SRC, file), 'utf8');
  const hits = files.flatMap((file) => scanIdentityLiterals(file, read(file)));

  assert.deepEqual(allowlistViolations(hits, ALLOWLIST), [],
    'an identity literal in src/ must become an input or carry the one allowlisted reason');

  // The scan reaches real modules: a literal planted in a copy of one is reported.
  const planted = scanIdentityLiterals(files[0], `${read(files[0])}\nconst X = 'https://github.com/acme/widgets';\n`);
  assert.ok(allowlistViolations(planted, []).some((violation) => violation.endsWith('github.com/acme')));
});

test('the allowlist refuses an unexplained hit, a second exception, a missing reason and a stale entry', () => {
  const hits = scanIdentityLiterals('core.mjs', "const HOME = 'https://github.com/acme/widgets';");
  const used = { file: 'core.mjs', literal: 'https://github.com/acme/widgets', reason: 'a reason' };

  assert.deepEqual(allowlistViolations(hits, []), ['UNEXPLAINED core.mjs:1 github.com/acme']);
  assert.deepEqual(allowlistViolations(hits, [used]), [], 'one used, reasoned exception is sound');
  assert.deepEqual(allowlistViolations(hits, [{ ...used, reason: '  ' }]), ['NO_REASON core.mjs']);
  assert.deepEqual(allowlistViolations(hits, [used, { ...used, file: 'gone.mjs' }]),
    ['TOO_MANY_EXCEPTIONS 2', 'STALE gone.mjs']);
  assert.deepEqual(allowlistViolations([], [used]), ['STALE core.mjs'],
    'an exception whose literal left the core goes with it');
  assert.deepEqual(allowlistViolations([], []), [], 'a core with no literal and no exception is sound');
});
