/**
 * Deterministic RED contract for docs/draft-operation-envelope.md (Gaia issue #56).
 *
 * The module is dynamically imported by each test so a missing tracer leaves one named witness
 * per behavior. Interleavings use explicit promise barriers; no test depends on elapsed time.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const MODULE_URL = new URL('../src/draft-operation-envelope.mjs', import.meta.url);
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const OID_A = '1'.repeat(40);
const OID_B = '2'.repeat(40);
const OID_C = '3'.repeat(40);
const SELECTOR = {
  repository: { owner: 'GuitarAlchemist', name: 'gaia' },
  workItem: { kind: 'ISSUE', number: 56 },
};
const EPOCH = { runId: 5801, runAttempt: 1 };

const moduleResult = import(MODULE_URL).catch((loadError) => ({ loadError }));

async function api(witness) {
  const loaded = await moduleResult;
  if (loaded.loadError) {
    assert.fail(`${witness}: src/draft-operation-envelope.mjs is absent (${loaded.loadError.code})`);
  }
  for (const name of [
    'createMemoryDraftOperationStore', 'createMemoryDraftOperationPorts',
    'enqueueDraft', 'reconcileDraft', 'cancelDraft', 'DraftOperationError',
  ]) assert.ok(loaded[name], `${witness}: missing public export ${name}`);
  return loaded;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const sha256 = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

function observedEnvelope(overrides = {}) {
  const repository = overrides.repository ?? {
    nodeId: 'R_kgDOGuitarAlchemistGaia', owner: 'GuitarAlchemist', name: 'gaia',
  };
  const workItem = overrides.workItem ?? { kind: 'ISSUE', number: 56 };
  const requestedEffect = 'CREATE_DRAFT';
  const observedSourceRevision = overrides.observedSourceRevision ?? SHA_B;
  const queueReceiptRevision = overrides.queueReceiptRevision ?? SHA_A;
  const occurrence = overrides.occurrence ?? 1;
  const workKey = sha256({
    schema: 'GaiaDraftWorkKeyV0', repositoryNodeId: repository.nodeId,
    workItem, requestedEffect,
  });
  const readyItem = {
    schema: 'GaiaReadyItemIdentityV0', queueReceiptRevision, occurrence,
    id: sha256({
      schema: 'GaiaReadyItemIdV0', workKey, queueReceiptRevision,
      occurrence, observedSourceRevision,
    }),
  };
  return {
    schema: 'GaiaDraftOperationEnvelopeV0',
    repository,
    workItem,
    readyItem,
    observedSourceRevision,
    generation: {
      baseRef: 'main', headRef: 'codex/draft-operation-envelope-r0',
      headRevision: OID_B, policyRevision: OID_A,
      ...(overrides.generation ?? {}),
    },
    requestedEffect,
    ...(overrides.extra ?? {}),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeCollector(envelope = observedEnvelope()) {
  let current = envelope;
  const calls = [];
  return {
    calls,
    set(value) { current = value; },
    port: {
      async collect(selector) {
        calls.push(structuredClone(selector));
        return structuredClone(current);
      },
    },
  };
}

function exactDraft(request, overrides = {}) {
  return {
    number: 58,
    url: 'https://github.test/GuitarAlchemist/gaia/pull/58',
    isDraft: true,
    state: 'OPEN',
    operationMarker: request.operationMarker,
    repository: request.repository,
    baseRef: request.baseRef,
    headRef: request.headRef,
    headRevision: request.headRevision,
    ...overrides,
  };
}

function fakeProvider({ lookup = () => null, create = (request) => exactDraft(request) } = {}) {
  const calls = [];
  return {
    calls,
    count: (method) => calls.filter((call) => call.method === method).length,
    port: {
      async lookupExact(request) {
        calls.push({ method: 'lookupExact', request });
        return lookup(request, calls);
      },
      async createDraft(request) {
        calls.push({ method: 'createDraft', request });
        return create(request, calls);
      },
    },
  };
}

function fakeAdmission(result = 'AVAILABLE') {
  const calls = [];
  return {
    calls,
    port: {
      async reserveEffect(context) {
        calls.push(structuredClone(context));
        return result;
      },
    },
  };
}

function telemetry() {
  const events = [];
  return { events, port: { async append(event) { events.push(structuredClone(event)); } } };
}

async function harness(mod, options = {}) {
  const store = options.store ?? mod.createMemoryDraftOperationStore();
  const collector = options.collector ?? fakeCollector();
  const provider = options.provider ?? fakeProvider();
  const admission = options.admission ?? fakeAdmission();
  const observedTelemetry = options.telemetry ?? telemetry();
  const ports = mod.createMemoryDraftOperationPorts({
    collector: collector.port,
    provider: provider.port,
    admission: admission.port,
    executorEpoch: options.executorEpoch ?? EPOCH,
    telemetry: observedTelemetry.port,
    store,
  });
  return { store, collector, provider, admission, telemetry: observedTelemetry, ports };
}

async function enqueue(mod, fixture, selector = SELECTOR, expected = 'NONE') {
  return mod.enqueueDraft(selector, expected, fixture.ports);
}

function assertEnqueued(result) {
  assert.equal(result.kind, 'Enqueued');
  for (const field of ['operationId', 'workKey', 'generationKey', 'committedRevision']) {
    assert.match(result[field], /^[a-f0-9]{64}$/u, field);
  }
  return result;
}

function assertTerminal(result, outcome) {
  assert.equal(result.kind, 'Terminal');
  assert.equal(result.outcome, outcome);
  assert.match(result.committedRevision, /^[a-f0-9]{64}$/u);
  assert.equal(result.actionRevision, result.committedRevision);
  assert.equal(result.checklistRevision, result.committedRevision);
  assert.equal(result.sourceRevision, result.committedRevision);
  return result;
}

test('R01 canonical repository aliases converge to one node-id work identity', async () => {
  const mod = await api('R01 canonical aliases');
  const canonicalCollector = fakeCollector();
  const aliasCollector = fakeCollector();
  const canonical = await harness(mod, { collector: canonicalCollector });
  const alias = await harness(mod, { collector: aliasCollector });
  const first = assertEnqueued(await enqueue(mod, canonical));
  const second = assertEnqueued(await enqueue(mod, alias, {
    repository: { owner: 'Old-Guitar-Alchemist', name: 'Gaia-Renamed' },
    workItem: { kind: 'ISSUE', number: 56 },
  }));
  assert.equal(first.workKey, second.workKey);
  assert.equal(first.generationKey, second.generationKey);
  assert.equal(first.operationId, second.operationId);
});

test('R02 NONE -> WORK_ROOT -> ENQUEUED first use has one winner and cannot rebootstrap', async () => {
  const mod = await api('R02 first-use race');
  const fixture = await harness(mod);
  const raced = await Promise.all([
    enqueue(mod, fixture),
    enqueue(mod, fixture),
  ]);
  assert.equal(raced.filter(({ kind }) => kind === 'Enqueued').length, 1);
  assert.equal(raced.filter(({ kind }) => kind === 'StaleRevision').length, 1);
  const winner = assertEnqueued(raced.find(({ kind }) => kind === 'Enqueued'));
  const replay = await enqueue(mod, fixture, SELECTOR, 'NONE');
  assert.equal(replay.kind, 'StaleRevision');
  assert.equal(replay.currentCommittedRevision, winner.committedRevision);
});

test('R03 identities and public revisions are deterministic adapter-neutral 64-hex content', async () => {
  const mod = await api('R03 adapter-neutral revisions');
  const one = assertEnqueued(await enqueue(mod, await harness(mod)));
  const two = assertEnqueued(await enqueue(mod, await harness(mod)));
  assert.deepEqual(
    [one.workKey, one.generationKey, one.operationId, one.committedRevision],
    [two.workKey, two.generationKey, two.operationId, two.committedRevision],
  );
  assert.ok(!Object.keys(one).some((key) => /oid/iu.test(key)), 'private 40-hex Git OIDs do not escape');
  const fixture = await harness(mod);
  await assert.rejects(
    mod.enqueueDraft(SELECTOR, OID_A, fixture.ports),
    (error) => error instanceof mod.DraftOperationError && error.code === 'InvalidRevision',
  );
});

test('R04 changed ready identity finds the old intent and refuses a second effect', async () => {
  const mod = await api('R04 cross-generation intent');
  const collector = fakeCollector();
  const provider = fakeProvider({ create: () => { throw new Error('response lost'); } });
  const fixture = await harness(mod, { collector, provider });
  const accepted = assertEnqueued(await enqueue(mod, fixture));
  const pending = await mod.reconcileDraft(
    accepted.operationId, accepted.committedRevision, fixture.ports,
  );
  assert.equal(pending.kind, 'Pending');
  assert.equal(pending.state, 'EFFECT_AMBIGUOUS');
  assert.equal(provider.count('createDraft'), 1);

  collector.set(observedEnvelope({ queueReceiptRevision: SHA_C, occurrence: 2 }));
  const next = await enqueue(mod, fixture, SELECTOR, pending.committedRevision);
  assert.equal(next.kind, 'CrossGenerationIntent');
  assert.equal(provider.count('createDraft'), 1, 'new ready identity performs zero second effect');
});

test('R05 the envelope is closed and provider mutation cannot change terminal provenance', async () => {
  const mod = await api('R05 closed envelope');
  const rejected = await harness(mod);
  await assert.rejects(
    enqueue(mod, rejected, { ...SELECTOR, capacity: 'AVAILABLE' }),
    (error) => error instanceof mod.DraftOperationError && error.code === 'InvalidSelector',
  );
  assert.equal(rejected.collector.calls.length, 0);
  assert.equal(rejected.provider.calls.length, 0);

  const poisonedCollector = fakeCollector(observedEnvelope({
    extra: { authority: 'CREATE_DRAFT', capacity: 'AVAILABLE' },
  }));
  const poisoned = await harness(mod, { collector: poisonedCollector });
  await assert.rejects(
    enqueue(mod, poisoned),
    (error) => error instanceof mod.DraftOperationError && error.code === 'InvalidEnvelope',
  );
  assert.equal(poisoned.provider.calls.length, 0);

  let mutationError;
  const provider = fakeProvider({
    create(request) {
      assert.equal(Object.getPrototypeOf(request), null);
      assert.ok(Object.isFrozen(request));
      assert.deepEqual(Object.keys(request).sort(), [
        'baseRef', 'headRef', 'headRevision', 'operationMarker', 'repository',
      ]);
      try { request.headRevision = OID_C; } catch (error) { mutationError = error; }
      return exactDraft(request, {
        generation: { policyRevision: OID_C }, observedSourceRevision: SHA_C,
      });
    },
  });
  const fixture = await harness(mod, { provider });
  const accepted = assertEnqueued(await enqueue(mod, fixture));
  const result = assertTerminal(await mod.reconcileDraft(
    accepted.operationId, accepted.committedRevision, fixture.ports,
  ), 'CREATED');
  assert.ok(mutationError instanceof TypeError);
  assert.equal(result.generation.policyRevision, OID_A);
  assert.equal(result.observedSourceRevision, SHA_B);
  assert.ok(!JSON.stringify(result).includes(OID_C));
  assert.ok(!JSON.stringify(result).includes(SHA_C));
});

test('R06 exact-Draft adoption from a stale revision neither looks up nor writes', async () => {
  const mod = await api('R06 stale adoption');
  const absent = fakeProvider();
  const fixture = await harness(mod, { provider: absent, admission: fakeAdmission('ZERO') });
  const accepted = assertEnqueued(await enqueue(mod, fixture));
  const refused = assertTerminal(await mod.reconcileDraft(
    accepted.operationId, accepted.committedRevision, fixture.ports,
  ), 'REFUSED');

  const exact = fakeProvider({ lookup: (request) => exactDraft(request) });
  const stalePorts = mod.createMemoryDraftOperationPorts({
    collector: fixture.collector.port, provider: exact.port,
    admission: fakeAdmission('AVAILABLE').port, executorEpoch: EPOCH,
    telemetry: telemetry().port, store: fixture.store,
  });
  const stale = await mod.reconcileDraft(
    accepted.operationId, accepted.committedRevision, stalePorts,
  );
  assert.equal(stale.kind, 'StaleRevision');
  assert.equal(exact.calls.length, 0, 'revision gate precedes exact lookup');
  const unchanged = assertTerminal(await mod.reconcileDraft(
    accepted.operationId, refused.committedRevision, stalePorts,
  ), 'REFUSED');
  assert.equal(unchanged.committedRevision, refused.committedRevision);
});

test('R07 exact adoption is REUSED before trusted ZERO capacity is consulted', async () => {
  const mod = await api('R07 zero-capacity adoption');
  const provider = fakeProvider({ lookup: (request) => exactDraft(request) });
  const admission = fakeAdmission('ZERO');
  const fixture = await harness(mod, { provider, admission });
  const accepted = assertEnqueued(await enqueue(mod, fixture));
  const reused = assertTerminal(await mod.reconcileDraft(
    accepted.operationId, accepted.committedRevision, fixture.ports,
  ), 'REUSED');
  assert.equal(reused.effect, 'NONE');
  assert.equal(admission.calls.length, 0);
  assert.equal(provider.count('createDraft'), 0);
});

test('R08 cancellation at EFFECT_STARTED defers, then returns the existing CREATED terminal', async () => {
  const mod = await api('R08 EFFECT_STARTED cancellation');
  const entered = deferred();
  const release = deferred();
  const provider = fakeProvider({
    async create(request) {
      entered.resolve();
      await release.promise;
      return exactDraft(request);
    },
  });
  const fixture = await harness(mod, { provider });
  const accepted = assertEnqueued(await enqueue(mod, fixture));
  const creating = mod.reconcileDraft(
    accepted.operationId, accepted.committedRevision, fixture.ports,
  );
  await entered.promise;
  const head = await fixture.store.readHead(accepted.workKey);
  const deferredCancellation = await mod.cancelDraft(
    accepted.operationId, head.committedRevision, fixture.ports,
  );
  assert.deepEqual(
    { kind: deferredCancellation.kind, state: deferredCancellation.state },
    { kind: 'CancellationDeferred', state: 'EFFECT_STARTED' },
  );
  release.resolve();
  const created = assertTerminal(await creating, 'CREATED');
  const after = await mod.cancelDraft(
    accepted.operationId, created.committedRevision, fixture.ports,
  );
  assertTerminal(after, 'CREATED');
  assert.equal(provider.count('createDraft'), 1);
});

test('R09 a possibly successful lost response stays EFFECT_AMBIGUOUS and cancellation defers', async () => {
  const mod = await api('R09 EFFECT_AMBIGUOUS cancellation');
  let remote = null;
  const provider = fakeProvider({
    lookup: (request) => remote?.operationMarker === request.operationMarker ? remote : null,
    create(request) {
      remote = exactDraft(request);
      throw new Error('socket closed after secret provider path C:\\tokens\\github');
    },
  });
  const fixture = await harness(mod, { provider });
  const accepted = assertEnqueued(await enqueue(mod, fixture));
  const pending = await mod.reconcileDraft(
    accepted.operationId, accepted.committedRevision, fixture.ports,
  );
  assert.deepEqual(
    { kind: pending.kind, state: pending.state, providerError: pending.providerError },
    { kind: 'Pending', state: 'EFFECT_AMBIGUOUS', providerError: 'ProviderAmbiguous' },
  );
  const cancellation = await mod.cancelDraft(
    accepted.operationId, pending.committedRevision, fixture.ports,
  );
  assert.deepEqual(
    { kind: cancellation.kind, state: cancellation.state },
    { kind: 'CancellationDeferred', state: 'EFFECT_AMBIGUOUS' },
  );
  const settled = await mod.reconcileDraft(
    accepted.operationId, pending.committedRevision, fixture.ports,
  );
  assertTerminal(settled, 'REUSED');
  assert.equal(provider.count('createDraft'), 1, 'ambiguous recovery never blindly retries');
});

test('R10 lookup and create transport failures expose only closed redacted categories', async () => {
  const mod = await api('R10 redacted provider errors');
  const raw = 'token=ghp_super_secret path=C:\\Users\\operator\\.ssh url=https://provider.invalid/private';

  const lookupProvider = fakeProvider({ lookup: () => { throw new Error(raw); } });
  const lookupFixture = await harness(mod, { provider: lookupProvider });
  const lookupAccepted = assertEnqueued(await enqueue(mod, lookupFixture));
  const lookupResult = await mod.reconcileDraft(
    lookupAccepted.operationId, lookupAccepted.committedRevision, lookupFixture.ports,
  );
  assertTerminal(lookupResult, 'REFUSED');
  assert.equal(lookupResult.refusal, 'ProviderUnavailable');
  assert.ok(!JSON.stringify(lookupResult).includes(raw));
  assert.ok(!JSON.stringify(lookupFixture.telemetry.events).includes('ghp_super_secret'));

  const createProvider = fakeProvider({ create: () => { throw new Error(raw); } });
  const createFixture = await harness(mod, { provider: createProvider });
  const createAccepted = assertEnqueued(await enqueue(mod, createFixture));
  const createResult = await mod.reconcileDraft(
    createAccepted.operationId, createAccepted.committedRevision, createFixture.ports,
  );
  assert.equal(createResult.kind, 'Pending');
  assert.equal(createResult.state, 'EFFECT_AMBIGUOUS');
  assert.equal(createResult.providerError, 'ProviderAmbiguous');
  assert.ok(!JSON.stringify(createResult).includes(raw));
  assert.ok(!JSON.stringify(createFixture.telemetry.events).includes('ghp_super_secret'));
});

test('R11 fixed inputs replay byte-identically with one coherent terminal revision', async () => {
  const mod = await api('R11 deterministic terminal');
  const run = async () => {
    const fixture = await harness(mod);
    const accepted = assertEnqueued(await enqueue(mod, fixture));
    return mod.reconcileDraft(accepted.operationId, accepted.committedRevision, fixture.ports);
  };
  const first = assertTerminal(await run(), 'CREATED');
  const second = assertTerminal(await run(), 'CREATED');
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.observedSourceRevision, SHA_B);
});
