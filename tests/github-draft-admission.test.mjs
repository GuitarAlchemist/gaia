import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DraftAdmissionError,
  createGitHubDraftAdmissionAdapter,
} from '../src/github-draft-admission.mjs';
import { initOperatorKeypair } from '../src/github-portfolio-operator.mjs';
import { createPortfolioFactory } from '../src/github-portfolio.mjs';
import { runPortfolioOperatorCli } from '../scripts/github-portfolio-operator.mjs';
import { main as runHostedPump } from '../scripts/hosted-draft-pump.mjs';
import { createMemoryDraftOperationPorts, enqueueDraft, reconcileDraft,
  listUnsettledDrafts } from '../src/draft-operation-envelope.mjs';
import { MANAGED_CREATE } from './helpers/managed-draft-config.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-draft-admission-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

// The envelope's own identity function, restated here so the fixture receipt carries a
// chain the adapter must be able to recompute rather than a chain the test asserts by
// fiat. The producer-composition test below, not this copied form, checks compatibility.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const contentRevision = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

const REPOSITORY = { nodeId: 'R_kgDOga', owner: 'GuitarAlchemist', name: 'ga' };
const WORK_ITEM = { kind: 'ISSUE', number: 7 };
const GENERATION = {
  baseRef: 'main',
  headRef: 'gaia/draft-issue-7',
  headRevision: 'c'.repeat(40),
  policyRevision: '1'.repeat(40),
};
const WORK_KEY = contentRevision({
  schema: 'GaiaDraftWorkKeyV0', repositoryNodeId: REPOSITORY.nodeId, workItem: WORK_ITEM,
  requestedEffect: 'CREATE_DRAFT',
});
const GENERATION_KEY = contentRevision({
  schema: 'GaiaDraftGenerationKeyV0', readyItemId: 'd'.repeat(64), generation: GENERATION,
});
const OPERATION_ID = contentRevision({
  schema: 'GaiaDraftOperationIdV0', workKey: WORK_KEY, generationKey: GENERATION_KEY,
});

function intakeReceipt(overrides = {}) {
  const pullRequest = {
    number: 121,
    url: 'https://github.com/GuitarAlchemist/ga/pull/121',
    isDraft: true,
    state: 'OPEN',
    operationMarker: OPERATION_ID,
    repository: REPOSITORY,
    baseRef: GENERATION.baseRef,
    headRef: GENERATION.headRef,
    headRevision: GENERATION.headRevision,
  };
  const result = {
    kind: 'Terminal',
    outcome: 'CREATED',
    effect: 'CREATE_DRAFT',
    operationId: OPERATION_ID,
    workKey: WORK_KEY,
    generationKey: GENERATION_KEY,
    generation: GENERATION,
    observedSourceRevision: 'e'.repeat(64),
    pullRequest,
    refusal: null,
    committedRevision: 'f'.repeat(64),
    actionRevision: 'f'.repeat(64),
    checklistRevision: 'f'.repeat(64),
    sourceRevision: 'f'.repeat(64),
  };
  return {
    schema: 'GaiaHostedDraftPumpCliReceiptV0',
    command: 'intake',
    trigger: 'ISSUES_LABELED',
    phase: 'ADMIT',
    operationId: OPERATION_ID,
    workKey: WORK_KEY,
    committedRevision: 'f'.repeat(64),
    workItem: WORK_ITEM,
    unsettledCount: 0,
    result,
    skipped: [],
    telemetry: [],
    ...overrides,
  };
}

