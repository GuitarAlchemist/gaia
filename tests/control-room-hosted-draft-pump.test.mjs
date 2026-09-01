/**
 * control-room-hosted-draft-pump.test.mjs — the hosted Draft pump transition as a published,
 * re-derived, rendered section.
 *
 * The operator failure behind this file is stated in issue #70: "The Control Room therefore cannot
 * distinguish a healthy empty queue from a pump that was never triggered." A drain with no eligible
 * work and a pump that has not ticked in three days currently read the same.
 *
 * The danger in fixing that is the same conflation the CI block exists to refuse: a pump tick is
 * not a unit of delivery. Most of what is asserted here is therefore what the pump section still
 * refuses to touch — the headline beyond one sentence, the next action, the obstruction, the pace,
 * and every count the snapshot already publishes.
 *
 * Two honest positive controls run first, built from the shipped CI-flow and merge-queue-capability
 * blocks. They prove the snapshot seam, the omit-not-null discipline and the render harness all work
 * in this file, so that every failure below isolates a missing hosted-pump mechanism rather than a
 * broken fixture.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  ControlRoomError, buildControlRoomSnapshot, renderControlRoomHtml, requireControlRoomSnapshot,
} from '../src/control-room.mjs';

const MODULE_URL = new URL('../src/hosted-draft-pump-observation.mjs', import.meta.url);

const SHA = 'a'.repeat(64);
const OPERATION_ID = 'b'.repeat(64);
const WORK_KEY = 'c'.repeat(64);
const GENERATION_KEY = 'd'.repeat(64);
const COMMITTED_REVISION = 'e'.repeat(64);
const SOURCE_REVISION = 'f'.repeat(64);
const LEDGER_ROOT_OID = '1'.repeat(40);
const LEDGER_ROOT_REVISION = '2'.repeat(64);

const AT = '2026-09-01T14:50:55.000Z';
const WINDOW_START = '2026-09-01T13:50:55.000Z';
const MINUTE = 60_000;
const at = (msBefore) => new Date(Date.parse(AT) - msBefore).toISOString();

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Reseal a tampered snapshot, so the digest can never stand in for the re-derivation gate. */
const reseal = (body) => {
  const { revision: _revision, ...rest } = body;
  return { ...rest, revision: createHash('sha256').update(canonicalJson(rest)).digest('hex') };
};

function projection(items = [], decisions = []) {
  const body = {
    schema: 'gaia-portfolio-drain-projection/1',
    portfolioRevision: SHA,
    effect: 'NONE',
    authority: 'NONE',
    capacity: 4,
    counts: { occupied: 0, available: 4 },
    items,
    decisions,
  };
  return { ...body, revision: createHash('sha256').update(canonicalJson(body)).digest('hex') };
}

const baseline = (extra = {}) => buildControlRoomSnapshot({
  drainProjection: projection(), observedAt: AT, ...extra,
});

// -----------------------------------------------------------------------------------------------
// Positive controls — the shipped seam, exercised with blocks that already exist.
// -----------------------------------------------------------------------------------------------

test('POSITIVE CONTROL: the snapshot seam omits an absent optional block rather than publishing null', () => {
  const snapshot = baseline();
  requireControlRoomSnapshot(snapshot);
  for (const key of ['ciFlow', 'mergeQueueCapability', 'prReviewThreadGate', 'localLanes']) {
    assert.equal(Object.hasOwn(snapshot, key), false,
      `${key} must be omitted, never carried as null`);
  }
});

test('POSITIVE CONTROL: the render harness produces a control room document from that snapshot', () => {
  const html = renderControlRoomHtml(baseline(), 'en');
  assert.match(html, /<section/u, 'the shipped renderer emits sections');
  assert.equal(/hosted-draft-pump/u.test(html), false,
    'a document published without the artifact carries no residue of the feature');
});

