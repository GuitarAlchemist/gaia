import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  cancelDraft,
  createDraftOperationPorts,
  createGitDataDraftOperationStore,
  createMemoryDraftOperationStore,
  enqueueDraft,
  listUnsettledDrafts,
} from '../src/draft-operation-envelope.mjs';

const REGISTRY_REF = 'refs/heads/gaia-ledger/registry-v0';
const WORK_REF_PREFIX = 'refs/heads/gaia-ledger/draft-operations-v0/';
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

function observedEnvelope(number) {
  const repository = { nodeId: 'R_kgDTest', owner: 'GuitarAlchemist', name: 'gaia' };
  const workItem = { kind: 'ISSUE', number };
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
      baseRef: 'main', headRef: `codex/issue-${number}`,
      headRevision: OID_B, policyRevision: OID_A,
    },
    requestedEffect: 'CREATE_DRAFT',
  };
}

function selector(number) {
  return {
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    workItem: { kind: 'ISSUE', number },
  };
}

function operationPorts(store, overrides = {}) {
  return createDraftOperationPorts({
    collector: overrides.collector ?? {
      async collect(observedSelector) {
        return observedEnvelope(observedSelector.workItem.number);
      },
    },
    provider: overrides.provider ?? {
      async lookupExact() { return null; },
      async createDraft() { assert.fail('provider create is outside this test'); },
    },
    admission: overrides.admission ?? {
      async reserveEffect() { assert.fail('admission is outside this test'); },
    },
    executorEpoch: { runId: 7001, runAttempt: 1 },
    telemetry: overrides.telemetry ?? { async append() {} },
    store,
  });
}

function fakeGitData() {
  const registryRoot = {
    schema: 'GaiaDraftRegistryRootV0', priorCommittedRevision: 'NONE', kind: 'REGISTRY_ROOT',
  };
  const refs = new Map([[REGISTRY_REF, [{
    oid: OID_A, body: registryRoot, committedRevision: revision(registryRoot),
  }]]]);
  let nextOid = 3;
  let writes = 0;
  const port = Object.freeze({
    async verifyProtection() { return true; },
    async read(ref) {
      const records = refs.get(ref);
      return records
        ? { state: 'PRESENT', records: structuredClone(records) }
        : { state: 'UNSEEN' };
    },
    async readByOperation(operationId) {
      const matches = [...refs.values()].filter(
        (records) => records.some((record) => record.body.operationId === operationId),
      );
      if (matches.length === 0) return { state: 'UNSEEN' };
      assert.equal(matches.length, 1);
      return { state: 'PRESENT', records: structuredClone(matches[0]) };
    },
    async compareAndAppend(ref, expectedHeadOid, body, transportMetadata) {
      const records = refs.get(ref) ?? [];
      const current = records.at(-1)?.oid ?? 'NONE';
      if (current !== expectedHeadOid) return { kind: 'STALE', currentHeadOid: current };
      writes += 1;
      const record = {
        oid: (nextOid++).toString(16).padStart(40, '0'),
        body: structuredClone(body), committedRevision: revision(body),
      };
      if (transportMetadata !== undefined) {
        record.transportMetadata = structuredClone(transportMetadata);
      }
      refs.set(ref, [...records, record]);
      return { kind: 'APPENDED', ...structuredClone(record) };
    },
  });
  return {
    port,
    config: {
      ledgerRegistryRootOid: OID_A,
      ledgerRegistryRootRevision: revision(registryRoot),
    },
    get writes() { return writes; },
    corruptFirstWork() {
      const ref = [...refs.keys()].find((candidate) => candidate.startsWith(WORK_REF_PREFIX));
      refs.get(ref)[1].body.untrusted = true;
    },
  };
}

function inertListingPorts(store) {
  return operationPorts(store, {
    collector: { async collect() { assert.fail('listing cannot collect'); } },
    provider: {
      async lookupExact() { assert.fail('listing cannot contact provider'); },
      async createDraft() { assert.fail('listing cannot create'); },
    },
    admission: { async reserveEffect() { assert.fail('listing cannot reserve'); } },
    telemetry: { async append() { assert.fail('listing cannot emit telemetry'); } },
  });
}

async function exerciseProjection(kind) {
  const git = kind === 'GitData' ? fakeGitData() : null;
  const store = git
    ? createGitDataDraftOperationStore({ gitData: git.port, config: git.config })
    : createMemoryDraftOperationStore();
  const accepted = [];
  for (const number of [62, 60, 61]) {
    accepted.push(await enqueueDraft(selector(number), 'NONE', operationPorts(store)));
  }
  await cancelDraft(
    accepted[2].operationId,
    accepted[2].committedRevision,
    operationPorts(store),
  );
  const writesBeforeList = git?.writes;

  const projected = await listUnsettledDrafts(inertListingPorts(store));

  assert.equal(git?.writes, writesBeforeList);
  assert.ok(Object.isFrozen(projected));
  assert.equal(projected.length, 2);
  assert.deepEqual(projected.map(({ workKey }) => workKey),
    [...projected.map(({ workKey }) => workKey)].sort());
  assert.deepEqual(projected.map((item) => Object.keys(item).sort()), [
    ['committedRevision', 'operationId', 'selector', 'workKey'],
    ['committedRevision', 'operationId', 'selector', 'workKey'],
  ]);
  const expected = accepted.slice(0, 2)
    .map((item, index) => ({
      operationId: item.operationId,
      workKey: item.workKey,
      committedRevision: item.committedRevision,
      selector: selector([62, 60][index]),
    }))
    .sort((left, right) => left.workKey.localeCompare(right.workKey));
  assert.deepEqual(structuredClone(projected), expected);
  assert.equal(JSON.stringify(projected).includes('oid'), false);
  for (const item of projected) {
    assert.ok(Object.isFrozen(item));
    assert.ok(Object.isFrozen(item.selector));
    assert.ok(Object.isFrozen(item.selector.repository));
    assert.ok(Object.isFrozen(item.selector.workItem));
  }
}

test('unsettled Draft projection is closed, deterministic, read-only, and adapter-neutral', async () => {
  await exerciseProjection('Memory');
  await exerciseProjection('GitData');
});

test('unsettled Git Data projection fails closed on a corrupt durable chain', async () => {
  const git = fakeGitData();
  const store = createGitDataDraftOperationStore({ gitData: git.port, config: git.config });
  await enqueueDraft(selector(60), 'NONE', operationPorts(store));
  git.corruptFirstWork();

  await assert.rejects(
    listUnsettledDrafts(inertListingPorts(store)),
    (error) => error?.code === 'LedgerCorrupt',
  );
});
