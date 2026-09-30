/**
 * Operator settlement of one EFFECT_AMBIGUOUS Draft operation (Gaia issue #161,
 * docs/hosted-draft-intake.md): the ABANDONED transition, its compare-and-swap write, and the ledger
 * read-back that re-proves it.
 *
 * Every scenario runs against the memory store and against a fake Git Data API implementing the
 * real ref/commit protocol, because ABANDONED is a ledger record both stores must hold and replay.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createDraftOperationPorts,
  createGitDataDraftOperationStore,
  createMemoryDraftOperationStore,
  enqueueDraft,
  listUnsettledDrafts,
  readmitDraft,
  reconcileDraft,
  settleAmbiguousDraft,
} from '../src/draft-operation-envelope.mjs';

const REGISTRY_REF = 'refs/heads/gaia-ledger/registry-v0';
const WORK_PREFIX = 'refs/heads/gaia-ledger/draft-operations-v0/';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const OID_A = '1'.repeat(40);
const OID_B = '2'.repeat(40);
const SELECTOR = {
  repository: { owner: 'GuitarAlchemist', name: 'gaia' },
  workItem: { kind: 'ISSUE', number: 127 },
};
const REPOSITORY = { nodeId: 'R_kgDOSettle', owner: 'GuitarAlchemist', name: 'gaia' };
const PROVENANCE = Object.freeze({
  reason: 'The create response for #127 was lost; the marker search finds no pull request.',
  runId: 16101, runAttempt: 1, triggeringActor: 'spareilleux',
});
const OBSERVED_AT = '2026-09-30T12:00:00Z';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
  ).join(',')}}`;
}

const sha256 = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

const WORK_KEY = sha256({
  schema: 'GaiaDraftWorkKeyV0', repositoryNodeId: REPOSITORY.nodeId,
  workItem: SELECTOR.workItem, requestedEffect: 'CREATE_DRAFT',
});

/** One ready event of issue #127; each occurrence is a distinct generation on its own head. */
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
      baseRef: 'main', headRef: `gaia/issue-127-ready-${occurrence}`,
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
  let writes = 0;
  const newOid = () => (nextOid++).toString(16).padStart(40, '0');
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
        return { state: 'PRESENT', records: structuredClone(matches[0]) };
      },
      async compareAndAppend(ref, expectedHeadOid, body, transportMetadata) {
        const records = refs.get(ref) ?? [];
        const current = records.at(-1)?.oid ?? 'NONE';
        if (current !== expectedHeadOid) return { kind: 'STALE', currentHeadOid: current };
        writes += 1;
        const record = { oid: newOid(), body: structuredClone(body), committedRevision: sha256(body) };
        if (transportMetadata !== undefined) {
          record.transportMetadata = structuredClone(transportMetadata);
        }
        refs.set(ref, [...records, record]);
        return { kind: 'APPENDED', ...structuredClone(record) };
      },
    }),
    writes: () => writes,
    kinds: (ref) => (refs.get(ref) ?? []).map((record) => record.body.kind),
    records: (ref) => structuredClone(refs.get(ref) ?? []),
    /** Rewrite the last record's body and re-hash it, so only the rules can refuse it. */
    rewriteLast(ref, change) {
      const records = structuredClone(refs.get(ref));
      const last = records.at(-1);
      change(last.body);
      last.committedRevision = sha256(last.body);
      refs.set(ref, records);
    },
  };
}

const STORES = [
  ['memory', () => ({ store: createMemoryDraftOperationStore(), git: null })],
  ['git data', () => {
    const git = fakeGitData();
    const config = {
      ledgerRegistryRootOid: OID_A, ledgerRegistryRootRevision: git.registryRootRevision,
    };
    const open = () => createGitDataDraftOperationStore({ gitData: git.port, config });
    return { git, open, store: open() };
  }],
];

