/**
 * lane-generation-bootstrap.test.mjs — the R0 contract suite for issue #93, gates B1-B18 of
 * `docs/lane-generation-bootstrap.md`.
 *
 * Everything here runs against a deterministic fake lane provider and an in-memory generation
 * store. No wmux, no Claude, no Codex, no Docker, no network, no `C:\tmp`, no live terminal, and
 * no clock the test does not supply. That is the point: the transition rules issue #93 needs are
 * the module's, not the multiplexer's, so they must be provable without one.
 *
 * Most of these tests assert what the module REFUSES to publish. The 2026-09-01 failure was not a
 * launch that broke; it was a launch that was counted. So the recurring shape is: arrange a world
 * where a launch would look successful to anything that trusts `running`, and assert that no
 * receipt exists, that the visible pane and live agent counts are exactly what they were before,
 * and that the unrelated `Music` workspace was never even addressed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LANE_AUTHENTICATION_MODES,
  LANE_BOOTSTRAP_REFUSALS,
  LANE_GENERATION_MANIFEST_SCHEMA,
  LANE_GENERATION_RECORD_SCHEMA,
  LANE_LAUNCH_RECEIPT_SCHEMA,
  LANE_PROVIDER_CAPABILITY_SCHEMA,
  LaneGenerationError,
  bootstrapLaneGeneration,
  canonicalLaneJson,
  createMemoryLaneGenerationStore,
  laneGenerationIdentity,
  laneManifestRevision,
  requireLaneGenerationManifest,
  requireLaneProviderCapability,
  verifyLaneLaunchReceipt,
} from '../src/lane-generation-bootstrap.mjs';
import { FOREIGN_WORKSPACE, createFakeLaneProvider } from './fixtures/fake-lane-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_SOURCE = join(HERE, '..', 'src', 'lane-generation-bootstrap.mjs');

const WORKSPACE = 'ws-bootstrap';
const SPAWNED_AT = '2026-09-01T12:00:00.000Z';
const OBSERVED_AT = '2026-09-01T12:00:10.000Z';

const seal = (base) => ({ ...base, revision: laneManifestRevision(base) });

function manifestBody(overrides = {}) {
  return {
    schema: LANE_GENERATION_MANIFEST_SCHEMA,
    repository: 'GuitarAlchemist/gaia',
    workItem: { kind: 'ISSUE', number: 93 },
    workspaceId: WORKSPACE,
    generationOrdinal: 1,
    providerId: 'fake-lane-provider',
    policy: {
      startupDeadlineMs: 60_000,
      ttlMs: 3_600_000,
      retryBudget: 2,
      cleanupPolicy: 'COMPENSATE_OWN_RESOURCES',
    },
    lanes: [
      {
        laneId: 'lane-implementer',
        role: 'IMPLEMENTER',
        subject: { kind: 'BRANCH', name: 'codex/wmux-bootstrapper-r0' },
        supervisor: 'lane-supervisor',
        artifactMarker: 'artifact-implementer',
      },
      {
        laneId: 'lane-supervisor',
        role: 'SUPERVISOR',
        subject: { kind: 'REVISION', name: 'a'.repeat(40) },
        supervisor: 'OPERATOR',
        artifactMarker: 'artifact-supervisor',
      },
    ],
    ...overrides,
  };
}

const manifest = (overrides) => seal(manifestBody(overrides));

function harness(options = {}) {
  const fake = createFakeLaneProvider({
    workspaceId: WORKSPACE,
    clock: () => SPAWNED_AT,
    ...options,
  });
  const store = options.store ?? createMemoryLaneGenerationStore();
  const ports = {
    store,
    provider: fake.provider,
    actor: options.actor ?? 'actor-alpha',
    now: options.now ?? (() => OBSERVED_AT),
  };
  return { fake, store, ports };
}

/** Wrap a store so one commit can be lost exactly the way a crashed host loses one. */
function losingStore(inner, { loseCommitToState }) {
  let lost = false;
  return {
    execute: (workKey, operation) => inner.execute(workKey, operation),
    read: (workKey) => inner.read(workKey),
    commit: async (workKey, expectedRevision, record) => {
      if (!lost && record.state === loseCommitToState) {
        lost = true;
        throw new Error('STORE_RESPONSE_LOST');
      }
      return inner.commit(workKey, expectedRevision, record);
    },
  };
}

/** Wrap a store so a competitor commits between our read and our compare-and-set. */
function racingStore(inner, competitor) {
  let raced = false;
  return {
    execute: (workKey, operation) => inner.execute(workKey, operation),
    read: (workKey) => inner.read(workKey),
    commit: async (workKey, expectedRevision, record) => {
      if (!raced) {
        raced = true;
        await inner.commit(workKey, expectedRevision, competitor(record));
      }
      return inner.commit(workKey, expectedRevision, record);
    },
  };
}

/** Wrap a store so one commit lands durably but its response never reaches the caller. */
function lostResponseStore(inner, { loseResponseToState }) {
  let lost = false;
  return {
    execute: (workKey, operation) => inner.execute(workKey, operation),
    read: (workKey) => inner.read(workKey),
    commit: async (workKey, expectedRevision, record) => {
      const committed = await inner.commit(workKey, expectedRevision, record);
      if (!lost && record.state === loseResponseToState) {
        lost = true;
        throw new Error('STORE_RESPONSE_LOST');
      }
      return committed;
    },
  };
}

const baselinePanes = 1;
const baselineAgents = 1;

// ---------------------------------------------------------------------------
// B1 — the manifest is closed, sealed, and its reporting edge is a graph
// ---------------------------------------------------------------------------

test('B1: a manifest carrying an unknown field is refused, never trimmed', () => {
  const body = { ...manifestBody(), owner: 'spareilleux' };
  assert.throws(() => requireLaneGenerationManifest(seal(body)), LaneGenerationError);
});

test('B1: a manifest edited after sealing does not validate', () => {
  const sealed = manifest();
  const tampered = { ...sealed, generationOrdinal: 7 };
  assert.throws(() => requireLaneGenerationManifest(tampered), LaneGenerationError);
});

