import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main, createHostedDraftPumpRuntime } from '../scripts/hosted-draft-pump.mjs';
import { createMemoryDraftOperationPorts, createDraftOperationPorts, enqueueDraft,
  reconcileDraft, listUnsettledDrafts } from '../src/draft-operation-envelope.mjs';
import { createGhGitDataApi } from '../src/gh-git-data-adapter.mjs';
import { createGhDraftCollectorApi, createHostedDraftCollector } from '../src/hosted-draft-collector.mjs';
import { createGhDraftOperationProvider } from '../src/gh-draft-operation-provider.mjs';
import { createGitHubActionsDraftAdmission } from '../src/github-actions-draft-admission.mjs';
import { createMemoryManagedRoundEvidencePort } from '../src/pr-delivery-round-history.mjs';

const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const hash = v => createHash('sha256').update(canonical(v)).digest('hex');

async function fixture(t, { stopped = false, expired = false, unrelated = false,
  replay = false, expiredRecovery = false, changeDuringAdmission = null,
  mutatePolicy = () => {}, policyEnvironment = false, normal = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gaia-canary-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repository = { nodeId: 'R_test', owner: 'test-org', name: 'test-repo' };
  const workItem = { kind: 'ISSUE', number: 40 };
  const workKey = hash({ schema: 'GaiaDraftWorkKeyV0', repositoryNodeId: repository.nodeId,
    workItem, requestedEffect: 'CREATE_DRAFT' });
  const observedSourceRevision = 'a'.repeat(64); const queueReceiptRevision = 'b'.repeat(64);
  const envelope = { schema: 'GaiaDraftOperationEnvelopeV0', repository, workItem,
    readyItem: { schema: 'GaiaReadyItemIdentityV0', queueReceiptRevision, occurrence: 1,
      id: hash({ schema: 'GaiaReadyItemIdV0', workKey, queueReceiptRevision, occurrence: 1, observedSourceRevision }) },
    observedSourceRevision, requestedEffect: 'CREATE_DRAFT',
    generation: { baseRef: 'main', headRef: 'canary-40', headRevision: 'c'.repeat(40), policyRevision: 'd'.repeat(40) } };
  // Seed a real operation ledger through its producer, not a hand-authored intake receipt.
  const seed = createMemoryDraftOperationPorts({ collector: { collect: async () => envelope },
    provider: { lookupExact: async () => null, createDraft: async () => { throw Error('not used'); } },
    admission: { reserveEffect: async () => 'ZERO' }, executorEpoch: { runId: 50, runAttempt: 1 },
    telemetry: { append: async () => {} } });
  const enqueued = await enqueueDraft({ repository: { owner: repository.owner, name: repository.name }, workItem }, 'NONE', seed);
  let changedStorageObservation = false;
  const readStoredOperation = seed.store.inspectByOperation.bind(seed.store);
  // External storage observation fault: the composition must reject a revision change.
  seed.store.inspectByOperation = async id => {
    const observed = await readStoredOperation(id);
    return changedStorageObservation && observed
      ? { ...observed, committedRevision: '9'.repeat(64) } : observed;
  };
  if (unrelated) {
    const other = structuredClone(envelope);
    other.workItem.number = 41;
    const otherKey = hash({ schema: 'GaiaDraftWorkKeyV0', repositoryNodeId: repository.nodeId,
      workItem: other.workItem, requestedEffect: 'CREATE_DRAFT' });
    other.readyItem.id = hash({ schema: 'GaiaReadyItemIdV0', workKey: otherKey,
      queueReceiptRevision, occurrence: 1, observedSourceRevision });
    const otherPorts = createDraftOperationPorts({ ...seed, collector: { collect: async () => other } });
    await enqueueDraft({ repository: { owner: repository.owner, name: repository.name },
      workItem: other.workItem }, 'NONE', otherPorts);
  }
  const policy = { schema: 'GaiaCanaryAdmissionPolicyV0', version: 1, repository,
    issue: 40, operationId: enqueued.operationId, generationKey: enqueued.generationKey,
    headRevision: envelope.generation.headRevision, effectActorId: 123,
    validFrom: '2026-09-05T21:00:00.000Z', validUntil: '2026-09-05T22:00:00.000Z',
    accountableOwner: 'github:user:test-owner', effectOwner: 'github:app:test-pump',
    reviewOwners: { standards: 'github:user:test-standards', spec: 'github:user:test-spec' },
    allowedEffect: 'CREATE_DRAFT', roundBudget: 1 };
  mutatePolicy(policy);
  if (normal) {
    policy.schema = policy.schema.replace('Canary', 'Normal');
    for (const field of ['issue', 'operationId', 'generationKey', 'headRevision']) delete policy[field];
  }
  const path = join(dir, 'policy.json'); writeFileSync(path, JSON.stringify(policy));
  let candidate = null; let creates = 0; let reads = 0;
  const run = async (_command, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return { stdout: JSON.stringify({ id: 'R_test', nameWithOwner: 'test-org/test-repo' }) };
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: JSON.stringify(candidate ? [candidate] : []) };
    if (args[0] === 'api' && args[1].includes('/git/ref/heads/')) return { stdout: envelope.generation.headRevision };
    if (args[0] === 'pr' && args[1] === 'create') {
      creates++;
      candidate = { number: 121, url: 'https://github.com/test-org/test-repo/pull/121',
        isDraft: true, state: 'OPEN', baseRefName: 'main', headRefName: 'canary-40',
        headRefOid: envelope.generation.headRevision, headRepositoryOwner: { id: 'O_test', login: 'test-org' },
        body: args[args.indexOf('--body') + 1] };
      return { stdout: candidate.url };
    }
    if (args[0] === 'pr' && args[1] === 'view') return { stdout: JSON.stringify(candidate) };
    throw new Error(`Unexpected external command: ${args.join(' ')}`);
  };
  const evidence = createMemoryManagedRoundEvidencePort();
  let recoveryTime = false; let runtime;
  const dependencies = { createGhGitDataApi, createGhDraftCollectorApi, createHostedDraftCollector,
    createGitDataDraftOperationStore: () => seed.store,
    createGhDraftOperationProvider: options => createGhDraftOperationProvider({ ...options, run }),
    createGitHubManagedRoundEvidencePort: () => evidence,
    createGitHubActionsDraftAdmission, createDraftOperationPorts, enqueueDraft, reconcileDraft, listUnsettledDrafts,
    now: () => expired || recoveryTime ? policy.validUntil : '2026-09-05T21:10:00.000Z',
    readWorkflowAdmission: async () => {
      reads++;
      if (reads === 2) {
        if (changeDuringAdmission === 'policy') {
          writeFileSync(path, JSON.stringify({ ...policy, accountableOwner: 'github:user:replacement' }));
        }
        if (changeDuringAdmission === 'expiry') recoveryTime = true;
        if (changeDuringAdmission === 'ledger') changedStorageObservation = true;
      }
      return {
      repository: { full_name: 'test-org/test-repo' }, id: 50, run_attempt: 1,
      path: '.github/workflows/hosted-draft-intake.yml', head_sha: 'e'.repeat(40),
      status: stopped && reads > 1 ? 'completed' : 'in_progress' }; },
  };
  let output = ''; let errors = '';
  const invocation = { argv: ['intake', '--repository', 'test-org/test-repo',
    '--pump-actor-id', '123', '--repository-node-id', 'R_test',
    '--ledger-root-oid', 'f'.repeat(40), '--ledger-root-revision', 'f'.repeat(64), normal ? '--normal-policy' : '--canary-policy', path],
    env: { GITHUB_REPOSITORY: 'test-org/test-repo', GITHUB_RUN_ID: '50', GITHUB_RUN_ATTEMPT: '1',
      GITHUB_WORKFLOW_SHA: 'e'.repeat(40),
      GITHUB_WORKFLOW_REF: 'test-org/test-repo/.github/workflows/hosted-draft-intake.yml@refs/heads/main' },
    runtimeFactory: (configuration, telemetry) => {
      runtime = createHostedDraftPumpRuntime(configuration, telemetry, dependencies);
      return runtime;
    },
    stdout: { write: v => { output += v; } }, stderr: { write: v => { errors += v; } } };
  if (policyEnvironment) {
    invocation.argv.splice(-2);
    invocation.env[normal ? 'GAIA_NORMAL_POLICY' : 'GAIA_CANARY_POLICY'] = path;
  }
  const code = await main(invocation);
  const firstOutput = output;
  let replayCode; let replayOutput;
  if (replay) {
    output = '';
    replayCode = await main(invocation);
    replayOutput = output;
  }
  let recovery;
  if (expiredRecovery) {
    const snapshot = await seed.store.inspectByOperation(enqueued.operationId);
    recoveryTime = true;
    try {
      recovery = await runtime.reconcile({ operationId: enqueued.operationId,
        workKey: enqueued.workKey, expectedRevision: snapshot.committedRevision });
    } catch (error) { recovery = { error: error.code }; }
  }
  return { code, output: firstOutput, errors, creates, reads, candidate, seed, enqueued,
    replayCode, replayOutput, recovery, managedEvidence: await evidence.read(enqueued.workKey) };
}