// The gh transport the provider talks through: one repository identity answer and one
// pull-request listing per read, scripted per case. Nothing else is reachable.
function fakeGh(pullRequests) {
  const calls = [];
  const candidate = (fields) => ({
    number: 121,
    url: 'https://github.com/GuitarAlchemist/ga/pull/121',
    isDraft: true,
    state: 'OPEN',
    baseRefName: GENERATION.baseRef,
    headRefName: GENERATION.headRef,
    headRefOid: GENERATION.headRevision,
    headRepositoryOwner: { id: 'U_kgDOowner', login: 'GuitarAlchemist' },
    body: `<!-- gaia-operation:${OPERATION_ID} -->\nIssue: https://github.com/GuitarAlchemist/ga/issues/7`,
    ...fields,
  });
  const run = async (command, args) => {
    calls.push([command, ...args]);
    assert.equal(command, 'gh');
    if (args[0] === 'repo' && args[1] === 'view') {
      return { stdout: JSON.stringify({ id: REPOSITORY.nodeId, nameWithOwner: 'GuitarAlchemist/ga' }) };
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      return { stdout: JSON.stringify(pullRequests().map(candidate)) };
    }
    throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
  };
  return { calls, run };
}

test('scheduled intake receipts from the real producer remain admissible with diagnostic annotations', async () => {
  const queueReceiptRevision = '2'.repeat(64);
  const observedSourceRevision = '3'.repeat(64);
  const envelope = {
    schema: 'GaiaDraftOperationEnvelopeV0', repository: REPOSITORY, workItem: WORK_ITEM,
    readyItem: {
      schema: 'GaiaReadyItemIdentityV0', queueReceiptRevision, occurrence: 1,
      id: contentRevision({ schema: 'GaiaReadyItemIdV0', workKey: WORK_KEY,
        queueReceiptRevision, occurrence: 1, observedSourceRevision }),
    },
    observedSourceRevision, generation: GENERATION, requestedEffect: 'CREATE_DRAFT',
  };
  const ports = createMemoryDraftOperationPorts({
    collector: { collect: async () => envelope },
    provider: {
      lookupExact: async () => null,
      createDraft: async (request) => ({
        number: 121, url: 'https://github.com/GuitarAlchemist/ga/pull/121',
        isDraft: true, state: 'OPEN', operationMarker: request.operationMarker,
        repository: request.repository, baseRef: request.baseRef,
        headRef: request.headRef, headRevision: request.headRevision,
      }),
    },
    admission: { reserveEffect: async () => 'AVAILABLE' },
    executorEpoch: { runId: 9001, runAttempt: 1 }, telemetry: { append: async () => {} },
  });
  let output = ''; let errors = ''; let observation;
  const code = await runHostedPump({
    argv: ['intake', '--repository', 'GuitarAlchemist/ga', '--pump-actor-id', '1234',
      '--repository-node-id', REPOSITORY.nodeId, '--ledger-root-oid', '4'.repeat(40),
      '--ledger-root-revision', '5'.repeat(64)],
    env: { GAIA_MANAGED_ROUND_JSON: JSON.stringify({ create: MANAGED_CREATE, advance: null }),
      GAIA_OBSERVATION_PATH: 'unused-observation.json', GITHUB_RUN_ID: '9001' },
    now: () => '2026-09-05T19:00:00.000Z',
    stdout: { write: (value) => { output += value; } },
    stderr: { write: (value) => { errors += value; } },
    writeFile: (_path, value) => { observation = JSON.parse(value); },
    runtimeFactory: () => ({
      enqueue: (selector) => enqueueDraft(selector, 'NONE', ports),
      reconcile: ({ operationId, expectedRevision }) => reconcileDraft(operationId, expectedRevision, ports),
      listUnsettled: () => listUnsettledDrafts(ports),
      listReadyIssues: async () => [{ number: WORK_ITEM.number }],
    }),
  });
  assert.equal(code, 0, errors);
  const receipt = JSON.parse(output);
  assert.equal(receipt.result.outcome, 'CREATED');
  assert.equal(receipt.observation.state, 'PRODUCED');
  assert.equal(receipt.observation.revision, observation.revision);
  const gh = fakeGh(() => [{ body: `<!-- gaia-operation:${receipt.operationId} -->` }]);
  const read = (value) => createGitHubDraftAdmissionAdapter({
    expectedRepository: 'GuitarAlchemist/ga', receiptText: JSON.stringify(value), run: gh.run,
  }).read({ repository: 'GuitarAlchemist/ga', itemKind: 'ISSUE', itemNumber: WORK_ITEM.number });
  const admitted = await read(receipt);
  assert.equal(admitted.number, 121);
  assert.equal(admitted.headRevision, GENERATION.headRevision);
  assert.equal(gh.calls.length, 2, 'diagnostic success never replaces provider readback');
  assert.deepEqual(await read({ ...receipt, observation: {
    state: 'REFUSED', reason: 'UnobservableHostedDraftPumpReceipt',
  } }), admitted, 'observation failure is not an admission decision');
  for (const bad of [null, { state: 'PRODUCED', revision: 'wrong' },
    { state: 'REFUSED', reason: 'unrecognized' },
    { state: 'PRODUCED', revision: observation.revision, extra: true }]) {
    await assert.rejects(read({ ...receipt, observation: bad }),
      (error) => error.code === 'DraftExpectationInvalid');
  }
  await assert.rejects(read({ ...receipt, undeclared: true }),
    (error) => error.code === 'DraftExpectationInvalid');
});

