import assert from 'node:assert/strict';
import test from 'node:test';
import { createNormalDraftAdmission, prepareNormalManagedRound,
  validateNormalAdmissionPolicy } from '../src/normal-admission-policy.mjs';
import { validateManagedDraftConfiguration } from '../src/pr-delivery-round-history.mjs';

// Synthetic identities exercise the contract; they are never activation material.
const policy = {
  schema: 'GaiaNormalAdmissionPolicyV0', version: 1,
  repository: { nodeId: 'R_test', owner: 'test-org', name: 'test-repo' },
  effectActorId: 123,
  validFrom: '2026-09-05T21:00:00.000Z', validUntil: '2026-09-05T22:00:00.000Z',
  accountableOwner: 'github:user:test-owner', effectOwner: 'github:app:test-pump',
  reviewOwners: { standards: 'github:user:test-standards', spec: 'github:user:test-spec' },
  allowedEffect: 'CREATE_DRAFT', roundBudget: 1,
};
const epoch = { runId: 50, runAttempt: 1 };
const snapshot = {
  identity: { operationId: 'a'.repeat(64), generationKey: 'b'.repeat(64), workKey: 'd'.repeat(64) },
  envelope: { repository: policy.repository, workItem: { kind: 'ISSUE', number: 40 },
    generation: { headRevision: 'c'.repeat(40) } },
  state: 'EFFECT_STARTED', committedRevision: 'e'.repeat(64), executorEpoch: epoch,
};
const input = () => ({ policy: structuredClone(policy), snapshot: structuredClone(snapshot),
  executorEpoch: { ...epoch }, pumpActorId: 123, observedAt: '2026-09-05T21:10:00.000Z' });

test('a normal policy admits any eligible operation in its declared repository, not one pinned issue', () => {
  const result = prepareNormalManagedRound(input());
  assert.doesNotThrow(() => validateManagedDraftConfiguration(result));
  assert.equal(result.receipt.schema, 'GaiaRoundReceiptV0');
  assert.equal(result.receipt.command.generation, snapshot.envelope.generation.headRevision);
  assert.equal(result.receipt.responsibility.supervisor, `gaia:operation:${snapshot.identity.operationId}`);
  assert.equal(result.receipt.roundBudget, 1);
  assert.deepEqual(result.receipt.responsibility.reviewOwners, policy.reviewOwners);
  assert.equal(result.effectClaim.leaseExpiresAt, '2026-09-05T21:15:00.000Z');

  const otherIssue = input();
  otherIssue.snapshot.identity = { operationId: 'f'.repeat(64), generationKey: '1'.repeat(64), workKey: '2'.repeat(64) };
  otherIssue.snapshot.envelope.workItem.number = 41;
  const otherResult = prepareNormalManagedRound(otherIssue);
  assert.doesNotThrow(() => validateManagedDraftConfiguration(otherResult));
  assert.notEqual(otherResult.receipt.revision, result.receipt.revision);

  const later = input(); later.observedAt = '2026-09-05T21:58:00.000Z';
  const replay = prepareNormalManagedRound(later);
  assert.deepEqual(replay.receipt, result.receipt);
  assert.equal(replay.effectClaim.leaseExpiresAt, policy.validUntil);
  assert.deepEqual(prepareNormalManagedRound(input()), result);
});

test('normal policy validation refuses a missing policy contract precisely', () => {
  assert.throws(() => validateNormalAdmissionPolicy(undefined), { code: 'InvalidNormalPolicy' });
  assert.throws(() => validateNormalAdmissionPolicy(null), { code: 'InvalidNormalPolicy' });
  assert.throws(() => validateNormalAdmissionPolicy({}), { code: 'InvalidNormalPolicy' });
});

