/**
 * resume-manifest.test.mjs — the resume-prompt check (W1, issue #104), driven from the three
 * resume defects the fleet actually recorded, not from its happy path.
 *
 *   Y1      the PR #92 R4 reviewer prompt named the R3 worktree (at 7da3004) as its subject while
 *           declaring the live head e98df9e, by an abbreviated commit. A reviewer following it
 *           would have labelled a verdict on 7da3004 as a verdict on e98df9e.
 *   Y2      the same prompt pinned origin/main at a94b5774, one merge before the live e697021.
 *   B16/B19 the PR #85 R1 repair prompt cited the R0 Standards review and excluded the R0 Spec
 *           review, which also returned REQUEST_CHANGES on the same head. One repair round and one
 *           dual-review round were lost.
 *
 * Fixture provenance. The prompts and review artifacts below are SHAPE-FAITHFUL RECONSTRUCTIONS,
 * not the verbatim fleet files, which live outside this repository. They keep what each defect
 * turns on — the binding lines, the commit identities, the citations, the verdict and marker
 * lines — and replace the prose. The commit identities are the real ones from this repository's
 * history. The worktree roots are neutral (`D:\lanes`, `D:\fleet`). Each world observation is the
 * one the record states: the R3 worktree at 7da3004, main at e697021, the PR #85 worktree clean at
 * its declared entry. Where the record does not state cleanliness it is set clean, so no refusal
 * below can come from dirt the record never saw.
 *
 * Each refusal has one gate and one mechanism revert: a one-expression mutant of the shipped
 * module, loaded from a scratch copy, that stops reporting it. A gate that survives its own
 * revert would be testing the fixture, not the rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MAX_RESUME_PROMPT_CHARS, RESUME_REFUSAL_CODES, RESUME_VERDICT_SCHEMA, ResumeManifestError,
  buildResumeManifest, checkResumePrompt, requireResumeManifest,
} from '../src/resume-manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'gaia-resume-manifest-'));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

// Real commit identities from this repository's history.
const PR85_R0_HEAD = '1df8d87705cecc4e9530f2433b9082efb3fc044a';
const PR85_R1_HEAD = 'e7d0fe25f2fbeecba0cbd775998695faf58b7405';
const PR85_BASE = 'c3fb5610514ecf34ab09a11d0866e8bd5875e217';
const PR92_R3_HEAD = '7da3004672f6e189566df3fa31683447dc1570bc';
const PR92_LIVE_HEAD = 'e98df9e15bc32b95f25ddb3b39ff08cfef541f33';
const MAIN_BEFORE_PR85 = 'a94b5774dd41f8865d17c2879d9adc5bc29f0cad';
const MAIN_AFTER_PR85 = 'e697021f76c1eeec9a72c65d4568a244e6441400';

const LANES = 'D:\\lanes';
const FLEET = 'D:\\fleet';
const PR92_R3_TREE = `${LANES}\\gaia-pr92-r3-review-7da3004`;
const PR92_R4_TREE = `${LANES}\\gaia-pr92-r4-review-e98df9e`;
const PR85_TREE = `${LANES}\\gaia-hosted-parallel-lanes-r0`;
const artifact = (name) => `${FLEET}\\${name}`;

// --- prompts -----------------------------------------------------------------------------------

const PR92_R4_AS_SPAWNED = [
  'You are the independent reviewer for Gaia PR #92 at its currently published head.',
  '',
  `Immutable subject: ${PR92_R3_TREE} (detached, verified clean at spawn)`,
  `Exact commit:      ${PR92_LIVE_HEAD.slice(0, 23)} (live head)`,
  `CI base / merge base: pin the literal SHA of origin/main, currently ${MAIN_BEFORE_PR85}`,
  `Result artifact: ${artifact('pr92-r4-review.md')}`,
  '',
  'Return exactly APPROVE or REQUEST_CHANGES.',
  '',
].join('\n');

const PR92_R4_CORRECTED = [
  'You are the independent reviewer for Gaia PR #92 at its currently published head.',
  '',
  `Immutable subject: ${PR92_R4_TREE} (detached, verified clean at spawn)`,
  `Exact commit: ${PR92_LIVE_HEAD} (live head)`,
  `CI base / merge base: pin the literal SHA of origin/main, currently ${MAIN_AFTER_PR85}`,
  `Result artifact: ${artifact('pr92-r4-review.md')}`,
  '',
  'Return exactly APPROVE or REQUEST_CHANGES.',
  '',
].join('\n');

const PR85_R1_REPAIR = [
  `You are the exclusive bounded repair writer for PR #85 in ${PR85_TREE}.`,
  `The R0 Standards review at ${artifact('pr85-r0-standards-review.md')} returned REQUEST_CHANGES`
    + ' on one blocking invariant. The Spec reviewer may report independently; do not wait for it.',
  `Work only in ${PR85_TREE} from the exact clean entry ${PR85_R0_HEAD}.`,
  `Write ${artifact('pr85-r1-repair-handoff.md')} and end with PR85_R1_REPAIR_COMPLETE.`,
  '',
].join('\n');

const PR85_R2_REPAIR = [
  'You are the exclusive bounded R2 repair writer for PR #85.',
  '',
  `Exclusive worktree: ${PR85_TREE}`,
  `Required clean entry HEAD: ${PR85_R1_HEAD}`,
  `Standards R1: ${artifact('pr85-r1-standards-review.md')} (APPROVE)`,
  `Spec R1: ${artifact('pr85-r1-spec-review.md')} (REQUEST_CHANGES, sole blocker S1)`,
  '',
  `Write ${artifact('pr85-r2-repair-handoff.md')} ending with PR85_R2_REPAIR_COMPLETE.`,
  '',
].join('\n');

// --- upstream artifacts --------------------------------------------------------------------------

const review = ({ title, subject, verdict, marker }) => [
  `# ${title}`, '', `- Subject reviewed: \`${subject}\``, `- Base: \`${PR85_BASE}\``, '',
  '## Verdict', '', `**${verdict}**`, '', 'Findings and reproducers are elided in this fixture.', '',
  verdict, '', marker, '',
].join('\n');

const UPSTREAM = {
  'pr85-r0-standards-review.md': review({ title: 'PR #85 — R0 Standards review',
    subject: PR85_R0_HEAD, verdict: 'REQUEST_CHANGES', marker: 'PR85_R0_STANDARDS_COMPLETE' }),
  'pr85-r0-spec-review.md': review({ title: 'PR #85 — R0 Spec review',
    subject: PR85_R0_HEAD, verdict: 'REQUEST_CHANGES', marker: 'PR85_R0_SPEC_COMPLETE' }),
  'pr85-r1-standards-review.md': review({ title: 'PR #85 — R1 Standards review',
    subject: PR85_R1_HEAD, verdict: 'APPROVE', marker: 'PR85_R1_STANDARDS_COMPLETE' }),
  'pr85-r1-spec-review.md': review({ title: 'PR #85 — R1 Spec review',
    subject: PR85_R1_HEAD, verdict: 'REQUEST_CHANGES', marker: 'PR85_R1_SPEC_COMPLETE' }),
  'pr85-r1-repair-handoff.md': [
    '# PR #85 — R1 bounded repair handoff', '',
    `- Entry (clean, immutable R0 subject): \`${PR85_R0_HEAD}\``,
    `- Repaired head: \`${PR85_R1_HEAD}\``, '', 'Commands and results are elided in this fixture.',
    '', 'PR85_R1_REPAIR_COMPLETE', '',
  ].join('\n'),
};

// --- declarations and recorded world observations ------------------------------------------------

const declare = ({ subject, commit, base = null, upstream = [] }) => buildResumeManifest({
  subjectPath: subject, declaredCommit: commit, baseRef: base === null ? null : 'origin/main',
  basePin: base, upstreamArtifacts: upstream.map(artifact),
});

const world = (manifest, { head, clean = true, main = null }) => ({
  subject: { path: manifest.subject.path, head, clean },
  base: manifest.base === null ? null : { ref: manifest.base.ref, head: main },
  upstream: manifest.upstream.map((path) => ({ path, text: UPSTREAM[path.split('\\').at(-1)] })),
});

function check(promptText, declaration, observed, module = { checkResumePrompt }) {
  const manifest = declare(declaration);
  return module.checkResumePrompt({ promptText, manifest, observation: world(manifest, observed) });
}

const codes = (report) => report.refusals.map((refusal) => refusal.code);

const refusal = (code, fn) => assert.throws(fn,
  (error) => error instanceof ResumeManifestError && error.code === code, `expected ${code}`);

/** Load a one-expression mutant of the shipped core, so a gate can be shown to be a mechanism. */
async function mutant(name, find, replace) {
  const source = readFileSync(join(ROOT, 'src', 'resume-manifest.mjs'), 'utf8');
  const mutated = source.replace(find, replace);
  assert.notEqual(mutated, source, `mutant ${name} changed nothing`);
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, mutated, 'utf8');
  return import(pathToFileURL(path).href);
}

