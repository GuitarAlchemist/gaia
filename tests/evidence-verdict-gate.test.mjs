/**
 * evidence-verdict-gate.test.mjs — no model verdict on evidence routes unpinned (#159).
 *
 * SCI-08 in docs/engineering-and-research-principles.md admits a model's `CONTRADICTED` or
 * `INSUFFICIENT` answer about an artifact only behind a deterministic existence check, admits a
 * model's report on an absent artifact as `UNKNOWN` or `INSUFFICIENT`, never as `CONTRADICTED`,
 * and sends a conflict between two strong records to a human. No seam pins that rule yet. Until
 * one does, these gates guard the vocabulary of the measured failure in every file under `src/`
 * and `scripts/`:
 *   - no word names a model evidence judge (Jev, Noul, or the hexavalent scale they classify in);
 *   - evidence vocabulary (contradict…, refut…, insufficien…) appears in code only at the
 *     deterministic sites listed here, word for word;
 *   - no list of review verdicts holds a verdict besides `APPROVE` and `REQUEST_CHANGES`: an
 *     array literal of uppercase quoted tokens, or a regex group of alternatives in any case.
 * A seam listed in PINNED_SEAMS is exempt from the first two gates once its own test pins SCI-08;
 * a list with no model behind it joins ALLOWED_REVIEW_LISTS, by its exact tokens, with its reason.
 *
 * The scan is lexical. Words are split into identifier segments, so `askJev` and `JEV_MODEL` are
 * found and `Bernoulli` is not; comments that open a line are not code. A model verdict under a
 * name none of these patterns knows passes: the gates catch the vocabulary of the measured
 * failure, not every way to bring it back.
 */

import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'tests/evidence-verdict-gate.test.mjs';
const DOCTRINE = 'docs/engineering-and-research-principles.md';
const CITATION = 'spareilleux/learn#18';

const CASES = '10 U + 10 C';
const RULE = [
  `SCI-08 (${DOCTRINE}): a model's CONTRADICTED or INSUFFICIENT answer about an artifact is`,
  'admissible only behind a deterministic existence check; a model\'s report on an absent artifact',
  'is admitted as UNKNOWN or INSUFFICIENT, never as CONTRADICTED; a conflict between two strong',
  'records goes to a human. The change that introduces a model evidence verdict adds a test',
  `pinning SCI-08 on the ${CASES} cases of ${CITATION}, adapted to Gaia receipts, and lists the`,
  'seam in PINNED_SEAMS.',
].join(' ');

/**
 * Each seam where a model classifies evidence, and the test that pins SCI-08 on it: a
 * `tests/*.test.mjs` file other than this one that imports the seam, declares a test, and names
 * SCI-08, the measurement and its cases.
 */
const PINNED_SEAMS = {};

/**
 * Review lists with no model behind them, per file: each list named by its exact tokens in order,
 * and why. An allowance covers that list only, not another list in the same file.
 */
const ALLOWED_REVIEW_LISTS = {};

/**
 * The evidence vocabulary each deterministic site uses in code, word for word, and why no model is
 * behind it. A word a site stops using leaves the list too, so the list stays the true inventory.
 */