test('normal admission preserves independent agent assignments without inventing approval', () => {
  const value = input();
  value.policy.schema = 'GaiaNormalAdmissionPolicyV1';
  value.policy.writerIdentity = 'gaia:agent:v1:codex:11111111-1111-4111-8111-111111111111:writer';
  value.policy.reviewOwners = {
    standards: 'gaia:agent:v1:claude:22222222-2222-4222-8222-222222222222:standards',
    spec: 'gaia:agent:v1:claude:33333333-3333-4333-8333-333333333333:spec',
  };
  const result = prepareNormalManagedRound(value);
  assert.equal(result.receipt.schema, 'GaiaRoundReceiptV1');
  assert.equal(result.receipt.responsibility.writerIdentity, value.policy.writerIdentity);
  assert.deepEqual(result.receipt.evidence.reviewVerdicts, ['UNKNOWN(NOT_REACHED)']);
  assert.doesNotThrow(() => validateManagedDraftConfiguration(result));
  value.policy.reviewOwners.spec = value.policy.writerIdentity.replace(':codex:', ':claude:');
  assert.throws(() => prepareNormalManagedRound(value), { code: 'InvalidNormalPolicy' });
});

test('a valid but different operation returned by the ledger causes zero reservation or effect', async () => {
  for (const change of [
    s => { s.identity.operationId = 'f'.repeat(64); },
    s => { s.identity.workKey = 'f'.repeat(64); },
    s => { s.identity.generationKey = 'f'.repeat(64); },
    s => { s.envelope.generation.headRevision = 'f'.repeat(40); },
    s => { s.envelope.workItem.number = 99; },
  ]) {
    const p = ports({ readOperation: async () => {
      const s = structuredClone(snapshot); change(s); return s;
    } });
    const admission = createNormalDraftAdmission({
      policy, snapshot: structuredClone(snapshot), pumpActorId: 123, executorEpoch: epoch, ...p,
    });
    await assert.rejects(() => admission.createDraft({}), { code: 'NormalClaimChanged' });
    assert.equal(p.calls.length, 0);
  }
});

test('normal policy requires an actual repository identity, not a coerced absent value', () => {
  const invalid = structuredClone(policy); invalid.repository.nodeId = undefined;
  assert.throws(() => validateNormalAdmissionPolicy(invalid), { code: 'InvalidNormalPolicy' });
});

test('normal producer refuses bad owner/reviewer configurations', () => {
  const cases = [
    ['same reviewers', x => { x.policy.reviewOwners.spec = x.policy.reviewOwners.standards; }, 'InvalidNormalPolicy'],
    ['absent reviewers', x => { delete x.policy.reviewOwners; }, 'InvalidNormalPolicy'],
    ['non-principal accountable owner', x => { x.policy.accountableOwner = 'not-a-principal'; }, 'InvalidNormalPolicy'],
    ['non-app effect owner', x => { x.policy.effectOwner = 'github:user:test-pump'; }, 'InvalidNormalPolicy'],
    ['merge permission', x => { x.policy.allowedEffect = 'MERGE'; }, 'InvalidNormalPolicy'],
    ['extra round budget', x => { x.policy.roundBudget = 2; }, 'InvalidNormalPolicy'],
    ['unknown policy field', x => { x.policy.secret = 'not-logged'; }, 'InvalidNormalPolicy'],
    ['issue field smuggled in (canary replay attempt)', x => { x.policy.issue = 40; }, 'InvalidNormalPolicy'],
  ];
  for (const [name, mutate, code] of cases) {
    const value = input(); mutate(value);
    assert.throws(() => prepareNormalManagedRound(value), { code }, name);
  }
});

test('normal producer refuses repository/operation/head/epoch mismatch and stale/expired/future time', () => {
  const cases = [
    ['foreign repo', x => { x.snapshot.envelope.repository.name = 'other'; }, 'NormalPolicyScopeMismatch'],
    ['other actor', x => { x.pumpActorId = 456; }, 'NormalPolicyScopeMismatch'],
    ['missing operation id', x => { x.snapshot.identity.operationId = undefined; }, 'NormalPolicyScopeMismatch'],
    ['missing head revision', x => { x.snapshot.envelope.generation.headRevision = undefined; }, 'NormalPolicyScopeMismatch'],
    ['not an issue', x => { x.snapshot.envelope.workItem.kind = 'PR'; }, 'NormalPolicyScopeMismatch'],
    ['wrong epoch', x => { x.executorEpoch.runAttempt = 2; }, 'NormalClaimMismatch'],
    ['not started', x => { x.snapshot.state = 'CLAIMED'; }, 'NormalClaimMismatch'],
    ['terminal', x => { x.snapshot.terminal = {}; }, 'NormalClaimMismatch'],
    ['expired (future)', x => { x.observedAt = policy.validUntil; }, 'NormalPolicyExpired'],
    ['not yet valid (stale)', x => { x.observedAt = '2026-09-05T20:59:59.999Z'; }, 'NormalPolicyExpired'],
  ];
  for (const [name, mutate, code] of cases) {
    const value = input(); mutate(value);
    assert.throws(() => prepareNormalManagedRound(value), { code }, name);
  }
});