// The five single-cause cases, one per refusal. Each is used by its gate and by its revert.
const CASES = {
  // Y1, isolated: the declaration is what the prompt says, and the named worktree is elsewhere.
  mismatch: [
    PR92_R4_AS_SPAWNED.replace(`${PR92_LIVE_HEAD.slice(0, 23)} (live head)`,
      `${PR92_LIVE_HEAD} (live head)`),
    { subject: PR92_R3_TREE, commit: PR92_LIVE_HEAD },
    { head: PR92_R3_HEAD },
  ],
  // Y2, isolated: the corrected subject, the stale pin, main resolved after #85 merged.
  stale: [
    PR92_R4_CORRECTED.replace(MAIN_AFTER_PR85, MAIN_BEFORE_PR85),
    { subject: PR92_R4_TREE, commit: PR92_LIVE_HEAD, base: MAIN_BEFORE_PR85 },
    { head: PR92_LIVE_HEAD, main: MAIN_AFTER_PR85 },
  ],
  // B16/B19: both R0 verdicts name the entry head; the prompt cites one of them.
  omitted: [
    PR85_R1_REPAIR,
    { subject: PR85_TREE, commit: PR85_R0_HEAD,
      upstream: ['pr85-r0-standards-review.md', 'pr85-r0-spec-review.md'] },
    { head: PR85_R0_HEAD },
  ],
  // The R2 prompt over a worktree that is no longer clean.
  dirty: [
    PR85_R2_REPAIR,
    { subject: PR85_TREE, commit: PR85_R1_HEAD,
      upstream: ['pr85-r1-standards-review.md', 'pr85-r1-spec-review.md'] },
    { head: PR85_R1_HEAD, clean: false },
  ],
  // Y1 from the other side: the operator declares the worktree it meant, the text still names R3.
  uncited: [
    PR92_R4_AS_SPAWNED,
    { subject: PR92_R4_TREE, commit: PR92_LIVE_HEAD },
    { head: PR92_LIVE_HEAD },
  ],
};