const PROVIDERS = {
  ambiguous: () => ({
    async lookupExact() { return null; },
    async createDraft() { throw new Error('response lost'); },
  }),
  creates: () => ({
    async lookupExact() { return null; },
    async createDraft(request) { return exactDraft(request); },
  }),
  reuses: () => ({
    async lookupExact(request) { return exactDraft(request); },
    async createDraft() { assert.fail('an adopted Draft is never created again'); },
  }),
};

function exactDraft(request) {
  return {
    number: 1270, url: 'https://github.com/GuitarAlchemist/gaia/pull/1270', isDraft: true,
    state: 'OPEN', operationMarker: request.operationMarker, repository: request.repository,
    baseRef: request.baseRef, headRef: request.headRef, headRevision: request.headRevision,
  };
}

function portsFor(store, occurrence, provider, telemetry = { async append() {} }) {
  return createDraftOperationPorts({
    collector: { async collect() { return structuredClone(readyEvent(occurrence)); } },
    provider,
    admission: { async reserveEffect() { return 'AVAILABLE'; } },
    executorEpoch: { runId: 16100, runAttempt: 1 },
    telemetry,
    store,
    async pause() {},
  });
}

/** Enqueue one generation and reconcile it with `provider`; ambiguous by default. */
async function operation(store, occurrence = 1, provider = PROVIDERS.ambiguous()) {
  const accepted = await enqueueDraft(SELECTOR, 'NONE', portsFor(store, occurrence, provider));
  assert.equal(accepted.kind, 'Enqueued');
  const result = await reconcileDraft(
    accepted.operationId, accepted.committedRevision, portsFor(store, occurrence, provider),
  );
  return { accepted, result };
}

/** A pull request row as `gh pr list --json` returns it, on the searched head. */
function ghRow(request, overrides = {}) {
  return {
    number: 1270, url: 'https://github.com/GuitarAlchemist/gaia/pull/1270', isDraft: true,
    state: 'OPEN', baseRefName: 'main', headRefName: request.headRef, headRefOid: OID_B,
    headRepositoryOwner: { id: 'O_kgDOSettle', login: 'GuitarAlchemist' },
    body: `<!-- gaia-operation:${request.marker} -->\nIssue: #127`,
    ...overrides,
  };
}

/** The lookup the gh adapter would return for `request`, with `candidates` rows. */
function lookupFor(request, candidates = [], overrides = {}) {
  return {
    schema: 'GaiaDraftMarkerLookupV0',
    committedRevision: request.committedRevision,
    repository: { ...request.repository },
    repositoryCheck: { id: REPOSITORY.nodeId, nameWithOwner: 'GuitarAlchemist/gaia' },
    headRef: request.headRef,
    marker: request.marker,
    search: { state: 'all', limit: 100 },
    observedAt: OBSERVED_AT,
    outcome: 'COMPLETE',
    candidates: typeof candidates === 'function' ? candidates(request) : candidates,
    ...overrides,
  };
}

/** A marker search that records every request and answers with `answer(request)`. */
function searcher(answer = (request) => lookupFor(request)) {
  const requests = [];
  return {
    requests,
    async searchMarker(request) {
      requests.push(structuredClone({ ...request, repository: { ...request.repository } }));
      return answer(request);
    },
  };
}

function telemetry() {
  const events = [];
  return { events, async append(event) { events.push(structuredClone(event)); } };
}

const settle = (store, pending, search, options, provenance = PROVENANCE, events = telemetry()) =>
  settleAmbiguousDraft(
    pending.operationId, pending.committedRevision, provenance,
    { store, telemetry: events, searchMarker: search.searchMarker }, options,
  );

