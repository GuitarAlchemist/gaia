/**
 * Operator re-admission of an effect-free refusal (Gaia issue #167, docs/hosted-draft-intake.md).
 *
 * Every scenario runs against the memory store and against a fake Git Data API implementing the
 * real ref/commit protocol, because the successor chain is a storage change and both stores own it.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  cancelDraft,
  createDraftOperationPorts,
  createGitDataDraftOperationStore,
  createMemoryDraftOperationStore,
  enqueueDraft,
  guardDraftCreation,
  listUnsettledDrafts,
  readmitDraft,
  reconcileDraft,
} from '../src/draft-operation-envelope.mjs';

const REGISTRY_REF = 'refs/heads/gaia-ledger/registry-v0';
const WORK_PREFIX = 'refs/heads/gaia-ledger/draft-operations-v0/';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const OID_A = '1'.repeat(40);
const OID_B = '2'.repeat(40);
const SELECTOR = {
  repository: { owner: 'GuitarAlchemist', name: 'gaia' },
  workItem: { kind: 'ISSUE', number: 93 },
};
const PROVENANCE = Object.freeze({
  reason: 'Admission window expired before #166; the create call never ran (NOT_INVOKED).',
  runId: 7001, runAttempt: 1, triggeringActor: 'spareilleux',
});

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
  ).join(',')}}`;
}

const sha256 = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

const REPOSITORY = { nodeId: 'R_kgDOReadmit', owner: 'GuitarAlchemist', name: 'gaia' };
const WORK_KEY = sha256({
  schema: 'GaiaDraftWorkKeyV0', repositoryNodeId: REPOSITORY.nodeId,
  workItem: SELECTOR.workItem, requestedEffect: 'CREATE_DRAFT',
});

/** One ready event of issue #93; each occurrence is a distinct generation. */
function readyEvent(occurrence) {
  const readyItem = {
    schema: 'GaiaReadyItemIdentityV0', queueReceiptRevision: SHA_A, occurrence,
    id: sha256({
      schema: 'GaiaReadyItemIdV0', workKey: WORK_KEY, queueReceiptRevision: SHA_A,
      occurrence, observedSourceRevision: SHA_B,
    }),
  };
  return {
    schema: 'GaiaDraftOperationEnvelopeV0', repository: REPOSITORY,
    workItem: SELECTOR.workItem, readyItem, observedSourceRevision: SHA_B,
    generation: {
      baseRef: 'main', headRef: `gaia/issue-93-ready-${occurrence}`,
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
    oid: OID_A, body: registryRoot, committedRevision: sha256(registryRoot),
  }]]]);
  let nextOid = 3;
  let failOnce = null;
  let writes = 0;
  return {
    registryRootRevision: sha256(registryRoot),
    port: Object.freeze({
      async verifyProtection() { return true; },
      async read(ref) {
        const records = refs.get(ref);
        return records ? { state: 'PRESENT', records: structuredClone(records) }
          : { state: 'UNSEEN' };
      },
      async readByOperation(operationId) {
        const matches = [...refs.values()].filter(
          (records) => records.some((record) => record.body.operationId === operationId),
        );
        if (matches.length === 0) return { state: 'UNSEEN' };
        assert.equal(matches.length, 1, 'operation identity is unique across work refs');
        return { state: 'PRESENT', records: structuredClone(matches[0]) };
      },
      async compareAndAppend(ref, expectedHeadOid, body, transportMetadata) {
        if (failOnce && failOnce(ref, body)) {
          failOnce = null;
          throw new Error('simulated process loss');
        }
        const records = refs.get(ref) ?? [];
        const current = records.at(-1)?.oid ?? 'NONE';
        if (current !== expectedHeadOid) return { kind: 'STALE', currentHeadOid: current };
        const oid = nextOid.toString(16).padStart(40, '0');
        nextOid += 1;
        writes += 1;
        const record = { oid, body: structuredClone(body), committedRevision: sha256(body) };
        if (transportMetadata !== undefined) {
          record.transportMetadata = structuredClone(transportMetadata);
        }
        refs.set(ref, [...records, record]);
        return { kind: 'APPENDED', ...structuredClone(record) };
      },
    }),
    failNext(predicate) { failOnce = predicate; },
    writes: () => writes,
    kinds: (ref) => (refs.get(ref) ?? []).map((record) => record.body.kind),
    records: (ref) => structuredClone(refs.get(ref) ?? []),
    replace(ref, records) { refs.set(ref, structuredClone(records)); },
  };
}