test('hosted intake accepts the workflow policy environment through the real admission path', async t => {
  const result = await fixture(t, { policyEnvironment: true, replay: true });
  assert.equal(result.code, 0, result.errors);
  assert.equal(JSON.parse(result.output).result.outcome, 'CREATED');
  assert.equal(result.creates, 1);
  assert.equal(result.replayCode, 0);
});

test('hosted intake uses its real runtime and claim producer to create one policy-bound Draft', async t => {
  const result = await fixture(t);
  assert.equal(result.code, 0, result.errors);
  const receipt = JSON.parse(result.output);
  assert.equal(receipt.result.outcome, 'CREATED', result.output);
  assert.equal(receipt.operationId, result.enqueued.operationId);
  assert.equal(result.creates, 1);
  assert.equal(result.reads, 2, 'Actions admission is checked again at creation');
  assert.match(result.candidate.body, /UNKNOWN\(NOT_REACHED\)/);
});

test('hosted intake creates and reads back V1 AI assignments without asserting review approval', async t => {
  const result = await fixture(t, { replay: true, mutatePolicy: p => {
    p.schema = 'GaiaCanaryAdmissionPolicyV1';
    p.writerIdentity = 'gaia:agent:v1:codex:11111111-1111-4111-8111-111111111111:writer';
    p.reviewOwners = {
      standards: 'gaia:agent:v1:codex:11111111-1111-4111-8111-111111111111:standards',
      spec: 'gaia:agent:v1:claude:22222222-2222-4222-8222-222222222222:spec',
    };
  } });
  assert.equal(result.code, 0, result.errors);
  assert.equal(JSON.parse(result.output).result.outcome, 'CREATED', result.output);
  assert.equal(result.creates, 1);
  assert.equal(result.replayCode, 0);
  assert.match(result.candidate.body, /Writer identity: `gaia:agent:v1:codex:/);
  assert.match(result.candidate.body, /Spec review owner: `gaia:agent:v1:claude:/);
  assert.match(result.candidate.body, /Review verdicts: `UNKNOWN\(NOT_REACHED\)`/);
});