// -----------------------------------------------------------------------------------------------
// The missing module. Every gate below reaches it through `api()`, so a missing export is named.
// -----------------------------------------------------------------------------------------------

const moduleResult = import(MODULE_URL).catch((loadError) => ({ loadError }));

const EXPORTS = [
  'HOSTED_DRAFT_PUMP_SCHEMA', 'HOSTED_DRAFT_PUMP_SOURCE', 'HOSTED_DRAFT_PUMP_STATES',
  'HOSTED_DRAFT_PUMP_BLOCKERS', 'HOSTED_DRAFT_PUMP_TRIGGERS', 'HOSTED_DRAFT_PUMP_FRESH_MS',
  'HostedDraftPumpObservationError', 'hostedDraftPumpRevision',
  'sealHostedDraftPumpObservation', 'requireHostedDraftPumpObservation',
  'deriveHostedDraftPumpBlock', 'summarizeHostedDraftPump',
];

async function api() {
  const loaded = await moduleResult;
  if (loaded.loadError) {
    assert.fail('src/hosted-draft-pump-observation.mjs must exist and export the observation seam');
  }
  for (const name of EXPORTS) {
    assert.notEqual(loaded[name], undefined,
      `src/hosted-draft-pump-observation.mjs must export ${name}`);
  }
  return loaded;
}

const transition = (overrides = {}) => ({
  tickAt: at(2 * MINUTE),
  trigger: 'READY_LABEL',
  outcome: 'CREATED',
  effect: 'CREATE_DRAFT',
  operationId: OPERATION_ID,
  workKey: WORK_KEY,
  generationKey: GENERATION_KEY,
  committedRevision: COMMITTED_REVISION,
  observedSourceRevision: SOURCE_REVISION,
  workItem: { kind: 'ISSUE', number: 70 },
  pullRequest: { number: 71, isDraft: true, state: 'OPEN' },
  blocker: 'NONE',
  ...overrides,
});

const sealArgs = (overrides = {}) => ({
  observedAt: AT,
  windowStartedAt: WINDOW_START,
  sequence: 41,
  repository: 'GuitarAlchemist/gaia',
  repositoryNodeId: 'R_kgDOT3lpUg',
  ledgerRootOid: LEDGER_ROOT_OID,
  ledgerRootRevision: LEDGER_ROOT_REVISION,
  transition: transition(),
  unsettledCount: 0,
  ...overrides,
});

async function seal(overrides = {}) {
  const mod = await api();
  return mod.sealHostedDraftPumpObservation(sealArgs(overrides));
}

// -----------------------------------------------------------------------------------------------
// Schema, vocabularies and provenance.
// -----------------------------------------------------------------------------------------------

test('the sealed observation is closed, content-addressed, and claims no effect or authority', async () => {
  const mod = await api();
  const artifact = await seal();

  assert.equal(artifact.schema, 'gaia-hosted-draft-pump/1');
  assert.equal(artifact.effect, 'NONE');
  assert.equal(artifact.authority, 'NONE');
  assert.match(artifact.revision, /^[a-f0-9]{64}$/u);

  const { revision, ...body } = artifact;
  assert.equal(revision, mod.hostedDraftPumpRevision(body),
    'the revision is SHA-256 over the canonical body with revision removed');

  // Sealing the same evidence twice is byte-identical: the artifact is a pure function of what
  // was read, never of when the producer happened to run.
  assert.equal(canonicalJson(await seal()), canonicalJson(artifact));
});

test('the state, blocker and trigger vocabularies are closed and exact', async () => {
  const mod = await api();
  assert.deepEqual([...mod.HOSTED_DRAFT_PUMP_STATES].sort(),
    ['ADVANCED', 'BLOCKED', 'EXPECTED_NONE', 'REPLAYED', 'STALE', 'UNSETTLED']);
  assert.deepEqual([...mod.HOSTED_DRAFT_PUMP_BLOCKERS].sort(),
    ['CROSS_GENERATION_INTENT', 'EFFECT_AMBIGUOUS', 'NONE', 'NO_EFFECT_CAPACITY',
      'PROVIDER_PROTOCOL_VIOLATION', 'PROVIDER_UNAVAILABLE']);
  assert.deepEqual([...mod.HOSTED_DRAFT_PUMP_TRIGGERS].sort(),
    ['MANUAL_DISPATCH', 'READY_LABEL', 'SCHEDULED_RECOVERY']);
});