// -------------------------------------------------------------------------------------------------
// The observed defects, one refusal each
// -------------------------------------------------------------------------------------------------

test('Y1: a worktree at one commit declared as another is refused as a commit mismatch', () => {
  const report = check(...CASES.mismatch);
  assert.equal(report.verdict, 'RESUME_REFUSED');
  assert.deepEqual(report.refusals, [{ code: 'RESUME_SUBJECT_COMMIT_MISMATCH',
    declared: PR92_LIVE_HEAD, observed: PR92_R3_HEAD }]);
});

test('Y2: a base pin one merge behind the live base is refused as stale', () => {
  const report = check(...CASES.stale);
  assert.deepEqual(report.refusals, [{ code: 'RESUME_BASE_PIN_STALE', ref: 'origin/main',
    pinned: MAIN_BEFORE_PR85, resolved: MAIN_AFTER_PR85 }]);
});

test('B16/B19: a blocking verdict on the entry head that the prompt does not cite is refused', () => {
  const report = check(...CASES.omitted);
  assert.deepEqual(report.refusals, [{ code: 'RESUME_BLOCKING_INPUT_OMITTED',
    artifact: artifact('pr85-r0-spec-review.md'), verdict: 'REQUEST_CHANGES',
    marker: 'PR85_R0_SPEC_COMPLETE' }]);
  const standards = report.upstream.find((entry) => entry.path.endsWith('standards-review.md'));
  assert.equal(standards.blocking && standards.cited, true, 'the cited half was never the defect');
});

