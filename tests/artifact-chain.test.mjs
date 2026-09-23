import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ARTIFACT_CHAIN_REPORT_SCHEMA, ARTIFACT_CHAIN_SCHEMA, ARTIFACT_CHAIN_STAGES,
  ArtifactChainError, artifactChainDocumentDigest, buildArtifactChain,
  canonicalArtifactChainJson, evaluateArtifactChain, validateArtifactChain,
} from '../src/artifact-chain.mjs';
import {
  ARTIFACT_BYTE_LIMIT, ArtifactChainFileError, emitCandidateArtifactChain,
  measureArtifactChainFiles, persistArtifactChainManifest, readArtifactChainJson,
} from '../src/artifact-chain-files.mjs';

const REVISION = 'a'.repeat(40);
const OTHER_REVISION = 'b'.repeat(40);
const SUBJECT = 'github.com/Example/app#141';
const digestOf = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const FIXTURE = Object.freeze({
  intent: 'accepted intent text\n',
  candidate: 'candidate receipt text\n',
  tests: 'test evidence text\n',
  review: 'independent review text\n',
  publication: 'publication receipt text\n',
  notes: 'advisory notes text\n',
});

/** A five-stage descriptor, plus one advisory and one reference edge on the candidate. */
function descriptor(overrides = {}) {
  return {
    subject: SUBJECT,
    nodes: [
      { id: 'intent', stage: 'INTENT', rootRevision: null, producer: 'repository-operator',
        locator: 'INTENT.md', claim: { kind: 'ACCEPTED_INTENT', statement: 'scope accepted by the user' },
        dependencies: [] },
      { id: 'notes', stage: 'INTENT', rootRevision: null, producer: 'repository-operator',
        locator: 'notes.md', claim: null, dependencies: [] },
      { id: 'candidate', stage: 'CANDIDATE', rootRevision: REVISION, producer: 'gaia-agent-factory',
        locator: 'receipt.json', claim: { kind: 'CANDIDATE_READY', statement: 'worker produced a change set' },
        dependencies: [
          { nodeId: 'intent', relation: 'required', pinnedDigest: digestOf(FIXTURE.intent) },
          { nodeId: 'notes', relation: 'advisory', pinnedDigest: digestOf(FIXTURE.notes) },
        ] },
      { id: 'tests', stage: 'TEST_EVIDENCE', rootRevision: REVISION, producer: 'node--test',
        locator: 'evidence/tests.log', claim: { kind: 'TESTS_PASSED', statement: 'exit code zero' },
        dependencies: [
          { nodeId: 'candidate', relation: 'required', pinnedDigest: digestOf(FIXTURE.candidate) },
          { nodeId: 'notes', relation: 'reference', pinnedDigest: digestOf(FIXTURE.notes) },
        ] },
      { id: 'review', stage: 'INDEPENDENT_REVIEW', rootRevision: REVISION, producer: 'independent-reviewer',
        locator: 'evidence/review.md', claim: { kind: 'APPROVE', statement: 'no important findings' },
        dependencies: [{ nodeId: 'tests', relation: 'required', pinnedDigest: digestOf(FIXTURE.tests) }] },
      { id: 'publication', stage: 'PUBLICATION_EVIDENCE', rootRevision: REVISION, producer: 'gaia-publication-adapter',
        locator: 'evidence/publication.json', claim: { kind: 'DRAFT_PUBLISHED', statement: 'draft head updated' },
        dependencies: [{ nodeId: 'review', relation: 'required', pinnedDigest: digestOf(FIXTURE.review) }] },
    ],
    ...overrides,
  };
}

const MEASURED = Object.freeze({
  intent: digestOf(FIXTURE.intent),
  notes: digestOf(FIXTURE.notes),
  candidate: digestOf(FIXTURE.candidate),
  tests: digestOf(FIXTURE.tests),
  review: digestOf(FIXTURE.review),
  publication: digestOf(FIXTURE.publication),
});

