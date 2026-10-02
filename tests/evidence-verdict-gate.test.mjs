/**
 * evidence-verdict-gate.test.mjs — no model verdict on evidence routes unpinned (#159).
 *
 * SCI-08 in docs/engineering-and-research-principles.md admits a model's `CONTRADICTED` or
 * `INSUFFICIENT` answer about an artifact only behind a deterministic existence check, has a model
 * read absence as `UNKNOWN` or `INSUFFICIENT`, never `CONTRADICTED`, and sends a conflict between
 * two strong records to a human. No seam pins that rule yet. Until one does, these gates guard the
 * vocabulary of the measured failure in every file under `src/` and `scripts/`:
 *   - no word names a model evidence judge (Jev, Noul, or the hexavalent scale they classify in);
 *   - evidence vocabulary (contradict…, refut…, insufficien…) appears in code only at the
 *     deterministic sites listed here, word for word;
 *   - no list of review verdicts, an array literal or a regex alternation, holds a verdict
 *     besides `APPROVE` and `REQUEST_CHANGES`.
 * A seam listed in PINNED_SEAMS is exempt once its own test cites the measurement.
 *
 * The scan is lexical. Words are split into identifier segments, so `askJev` and `JEV_MODEL` are
 * found and `Bernoulli` is not; whole-line comments are not code. A model verdict under a name
 * none of these patterns knows passes: the gates catch the vocabulary of the measured failure,
 * not every way to bring it back.
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
const DOCTRINE = 'docs/engineering-and-research-principles.md';
const CITATION = 'spareilleux/learn#18';

const RULE = [
  `SCI-08 (${DOCTRINE}): a model's CONTRADICTED or INSUFFICIENT answer about an artifact is`,
  'admissible only behind a deterministic existence check; a model reads absence as UNKNOWN or',
  'INSUFFICIENT, never CONTRADICTED; a conflict between two strong records goes to a human. The',
  'change that introduces a model evidence verdict adds a test pinning SCI-08 on the 10 U + 10 C',
  `cases of ${CITATION}, adapted to Gaia receipts, and lists the seam in PINNED_SEAMS.`,
].join(' ');

/** Each seam where a model classifies evidence, and the test that pins SCI-08 on it. */
const PINNED_SEAMS = {};

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