test('hosted intake refuses self-reviewed V1 before any managed claim or Draft', async t => {
  const result = await fixture(t, { mutatePolicy: p => {
    p.schema = 'GaiaCanaryAdmissionPolicyV1';
    p.writerIdentity = 'gaia:agent:v1:codex:11111111-1111-4111-8111-111111111111:writer';
    p.reviewOwners = { standards: p.writerIdentity,
      spec: 'gaia:agent:v1:claude:22222222-2222-4222-8222-222222222222:spec' };
  } });
  assert.notEqual(result.code, 0);
  assert.equal(result.creates, 0);
  assert.deepEqual(result.managedEvidence, { state: 'UNSEEN' });
});

test('hosted intake creates no Draft when Actions stops before the effect', async t => {
  const result = await fixture(t, { stopped: true });
  assert.equal(result.creates, 0);
  assert.equal(result.candidate, null);
  assert.notEqual(JSON.parse(result.output).result.outcome, 'CREATED');
});

test('hosted intake creates no Draft for an expired canary policy', async t => {
  const result = await fixture(t, { expired: true });
  assert.notEqual(result.code, 0);
  assert.equal(result.creates, 0);
  assert.equal(result.reads, 0);
});

test('hosted intake cannot redirect the canary to a different generation', async t => {
  const result = await fixture(t, { mutatePolicy: policy => { policy.generationKey = '0'.repeat(64); } });
  assert.notEqual(result.code, 0);
  assert.equal(result.creates, 0);
  assert.equal(result.reads, 0);
});