test('the observation carries Git Data ledger identity and committed-revision provenance', async () => {
  const mod = await api();
  const artifact = await seal();
  const block = mod.deriveHostedDraftPumpBlock({ artifact, observedAt: AT });

  assert.equal(block.source, 'GAIA_HOSTED_DRAFT_PUMP');
  assert.equal(block.ledgerRootRevision, LEDGER_ROOT_REVISION);
  assert.equal(block.committedRevision, COMMITTED_REVISION);
  assert.equal(block.operationId, OPERATION_ID);
  assert.equal(block.workKey, WORK_KEY);
  assert.deepEqual(block.workItem, { kind: 'ISSUE', number: 70 });
  // The transition is carried verbatim: a digest over evidence the verifier cannot see is not
  // verifiable.
  assert.deepEqual(block.transition, artifact.transition);
});

test('require, derive and summarize are total over every state in the vocabulary', async () => {
  const mod = await api();
  const byState = {
    ADVANCED: transition({ outcome: 'CREATED', effect: 'CREATE_DRAFT' }),
    REPLAYED: transition({ outcome: 'REUSED', effect: 'NONE' }),
    EXPECTED_NONE: transition({
      outcome: 'EXPECTED_NONE', effect: 'NONE', operationId: null, workKey: null,
      generationKey: null, committedRevision: null, workItem: null, pullRequest: null,
    }),
    BLOCKED: transition({
      outcome: 'REFUSED', effect: 'NONE', pullRequest: null, blocker: 'PROVIDER_UNAVAILABLE',
    }),
    UNSETTLED: transition({ outcome: 'PENDING', effect: 'NONE', pullRequest: null }),
  };
  for (const [state, value] of Object.entries(byState)) {
    const extra = state === 'UNSETTLED' ? { unsettledCount: 1 } : {};
    const artifact = await seal({ transition: value, ...extra });
    assert.equal(mod.requireHostedDraftPumpObservation(artifact).schema, 'gaia-hosted-draft-pump/1');
    const block = mod.deriveHostedDraftPumpBlock({ artifact, observedAt: AT });
    assert.equal(block.state, state, `${state} must derive its own published state`);
    const summary = mod.summarizeHostedDraftPump({ artifact, observedAt: AT });
    assert.equal(typeof summary, 'object');
    assert.notEqual(summary, null, `summarize is total for ${state}`);
  }
});

test('ADVANCED and REPLAYED are different published states for the same operation identity', async () => {
  const mod = await api();
  const advanced = mod.deriveHostedDraftPumpBlock({
    artifact: await seal({ transition: transition({ outcome: 'CREATED', effect: 'CREATE_DRAFT' }) }),
    observedAt: AT,
  });
  const replayed = mod.deriveHostedDraftPumpBlock({
    artifact: await seal({ transition: transition({ outcome: 'REUSED', effect: 'NONE' }) }),
    observedAt: AT,
  });

  assert.equal(advanced.operationId, replayed.operationId);
  assert.equal(advanced.state, 'ADVANCED');
  assert.equal(replayed.state, 'REPLAYED');
  // Collapsing them would let a recovery tick that performed nothing read as intake progress.
  assert.notEqual(advanced.state, replayed.state);
});

// -----------------------------------------------------------------------------------------------
// Refusals — incoherent evidence is a typed refusal, never a softened warning.
// -----------------------------------------------------------------------------------------------