test('B1: a supervisor that names no lane in this manifest is refused', () => {
  const lanes = manifestBody().lanes.map((lane) => (
    lane.laneId === 'lane-implementer' ? { ...lane, supervisor: 'lane-ghost' } : lane
  ));
  assert.throws(() => requireLaneGenerationManifest(manifest({ lanes })), LaneGenerationError);
});

test('B1: a reporting cycle is refused', () => {
  const lanes = manifestBody().lanes.map((lane) => (
    lane.laneId === 'lane-supervisor' ? { ...lane, supervisor: 'lane-implementer' } : lane
  ));
  assert.throws(() => requireLaneGenerationManifest(manifest({ lanes })), LaneGenerationError);
});

test('B1: a generation with no lane reporting to the operator is refused', () => {
  const lanes = [{
    laneId: 'lane-a',
    role: 'IMPLEMENTER',
    subject: { kind: 'BRANCH', name: 'codex/x' },
    supervisor: 'lane-b',
    artifactMarker: 'artifact-a',
  }, {
    laneId: 'lane-b',
    role: 'REVIEWER',
    subject: { kind: 'BRANCH', name: 'codex/y' },
    supervisor: 'lane-a',
    artifactMarker: 'artifact-b',
  }];
  assert.throws(() => requireLaneGenerationManifest(manifest({ lanes })), LaneGenerationError);
});

test('B1: duplicate lane identities, unknown roles and unknown subject kinds are refused', () => {
  const duplicate = manifestBody().lanes.map((lane) => ({ ...lane, laneId: 'lane-same' }));
  assert.throws(() => requireLaneGenerationManifest(manifest({ lanes: duplicate })), LaneGenerationError);

  const badRole = manifestBody().lanes.map((lane, index) => (
    index === 0 ? { ...lane, role: 'ARCHITECT' } : lane
  ));
  assert.throws(() => requireLaneGenerationManifest(manifest({ lanes: badRole })), LaneGenerationError);

  const badSubject = manifestBody().lanes.map((lane, index) => (
    index === 0 ? { ...lane, subject: { kind: 'TAG', name: 'v1' } } : lane
  ));
  assert.throws(() => requireLaneGenerationManifest(manifest({ lanes: badSubject })), LaneGenerationError);
});

test('B1: a valid manifest round-trips and is deeply frozen', () => {
  const validated = requireLaneGenerationManifest(manifest());
  assert.equal(validated.schema, LANE_GENERATION_MANIFEST_SCHEMA);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.lanes[0]));
  assert.throws(() => { validated.lanes[0].role = 'REVIEWER'; }, TypeError);
});

// ---------------------------------------------------------------------------
// B2 — identity is derived from content, twice, the same way
// ---------------------------------------------------------------------------

test('B2: the same manifest yields the same work, generation and operation identities', () => {
  const first = laneGenerationIdentity(requireLaneGenerationManifest(manifest()));
  const second = laneGenerationIdentity(requireLaneGenerationManifest(manifest()));
  assert.deepEqual(first, second);
  assert.match(first.generationId, /^[0-9a-f]{64}$/);
  assert.match(first.operationId, /^[0-9a-f]{64}$/);
  assert.match(first.workKey, /^[0-9a-f]{64}$/);
});

test('B2: a new ordinal is a new generation and the same work identity', () => {
  const one = laneGenerationIdentity(requireLaneGenerationManifest(manifest()));
  const two = laneGenerationIdentity(
    requireLaneGenerationManifest(manifest({ generationOrdinal: 2 })),
  );
  assert.equal(one.workKey, two.workKey);
  assert.notEqual(one.generationId, two.generationId);
  assert.notEqual(one.operationId, two.operationId);
});

test('B2: changing any lane changes the generation identity', () => {
  const lanes = manifestBody().lanes.map((lane, index) => (
    index === 0
      ? { ...lane, subject: { kind: 'BRANCH', name: 'codex/other' } }
      : lane
  ));
  const one = laneGenerationIdentity(requireLaneGenerationManifest(manifest()));
  const two = laneGenerationIdentity(requireLaneGenerationManifest(manifest({ lanes })));
  assert.equal(one.workKey, two.workKey);
  assert.notEqual(one.generationId, two.generationId);
});

// ---------------------------------------------------------------------------
// B3 — the complete topology exists before any process does
// ---------------------------------------------------------------------------

test('B3: every pane of the generation is created before the first spawn', async () => {
  const { fake, ports } = harness();
  const result = await bootstrapLaneGeneration(manifest(), ports);
  assert.equal(result.outcome, 'LAUNCH_RECEIPT_PUBLISHED');

  const ops = fake.operations();
  const firstSpawn = ops.indexOf('spawn');
  const topology = ops.indexOf('createTopology');
  assert.ok(topology >= 0, 'topology was built');
  assert.ok(firstSpawn > topology, 'no process exists before the grid does');
  assert.equal(ops.filter((op) => op === 'createTopology').length, 1);
  assert.equal(ops.filter((op) => op === 'spawn').length, 2);
  assert.equal(fake.journal.find((entry) => entry.op === 'createTopology').laneCount, 2);
});

test('B3: a published receipt describes one pane, one surface and one agent per lane', async () => {
  const { fake, ports } = harness();
  const { receipt } = await bootstrapLaneGeneration(manifest(), ports);

  assert.equal(receipt.schema, LANE_LAUNCH_RECEIPT_SCHEMA);
  assert.equal(receipt.lanes.length, 2);
  const paneIds = new Set(receipt.lanes.map((lane) => lane.paneId));
  const surfaceIds = new Set(receipt.lanes.map((lane) => lane.surfaceId));
  const agentIds = new Set(receipt.lanes.map((lane) => lane.agentId));
  assert.equal(paneIds.size, 2);
  assert.equal(surfaceIds.size, 2);
  assert.equal(agentIds.size, 2);
  for (const lane of receipt.lanes) {
    const pane = fake.panes().find((candidate) => candidate.paneId === lane.paneId);
    assert.equal(pane.surfaceIds.length, 1, 'exactly one terminal surface');
    assert.equal(pane.surfaceIds[0], lane.surfaceId);
  }
  assert.equal(fake.livePaneCount(), baselinePanes + 2);
  assert.equal(fake.liveAgentCount(), baselineAgents + 2);
});