const DETERMINISTIC_SITES = {
  // Refusal and history codes computed by rule: too few comparable runs, no authority, no
  // capability or quota.
  'src/ci-flow-optimization.mjs': ['INSUFFICIENT_HISTORY'],
  'src/ci-flow.mjs': ['INSUFFICIENT_HISTORY'],
  'src/lane-generation-bootstrap.mjs': ['CAPABILITY_INSUFFICIENT', 'QUOTA_INSUFFICIENT'],
  'src/merge-queue-capability.mjs': ['INSUFFICIENT_AUTHORITY'],
  'src/pr-review-thread.mjs': ['INSUFFICIENT_HISTORY'],
  // Projection text for codes like those, and for carried evidence that fails its own checks.
  'src/control-room.mjs': ['INSUFFICIENT_HISTORY', 'Insufficient', 'contradicts'],
  // Projection text for RECONCILE_REQUIRED, a drain state set by rule when recorded evidence and
  // the current observation disagree.
  'src/portfolio-drain-obstruction.mjs': ['contradicts'],
  // A gap kind a caller declares in a research proposal, validated and routed nowhere; and a
  // finding raised when an issue carries two exclusive status labels.
  'src/epistemic-research.mjs': ['contradiction'],
  'src/issue-consistency.mjs': ['contradictory'],
  // Two observations of one lane artifact disagree: a completion verified earlier in the
  // generation is no longer found, readable, or matching its digest. Refused, not judged.
  'src/local-lane-observation.mjs': ['COMPLETION_EVIDENCE_CONTRADICTED'],
  'src/local-lane-sensor.mjs': ['COMPLETION_EVIDENCE_CONTRADICTED'],
  // Two spans of one digest-bound plan artifact disagree, found by a deterministic rule; the
  // audit and its repair proposal are advisory.
  'src/plan-contradiction-audit.mjs': [
    'CONTRADICTION', 'CONTRADICTION_REPAIR_SCHEMA', 'NO_CONTRADICTION',
    'PLAN_CONTRADICTION_AUDIT_SCHEMA', 'PlanContradictionError', 'contradiction',
    'contradictionAudit', 'contradictionFor', 'contradictionId', 'contradictionRevision',
    'encodeContradictionRepair', 'encodePlanContradictionAudit', 'proposeContradictionRepair',
    'verifyContradictionRepair', 'verifyPlanContradictionAudit',
  ],
  'scripts/plan-contradiction-audit.mjs': [
    'contradiction', 'encodeContradictionRepair', 'encodePlanContradictionAudit',
    'proposeContradictionRepair',
  ],
};

const JUDGES = new Set(['jev', 'noul', 'hexavalent']);
const EVIDENCE = /^(?:contradict|refut|insufficien)/u;
const REVIEW_VERDICTS = new Set(['APPROVE', 'REQUEST_CHANGES']);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const words = (text) => text.match(/[A-Za-z0-9_]+/gu) ?? [];
/** `askJev` → ask, Jev; `JEV_MODEL` → JEV, MODEL; `V2_CONTRADICTED` → V, 2, CONTRADICTED. */
const segments = (word) => word.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/gu) ?? [];
const hasSegment = (word, match) => segments(word).some((part) => match(part.toLowerCase()));

/**
 * The text without comments that open a line: a `//` line, and a `/* … *\/` block opened at line
 * start, whose closing line keeps what follows `*\/`. A `.ps1` `#` comment counts as code.
 */
function code(text) {
  let block = false;
  return text.split('\n').map((line) => {
    let rest = line;
    for (;;) {
      if (block) {
        const end = rest.indexOf('*/');
        if (end === -1) return '';
        block = false;
        rest = rest.slice(end + 2);
      }
      const trimmed = rest.trimStart();
      if (trimmed.startsWith('/*')) {
        block = true;
        rest = trimmed.slice(2);
      } else {
        return trimmed.startsWith('//') ? '' : rest;
      }
    }
  }).join('\n');
}

/** Every file under `src/` and `scripts/` of `root`, decoded as UTF-8, in path order. */
function shippedSources(root = ROOT) {
  return ['src', 'scripts']
    .flatMap((dir) => readdirSync(join(root, dir), { recursive: true })
      .map((entry) => `${dir}/${entry.replaceAll('\\', '/')}`))
    .filter((path) => statSync(join(root, path)).isFile())
    .sort()
    .map((path) => {
      const bytes = readFileSync(join(root, path));
      let text;
      try {
        text = UTF8.decode(bytes);
      } catch {
        text = null;
      }
      // UTF-16 without a byte-order mark decodes as UTF-8 with a NUL between letters.
      if (text === null || text.includes('\0')) {
        assert.fail(`${path} is not UTF-8 text, so the evidence-verdict gates cannot read it`);
      }
      return { path, text };
    });
}