function ports(overrides = {}) {
  const calls = [];
  return Object.freeze({
    calls,
    readPolicy: overrides.readPolicy ?? (async () => policy),
    readOperation: overrides.readOperation ?? (async () => structuredClone(snapshot)),
    reserveEffect: overrides.reserveEffect ?? (async (claim) => {
      calls.push(claim);
      return 'AVAILABLE';
    }),
    now: overrides.now ?? (() => '2026-09-05T21:10:00.000Z'),
    lookupExact: overrides.lookupExact ?? (async () => null),
    createDraft: overrides.createDraft ?? (async (request, managed) => {
      calls.push({ request, managed });
      return { kind: 'CREATED', managed };
    }),
  });
}

test('a valid normal generation passes the unchanged managed validator and creates exactly one effect', async () => {
  const p = ports();
  const admission = createNormalDraftAdmission({
    policy, snapshot: structuredClone(snapshot), pumpActorId: 123, executorEpoch: epoch, ...p,
  });
  const result = await admission.createDraft({ some: 'request' });
  assert.equal(result.kind, 'CREATED');
  assert.doesNotThrow(() => validateManagedDraftConfiguration(result.managed));
  assert.equal(p.calls.filter((call) => call.request !== undefined).length, 1);
});

test('normal admission performs no effect when the claim or policy changes between checks', async () => {
  let reserveCalls = 0;
  const changedClaim = createNormalDraftAdmission({
    policy, snapshot: structuredClone(snapshot), pumpActorId: 123, executorEpoch: epoch,
    ...ports({
      readOperation: async () => {
        reserveCalls += 1;
        const clone = structuredClone(snapshot);
        if (reserveCalls > 1) clone.committedRevision = 'f'.repeat(64);
        return clone;
      },
    }),
  });
  await assert.rejects(() => changedClaim.createDraft({}), { code: 'NormalClaimChanged' });

  const changedPolicy = createNormalDraftAdmission({
    policy, snapshot: structuredClone(snapshot), pumpActorId: 123, executorEpoch: epoch,
    ...ports({
      readPolicy: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          const clone = structuredClone(policy);
          if (calls > 1) clone.effectActorId = 999;
          return clone;
        };
      })(),
    }),
  });
  await assert.rejects(() => changedPolicy.createDraft({}), { code: 'NormalPolicyChanged' });

  const refused = createNormalDraftAdmission({
    policy, snapshot: structuredClone(snapshot), pumpActorId: 123, executorEpoch: epoch,
    ...ports({ reserveEffect: async () => 'ZERO' }),
  });
  await assert.rejects(() => refused.createDraft({}), { code: 'NormalAdmissionRefused' });
});

test('normal admission lookup/reuse performs no extra effect', async () => {
  const p = ports();
  const admission = createNormalDraftAdmission({
    policy, snapshot: structuredClone(snapshot), pumpActorId: 123, executorEpoch: epoch, ...p,
  });
  const found = await admission.lookupExact({ some: 'request' });
  assert.equal(found, null);
  assert.equal(p.calls.length, 0);
});

test('a missing normal policy is a distinct, explicit refusal, never a fixture fallback', () => {
  assert.throws(() => createNormalDraftAdmission({
    policy: undefined, snapshot: structuredClone(snapshot), pumpActorId: 123, executorEpoch: epoch, ...ports(),
  }), { code: 'InvalidNormalPolicy' });
});