test('the Draft admission adapter reads back the exact issue-bound Draft and refuses everything else', async () => {
  const receiptText = JSON.stringify(intakeReceipt());
  let listing = [{}];
  const gh = fakeGh(() => listing);
  const adapter = createGitHubDraftAdmissionAdapter({
    expectedRepository: 'GuitarAlchemist/ga', receiptText, run: gh.run,
  });
  const scheduled = { repository: 'GuitarAlchemist/ga', itemKind: 'ISSUE', itemNumber: 7 };

  // Admitted: the live head equals the receipt's head and the marker is exact.
  assert.deepEqual(await adapter.read(scheduled), {
    number: 121, isDraft: true, state: 'OPEN',
    headRef: GENERATION.headRef, headRevision: GENERATION.headRevision,
  });
  assert.deepEqual(gh.calls.map((call) => call.slice(0, 3)), [
    ['gh', 'repo', 'view'], ['gh', 'pr', 'list'],
  ]);

  // A scheduled item other than the receipt's is foreign to this expectation, and GitHub
  // is not consulted about it.
  const before = gh.calls.length;
  for (const foreign of [
    { ...scheduled, itemNumber: 8 },
    { ...scheduled, itemKind: 'PULL_REQUEST' },
    { ...scheduled, repository: 'GuitarAlchemist/ix' },
  ]) {
    await assert.rejects(adapter.read(foreign), (error) => (
      error instanceof DraftAdmissionError && error.code === 'DraftExpectationForeign'
    ));
  }
  assert.equal(gh.calls.length, before);

  // No pull request on the head: absent, so the factory refuses DraftAdmissionMissing.
  listing = [];
  assert.equal(await adapter.read(scheduled), null);
  // Reusing the exact branch/marker does not make a different PR the one in the receipt.
  listing = [{ number: 999, url: 'https://github.com/GuitarAlchemist/ga/pull/999' }];
  await assert.rejects(adapter.read(scheduled), (error) => error.code === 'DraftExpectationMismatch');
  // The head moved after the receipt was written: stale, refused by the provider's exact
  // readback, never admitted with the receipt's revision.
  listing = [{ headRefOid: 'a'.repeat(40) }];
  await assert.rejects(adapter.read(scheduled), (error) => error.code === 'ProviderConflict');
  // Ready for review or closed: not a Draft.
  listing = [{ isDraft: false }];
  await assert.rejects(adapter.read(scheduled), (error) => error.code === 'ProviderConflict');
  listing = [{ state: 'CLOSED' }];
  await assert.rejects(adapter.read(scheduled), (error) => error.code === 'ProviderConflict');
  // A fork carrying the marker is not the repository's Draft.
  listing = [{ headRepositoryOwner: { id: 'U_other', login: 'someone-else' } }];
  await assert.rejects(adapter.read(scheduled), (error) => error.code === 'ProviderConflict');
  // Two candidates on one head are ambiguous, never "the first one".
  listing = [{}, { number: 122, url: 'https://github.com/GuitarAlchemist/ga/pull/122' }];
  await assert.rejects(adapter.read(scheduled), (error) => error.code === 'ProviderAmbiguous');
  // A transport failure is unavailable, and its text does not travel.
  const broken = createGitHubDraftAdmissionAdapter({
    expectedRepository: 'GuitarAlchemist/ga', receiptText,
    run: async () => { throw new Error('token ghs_SECRET leaked in stderr'); },
  });
  await assert.rejects(broken.read(scheduled), (error) => (
    error.code === 'ProviderUnavailable' && !String(error.message).includes('ghs_SECRET')
  ));
});

