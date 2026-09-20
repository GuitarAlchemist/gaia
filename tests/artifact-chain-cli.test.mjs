import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateArtifactChain } from '../src/artifact-chain.mjs';
import { readArtifactChainJson } from '../src/artifact-chain-files.mjs';
import { emitCandidateSidecar } from '../scripts/github-portfolio-autonomous.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(repositoryRoot, 'scripts', 'artifact-chain.mjs');
const REVISION = 'a'.repeat(40);
const SUBJECT = 'github.com/Example/app#141';

const run = (...args) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined);
  return { code: result.status, out: result.stdout, err: result.stderr };
};

/** The demonstration fixture: five real files, one per stage, plus an advisory note. */
function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `gaia-artifact-chain-cli-${name}-`));
  mkdirSync(join(root, 'evidence'));
  writeFileSync(join(root, 'INTENT.md'), '# accepted intent\n\nthe user asked for the bounded work\n');
  writeFileSync(join(root, 'notes.md'), 'advisory background notes\n');
  writeFileSync(join(root, 'receipt.json'), '{"schema":"example-candidate","status":"completed"}\n');
  writeFileSync(join(root, 'evidence/tests.log'), 'ok 12 passing\nexit code 0\n');
  writeFileSync(join(root, 'evidence/review.md'), 'independent review: APPROVE, no important findings\n');
  writeFileSync(join(root, 'evidence/publication.json'), '{"draft":145,"head":"published"}\n');
  const fileDigest = path => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
  const descriptor = {
    subject: SUBJECT,
    nodes: [
      { id: 'intent', stage: 'INTENT', rootRevision: null, producer: 'repository-operator',
        locator: 'INTENT.md', claim: { kind: 'ACCEPTED_INTENT', statement: 'scope accepted by the user' },
        dependencies: [] },
      { id: 'notes', stage: 'INTENT', rootRevision: null, producer: 'repository-operator',
        locator: 'notes.md', claim: null, dependencies: [] },
      { id: 'candidate', stage: 'CANDIDATE', rootRevision: REVISION, producer: 'gaia-agent-factory',
        locator: 'receipt.json', claim: { kind: 'CANDIDATE_READY', statement: 'a change set exists' },
        dependencies: [
          { nodeId: 'intent', relation: 'required', pinnedDigest: fileDigest('INTENT.md') },
          { nodeId: 'notes', relation: 'advisory', pinnedDigest: fileDigest('notes.md') },
        ] },
      { id: 'tests', stage: 'TEST_EVIDENCE', rootRevision: REVISION, producer: 'node--test',
        locator: 'evidence/tests.log', claim: { kind: 'TESTS_REPORTED', statement: 'asserted by the log' },
        dependencies: [{ nodeId: 'candidate', relation: 'required',
          pinnedDigest: fileDigest('receipt.json') }] },
      { id: 'review', stage: 'INDEPENDENT_REVIEW', rootRevision: REVISION, producer: 'independent-reviewer',
        locator: 'evidence/review.md', claim: { kind: 'APPROVE', statement: 'asserted by the artifact' },
        dependencies: [{ nodeId: 'tests', relation: 'required',
          pinnedDigest: fileDigest('evidence/tests.log') }] },
      { id: 'publication', stage: 'PUBLICATION_EVIDENCE', rootRevision: REVISION, producer: 'gaia-publication-adapter',
        locator: 'evidence/publication.json', claim: { kind: 'DRAFT_PUBLISHED', statement: 'asserted by the receipt' },
        dependencies: [{ nodeId: 'review', relation: 'required',
          pinnedDigest: fileDigest('evidence/review.md') }] },
    ],
  };
  writeFileSync(join(root, 'descriptor.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
  return root;
}

test('the CLI creates and validates a five-stage chain in a real subprocess, then detects staleness', () => {
  const root = fixture('demo');
  const manifestPath = join(root, 'evidence', 'artifact-chain.json');
  try {
    const created = run('create', '--root', root, '--descriptor', join(root, 'descriptor.json'),
      '--manifest', manifestPath);
    assert.equal(created.code, 0, created.err);
    assert.match(created.out, /^status=WRITTEN$/mu);
    assert.match(created.out, /^pending=$/mu);
    const bytes = readFileSync(manifestPath);

    const again = run('create', '--root', root, '--descriptor', join(root, 'descriptor.json'),
      '--manifest', manifestPath);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /^status=UNCHANGED$/mu);
    assert.deepEqual(readFileSync(manifestPath), bytes, 'replay was not byte-identical');

    const manifest = validateArtifactChain(readArtifactChainJson(manifestPath));
    assert.deepEqual(manifest.pendingStages, []);

    const fresh = run('validate', '--root', root, '--manifest', manifestPath,
      '--subject', SUBJECT, '--root-revision', REVISION);
    assert.equal(fresh.code, 0, fresh.err);
    assert.match(fresh.out, /^verdict=CHAIN_FRESH$/mu);
    assert.match(fresh.out, /^node=publication FRESH$/mu);

    const json = run('validate', '--root', root, '--manifest', manifestPath,
      '--subject', SUBJECT, '--root-revision', REVISION, '--json');
    assert.equal(json.code, 0, json.err);
    const report = JSON.parse(json.out);
    assert.equal(report.verdict, 'CHAIN_FRESH');
    assert.equal(report.nodes.find(node => node.id === 'tests').claimStatus, 'ASSERTED_NOT_VERIFIED');

    // One byte of the accepted intent changes: every required dependent goes stale.
    writeFileSync(join(root, 'INTENT.md'), '# accepted intent\n\nthe user asked for other work\n');
    const stale = run('validate', '--root', root, '--manifest', manifestPath,
      '--subject', SUBJECT, '--root-revision', REVISION, '--json');
    assert.equal(stale.code, 1, stale.err);
    const staleReport = JSON.parse(stale.out);
    assert.equal(staleReport.verdict, 'CHAIN_STALE');
    assert.equal(staleReport.nodes.find(node => node.id === 'intent').freshness, 'CONTENT_CHANGED');
    for (const id of ['candidate', 'tests', 'review', 'publication']) {
      assert.equal(staleReport.nodes.find(node => node.id === id).freshness, 'STALE_REQUIRED_INPUT');
    }
    assert.deepEqual(readFileSync(manifestPath), bytes, 'validation must not touch the manifest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the CLI refuses usage errors, escaping locators, wrong subjects, and conflicting writes', () => {
  const root = fixture('refusals');
  const manifestPath = join(root, 'evidence', 'artifact-chain.json');
  try {
    assert.equal(run().code, 2);
    assert.equal(run('--help').code, 0);
    assert.equal(run('inspect', '--root', root).code, 2);
    assert.equal(run('create', '--root', root).code, 2);
    assert.equal(run('create', '--root', root, '--descriptor', join(root, 'descriptor.json'), '--nope', 'x').code, 2);
    assert.equal(run('validate', '--root', root, '--manifest', manifestPath, '--subject', SUBJECT).code, 2,
      'validate must require at least one expected root revision');

    const absent = run('create', '--root', root, '--descriptor', join(root, 'absent.json'));
    assert.equal(absent.code, 3);
    assert.match(absent.err, /^REFUSED: DocumentUnreadable$/mu);

    const escaping = JSON.parse(readFileSync(join(root, 'descriptor.json'), 'utf8'));
    escaping.nodes[0].locator = '../escape.md';
    writeFileSync(join(root, 'escaping.json'), JSON.stringify(escaping));
    const refused = run('create', '--root', root, '--descriptor', join(root, 'escaping.json'));
    assert.equal(refused.code, 3);
    assert.match(refused.err, /^REFUSED: InvalidLocator$/mu);

    assert.equal(run('create', '--root', root, '--descriptor', join(root, 'descriptor.json'),
      '--manifest', manifestPath).code, 0);
    const wrongSubject = run('validate', '--root', root, '--manifest', manifestPath,
      '--subject', 'github.com/Example/app#999', '--root-revision', REVISION);
    assert.equal(wrongSubject.code, 3);
    assert.match(wrongSubject.err, /^REFUSED: SubjectMismatch$/mu);

    // A second writer with a different chain refuses instead of overwriting the first.
    const shorter = JSON.parse(readFileSync(join(root, 'descriptor.json'), 'utf8'));
    shorter.nodes = shorter.nodes.filter(node => ['intent', 'notes', 'candidate'].includes(node.id));
    writeFileSync(join(root, 'shorter.json'), JSON.stringify(shorter));
    const bytes = readFileSync(manifestPath);
    const conflict = run('create', '--root', root, '--descriptor', join(root, 'shorter.json'),
      '--manifest', manifestPath);
    assert.equal(conflict.code, 3);
    assert.match(conflict.err, /^REFUSED: ManifestConflict$/mu);
    assert.deepEqual(readFileSync(manifestPath), bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate CLI writers race to the same manifest and exactly one set of bytes survives', async () => {
  const root = fixture('duplicate');
  const manifestPath = join(root, 'evidence', 'artifact-chain.json');
  try {
    const args = ['create', '--root', root, '--descriptor', join(root, 'descriptor.json'),
      '--manifest', manifestPath];
    const results = await Promise.all([0, 1, 2, 3].map(() => new Promise((settle, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { err += chunk; });
      child.on('error', reject);
      child.on('close', code => settle({ code, out, err }));
    })));
    assert.deepEqual(results.map(result => result.code), [0, 0, 0, 0], results.map(r => r.err).join(''));
    const statuses = results.map(result => /^status=(\w+)$/mu.exec(result.out)[1]);
    assert.equal(statuses.filter(status => status === 'WRITTEN').length, 1);
    assert.equal(statuses.filter(status => status === 'UNCHANGED').length, 3);
    assert.equal(run('validate', '--root', root, '--manifest', manifestPath,
      '--subject', SUBJECT, '--root-revision', REVISION).code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the autonomous CLI sidecar hook is honest about candidates and never throws into the host', () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'gaia-artifact-chain-host-'));
  try {
    const idempotencyKey = 'd'.repeat(64);
    const jobKey = 'e'.repeat(64);
    const intent = { action: 'RUN_FACTORY_AGENT', repository: 'Example/app', itemNumber: 141,
      itemId: 'I_kwDO', draft: { number: 145, headRef: 'codex/fix', headRevision: REVISION },
      task: 'do the bounded work', intentRevision: 'c'.repeat(64) };
    const evidenceDir = join(evidenceRoot, idempotencyKey);
    mkdirSync(evidenceDir);
    writeFileSync(join(evidenceDir, 'receipt.json'), '{"schema":"gaia-portfolio-execution-receipt/2"}\n');
    const receipt = { schema: 'gaia-autonomous-factory-receipt/1', status: 'CANDIDATE_READY',
      jobKey, intentRevision: intent.intentRevision, idempotencyKey, factory: { status: 'completed' } };
    const store = { get: key => (key === jobKey ? { jobKey, intent, idempotencyKey } : null) };

    const first = emitCandidateSidecar({ result: receipt, store, evidenceRoot });
    assert.equal(first.status, 'WRITTEN');
    assert.deepEqual(first.pendingStages, ['TEST_EVIDENCE', 'INDEPENDENT_REVIEW', 'PUBLICATION_EVIDENCE']);
    const bytes = readFileSync(join(evidenceDir, 'artifact-chain.json'));
    assert.equal(emitCandidateSidecar({ result: receipt, store, evidenceRoot }).status, 'UNCHANGED');
    assert.deepEqual(readFileSync(join(evidenceDir, 'artifact-chain.json')), bytes);
    assert.equal(validateArtifactChain(readArtifactChainJson(join(evidenceDir, 'artifact-chain.json')))
      .nodes[1].contentDigest,
      createHash('sha256').update(readFileSync(join(evidenceDir, 'receipt.json'))).digest('hex'));

    // Non-terminal tick results carry no candidate to describe.
    assert.equal(emitCandidateSidecar({ result: { status: 'NO_NEW_CANDIDATE' }, store, evidenceRoot }), null);
    assert.equal(emitCandidateSidecar({ result: { status: 'REFUSED', code: 'PolicyDisabled' }, store, evidenceRoot }), null);
    assert.equal(emitCandidateSidecar({ result: { schema: 'gaia-autonomous-factory-result/1',
      status: 'RECONCILIATION_REQUIRED', jobKey }, store, evidenceRoot }), null);

    // Every failure is reported in place. The completed job must never be rerun because a
    // sidecar could not be written, so nothing here may escape as an exception.
    const unreadable = emitCandidateSidecar({ result: { ...receipt, idempotencyKey: 'f'.repeat(64) },
      store, evidenceRoot });
    assert.equal(unreadable.status, 'FAILED');
    assert.match(unreadable.code, /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u);
    const hostile = emitCandidateSidecar({ result: receipt, evidenceRoot,
      store: { get: () => { throw new Error('ledger unavailable'); } } });
    assert.deepEqual(hostile, { status: 'FAILED', code: 'ArtifactChainSidecarFailed' });
    assert.deepEqual(emitCandidateSidecar({ result: receipt, evidenceRoot, store: { get: () => null } }),
      { status: 'FAILED', code: 'UnknownJob' });
  } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }
});
