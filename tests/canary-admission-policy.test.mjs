import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareCanaryManagedRound, validateCanaryAdmissionPolicy } from '../src/canary-admission-policy.mjs';
import { validateManagedDraftConfiguration, createInitialManagedRound,
  planManagedRoundUpdate } from '../src/pr-delivery-round-history.mjs';
import { createHash } from 'node:crypto';

// Synthetic identities exercise the contract; they are never activation material.
const policy = {
  schema: 'GaiaCanaryAdmissionPolicyV0', version: 1,
  repository: { nodeId: 'R_test', owner: 'test-org', name: 'test-repo' },
  issue: 40, operationId: 'a'.repeat(64), generationKey: 'b'.repeat(64),
  headRevision: 'c'.repeat(40), effectActorId: 123,
  validFrom: '2026-09-05T21:00:00.000Z', validUntil: '2026-09-05T22:00:00.000Z',
  accountableOwner: 'github:user:test-owner', effectOwner: 'github:app:test-pump',
  reviewOwners: { standards: 'github:user:test-standards', spec: 'github:user:test-spec' },
  allowedEffect: 'CREATE_DRAFT', roundBudget: 1,
};
const epoch = { runId: 50, runAttempt: 1 };
const snapshot = {
  identity: { operationId: policy.operationId, generationKey: policy.generationKey, workKey: 'd'.repeat(64) },
  envelope: { repository: policy.repository, workItem: { kind: 'ISSUE', number: 40 },
    generation: { headRevision: policy.headRevision } },
  state: 'EFFECT_STARTED', committedRevision: 'e'.repeat(64), executorEpoch: epoch,
};
const input = () => ({ policy: structuredClone(policy), snapshot: structuredClone(snapshot),
  executorEpoch: { ...epoch }, pumpActorId: 123, observedAt: '2026-09-05T21:10:00.000Z' });

test('V1 canary assignments preserve real-shaped AI identities without inventing approval', () => {
  const value = input();
  value.policy.schema = 'GaiaCanaryAdmissionPolicyV1';
  value.policy.writerIdentity = 'gaia:agent:v1:codex:11111111-1111-4111-8111-111111111111:writer';
  value.policy.reviewOwners = {
    standards: 'gaia:agent:v1:codex:11111111-1111-4111-8111-111111111111:standards',
    spec: 'gaia:agent:v1:claude:22222222-2222-4222-8222-222222222222:spec',
  };
  const result = prepareCanaryManagedRound(value);
  assert.equal(result.receipt.schema, 'GaiaRoundReceiptV1');
  assert.equal(result.receipt.responsibility.writerIdentity, value.policy.writerIdentity);
  assert.deepEqual(result.receipt.responsibility.reviewOwners, value.policy.reviewOwners);
  assert.deepEqual(result.receipt.evidence.reviewVerdicts, ['UNKNOWN(NOT_REACHED)']);
  assert.equal(result.receipt.command.generation, policy.headRevision);
  assert.doesNotThrow(() => validateManagedDraftConfiguration(result));
  assert.deepEqual(prepareCanaryManagedRound(value), result);
  const initial = createInitialManagedRound({ workKey: value.snapshot.identity.workKey,
    headRevision: policy.headRevision, receipt: result.receipt });
  const body = initial.managedSection;
  const projection = planManagedRoundUpdate({ workKey: value.snapshot.identity.workKey,
    observation: { number: 121, headRevision: policy.headRevision, body,
      bodyRevision: createHash('sha256').update(body).digest('hex') },
    receipt: { schema: 'GaiaRoundDeadlineReceiptV0', revision: 'f'.repeat(64),
      observedAt: '2026-09-05T22:01:00.000Z' } });
  assert.equal(projection.kind, 'ESCALATE', JSON.stringify(projection));
});

