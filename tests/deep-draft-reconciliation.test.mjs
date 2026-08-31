import assert from 'node:assert/strict';
import test from 'node:test';

const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const OID_A = '1'.repeat(40);
const OID_B = '2'.repeat(40);
const AT = '2026-08-31T23:30:00.000Z';

const load = () => import('../src/deep-draft-reconciliation.mjs');

const observation = (overrides = {}) => ({
  organization: 'GuitarAlchemist',
  repository: 'gaia',
  workItem: 'issue-56',
  readyItem: 'ready-56',
  baseBranch: 'main',
  baseOid: OID_A,
  headBranch: 'codex/deep-reconciliation-r0',
  headBranchGeneration: 'head-generation-1',
  evidenceHeadOid: OID_B,
  policyRevision: SHA256_A,
  reconciliationGeneration: 1,
  requestedEffect: 'CREATE_DRAFT',
  sourceRevision: SHA256_B,
  observedAt: AT,
  evaluatedAt: AT,
  cancelled: false,
  capacity: { provider: 1, ci: 1, lanes: 1 },
  ...overrides,
});

function provider(seed = [], {
  loseResponse = false, persistBeforeLoss = true, adoptExact = false,
} = {}) {
  const drafts = [...seed];
  const calls = { lookup: 0, create: 0 };
  return {
    calls,
    drafts,
    async lookupExact(request) {
      calls.lookup += 1;
      if (adoptExact) {
        return {
          number: 58, isDraft: true, state: 'OPEN',
          operationIdentity: request.operationIdentity,
        };
      }
      return drafts.find((draft) => draft.operationIdentity === request.operationIdentity) ?? null;
    },
    async createDraft(request) {
      calls.create += 1;
      const draft = {
        number: 58, isDraft: true, state: 'OPEN',
        operationIdentity: request.operationIdentity,
      };
      if (persistBeforeLoss) drafts.push(draft);
      if (loseResponse) {
        const error = new Error('provider response lost');
        error.code = 'AmbiguousProviderResponse';
        throw error;
      }
      if (!persistBeforeLoss) drafts.push(draft);
      return draft;
    },
  };
}

const silentTelemetry = () => ({ events: [], append(event) { this.events.push(event); } });

async function call(mod, obs, store, remote, expectedRevision = null, extra = {}) {
  const revision = expectedRevision ?? (await store.read()).revision;
  return mod.reconcileDraft(obs, revision, {
    store, provider: remote, telemetry: silentTelemetry(), ...extra,
  });
}

test('R0-01 old-generation intent is refused by a new policy/head generation', async () => {
  const mod = await load();
  const store = mod.createMemoryDraftReconciliationStore();
  const remote = provider([], { loseResponse: true, persistBeforeLoss: false });
  const first = await call(mod, observation(), store, remote);
  assert.equal(first.outcome, 'NEEDS_RECONCILIATION');
  const second = await call(mod, observation({
    policyRevision: 'c'.repeat(64), evidenceHeadOid: '3'.repeat(40),
    reconciliationGeneration: 2,
  }), store, remote);
  assert.deepEqual({ outcome: second.outcome, refusal: second.refusal }, {
    outcome: 'REFUSED', refusal: 'CrossGenerationIntent',
  });
  assert.equal(remote.calls.create, 1);
});

test('R0-02 a resumed stale owner performs no effect after a newer generation wins', async () => {
  const mod = await load();
  const inner = mod.createMemoryDraftReconciliationStore();
  let entered;
  const atIntent = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stalled = {
    read: (...args) => inner.read(...args),
    async compareAndSetAppend(expected, record) {
      const result = await inner.compareAndSetAppend(expected, record);
      if (record.kind === 'INTENT') { entered(); await gate; }
      return result;
    },
  };
  const remote = provider();
  const start = (await inner.read()).revision;
  const ownerA = call(mod, observation(), stalled, remote, start);
  await atIntent;
  const ownerB = await call(mod, observation({ reconciliationGeneration: 2 }), inner, remote);
  release();
  const resumedA = await ownerA;
  assert.equal(ownerB.outcome, 'CREATED');
  assert.deepEqual({ outcome: resumedA.outcome, refusal: resumedA.refusal }, {
    outcome: 'REFUSED', refusal: 'StaleOwner',
  });
  assert.equal(remote.calls.create, 1);
});

test('R0-03 a lost provider response reconciles without a blind retry', async () => {
  const mod = await load();
  const store = mod.createMemoryDraftReconciliationStore();
  const remote = provider([], { loseResponse: true });
  const result = await call(mod, observation(), store, remote);
  assert.equal(result.outcome, 'CREATED');
  assert.equal(remote.calls.create, 1);
  assert.ok(remote.calls.lookup >= 1);
});