test('a declared subject worktree that is not clean is refused as dirty', () => {
  assert.deepEqual(codes(check(...CASES.dirty)), ['RESUME_SUBJECT_DIRTY']);
});

test('a declaration the prompt text does not carry is refused: the lane acts on the text', () => {
  const report = check(...CASES.uncited);
  assert.deepEqual(report.refusals, [
    { code: 'RESUME_BINDING_NOT_CITED', binding: 'SUBJECT_PATH' },
    { code: 'RESUME_BINDING_NOT_CITED', binding: 'SUBJECT_COMMIT' },
  ]);
  // The same text with a base declared must also carry the pin it is checked against.
  const withBase = check(PR92_R4_AS_SPAWNED,
    { subject: PR92_R4_TREE, commit: PR92_LIVE_HEAD, base: MAIN_AFTER_PR85 },
    { head: PR92_LIVE_HEAD, main: MAIN_AFTER_PR85 });
  assert.deepEqual(withBase.refusals.map((entry) => entry.binding),
    ['SUBJECT_PATH', 'SUBJECT_COMMIT', 'BASE_PIN']);
});

test('the PR #92 R4 prompt as spawned fails on every count the record names', () => {
  // Declared as written, with the full commit the operator meant: the check never expands an
  // abbreviation, so the abbreviated text does not carry it.
  const report = check(PR92_R4_AS_SPAWNED,
    { subject: PR92_R3_TREE, commit: PR92_LIVE_HEAD, base: MAIN_BEFORE_PR85 },
    { head: PR92_R3_HEAD, main: MAIN_AFTER_PR85 });
  assert.deepEqual(codes(report), ['RESUME_BINDING_NOT_CITED', 'RESUME_SUBJECT_COMMIT_MISMATCH',
    'RESUME_BASE_PIN_STALE']);
});

test('positive controls: the corrected PR #92 R4 prompt and the PR #85 R2 prompt agree', () => {
  const corrected = check(PR92_R4_CORRECTED,
    { subject: PR92_R4_TREE, commit: PR92_LIVE_HEAD, base: MAIN_AFTER_PR85 },
    { head: PR92_LIVE_HEAD, main: MAIN_AFTER_PR85 });
  assert.equal(corrected.verdict, 'RESUME_AGREED');
  assert.deepEqual(corrected.refusals, []);

  // The R2 prompt cited both R1 verdicts, and R2 closed the blocker R1 could not see.
  const r2 = check(PR85_R2_REPAIR,
    { subject: PR85_TREE, commit: PR85_R1_HEAD, upstream: ['pr85-r0-spec-review.md',
      'pr85-r0-standards-review.md', 'pr85-r1-standards-review.md', 'pr85-r1-spec-review.md'] },
    { head: PR85_R1_HEAD });
  assert.equal(r2.verdict, 'RESUME_AGREED');
  assert.deepEqual(r2.upstream.map(({ blocking, cited }) => [blocking, cited]),
    [[false, false], [false, false], [true, true], [true, true]],
    'R0 verdicts judged an earlier generation, so they do not block the R2 entry');
});