// ---------------------------------------------------------------------------
// B4 / B17 — the capability descriptor is the only thing a provider may say
// ---------------------------------------------------------------------------

test('B4: a descriptor missing a required capability is refused before any pane exists', async () => {
  const { fake, ports } = harness({
    capability: { capabilities: ['OBSERVE', 'SPAWN', 'TOPOLOGY'] },
  });
  const result = await bootstrapLaneGeneration(manifest(), ports);
  assert.equal(result.outcome, 'REFUSED');
  assert.equal(result.refusal, 'CAPABILITY_INSUFFICIENT');
  assert.deepEqual(fake.mutations(), []);
  assert.equal(fake.livePaneCount(), baselinePanes);
});

test('B4: an unknown authentication mode and an unknown descriptor field are refused', () => {
  const base = {
    schema: LANE_PROVIDER_CAPABILITY_SCHEMA,
    providerId: 'p',
    capabilities: ['CLOSE_PANE', 'OBSERVE', 'OPERATION_MARKER', 'REAP', 'SPAWN', 'STOP', 'TOPOLOGY'],
    authenticationMode: 'AMBIENT_SESSION',
    costObservation: { basis: 'UNOBSERVED', remainingUnits: null },
    evidenceContract: { kind: 'STRUCTURED_PROCESS_IDENTITY', startupDeadlineMs: 60_000 },
    limits: { maxLanes: 4 },
  };
  assert.ok(requireLaneProviderCapability(base));
  assert.throws(
    () => requireLaneProviderCapability({ ...base, authenticationMode: 'API_KEY' }),
    LaneGenerationError,
  );
  assert.throws(
    () => requireLaneProviderCapability({ ...base, credential: 'x' }),
    LaneGenerationError,
  );
  assert.ok(!LANE_AUTHENTICATION_MODES.some((mode) => /credential|secret|token|key/i.test(mode)));
});

test('B4: a declared quota below the generation refuses before spawning anything', async () => {
  const { fake, ports } = harness({
    capability: { costObservation: { basis: 'DECLARED_UNITS', remainingUnits: 1 } },
  });
  const result = await bootstrapLaneGeneration(manifest(), ports);
  assert.equal(result.outcome, 'REFUSED');
  assert.equal(result.refusal, 'QUOTA_INSUFFICIENT');
  assert.deepEqual(fake.mutations(), []);
});

test('B4: a generation wider than the declared or measured lane limit is refused', async () => {
  const narrow = harness({ capability: { limits: { maxLanes: 1 } } });
  const first = await bootstrapLaneGeneration(manifest(), narrow.ports);
  assert.equal(first.refusal, 'LANE_LIMIT_EXCEEDED');
  assert.deepEqual(narrow.fake.mutations(), []);

  const wide = harness({ capability: { limits: { maxLanes: 8 } } });
  const lanes = ['a', 'b', 'c', 'd', 'e'].map((suffix) => ({
    laneId: `lane-${suffix}`,
    role: 'IMPLEMENTER',
    subject: { kind: 'BRANCH', name: `codex/${suffix}` },
    supervisor: 'OPERATOR',
    artifactMarker: `artifact-${suffix}`,
  }));
  const second = await bootstrapLaneGeneration(manifest({ lanes }), wide.ports);
  assert.equal(second.refusal, 'LANE_LIMIT_EXCEEDED');
  assert.deepEqual(wide.fake.mutations(), []);
});

test('B4: a provider that answers for a different identity than the manifest declared is refused', async () => {
  const { fake, ports } = harness({ providerId: 'some-other-provider' });
  const result = await bootstrapLaneGeneration(manifest(), ports);
  assert.equal(result.refusal, 'CAPABILITY_INSUFFICIENT');
  assert.deepEqual(fake.mutations(), []);
});

test('B17: two providers differing only in identity decide identically', async () => {
  const alpha = harness({ providerId: 'claude-shaped-provider' });
  const beta = harness({ providerId: 'gemini-shaped-provider' });
  const one = await bootstrapLaneGeneration(
    manifest({ providerId: 'claude-shaped-provider' }), alpha.ports,
  );
  const two = await bootstrapLaneGeneration(
    manifest({ providerId: 'gemini-shaped-provider' }), beta.ports,
  );
  assert.equal(one.outcome, 'LAUNCH_RECEIPT_PUBLISHED');
  assert.equal(two.outcome, 'LAUNCH_RECEIPT_PUBLISHED');
  assert.deepEqual(alpha.fake.operations(), beta.fake.operations());
  const normalize = (receipt) => canonicalLaneJson({
    ...receipt, providerId: 'X', workKey: 'X', generationId: 'X', operationId: 'X', revision: 'X',
  });
  assert.equal(normalize(one.receipt), normalize(two.receipt));
});

test('B17: an evidence contract of declared artifact markers is honoured, not hardcoded', async () => {
  const { fake, ports } = harness({
    capability: { evidenceContract: { kind: 'DECLARED_ARTIFACT_MARKER', startupDeadlineMs: 60_000 } },
    faults: { omitProcessIdentityOnLane: 'ALL' },
  });
  const result = await bootstrapLaneGeneration(manifest(), ports);
  assert.equal(result.outcome, 'LAUNCH_RECEIPT_PUBLISHED');
  assert.equal(result.receipt.evidenceKind, 'DECLARED_ARTIFACT_MARKER');
  assert.equal(fake.liveAgentCount(), baselineAgents + 2);
});