test('a transition dated after the reading instant is refused, never clamped to a zero age', async () => {
  const mod = await api();
  // formatDuration clamps negatives to zero, so an unrefused future instant renders as "0s ago" —
  // the single most reassuring reading available, for a transition that has not happened.
  assert.throws(
    () => mod.requireHostedDraftPumpObservation(mod.sealHostedDraftPumpObservation(
      sealArgs({ transition: transition({ tickAt: '2026-09-01T15:10:00.000Z' }) }),
    )),
    (error) => error?.name === 'HostedDraftPumpObservationError'
      && error.code === 'IncoherentHostedDraftPump',
  );
});

test('a producer that went backwards in time or in sequence is refused', async () => {
  const mod = await api();
  const artifact = await seal();
  const prior = { observedAt: AT, sequence: 41, workKey: WORK_KEY,
    committedRevision: COMMITTED_REVISION };

  // Two separate negative controls: the only two fields that carry monotonic evidence. Each is
  // pushed backwards on its own, with everything else left forward, so neither refusal can be
  // credited to the other field.
  for (const [name, older] of [
    ['observedAt', { ...prior, observedAt: '2026-09-01T15:00:00.000Z' }],
    ['sequence', { ...prior, sequence: 99 }],
  ]) {
    assert.throws(
      () => mod.requireHostedDraftPumpObservation(artifact, { priorObservation: older }),
      (error) => error?.code === 'IncoherentHostedDraftPump',
      `a backwards ${name} must be refused`,
    );
  }
});

test('a forward observation is accepted however its opaque committed revision sorts', async () => {
  const mod = await api();

  // `committedRevision` is a SHA-256 content address. It is derived from the bytes of a ledger
  // record, never from when that record was written, so two of them have no temporal relation and
  // sorting them is a coin flip. Here the evidence that actually carries order — `observedAt` and
  // `sequence` — both move forward on one work key, while the digest happens to sort lower than
  // the one previously published. That is an ordinary forward append and must be accepted;
  // refusing it manufactures `IncoherentHostedDraftPump` against real intake progress, and a
  // refused observation ages into `STALE`, which is issue #70's defect restored.
  const artifact = await seal({
    sequence: 101,
    transition: transition({ committedRevision: 'a'.repeat(64) }),
  });
  const prior = {
    observedAt: WINDOW_START,
    sequence: 100,
    workKey: WORK_KEY,
    committedRevision: 'e'.repeat(64),
  };

  assert.equal(prior.committedRevision > artifact.transition.committedRevision, true,
    'the fixture must put the later committed revision lexicographically lower');

  const verified = mod.requireHostedDraftPumpObservation(artifact, { priorObservation: prior });
  assert.equal(verified.sequence, 101);
  assert.equal(verified.transition.committedRevision, 'a'.repeat(64));

  // The same reading through the summarizing seam, so the acceptance is proven where the Control
  // Room actually consumes it and not only at the verifier.
  const block = mod.summarizeHostedDraftPump({ artifact, observedAt: AT, priorObservation: prior });
  assert.equal(block.state, 'ADVANCED');
  assert.equal(block.committedRevision, 'a'.repeat(64));
  assert.equal(block.workKey, WORK_KEY);
});

test('malformed, unknown-token and corrupt evidence is refused by typed code and by name', async () => {
  const mod = await api();
  const artifact = await seal();

  const cases = [
    ['unknown top-level key', { ...artifact, surprise: 1 }],
    ['unknown nested key', { ...artifact, transition: { ...artifact.transition, surprise: 1 } }],
    ['unknown blocker token', { ...artifact, transition: { ...artifact.transition, blocker: 'WAT' } }],
    ['unknown trigger token', { ...artifact, transition: { ...artifact.transition, trigger: 'WAT' } }],
    ['malformed identity', { ...artifact, transition: { ...artifact.transition, operationId: 'nope' } }],
    ['digest that does not match content', { ...artifact, sequence: 42 }],
    ['pull request present with no operation identity', {
      ...artifact,
      transition: { ...artifact.transition, operationId: null },
    }],
  ];
  for (const [name, value] of cases) {
    assert.throws(
      () => mod.requireHostedDraftPumpObservation(value),
      (error) => error?.name === 'HostedDraftPumpObservationError'
        && error.code === 'InvalidHostedDraftPump',
      `${name} must be refused by typed code`,
    );
  }
});