test('the Draft admission adapter refuses a receipt whose identity chain does not derive from its issue', async () => {
  // Refusal happens on the first read, inside the factory's admission boundary, so the
  // operator still gets a receipt; the transport is never reached on any of these.
  const scheduled = { repository: 'GuitarAlchemist/ga', itemKind: 'ISSUE', itemNumber: 7 };
  const unreachable = async () => { throw new Error('must not be reached'); };
  const build = (receiptText, expectedRepository = 'GuitarAlchemist/ga') => (
    createGitHubDraftAdmissionAdapter({ expectedRepository, receiptText, run: unreachable })
  );
  const invalid = (receipt, label) => assert.rejects(build(JSON.stringify(receipt)).read(scheduled),
    (error) => error instanceof DraftAdmissionError && error.code === 'DraftExpectationInvalid', label);

  const base = intakeReceipt();
  await invalid({ ...base, workKey: 'a'.repeat(64), result: { ...base.result, workKey: 'a'.repeat(64) } },
    'work key not derived from repository and issue');
  await invalid({ ...base, workItem: { kind: 'ISSUE', number: 8 } }, 'issue does not derive the work key');
  await invalid({
    ...base,
    result: { ...base.result, pullRequest: { ...base.result.pullRequest, operationMarker: 'b'.repeat(64) } },
  }, 'marker is not the operation identity');
  await invalid({ ...base, result: { ...base.result, kind: 'Pending' } }, 'not terminal');
  await invalid({ ...base, result: { ...base.result, outcome: 'REFUSED', pullRequest: null } }, 'refused outcome');
  await invalid({ ...base, command: 'reconcile' }, 'not an intake receipt');
  await invalid({ ...base, schema: 'SomethingElse' }, 'foreign schema');
  await assert.rejects(build(JSON.stringify(base), 'GuitarAlchemist/ix').read(
    { ...scheduled, repository: 'GuitarAlchemist/ix' },
  ), (error) => error instanceof DraftAdmissionError && error.code === 'DraftExpectationForeign');
  await assert.rejects(build('{not json').read(scheduled),
    (error) => error instanceof DraftAdmissionError && error.code === 'DraftExpectationInvalid');
  assert.throws(() => createGitHubDraftAdmissionAdapter({
    expectedRepository: 'not a repository', receiptText: '{}', run: unreachable,
  }), (error) => error instanceof DraftAdmissionError && error.code === 'InvalidArgument');
});

// ---------------------------------------------------------------------------
// The shipped composition: the real CLI, the real operator, the real factory, the real
// authority adapter with an ephemeral key, and the real admission adapter over a fake gh
// transport. Only GitHub, the terminal, and the agent execution are replaced.
// ---------------------------------------------------------------------------

function scripted(answers) {
  const prompts = [];
  const remaining = [...answers];
  return {
    prompts,
    read: async ({ prompt }) => {
      prompts.push(prompt);
      if (remaining.length === 0) throw new Error('the script ran out of answers');
      return remaining.shift();
    },
  };
}