/** The text without whole-line comments: `//` lines and blocks opened at line start. */
function code(text) {
  const kept = [];
  let block = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (block) {
      block = !trimmed.includes('*/');
    } else if (trimmed.startsWith('/*')) {
      block = !trimmed.includes('*/', 2);
    } else if (!trimmed.startsWith('//')) {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

/** Every file under `src/` and `scripts/` of `root`, decoded as UTF-8, in path order. */
function shippedSources(root = ROOT) {
  return ['src', 'scripts']
    .flatMap((dir) => readdirSync(join(root, dir), { recursive: true })
      .map((entry) => `${dir}/${entry.replaceAll('\\', '/')}`))
    .filter((path) => statSync(join(root, path)).isFile())
    .sort()
    .map((path) => {
      try {
        return { path, text: UTF8.decode(readFileSync(join(root, path))) };
      } catch {
        return assert.fail(`${path} is not UTF-8, so the evidence-verdict gates cannot read it`);
      }
    });
}

/** Why each pin in `seams` does not hold: its test is missing or does not cite the measurement. */
function pinProblems(root, seams) {
  return Object.entries(seams).flatMap(([seam, testPath]) => {
    let text;
    try {
      text = readFileSync(join(root, testPath), 'utf8');
    } catch {
      return [`${seam}: ${testPath} does not exist`];
    }
    return text.includes(CITATION) && text.includes('SCI-08')
      ? [] : [`${seam}: ${testPath} does not pin SCI-08 on ${CITATION}`];
  });
}

/** The sources the gates judge: every file but a seam whose pin holds. */
function gatedSources(root = ROOT, seams = PINNED_SEAMS) {
  const pinned = Object.keys(seams)
    .filter((seam) => pinProblems(root, { [seam]: seams[seam] }).length === 0);
  return shippedSources(root).filter(({ path }) => !pinned.includes(path));
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

/** Every array literal or regex alternation in code that lists a review verdict. */
function reviewLists(sources) {
  return sources.flatMap(({ path, text }) => {
    const program = code(text);
    const quoted = [...program.matchAll(/\[([^[\]]*)\]/gu)].map(([, body]) => (
      [...body.matchAll(/(['"`])([A-Z][A-Z0-9_]*)\1/gu)].map(([, , token]) => token)));
    const alternations = [...program.matchAll(/\b[A-Z][A-Z0-9_]*(?:\|[A-Z][A-Z0-9_]*)+\b/gu)]
      .map(([alternation]) => alternation.split('|'));
    return [...quoted, ...alternations]
      .filter((tokens) => tokens.some((token) => REVIEW_VERDICTS.has(token)))
      .map((tokens) => ({ path, tokens }));
  });
}

/** `path: verdict` for every verdict a review list holds besides the binary pair. */
const widenedReviewVerdicts = (lists) => lists.flatMap(({ path, tokens }) => tokens
  .filter((token) => !REVIEW_VERDICTS.has(token))
  .map((token) => `${path}: ${token}`));

test('no shipped source names a model evidence judge', () => {
  const sources = gatedSources();
  // The scan reaches both trees: one known file from each.
  const paths = sources.map(({ path }) => path);
  for (const path of ['src/reporting-context.mjs', 'scripts/architecture-drift.mjs']) {
    assert.ok(paths.includes(path), `the scan reads ${path}`);
  }
  assert.deepEqual(judgeMentions(sources), [], RULE);
});

test('evidence vocabulary in code stays at the deterministic sites that own it', () => {
  assert.deepEqual(evidenceSites(gatedSources()), DETERMINISTIC_SITES,
    `${RULE} A deterministic site joins DETERMINISTIC_SITES with the rule that makes it one.`);
});

test('no review verdict list holds a verdict besides APPROVE and REQUEST_CHANGES', () => {
  const lists = reviewLists(gatedSources());
  // The scan reads the lists it guards: two vocabularies and the three verdict parsers.
  const paths = new Set(lists.map(({ path }) => path));
  for (const path of [
    'src/reporting-context.mjs', 'src/lineage-receipt.mjs', 'src/factory-agent.mjs',
    'src/drain-petri-net-facts.mjs',
  ]) {
    assert.ok(paths.has(path), `the scan reads the review verdicts in ${path}`);
  }
  assert.deepEqual(widenedReviewVerdicts(lists), [], RULE);
});

test('every pinned seam has a test that pins SCI-08 on the measurement', () => {
  assert.deepEqual(pinProblems(ROOT, PINNED_SEAMS), []);
});

test('NEGATIVE CONTROL: each gate fires on a planted violation, and a pinned seam passes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-evidence-verdict-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plant = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  plant('src/clean.mjs', [
    "const VERDICTS = Object.freeze(['APPROVE', 'REQUEST_CHANGES']);",
    "const approved = ['APPROVE'].includes(verdict) && byVerdict['APPROVE'];",
    "const ROLES = [['reviewer-final', 'APPROVE']];",
    "const PAIR = [\n  'APPROVE', // the reviewer's pass\n  'REQUEST_CHANGES',\n];",
    'const LINE = /^VERDICT: (APPROVE|REQUEST_CHANGES)$/u;',
    '// Bernoulli, Sarajevo and IRREFUTABLE name no judge, and this comment says evidence',
    '// contradicts itself without being code.',
    'const trial = bernoulliTrial(IRREFUTABLE);',
    '',
  ].join('\n'));
  plant('src/nested/deep/judge.mjs',
    'const client = askJev(receipt); /* JEV_MODEL, hexavalent */\n// Noul could judge it too.\n');
  plant('scripts/scale.ps1', '$NOUL_SCALE = 6\n');
  plant('src/evidence.mjs',
    "if (answer === 'contradicted') route(isRefuted, V2_CONTRADICTED, 'Insufficient');\n");
  plant('src/review.mjs', [
    'const VERDICTS = new Set([\n  "APPROVE",\n  "REQUEST_CHANGES",\n  "INSUFFICIENT",\n]);',
    'const LINE = /^VERDICT: (APPROVE|REQUEST_CHANGES|UNKNOWN)$/u;',
    'const SIDES = [`REQUEST_CHANGES`, `DISPROVEN`];',
    '',
  ].join('\n'));
  plant('src/pinned.mjs', 'export const askJev = (receipt) => receipt;\n');
  plant('tests/pinned.test.mjs', `// Pins SCI-08 on the 10 U + 10 C cases of ${CITATION}.\n`);
  plant('src/unpinned.mjs', 'export const askNoul = (receipt) => receipt;\n');
  plant('tests/unpinned.test.mjs', '// Says nothing about the measurement.\n');
  const seams = {
    'src/pinned.mjs': 'tests/pinned.test.mjs', 'src/unpinned.mjs': 'tests/unpinned.test.mjs',
  };

  const sources = gatedSources(root, seams);
  assert.deepEqual(sources.map(({ path }) => path), [
    'scripts/scale.ps1', 'src/clean.mjs', 'src/evidence.mjs', 'src/nested/deep/judge.mjs',
    'src/review.mjs', 'src/unpinned.mjs',
  ], 'the walk reaches nested files, and only the seam whose pin holds is exempt');
  assert.deepEqual(pinProblems(root, seams), [
    `src/unpinned.mjs: tests/unpinned.test.mjs does not pin SCI-08 on ${CITATION}`,
  ]);
  assert.deepEqual(pinProblems(root, { 'src/x.mjs': 'tests/missing.test.mjs' }), [
    'src/x.mjs: tests/missing.test.mjs does not exist',
  ]);

  assert.deepEqual(judgeMentions(sources), [
    'scripts/scale.ps1: NOUL_SCALE', 'src/nested/deep/judge.mjs: askJev',
    'src/nested/deep/judge.mjs: JEV_MODEL', 'src/nested/deep/judge.mjs: hexavalent',
    'src/nested/deep/judge.mjs: Noul', 'src/unpinned.mjs: askNoul',
  ]);
  assert.deepEqual(evidenceSites(sources), {
    'src/evidence.mjs': ['Insufficient', 'V2_CONTRADICTED', 'contradicted', 'isRefuted'],
    'src/review.mjs': ['INSUFFICIENT'],
  });
  assert.deepEqual(widenedReviewVerdicts(reviewLists(sources)), [
    'src/review.mjs: INSUFFICIENT', 'src/review.mjs: DISPROVEN', 'src/review.mjs: UNKNOWN',
  ]);
  assert.equal(reviewLists(sources).filter(({ path }) => path === 'src/clean.mjs').length, 6,
    'every clean list is read, and none is widened');

  // A file that is not UTF-8 fails by name rather than hiding a word.
  plant('src/wide.ps1', Buffer.from('﻿$JEV = 1\n', 'utf16le'));
  assert.throws(() => shippedSources(root), /src\/wide\.ps1 is not UTF-8/u);

  // The failure message points at a rule the doctrine declares, and at the cases to pin.
  const doctrine = readFileSync(join(ROOT, DOCTRINE), 'utf8');
  assert.match(doctrine, /^### SCI-08 — /mu);
  assert.ok(doctrine.includes(CITATION), 'the doctrine cites the measurement');
  assert.match(RULE, /^SCI-08 /u);
  assert.match(RULE, /the 10 U \+ 10 C cases of spareilleux\/learn#18/u);
});