const STORES = [
  ['memory', () => ({ store: createMemoryDraftOperationStore(), git: null })],
  ['git data', () => {
    const git = fakeGitData();
    const config = {
      ledgerRegistryRootOid: OID_A, ledgerRegistryRootRevision: git.registryRootRevision,
    };
    return {
      git, config,
      store: createGitDataDraftOperationStore({ gitData: git.port, config }),
    };
  }],
];

function exactDraft(request) {
  return {
    number: 193, url: 'https://github.test/GuitarAlchemist/gaia/pull/193', isDraft: true,
    state: 'OPEN', operationMarker: request.operationMarker, repository: request.repository,
    baseRef: request.baseRef, headRef: request.headRef, headRevision: request.headRevision,
  };
}

const PROVIDERS = {
  expired: () => ({
    async lookupExact() { return null; },
    createDraft: guardDraftCreation({
      prepare: async () => {
        throw Object.assign(new Error('expired'), { code: 'NormalPolicyExpired' });
      },
      invoke: async () => assert.fail('the create call must not run'),
    }),
  }),
  unavailable: () => ({
    async lookupExact() { throw new Error('lookup transport failed'); },
    async createDraft() { assert.fail('the create call must not run'); },
  }),
  creates: (log = []) => ({
    async lookupExact() { return null; },
    async createDraft(request) { log.push(request.operationMarker); return exactDraft(request); },
  }),
  ambiguous: () => ({
    async lookupExact() { return null; },
    async createDraft() { throw new Error('response lost'); },
  }),
  reuses: () => ({
    async lookupExact(request) { return exactDraft(request); },
    async createDraft() { assert.fail('an adopted Draft is never created again'); },
  }),
};

function portsFor(store, envelope, provider = PROVIDERS.creates()) {
  return createDraftOperationPorts({
    collector: { async collect() { return structuredClone(envelope); } },
    provider,
    admission: { async reserveEffect() { return 'AVAILABLE'; } },
    executorEpoch: { runId: 7101, runAttempt: 1 },
    telemetry: { async append() {} },
    store,
  });
}

const enqueue = (store, occurrence) => enqueueDraft(
  SELECTOR, 'NONE', portsFor(store, readyEvent(occurrence)),
);

async function settle(store, occurrence, provider) {
  const accepted = await enqueue(store, occurrence);
  assert.equal(accepted.kind, 'Enqueued', `occurrence ${occurrence} enqueues`);
  const result = await reconcileDraft(
    accepted.operationId, accepted.committedRevision,
    portsFor(store, readyEvent(occurrence), provider),
  );
  return { accepted, result };
}

const successorKey = (predecessorAdmissionKey, predecessorTerminalRevision) => sha256({
  schema: 'GaiaDraftSuccessorAdmissionKeyV0',
  predecessorAdmissionKey, predecessorTerminalRevision,
});