test('B17: a declared-marker provider that never registers the marker is refused', async () => {
  const { fake, ports } = harness({
    capability: { evidenceContract: { kind: 'DECLARED_ARTIFACT_MARKER', startupDeadlineMs: 60_000 } },
    faults: { omitEvidenceMarkerOnLane: 'lane-supervisor' },
  });
  const result = await bootstrapLaneGeneration(manifest(), ports);
  assert.equal(result.refusal, 'PROCESS_ABSENT');
  assert.equal(fake.livePaneCount(), baselinePanes);
  assert.equal(fake.liveAgentCount(), baselineAgents);
});

// ---------------------------------------------------------------------------
// B5 / B6 — one winner, and stale losers with no effect
// ---------------------------------------------------------------------------

test('B5: overlapping same-actor resume cannot spawn a duplicate lane', async () => {
  const { fake, ports } = harness();
  let entered;
  let release;
  let paused = false;
  const reached = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const provider = {
    ...fake.provider,
    async spawn(request) {
      const result = await fake.provider.spawn(request);
      if (!paused) { paused = true; entered(); await barrier; }
      return result;
    },
  };
  const first = bootstrapLaneGeneration(manifest(), { ...ports, provider });
  await reached;
  let second;
  let before;
  let after;
  try {
    before = fake.operations();
    second = await bootstrapLaneGeneration(manifest(), { ...ports, provider });
    after = fake.operations();
  } finally { release(); }
  const winner = await first;
  assert.equal(second.refusal, 'EXECUTION_HELD');
  assert.deepEqual(after, before, 'contender performs no provider call');
  assert.equal(winner.outcome, 'LAUNCH_RECEIPT_PUBLISHED');
  assert.equal(fake.operations().filter(operation => operation === 'spawn').length, 2);
  assert.equal(fake.liveAgentCount(), baselineAgents + 2);
  const replay = await bootstrapLaneGeneration(manifest(), { ...ports, provider });
  assert.equal(replay.outcome, 'LAUNCH_RECEIPT_REPLAYED');
  assert.deepEqual(replay.receipt, winner.receipt);
});

test('B5: a second actor meeting a held claim performs no effect at all', async () => {
  const store = createMemoryLaneGenerationStore();
  const alpha = harness({
    store: losingStore(store, { loseCommitToState: 'IN_FLIGHT' }),
    actor: 'actor-alpha',
  });
  await assert.rejects(() => bootstrapLaneGeneration(manifest(), alpha.ports));

  const beta = harness({ store, actor: 'actor-beta' });
  const result = await bootstrapLaneGeneration(manifest(), beta.ports);
  assert.equal(result.outcome, 'REFUSED');
  assert.equal(result.refusal, 'CLAIM_HELD');
  assert.deepEqual(beta.fake.mutations(), []);
});

test('B5: admission exclusion spans actors and ordinals but not unrelated work', async () => {
  const { fake, store, ports } = harness();
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const provider = {
    ...fake.provider,
    async describe() { entered(); await barrier; return fake.provider.describe(); },
  };
  const owner = bootstrapLaneGeneration(manifest(), { ...ports, provider });
  await reached;
  const outcomes = [];
  const before = fake.operations();
  let independent;
  try {
    outcomes.push(await bootstrapLaneGeneration(manifest(), { ...ports, actor: 'actor-beta' }));
    outcomes.push(await bootstrapLaneGeneration(manifest({ generationOrdinal: 2 }), ports));
    const other = harness({ store, workspaceId: 'ws-independent' });
    independent = await bootstrapLaneGeneration(manifest({ workspaceId: 'ws-independent' }), other.ports);
  } finally { release(); }
  const first = await owner;
  assert.deepEqual(outcomes.map(result => result.refusal), ['EXECUTION_HELD', 'EXECUTION_HELD']);
  assert.equal(independent.outcome, 'LAUNCH_RECEIPT_PUBLISHED');
  assert.deepEqual(before, [], 'owner is paused before its first provider observation');
  assert.equal(first.outcome, 'LAUNCH_RECEIPT_PUBLISHED');
  assert.equal(fake.operations().filter(operation => operation === 'spawn').length, 2);
});

test('B5: a store without an execution boundary fails closed before provider access', async () => {
  const { fake, store, ports } = harness();
  const { execute, ...unprotectedStore } = store;
  await assert.rejects(
    () => bootstrapLaneGeneration(manifest(), { ...ports, store: unprotectedStore }),
    { code: 'PORTS_STORE_INVALID' },
  );
  assert.deepEqual(fake.operations(), []);
});

test('B5: losing the claim compare-and-set performs no effect', async () => {
  const inner = createMemoryLaneGenerationStore();
  const { fake, ports } = harness({
    store: racingStore(inner, (record) => ({ ...record, actor: 'actor-competitor' })),
  });
  const result = await bootstrapLaneGeneration(manifest(), ports);
  assert.equal(result.outcome, 'REFUSED');
  assert.equal(result.refusal, 'STALE_REVISION');
  assert.deepEqual(fake.mutations(), []);
  assert.equal(fake.livePaneCount(), baselinePanes);
});

test('B6: a stale generation ordinal performs no effect', async () => {
  const store = createMemoryLaneGenerationStore();
  const first = harness({ store });
  const published = await bootstrapLaneGeneration(manifest({ generationOrdinal: 2 }), first.ports);
  assert.equal(published.outcome, 'LAUNCH_RECEIPT_PUBLISHED');

  const second = harness({ store });
  const stale = await bootstrapLaneGeneration(manifest({ generationOrdinal: 1 }), second.ports);
  assert.equal(stale.outcome, 'REFUSED');
  assert.equal(stale.refusal, 'STALE_GENERATION');
  assert.deepEqual(second.fake.mutations(), []);
});

test('B6: a different generation at the same ordinal is a stale competitor, not a launch', async () => {
  const store = createMemoryLaneGenerationStore();
  const first = harness({ store });
  await bootstrapLaneGeneration(manifest(), first.ports);

  const lanes = manifestBody().lanes.map((lane, index) => (
    index === 0 ? { ...lane, artifactMarker: 'artifact-elsewhere' } : lane
  ));
  const second = harness({ store });
  const result = await bootstrapLaneGeneration(manifest({ lanes }), second.ports);
  assert.equal(result.refusal, 'STALE_GENERATION');
  assert.deepEqual(second.fake.mutations(), []);
});

