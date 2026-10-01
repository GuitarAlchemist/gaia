/**
 * evidence-verdict-gate.test.mjs — no model verdict routes on evidence existence yet (#159).
 *
 * SCI-08 in docs/engineering-and-research-principles.md admits a model's `CONTRADICTED` or
 * `INSUFFICIENT` answer only behind a deterministic existence check, maps absence to `UNKNOWN`,
 * and sends a conflict between two strong records to a human. No model classifies evidence in
 * Gaia yet, so the rule has no seam to pin. These gates keep it that way. They read every file
 * under `src/` and `scripts/` and fail when a change names a model evidence judge, gives a review
 * verdict a third value, or uses contradiction vocabulary outside the deterministic sites listed
 * here. Each failure names the test the change must add instead.
 *
 * The scan is lexical. A model verdict under a name none of these patterns knows passes it: the
 * gates catch the vocabulary of the measured failure, not every way to bring it back.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCTRINE = 'docs/engineering-and-research-principles.md';

const RULE = [
  `SCI-08 (${DOCTRINE}): a model verdict on evidence is admitted only behind a deterministic`,
  'existence check, absence maps to UNKNOWN, and a conflict between two strong records goes to a',
  'human. The change that introduces a model evidence verdict must add a test pinning SCI-08 on',
  'the 10 U + 10 C cases of spareilleux/learn#18, adapted to Gaia receipts.',
].join(' ');

/** The model evidence judges measured in spareilleux/learn#18, and the logic they classify in. */
const JUDGE = /\b(?:jev|noul|hexavalent)\b/gi;
/** Contradiction and refutation vocabulary, as a constant or a literal spells it. */
const CONTRADICTION = /\b[A-Z0-9_]*(?:CONTRADICT|REFUT)[A-Z0-9_]*\b/g;
/** An array literal that lists a review verdict. */
const REVIEW_VOCABULARY = /\[([^[\]]*['"](?:APPROVE|REQUEST_CHANGES)['"][^[\]]*)\]/g;
const REVIEW_VERDICTS = ['APPROVE', 'REQUEST_CHANGES'];

/**
 * Where contradiction vocabulary may appear, and why each site is deterministic. A site that
 * stops using a token leaves this list too, so the list stays the true inventory.
 */
const DETERMINISTIC_SITES = {
  // A completion marker verified earlier in the lane's generation no longer verifies with the
  // same digest. The lane is refused (`REFUSED_EVIDENCE`), not judged, and no model is asked.
  'src/local-lane-observation.mjs': ['COMPLETION_EVIDENCE_CONTRADICTED'],
  'src/local-lane-sensor.mjs': ['COMPLETION_EVIDENCE_CONTRADICTED'],
  // Structural conflicts between digest-bound plan declarations, found by rule and advisory only.
  'src/plan-contradiction-audit.mjs': [
    'CONTRADICTION', 'CONTRADICTION_REPAIR_SCHEMA', 'NO_CONTRADICTION',
    'PLAN_CONTRADICTION_AUDIT_SCHEMA',
  ],
};

const SCANNED = ['src', 'scripts'];

/** Every file under the scanned trees, as `{ path, text }` in path order. */
function shippedSources() {
  return SCANNED
    .flatMap((dir) => readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort()
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
}

/** `path: name` for every mention of a model evidence judge. */
const judgeMentions = (sources) => sources.flatMap(({ path, text }) => (
  [...text.matchAll(JUDGE)].map(([name]) => `${path}: ${name}`)));

/** The contradiction tokens each file uses, for the files that use any. */
function contradictionSites(sources) {
  const sites = {};
  for (const { path, text } of sources) {
    const tokens = [...new Set(text.match(CONTRADICTION) ?? [])].sort();
    if (tokens.length > 0) sites[path] = tokens;
  }
  return sites;
}

/** Each array literal that lists a review verdict, as the string literals it holds. */
const reviewVocabularies = (sources) => sources.flatMap(({ path, text }) => (
  [...text.matchAll(REVIEW_VOCABULARY)].map(([, body]) => ({
    path, values: [...body.matchAll(/['"]([^'"]*)['"]/g)].map(([, value]) => value),
  }))));

/** The review vocabularies that list anything but the binary review pair. */
const widenedReviewVocabularies = (vocabularies) => vocabularies.filter(({ values }) => (
  values.length !== REVIEW_VERDICTS.length || values.some((value, i) => value !== REVIEW_VERDICTS[i])));

test('no shipped source names a model evidence judge', () => {
  const sources = shippedSources();
  // The scan reaches both trees: one known file from each.
  const paths = sources.map(({ path }) => path);
  for (const path of ['src/reporting-context.mjs', 'scripts/architecture-drift.mjs']) {
    assert.ok(paths.includes(path), `the scan reads ${path}`);
  }
  assert.deepEqual(judgeMentions(sources), [], RULE);
});

test('contradiction vocabulary stays at the deterministic sites that own it', () => {
  assert.deepEqual(contradictionSites(shippedSources()), DETERMINISTIC_SITES,
    `${RULE} A deterministic site joins DETERMINISTIC_SITES with the check that makes it one.`);
});

test('every review verdict vocabulary is the binary review pair', () => {
  const vocabularies = reviewVocabularies(shippedSources());
  // The scan reads the vocabularies it guards: the reporting context and the lineage receipt
  // each declare one.
  const paths = new Set(vocabularies.map(({ path }) => path));
  for (const path of ['src/reporting-context.mjs', 'src/lineage-receipt.mjs']) {
    assert.ok(paths.has(path), `the scan reads the review vocabulary in ${path}`);
  }
  assert.deepEqual(widenedReviewVocabularies(vocabularies), [], RULE);
});

test('NEGATIVE CONTROL: each gate fires on a planted violation and names the rule', () => {
  const clean = {
    path: 'src/clean.mjs', text: "const VERDICTS = Object.freeze(['APPROVE', 'REQUEST_CHANGES']);\n",
  };
  assert.deepEqual(judgeMentions([clean]), []);
  assert.deepEqual(contradictionSites([clean]), {});
  assert.deepEqual(reviewVocabularies([clean]), [{ path: clean.path, values: REVIEW_VERDICTS }]);
  assert.deepEqual(widenedReviewVocabularies(reviewVocabularies([clean])), []);

  const planted = [
    { path: 'src/judge.mjs', text: '// Ask Jev to classify the receipt on the hexavalent scale.\n' },
    { path: 'scripts/judge.mjs', text: "import { noul } from './noul.mjs';\n" },
    { path: 'src/evidence.mjs', text: "if (answer === 'EVIDENCE_CONTRADICTED') route('REFUTED');\n" },
    {
      path: 'src/review.mjs',
      text: "const VERDICTS = new Set([\n  'APPROVE',\n  'REQUEST_CHANGES',\n  'INSUFFICIENT',\n]);\n",
    },
  ];
  assert.deepEqual(judgeMentions(planted), [
    'src/judge.mjs: Jev', 'src/judge.mjs: hexavalent',
    'scripts/judge.mjs: noul', 'scripts/judge.mjs: noul',
  ]);
  assert.deepEqual(contradictionSites(planted), {
    'src/evidence.mjs': ['EVIDENCE_CONTRADICTED', 'REFUTED'],
  });
  const widened = [{ path: 'src/review.mjs', values: [...REVIEW_VERDICTS, 'INSUFFICIENT'] }];
  assert.deepEqual(reviewVocabularies(planted), widened);
  assert.deepEqual(widenedReviewVocabularies(reviewVocabularies(planted)), widened);
  const reordered = [{ path: 'src/order.mjs', values: ['REQUEST_CHANGES', 'APPROVE'] }];
  assert.deepEqual(widenedReviewVocabularies(reordered), reordered);

  // The failure message points at a rule the doctrine declares, and at the cases to pin.
  const doctrine = readFileSync(join(ROOT, DOCTRINE), 'utf8');
  assert.match(doctrine, /^### SCI-08 — /m);
  assert.ok(doctrine.includes('spareilleux/learn#18'), 'the doctrine cites the measurement');
  assert.match(RULE, /^SCI-08 /);
  assert.match(RULE, /the 10 U \+ 10 C cases of spareilleux\/learn#18/);
});