test('an effect-free refusal is re-admitted only by an explicit apply, for a new generation', async () => {
  for (const [name, make] of STORES) {
    const { store, git } = make();
    const { accepted, result: refused } = await settle(store, 1, PROVIDERS.expired());
    assert.equal(refused.outcome, 'REFUSED', name);
    assert.equal(refused.refusal, 'BeforeProvider:NormalPolicyExpired', name);
    assert.equal((await enqueue(store, 2)).kind, 'StaleRevision', `${name}: barred before readmission`);

    const writesBefore = git?.writes();
    const planned = await readmitDraft(
      accepted.operationId, refused.committedRevision, PROVENANCE, { store },
    );
    const admissionKey = successorKey(WORK_KEY, refused.committedRevision);
    assert.deepEqual(planned, {
      kind: 'ReadmissionPlanned', operationId: accepted.operationId, workKey: WORK_KEY,
      refusal: 'BeforeProvider:NormalPolicyExpired',
      committedRevision: refused.committedRevision, admissionKey,
    }, name);
    if (git) assert.equal(git.writes(), writesBefore, 'a dry run writes nothing');
    assert.equal((await enqueue(store, 2)).kind, 'StaleRevision', `${name}: a dry run admits nothing`);

    const applied = await readmitDraft(
      accepted.operationId, refused.committedRevision, PROVENANCE, { store }, { apply: true },
    );
    assert.equal(applied.kind, 'Readmitted', name);
    assert.equal(applied.admissionKey, admissionKey, name);
    assert.match(applied.successorRootRevision, /^[a-f0-9]{64}$/u);

    assert.equal((await enqueue(store, 1)).kind, 'StaleRevision', `${name}: the refused generation is spent`);
    const log = [];
    const { accepted: second, result: created } = await settle(store, 2, PROVIDERS.creates(log));
    assert.equal(second.workKey, WORK_KEY, `${name}: the successor keeps the issue's work key`);
    assert.equal(second.operationId, sha256({
      schema: 'GaiaDraftOperationIdV0', workKey: WORK_KEY, generationKey: second.generationKey,
    }), `${name}: operation identity derives exactly as for a first admission`);
    assert.notEqual(second.operationId, accepted.operationId);
    assert.equal(created.outcome, 'CREATED', name);
    assert.deepEqual(log, [second.operationId], `${name}: one create, carrying the new marker`);

    assert.equal((await enqueue(store, 3)).kind, 'StaleRevision', `${name}: a created chain ends the line`);
    const again = await readmitDraft(
      accepted.operationId, refused.committedRevision, PROVENANCE, { store }, { apply: true },
    );
    assert.equal(again.kind, 'AlreadyReadmitted', `${name}: one successor per refusal`);

    if (git) {
      assert.deepEqual(git.kinds(REGISTRY_REF),
        ['REGISTRY_ROOT', 'RESERVED', 'CONFIRMED', 'RESERVED', 'CONFIRMED']);
      assert.deepEqual(git.kinds(`${WORK_PREFIX}${WORK_KEY}`),
        ['WORK_ROOT', 'ENQUEUED', 'CLAIMED', 'INTENT', 'EFFECT_STARTED', 'REFUSED'],
        'the refused chain is never appended to');
      const [root] = git.records(`${WORK_PREFIX}${admissionKey}`);
      assert.deepEqual(root.body, {
        schema: 'GaiaDraftWorkRootV1', priorCommittedRevision: 'NONE', kind: 'WORK_ROOT',
        workKey: WORK_KEY, admissionKey,
        predecessor: {
          admissionKey: WORK_KEY, operationId: accepted.operationId,
          terminalCommittedRevision: refused.committedRevision,
          refusal: 'BeforeProvider:NormalPolicyExpired',
        },
        spentGenerationKeys: [accepted.generationKey],
        readmission: { ...PROVENANCE },
      });
    }
  }
});

test('a refusal from before the effect boundary is re-admissible whatever its code', async () => {
  for (const [name, make] of STORES) {
    const { store } = make();
    const { accepted, result } = await settle(store, 1, PROVIDERS.unavailable());
    assert.equal(result.refusal, 'ProviderUnavailable', name);
    const applied = await readmitDraft(
      accepted.operationId, result.committedRevision, PROVENANCE, { store }, { apply: true },
    );
    assert.equal(applied.kind, 'Readmitted', name);
    assert.equal((await enqueue(store, 2)).kind, 'Enqueued', name);
  }
});