test('a completion marker blocks as a verdict does: the R2 prompt did not cite the R1 handoff', () => {
  const report = check(PR85_R2_REPAIR,
    { subject: PR85_TREE, commit: PR85_R1_HEAD, upstream: ['pr85-r1-repair-handoff.md',
      'pr85-r1-standards-review.md', 'pr85-r1-spec-review.md'] },
    { head: PR85_R1_HEAD });
  assert.deepEqual(report.refusals, [{ code: 'RESUME_BLOCKING_INPUT_OMITTED',
    artifact: artifact('pr85-r1-repair-handoff.md'), verdict: null,
    marker: 'PR85_R1_REPAIR_COMPLETE' }]);
});

// -------------------------------------------------------------------------------------------------
// Repetition is not integrity
// -------------------------------------------------------------------------------------------------

test('naming a bad subject twice cannot make it valid; naming a good one once is enough', () => {
  // The retired SubjectNamedTwice rule: path and commit must each appear at least twice.
  const namedTwice = (text, path, commit) => text.split(path).length > 2 && text.split(commit).length > 2;
  const [prompt, declaration, observed] = CASES.mismatch;
  const repeated = `${prompt}Binding: review ${PR92_R3_TREE} at ${PR92_LIVE_HEAD} and nothing else.\n`;
  assert.equal(namedTwice(repeated, PR92_R3_TREE, PR92_LIVE_HEAD), true,
    'the count-of-two heuristic admits the mislabelled subject');
  assert.deepEqual(codes(check(repeated, declaration, observed)), ['RESUME_SUBJECT_COMMIT_MISMATCH']);

  const [good, goodDeclaration] = [PR92_R4_CORRECTED,
    { subject: PR92_R4_TREE, commit: PR92_LIVE_HEAD, base: MAIN_AFTER_PR85 }];
  assert.equal(namedTwice(good, PR92_R4_TREE, PR92_LIVE_HEAD), false,
    'the heuristic refuses a correct prompt that names its subject once');
  assert.equal(check(good, goodDeclaration, { head: PR92_LIVE_HEAD, main: MAIN_AFTER_PR85 }).verdict,
    'RESUME_AGREED');
});

// -------------------------------------------------------------------------------------------------
// Mechanism reverts: each gate above stops holding when its rule is removed
// -------------------------------------------------------------------------------------------------

test('MECHANISM REVERT: without the generation comparison, Y1 agrees', async () => {
  const module = await mutant('mr-mismatch',
    'if (observation.subject.head !== manifest.subject.commit) {', 'if (false) {');
  assert.equal(check(...CASES.mismatch, module).verdict, 'RESUME_AGREED');
});

test('MECHANISM REVERT: without the live base comparison, Y2 agrees', async () => {
  const module = await mutant('mr-stale',
    'if (manifest.base !== null && observation.base.head !== manifest.base.pin) {', 'if (false) {');
  assert.equal(check(...CASES.stale, module).verdict, 'RESUME_AGREED');
});

test('MECHANISM REVERT: without blocking classification, B16/B19 agrees', async () => {
  const module = await mutant('mr-omitted',
    'blocking: namesCommit(text, manifest.subject.commit) && (verdict !== null || marker !== null),',
    'blocking: false,');
  assert.equal(check(...CASES.omitted, module).verdict, 'RESUME_AGREED');
});

test('MECHANISM REVERT: without the cleanliness rule, a dirty subject agrees', async () => {
  const module = await mutant('mr-dirty', 'if (!observation.subject.clean)', 'if (false)');
  assert.equal(check(...CASES.dirty, module).verdict, 'RESUME_AGREED');
});