test('R0-04 restart after durable intent ignores stale process memory', async () => {
  const mod = await load();
  const store = mod.createMemoryDraftReconciliationStore();
  const uncertain = provider([], { loseResponse: true, persistBeforeLoss: false });
  assert.equal((await call(mod, observation(), store, uncertain)).outcome,
    'NEEDS_RECONCILIATION');
  const identity = (await store.read()).records.at(-1).operationIdentity;
  const recovered = provider([{ number: 58, isDraft: true, state: 'OPEN', operationIdentity: identity }]);
  assert.equal((await call(mod, observation(), store, recovered)).outcome, 'SATISFIED');
  assert.equal(recovered.calls.create, 0);
});

test('R0-05 an existing exact Draft is adopted without an effect', async () => {
  const mod = await load();
  const store = mod.createMemoryDraftReconciliationStore();
  const remote = provider([], { adoptExact: true });
  assert.equal((await call(mod, observation(), store, remote)).outcome, 'SATISFIED');
  assert.equal(remote.calls.create, 0);
});

test('R0-06 exact adoption bypasses provider, CI, and lane capacity', async () => {
  const mod = await load();
  const store = mod.createMemoryDraftReconciliationStore();
  const obs = observation({ capacity: { provider: 0, ci: 0, lanes: 0 } });
  const remote = provider([], { adoptExact: true });
  assert.equal((await call(mod, obs, store, remote)).outcome, 'SATISFIED');
  assert.equal(remote.calls.create, 0);
});

test('R0-07 two actors reading one revision produce one CAS winner and one effect', async () => {
  const mod = await load();
  const store = mod.createMemoryDraftReconciliationStore();
  const remote = provider();
  const start = (await store.read()).revision;
  const results = await Promise.all([
    call(mod, observation(), store, remote, start),
    call(mod, observation(), store, remote, start),
  ]);
  assert.equal(results.filter((result) => result.outcome === 'CREATED').length, 1);
  assert.equal(results.filter((result) => result.outcome === 'REFUSED').length, 1);
  assert.equal(remote.calls.create, 1);
});

test('R0-08 duplicate, delayed, reordered, and replayed delivery converges', async () => {
  const mod = await load();
  const store = mod.createMemoryDraftReconciliationStore();
  const remote = provider();
  const start = (await store.read()).revision;
  const created = await call(mod, observation(), store, remote, start);
  const replay = await call(mod, observation(), store, remote, start);
  assert.equal(created.outcome, 'CREATED');
  assert.ok(['CREATED', 'REFUSED'].includes(replay.outcome));
  assert.equal(remote.calls.create, 1);
});

test('R0-09 future, corrupt, stale, and mismatched evidence is refused', async () => {
  const mod = await load();
  for (const obs of [
    observation({ observedAt: '2026-09-01T00:00:00.000Z' }),
    observation({ sourceRevision: 'not-a-revision' }),
    observation({ reconciliationGeneration: 0 }),
    observation({ requestedEffect: 'MERGE' }),
  ]) {
    const store = mod.createMemoryDraftReconciliationStore();
    const remote = provider();
    assert.equal((await call(mod, obs, store, remote)).outcome, 'REFUSED');
    assert.equal(remote.calls.create, 0);
  }
});

test('R0-10 cancellation racing completion is ordered by one durable revision', async () => {
  const mod = await load();
  const store = mod.createMemoryDraftReconciliationStore();
  const remote = provider();
  const cancelled = await call(mod, observation({ cancelled: true }), store, remote);
  assert.deepEqual({ outcome: cancelled.outcome, refusal: cancelled.refusal }, {
    outcome: 'REFUSED', refusal: 'Cancelled',
  });
  const resumed = await call(mod, observation(), store, remote);
  assert.equal(resumed.outcome, 'REFUSED');
  assert.equal(remote.calls.create, 0);
});

test('R0-11 projection, checklist, action, and source share the committed revision', async () => {
  const mod = await load();
  const store = mod.createMemoryDraftReconciliationStore();
  const result = await call(mod, observation(), store, provider());
  assert.equal(result.outcome, 'CREATED');
  assert.equal(result.actionRevision, result.stateRevision);
  assert.equal(result.checklistRevision, result.stateRevision);
  assert.equal(result.projectionRevision, result.stateRevision);
  assert.equal(result.sourceRevision, SHA256_B);
});
