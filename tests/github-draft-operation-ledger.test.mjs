import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createDraftOperationPorts,
  createGitDataDraftOperationStore,
  enqueueDraft,
  reconcileDraft,
} from '../src/draft-operation-envelope.mjs';

const REGISTRY_REF = 'refs/heads/gaia-ledger/registry-v0';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const OID_A = '1'.repeat(40);
const OID_B = '2'.repeat(40);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
  ).join(',')}}`;
}

const revision = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

function observedEnvelope() {
  const repository = { nodeId: 'R_kgDTest', owner: 'GuitarAlchemist', name: 'gaia' };
  const workItem = { kind: 'ISSUE', number: 60 };
  const workKey = revision({
    schema: 'GaiaDraftWorkKeyV0', repositoryNodeId: repository.nodeId,
    workItem, requestedEffect: 'CREATE_DRAFT',
  });
  const readyItem = {
    schema: 'GaiaReadyItemIdentityV0', queueReceiptRevision: SHA_A, occurrence: 1,
    id: revision({
      schema: 'GaiaReadyItemIdV0', workKey, queueReceiptRevision: SHA_A,
      occurrence: 1, observedSourceRevision: SHA_B,
    }),
  };
  return {
    schema: 'GaiaDraftOperationEnvelopeV0', repository, workItem, readyItem,
    observedSourceRevision: SHA_B,
    generation: {
      baseRef: 'main', headRef: 'codex/hosted-draft-pump-r0',
      headRevision: OID_B, policyRevision: OID_A,
    },
    requestedEffect: 'CREATE_DRAFT',
  };
}

function fakeGitData({ failOnceOnKind = null, protectionSequence = [] } = {}) {
  const registryRoot = {
    schema: 'GaiaDraftRegistryRootV0', priorCommittedRevision: 'NONE', kind: 'REGISTRY_ROOT',
  };
  const refs = new Map([[REGISTRY_REF, [{
    oid: OID_A, body: registryRoot, committedRevision: revision(registryRoot),
  }]]]);
  let nextOid = 3;
  return {
    registryRootRevision: revision(registryRoot),
    port: Object.freeze({
      async verifyProtection() {
        return protectionSequence.length > 0 ? protectionSequence.shift() : true;
      },
      async read(ref) {
        const records = refs.get(ref);
        if (!records) return { state: 'UNSEEN' };
        return { state: 'PRESENT', records: structuredClone(records) };
      },
      async readByOperation(operationId) {
        const matches = [...refs.values()].filter(
          (records) => records.some((record) => record.body.operationId === operationId),
        );
        if (matches.length === 0) return { state: 'UNSEEN' };
        assert.equal(matches.length, 1, 'operation identity is unique across work refs');
        return { state: 'PRESENT', records: structuredClone(matches[0]) };
      },
      async compareAndAppend(ref, expectedHeadOid, body) {
        if (body.kind === failOnceOnKind) {
          failOnceOnKind = null;
          throw new Error('simulated process loss');
        }
        const records = refs.get(ref) ?? [];
        const current = records.at(-1)?.oid ?? 'NONE';
        if (current !== expectedHeadOid) return { kind: 'STALE', currentHeadOid: current };
        const oid = nextOid.toString(16).padStart(40, '0');
        nextOid += 1;
        const record = { oid, body: structuredClone(body), committedRevision: revision(body) };
        refs.set(ref, [...records, record]);
        return { kind: 'APPENDED', ...structuredClone(record) };
      },
    }),
    kinds(ref) { return (refs.get(ref) ?? []).map((record) => record.body.kind); },
    replaceRecordOid(ref, index, oid) {
      const records = refs.get(ref);
      assert.ok(records?.[index], 'record to replace exists');
      records[index] = { ...records[index], oid };
    },
  };
}

function ports(store, collector, overrides = {}) {
  return createDraftOperationPorts({
    collector: { async collect() { return structuredClone(collector); } },
    provider: overrides.provider
      ?? { async lookupExact() { return null; }, async createDraft() { return null; } },
    admission: overrides.admission ?? { async reserveEffect() { return 'ZERO'; } },
    executorEpoch: { runId: 6001, runAttempt: 1 },
    telemetry: { async append() {} },
    store,
  });
}

test('R2 durable enqueue survives restart and NONE cannot bootstrap it twice', async () => {
  assert.equal(typeof createGitDataDraftOperationStore, 'function');
  assert.equal(typeof createDraftOperationPorts, 'function');
  const git = fakeGitData();
  const config = {
    ledgerRegistryRootOid: OID_A,
    ledgerRegistryRootRevision: git.registryRootRevision,
  };
  const firstStore = createGitDataDraftOperationStore({ gitData: git.port, config });
  const selector = {
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    workItem: { kind: 'ISSUE', number: 60 },
  };

  const accepted = await enqueueDraft(
    selector, 'NONE', ports(firstStore, observedEnvelope()),
  );
  assert.equal(accepted.kind, 'Enqueued');

  const restarted = createGitDataDraftOperationStore({ gitData: git.port, config });
  const repeated = await enqueueDraft(selector, 'NONE', ports(restarted, observedEnvelope()));
  assert.equal(repeated.kind, 'StaleRevision');
  assert.equal(repeated.currentCommittedRevision, accepted.committedRevision);
  assert.deepEqual(git.kinds(REGISTRY_REF), ['REGISTRY_ROOT', 'RESERVED', 'CONFIRMED']);
  assert.deepEqual(
    git.kinds(`refs/heads/gaia-ledger/draft-operations-v0/${accepted.workKey}`),
    ['WORK_ROOT', 'ENQUEUED'],
  );
});

test('R3 work registration refuses an identical root body stored under a different Git OID', async () => {
  const git = fakeGitData();
  const config = {
    ledgerRegistryRootOid: OID_A,
    ledgerRegistryRootRevision: git.registryRootRevision,
  };
  const selector = {
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    workItem: { kind: 'ISSUE', number: 60 },
  };
  const store = createGitDataDraftOperationStore({ gitData: git.port, config });
  const accepted = await enqueueDraft(selector, 'NONE', ports(store, observedEnvelope()));
  const workRef = `refs/heads/gaia-ledger/draft-operations-v0/${accepted.workKey}`;

  git.replaceRecordOid(workRef, 0, OID_B);

  const restarted = createGitDataDraftOperationStore({ gitData: git.port, config });
  await assert.rejects(
    restarted.readHead(accepted.workKey),
    (error) => error?.code === 'LedgerCorrupt',
  );
});

test('R3 hosted reconciliation persists one CREATED effect and replays it after restart', async () => {
  const git = fakeGitData();
  const config = {
    ledgerRegistryRootOid: OID_A,
    ledgerRegistryRootRevision: git.registryRootRevision,
  };
  const envelope = observedEnvelope();
  const selector = {
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    workItem: { kind: 'ISSUE', number: 60 },
  };
  const store = createGitDataDraftOperationStore({ gitData: git.port, config });
  const accepted = await enqueueDraft(selector, 'NONE', ports(store, envelope));
  let lookups = 0;
  let creates = 0;
  const provider = {
    async lookupExact() { lookups += 1; return null; },
    async createDraft(request) {
      creates += 1;
      return {
        number: 61, url: 'https://github.com/GuitarAlchemist/gaia/pull/61',
        isDraft: true, state: 'OPEN', operationMarker: request.operationMarker,
        repository: structuredClone(request.repository),
        baseRef: request.baseRef, headRef: request.headRef, headRevision: request.headRevision,
      };
    },
  };
  const created = await reconcileDraft(
    accepted.operationId, accepted.committedRevision,
    ports(store, envelope, {
      provider, admission: { async reserveEffect() { return 'AVAILABLE'; } },
    }),
  );
  assert.equal(created.kind, 'Terminal');
  assert.equal(created.outcome, 'CREATED');
  assert.equal(lookups, 1);
  assert.equal(creates, 1);

  const restarted = createGitDataDraftOperationStore({ gitData: git.port, config });
  const replayed = await reconcileDraft(
    accepted.operationId, created.committedRevision,
    ports(restarted, envelope, {
      provider: {
        async lookupExact() { assert.fail('terminal replay must not contact the provider'); },
        async createDraft() { assert.fail('terminal replay must not create'); },
      },
      admission: { async reserveEffect() { assert.fail('terminal replay needs no capacity'); } },
    }),
  );
  assert.deepEqual(replayed, created);
  assert.deepEqual(
    git.kinds(`refs/heads/gaia-ledger/draft-operations-v0/${accepted.workKey}`),
    ['WORK_ROOT', 'ENQUEUED', 'CLAIMED', 'INTENT', 'EFFECT_STARTED', 'CREATED'],
  );
});

test('R2 restart resumes every deterministic bootstrap crash boundary', async () => {
  for (const failOnceOnKind of ['WORK_ROOT', 'CONFIRMED', 'ENQUEUED']) {
    const git = fakeGitData({ failOnceOnKind });
    const config = {
      ledgerRegistryRootOid: OID_A,
      ledgerRegistryRootRevision: git.registryRootRevision,
    };
    const selector = {
      repository: { owner: 'GuitarAlchemist', name: 'gaia' },
      workItem: { kind: 'ISSUE', number: 60 },
    };
    const first = createGitDataDraftOperationStore({ gitData: git.port, config });
    await assert.rejects(enqueueDraft(selector, 'NONE', ports(first, observedEnvelope())));

    const restarted = createGitDataDraftOperationStore({ gitData: git.port, config });
    const accepted = await enqueueDraft(
      selector, 'NONE', ports(restarted, observedEnvelope()),
    );
    assert.equal(accepted.kind, 'Enqueued', failOnceOnKind);
    assert.deepEqual(
      git.kinds(REGISTRY_REF), ['REGISTRY_ROOT', 'RESERVED', 'CONFIRMED'], failOnceOnKind,
    );
    assert.deepEqual(
      git.kinds(`refs/heads/gaia-ledger/draft-operations-v0/${accepted.workKey}`),
      ['WORK_ROOT', 'ENQUEUED'], failOnceOnKind,
    );
  }
});

test('R3 ambiguous create is never retried and exact observation settles it after restart', async () => {
  const git = fakeGitData();
  const config = {
    ledgerRegistryRootOid: OID_A,
    ledgerRegistryRootRevision: git.registryRootRevision,
  };
  const envelope = observedEnvelope();
  const selector = {
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    workItem: { kind: 'ISSUE', number: 60 },
  };
  const store = createGitDataDraftOperationStore({ gitData: git.port, config });
  const accepted = await enqueueDraft(selector, 'NONE', ports(store, envelope));
  let creates = 0;
  const ambiguous = await reconcileDraft(
    accepted.operationId, accepted.committedRevision,
    ports(store, envelope, {
      provider: {
        async lookupExact() { return null; },
        async createDraft() { creates += 1; throw new Error('response lost'); },
      },
      admission: { async reserveEffect() { return 'AVAILABLE'; } },
    }),
  );
  assert.equal(ambiguous.kind, 'Pending');
  assert.equal(ambiguous.state, 'EFFECT_AMBIGUOUS');

  const restarted = createGitDataDraftOperationStore({ gitData: git.port, config });
  const reused = await reconcileDraft(
    accepted.operationId, ambiguous.committedRevision,
    ports(restarted, envelope, {
      provider: {
        async lookupExact(request) {
          return {
            number: 61, url: 'https://github.com/GuitarAlchemist/gaia/pull/61',
            isDraft: true, state: 'OPEN', operationMarker: request.operationMarker,
            repository: structuredClone(request.repository),
            baseRef: request.baseRef, headRef: request.headRef,
            headRevision: request.headRevision,
          };
        },
        async createDraft() { assert.fail('ambiguous effects are lookup-only'); },
      },
      admission: { async reserveEffect() { assert.fail('reuse needs no capacity'); } },
    }),
  );
  assert.equal(reused.outcome, 'REUSED');
  assert.equal(creates, 1);
});

test('R3 protection loss refuses the next ledger write before any Draft effect', async () => {
  const git = fakeGitData({ protectionSequence: [true, true, true, true, false] });
  const config = {
    ledgerRegistryRootOid: OID_A,
    ledgerRegistryRootRevision: git.registryRootRevision,
  };
  const envelope = observedEnvelope();
  const selector = {
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    workItem: { kind: 'ISSUE', number: 60 },
  };
  const store = createGitDataDraftOperationStore({ gitData: git.port, config });
  const accepted = await enqueueDraft(selector, 'NONE', ports(store, envelope));
  let creates = 0;
  await assert.rejects(
    reconcileDraft(
      accepted.operationId, accepted.committedRevision,
      ports(store, envelope, {
        provider: {
          async lookupExact() { return null; },
          async createDraft() { creates += 1; return null; },
        },
        admission: { async reserveEffect() { return 'AVAILABLE'; } },
      }),
    ),
    (error) => error?.code === 'LedgerProtectionMissing',
  );
  assert.equal(creates, 0);
  assert.deepEqual(
    git.kinds(`refs/heads/gaia-ledger/draft-operations-v0/${accepted.workKey}`),
    ['WORK_ROOT', 'ENQUEUED'],
  );
});