test('MECHANISM REVERT: without the citation rule, a text naming another worktree agrees', async () => {
  const module = await mutant('mr-uncited',
    /if \(!citesPath\(promptText, manifest\.subject\.path\)\) \{[\s\S]*?if \(!citesCommit\(promptText, manifest\.subject\.commit\)\) \{/u,
    'if (false) {\n  }\n  if (false) {');
  assert.equal(check(...CASES.uncited, module).verdict, 'RESUME_AGREED');
});

// -------------------------------------------------------------------------------------------------
// Citation boundaries, input validation and the shape of the verdict
// -------------------------------------------------------------------------------------------------

test('a citation is a whole token: prefixes, longer names and abbreviations do not count', () => {
  const declaration = { subject: PR85_TREE, commit: PR85_R0_HEAD };
  const agree = (text) => check(text, declaration, { head: PR85_R0_HEAD }).verdict;
  assert.equal(agree(`Work in ${PR85_TREE}. Entry ${PR85_R0_HEAD}.`), 'RESUME_AGREED',
    'a sentence may end right after the path');
  assert.equal(agree(`Work in ${PR85_TREE.replaceAll('\\', '/').toUpperCase()} at ${PR85_R0_HEAD}`),
    'RESUME_AGREED', 'separators and case do not change a Windows path');
  assert.equal(agree(`Work in ${PR85_TREE}\\src at ${PR85_R0_HEAD}`), 'RESUME_AGREED',
    'a file inside the subject names the subject');
  assert.equal(agree(`Work in ${PR85_TREE}-old at ${PR85_R0_HEAD}`), 'RESUME_REFUSED',
    'a longer sibling name is a different worktree');
  assert.equal(agree(`Work in ${PR85_TREE} at ${PR85_R0_HEAD.slice(0, 12)}`), 'RESUME_REFUSED',
    'an abbreviation does not carry the full generation');
  assert.equal(agree(`Work in ${PR85_TREE} at ${PR85_R0_HEAD}ff`), 'RESUME_REFUSED',
    'a longer hex run is a different identifier');

  const cited = (text) => check(text, { ...declaration, upstream: ['pr85-r0-spec-review.md'] },
    { head: PR85_R0_HEAD }).upstream[0].cited;
  assert.equal(cited(`${PR85_TREE} ${PR85_R0_HEAD} read pr85-r0-spec-review.md.`), true);
  assert.equal(cited(`${PR85_TREE} ${PR85_R0_HEAD} read old-pr85-r0-spec-review.md`), false);
  assert.equal(cited(`${PR85_TREE} ${PR85_R0_HEAD} read pr85-r0-spec-review.md.bak`), false);
});

test('an upstream artifact blocks only if it names the entry generation and carries a verdict', () => {
  const declaration = { subject: PR85_TREE, commit: PR85_R0_HEAD, upstream: ['notes.md'] };
  const blocking = (text) => {
    UPSTREAM['notes.md'] = text;
    try {
      return check(PR85_R1_REPAIR, declaration, { head: PR85_R0_HEAD }).upstream[0].blocking;
    } finally {
      delete UPSTREAM['notes.md'];
    }
  };
  assert.equal(blocking(`Reviewed ${PR85_R0_HEAD.slice(0, 7)}.\n\n## Verdict: **APPROVE**\n`), true,
    'an abbreviation names the generation; a labelled, emphasised verdict still counts');
  assert.equal(blocking(`Reviewed ${PR85_R0_HEAD}. Return APPROVE or REQUEST_CHANGES.\n`), false,
    'a verdict word inside prose is not a verdict');
  assert.equal(blocking(`Reviewed ${PR85_R1_HEAD}.\n\nREQUEST_CHANGES\n`), false,
    'a verdict on another generation does not block this one');
  assert.equal(blocking(`Reviewed ${'0'.repeat(24)}${PR85_R0_HEAD}.\n\nAPPROVE\n`), false,
    'a digest that merely contains the commit does not name it');
  assert.equal(blocking(`Notes on ${PR85_R0_HEAD}.\n\nNOTES_COMPLETE_SOON\n`), false,
    'only a trailing <NAME>_COMPLETE line is a completion marker');
});

test('malformed input is a typed error, never a verdict', () => {
  const good = { subjectPath: PR85_TREE, declaredCommit: PR85_R0_HEAD };
  for (const bad of [
    { ...good, declaredCommit: PR85_R0_HEAD.slice(0, 23) },
    { ...good, declaredCommit: PR85_R0_HEAD.toUpperCase() },
    { ...good, subjectPath: 'lanes\\relative' },
    { ...good, subjectPath: `${PR85_TREE}\\..\\elsewhere` },
    { ...good, subjectPath: `${PR85_TREE}\\` },
    { ...good, baseRef: 'origin/main' },
    { ...good, baseRef: 'main', basePin: MAIN_AFTER_PR85 },
    { ...good, baseRef: 'origin/../main', basePin: MAIN_AFTER_PR85 },
    { ...good, baseRef: '-upload-pack/main', basePin: MAIN_AFTER_PR85 },
    { ...good, upstreamArtifacts: [artifact('a.md'), `${LANES}\\A.MD`] },
    { ...good, upstreamArtifacts: 'a.md' },
  ]) {
    refusal('RESUME_MANIFEST_INVALID', () => buildResumeManifest(bad));
  }

  const manifest = declare({ subject: PR85_TREE, commit: PR85_R0_HEAD });
  const observed = world(manifest, { head: PR85_R0_HEAD });
  refusal('RESUME_MANIFEST_INVALID', () => requireResumeManifest({ ...manifest, extra: 1 }));
  refusal('RESUME_MANIFEST_INVALID', () => requireResumeManifest(
    { ...manifest, schema: 'gaia-resume-manifest/2' }));
  for (const promptText of ['', 42, 'x'.repeat(MAX_RESUME_PROMPT_CHARS + 1)]) {
    refusal('RESUME_PROMPT_INVALID', () => checkResumePrompt({ promptText, manifest,
      observation: observed }));
  }
  for (const observation of [
    { ...observed, subject: { ...observed.subject, path: PR92_R4_TREE } },
    { ...observed, subject: { ...observed.subject, head: PR85_R0_HEAD.slice(0, 7) } },
    { ...observed, subject: { ...observed.subject, clean: 'yes' } },
    { ...observed, base: { ref: 'origin/main', head: MAIN_AFTER_PR85 } },
    { ...observed, upstream: [{ path: artifact('extra.md'), text: '' }] },
    { ...observed, extra: true },
  ]) {
    refusal('RESUME_OBSERVATION_INVALID', () => checkResumePrompt({
      promptText: PR85_R1_REPAIR, manifest, observation }));
  }
});

test('the verdict is frozen, authority-free, digest-bound and never carries the prompt text', () => {
  const report = check(...CASES.omitted);
  assert.equal(report.schema, RESUME_VERDICT_SCHEMA);
  assert.equal(report.authority, 'NONE');
  assert.equal(report.prompt.sha256,
    createHash('sha256').update(CASES.omitted[0], 'utf8').digest('hex'));
  assert.equal(report.prompt.chars, CASES.omitted[0].length);
  assert.ok(!JSON.stringify(report).includes('exclusive bounded repair writer'));
  assert.ok(Object.isFrozen(report) && Object.isFrozen(report.refusals)
    && Object.isFrozen(report.refusals[0]) && Object.isFrozen(report.upstream[0]));
  assert.deepEqual([...new Set(Object.values(CASES).flatMap((args) => codes(check(...args))))].sort(),
    [...RESUME_REFUSAL_CODES].sort(), 'every refusal in the vocabulary has a gate above');
});

test('the core is pure: it imports node:crypto and nothing else', () => {
  const source = readFileSync(join(ROOT, 'src', 'resume-manifest.mjs'), 'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';$/gmu)].map((match) => match[1]),
    ['node:crypto']);
});