test('stale evidence displays STALE and withholds present-tense pump health', async () => {
  const mod = await api();
  const artifact = await seal();
  const late = new Date(
    Date.parse(AT) + mod.HOSTED_DRAFT_PUMP_FRESH_MS + MINUTE,
  ).toISOString();
  const block = mod.deriveHostedDraftPumpBlock({ artifact, observedAt: late });

  assert.equal(block.state, 'STALE',
    'past the window a dead pump must not read as a healthy empty queue');
  // It still names the transition it has: STALE withholds the reading, not the evidence.
  assert.equal(block.operationId, OPERATION_ID);
  assert.equal(block.committedRevision, COMMITTED_REVISION);
  // The two ages are separate facts: a fresh reading of an old transition is not recent.
  assert.ok(block.transitionAgeMs > block.observationAgeMs,
    'observationAgeMs and transitionAgeMs are published separately');
});

// -----------------------------------------------------------------------------------------------
// The snapshot seam.
// -----------------------------------------------------------------------------------------------

test('the optional snapshot input is byte-neutral when absent and verified when present', async () => {
  const artifact = await seal();
  const without = baseline();
  assert.equal(Object.hasOwn(without, 'hostedDraftPump'), false,
    'absent means the key is omitted, never a null that moves every published revision');

  const withBlock = baseline({ hostedDraftPump: artifact });
  assert.equal(withBlock.hostedDraftPump.state, 'ADVANCED');
  requireControlRoomSnapshot(withBlock);

  // The block is sealed into the snapshot digest, so it cannot be added or edited after the fact.
  assert.notEqual(withBlock.revision, without.revision);
});

test('a resealed snapshot whose published state was edited is refused by re-derivation', async () => {
  const artifact = await seal({
    transition: transition({
      outcome: 'REFUSED', effect: 'NONE', pullRequest: null, blocker: 'PROVIDER_UNAVAILABLE',
    }),
  });
  const snapshot = baseline({ hostedDraftPump: artifact });
  assert.equal(snapshot.hostedDraftPump.state, 'BLOCKED');

  const forged = reseal({
    ...snapshot,
    hostedDraftPump: { ...snapshot.hostedDraftPump, state: 'ADVANCED', blocker: 'NONE' },
  });
  assert.throws(
    () => requireControlRoomSnapshot(forged),
    (error) => error instanceof ControlRoomError,
    'resealing must not be enough to forge a green pump',
  );
});

test('future-dated evidence is refused at the snapshot seam as IncoherentEvidence', async () => {
  const artifact = await seal({ observedAt: '2026-09-01T15:30:00.000Z' });
  assert.throws(
    () => baseline({ hostedDraftPump: artifact }),
    (error) => error instanceof ControlRoomError && error.code === 'IncoherentEvidence',
  );
});

test('the pump block moves no existing reading in the snapshot body', async () => {
  const advanced = baseline({ hostedDraftPump: await seal() });
  const blocked = baseline({
    hostedDraftPump: await seal({
      sequence: 42,
      transition: transition({
        outcome: 'REFUSED', effect: 'NONE', pullRequest: null, blocker: 'NO_EFFECT_CAPACITY',
      }),
    }),
  });

  assert.notEqual(canonicalJson(advanced.hostedDraftPump), canonicalJson(blocked.hostedDraftPump));
  const { hostedDraftPump: _a, revision: _ar, ...advancedRest } = advanced;
  const { hostedDraftPump: _b, revision: _br, ...blockedRest } = blocked;
  assert.equal(canonicalJson(advancedRest), canonicalJson(blockedRest),
    'a pump transition must move no block that speaks about delivery');
});