test('a chain that created, adopted, cancelled, is ambiguous or is unsettled is never re-admitted', async () => {
  for (const [name, make] of STORES) {
    const cases = [
      ['CREATED', PROVIDERS.creates()],
      ['REUSED', PROVIDERS.reuses()],
      ['EFFECT_AMBIGUOUS', PROVIDERS.ambiguous()],
      ['CANCELLED', null],
      ['ENQUEUED', null],
    ];
    for (const [expected, provider] of cases) {
      const { store, git } = make();
      let operationId;
      let committedRevision;
      if (provider) {
        const settled = await settle(store, 1, provider);
        operationId = settled.accepted.operationId;
        committedRevision = settled.result.committedRevision;
      } else {
        const accepted = await enqueue(store, 1);
        operationId = accepted.operationId;
        committedRevision = accepted.committedRevision;
        if (expected === 'CANCELLED') {
          committedRevision = (await cancelDraft(
            operationId, committedRevision, portsFor(store, readyEvent(1)),
          )).committedRevision;
        }
      }
      const writesBefore = git?.writes();
      const refused = await readmitDraft(
        operationId, committedRevision, PROVENANCE, { store }, { apply: true },
      );
      assert.equal(refused.kind, 'NotReadmissible', `${name}: ${expected}`);
      assert.equal(refused.state, expected, `${name}: ${expected}`);
      if (git) assert.equal(git.writes(), writesBefore, `${name}: ${expected} writes nothing`);
      assert.equal((await enqueue(store, 2)).kind, 'StaleRevision', `${name}: ${expected} stays barred`);
    }
  }
});

test('a stale revision, an unknown operation or malformed provenance is refused before any write', async () => {
  for (const [name, make] of STORES) {
    const { store, git } = make();
    const { accepted, result } = await settle(store, 1, PROVIDERS.expired());
    const writesBefore = git?.writes();
    const stale = await readmitDraft(
      accepted.operationId, accepted.committedRevision, PROVENANCE, { store }, { apply: true },
    );
    assert.deepEqual(stale, {
      kind: 'StaleRevision', currentCommittedRevision: result.committedRevision,
    }, name);
    await assert.rejects(
      readmitDraft(SHA_A, result.committedRevision, PROVENANCE, { store }, { apply: true }),
      { code: 'UnknownOperation' },
    );
    for (const provenance of [
      { ...PROVENANCE, reason: '' },
      { ...PROVENANCE, reason: ' padded' },
      { ...PROVENANCE, reason: 'x'.repeat(501) },
      { ...PROVENANCE, reason: 'two\nlines' },
      { ...PROVENANCE, runId: 0 },
      { ...PROVENANCE, runAttempt: 1.5 },
      { ...PROVENANCE, triggeringActor: 'not a login' },
      { ...PROVENANCE, extra: true },
      { reason: PROVENANCE.reason, runId: 1, runAttempt: 1 },
    ]) {
      await assert.rejects(
        readmitDraft(accepted.operationId, result.committedRevision, provenance, { store },
          { apply: true }),
        { code: 'InvalidReadmission' }, `${name}: ${JSON.stringify(provenance).slice(0, 60)}`,
      );
    }
    await assert.rejects(
      readmitDraft(accepted.operationId, result.committedRevision, PROVENANCE, { store },
        { apply: 'yes' }),
      { code: 'InvalidReadmission' },
    );
    if (git) assert.equal(git.writes(), writesBefore, `${name}: refusals write nothing`);
  }
});

test('a successor refused again extends the line and never forks it', async () => {
  for (const [name, make] of STORES) {
    const { store, git } = make();
    const first = await settle(store, 1, PROVIDERS.expired());
    await readmitDraft(first.accepted.operationId, first.result.committedRevision, PROVENANCE,
      { store }, { apply: true });
    const second = await settle(store, 2, PROVIDERS.expired());
    assert.equal(second.result.outcome, 'REFUSED', name);
    assert.equal((await enqueue(store, 3)).kind, 'StaleRevision', `${name}: barred again`);

    const secondKey = successorKey(WORK_KEY, first.result.committedRevision);
    const applied = await readmitDraft(second.accepted.operationId, second.result.committedRevision,
      { ...PROVENANCE, runId: 7002 }, { store }, { apply: true });
    assert.equal(applied.admissionKey, successorKey(secondKey, second.result.committedRevision), name);
    for (const spent of [1, 2]) {
      assert.equal((await enqueue(store, spent)).kind, 'StaleRevision', `${name}: ${spent} is spent`);
    }
    const third = await enqueue(store, 3);
    assert.equal(third.kind, 'Enqueued', name);

    const unsettled = await listUnsettledDrafts({ store });
    assert.deepEqual(unsettled.map((item) => [item.operationId, item.workKey]),
      [[third.operationId, WORK_KEY]], `${name}: only the open successor is unsettled`);
    if (git) {
      const [root] = git.records(`${WORK_PREFIX}${applied.admissionKey}`);
      assert.deepEqual(root.body.spentGenerationKeys,
        [first.accepted.generationKey, second.accepted.generationKey]);
      assert.equal(root.body.readmission.runId, 7002);
    }
  }
});