test('a provably absent Draft is abandoned only by an explicit apply, at the ambiguous revision', async () => {
  for (const [name, make] of STORES) {
    const { store, git, open } = make();
    const { result: pending } = await operation(store);
    assert.equal(pending.kind, 'Pending', name);
    const search = searcher();
    const writesBefore = git?.writes();

    const planned = await settle(store, pending, search);
    assert.equal(planned.kind, 'AbandonmentPlanned', `${name}: a dry run by default`);
    assert.deepEqual([planned.decision, planned.reason], ['SETTLE_ABANDONED', 'MarkerProvablyAbsent']);
    assert.equal(planned.evidence.committedRevision, pending.committedRevision, name);
    assert.deepEqual(search.requests, [{
      committedRevision: pending.committedRevision, repository: REPOSITORY,
      headRef: readyEvent(1).generation.headRef, marker: pending.operationId,
    }], `${name}: the search is bound to the revision read, the head and the marker`);
    assert.equal(git?.writes(), writesBefore, `${name}: a dry run writes nothing`);
    assert.equal((await listUnsettledDrafts({ store })).length, 1, name);

    const events = telemetry();
    const applied = await settle(store, pending, search, { apply: true }, PROVENANCE, events);
    assert.equal(applied.kind, 'Abandoned', name);
    assert.equal(search.requests.length, 2, `${name}: the write re-runs the search`);
    assert.notEqual(applied.settledRevision, pending.committedRevision, name);
    assert.deepEqual(events.events, [{ kind: 'ABANDONED', operationId: pending.operationId }], name);
    assert.deepEqual(await listUnsettledDrafts({ store }), [], `${name}: no longer unsettled`);
    if (git) {
      assert.equal(git.writes(), writesBefore + 1, `${name}: exactly one record`);
      assert.deepEqual(git.kinds(`${WORK_PREFIX}${WORK_KEY}`).slice(-2),
        ['EFFECT_AMBIGUOUS', 'ABANDONED'], name);
    }

    // The read-back, through a fresh store over the same ledger for Git Data, holds the proof.
    const reader = open ? open() : store;
    const terminal = await reconcileDraft(
      pending.operationId, applied.settledRevision, portsFor(reader, 1, PROVIDERS.creates()),
    );
    assert.equal(terminal.kind, 'Terminal', name);
    assert.deepEqual([terminal.outcome, terminal.effect, terminal.pullRequest, terminal.refusal],
      ['ABANDONED', 'NONE', null, null], `${name}: nothing was created`);
    const again = await settle(reader, pending, search, { apply: true });
    assert.equal(again.kind, 'AlreadyAbandoned', `${name}: a re-run adopts its own write`);
    assert.equal(again.settledRevision, applied.settledRevision, name);
    assert.equal(search.requests.length, 2, `${name}: and searches nothing`);
    if (git) assert.equal(git.writes(), writesBefore + 1, name);

    // An abandoned line is settled: a new generation is not admitted and it is not re-admissible.
    assert.equal((await enqueueDraft(SELECTOR, 'NONE',
      portsFor(reader, 2, PROVIDERS.creates()))).kind, 'StaleRevision', name);
    assert.equal((await readmitDraft(pending.operationId, applied.settledRevision, PROVENANCE,
      { store: reader }, { apply: true })).kind, 'NotReadmissible', name);
  }
});

test('the stored abandonment carries the decision evidence and the dispatch that asked', async () => {
  for (const [name, make] of STORES) {
    const { store, git, open } = make();
    const { result: pending } = await operation(store);
    const applied = await settle(store, pending, searcher(), { apply: true });
    assert.equal(applied.kind, 'Abandoned', name);
    const read = await (open ? open() : store).inspectByOperation(pending.operationId);
    assert.equal(read.state, 'ABANDONED', name);
    assert.deepEqual({ ...read.terminal.provenance }, PROVENANCE, name);
    assert.deepEqual(structuredClone(read.terminal.settlement), structuredClone(applied.evidence), name);
    assert.deepEqual([read.terminal.outcome, read.terminal.committedRevision],
      ['ABANDONED', applied.settledRevision], name);
    if (git) {
      const body = git.records(`${WORK_PREFIX}${WORK_KEY}`).at(-1).body;
      assert.deepEqual(Object.keys(body).sort(), [
        'generationKey', 'kind', 'operationId', 'priorCommittedRevision', 'provenance', 'schema',
        'settlement', 'workKey',
      ], `${name}: a closed record`);
      assert.equal(body.priorCommittedRevision, pending.committedRevision, name);
    }
  }
});