test('one canary does not hide unrelated unsettled work from the global receipt', async t => {
  const result = await fixture(t, { unrelated: true });
  assert.equal(result.code, 0, result.errors);
  const receipt = JSON.parse(result.output);
  assert.equal(receipt.result.outcome, 'CREATED');
  assert.equal(receipt.unsettledCount, 1);
  assert.equal(result.creates, 1);
});

test('replaying the same canary admission cannot create a second Draft or claim new progress', async t => {
  const result = await fixture(t, { replay: true });
  assert.equal(JSON.parse(result.output).result.outcome, 'CREATED');
  assert.equal(result.replayCode, 0, result.errors);
  const replay = JSON.parse(result.replayOutput);
  assert.equal(replay.result, null);
  assert.equal(replay.skipped[0].reason, 'CanaryOperationNotEnqueued');
  assert.equal(result.creates, 1);
});

test('policy expiry does not erase read-only reconciliation of an already terminal canary', async t => {
  const result = await fixture(t, { expiredRecovery: true });
  assert.equal(result.recovery.kind, 'Terminal', JSON.stringify(result.recovery));
  assert.equal(result.recovery.pullRequest.number, 121);
  assert.equal(result.creates, 1);
});

test('changes during admission cannot acquire a managed claim or create a Draft', async t => {
  for (const change of ['policy', 'ledger', 'expiry']) {
    await t.test(change, async subtest => {
      const result = await fixture(subtest, { changeDuringAdmission: change });
      assert.equal(result.creates, 0);
      assert.deepEqual(result.managedEvidence, { state: 'UNSEEN' });
      assert.notEqual(JSON.parse(result.output).result.outcome, 'CREATED');
    });
  }
});

test('ambiguous canary recovery remains lookup-only without renewing managed authority', async t => {
  const result = await fixture(t, { stopped: true, replay: true });
  assert.equal(result.replayCode, 0, result.errors);
  assert.equal(JSON.parse(result.replayOutput).result.state, 'EFFECT_AMBIGUOUS');
  assert.equal(result.creates, 0);
  assert.deepEqual(result.managedEvidence, { state: 'UNSEEN' });
  assert.equal(result.reads, 2, 'the retry must not request fresh create authority');
});

test('normal intake crosses the real runtime and managed receipt seam without a static claim', async t => {
  const result = await fixture(t, { normal: true, policyEnvironment: true, expiredRecovery: true });
  assert.equal(result.code, 0, result.errors);
  assert.equal(JSON.parse(result.output).result.outcome, 'CREATED', result.output);
  assert.equal(result.creates, 1);
  assert.equal(result.reads, 2);
  assert.equal(result.recovery.kind, 'Terminal');
  assert.match(result.candidate.body, /normal admission policy/);
});

test('normal intake refuses changed policy, ledger, expiry or stopped Actions before creation', async t => {
  for (const fault of ['policy', 'ledger', 'expiry', 'stopped']) {
    await t.test(fault, async subtest => {
      const result = await fixture(subtest, { normal: true, stopped: fault === 'stopped',
        changeDuringAdmission: fault === 'stopped' ? null : fault });
      assert.equal(result.creates, 0);
      assert.deepEqual(result.managedEvidence, { state: 'UNSEEN' });
      assert.notEqual(JSON.parse(result.output).result.outcome, 'CREATED');
    });
  }
});
