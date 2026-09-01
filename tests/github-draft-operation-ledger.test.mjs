import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createDraftOperationPorts,
  createGitDataDraftOperationStore,
  enqueueDraft,
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

function fakeGitData() {
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
      async verifyProtection() { return true; },
      async read(ref) {
        const records = refs.get(ref);
        if (!records) return { state: 'UNSEEN' };
        return { state: 'PRESENT', records: structuredClone(records) };
      },
      async compareAndAppend(ref, expectedHeadOid, body) {
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
  };
}

function ports(store, collector) {
  return createDraftOperationPorts({
    collector: { async collect() { return structuredClone(collector); } },
    provider: { async lookupExact() { return null; }, async createDraft() { return null; } },
    admission: { async reserveEffect() { return 'ZERO'; } },
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