test('B6: a newer ordinal does not silently supersede a live generation in R0', async () => {
  const store = createMemoryLaneGenerationStore();
  const first = harness({ store });
  await bootstrapLaneGeneration(manifest(), first.ports);

  const second = harness({ store });
  const result = await bootstrapLaneGeneration(manifest({ generationOrdinal: 2 }), second.ports);
  assert.equal(result.outcome, 'REFUSED');
  assert.equal(result.refusal, 'ACTIVE_GENERATION_PRESENT');
  assert.deepEqual(second.fake.mutations(), []);
});

// ---------------------------------------------------------------------------
// B7 / B8 — exact compensation, and nothing beyond it
// ---------------------------------------------------------------------------

test('B20: incomplete cleanup blocks successors and resumes cleanup without spawning', async () => {
  const { fake, store, ports } = harness({ faults: { omitReportingParentOnLane: 'ALL' } });
  const unavailable = async () => { throw new Error('TEMPORARY_CLEANUP_FAILURE'); };
  const first = await bootstrapLaneGeneration(manifest(), {
    ...ports,
    provider: { ...fake.provider, stopAgent: unavailable, reapSurface: unavailable, closePane: unavailable },
  });
  assert.equal(first.compensation.incomplete, true);
  const identity = laneGenerationIdentity(manifest());
  assert.equal((await store.read(identity.workKey)).record.state, 'COMPENSATING');
  const spawns = fake.operations().filter(op => op === 'spawn').length;
  const mutations = fake.mutations().length;
  const successor = await bootstrapLaneGeneration(manifest({ generationOrdinal: 2 }), ports);
  assert.equal(successor.refusal, 'CLAIM_HELD');
  assert.equal(fake.mutations().length, mutations, 'unsettled cleanup admits no successor effects');
  const recovered = await bootstrapLaneGeneration(manifest(), ports);
  assert.equal(recovered.refusal, 'GENERATION_COMPENSATED');
  assert.equal(recovered.compensation.incomplete, false);
  assert.equal(fake.operations().filter(op => op === 'spawn').length, spawns);
  assert.equal(fake.livePaneCount(), baselinePanes);
  assert.equal(fake.liveAgentCount(), baselineAgents);
  assert.equal((await store.read(identity.workKey)).record.state, 'COMPENSATED');
});

test('B20: cleanup acknowledgements without removal never settle the generation', async () => {
  const { fake, store, ports } = harness({ faults: { omitReportingParentOnLane: 'ALL' } });
  const first = await bootstrapLaneGeneration(manifest(), {
    ...ports,
    provider: {
      ...fake.provider,
      stopAgent: async () => ({ stopped: true }),
      reapSurface: async () => ({ reaped: true }),
      closePane: async () => ({ closed: true }),
    },
  });
  assert.equal(first.refusal, 'CLEANUP_INCOMPLETE');
  assert.equal((await store.read(laneGenerationIdentity(manifest()).workKey)).record.state, 'COMPENSATING');
  const recovered = await bootstrapLaneGeneration(manifest(), ports);
  assert.equal(recovered.refusal, 'GENERATION_COMPENSATED');
  assert.equal(fake.livePaneCount(), baselinePanes);
  assert.equal(fake.liveAgentCount(), baselineAgents);
});

test('B20: a lost cleanup-intent response resumes cleanup instead of startup', async () => {
  const { fake, store, ports } = harness({ faults: { omitReportingParentOnLane: 'ALL' } });
  await assert.rejects(() => bootstrapLaneGeneration(manifest(), {
    ...ports, store: lostResponseStore(store, { loseResponseToState: 'COMPENSATING' }),
  }), /STORE_RESPONSE_LOST/);
  const spawns = fake.operations().filter(op => op === 'spawn').length;
  const recovered = await bootstrapLaneGeneration(manifest(), ports);
  assert.equal(recovered.refusal, 'GENERATION_COMPENSATED');
  assert.equal(fake.operations().filter(op => op === 'spawn').length, spawns);
  assert.equal(fake.livePaneCount(), baselinePanes);
  assert.equal(fake.liveAgentCount(), baselineAgents);
});

test('B7: a partial spawn failure leaves the visible and live counts unchanged', async () => {
  const { fake, store, ports } = harness({ faults: { spawnThrowsOnLane: 'lane-supervisor' } });
  const result = await bootstrapLaneGeneration(manifest(), ports);

  assert.equal(result.outcome, 'REFUSED');
  assert.equal(result.refusal, 'SPAWN_FAILED');
  assert.equal(result.subject, 'lane-supervisor');
  assert.equal(fake.livePaneCount(), baselinePanes);
  assert.equal(fake.liveAgentCount(), baselineAgents);
  assert.equal(result.compensation.panesClosed, 2);
  assert.equal(result.compensation.agentsStopped, 1);
  assert.equal(result.compensation.incomplete, false);

  const identity = laneGenerationIdentity(requireLaneGenerationManifest(manifest()));
  const head = await store.read(identity.workKey);
  assert.equal(head.record.schema, LANE_GENERATION_RECORD_SCHEMA);
  assert.equal(head.record.state, 'COMPENSATED');
  assert.equal(head.record.receipt, null);
});