const githubSnapshot = () => ({
  schema: 'gaia-github-read-snapshot/1',
  organization: 'GuitarAlchemist',
  scope: 'all-repositories-visible-to-adapter',
  complete: true,
  repositories: [{
    id: 'repo-ga', nameWithOwner: 'GuitarAlchemist/ga', archived: false,
    defaultBranchOid: 'f'.repeat(40),
    issues: [{
      id: 'issue-ga-7', number: 7, title: 'Deliver the canary',
      updatedAt: '2026-09-05T12:00:00.000Z', labels: ['ready-for-agent'],
      dependencies: [], duplicateOf: null,
    }],
    pullRequests: [],
  }],
});

test('the operator CLI admits the Draft through the shipped composition before any grant is spent', async () => {
  const dir = join(scratch, 'cli');
  mkdirSync(dir);
  const ledgerDir = join(dir, 'ledger');
  mkdirSync(ledgerDir);
  const privateKeyPath = join(dir, 'operator.key');
  const publicKeyPath = join(dir, 'operator.pub');
  await initOperatorKeypair({
    privateKeyPath, publicKeyPath, readPassphrase: scripted(['pass phrase', 'pass phrase']).read,
  });
  const githubRead = { read: async () => githubSnapshot() };
  const portfolio = await createPortfolioFactory({ githubRead }).survey({
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  });
  const portfolioPath = join(dir, 'portfolio.json');
  writeFileSync(portfolioPath, JSON.stringify(portfolio), 'utf8');
  const receiptPath = join(dir, 'intake-receipt.json');
  writeFileSync(receiptPath, JSON.stringify(intakeReceipt()), 'utf8');

  let listing = [];
  const gh = fakeGh(() => listing);
  let executed = 0;
  const confirmations = [];
  const baseArgs = [
    'run',
    '--portfolio', portfolioPath,
    '--repository', 'GuitarAlchemist/ga',
    '--private-key', privateKeyPath,
    '--public-key', publicKeyPath,
    '--ledger', ledgerDir,
    '--worktree', join(dir, 'worktree'),
    '--evidence-root', join(dir, 'evidence'),
  ];
  const run = (extraArgs, outName) => runPortfolioOperatorCli(
    [...baseArgs, '--out', join(dir, outName), ...extraArgs],
    {
      isInteractive: () => true,
      writeStdout: () => {},
      writeProgress: () => {},
      createGithubRead: () => githubRead,
      createExecution: () => ({
        execute: async ({ intent }) => {
          executed += 1;
          return { schema: 'gaia-agent-factory-receipt/1', status: 'completed', task: intent.task };
        },
      }),
      createDraftAdmission: (options) => createGitHubDraftAdmissionAdapter({ ...options, run: gh.run }),
      readPassphraseFn: async () => 'pass phrase',
      confirmFn: async ({ prompt, intent }) => {
        confirmations.push(prompt);
        return intent.intentRevision;
      },
    },
  );
  const receiptAt = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

  // Omitting the receipt is a usage error, not a run without admission.
  await assert.rejects(run([], 'no-receipt.json'), /missing --draft-receipt/u);
  assert.equal(executed, 0);

  // No Draft on GitHub: refused at materialization, before confirmation, before any grant.
  assert.equal(await run(['--draft-receipt', receiptPath], 'missing.json'), 1);
  assert.deepEqual(receiptAt('missing.json').refusal, { stage: 'materialize', code: 'DraftAdmissionMissing' });
  assert.equal(confirmations.length, 0);
  assert.deepEqual(readdirSync(ledgerDir), []);
  assert.equal(executed, 0);

  // The exact Draft exists: the operator confirms it by revision and one run is authorized.
  listing = [{}];
  assert.equal(await run(['--draft-receipt', receiptPath], 'admitted.json'), 0);
  const admitted = receiptAt('admitted.json');
  assert.equal(admitted.status, 'AUTHORIZED');
  assert.equal(admitted.transition.status, 'CANDIDATE_READY');
  assert.deepEqual(admitted.transition.intent.draft, {
    number: 121, headRef: GENERATION.headRef, headRevision: GENERATION.headRevision,
  });
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /draft\s+#121 gaia\/draft-issue-7 @ c{40}/u);
  assert.equal(readdirSync(ledgerDir).length, 1);
  assert.equal(executed, 1);
});