test('a marked Draft found is left for reconcile to adopt, and a search that proves nothing writes nothing', async () => {
  for (const [name, make] of STORES) {
    const { store, git } = make();
    const { result: pending } = await operation(store);
    const writesBefore = git?.writes();

    const found = await settle(store, pending, searcher(
      (request) => lookupFor(request, [ghRow(request)]),
    ), { apply: true });
    assert.equal(found.kind, 'ReconcileAdopts', name);
    assert.deepEqual([found.decision, found.reason], ['SETTLE_REUSED', 'MarkedDraftFound'], name);
    assert.equal(found.evidence.pullRequest.number, 1270, name);

    const unproven = {
      SeveralPullRequestsOnHead: (request) => lookupFor(request,
        [ghRow(request), ghRow(request, { number: 1271, body: 'hand-made' })]),
      LookupTruncated: (request) => lookupFor(request, Array.from({ length: 100 },
        (_, index) => ghRow(request, { number: 2000 + index, body: 'hand-made' }))),
      LookupErrored: (request) => lookupFor(request, [], { outcome: 'ERRORED', repositoryCheck: null }),
      LookupPartial: (request) => lookupFor(request, [], { outcome: 'PARTIAL' }),
      UnmarkedPullRequestOnHead: (request) => lookupFor(request, [ghRow(request, { body: 'none' })]),
      MarkedPullRequestNotAdoptable: (request) => lookupFor(request,
        [ghRow(request, { state: 'CLOSED', isDraft: false })]),
    };
    for (const [reason, answer] of Object.entries(unproven)) {
      const stays = await settle(store, pending, searcher(answer), { apply: true });
      assert.equal(stays.kind, 'StaysUnsettled', `${name}: ${reason}`);
      assert.deepEqual([stays.decision, stays.reason], ['STAY_UNSETTLED', reason], name);
    }
    assert.equal(git?.writes(), writesBefore, `${name}: nothing short of a proven absence is written`);
    assert.equal((await store.inspectByOperation(pending.operationId)).state, 'EFFECT_AMBIGUOUS');

    // What the settlement found is what reconcile's own exact lookup adopts.
    const adopted = await reconcileDraft(
      pending.operationId, pending.committedRevision, portsFor(store, 1, PROVIDERS.reuses()),
    );
    assert.deepEqual([adopted.kind, adopted.outcome], ['Terminal', 'REUSED'], name);
  }
});