test('the pump block is passed into no consumer that speaks about delivery, and adds at most one headline sentence', async () => {
  await api();
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/control-room.mjs', import.meta.url), 'utf8');
  assert.notEqual(source.indexOf('const hostedDraftPumpBlock ='), -1,
    'the block is derived in the builder');

  for (const consumer of ['forecastEta', 'measurePace', 'blockerSummary', 'nextActionFor',
    'itemActivity', 'classifyPortfolioDrainObstruction']) {
    assert.equal(
      new RegExp(String.raw`\b${consumer}\([^)]*hostedDraftPump`, 'u').test(source), false,
      `${consumer} must not be handed the pump block`,
    );
  }
  let headlineLines = 0;
  for (const line of source.split('\n')) {
    if (!line.includes('hostedDraftPumpBlock')) continue;
    assert.ok(!/nextAction|obstruction|pace|showSpinner/iu.test(line),
      `the pump block shares a line with a delivery reading: ${line.trim()}`);
    if (/headline/iu.test(line)) headlineLines += 1;
  }
  assert.ok(headlineLines <= 1, 'the pump block contributes at most one headline sentence');
});

test('the rendered section is one compact panel that fabricates no ETA, progress, authority or effect', async () => {
  await api();
  const snapshot = baseline({ hostedDraftPump: await seal() });
  const html = renderControlRoomHtml(snapshot, 'en');

  const start = html.indexOf('<section class="section-panel hosted-draft-pump"');
  assert.notEqual(start, -1, 'the hosted Draft pump section is rendered');
  const end = html.indexOf('</section>', start);
  const section = html.slice(start, end);
  assert.equal(html.indexOf('<section class="section-panel hosted-draft-pump"', end), -1,
    'exactly one pump section is rendered');

  // Colour is never meaning: the state carries a word and a machine-readable attribute.
  assert.match(section, /data-state="ADVANCED"/u);
  assert.match(section, /data-blocker="NONE"/u);
  // No fabrication: no ETA, no percentage, no spinner, no claimed authority or effect.
  assert.equal(/eta|estimat|%|spinner|progress/iu.test(section), false,
    'the pump section fabricates no ETA or progress reading');
  assert.match(section, /EXPECTED_NONE|ADVANCED/u);
});

test('EXPECTED_NONE renders as a named state, never as an absence or a zero', async () => {
  const mod = await api();
  const artifact = await seal({
    transition: transition({
      outcome: 'EXPECTED_NONE', effect: 'NONE', operationId: null, workKey: null,
      generationKey: null, committedRevision: null, workItem: null, pullRequest: null,
    }),
  });
  const block = mod.deriveHostedDraftPumpBlock({ artifact, observedAt: AT });
  assert.equal(block.state, 'EXPECTED_NONE');
  assert.equal(block.operationId, null, 'an empty tick publishes no operation identity');

  const html = renderControlRoomHtml(baseline({ hostedDraftPump: artifact }), 'en');
  assert.match(html, /data-state="EXPECTED_NONE"/u);
});

test('the local evidence file is transport only: the artifact verifies on its own revision', async () => {
  const mod = await api();
  const artifact = await seal();
  // Round-tripping through JSON is what a caller-supplied file does. Nothing about the file —
  // its path, its mtime, its existence — participates in the verification.
  const throughFile = JSON.parse(JSON.stringify(artifact));
  assert.equal(mod.requireHostedDraftPumpObservation(throughFile).revision, artifact.revision);

  const moduleSource = (await import('node:fs')).readFileSync(MODULE_URL, 'utf8');
  for (const forbidden of ['duckdb', 'wmux', 'node:fs', 'node:child_process', 'node:net']) {
    assert.equal(moduleSource.toLowerCase().includes(forbidden), false,
      `the observation module must not reach for ${forbidden}`);
  }
});