test('B8: compensation never addresses a resource this operation did not create', async () => {
  const { fake, ports } = harness({ faults: { spawnThrowsOnLane: 'lane-supervisor' } });
  await bootstrapLaneGeneration(manifest(), ports);

  const touched = fake.journal.filter((entry) => ['stopAgent', 'reapSurface', 'closePane'].includes(entry.op));
  for (const entry of touched) {
    assert.notEqual(entry.paneId, FOREIGN_WORKSPACE.paneId);
    assert.notEqual(entry.agentId, FOREIGN_WORKSPACE.agentId);
    assert.notEqual(entry.surfaceId, FOREIGN_WORKSPACE.surfaceId);
  }
  const music = fake.panes().find((pane) => pane.paneId === FOREIGN_WORKSPACE.paneId);
  assert.deepEqual(music.surfaceIds, [FOREIGN_WORKSPACE.surfaceId]);
  const musicAgent = fake.agents().find((agent) => agent.agentId === FOREIGN_WORKSPACE.agentId);
  assert.equal(musicAgent.lifecycle, 'RUNNING');
});

test('B7: a topology that does not match the generation is compensated, not launched', async () => {
  const { fake, ports } = harness({ faults: { topologyPaneCount: 1 } });
  const result = await bootstrapLaneGeneration(manifest(), ports);
  assert.equal(result.refusal, 'TOPOLOGY_MISMATCH');
  assert.equal(fake.operations().includes('spawn'), false);
  assert.equal(fake.livePaneCount(), baselinePanes);
});

// ---------------------------------------------------------------------------
// B9-B13 — the postconditions that make the receipt a linearization point
// ---------------------------------------------------------------------------

const postcondition = (name, faults, refusal, options = {}) => {
  test(`${name}`, async () => {
    const { fake, store, ports } = harness({ faults, ...options });
    const result = await bootstrapLaneGeneration(manifest(), ports);
    assert.equal(result.outcome, 'REFUSED');
    assert.equal(result.refusal, refusal);
    assert.equal(fake.livePaneCount(), baselinePanes, 'visible pane count unchanged');
    assert.equal(fake.liveAgentCount(), baselineAgents, 'live agent count unchanged');
    const identity = laneGenerationIdentity(requireLaneGenerationManifest(manifest()));
    const head = await store.read(identity.workKey);
    assert.equal(head.record.state, 'COMPENSATED');
    assert.equal(head.record.receipt, null);
  });
};

postcondition(
  'B9: a pane carrying a stacked second surface never publishes a receipt',
  { stackSurfaceOnLane: 'lane-implementer' },
  'STACKED_SURFACE',
);

postcondition(
  'B10: an agent whose returned pane is not the pane it was asked for never publishes',
  { spawnReturnsPaneIdOnLane: 'lane-implementer' },
  'SURFACE_MISMATCH',
);

postcondition(
  'B10: an agent whose pane vanished before verification never publishes',
  { deletePaneOnLane: 'lane-implementer' },
  'PANE_ABSENT',
);

postcondition(
  'B11: a process that exited before verification never publishes',
  { exitLane: 'lane-supervisor' },
  'PROCESS_ABSENT',
);

postcondition(
  'B11: an agent with no structured process identity never publishes',
  { omitProcessIdentityOnLane: 'lane-supervisor' },
  'PROCESS_ABSENT',
);

postcondition(
  'B12: a startup older than the deadline never publishes',
  { startedAtByLane: { 'lane-supervisor': '2026-09-01T11:00:00.000Z' } },
  'STARTUP_TIMEOUT',
);

postcondition(
  'B13: a layout that moved during spawn never publishes',
  { expandGridOnLane: 'lane-implementer' },
  'LAYOUT_CHANGED',
);

postcondition(
  'B16: a lane whose reporting edge was never registered never publishes',
  { omitReportingParentOnLane: 'lane-implementer' },
  'REPORTING_EDGE_MISSING',
);

test('B12: the provider may narrow the declared startup deadline but never widen it', async () => {
  const strict = harness({
    capability: { evidenceContract: { kind: 'STRUCTURED_PROCESS_IDENTITY', startupDeadlineMs: 1_000 } },
  });
  const result = await bootstrapLaneGeneration(manifest(), strict.ports);
  assert.equal(result.refusal, 'STARTUP_TIMEOUT');

  const lax = harness({
    capability: { evidenceContract: { kind: 'STRUCTURED_PROCESS_IDENTITY', startupDeadlineMs: 900_000 } },
  });
  const narrowed = await bootstrapLaneGeneration(
    manifest({ policy: { ...manifestBody().policy, startupDeadlineMs: 1_000 } }),
    lax.ports,
  );
  assert.equal(narrowed.refusal, 'STARTUP_TIMEOUT');
});

// ---------------------------------------------------------------------------
// B14 / B15 — replay, resumption and idempotence
// ---------------------------------------------------------------------------

test('B14: a replay after a lost response adopts its own resources instead of creating more', async () => {
  const store = createMemoryLaneGenerationStore();
  const fake = createFakeLaneProvider({ workspaceId: WORKSPACE, clock: () => SPAWNED_AT });
  const basePorts = { provider: fake.provider, actor: 'actor-alpha', now: () => OBSERVED_AT };

  await assert.rejects(
    () => bootstrapLaneGeneration(manifest(), {
      ...basePorts, store: losingStore(store, { loseCommitToState: 'ACTIVE' }),
    }),
    /STORE_RESPONSE_LOST/,
  );
  assert.equal(fake.livePaneCount(), baselinePanes + 2);
  assert.equal(fake.liveAgentCount(), baselineAgents + 2);
  const spawnsBefore = fake.operations().filter((op) => op === 'spawn').length;
  assert.equal(spawnsBefore, 2);

  const resumed = await bootstrapLaneGeneration(manifest(), { ...basePorts, store });
  assert.equal(resumed.outcome, 'LAUNCH_RECEIPT_PUBLISHED');
  assert.equal(resumed.reconciliation, 'RESUMED');
  assert.equal(fake.operations().filter((op) => op === 'spawn').length, spawnsBefore);
  assert.equal(fake.operations().filter((op) => op === 'createTopology').length, 1);
  assert.equal(fake.livePaneCount(), baselinePanes + 2);
  assert.equal(fake.liveAgentCount(), baselineAgents + 2);
});