test('V1 refuses writer review, provider aliases, missing identities and V0 downgrade', () => {
  const base = input();
  base.policy.schema = 'GaiaCanaryAdmissionPolicyV1';
  base.policy.writerIdentity = 'gaia:agent:v1:codex:11111111-1111-4111-8111-111111111111:writer';
  base.policy.reviewOwners = {
    standards: 'gaia:agent:v1:codex:11111111-1111-4111-8111-111111111111:standards',
    spec: 'gaia:agent:v1:claude:22222222-2222-4222-8222-222222222222:spec',
  };
  for (const mutate of [
    p => { p.reviewOwners.spec = p.writerIdentity; },
    p => { p.reviewOwners.spec = p.reviewOwners.standards.replace(':codex:', ':claude:'); },
    p => { p.reviewOwners.spec = p.writerIdentity.replace(':codex:', ':claude:'); },
    p => { delete p.writerIdentity; },
    p => { p.reviewOwners.spec = 'claude-sonnet-5'; },
    p => { p.schema = 'GaiaCanaryAdmissionPolicyV0'; },
    p => { p.schema = 'GaiaCanaryAdmissionPolicyV0'; delete p.writerIdentity; },
  ]) {
    const value = structuredClone(base); mutate(value.policy);
    assert.throws(() => prepareCanaryManagedRound(value), { code: 'InvalidCanaryPolicy' });
  }
  const stale = structuredClone(base); stale.snapshot.envelope.generation.headRevision = 'f'.repeat(40);
  assert.throws(() => prepareCanaryManagedRound(stale), { code: 'CanaryPolicyScopeMismatch' });
  const forged = prepareCanaryManagedRound(base);
  forged.receipt.responsibility.reviewOwners.spec = base.policy.writerIdentity;
  assert.throws(() => validateManagedDraftConfiguration(forged), { code: 'ReviewOwnerConflict' });
});

test('one canary policy produces a valid managed receipt bound to durable execution evidence', () => {
  const result = prepareCanaryManagedRound(input());
  assert.doesNotThrow(() => validateManagedDraftConfiguration(result));
  assert.equal(result.receipt.command.generation, policy.headRevision);
  assert.equal(result.receipt.responsibility.supervisor, `gaia:operation:${policy.operationId}`);
  assert.equal(result.receipt.roundBudget, 1);
  assert.deepEqual(result.receipt.evidence.reviewVerdicts, ['UNKNOWN(NOT_REACHED)']);
  assert.equal(result.effectClaim.leaseExpiresAt, '2026-09-05T21:15:00.000Z');
  const later = input(); later.observedAt = '2026-09-05T21:58:00.000Z';
  const replay = prepareCanaryManagedRound(later);
  assert.deepEqual(replay.receipt, result.receipt);
  assert.equal(replay.effectClaim.leaseExpiresAt, policy.validUntil);
  assert.deepEqual(prepareCanaryManagedRound(input()), result);
});

test('canary policy requires an actual repository identity, not a coerced absent value', () => {
  const invalid = structuredClone(policy); invalid.repository.nodeId = undefined;
  assert.throws(() => validateCanaryAdmissionPolicy(invalid), { code: 'InvalidCanaryPolicy' });
});

test('canary producer refuses foreign, expired, unclaimed and conflicting inputs', () => {
  const cases = [
    ['foreign operation', x => { x.snapshot.identity.operationId = 'f'.repeat(64); }, 'CanaryPolicyScopeMismatch'],
    ['new generation', x => { x.snapshot.identity.generationKey = 'f'.repeat(64); }, 'CanaryPolicyScopeMismatch'],
    ['foreign repo', x => { x.snapshot.envelope.repository.name = 'other'; }, 'CanaryPolicyScopeMismatch'],
    ['wrong head', x => { x.snapshot.envelope.generation.headRevision = 'f'.repeat(40); }, 'CanaryPolicyScopeMismatch'],
    ['other actor', x => { x.pumpActorId = 456; }, 'CanaryPolicyScopeMismatch'],
    ['wrong epoch', x => { x.executorEpoch.runAttempt = 2; }, 'CanaryClaimMismatch'],
    ['not started', x => { x.snapshot.state = 'CLAIMED'; }, 'CanaryClaimMismatch'],
    ['terminal', x => { x.snapshot.terminal = {}; }, 'CanaryClaimMismatch'],
    ['expired', x => { x.observedAt = policy.validUntil; }, 'CanaryPolicyExpired'],
    ['not yet valid', x => { x.observedAt = '2026-09-05T20:59:59.999Z'; }, 'CanaryPolicyExpired'],
    ['same reviewers', x => { x.policy.reviewOwners.spec = x.policy.reviewOwners.standards; }, 'InvalidCanaryPolicy'],
    ['absent reviewers', x => { delete x.policy.reviewOwners; }, 'InvalidCanaryPolicy'],
    ['merge permission', x => { x.policy.allowedEffect = 'MERGE'; }, 'InvalidCanaryPolicy'],
    ['extra task', x => { x.policy.roundBudget = 2; }, 'InvalidCanaryPolicy'],
    ['unknown policy field', x => { x.policy.secret = 'not-logged'; }, 'InvalidCanaryPolicy'],
  ];
  for (const [name, mutate, code] of cases) {
    const value = input(); mutate(value);
    assert.throws(() => prepareCanaryManagedRound(value), { code }, name);
  }
});