test('successor chains survive a restart and resolve by operation identity', async () => {
  const [, make] = STORES[1];
  const { store, git, config } = make();
  const first = await settle(store, 1, PROVIDERS.expired());
  await readmitDraft(first.accepted.operationId, first.result.committedRevision, PROVENANCE,
    { store }, { apply: true });
  const accepted = await enqueue(store, 2);

  const restarted = createGitDataDraftOperationStore({ gitData: git.port, config });
  const snapshot = await restarted.inspectByOperation(accepted.operationId);
  assert.equal(snapshot.identity.workKey, WORK_KEY);
  assert.equal(snapshot.admission.key, successorKey(WORK_KEY, first.result.committedRevision));
  assert.deepEqual(snapshot.admission.spentGenerationKeys, [first.accepted.generationKey]);
  const created = await reconcileDraft(accepted.operationId, accepted.committedRevision,
    portsFor(restarted, readyEvent(2)));
  assert.equal(created.outcome, 'CREATED');
  const old = await restarted.inspectByOperation(first.accepted.operationId);
  assert.equal(old.terminal.outcome, 'REFUSED', 'the refused chain still reads as refused');
});

test('an interrupted re-admission resumes on the next apply and admits nothing meanwhile', async () => {
  const [, make] = STORES[1];
  for (const lostKind of ['RESERVED', 'WORK_ROOT', 'CONFIRMED']) {
    const { store, git } = make();
    const first = await settle(store, 1, PROVIDERS.expired());
    const admissionKey = successorKey(WORK_KEY, first.result.committedRevision);
    git.failNext((ref, body) => body.kind === lostKind
      && (ref === REGISTRY_REF ? body.admissionKey === admissionKey
        : ref === `${WORK_PREFIX}${admissionKey}`));
    await assert.rejects(readmitDraft(first.accepted.operationId, first.result.committedRevision,
      PROVENANCE, { store }, { apply: true }), undefined, lostKind);
    assert.equal((await enqueue(store, 2)).kind, 'StaleRevision', `${lostKind}: nothing admitted`);
    const resumed = await readmitDraft(first.accepted.operationId, first.result.committedRevision,
      { ...PROVENANCE, runAttempt: 2 }, { store }, { apply: true });
    assert.equal(resumed.kind, 'Readmitted', lostKind);
    assert.equal((await enqueue(store, 2)).kind, 'Enqueued', lostKind);
  }
});

test('a successor chain that reuses a spent generation, or a forged successor key, fails closed', async () => {
  const [, make] = STORES[1];
  const { store, git } = make();
  const first = await settle(store, 1, PROVIDERS.expired());
  await readmitDraft(first.accepted.operationId, first.result.committedRevision, PROVENANCE,
    { store }, { apply: true });
  const accepted = await enqueue(store, 2);
  const admissionKey = successorKey(WORK_KEY, first.result.committedRevision);
  const ref = `${WORK_PREFIX}${admissionKey}`;
  const pristine = git.records(ref);

  const spent = structuredClone(pristine);
  spent[0].body.spentGenerationKeys = [first.accepted.generationKey, accepted.generationKey];
  spent[0].committedRevision = sha256(spent[0].body);
  spent[1].body.priorCommittedRevision = spent[0].committedRevision;
  spent[1].committedRevision = sha256(spent[1].body);
  git.replace(ref, spent);
  await assert.rejects(store.inspectByOperation(accepted.operationId), { code: 'LedgerCorrupt' });

  const forged = structuredClone(pristine);
  forged[0].body.predecessor.terminalCommittedRevision = SHA_A;
  forged[0].committedRevision = sha256(forged[0].body);
  forged[1].body.priorCommittedRevision = forged[0].committedRevision;
  forged[1].committedRevision = sha256(forged[1].body);
  git.replace(ref, forged);
  await assert.rejects(store.inspectByOperation(accepted.operationId), { code: 'LedgerCorrupt' });
});