test('B14: a resume from a recorded but unspawned plan completes the generation instead of throwing', async () => {
  // The crash point between the IN_FLIGHT commit that records the topology and the first spawn:
  // the durable record holds a plan whose every agentId is null, and the store hands it back
  // frozen. The retry must fill its own copy, not write into the store's.
  const store = createMemoryLaneGenerationStore();
  const fake = createFakeLaneProvider({ workspaceId: WORKSPACE, clock: () => SPAWNED_AT });
  const basePorts = { provider: fake.provider, actor: 'actor-alpha', now: () => OBSERVED_AT };

  await assert.rejects(
    () => bootstrapLaneGeneration(manifest(), {
      ...basePorts, store: lostResponseStore(store, { loseResponseToState: 'IN_FLIGHT' }),
    }),
    /STORE_RESPONSE_LOST/,
  );
  const identity = laneGenerationIdentity(requireLaneGenerationManifest(manifest()));
  const crashed = await store.read(identity.workKey);
  assert.equal(crashed.record.state, 'IN_FLIGHT');
  assert.deepEqual(crashed.record.plan.panes.map((entry) => entry.agentId), [null, null]);
  assert.equal(fake.livePaneCount(), baselinePanes + 2);
  assert.equal(fake.liveAgentCount(), baselineAgents);
  assert.equal(fake.operations().filter((op) => op === 'spawn').length, 0);

  const resumed = await bootstrapLaneGeneration(manifest(), { ...basePorts, store });
  assert.equal(resumed.outcome, 'LAUNCH_RECEIPT_PUBLISHED');
  assert.equal(resumed.reconciliation, 'RESUMED');
  assert.equal(fake.operations().filter((op) => op === 'createTopology').length, 1);
  assert.equal(fake.operations().filter((op) => op === 'spawn').length, 2);
  assert.equal(fake.livePaneCount(), baselinePanes + 2);
  assert.equal(fake.liveAgentCount(), baselineAgents + 2);
  const published = await store.read(identity.workKey);
  assert.equal(published.record.state, 'ACTIVE');
  assert.deepEqual(
    crashed.record.plan.panes.map((entry) => entry.agentId), [null, null],
    'the record the store handed out is not written through',
  );

  const replayed = await bootstrapLaneGeneration(manifest(), { ...basePorts, store });
  assert.equal(replayed.outcome, 'LAUNCH_RECEIPT_REPLAYED');
  assert.equal(fake.operations().filter((op) => op === 'spawn').length, 2);
});

// ---------------------------------------------------------------------------
// B19 — the linearization point sits inside the compensating boundary
// ---------------------------------------------------------------------------

test('B19: a clock that yields no exact instant is refused at admission with zero effect', async () => {
  const { fake, store, ports } = harness({ now: () => '2026-09-01 12:00:10' });
  await assert.rejects(() => bootstrapLaneGeneration(manifest(), ports), /PORTS_CLOCK_INVALID/);
  assert.deepEqual(fake.mutations(), [], 'nothing was created for a clock that cannot timestamp');
  assert.equal(fake.livePaneCount(), baselinePanes);
  assert.equal(fake.liveAgentCount(), baselineAgents);
  const identity = laneGenerationIdentity(requireLaneGenerationManifest(manifest()));
  assert.equal(await store.read(identity.workKey), null, 'no record was written at all');
});

/** A provider whose verification snapshot fails once, after every process exists. */
const observationFault = (name, answer) => {
  test(`B19: ${name} after spawn compensates and refuses OBSERVATION_UNAVAILABLE`, async () => {
    const { fake, store, ports } = harness();
    let faulted = false;
    const provider = {
      ...fake.provider,
      snapshot: async (request) => {
        const spawned = fake.operations().filter((op) => op === 'spawn').length;
        if (!faulted && spawned === 2) {
          faulted = true;
          return answer();
        }
        return fake.provider.snapshot(request);
      },
    };
    const result = await bootstrapLaneGeneration(manifest(), { ...ports, provider });
    assert.equal(result.outcome, 'REFUSED');
    assert.equal(result.refusal, 'OBSERVATION_UNAVAILABLE');
    assert.ok(LANE_BOOTSTRAP_REFUSALS.includes(result.refusal), 'the refusal is published');
    assert.equal(result.compensation.agentsStopped, 2);
    assert.equal(result.compensation.panesClosed, 2);
    assert.equal(result.compensation.incomplete, false);
    assert.equal(fake.livePaneCount(), baselinePanes, 'visible pane count unchanged');
    assert.equal(fake.liveAgentCount(), baselineAgents, 'live agent count unchanged');
    const identity = laneGenerationIdentity(requireLaneGenerationManifest(manifest()));
    const head = await store.read(identity.workKey);
    assert.equal(head.record.state, 'COMPENSATED');
    assert.equal(head.record.receipt, null);
  });
};

observationFault('a host that cannot be observed', () => {
  throw new Error('HOST_UNREACHABLE');
});
observationFault('an observation that is not an object', () => null);

test('B15: bootstrapping a published generation twice returns the first receipt and spawns nothing', async () => {
  const store = createMemoryLaneGenerationStore();
  const first = harness({ store });
  const one = await bootstrapLaneGeneration(manifest(), first.ports);

  const second = harness({ store });
  const two = await bootstrapLaneGeneration(manifest(), second.ports);
  assert.equal(two.outcome, 'LAUNCH_RECEIPT_REPLAYED');
  assert.equal(canonicalLaneJson(two.receipt), canonicalLaneJson(one.receipt));
  assert.deepEqual(second.fake.mutations(), []);
  assert.equal(second.fake.livePaneCount(), baselinePanes);
});

test('B15: a compensated generation is terminal at its own ordinal in R0', async () => {
  const store = createMemoryLaneGenerationStore();
  const failing = harness({ store, faults: { spawnThrowsOnLane: 'lane-supervisor' } });
  await bootstrapLaneGeneration(manifest(), failing.ports);

  const retry = harness({ store });
  const result = await bootstrapLaneGeneration(manifest(), retry.ports);
  assert.equal(result.refusal, 'GENERATION_COMPENSATED');
  assert.deepEqual(retry.fake.mutations(), []);
});