test('settlement refuses what it cannot bind: another revision, another state, another search', async () => {
  for (const [name, make] of STORES) {
    const { store, git } = make();
    const { result: pending } = await operation(store);
    const createdStore = createMemoryDraftOperationStore();
    const { result: created } = await operation(createdStore, 1, PROVIDERS.creates());
    const search = searcher();
    const writesBefore = git?.writes();

    const staleResult = await settle(store, { ...pending, committedRevision: SHA_A }, search,
      { apply: true });
    assert.deepEqual(staleResult, {
      kind: 'StaleRevision', currentCommittedRevision: pending.committedRevision,
    }, name);

    const enqueuedStore = createMemoryDraftOperationStore();
    const enqueued = await enqueueDraft(SELECTOR, 'NONE',
      portsFor(enqueuedStore, 3, PROVIDERS.creates()));
    const notAmbiguous = await settle(enqueuedStore, enqueued, search, { apply: true });
    assert.deepEqual([notAmbiguous.kind, notAmbiguous.state, notAmbiguous.outcome],
      ['NotAmbiguous', 'ENQUEUED', null], name);
    const settled = await settle(createdStore, created, search, { apply: true });
    assert.deepEqual([settled.kind, settled.state, settled.outcome],
      ['NotAmbiguous', 'CREATED', 'CREATED'], `${name}: a created Draft is never abandoned`);
    assert.equal(search.requests.length, 0, `${name}: nothing is searched for an unbound operation`);

    const refusals = {
      LookupScopeMismatch: (request) => lookupFor(request, [], {
        repositoryCheck: { id: 'R_elsewhere', nameWithOwner: 'GuitarAlchemist/gaia' },
      }),
      LookupRevisionMismatch: (request) => lookupFor(request, [], { committedRevision: SHA_B }),
      LookupMarkerMismatch: (request) => lookupFor(request, [], { marker: SHA_A }),
      InvalidLookup: (request) => ({ ...lookupFor(request), extra: true }),
    };
    for (const [code, answer] of Object.entries(refusals)) {
      const refused = await settle(store, pending, searcher(answer), { apply: true });
      assert.deepEqual([refused.kind, refused.refusal], ['SettlementRefused', code], `${name}: ${code}`);
    }
    assert.equal(git?.writes(), writesBefore, `${name}: a refused settlement writes nothing`);

    const code = (expected) => (error) => error.code === expected;
    await assert.rejects(settleAmbiguousDraft(SHA_A, SHA_B, PROVENANCE,
      { store, searchMarker: search.searchMarker }), code('UnknownOperation'), name);
    await assert.rejects(settle(store, pending, search, { apply: 'yes' }),
      code('InvalidSettlement'), name);
    for (const provenance of [
      { ...PROVENANCE, reason: ' padded' }, { ...PROVENANCE, reason: 'x'.repeat(501) },
      { ...PROVENANCE, triggeringActor: 'not an actor' }, { ...PROVENANCE, runId: 0 },
      { reason: PROVENANCE.reason, runId: 1, runAttempt: 1 },
    ]) {
      await assert.rejects(settle(store, pending, search, {}, provenance),
        code('InvalidSettlement'), name);
    }
    await assert.rejects(settleAmbiguousDraft(pending.operationId, pending.committedRevision,
      PROVENANCE, { store }), code('InvalidPorts'), `${name}: no search, no settlement`);
    assert.equal(search.requests.length, 0, name);
  }
});

test('an operation that moves between the read and the write is never abandoned', async () => {
  for (const [name, make] of STORES) {
    const { store, git } = make();
    const { result: pending } = await operation(store);
    // The Draft turns up and reconcile adopts it while the settlement is searching.
    const racing = searcher(async (request) => {
      const adopted = await reconcileDraft(
        pending.operationId, pending.committedRevision, portsFor(store, 1, PROVIDERS.reuses()),
      );
      assert.equal(adopted.outcome, 'REUSED');
      return lookupFor(request);
    });
    const lost = await settle(store, pending, racing, { apply: true });
    assert.equal(lost.kind, 'StaleRevision', name);
    const after = await store.inspectByOperation(pending.operationId);
    assert.equal(after.state, 'REUSED', `${name}: the adoption stands`);
    assert.equal(lost.currentCommittedRevision, after.committedRevision, name);
    if (git) assert.equal(git.kinds(`${WORK_PREFIX}${WORK_KEY}`).at(-1), 'REUSED', name);
  }
});