const EXPECTATION = Object.freeze({ subject: SUBJECT, requiredRootRevisions: [REVISION] });

const chain = (input = descriptor(), measured = MEASURED) => buildArtifactChain({ descriptor: input, measured });
const freshnessOf = report => Object.fromEntries(report.nodes.map(node => [node.id, node.freshness]));
const refusal = (fn, code) => {
  assert.throws(fn, error => {
    assert.ok(error instanceof ArtifactChainError, `expected ArtifactChainError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
};

function tempRoot(name, contents = FIXTURE) {
  const root = mkdtempSync(join(tmpdir(), `gaia-artifact-chain-${name}-`));
  mkdirSync(join(root, 'evidence'));
  writeFileSync(join(root, 'INTENT.md'), contents.intent);
  writeFileSync(join(root, 'notes.md'), contents.notes);
  writeFileSync(join(root, 'receipt.json'), contents.candidate);
  writeFileSync(join(root, 'evidence/tests.log'), contents.tests);
  writeFileSync(join(root, 'evidence/review.md'), contents.review);
  writeFileSync(join(root, 'evidence/publication.json'), contents.publication);
  return root;
}

test('a valid five-stage chain is fresh, claims stay asserted, and nothing reads as verified', () => {
  const manifest = chain();
  assert.equal(manifest.schema, ARTIFACT_CHAIN_SCHEMA);
  assert.deepEqual(manifest.pendingStages, []);
  assert.deepEqual(manifest.nodes.map(node => node.id),
    ['intent', 'notes', 'candidate', 'tests', 'review', 'publication']);
  assert.equal(manifest.nodes.find(node => node.id === 'candidate').dependencies
    .find(dependency => dependency.nodeId === 'intent').pinnedDigest, MEASURED.intent);

  const report = evaluateArtifactChain({ manifest, observed: MEASURED, expectation: EXPECTATION });
  assert.equal(report.schema, ARTIFACT_CHAIN_REPORT_SCHEMA);
  assert.equal(report.verdict, 'CHAIN_FRESH');
  assert.deepEqual(freshnessOf(report), { intent: 'FRESH', notes: 'FRESH', candidate: 'FRESH',
    tests: 'FRESH', review: 'FRESH', publication: 'FRESH' });
  assert.deepEqual(report.stages.map(stage => stage.status), ARTIFACT_CHAIN_STAGES.map(() => 'PRESENT'));
  assert.equal(report.nodes.find(node => node.id === 'tests').claimStatus, 'ASSERTED_NOT_VERIFIED');
  assert.equal(report.nodes.find(node => node.id === 'notes').claimStatus, 'NO_CLAIM');
  // A fresh chain is a digest statement. No report field may read as verification of a claim.
  const text = canonicalArtifactChainJson(report);
  assert.equal(text.replaceAll('ASSERTED_NOT_VERIFIED', '').includes('VERIF'), false);
  assert.equal(/passed|PASSED/u.test(text.replaceAll('"claimStatus"', '')), false);
});

test('a missing later stage is reported not provided, never as a pass', () => {
  const input = descriptor();
  input.nodes = input.nodes.filter(node => ['intent', 'notes', 'candidate'].includes(node.id));
  const manifest = chain(input, { intent: MEASURED.intent, notes: MEASURED.notes, candidate: MEASURED.candidate });
  assert.deepEqual(manifest.pendingStages, ['TEST_EVIDENCE', 'INDEPENDENT_REVIEW', 'PUBLICATION_EVIDENCE']);

  const report = evaluateArtifactChain({ manifest,
    observed: { intent: MEASURED.intent, notes: MEASURED.notes, candidate: MEASURED.candidate },
    expectation: EXPECTATION });
  assert.equal(report.verdict, 'CHAIN_FRESH');
  assert.deepEqual(report.stages, [
    { stage: 'INTENT', status: 'PRESENT', nodeIds: ['intent', 'notes'] },
    { stage: 'CANDIDATE', status: 'PRESENT', nodeIds: ['candidate'] },
    { stage: 'TEST_EVIDENCE', status: 'NOT_PROVIDED', nodeIds: [] },
    { stage: 'INDEPENDENT_REVIEW', status: 'NOT_PROVIDED', nodeIds: [] },
    { stage: 'PUBLICATION_EVIDENCE', status: 'NOT_PROVIDED', nodeIds: [] },
  ]);
});

test('a changed required predecessor makes every dependent stale transitively', () => {
  const manifest = chain();
  const report = evaluateArtifactChain({ manifest,
    observed: { ...MEASURED, intent: digestOf('rewritten intent\n') }, expectation: EXPECTATION });
  assert.equal(report.verdict, 'CHAIN_STALE');
  assert.deepEqual(freshnessOf(report), {
    intent: 'CONTENT_CHANGED', notes: 'FRESH', candidate: 'STALE_REQUIRED_INPUT',
    tests: 'STALE_REQUIRED_INPUT', review: 'STALE_REQUIRED_INPUT', publication: 'STALE_REQUIRED_INPUT',
  });
});

test('building around newer predecessor bytes preserves the dependent producer pin and exposes staleness', () => {
  const newerIntent = digestOf('newer accepted intent\n');
  const manifest = chain(descriptor(), { ...MEASURED, intent: newerIntent });
  const candidatePin = manifest.nodes.find(node => node.id === 'candidate').dependencies
    .find(dependency => dependency.nodeId === 'intent').pinnedDigest;
  assert.equal(candidatePin, MEASURED.intent, 'creation must not rebind old dependent evidence');
  const report = evaluateArtifactChain({ manifest,
    observed: { ...MEASURED, intent: newerIntent }, expectation: EXPECTATION });
  assert.equal(freshnessOf(report).intent, 'FRESH');
  assert.equal(freshnessOf(report).candidate, 'PIN_MISMATCH');
  assert.equal(freshnessOf(report).tests, 'STALE_REQUIRED_INPUT');
});

test('a required pin that disagrees with the recorded predecessor digest is a pin mismatch', () => {
  const manifest = JSON.parse(canonicalArtifactChainJson(chain()));
  const candidate = manifest.nodes.find(node => node.id === 'candidate');
  candidate.dependencies.find(dependency => dependency.nodeId === 'intent').pinnedDigest = digestOf('older intent\n');
  const report = evaluateArtifactChain({ manifest: validateArtifactChain(manifest), observed: MEASURED,
    expectation: EXPECTATION });
  assert.equal(report.verdict, 'CHAIN_STALE');
  assert.equal(freshnessOf(report).candidate, 'PIN_MISMATCH');
  assert.equal(freshnessOf(report).tests, 'STALE_REQUIRED_INPUT');
});

test('advisory and reference changes never invalidate required freshness', () => {
  const manifest = chain();
  const report = evaluateArtifactChain({ manifest,
    observed: { ...MEASURED, notes: digestOf('rewritten notes\n') }, expectation: EXPECTATION });
  assert.equal(report.verdict, 'CHAIN_STALE', 'the changed advisory artifact itself is not fresh');
  assert.deepEqual(freshnessOf(report), {
    intent: 'FRESH', notes: 'CONTENT_CHANGED', candidate: 'FRESH', tests: 'FRESH',
    review: 'FRESH', publication: 'FRESH',
  });
  assert.deepEqual(report.nodes.find(node => node.id === 'candidate').changedAdvisoryInputs, ['notes']);
  assert.deepEqual(report.nodes.find(node => node.id === 'tests').changedAdvisoryInputs, ['notes']);
  assert.deepEqual(report.nodes.find(node => node.id === 'review').changedAdvisoryInputs, []);

  // The other way an advisory input can have moved: the artifact is fresh, but this node pinned a
  // different version of it. Still advisory, so still no effect on required freshness.
  const repinned = JSON.parse(canonicalArtifactChainJson(manifest));
  repinned.nodes.find(node => node.id === 'candidate').dependencies
    .find(dependency => dependency.nodeId === 'notes').pinnedDigest = digestOf('an older note\n');
  const second = evaluateArtifactChain({ manifest: validateArtifactChain(repinned), observed: MEASURED,
    expectation: EXPECTATION });
  assert.equal(second.verdict, 'CHAIN_FRESH');
  assert.deepEqual(freshnessOf(second).candidate, 'FRESH');
  assert.deepEqual(second.nodes.find(node => node.id === 'candidate').changedAdvisoryInputs, ['notes']);
  assert.deepEqual(second.nodes.find(node => node.id === 'tests').changedAdvisoryInputs, []);
});

test('the manifest cannot supply its own expectation: wrong subject and wrong revision refuse or stale', () => {
  const manifest = chain();
  refusal(() => evaluateArtifactChain({ manifest, observed: MEASURED,
    expectation: { subject: 'github.com/Example/app#999', requiredRootRevisions: [REVISION] } }), 'SubjectMismatch');
  refusal(() => evaluateArtifactChain({ manifest, observed: MEASURED,
    expectation: { subject: SUBJECT, requiredRootRevisions: [] } }), 'InvalidExpectation');
  refusal(() => evaluateArtifactChain({ manifest, observed: MEASURED,
    expectation: { subject: SUBJECT, requiredRootRevisions: ['not-a-revision'] } }), 'InvalidExpectation');

  // Each of these four nodes is bound to the superseded revision itself, so each reports its own
  // reason rather than inheriting one; the two revision-free intent artifacts stay fresh.
  const report = evaluateArtifactChain({ manifest, observed: MEASURED,
    expectation: { subject: SUBJECT, requiredRootRevisions: [OTHER_REVISION] } });
  assert.equal(report.verdict, 'CHAIN_STALE');
  assert.deepEqual(freshnessOf(report), {
    intent: 'FRESH', notes: 'FRESH', candidate: 'STALE_ROOT_REVISION',
    tests: 'STALE_ROOT_REVISION', review: 'STALE_ROOT_REVISION', publication: 'STALE_ROOT_REVISION',
  });

  // A node at an expected revision whose required predecessor is not is stale by inheritance.
  const mixed = evaluateArtifactChain({ manifest, observed: MEASURED,
    expectation: { subject: SUBJECT, requiredRootRevisions: [OTHER_REVISION, REVISION] } });
  assert.equal(mixed.verdict, 'CHAIN_FRESH');
  const partial = descriptor();
  partial.nodes.find(node => node.id === 'candidate').rootRevision = OTHER_REVISION;
  const inherited = evaluateArtifactChain({ manifest: chain(partial), observed: MEASURED,
    expectation: EXPECTATION });
  assert.deepEqual(freshnessOf(inherited), {
    intent: 'FRESH', notes: 'FRESH', candidate: 'STALE_ROOT_REVISION',
    tests: 'STALE_REQUIRED_INPUT', review: 'STALE_REQUIRED_INPUT', publication: 'STALE_REQUIRED_INPUT',
  });
});

test('observation must cover exactly the manifest nodes and fails closed otherwise', () => {
  const manifest = chain();
  const { publication, ...partial } = MEASURED;
  refusal(() => evaluateArtifactChain({ manifest, observed: partial, expectation: EXPECTATION }), 'InvalidObservation');
  refusal(() => evaluateArtifactChain({ manifest, observed: { ...MEASURED, stranger: MEASURED.intent },
    expectation: EXPECTATION }), 'InvalidObservation');
  refusal(() => evaluateArtifactChain({ manifest, observed: { ...MEASURED, publication: 'short' },
    expectation: EXPECTATION }), 'InvalidObservation');
  refusal(() => evaluateArtifactChain({ manifest, observed: null, expectation: EXPECTATION }), 'InvalidObservation');
});

test('a forged content digest is caught by observation, whatever the manifest says', () => {
  // A tamperer rewrites one artifact and re-pins every reference to the forged digest. The
  // manifest is now internally consistent; the measured bytes still refuse it.
  const forged = digestOf('forged candidate\n');
  const manifest = JSON.parse(canonicalArtifactChainJson(chain()));
  manifest.nodes.find(node => node.id === 'candidate').contentDigest = forged;
  manifest.nodes.find(node => node.id === 'tests').dependencies
    .find(dependency => dependency.nodeId === 'candidate').pinnedDigest = forged;
  const report = evaluateArtifactChain({ manifest: validateArtifactChain(manifest), observed: MEASURED,
    expectation: EXPECTATION });
  assert.equal(report.verdict, 'CHAIN_STALE');
  assert.equal(freshnessOf(report).candidate, 'CONTENT_CHANGED');
  assert.equal(freshnessOf(report).publication, 'STALE_REQUIRED_INPUT');
});

test('structural refusals: duplicates, unknown, cyclic, out-of-order, and skipped stages', () => {
  const duplicate = descriptor();
  duplicate.nodes.push({ ...duplicate.nodes[0] });
  refusal(() => chain(duplicate, MEASURED), 'DuplicateNodeId');

  const duplicateEdge = descriptor();
  duplicateEdge.nodes.find(node => node.id === 'candidate').dependencies
    .push({ nodeId: 'intent', relation: 'reference', pinnedDigest: MEASURED.intent });
  refusal(() => chain(duplicateEdge, MEASURED), 'DuplicateDependency');

  const unknown = descriptor();
  unknown.nodes.find(node => node.id === 'candidate').dependencies
    .push({ nodeId: 'ghost', relation: 'advisory', pinnedDigest: MEASURED.intent });
  refusal(() => chain(unknown, MEASURED), 'UnknownDependency');

  const self = descriptor();
  self.nodes.find(node => node.id === 'candidate').dependencies
    .push({ nodeId: 'candidate', relation: 'advisory', pinnedDigest: MEASURED.candidate });
  refusal(() => chain(self, MEASURED), 'InvalidDependencyOrder');

  const cyclic = descriptor();
  cyclic.nodes.find(node => node.id === 'intent').dependencies
    .push({ nodeId: 'candidate', relation: 'required', pinnedDigest: MEASURED.candidate });
  refusal(() => chain(cyclic, MEASURED), 'UnexpectedDependency');

  const backwards = descriptor();
  backwards.nodes.find(node => node.id === 'candidate').dependencies
    .push({ nodeId: 'tests', relation: 'advisory', pinnedDigest: MEASURED.tests });
  refusal(() => chain(backwards, MEASURED), 'InvalidDependencyOrder');

  const sameStage = descriptor();
  sameStage.nodes.find(node => node.id === 'candidate').dependencies
    .push({ nodeId: 'candidate', relation: 'required', pinnedDigest: MEASURED.candidate });
  refusal(() => chain(sameStage, MEASURED), 'InvalidDependencyOrder');

  // A publication node cannot exist without the review stage it claims to follow.
  const skipped = descriptor();
  skipped.nodes = skipped.nodes.filter(node => node.id !== 'review');
  skipped.nodes.find(node => node.id === 'publication').dependencies = [
    { nodeId: 'tests', relation: 'required', pinnedDigest: MEASURED.tests },
  ];
  const { review, ...withoutReview } = MEASURED;
  refusal(() => chain(skipped, withoutReview), 'MissingPredecessorStage');

  const advisoryOnly = descriptor();
  advisoryOnly.nodes.find(node => node.id === 'candidate').dependencies = [
    { nodeId: 'intent', relation: 'advisory', pinnedDigest: MEASURED.intent },
  ];
  refusal(() => chain(advisoryOnly, MEASURED), 'MissingPredecessorStage');
});

test('malformed descriptors, measurements, and manifests are refused rather than repaired', () => {
  refusal(() => chain({ subject: SUBJECT }, MEASURED), 'InvalidDescriptor');
  refusal(() => chain({ ...descriptor(), extra: 1 }, MEASURED), 'InvalidDescriptor');
  refusal(() => chain({ ...descriptor(), subject: ' leading space' }, MEASURED), 'InvalidDescriptor');
  refusal(() => chain({ ...descriptor(), nodes: [] }, {}), 'InvalidDescriptor');
  const missingPin = descriptor();
  delete missingPin.nodes.find(node => node.id === 'candidate').dependencies[0].pinnedDigest;
  refusal(() => chain(missingPin), 'InvalidDescriptor');
  refusal(() => buildArtifactChain({ descriptor: descriptor() }), 'InvalidMeasurement');
  const { intent, ...missing } = MEASURED;
  refusal(() => chain(descriptor(), missing), 'InvalidMeasurement');
  refusal(() => chain(descriptor(), { ...MEASURED, extra: MEASURED.intent }), 'InvalidMeasurement');
  refusal(() => chain(descriptor(), { ...MEASURED, intent: 'NOTADIGEST' }), 'InvalidMeasurement');

  const hostile = descriptor();
  Object.defineProperty(hostile.nodes[0], 'producer', { get: () => 'sneaky', enumerable: true });
  refusal(() => chain(hostile, MEASURED), 'InvalidDescriptor');

  const stage = descriptor();
  stage.nodes[0].stage = 'MYSTERY';
  refusal(() => chain(stage, MEASURED), 'InvalidDescriptor');

  const locator = descriptor();
  locator.nodes[0].locator = '../outside.md';
  refusal(() => chain(locator, MEASURED), 'InvalidDescriptor');
  for (const value of ['/absolute.md', 'C:/absolute.md', 'a\\b.md', '', './a.md', 'a/./b.md', 'a//b.md']) {
    const variant = descriptor();
    variant.nodes[0].locator = value;
    refusal(() => chain(variant, MEASURED), 'InvalidDescriptor');
  }

  const manifest = JSON.parse(canonicalArtifactChainJson(chain()));
  refusal(() => validateArtifactChain({ ...manifest, schema: 'gaia-artifact-chain/2' }), 'InvalidManifest');
  refusal(() => validateArtifactChain({ ...manifest, pendingStages: ['TEST_EVIDENCE'] }), 'InvalidManifest');
  refusal(() => validateArtifactChain({ ...manifest, nodes: [...manifest.nodes].reverse() }), 'InvalidManifest');
  refusal(() => validateArtifactChain({ ...manifest, extra: true }), 'InvalidManifest');
  refusal(() => validateArtifactChain('{}'), 'InvalidManifest');
  const unpinned = JSON.parse(canonicalArtifactChainJson(manifest));
  delete unpinned.nodes.find(node => node.id === 'candidate').dependencies[0].pinnedDigest;
  refusal(() => validateArtifactChain(unpinned), 'InvalidManifest');
});

test('build and evaluation replay byte-identically and mutate no input', () => {
  const input = descriptor();
  const inputText = JSON.stringify(input);
  const measuredText = JSON.stringify(MEASURED);
  const first = canonicalArtifactChainJson(buildArtifactChain({ descriptor: input, measured: MEASURED }));
  const second = canonicalArtifactChainJson(buildArtifactChain({ descriptor: input, measured: MEASURED }));
  assert.equal(first, second);
  assert.equal(artifactChainDocumentDigest(JSON.parse(first)), artifactChainDocumentDigest(JSON.parse(second)));
  assert.equal(JSON.stringify(input), inputText, 'the descriptor was mutated');
  assert.equal(JSON.stringify(MEASURED), measuredText, 'the measurement was mutated');

  // A manifest that survives a round trip through its own canonical bytes evaluates identically.
  const manifest = validateArtifactChain(JSON.parse(first));
  assert.equal(canonicalArtifactChainJson(manifest), first);
  const observed = { ...MEASURED };
  const reportText = canonicalArtifactChainJson(evaluateArtifactChain({ manifest, observed, expectation: EXPECTATION }));
  assert.equal(canonicalArtifactChainJson(evaluateArtifactChain({ manifest, observed, expectation: EXPECTATION })), reportText);
  assert.equal(canonicalArtifactChainJson(manifest), first, 'the manifest was mutated');
  assert.deepEqual(observed, MEASURED, 'the observation was mutated');
});

test('the file adapter measures real bytes and refuses escape, symlinks, and oversize input', () => {
  const root = tempRoot('measure');
  try {
    assert.deepEqual(measureArtifactChainFiles({ root, nodes: descriptor().nodes }), MEASURED);

    const outside = mkdtempSync(join(tmpdir(), 'gaia-artifact-chain-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret\n');
      const escape = [{ id: 'x', locator: '../secret.txt' }];
      assert.throws(() => measureArtifactChainFiles({ root, nodes: escape }),
        error => error instanceof ArtifactChainFileError && error.code === 'InvalidLocator');
      let linked = true;
      try { symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'), 'file'); }
      catch { linked = false; }
      if (linked) {
        assert.throws(() => measureArtifactChainFiles({ root, nodes: [{ id: 'x', locator: 'link.txt' }] }),
          error => error instanceof ArtifactChainFileError && error.code === 'SymlinkedLocator');
      }
    } finally { rmSync(outside, { recursive: true, force: true }); }

    assert.throws(() => measureArtifactChainFiles({ root, nodes: [{ id: 'x', locator: 'evidence' }] }),
      error => error instanceof ArtifactChainFileError && error.code === 'ArtifactUnreadable');
    assert.throws(() => measureArtifactChainFiles({ root, nodes: [{ id: 'x', locator: 'absent.md' }] }),
      error => error instanceof ArtifactChainFileError && error.code === 'ArtifactUnreadable');
    writeFileSync(join(root, 'huge.bin'), Buffer.alloc(ARTIFACT_BYTE_LIMIT + 1));
    assert.throws(() => measureArtifactChainFiles({ root, nodes: [{ id: 'x', locator: 'huge.bin' }] }),
      error => error instanceof ArtifactChainFileError && error.code === 'ArtifactTooLarge');
    assert.throws(() => measureArtifactChainFiles({ root: join(root, 'absent-dir'), nodes: [] }),
      error => error instanceof ArtifactChainFileError && error.code === 'InvalidRoot');
    assert.throws(() => readArtifactChainJson(join(root, 'absent.json')),
      error => error instanceof ArtifactChainFileError && error.code === 'DocumentUnreadable');
    writeFileSync(join(root, 'bad.json'), 'not json');
    assert.throws(() => readArtifactChainJson(join(root, 'bad.json')),
      error => error instanceof ArtifactChainFileError && error.code === 'DocumentUnreadable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('persisting a manifest is immutable: identical bytes are unchanged, different bytes refuse', () => {
  const root = tempRoot('persist');
  try {
    const manifest = chain();
    const path = join(root, 'evidence/artifact-chain.json');
    assert.deepEqual(persistArtifactChainManifest({ path, manifest }), { status: 'WRITTEN' });
    const bytes = readFileSync(path);
    assert.deepEqual(persistArtifactChainManifest({ path, manifest }), { status: 'UNCHANGED' });
    assert.deepEqual(readFileSync(path), bytes, 'an identical rewrite changed the bytes');

    const other = descriptor();
    other.nodes = other.nodes.filter(node => ['intent', 'notes', 'candidate'].includes(node.id));
    const shorter = chain(other, { intent: MEASURED.intent, notes: MEASURED.notes, candidate: MEASURED.candidate });
    assert.throws(() => persistArtifactChainManifest({ path, manifest: shorter }),
      error => error instanceof ArtifactChainFileError && error.code === 'ManifestConflict');
    assert.deepEqual(readFileSync(path), bytes, 'a conflicting write overwrote existing evidence');

    writeFileSync(join(root, 'evidence/corrupt.json'), 'not json\n');
    assert.throws(() => persistArtifactChainManifest({ path: join(root, 'evidence/corrupt.json'), manifest }),
      error => error instanceof ArtifactChainFileError && error.code === 'ManifestConflict');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the candidate sidecar records the candidate stage and leaves later stages not provided', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-artifact-chain-sidecar-'));
  try {
    const intent = { action: 'RUN_FACTORY_AGENT', repository: 'Example/app', itemNumber: 141,
      itemId: 'I_kwDO', draft: { number: 145, headRef: 'codex/fix', headRevision: REVISION },
      task: 'do the bounded work', intentRevision: 'c'.repeat(64) };
    writeFileSync(join(root, 'receipt.json'), FIXTURE.candidate);
    const emit = () => emitCandidateArtifactChain({ evidenceDir: root, intent, status: 'CANDIDATE_READY' });
    const first = emit();
    assert.equal(first.status, 'WRITTEN');
    assert.deepEqual(first.pendingStages, ['TEST_EVIDENCE', 'INDEPENDENT_REVIEW', 'PUBLICATION_EVIDENCE']);
    assert.equal(first.subject, 'Example/app#141/draft-145');
    assert.equal(emit().status, 'UNCHANGED', 'a repeated emission must not rewrite evidence');

    const manifest = validateArtifactChain(readArtifactChainJson(join(root, 'artifact-chain.json')));
    assert.deepEqual(manifest.nodes.map(node => node.stage), ['INTENT', 'CANDIDATE']);
    assert.equal(manifest.nodes[1].claim.kind, 'CANDIDATE_READY');
    assert.equal(manifest.nodes[1].rootRevision, REVISION);
    assert.equal(manifest.nodes[0].contentDigest,
      createHash('sha256').update(readFileSync(join(root, 'intent.json'))).digest('hex'));
    // The stored intent is evidence too: a second emission never rewrites it.
    assert.ok(lstatSync(join(root, 'intent.json')).isFile());

    const report = evaluateArtifactChain({ manifest,
      observed: measureArtifactChainFiles({ root, nodes: manifest.nodes }),
      expectation: { subject: first.subject, requiredRootRevisions: [REVISION] } });
    assert.equal(report.verdict, 'CHAIN_FRESH');
    assert.deepEqual(report.stages.filter(stage => stage.status === 'NOT_PROVIDED').map(stage => stage.stage),
      ['TEST_EVIDENCE', 'INDEPENDENT_REVIEW', 'PUBLICATION_EVIDENCE']);

    // A rejected candidate is recorded as rejected, in its own evidence directory.
    const rejectedDir = mkdtempSync(join(tmpdir(), 'gaia-artifact-chain-rejected-'));
    try {
      writeFileSync(join(rejectedDir, 'receipt.json'), FIXTURE.candidate);
      const rejected = emitCandidateArtifactChain({ evidenceDir: rejectedDir, intent, status: 'CANDIDATE_REJECTED' });
      assert.equal(rejected.status, 'WRITTEN');
      const document = validateArtifactChain(readArtifactChainJson(join(rejectedDir, 'artifact-chain.json')));
      assert.equal(document.nodes[1].claim.kind, 'CANDIDATE_REJECTED');
    } finally { rmSync(rejectedDir, { recursive: true, force: true }); }

    assert.throws(() => emitCandidateArtifactChain({ evidenceDir: join(root, 'absent'), intent, status: 'CANDIDATE_READY' }),
      error => error instanceof ArtifactChainFileError);
    assert.throws(() => emitCandidateArtifactChain({ evidenceDir: root, intent, status: 'MAYBE' }),
      error => error instanceof ArtifactChainFileError && error.code === 'InvalidCandidateStatus');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