test('deterministic replay: two independent runs publish byte-identical receipts', async () => {
  const one = await bootstrapLaneGeneration(manifest(), harness().ports);
  const two = await bootstrapLaneGeneration(manifest(), harness().ports);
  assert.equal(canonicalLaneJson(one.receipt), canonicalLaneJson(two.receipt));
});

// ---------------------------------------------------------------------------
// B16 — the receipt is the evidence, and it refuses to be edited
// ---------------------------------------------------------------------------

test('B16: a receipt carries the persisted reporting edge and artifact marker of every lane', async () => {
  const { receipt } = await bootstrapLaneGeneration(manifest(), harness().ports);
  const declared = requireLaneGenerationManifest(manifest());
  for (const lane of declared.lanes) {
    const published = receipt.lanes.find((entry) => entry.laneId === lane.laneId);
    assert.ok(published, `lane ${lane.laneId} is present`);
    assert.equal(published.supervisor, lane.supervisor);
    assert.equal(published.artifactMarker, lane.artifactMarker);
  }
  assert.equal(receipt.policy.ttlMs, declared.policy.ttlMs);
  assert.equal(receipt.policy.retryBudget, declared.policy.retryBudget);
  assert.equal(receipt.publishedAt, OBSERVED_AT);
});

test('B16: an edited receipt is refused by its own reader', async () => {
  const { receipt } = await bootstrapLaneGeneration(manifest(), harness().ports);
  assert.ok(verifyLaneLaunchReceipt(receipt));
  assert.throws(
    () => verifyLaneLaunchReceipt({ ...receipt, workspaceId: 'Music' }),
    LaneGenerationError,
  );
  const lanes = receipt.lanes.map((lane, index) => (
    index === 0 ? { ...lane, supervisor: 'OPERATOR' } : lane
  ));
  assert.throws(() => verifyLaneLaunchReceipt({ ...receipt, lanes }), LaneGenerationError);
});

// ---------------------------------------------------------------------------
// Mechanism-revert control — the postconditions are what catch the mutants
// ---------------------------------------------------------------------------

test('MECHANISM REVERT: without verification-before-publication every mutant escapes', async () => {
  // A shallow pass-through at the same seam: claim, build, spawn, publish. It is exactly the
  // module minus step 8, and it is what the 2026-09-01 launch effectively was.
  const publishWithoutVerification = async (declared, fake) => {
    const identity = laneGenerationIdentity(requireLaneGenerationManifest(declared));
    const topology = await fake.provider.createTopology({
      workspaceId: declared.workspaceId,
      generationId: identity.generationId,
      operationMarker: identity.operationId,
      laneCount: declared.lanes.length,
    });
    const lanes = [];
    for (const [index, lane] of declared.lanes.entries()) {
      const spawned = await fake.provider.spawn({
        paneId: topology.paneIds[index],
        laneId: lane.laneId,
        role: lane.role,
        subject: lane.subject,
        supervisor: lane.supervisor,
        artifactMarker: lane.artifactMarker,
        operationMarker: identity.operationId,
      });
      lanes.push({ laneId: lane.laneId, ...spawned });
    }
    return { published: true, lanes };
  };

  const mutants = [
    { stackSurfaceOnLane: 'lane-implementer' },
    { exitLane: 'lane-supervisor' },
    { deletePaneOnLane: 'lane-implementer' },
    { expandGridOnLane: 'lane-implementer' },
    { omitReportingParentOnLane: 'lane-implementer' },
    { startedAtByLane: { 'lane-supervisor': '2026-09-01T11:00:00.000Z' } },
  ];

  for (const faults of mutants) {
    const guarded = harness({ faults });
    const refused = await bootstrapLaneGeneration(manifest(), guarded.ports);
    assert.equal(refused.outcome, 'REFUSED', `mutant ${JSON.stringify(faults)} is refused`);

    const reverted = createFakeLaneProvider({ workspaceId: WORKSPACE, clock: () => SPAWNED_AT, faults });
    const escaped = await publishWithoutVerification(manifest(), reverted);
    assert.equal(escaped.published, true, `mutant ${JSON.stringify(faults)} escapes the revert`);
  }
});

// ---------------------------------------------------------------------------
// B18 — source cleanliness at the seam
// ---------------------------------------------------------------------------

test('B18: the module reads no screen, holds no credential and speaks to no network', () => {
  const source = readFileSync(MODULE_SOURCE, 'utf8');
  const forbidden = [
    /node:(net|http|https|dgram|tls|child_process)/, /\bspawnSync\b/, /\bexecSync\b/,
    /\bshell\s*:\s*true\b/, /\bstdout\b/, /\bstderr\b/, /\bscreen\b/, /\bprompt\b/,
    /\bcommandLine\b/, /\bcredential\b/, /\bapiKey\b/, /\btoken\b/, /process\.env/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `module source must not match ${pattern}`);
  }
});

test('B18: the module names no provider product and imports no bus verb', () => {
  const source = readFileSync(MODULE_SOURCE, 'utf8');
  for (const product of ['wmux', 'claude', 'codex', 'gemini', 'antigravity', 'auggie', 'junie']) {
    assert.equal(new RegExp(product, 'i').test(source), false, `module must not name ${product}`);
  }
  assert.equal(/bus-core/.test(source), false);
  for (const verb of ['register', 'inbox', 'handoff', 'heartbeat']) {
    assert.equal(new RegExp(`\\b${verb}\\b`, 'i').test(source), false, `module must not use ${verb}`);
  }
});

test('B18: every refusal the module can return is in the published closed vocabulary', () => {
  const source = readFileSync(MODULE_SOURCE, 'utf8');
  const used = [...source.matchAll(/refuse\('([A-Z_]+)'/g)].map((match) => match[1]);
  assert.ok(used.length > 0, 'the module refuses by name');
  for (const refusal of used) {
    assert.ok(LANE_BOOTSTRAP_REFUSALS.includes(refusal), `${refusal} is published`);
  }
});