test('the ledger reads an abandonment back only with evidence that proves it', async () => {
  const [, makeGit] = STORES[1];
  const rehash = (settlement) => {
    const { revision, ...record } = settlement;
    settlement.revision = sha256(record);
    return revision;
  };
  const tampers = {
    'an untouched record (control)': null,
    'a lookup that found a pull request': (body) => {
      body.settlement.lookup.candidateCount = 1; rehash(body.settlement);
    },
    'a lookup that did not complete': (body) => {
      body.settlement.lookup.outcome = 'PARTIAL'; rehash(body.settlement);
    },
    'a search under another bound': (body) => {
      body.settlement.lookup.search.limit = 1000; rehash(body.settlement);
    },
    'another repository identity': (body) => {
      body.settlement.lookup.repositoryCheck.id = 'R_elsewhere'; rehash(body.settlement);
    },
    'a decision to reuse': (body) => {
      body.settlement.decision = 'SETTLE_REUSED'; rehash(body.settlement);
    },
    'another ambiguous revision': (body) => {
      body.settlement.committedRevision = SHA_A; rehash(body.settlement);
    },
    'another operation': (body) => {
      body.settlement.operationId = SHA_B; rehash(body.settlement);
    },
    'a claimed effect': (body) => {
      body.settlement.effect = 'CREATE_DRAFT'; rehash(body.settlement);
    },
    'evidence that does not name its content': (body) => {
      body.settlement.lookup.observedAt = '2026-10-01T00:00:00Z';
    },
    'a dispatcher that is no GitHub login': (body) => {
      body.provenance.triggeringActor = 'not an actor';
    },
    'a record with an extra field': (body) => { body.note = 'trust me'; },
    'no provenance': (body) => { delete body.provenance; },
  };
  for (const [name, tamper] of Object.entries(tampers)) {
    const { store, git, open } = makeGit();
    const { result: pending } = await operation(store);
    assert.equal((await settle(store, pending, searcher(), { apply: true })).kind, 'Abandoned');
    if (tamper) git.rewriteLast(`${WORK_PREFIX}${WORK_KEY}`, tamper);
    const read = open().inspectByOperation(pending.operationId);
    if (tamper === null) {
      assert.equal((await read).state, 'ABANDONED', name);
    } else {
      await assert.rejects(read, (error) => error.code === 'LedgerCorrupt', name);
    }
  }

  // ABANDONED follows EFFECT_AMBIGUOUS only: the same proof after any other record is corruption.
  const { store, git, open } = makeGit();
  const { result: pending } = await operation(store);
  await settle(store, pending, searcher(), { apply: true });
  const records = git.records(`${WORK_PREFIX}${WORK_KEY}`);
  const abandoned = structuredClone(records.at(-1).body);
  const started = records.at(-3);
  abandoned.priorCommittedRevision = started.committedRevision;
  abandoned.settlement.committedRevision = started.committedRevision;
  rehash(abandoned.settlement);
  const replaced = [...records.slice(0, -2), {
    oid: records.at(-1).oid, body: abandoned, committedRevision: sha256(abandoned),
  }];
  assert.equal((await fakeGitDataFrom(git, records).inspectByOperation(pending.operationId)).state,
    'ABANDONED', 'positive control: the substituted chain reads when it is the real one');
  const rewritten = fakeGitDataFrom(git, replaced);
  await assert.rejects(rewritten.inspectByOperation(pending.operationId),
    (error) => error.code === 'LedgerCorrupt', 'EFFECT_STARTED → ABANDONED is refused');
  assert.equal((await open().inspectByOperation(pending.operationId)).state, 'ABANDONED',
    'positive control: the original chain still reads');
});

/** A store over a copy of `git`'s ledger whose work ref holds `records` instead. */
function fakeGitDataFrom(git, records) {
  const port = Object.freeze({
    ...git.port,
    async read(ref) {
      if (ref === `${WORK_PREFIX}${WORK_KEY}`) {
        return { state: 'PRESENT', records: structuredClone(records) };
      }
      return git.port.read(ref);
    },
    async readByOperation() { return { state: 'PRESENT', records: structuredClone(records) }; },
  });
  return createGitDataDraftOperationStore({
    gitData: port,
    config: { ledgerRegistryRootOid: OID_A, ledgerRegistryRootRevision: git.registryRootRevision },
  });
}