/**
 * Why each pin in `seams` does not hold. The pin must be a `tests/*.test.mjs` file other than this
 * gate, and it must import the seam, declare a test, and name SCI-08, the measurement and its
 * cases.
 */
function pinProblems(root, seams) {
  return Object.entries(seams).flatMap(([seam, testPath]) => {
    if (!/^tests\/[^/]+\.test\.mjs$/u.test(testPath) || testPath === SELF) {
      return [`${seam}: ${testPath} is not a test of its own`];
    }
    let text;
    try {
      text = readFileSync(join(root, testPath), 'utf8');
    } catch {
      return [`${seam}: ${testPath} does not exist`];
    }
    const imports = [`'../${seam}'`, `"../${seam}"`].some((specifier) => text.includes(specifier));
    const pins = imports && /^test\(/mu.test(text) && text.includes('SCI-08')
      && text.includes(CITATION) && text.includes(CASES);
    return pins ? [] : [`${seam}: ${testPath} does not pin SCI-08 on the ${CASES} cases of ${CITATION}`];
  });
}

/** `path: word` for every word that names a model evidence judge, comments included. */
const judgeMentions = (sources) => sources.flatMap(({ path, text }) => words(text)
  .filter((word) => hasSegment(word, (part) => JUDGES.has(part)))
  .map((word) => `${path}: ${word}`));

/** The evidence words each file uses in code, for the files that use any. */
function evidenceSites(sources) {
  const sites = {};
  for (const { path, text } of sources) {
    const found = [...new Set(words(code(text)))]
      .filter((word) => hasSegment(word, (part) => EVIDENCE.test(part)))
      .sort();
    if (found.length > 0) sites[path] = found;
  }
  return sites;
}

const isReviewVerdict = (token) => REVIEW_VERDICTS.has(token.toUpperCase());

/**
 * Every list in code that names a review verdict, in any case: an array literal, read as its
 * uppercase quoted tokens, or a regex group of alternatives, read whole once its named, lookaround
 * or non-capturing prefix and its word boundaries are set aside.
 */
function reviewLists(sources) {
  return sources.flatMap(({ path, text }) => {
    const program = code(text);
    const quoted = [...program.matchAll(/\[([^[\]]*)\]/gu)].map(([, body]) => (
      [...body.matchAll(/(['"`])([A-Z][A-Z0-9_]*)\1/gu)].map(([, , token]) => token)));
    const groups = [...program.matchAll(/\((?:\?(?:<[A-Za-z_$][\w$]*>|<=|<!|[:=!]))?([^()]*\|[^()]*)\)/gu)]
      .map(([, body]) => body.split('|').map((token) => token.replaceAll(/\\[bB]/gu, '')));
    return [...quoted, ...groups]
      .filter((tokens) => tokens.some(isReviewVerdict))
      .map((tokens) => ({ path, tokens }));
  });
}

const sameTokens = (left, right) => left.length === right.length
  && left.every((token, index) => token === right[index]);
const allowedList = (allowed, { path, tokens }) => (allowed[path] ?? [])
  .some((entry) => sameTokens(entry.tokens, tokens));

/** `path: verdict` for every verdict a review list holds besides the pair, unless allowed. */
const widenedReviewVerdicts = (lists, allowed = ALLOWED_REVIEW_LISTS) => lists
  .filter((list) => !allowedList(allowed, list))
  .flatMap(({ path, tokens }) => tokens
    .filter((token) => !isReviewVerdict(token))
    .map((token) => `${path}: ${token}`));

/** `path: tokens` for every allowance that names no list in its file any more. */
const staleAllowances = (lists, allowed = ALLOWED_REVIEW_LISTS) => Object.entries(allowed)
  .flatMap(([path, entries]) => entries
    .filter((entry) => !lists.some((list) => list.path === path && sameTokens(list.tokens, entry.tokens)))
    .map((entry) => `${path}: ${entry.tokens.join(' | ')}`));

/**
 * What the three gates find under `root`. The judge and evidence gates skip a seam whose pin holds;
 * the review gate reads every file, because pinning SCI-08 does not widen a review verdict.
 */
function gates(root = ROOT, seams = PINNED_SEAMS, allowed = ALLOWED_REVIEW_LISTS) {
  const sources = shippedSources(root);
  const pinned = Object.keys(seams)
    .filter((seam) => pinProblems(root, { [seam]: seams[seam] }).length === 0);
  const gated = sources.filter(({ path }) => !pinned.includes(path));
  const lists = reviewLists(sources);
  return {
    gatedPaths: gated.map(({ path }) => path),
    judges: judgeMentions(gated),
    evidence: evidenceSites(gated),
    lists,
    widened: widenedReviewVerdicts(lists, allowed),
    stale: staleAllowances(lists, allowed),
  };
}

test('no shipped source names a model evidence judge', () => {
  const { gatedPaths, judges } = gates();
  // The scan reaches both trees: one known file from each.
  for (const path of ['src/reporting-context.mjs', 'scripts/architecture-drift.mjs']) {
    assert.ok(gatedPaths.includes(path), `the scan reads ${path}`);
  }
  assert.deepEqual(judges, [], RULE);
});

test('evidence vocabulary in code stays at the deterministic sites that own it', () => {
  assert.deepEqual(gates().evidence, DETERMINISTIC_SITES,
    `${RULE} A deterministic site joins DETERMINISTIC_SITES with the rule that makes it one.`);
});

test('no review verdict list holds a verdict besides APPROVE and REQUEST_CHANGES', () => {
  const { lists, widened, stale } = gates();
  // The scan reads the lists it guards: two vocabularies and the three verdict parsers.
  const paths = new Set(lists.map(({ path }) => path));
  for (const path of [
    'src/reporting-context.mjs', 'src/lineage-receipt.mjs', 'src/factory-agent.mjs',
    'src/drain-petri-net-facts.mjs',
  ]) {
    assert.ok(paths.has(path), `the scan reads the review verdicts in ${path}`);
  }
  assert.deepEqual(widened, [],
    `${RULE} A list with no model behind it joins ALLOWED_REVIEW_LISTS with its reason.`);
  assert.deepEqual(stale, [], 'every allowance still names a list');
});

test('every pinned seam has a test that pins SCI-08 on the measurement', () => {
  assert.deepEqual(pinProblems(ROOT, PINNED_SEAMS), [], RULE);
});

test('NEGATIVE CONTROL: each gate fires on a planted violation, and only a real pin passes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-evidence-verdict-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));
  const plant = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const lines = (...text) => `${text.join('\n')}\n`;
  plant('src/clean.mjs', lines(
    "const VERDICTS = Object.freeze(['APPROVE', 'REQUEST_CHANGES']);",
    "const approved = ['APPROVE'].includes(verdict) && byVerdict['APPROVE'];",
    "const ROLES = [['reviewer-final', 'APPROVE']];",
    "const KEYS = ['FRESH', byVerdict['APPROVE']];",
    "const PAIR = [\n  'APPROVE', // the reviewer's pass\n  'REQUEST_CHANGES',\n];",
    'const LINE = /^VERDICT: (APPROVE|REQUEST_CHANGES)$/u;',
    'const NAMED = /^VERDICT: (?<verdict>APPROVE|REQUEST_CHANGES\\b)/u;',
    'const BARE = /^verdict: (?:approve|request_changes)$/iu;',
    "// const OLD = ['APPROVE', 'REQUEST_CHANGES', 'ABSTAIN'];",
    '// Bernoulli, Sarajevo and IRREFUTABLE name no judge, and this comment says evidence',
    '// contradicts itself without being code.',
    'const trial = bernoulliTrial(IRREFUTABLE);',
  ));
  plant('src/nested/deep/judge.mjs', lines(
    'const client = askJev(receipt); /* JEV_MODEL, hexavalent */',
    'const second = new JEVClient();',
    '// Noul could judge it too.',
  ));
  plant('scripts/scale.ps1', lines('$NOUL_SCALE = 6'));
  plant('src/evidence.mjs', lines(
    "if (answer === 'contradicted') route(isRefuted, V2_CONTRADICTED, 'Insufficient');",
  ));
  plant('src/review.mjs', lines(
    'const VERDICTS = new Set([\n  "APPROVE",\n  "REQUEST_CHANGES",\n  "DISPROVEN",\n]);',
    'const CODEX = /^VERDICT: (APPROVE|REQUEST_CHANGES|unverified)$/u;',
    'const SIDES = [`REQUEST_CHANGES`, `ABSTAIN`];',
    "/* verdicts */ const V = ['APPROVE', 'REQUEST_CHANGES', 'HOLD'];",
    "/* a block\n   that closes */ const W = ['REQUEST_CHANGES', 'DEFER'];",
    'const LOWER = /^verdict: (approve|request_changes|abstain)$/iu;',
    "const copied = LABELS[verdict === 'APPROVE' ? 'READY' : 'BLOCKED'];",
  ));
  plant('src/labels.mjs', lines(
    "const label = LABELS[verdict === 'APPROVE' ? 'READY' : 'BLOCKED'];",
    "const STATES = ['APPROVE', 'REQUEST_CHANGES', 'READY'];",
  ));
  plant('src/pinned.mjs', lines(
    'export const askJev = (receipt) => receipt;',
    "export const VERDICTS = ['APPROVE', 'REQUEST_CHANGES', 'CONTRADICTED'];",
  ));
  plant('src/unpinned.mjs', lines('export const askNoul = (receipt) => receipt;'));
  const pinLines = {
    imports: "import { askJev } from '../src/pinned.mjs';",
    names: `// Pins SCI-08 on the ${CASES} cases of ${CITATION}.`,
    declares: "test('a model reads absence as unknown', () => askJev({}));",
  };
  const pin = (name, overrides = {}) => {
    const path = `tests/${name}.test.mjs`;
    plant(path, lines(...Object.values({ ...pinLines, ...overrides }).filter((line) => line !== null)));
    return path;
  };
  const seams = { 'src/pinned.mjs': pin('pinned'), 'src/unpinned.mjs': pin('unpinned') };

  // A pin holds only as a test of its own that imports the seam and names the rule in full.
  const problem = (path, reason) => `src/pinned.mjs: ${path} ${reason}`;
  const unpinned = `does not pin SCI-08 on the ${CASES} cases of ${CITATION}`;
  for (const [path, reason] of [
    [pin('no-rule', { names: `// Pins the ${CASES} cases of ${CITATION}.` }), unpinned],
    [pin('no-citation', { names: `// Pins SCI-08 on the ${CASES} cases.` }), unpinned],
    [pin('no-cases', { names: `// Pins SCI-08 on ${CITATION}.` }), unpinned],
    [pin('no-test', { declares: null }), unpinned],
    [pin('commented-test', { declares: "// test('later', () => askJev({}));" }), unpinned],
    [pin('no-import', { imports: null }), unpinned],
    [DOCTRINE, 'is not a test of its own'],
    [SELF, 'is not a test of its own'],
    ['src/pinned.mjs', 'is not a test of its own'],
    ['tests/missing.test.mjs', 'does not exist'],
  ]) {
    assert.deepEqual(pinProblems(root, { 'src/pinned.mjs': path }), [problem(path, reason)]);
  }
  // A complete pin outside `tests/*.test.mjs` is still not a test of its own.
  plant('tests/helpers/pin.mjs', readFileSync(join(root, seams['src/pinned.mjs']), 'utf8'));
  assert.deepEqual(pinProblems(root, { 'src/pinned.mjs': 'tests/helpers/pin.mjs' }),
    [problem('tests/helpers/pin.mjs', 'is not a test of its own')]);
  assert.deepEqual(pinProblems(root, seams), [
    `src/unpinned.mjs: tests/unpinned.test.mjs ${unpinned}`,
  ]);

  const labels = ['APPROVE', 'READY', 'BLOCKED'];
  const allowed = { 'src/labels.mjs': [{ tokens: labels, why: 'presentation keys' }] };
  const found = gates(root, seams, allowed);
  assert.deepEqual(found.gatedPaths, [
    'scripts/scale.ps1', 'src/clean.mjs', 'src/evidence.mjs', 'src/labels.mjs',
    'src/nested/deep/judge.mjs', 'src/review.mjs', 'src/unpinned.mjs',
  ], 'the walk reaches nested files, and only the seam whose pin holds is exempt');
  assert.deepEqual(found.judges, [
    'scripts/scale.ps1: NOUL_SCALE', 'src/nested/deep/judge.mjs: askJev',
    'src/nested/deep/judge.mjs: JEV_MODEL', 'src/nested/deep/judge.mjs: hexavalent',
    'src/nested/deep/judge.mjs: JEVClient', 'src/nested/deep/judge.mjs: Noul',
    'src/unpinned.mjs: askNoul',
  ]);
  assert.deepEqual(found.evidence, {
    'src/evidence.mjs': ['Insufficient', 'V2_CONTRADICTED', 'contradicted', 'isRefuted'],
  });

  // The review gate reads the pinned seam too, and an allowance covers its own list only: not
  // another list in its file, and not the same list in another file.
  const widened = [
    'src/labels.mjs: READY', 'src/pinned.mjs: CONTRADICTED', 'src/review.mjs: DISPROVEN',
    'src/review.mjs: ABSTAIN', 'src/review.mjs: HOLD', 'src/review.mjs: DEFER',
    'src/review.mjs: READY', 'src/review.mjs: BLOCKED', 'src/review.mjs: unverified',
    'src/review.mjs: abstain',
  ];
  assert.deepEqual(found.widened, widened);
  assert.deepEqual(found.stale, []);
  assert.deepEqual(gates(root, seams, {}).widened,
    ['src/labels.mjs: READY', 'src/labels.mjs: BLOCKED', ...widened]);
  assert.deepEqual(gates(root, seams, {
    'src/labels.mjs': [{ tokens: ['APPROVE', 'READY'] }],
    'src/clean.mjs': [{ tokens: labels }],
  }).stale, ['src/labels.mjs: APPROVE | READY', 'src/clean.mjs: APPROVE | READY | BLOCKED']);
  assert.equal(found.lists.filter(({ path }) => path === 'src/clean.mjs').length, 9,
    'every clean list is read, a commented-out one is not, and none is widened');

  // A file that is not UTF-8 text fails by name rather than hiding a word.
  plant('src/bare.ps1', Buffer.from('$JEV = 1\n', 'utf16le'));
  assert.throws(() => shippedSources(root), /src\/bare\.ps1 is not UTF-8 text/u);
  rmSync(join(root, 'src/bare.ps1'));
  plant('src/wide.ps1', Buffer.from(`${String.fromCharCode(0xfeff)}$JEV = 1\n`, 'utf16le'));
  assert.throws(() => shippedSources(root), /src\/wide\.ps1 is not UTF-8 text/u);
  rmSync(join(root, 'src/wide.ps1'));
  plant('src/latin.ps1', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  assert.throws(() => shippedSources(root), /src\/latin\.ps1 is not UTF-8 text/u);

  // The failure message points at a rule the doctrine declares, and at the cases to pin.
  const doctrine = readFileSync(join(ROOT, DOCTRINE), 'utf8');
  assert.match(doctrine, /^### SCI-08 — /mu);
  assert.ok(doctrine.includes(CITATION), 'the doctrine cites the measurement');
  assert.match(RULE, /^SCI-08 /u);
  assert.match(RULE, /the 10 U \+ 10 C cases of spareilleux\/learn#18/u);
  assert.match(RULE, /lists the seam in PINNED_SEAMS\.$/u);
});
