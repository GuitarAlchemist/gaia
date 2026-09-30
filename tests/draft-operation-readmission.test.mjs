/**
 * Operator re-admission of an effect-free refusal (Gaia issue #167, docs/hosted-draft-intake.md),
 * and the shared-registry contention every admission line meets.
 *
 * Every scenario runs against the memory store and against a fake Git Data API implementing the
 * real ref/commit protocol, because the successor chain is a storage change and both stores own it.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  admissionRetryPauseMs,
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
  let beforeRead = null;
  let contention = null;
  let writes = 0;
  let rivals = 0;
  return {
    registryRootRevision: sha256(registryRoot),
    port: Object.freeze({
      async verifyProtection() { return true; },
      async read(ref) {
        if (beforeRead && beforeRead.ref === ref) {
          const { action } = beforeRead;
          beforeRead = null;
          await action();
        }
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
        if (contention && contention.times > 0 && contention.predicate(ref, body)) {
          // Another admission lands on the shared registry first.
          contention.times -= 1;
          const head = refs.get(REGISTRY_REF).at(-1);
          rivals += 1;
          const rival = {
            schema: 'GaiaDraftRegistryReceiptV0', priorCommittedRevision: head.committedRevision,
            kind: 'RESERVED', workKey: sha256({ rival: rivals }),
          };
          refs.set(REGISTRY_REF, [...refs.get(REGISTRY_REF), {
            oid: (nextOid++).toString(16).padStart(40, '0'), body: rival,
            committedRevision: sha256(rival),
          }]);
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
    contend(predicate, times) { contention = { predicate, times }; },
    beforeReading(ref, action) { beforeRead = { ref, action }; },
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

// The pause between admission attempts is recorded, never waited: no test depends on elapsed time.
function pauses() {
  const waited = [];
  return { waited, async pause(milliseconds) { waited.push(milliseconds); } };
}

function portsFor(store, envelope, provider = PROVIDERS.creates(), pause = pauses().pause) {
  return createDraftOperationPorts({
    collector: { async collect() { return structuredClone(envelope); } },
    provider,
    admission: { async reserveEffect() { return 'AVAILABLE'; } },
    executorEpoch: { runId: 7101, runAttempt: 1 },
    telemetry: { async append() {} },
    store,
    pause,
  });
}

const enqueue = (store, occurrence, pause) => enqueueDraft(
  SELECTOR, 'NONE', portsFor(store, readyEvent(occurrence), undefined, pause),
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

test('a successor that reuses a spent generation, forges its key or misnames its predecessor fails closed', async () => {
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

  const misnamed = structuredClone(pristine);
  misnamed[0].body.predecessor.operationId = SHA_A;
  misnamed[0].committedRevision = sha256(misnamed[0].body);
  misnamed[1].body.priorCommittedRevision = misnamed[0].committedRevision;
  misnamed[1].committedRevision = sha256(misnamed[1].body);
  // The registry is re-confirmed on the forged root, so only the root's own content can refuse it.
  const registry = git.records(REGISTRY_REF);
  const confirmed = structuredClone(registry);
  assert.equal(confirmed.at(-1).body.admissionKey, admissionKey);
  confirmed.at(-1).body.bootstrapCommittedRevision = misnamed[0].committedRevision;
  confirmed.at(-1).committedRevision = sha256(confirmed.at(-1).body);
  git.replace(REGISTRY_REF, confirmed);
  git.replace(ref, misnamed);
  await assert.rejects(store.inspectByOperation(accepted.operationId), { code: 'LedgerCorrupt' });

  git.replace(REGISTRY_REF, registry);
  git.replace(ref, pristine);
  assert.equal((await store.inspectByOperation(accepted.operationId)).state, 'ENQUEUED',
    'the pristine chain still reads: each rejection above is the forgery, not the fixture');
});

test('readHead follows the line to the successor that holds an operation', async () => {
  for (const [name, make] of STORES) {
    const { store } = make();
    const first = await settle(store, 1, PROVIDERS.expired());
    const refusedHead = {
      state: 'PRESENT', committedRevision: first.result.committedRevision, recordKind: 'REFUSED',
    };
    assert.deepEqual(await store.readHead(WORK_KEY), refusedHead, name);
    await readmitDraft(first.accepted.operationId, first.result.committedRevision, PROVENANCE,
      { store }, { apply: true });
    assert.deepEqual(await store.readHead(WORK_KEY), refusedHead,
      `${name}: an open successor holds no operation yet`);
    const second = await enqueue(store, 2);
    assert.deepEqual(await store.readHead(WORK_KEY), {
      state: 'PRESENT', committedRevision: second.committedRevision, recordKind: 'ENQUEUED',
    }, `${name}: the head is the successor's operation`);
  }
});

test('a re-admission is reported once, and intake never enqueues on it at a supplied revision', async () => {
  for (const [name, make] of STORES) {
    const { store } = make();
    const first = await settle(store, 1, PROVIDERS.expired());
    const events = [];
    const ports = { store, telemetry: { async append(event) { events.push(event); } } };
    const readmit = (options) => readmitDraft(
      first.accepted.operationId, first.result.committedRevision, PROVENANCE, ports, options,
    );
    assert.equal((await readmit()).kind, 'ReadmissionPlanned', name);
    assert.deepEqual(events, [], `${name}: a dry run reports nothing`);
    const applied = await readmit({ apply: true });
    assert.deepEqual(events, [{
      kind: 'READMITTED', operationId: first.accepted.operationId,
      admissionKey: applied.admissionKey,
    }], name);
    assert.equal((await readmit({ apply: true })).kind, 'AlreadyReadmitted', name);
    assert.equal(events.length, 1, `${name}: a repeat apply reports nothing new`);

    const supplied = await enqueueDraft(SELECTOR, first.result.committedRevision,
      portsFor(store, readyEvent(2)));
    assert.deepEqual(supplied, {
      kind: 'StaleRevision', currentCommittedRevision: first.result.committedRevision,
    }, `${name}: an open successor is claimed only as a new admission`);
    assert.equal((await enqueue(store, 2)).kind, 'Enqueued', `${name}: nothing was taken`);
  }
});

test('registry contention is retried from what landed, then reported as contended', async () => {
  const [, make] = STORES[1];
  const opens = (admissionKey) => (ref, body) => ref === REGISTRY_REF
    && body.admissionKey === admissionKey;
  for (const [times, expected] of [[2, 'Readmitted'], [3, 'ReadmissionContended']]) {
    const { store, git } = make();
    const first = await settle(store, 1, PROVIDERS.expired());
    const admissionKey = successorKey(WORK_KEY, first.result.committedRevision);
    git.contend(opens(admissionKey), times);
    const result = await readmitDraft(first.accepted.operationId, first.result.committedRevision,
      PROVENANCE, { store }, { apply: true });
    assert.equal(result.kind, expected, `${times} rival writes`);
    assert.equal(result.admissionKey, admissionKey);
    if (expected === 'ReadmissionContended') {
      assert.equal(result.committedRevision, first.result.committedRevision);
      assert.equal((await enqueue(store, 2)).kind, 'StaleRevision', 'a contended run admits nothing');
      const resumed = await readmitDraft(first.accepted.operationId,
        first.result.committedRevision, PROVENANCE, { store }, { apply: true });
      assert.equal(resumed.kind, 'Readmitted', 'the next dispatch resumes');
    }
    assert.equal((await enqueue(store, 2)).kind, 'Enqueued', `${times} rival writes`);
  }

  const { store, git } = make();
  const first = await settle(store, 1, PROVIDERS.expired());
  const admissionKey = successorKey(WORK_KEY, first.result.committedRevision);
  git.contend((ref, body) => ref === REGISTRY_REF && body.kind === 'CONFIRMED'
    && body.admissionKey === admissionKey, 1);
  const resumed = await readmitDraft(first.accepted.operationId, first.result.committedRevision,
    PROVENANCE, { store }, { apply: true });
  assert.equal(resumed.kind, 'Readmitted', 'a lost confirmation resumes from the written root');
  assert.equal(git.records(`${WORK_PREFIX}${admissionKey}`).length, 1, 'one root, never two');
});

test('an intake that reads a successor while it is being opened sees it open, never corrupt', async () => {
  const [, make] = STORES[1];
  const { store, git, config } = make();
  const first = await settle(store, 1, PROVIDERS.expired());
  const admissionKey = successorKey(WORK_KEY, first.result.committedRevision);
  const operator = createGitDataDraftOperationStore({ gitData: git.port, config });
  // Intake has read the registry and finds no successor; the operator's whole opening lands
  // before intake reads the successor's work ref.
  git.beforeReading(`${WORK_PREFIX}${admissionKey}`, async () => {
    const opened = await readmitDraft(first.accepted.operationId, first.result.committedRevision,
      PROVENANCE, { store: operator }, { apply: true });
    assert.equal(opened.kind, 'Readmitted');
  });
  const accepted = await enqueue(store, 2);
  assert.equal(accepted.kind, 'Enqueued');
  assert.equal((await store.inspectByOperation(accepted.operationId)).admission.key, admissionKey);
});

test('a first admission that loses the shared registry is retried, then reported contended', async () => {
  const [, make] = STORES[1];
  const reserves = (ref, body) => ref === REGISTRY_REF && body.kind === 'RESERVED'
    && body.workKey === WORK_KEY;
  // A pause before each retry, none after the last attempt: 2–4 s, then 4–8 s.
  const backoff = [admissionRetryPauseMs(WORK_KEY, 1), admissionRetryPauseMs(WORK_KEY, 2)];
  assert.ok(backoff[0] >= 2000 && backoff[0] < 4000 && backoff[1] >= 4000 && backoff[1] < 8000,
    `${backoff}`);
  for (const [times, expected] of [[2, 'Enqueued'], [3, 'AdmissionContended']]) {
    const { store, git } = make();
    // Labelling several issues at once starts one intake per issue, all writing one registry.
    git.contend(reserves, times);
    const clock = pauses();
    const result = await enqueue(store, 1, clock.pause);
    assert.equal(result.kind, expected, `${times} rival admissions`);
    assert.deepEqual(clock.waited, backoff, `${times} rival admissions`);
    if (expected === 'AdmissionContended') {
      // Not StaleRevision: that would read as a settled issue in a healthy empty queue.
      assert.deepEqual(result, { kind: 'AdmissionContended', workKey: WORK_KEY });
      assert.deepEqual(git.kinds(`${WORK_PREFIX}${WORK_KEY}`), [], 'a contended run writes no work');
      const next = pauses();
      assert.equal((await enqueue(store, 1, next.pause)).kind, 'Enqueued', 'the next run admits it');
      assert.deepEqual(next.waited, [], 'an uncontended admission never waits');
    }
    assert.deepEqual(git.kinds(`${WORK_PREFIX}${WORK_KEY}`), ['WORK_ROOT', 'ENQUEUED']);
  }
  // Only a first admission is retried. A supplied revision that no record carries is plain stale.
  for (const [name, makeStore] of STORES) {
    const { store } = makeStore();
    const clock = pauses();
    const supplied = await enqueueDraft(SELECTOR, 'e'.repeat(64),
      portsFor(store, readyEvent(1), undefined, clock.pause));
    assert.deepEqual(supplied, { kind: 'StaleRevision', currentCommittedRevision: 'NONE' }, name);
    assert.deepEqual(clock.waited, [], `${name}: nothing to retry, nothing to wait for`);
  }
});

test('a first admission whose confirmation is lost resumes from its own root', async () => {
  const [, make] = STORES[1];
  const { store, git } = make();
  git.contend((ref, body) => ref === REGISTRY_REF && body.kind === 'CONFIRMED'
    && body.workKey === WORK_KEY, 1);
  const result = await enqueue(store, 1);
  assert.equal(result.kind, 'Enqueued');
  assert.deepEqual(git.kinds(`${WORK_PREFIX}${WORK_KEY}`), ['WORK_ROOT', 'ENQUEUED'],
    'one root, never two');
  assert.deepEqual(git.kinds(REGISTRY_REF).filter((kind) => kind === 'CONFIRMED'), ['CONFIRMED']);
});

test('two intakes of one issue that both lose to a third admission still admit it exactly once', async () => {
  const [, make] = STORES[1];
  const { store, git, config } = make();
  const rival = createGitDataDraftOperationStore({ gitData: git.port, config });
  let admittedByRival = null;
  // A third issue's reservation lands first, so both first reservations of this issue go stale;
  // without the retry neither run admits it. Gated interleavings of the two runs inside one
  // bootstrap live in tests/draft-operation-concurrent-bootstrap.test.mjs.
  git.contend((ref, body) => {
    if (ref !== REGISTRY_REF || body.kind !== 'RESERVED' || body.workKey !== WORK_KEY) return false;
    return admittedByRival === null;
  }, 1);
  const rivalRun = enqueue(rival, 1).then((result) => { admittedByRival = result; });
  const result = await enqueue(store, 1);
  await rivalRun;
  const enqueued = [admittedByRival, result].filter((run) => run.kind === 'Enqueued');
  assert.equal(enqueued.length, 1, 'exactly one of the two runs admits the issue');
  assert.deepEqual(git.kinds(`${WORK_PREFIX}${WORK_KEY}`), ['WORK_ROOT', 'ENQUEUED']);
});
