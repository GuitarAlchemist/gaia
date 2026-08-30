/**
 * local-lane-observation.test.mjs — the closed observation schema and the pure sensor core.
 *
 * Nothing here touches wmux, a process, a clock or a file except one redacted golden fixture.
 * The sensor core is a pure function from already-parsed structured agent metadata to one sealed
 * observation, so the interesting question is what it refuses and what it declines to read — both
 * of which are decidable here.
 *
 * Gates T8-T13 of the pair-review amendment live in this file.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LANE_ARTIFACT_BINDINGS_SCHEMA,
  LANE_EVIDENCE_REASONS,
  LANE_TASK_STATES,
  LANE_TASK_STATE_FIELDS,
  LOCAL_LANE_LABEL_STATES,
  LOCAL_LANE_LIFECYCLES,
  LOCAL_LANE_OBSERVATION_FRESH_MS,
  LOCAL_LANE_OBSERVATION_SCHEMA,
  LOCAL_LANE_SOURCE,
  LocalLaneObservationError,
  MAX_ARTIFACT_BINDINGS,
  MAX_LANE_GENERATION,
  MAX_LANE_TASK_STATES,
  MAX_OBSERVED_LANES,
  UNKNOWN_IDENTITY,
  laneArtifactBindingRevision,
  laneCompletionEvidenceRevision,
  laneOrderKey,
  localLaneObservationRevision,
  requireLaneArtifactBindings,
  requireLocalLaneObservation,
  sealLaneArtifactBindings,
  sealLocalLaneObservation,
} from '../src/local-lane-observation.mjs';
import {
  LocalLaneSensorError,
  WMUX_LANE_METADATA_FIELDS,
  WMUX_STATUS_LIFECYCLE,
  deriveLaneTaskStates,
  observeLocalLanes,
} from '../src/local-lane-sensor.mjs';

const AT = '2026-08-30T03:45:00.000Z';
const GOLDEN = fileURLToPath(new URL('./fixtures/wmux-agent-list-redacted.json', import.meta.url));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Re-seal a hand-edited observation, so a refusal is about the rule and not about the digest. */
function reseal(body) {
  const { revision, ...rest } = body;
  return { ...rest, revision: createHash('sha256').update(canonicalJson(rest)).digest('hex') };
}

const lane = (n, overrides = {}) => ({
  workspaceId: `ws-${n}`,
  paneId: `pane-${n}`,
  surfaceId: `surf-${n}`,
  agentId: `agent-${n}`,
  label: `lane ${n}`,
  labelState: 'OBSERVED',
  lifecycle: 'RUNNING',
  ...overrides,
});

/** One raw `wmux agent list` record, including the fields this sensor must never read. */
const agent = (n, overrides = {}) => ({
  agentId: `agent-${n}`,
  surfaceId: `surf-${n}`,
  paneId: `pane-${n}`,
  workspaceId: `ws-${n}`,
  label: `lane ${n}`,
  cmd: `pwsh -NoProfile -File 'C:\\tmp\\SECRET-COMMAND-LINE-${n}.ps1'`,
  status: 'running',
  spawnTime: 1_788_060_173_347,
  pid: 13_912 + n,
  ...overrides,
});

// ---------------------------------------------------------------------------
// the closed schema
// ---------------------------------------------------------------------------

test('a sealed observation carries exactly the bounded metadata the UI needs', () => {
  const observation = sealLocalLaneObservation({ observedAt: AT, lanes: [lane(1)] });

  assert.deepEqual(Object.keys(observation).sort(), [
    'authority', 'effect', 'lanes', 'observedAt', 'revision', 'schema', 'source',
  ]);
  assert.equal(observation.schema, LOCAL_LANE_OBSERVATION_SCHEMA);
  assert.equal(observation.source, LOCAL_LANE_SOURCE);
  assert.equal(observation.effect, 'NONE');
  assert.equal(observation.authority, 'NONE');
  assert.equal(observation.observedAt, AT);
  assert.deepEqual(Object.keys(observation.lanes[0]).sort(), [
    'agentId', 'label', 'labelState', 'lifecycle', 'paneId', 'surfaceId', 'workspaceId',
  ]);
  assert.equal(Object.isFrozen(observation.lanes[0]), true, 'the value is deeply immutable');
  assert.deepEqual(requireLocalLaneObservation(structuredClone(observation)), observation);
});

test('the observation window is a sensor-cadence window with its own name and meaning', () => {
  assert.equal(LOCAL_LANE_OBSERVATION_FRESH_MS, 30_000);
  const source = readFileSync(
    fileURLToPath(new URL('../src/local-lane-observation.mjs', import.meta.url)), 'utf8',
  );
  assert.equal(
    source.includes('HEARTBEAT_FRESH_MS'), false,
    'the sensor cadence window must not be a borrowed heartbeat constant',
  );
  assert.match(source, /how recently the SENSOR reported/iu, 'and it says what it measures');
});

test('the lifecycle vocabulary is closed and only RUNNING is ever a live lane', () => {
  assert.deepEqual([...LOCAL_LANE_LIFECYCLES], ['RUNNING', 'EXITED', 'UNKNOWN']);
  for (const lifecycle of LOCAL_LANE_LIFECYCLES) {
    assert.doesNotThrow(() => sealLocalLaneObservation({
      observedAt: AT, lanes: [lane(1, { lifecycle })],
    }));
  }
  assert.throws(
    () => sealLocalLaneObservation({ observedAt: AT, lanes: [lane(1, { lifecycle: 'BUSY' })] }),
    (error) => error instanceof LocalLaneObservationError && /lifecycle/u.test(error.message),
  );
});

test('T9: an unknown field is refused rather than ignored, at both levels', () => {
  const observation = sealLocalLaneObservation({ observedAt: AT, lanes: [lane(1)] });

  assert.throws(
    () => requireLocalLaneObservation(reseal({ ...observation, note: 'extra' })),
    (error) => error instanceof LocalLaneObservationError && /unknown field/u.test(error.message),
    'a top-level extra field is refused',
  );
  assert.throws(
    () => requireLocalLaneObservation(reseal({
      ...observation,
      lanes: [{ ...observation.lanes[0], cmd: 'pwsh -File secret.ps1' }],
    })),
    (error) => error instanceof LocalLaneObservationError && /unknown field/u.test(error.message),
    'a smuggled command line is refused rather than carried and ignored',
  );
});

test('T9: an unknown field on a wmux RECORD is ignored, because the sensor never reads it', () => {
  const observation = observeLocalLanes({
    observedAt: AT,
    agents: [agent(1, { exitCode: -1, title: 'a future wmux field', anything: { at: 'all' } })],
  });

  assert.equal(observation.lanes.length, 1, 'a record with extra keys is still an observed lane');
  assert.equal(JSON.stringify(observation).includes('future wmux field'), false);
  assert.equal(JSON.stringify(observation).includes('exitCode'), false);
});

test('malformed values fail closed, one refusal per malformed shape', () => {
  const cases = [
    ['a non-ISO instant', { observedAt: '2026-08-30 03:45' }],
    ['a partial instant that would parse leniently', { observedAt: '2026-08-30' }],
    ['a non-string instant', { observedAt: 1_788_060_173_347 }],
    ['lanes that are not an array', { lanes: { 0: lane(1) } }],
  ];
  for (const [why, patch] of cases) {
    assert.throws(
      () => requireLocalLaneObservation(reseal({
        ...sealLocalLaneObservation({ observedAt: AT, lanes: [lane(1)] }), ...patch,
      })),
      LocalLaneObservationError,
      why,
    );
  }
  for (const identity of ['workspaceId', 'paneId', 'surfaceId', 'agentId']) {
    assert.throws(
      () => sealLocalLaneObservation({
        observedAt: AT, lanes: [lane(1, { [identity]: 'has a space' })],
      }),
      LocalLaneObservationError,
      `${identity} may not carry free text`,
    );
  }
});

test('T10: the label allowlist refuses every adversarial class, and admits a real label', () => {
  const refused = [
    ['markup', '<script>alert(1)</script>'],
    ['an attribute break', 'lane" onmouseover="x'],
    ['a shell substitution', 'lane`whoami`'],
    ['a command separator', 'lane; rm -rf /'],
    ['a newline', 'lane\nsecond line'],
    ['a bidi override that could impersonate another lane', 'Gaia\u202Ednuor-kcab'],
    ['a bidi isolate', 'Gaia\u2066lane\u2069'],
    ['a zero-width space that forges a duplicate', 'Gaia\u200BStandards'],
    ['a byte order mark', 'Gaia\uFEFFStandards'],
    ['a leading combining mark', '\u0301Gaia'],
    ['a C0 control', 'Gaia\u0007'],
    ['an unassigned code point', 'Gaia\uFFFF'],
    ['a label longer than the bound', 'a'.repeat(65)],
  ];
  for (const [why, label] of refused) {
    assert.throws(
      () => sealLocalLaneObservation({
        observedAt: AT, lanes: [lane(1, { label, labelState: 'OBSERVED' })],
      }),
      (error) => error instanceof LocalLaneObservationError && /label/u.test(error.message),
      `${why} must not be a displayable label`,
    );
  }
  // Every real wmux label on this machine carries U+2014, and an ampersand is an ordinary name.
  assert.doesNotThrow(() => sealLocalLaneObservation({
    observedAt: AT,
    lanes: [lane(1, { label: 'Gaia Dashboard UX R0 — R&D (Standards)' })],
  }));
});

test('S2: the label state is a separate closed field, never a sentinel inside the label', () => {
  assert.deepEqual([...LOCAL_LANE_LABEL_STATES], ['OBSERVED', 'ABSENT', 'WITHHELD_UNSAFE']);

  for (const labelState of ['ABSENT', 'WITHHELD_UNSAFE']) {
    assert.doesNotThrow(() => sealLocalLaneObservation({
      observedAt: AT, lanes: [lane(1, { label: null, labelState })],
    }));
    assert.throws(
      () => sealLocalLaneObservation({
        observedAt: AT, lanes: [lane(1, { label: 'a real name', labelState })],
      }),
      LocalLaneObservationError,
      `${labelState} must carry no label at all`,
    );
  }
  assert.throws(
    () => sealLocalLaneObservation({
      observedAt: AT, lanes: [lane(1, { label: null, labelState: 'OBSERVED' })],
    }),
    LocalLaneObservationError,
  );
  // A lane genuinely called UNKNOWN stays distinguishable from a lane with no name.
  const named = sealLocalLaneObservation({ observedAt: AT, lanes: [lane(1, { label: 'UNKNOWN' })] });
  const unnamed = sealLocalLaneObservation({
    observedAt: AT, lanes: [lane(1, { label: null, labelState: 'ABSENT' })],
  });
  assert.notEqual(named.revision, unnamed.revision);
});

test('T13: lanes are strictly ordered, and a duplicate identity is a refusal', () => {
  assert.throws(
    () => requireLocalLaneObservation(reseal({
      ...sealLocalLaneObservation({ observedAt: AT, lanes: [lane(1), lane(2)] }),
      lanes: [lane(2), lane(1)],
    })),
    (error) => error instanceof LocalLaneObservationError && /order/u.test(error.message),
  );
  assert.throws(
    () => requireLocalLaneObservation(reseal({
      ...sealLocalLaneObservation({ observedAt: AT, lanes: [lane(1)] }),
      lanes: [lane(1), lane(1)],
    })),
    (error) => error instanceof LocalLaneObservationError && /order/u.test(error.message),
    'a duplicated identity is refused rather than counted twice',
  );
  // The same agent id under two workspaces is two lanes, and both are kept.
  const twice = observeLocalLanes({
    observedAt: AT,
    agents: [
      { ...agent(1), workspaceId: 'ws-alpha' },
      { ...agent(1), workspaceId: 'ws-beta' },
    ],
  });
  assert.equal(twice.lanes.length, 2);
});

test('the observation is content-addressed and a hand edit is refused at the seam', () => {
  const observation = sealLocalLaneObservation({ observedAt: AT, lanes: [lane(1)] });

  assert.throws(
    () => requireLocalLaneObservation({
      ...observation, lanes: [{ ...observation.lanes[0], lifecycle: 'EXITED' }],
    }),
    (error) => error instanceof LocalLaneObservationError && /revision/u.test(error.message),
  );
  assert.throws(
    () => requireLocalLaneObservation({ ...observation, revision: 'not-a-digest' }),
    LocalLaneObservationError,
  );
});

test('the lane count is bounded by a document-size cap that is not a lane policy', () => {
  const many = Array.from({ length: MAX_OBSERVED_LANES + 1 }, (_, index) => lane(
    String(index).padStart(3, '0'),
  ));
  assert.throws(
    () => sealLocalLaneObservation({ observedAt: AT, lanes: many }),
    (error) => error instanceof LocalLaneObservationError && /at most/u.test(error.message),
  );
  assert.doesNotThrow(() => sealLocalLaneObservation({
    observedAt: AT, lanes: many.slice(0, MAX_OBSERVED_LANES),
  }));
});

// ---------------------------------------------------------------------------
// the pure sensor core
// ---------------------------------------------------------------------------

test('the sensor reads six named metadata fields and cannot reach a seventh', () => {
  assert.deepEqual([...WMUX_LANE_METADATA_FIELDS].sort(), [
    'agentId', 'label', 'paneId', 'status', 'surfaceId', 'workspaceId',
  ]);

  const observation = observeLocalLanes({ agents: [agent(1)], observedAt: AT });
  const serialized = JSON.stringify(observation);

  assert.equal(observation.lanes.length, 1);
  assert.equal(observation.lanes[0].lifecycle, 'RUNNING');
  assert.equal(serialized.includes('SECRET-COMMAND-LINE'), false, 'no command line is ingested');
  assert.equal(serialized.includes('cmd'), false);
  assert.equal(serialized.includes('pid'), false);
  assert.equal(serialized.includes('spawnTime'), false, 'and no lane elapsed time is derivable');
});

test('T15: screen, prompt, reasoning and stdout fields are never ingested', () => {
  const observation = observeLocalLanes({
    observedAt: AT,
    agents: [agent(1, {
      screen: 'SCREEN-SCRAPE-MARKER',
      prompt: 'PROMPT-MARKER',
      reasoning: 'REASONING-MARKER',
      stdout: 'STDOUT-MARKER',
      stderr: 'STDERR-MARKER',
      transcript: 'TRANSCRIPT-MARKER',
      cwd: 'C:\\tmp\\CWD-MARKER',
      argv: ['ARGV-MARKER'],
      source: 'SOURCE-CODE-MARKER',
    })],
  });

  const serialized = JSON.stringify(observation);
  for (const marker of [
    'SCREEN-SCRAPE', 'PROMPT-MARKER', 'REASONING-MARKER', 'STDOUT-MARKER', 'STDERR-MARKER',
    'TRANSCRIPT-MARKER', 'CWD-MARKER', 'ARGV-MARKER', 'SOURCE-CODE-MARKER',
  ]) {
    assert.equal(serialized.includes(marker), false, `${marker} reached the observation`);
  }
  assert.equal(observation.lanes.length, 1, 'and the lane itself is still observed');
});

test('T8: wmux status is mapped by exact equality and anything else fails closed to UNKNOWN', () => {
  assert.deepEqual({ ...WMUX_STATUS_LIFECYCLE }, { running: 'RUNNING', exited: 'EXITED' });

  const observation = observeLocalLanes({
    observedAt: AT,
    agents: [
      agent(1, { status: 'running' }),
      agent(2, { status: 'exited' }),
      agent(3, { status: 'Running' }),
      agent(4, { status: 'RUNNING' }),
      agent(5, { status: 'running (paused)' }),
      agent(6, { status: 'run' }),
      agent(7, { status: '' }),
      agent(8, { status: 17 }),
      agent(9, { status: 'constructor' }),
    ],
  });

  assert.deepEqual(observation.lanes.map(({ lifecycle }) => lifecycle), [
    'RUNNING', 'EXITED', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN',
    'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN',
  ]);
});

test('T11: an unsafe or absent label withholds the name and never drops the lane', () => {
  const agents = [
    agent(1, { label: undefined }),
    agent(2, { label: null }),
    agent(3, { label: '<script>alert(1)</script>' }),
    agent(4, { label: 'Gaia\u202Ednuor-kcab' }),
    agent(5, { label: 'Gaia Dashboard UX R0 — Standards' }),
  ];

  const observation = observeLocalLanes({ observedAt: AT, agents });

  assert.equal(observation.lanes.length, agents.length, 'every lane is still published');
  assert.deepEqual(observation.lanes.map(({ labelState }) => labelState), [
    'ABSENT', 'ABSENT', 'WITHHELD_UNSAFE', 'WITHHELD_UNSAFE', 'OBSERVED',
  ]);
  assert.deepEqual(observation.lanes.map(({ label }) => label), [
    null, null, null, null, 'Gaia Dashboard UX R0 — Standards',
  ]);
  const serialized = JSON.stringify(observation);
  assert.equal(serialized.includes('script'), false);
  assert.equal(serialized.includes('\u202E'), false);
});

test('an absent identity is UNKNOWN, and a malformed one refuses the whole observation', () => {
  const observed = observeLocalLanes({ observedAt: AT, agents: [agent(1, { paneId: null })] });
  assert.equal(observed.lanes[0].paneId, UNKNOWN_IDENTITY);

  assert.throws(
    () => observeLocalLanes({ observedAt: AT, agents: [agent(1, { agentId: 'agent 1 of 4' })] }),
    (error) => error instanceof LocalLaneSensorError && error.code === 'LaneIdentityUnreadable',
    'a wrong identity is worse than no identity, so the observation is refused',
  );
});

test('the sensor fails closed on anything that is not an exact agent array', () => {
  for (const agents of [undefined, null, {}, 'agents', [null], ['agent-1'], [[]]]) {
    assert.throws(
      () => observeLocalLanes({ agents, observedAt: AT }),
      LocalLaneSensorError,
      `${JSON.stringify(agents) ?? 'undefined'} is not readable structured metadata`,
    );
  }
});

test('a duplicated wmux identity is refused rather than double counted', () => {
  assert.throws(
    () => observeLocalLanes({ observedAt: AT, agents: [agent(1), agent(1)] }),
    (error) => error instanceof LocalLaneSensorError && error.code === 'DuplicateLaneIdentity',
  );
});

test('the sensor is deterministic: identical evidence produces identical bytes, in any order', () => {
  const agents = [agent(3), agent(1), agent(2, { status: 'exited' })];

  const once = observeLocalLanes({ agents, observedAt: AT });
  const twice = observeLocalLanes({ agents: [...agents].reverse(), observedAt: AT });

  assert.equal(JSON.stringify(once), JSON.stringify(twice));
  assert.equal(once.revision, twice.revision);
  assert.deepEqual(once.lanes.map(({ agentId }) => agentId), ['agent-1', 'agent-2', 'agent-3']);
});

// ---------------------------------------------------------------------------
// the golden input named by the Decision Receipt
// ---------------------------------------------------------------------------

test('the redacted golden fixture is the exact input the Decision Receipt names', () => {
  const bytes = readFileSync(GOLDEN, 'utf8');

  assert.equal(
    createHash('sha256').update(bytes, 'utf8').digest('hex'),
    '74541f35bf527b3bc4f226fe4e1815000497088d5337c5084bde211afa0d09ba',
    'the fixture the receipt pins is the fixture on disk',
  );
  for (const stripped of ['cmd', 'pid', 'spawnTime', 'exitCode']) {
    assert.equal(bytes.includes(stripped), false, `${stripped} survived redaction`);
  }
});

test('the golden wmux payload observes every workspace and both real lifecycles', () => {
  const { agents } = JSON.parse(readFileSync(GOLDEN, 'utf8'));

  const observation = observeLocalLanes({ agents, observedAt: AT });

  assert.equal(observation.lanes.length, 7);
  assert.equal(
    new Set(observation.lanes.map(({ workspaceId }) => workspaceId)).size, 2,
    'no workspace filter is applied, so both workspaces are observed',
  );
  assert.equal(observation.lanes.filter(({ lifecycle }) => lifecycle === 'RUNNING').length, 5);
  assert.equal(observation.lanes.filter(({ lifecycle }) => lifecycle === 'EXITED').length, 2);
  assert.equal(
    observation.lanes.every(({ labelState }) => labelState === 'OBSERVED'), true,
    'every real label on this machine passes the allowlist, em dash included',
  );
  // Real labels are duplicated, which is why the row must show an identity beside the name.
  assert.equal(new Set(observation.lanes.map(({ label }) => label)).size < 7, true);
});

// ===========================================================================
// ARTIFACT COMPLETION SIGNALS R0
//
// docs/artifact-completion-signals.md is the normative contract these gates
// enforce. Two axes, never one: `processLifecycle` is what wmux observed about
// a process, `taskState` is what the artifact bytes prove about the work. The
// wrapper outliving the provider is the NORMAL case, so RUNNING beside
// COMPLETED_EVIDENCE must be expressible rather than reconciled away.
// ===========================================================================

const ARTIFACT_ROOT = process.platform === 'win32'
  ? 'C:\\tmp\\gaia-artifact-root'
  : '/tmp/gaia-artifact-root';
const MARKER = 'GAIA_TRACER_ARTIFACT_COMPLETE';
const SOURCE_REVISION = 'c'.repeat(64);
/** Sixty-four characters, four of which are spaces: a length check would accept this. */
const SHA_LIKE = `${'c'.repeat(60)}    `;

/** One operator-authored binding. Every field is exact; nothing here is inferred. */
const binding = (n, overrides = {}) => ({
  workspaceId: `ws-${n}`,
  paneId: `pane-${n}`,
  surfaceId: `surf-${n}`,
  agentId: `agent-${n}`,
  allowedRoot: ARTIFACT_ROOT,
  artifactPath: join(ARTIFACT_ROOT, `handoff-${n}.md`),
  completionMarker: MARKER,
  sourceRevision: SOURCE_REVISION,
  ...overrides,
});

const digestOf = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const readOutcome = (text) => ({ outcome: 'READ', digest: digestOf(text), text });
const ABSENT = { outcome: 'ABSENT' };
const refusedOutcome = (reason) => ({ outcome: 'REFUSED', reason });
const evidenceFor = (pairs) => new Map(pairs.map(([b, e]) => [laneOrderKey(b), e]));

const COMPLETE_TEXT = `writer handoff\n\nentry d44de19\n\n${MARKER}\n`;

/** A whole observation, hand-built and sealed with the real recipe, for verifier gates. */
const withTaskStates = (lanes, taskStates, observedAt = AT) => ({
  schema: LOCAL_LANE_OBSERVATION_SCHEMA,
  source: LOCAL_LANE_SOURCE,
  effect: 'NONE',
  authority: 'NONE',
  observedAt,
  lanes,
  taskStates,
  revision: localLaneObservationRevision({ observedAt, lanes }),
});

/** The one COMPLETED_EVIDENCE entry the verifier gates below start from and then break. */
function completedEntry(overrides = {}) {
  const base = {
    workspaceId: 'ws-1',
    paneId: 'pane-1',
    surfaceId: 'surf-1',
    agentId: 'agent-1',
    processLifecycle: 'RUNNING',
    taskState: 'COMPLETED_EVIDENCE',
    evidenceReason: 'MARKER_VERIFIED',
    bindingRevision: laneArtifactBindingRevision(binding(1)),
    generation: 0,
    artifactDigest: digestOf(COMPLETE_TEXT),
    completionObservedAt: AT,
    ...overrides,
  };
  return { ...base, completionEvidenceRevision: laneCompletionEvidenceRevision(base) };
}

// ---------------------------------------------------------------------------
// gaia-lane-artifact-bindings/1 — the closed, operator-authored input
// ---------------------------------------------------------------------------

test('a sealed binding document carries exactly the operator-authored input', () => {
  const doc = sealLaneArtifactBindings({ bindings: [binding(1)] });

  assert.deepEqual(Object.keys(doc).sort(), [
    'authority', 'bindings', 'effect', 'revision', 'schema',
  ]);
  assert.equal(doc.schema, LANE_ARTIFACT_BINDINGS_SCHEMA);
  assert.equal(doc.schema, 'gaia-lane-artifact-bindings/1');
  assert.equal(doc.effect, 'NONE', 'a binding file authorises no effect');
  assert.equal(doc.authority, 'NONE', 'and confers no authority');
  assert.deepEqual(Object.keys(doc.bindings[0]).sort(), [
    'agentId', 'allowedRoot', 'artifactPath', 'completionMarker',
    'paneId', 'sourceRevision', 'surfaceId', 'workspaceId',
  ]);
  assert.deepEqual(requireLaneArtifactBindings(structuredClone(doc)), doc);
  assert.equal(Object.isFrozen(doc.bindings[0]), true, 'the value is deeply immutable');
});

test('an unknown field is refused in a binding document, never ignored', () => {
  const doc = sealLaneArtifactBindings({ bindings: [binding(1)] });

  assert.throws(
    () => requireLaneArtifactBindings({ ...doc, reap: true }),
    (error) => error instanceof LocalLaneObservationError && /unknown field/u.test(error.message),
    'a document-level extension is refused',
  );
  assert.throws(
    () => requireLaneArtifactBindings({
      ...doc, bindings: [{ ...doc.bindings[0], killOnComplete: true }],
    }),
    (error) => error instanceof LocalLaneObservationError && /unknown field/u.test(error.message),
    'and a record-level one is refused before its revision is even consulted',
  );
});

test('a tampered binding revision is refused, and no record inside the document is used', () => {
  // The artifact sits two levels down, so widening or narrowing the fence is still a legal
  // binding and the refusal below is about the revision rather than about the path.
  const doc = sealLaneArtifactBindings({
    bindings: [binding(1, { artifactPath: join(ARTIFACT_ROOT, 'nested', 'handoff-1.md') })],
  });

  for (const tamper of [
    { sourceRevision: 'd'.repeat(64) },
    { completionMarker: 'GAIA_SOME_OTHER_MARKER_COMPLETE' },
    { artifactPath: join(ARTIFACT_ROOT, 'nested', 'someone-elses-handoff.md') },
    { agentId: 'agent-9' },
    { allowedRoot: join(ARTIFACT_ROOT, 'nested') },
  ]) {
    assert.throws(
      () => requireLaneArtifactBindings({
        ...doc, bindings: [{ ...doc.bindings[0], ...tamper }],
      }),
      (error) => error instanceof LocalLaneObservationError && /revision/u.test(error.message),
      `editing ${Object.keys(tamper)[0]} without resealing must be refused`,
    );
  }
  assert.throws(
    () => requireLaneArtifactBindings({ ...doc, revision: 'e'.repeat(64) }),
    (error) => error instanceof LocalLaneObservationError && /revision/u.test(error.message),
    'a well-shaped revision of the wrong content is still the wrong content',
  );
});

test('a binding never names the UNKNOWN identity sentinel', () => {
  for (const field of ['workspaceId', 'paneId', 'surfaceId', 'agentId']) {
    assert.throws(
      () => sealLaneArtifactBindings({ bindings: [binding(1, { [field]: UNKNOWN_IDENTITY })] }),
      (error) => error instanceof LocalLaneObservationError,
      `${field} of UNKNOWN would match every lane whose identity wmux never supplied`,
    );
    assert.throws(
      () => sealLaneArtifactBindings({ bindings: [binding(1, { [field]: 'not an identity' })] }),
      (error) => error instanceof LocalLaneObservationError,
      `${field} must be a bounded identity`,
    );
  }
});

test('a binding artifact path may not escape its allowed root', () => {
  const escapes = [
    { allowedRoot: ARTIFACT_ROOT, artifactPath: join(ARTIFACT_ROOT) },
    { allowedRoot: ARTIFACT_ROOT, artifactPath: `${ARTIFACT_ROOT}-evil${sep}handoff.md` },
    { allowedRoot: ARTIFACT_ROOT, artifactPath: `${ARTIFACT_ROOT}${sep}..${sep}escape.md` },
    { allowedRoot: ARTIFACT_ROOT, artifactPath: `${ARTIFACT_ROOT}${sep}.${sep}handoff.md` },
    { allowedRoot: ARTIFACT_ROOT, artifactPath: `${ARTIFACT_ROOT}${sep}${sep}handoff.md` },
    { allowedRoot: ARTIFACT_ROOT, artifactPath: `${ARTIFACT_ROOT}${sep}handoff.md${sep}` },
    { allowedRoot: ARTIFACT_ROOT, artifactPath: 'handoff.md' },
    { allowedRoot: ARTIFACT_ROOT, artifactPath: `${ARTIFACT_ROOT}${sep}hand\u0000off.md` },
    { allowedRoot: `${sep}${sep}server${sep}share`, artifactPath: `${sep}${sep}server${sep}share${sep}h.md` },
    { allowedRoot: `${ARTIFACT_ROOT}${sep}..`, artifactPath: join(ARTIFACT_ROOT, 'h.md') },
    { allowedRoot: ARTIFACT_ROOT, artifactPath: join(ARTIFACT_ROOT, `${'a'.repeat(600)}.md`) },
  ];
  for (const paths of escapes) {
    assert.throws(
      () => sealLaneArtifactBindings({ bindings: [binding(1, paths)] }),
      (error) => error instanceof LocalLaneObservationError,
      `${paths.artifactPath} under ${paths.allowedRoot} must be refused`,
    );
  }
  // The fence holds a legitimate nested path, so this is a fence and not a ban.
  assert.doesNotThrow(() => sealLaneArtifactBindings({
    bindings: [binding(1, { artifactPath: join(ARTIFACT_ROOT, 'nested', 'deep', 'handoff.md') })],
  }));
});

test('a completion marker is exact ASCII, bounded, and never whitespace-bearing', () => {
  for (const marker of [
    '', 'SHORT', `${MARKER} `, `GAIA ${MARKER}`, `${MARKER}\n`,
    `GAIA_\u200bTRACER_COMPLETE`, `GAIA_TRACER_\u2014_COMPLETE`, 'X'.repeat(201),
  ]) {
    assert.throws(
      () => sealLaneArtifactBindings({ bindings: [binding(1, { completionMarker: marker })] }),
      (error) => error instanceof LocalLaneObservationError,
      `${JSON.stringify(marker)} is not a byte-comparable marker`,
    );
  }
  for (const revision of ['', 'C'.repeat(64), 'c'.repeat(63), `${'c'.repeat(63)}z`, SHA_LIKE]) {
    assert.throws(
      () => sealLaneArtifactBindings({ bindings: [binding(1, { sourceRevision: revision })] }),
      (error) => error instanceof LocalLaneObservationError,
      'a source revision is exactly 64 lowercase hex characters',
    );
  }
});

test('binding documents are ordered, deduplicated and bounded', () => {
  const doc = sealLaneArtifactBindings({ bindings: [binding(3), binding(1), binding(2)] });
  assert.deepEqual(doc.bindings.map(({ agentId }) => agentId), ['agent-1', 'agent-2', 'agent-3']);

  assert.throws(
    () => sealLaneArtifactBindings({ bindings: [binding(1), binding(1)] }),
    (error) => error instanceof LocalLaneObservationError && /order/u.test(error.message),
    'two bindings for one lane would silently decide which artifact counts',
  );
  assert.throws(
    () => requireLaneArtifactBindings({
      ...doc, bindings: [doc.bindings[1], doc.bindings[0], doc.bindings[2]],
    }),
    (error) => error instanceof LocalLaneObservationError,
    'a hand-written document gets no dispensation the sealer does not enjoy',
  );
  assert.equal(MAX_ARTIFACT_BINDINGS, 64);
  assert.throws(
    () => sealLaneArtifactBindings({
      bindings: Array.from({ length: 65 }, (unused, index) => binding(index + 100)),
    }),
    (error) => error instanceof LocalLaneObservationError,
  );
});

// ---------------------------------------------------------------------------
// the transition itself
// ---------------------------------------------------------------------------

test('a verified terminal marker publishes COMPLETED_EVIDENCE', () => {
  const bound = binding(1);

  const states = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(COMPLETE_TEXT)]]),
    previousTaskStates: [],
    observedAt: AT,
  });

  assert.equal(states.length, 1);
  const [entry] = states;
  assert.deepEqual(Object.keys(entry).sort(), [...LANE_TASK_STATE_FIELDS].sort());
  assert.equal(entry.taskState, 'COMPLETED_EVIDENCE');
  assert.equal(entry.evidenceReason, 'MARKER_VERIFIED');
  assert.equal(entry.artifactDigest, digestOf(COMPLETE_TEXT));
  assert.equal(entry.completionObservedAt, AT);
  assert.equal(entry.bindingRevision, laneArtifactBindingRevision(bound));
  assert.equal(entry.generation, 0);
  assert.equal(
    entry.completionEvidenceRevision, laneCompletionEvidenceRevision(entry),
    'the completion is content-addressed by its own binding, generation, digest and instant',
  );
});

test('the wrapper still reports RUNNING, and that stays a separate, unchanged axis', () => {
  const bound = binding(1);

  const observation = observeLocalLanes({
    agents: [agent(1)],
    observedAt: AT,
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(COMPLETE_TEXT)]]),
  });

  assert.equal(
    observation.lanes[0].lifecycle, 'RUNNING',
    'the wmux lifecycle is what wmux said, and this slice does not touch it',
  );
  assert.equal(observation.taskStates[0].processLifecycle, 'RUNNING');
  assert.equal(observation.taskStates[0].taskState, 'COMPLETED_EVIDENCE');
  assert.equal(
    observation.revision,
    localLaneObservationRevision({ observedAt: AT, lanes: observation.lanes }),
    'the lane revision still addresses the lane set, so existing consumers re-derive it',
  );
});

test('an in-progress artifact is RUNNING while the pane runs, and UNKNOWN once it does not', () => {
  const bound = binding(1);
  const partial = readOutcome('writer handoff\n\nentry d44de19\n\nstill working\n');

  const running = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, partial]]),
    observedAt: AT,
  });
  assert.equal(running[0].taskState, 'RUNNING');
  assert.equal(running[0].evidenceReason, 'ARTIFACT_IN_PROGRESS');
  assert.equal(running[0].artifactDigest, null, 'a partial completion is not a completion');
  assert.equal(running[0].completionObservedAt, null);
  assert.equal(running[0].completionEvidenceRevision, null);

  const absent = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, ABSENT]]),
    observedAt: AT,
  });
  assert.equal(absent[0].taskState, 'RUNNING', 'a file not written yet is work in progress');

  const exited = deriveLaneTaskStates({
    lanes: [lane(1, { lifecycle: 'EXITED' })],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, partial]]),
    observedAt: AT,
  });
  assert.equal(exited[0].taskState, 'UNKNOWN');
  assert.equal(exited[0].evidenceReason, 'NO_COMPLETION_EVIDENCE');
  assert.equal(exited[0].processLifecycle, 'EXITED');
});

test('a duplicated marker is refused evidence, never a completion', () => {
  const bound = binding(1);
  const twice = `${MARKER}\n\nmore log\n\n${MARKER}\n`;

  const states = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(twice)]]),
    observedAt: AT,
  });

  assert.equal(states[0].taskState, 'REFUSED_EVIDENCE');
  assert.equal(states[0].evidenceReason, 'DUPLICATE_MARKER');
  assert.equal(states[0].artifactDigest, null);

  // Overlapping occurrences are counted, so a self-overlapping marker cannot hide a second one.
  const overlap = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [binding(1, { completionMarker: 'AAAAAAAA' })],
    artifactEvidence: evidenceFor([[bound, readOutcome('AAAAAAAAA\n')]]),
    observedAt: AT,
  });
  assert.equal(overlap[0].evidenceReason, 'DUPLICATE_MARKER');
});

test('a marker that is not terminal is refused evidence, never a completion', () => {
  const bound = binding(1);

  for (const text of [
    `${MARKER}\nand then more work happened\n`,
    `${MARKER} trailing prose`,
    `intro\n${MARKER}\n\n## Appendix\n`,
  ]) {
    const states = deriveLaneTaskStates({
      lanes: [lane(1)],
      bindings: [bound],
      artifactEvidence: evidenceFor([[bound, readOutcome(text)]]),
      observedAt: AT,
    });
    assert.equal(states[0].taskState, 'REFUSED_EVIDENCE');
    assert.equal(states[0].evidenceReason, 'MARKER_NOT_TERMINAL');
  }
  // Trailing ASCII whitespace only is still terminal.
  for (const text of [`${MARKER}`, `${MARKER}\n`, `${MARKER}\r\n`, `${MARKER}\n\t \n`]) {
    const states = deriveLaneTaskStates({
      lanes: [lane(1)],
      bindings: [bound],
      artifactEvidence: evidenceFor([[bound, readOutcome(text)]]),
      observedAt: AT,
    });
    assert.equal(states[0].taskState, 'COMPLETED_EVIDENCE', JSON.stringify(text));
  }
});

test('bytes that changed between the two reads are refused evidence', () => {
  const bound = binding(1);

  const states = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, refusedOutcome('ARTIFACT_UNSTABLE')]]),
    observedAt: AT,
  });

  assert.equal(states[0].taskState, 'REFUSED_EVIDENCE');
  assert.equal(states[0].evidenceReason, 'ARTIFACT_UNSTABLE');
  assert.equal(states[0].artifactDigest, null);
});

test('every boundary refusal reaches the observation as REFUSED_EVIDENCE, and none as progress', () => {
  const bound = binding(1);
  for (const reason of [
    'PATH_ESCAPES_ALLOWED_ROOT', 'NOT_A_REGULAR_FILE', 'ARTIFACT_TOO_LARGE',
    'ARTIFACT_UNSTABLE', 'ARTIFACT_UNREADABLE',
  ]) {
    const states = deriveLaneTaskStates({
      lanes: [lane(1)],
      bindings: [bound],
      artifactEvidence: evidenceFor([[bound, refusedOutcome(reason)]]),
      observedAt: AT,
    });
    assert.equal(states[0].taskState, 'REFUSED_EVIDENCE');
    assert.equal(states[0].evidenceReason, reason);
  }
  // A bound lane with no artifact observation at all fails closed rather than reading as absent.
  const missing = deriveLaneTaskStates({
    lanes: [lane(1)], bindings: [bound], artifactEvidence: new Map(), observedAt: AT,
  });
  assert.equal(missing[0].taskState, 'REFUSED_EVIDENCE');
  assert.equal(missing[0].evidenceReason, 'NO_ARTIFACT_OBSERVATION');
});

test('a lane with no binding is UNBOUND, and is never inferred into one', () => {
  const states = deriveLaneTaskStates({
    lanes: [lane(1), lane(2)],
    bindings: [binding(2)],
    artifactEvidence: evidenceFor([[binding(2), readOutcome(COMPLETE_TEXT)]]),
    observedAt: AT,
  });

  assert.deepEqual(states.map(({ taskState }) => taskState), ['UNBOUND', 'COMPLETED_EVIDENCE']);
  const [unbound] = states;
  assert.equal(unbound.evidenceReason, 'NO_BINDING');
  assert.equal(unbound.bindingRevision, null);
  assert.equal(unbound.artifactDigest, null);
  assert.equal(unbound.completionObservedAt, null);
  assert.equal(unbound.completionEvidenceRevision, null);
  assert.equal(unbound.processLifecycle, 'RUNNING', 'process liveness is still reported');

  // A binding whose pane wmux never reported is still evaluated, and its lifecycle is UNKNOWN.
  const orphan = deriveLaneTaskStates({
    lanes: [],
    bindings: [binding(7)],
    artifactEvidence: evidenceFor([[binding(7), readOutcome(COMPLETE_TEXT)]]),
    observedAt: AT,
  });
  assert.equal(orphan[0].processLifecycle, 'UNKNOWN');
  assert.equal(orphan[0].taskState, 'COMPLETED_EVIDENCE');
});

// ---------------------------------------------------------------------------
// monotonicity, and the generation that bounds it
// ---------------------------------------------------------------------------

test('a completion is monotonic within a generation and never silently reverts', () => {
  const bound = binding(1);
  const first = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(COMPLETE_TEXT)]]),
    observedAt: AT,
  });
  assert.equal(first[0].taskState, 'COMPLETED_EVIDENCE');

  const later = '2026-08-30T03:46:00.000Z';
  const stable = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(COMPLETE_TEXT)]]),
    previousTaskStates: first,
    observedAt: later,
  });
  assert.equal(stable[0].taskState, 'COMPLETED_EVIDENCE');
  assert.equal(
    stable[0].completionObservedAt, AT,
    'the first sighting is pinned; a completion instant that advanced would be a pace signal',
  );
  assert.equal(stable[0].completionEvidenceRevision, first[0].completionEvidenceRevision);

  for (const outcome of [ABSENT, readOutcome('the marker was removed\n'), refusedOutcome('ARTIFACT_UNREADABLE')]) {
    const contradicted = deriveLaneTaskStates({
      lanes: [lane(1)],
      bindings: [bound],
      artifactEvidence: evidenceFor([[bound, outcome]]),
      previousTaskStates: first,
      observedAt: later,
    });
    assert.equal(contradicted[0].taskState, 'REFUSED_EVIDENCE');
    assert.equal(contradicted[0].evidenceReason, 'COMPLETION_EVIDENCE_CONTRADICTED');
    assert.notEqual(contradicted[0].taskState, 'RUNNING', 'and never back to RUNNING');
  }

  // A different artifact under the same binding and generation is a contradiction too.
  const swapped = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(`someone elses work\n\n${MARKER}\n`)]]),
    previousTaskStates: first,
    observedAt: later,
  });
  assert.equal(swapped[0].evidenceReason, 'COMPLETION_EVIDENCE_CONTRADICTED');
});

test('a refusal is sticky for the rest of its generation', () => {
  const bound = binding(1);
  const refused = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, refusedOutcome('ARTIFACT_UNSTABLE')]]),
    observedAt: AT,
  });
  assert.equal(refused[0].taskState, 'REFUSED_EVIDENCE');

  const after = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(COMPLETE_TEXT)]]),
    previousTaskStates: refused,
    observedAt: '2026-08-30T03:46:00.000Z',
  });
  assert.equal(after[0].taskState, 'REFUSED_EVIDENCE');
  assert.equal(after[0].evidenceReason, 'REFUSAL_IS_STICKY_WITHIN_GENERATION');
  assert.equal(after[0].artifactDigest, null, 'a refusal carries no evidence');
});

test('a new generation starts from fresh evidence and inherits no completion', () => {
  const bound = binding(1);
  const completed = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(COMPLETE_TEXT)]]),
    observedAt: AT,
  });
  assert.equal(completed[0].generation, 0);

  // 1. The binding content-addresses differently: a new agent, artifact, marker or source.
  const rebound = binding(1, { sourceRevision: 'f'.repeat(64) });
  const afterRebind = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [rebound],
    artifactEvidence: evidenceFor([[rebound, ABSENT]]),
    previousTaskStates: completed,
    observedAt: '2026-08-30T03:46:00.000Z',
  });
  assert.equal(afterRebind[0].generation, 1, 'the generation moved');
  assert.equal(afterRebind[0].taskState, 'RUNNING', 'and no completion was inherited');
  assert.equal(afterRebind[0].completionObservedAt, null);
  assert.equal(afterRebind[0].bindingRevision, laneArtifactBindingRevision(rebound));

  // 2. The pane restarted under the same identity: not RUNNING last tick, RUNNING now.
  const exited = deriveLaneTaskStates({
    lanes: [lane(1, { lifecycle: 'EXITED' })],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(COMPLETE_TEXT)]]),
    previousTaskStates: completed,
    observedAt: '2026-08-30T03:46:00.000Z',
  });
  assert.equal(exited[0].generation, 0, 'leaving RUNNING is not a new generation');
  const restarted = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(COMPLETE_TEXT)]]),
    previousTaskStates: exited,
    observedAt: '2026-08-30T03:47:00.000Z',
  });
  assert.equal(restarted[0].generation, 1, 'returning to RUNNING is');
  assert.equal(
    restarted[0].completionObservedAt, '2026-08-30T03:47:00.000Z',
    'the new generation re-observes the marker for itself rather than inheriting the instant',
  );

  // 3. A sticky refusal does not survive its generation either.
  const refused = deriveLaneTaskStates({
    lanes: [lane(1, { lifecycle: 'EXITED' })],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, refusedOutcome('ARTIFACT_UNSTABLE')]]),
    observedAt: AT,
  });
  const freshRun = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(COMPLETE_TEXT)]]),
    previousTaskStates: refused,
    observedAt: '2026-08-30T03:46:00.000Z',
  });
  assert.equal(freshRun[0].generation, refused[0].generation + 1);
  assert.equal(freshRun[0].taskState, 'COMPLETED_EVIDENCE');
});

test('a forged prior completion cannot survive one tick of real evidence', () => {
  const bound = binding(1);
  // Whoever can write the observation file can also recompute a self-consistent address, so the
  // defence is not the digest: it is that the next tick re-reads the artifact and contradicts it.
  const forged = [completedEntry({ artifactDigest: digestOf('a completion that never happened') })];

  const next = deriveLaneTaskStates({
    lanes: [lane(1)],
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(COMPLETE_TEXT)]]),
    previousTaskStates: forged,
    observedAt: '2026-08-30T03:46:00.000Z',
  });

  assert.equal(next[0].taskState, 'REFUSED_EVIDENCE');
  assert.equal(next[0].evidenceReason, 'COMPLETION_EVIDENCE_CONTRADICTED');
});

test('the derivation is deterministic: identical evidence replays to identical bytes', () => {
  const bindings = [binding(3), binding(1), binding(2)];
  const artifactEvidence = evidenceFor([
    [binding(1), readOutcome(COMPLETE_TEXT)],
    [binding(2), ABSENT],
    [binding(3), refusedOutcome('ARTIFACT_TOO_LARGE')],
  ]);
  const input = { lanes: [lane(2), lane(3), lane(1)], bindings, artifactEvidence, observedAt: AT };

  const once = deriveLaneTaskStates(input);
  const twice = deriveLaneTaskStates({ ...input, lanes: [...input.lanes].reverse() });

  assert.equal(JSON.stringify(once), JSON.stringify(twice));
  assert.deepEqual(once.map(({ agentId }) => agentId), ['agent-1', 'agent-2', 'agent-3']);
  assert.deepEqual(
    once.map(({ taskState }) => taskState),
    ['COMPLETED_EVIDENCE', 'RUNNING', 'REFUSED_EVIDENCE'],
  );
});

// ---------------------------------------------------------------------------
// what a task state may never say
// ---------------------------------------------------------------------------

test('a completion claims evidence and nothing else — no approval, pace, ETA or GitHub binding', () => {
  const bound = binding(1);
  const observation = observeLocalLanes({
    agents: [agent(1)],
    observedAt: AT,
    bindings: [bound],
    artifactEvidence: evidenceFor([[bound, readOutcome(COMPLETE_TEXT)]]),
  });
  const bytes = JSON.stringify(observation);

  for (const forbidden of [
    /approv/iu, /success/iu, /percent/iu, /\bpace\b/iu, /\beta\b/iu, /elapsed/iu,
    /github/iu, /pull_?request/iu, /\bissue\b/iu, /\brepositor/iu, /\bremain/iu,
    /forecast/iu, /\bdone\b/iu, /reap/iu, /\bkill/iu,
  ]) {
    assert.equal(forbidden.test(bytes), false, `a completion must never say ${forbidden}`);
  }
  assert.equal(bytes.includes(ARTIFACT_ROOT), false, 'and never leaks the local artifact path');
  assert.equal(bytes.includes(MARKER), false, 'nor republishes the marker it was told to look for');
  assert.equal(observation.effect, 'NONE');
  assert.equal(observation.authority, 'NONE');
  assert.deepEqual(
    LANE_TASK_STATES,
    ['UNBOUND', 'RUNNING', 'COMPLETED_EVIDENCE', 'REFUSED_EVIDENCE', 'UNKNOWN'],
  );
  assert.equal(
    Object.values(LANE_EVIDENCE_REASONS).every((state) => LANE_TASK_STATES.includes(state)), true,
    'every reason names a state in the closed vocabulary',
  );
});

// ---------------------------------------------------------------------------
// the verifier: what a published observation must survive
// ---------------------------------------------------------------------------

test('taskStates is optional, and a lane-only observation is byte-identical to before', () => {
  const observation = sealLocalLaneObservation({ observedAt: AT, lanes: [lane(1)] });

  assert.equal(Object.hasOwn(observation, 'taskStates'), false);
  assert.deepEqual(Object.keys(observation).sort(), [
    'authority', 'effect', 'lanes', 'observedAt', 'revision', 'schema', 'source',
  ]);
  assert.throws(
    () => requireLocalLaneObservation({ ...structuredClone(observation), taskStates: null }),
    (error) => error instanceof LocalLaneObservationError,
    'an absent task state list omits the field entirely, and never publishes null',
  );
});

test('a published processLifecycle must be the lifecycle its own lane reported', () => {
  const lanes = [lane(1)];

  assert.doesNotThrow(() => requireLocalLaneObservation(
    withTaskStates(lanes, [completedEntry()]),
  ));
  assert.throws(
    () => requireLocalLaneObservation(
      withTaskStates(lanes, [completedEntry({ processLifecycle: 'EXITED' })]),
    ),
    (error) => error instanceof LocalLaneObservationError && /lifecycle/u.test(error.message),
    'the two axes stay independent by being cross-checked, not by being merged',
  );
  assert.throws(
    () => requireLocalLaneObservation(
      withTaskStates([], [completedEntry()]),
    ),
    (error) => error instanceof LocalLaneObservationError && /lifecycle/u.test(error.message),
    'an entry whose lane wmux never reported must say UNKNOWN, not RUNNING',
  );
  assert.doesNotThrow(() => requireLocalLaneObservation(
    withTaskStates([], [completedEntry({ processLifecycle: 'UNKNOWN' })]),
  ));
});

test('a published taskState of RUNNING requires a process that is actually running', () => {
  const entry = completedEntry({
    taskState: 'RUNNING',
    evidenceReason: 'ARTIFACT_IN_PROGRESS',
    artifactDigest: null,
    completionObservedAt: null,
  });
  const running = { ...entry, completionEvidenceRevision: null };

  assert.doesNotThrow(() => requireLocalLaneObservation(withTaskStates([lane(1)], [running])));
  assert.throws(
    () => requireLocalLaneObservation(withTaskStates(
      [lane(1, { lifecycle: 'EXITED' })],
      [{ ...running, processLifecycle: 'EXITED' }],
    )),
    (error) => error instanceof LocalLaneObservationError,
    'taskState RUNNING beside a process that is not running is a contradiction',
  );
});

test('completion evidence is refused unless it addresses its own binding, digest and instant', () => {
  const lanes = [lane(1)];

  for (const tamper of [
    { artifactDigest: digestOf('some other artifact') },
    { completionObservedAt: '2026-08-30T04:00:00.000Z' },
    { bindingRevision: 'b'.repeat(64) },
    { generation: 3 },
    { agentId: 'agent-1x' },
  ]) {
    assert.throws(
      () => requireLocalLaneObservation(withTaskStates(
        lanes, [{ ...completedEntry(), ...tamper }],
      )),
      (error) => error instanceof LocalLaneObservationError,
      `editing ${Object.keys(tamper)[0]} without re-addressing must be refused`,
    );
  }
  assert.throws(
    () => requireLocalLaneObservation(withTaskStates(
      lanes, [{ ...completedEntry(), completionEvidenceRevision: 'a'.repeat(64) }],
    )),
    (error) => error instanceof LocalLaneObservationError,
  );
});

test('the three evidence fields are present exactly when the state is COMPLETED_EVIDENCE', () => {
  const complete = completedEntry();

  for (const partial of [
    { artifactDigest: null },
    { completionObservedAt: null },
    { completionEvidenceRevision: null },
    { completionObservedAt: '2026-08-30' },
    { completionObservedAt: '2026-08-30T03:45:00Z' },
  ]) {
    assert.throws(
      () => requireLocalLaneObservation(withTaskStates([lane(1)], [{ ...complete, ...partial }])),
      (error) => error instanceof LocalLaneObservationError,
      `a completion missing ${Object.keys(partial)[0]} is not a completion`,
    );
  }
  for (const state of ['UNBOUND', 'RUNNING', 'REFUSED_EVIDENCE', 'UNKNOWN']) {
    assert.throws(
      () => requireLocalLaneObservation(withTaskStates([lane(1)], [{ ...complete, taskState: state }])),
      (error) => error instanceof LocalLaneObservationError,
      `${state} may carry no completion evidence`,
    );
  }
});

test('a task state entry is closed, ordered, bounded and reason-consistent', () => {
  const complete = completedEntry();

  assert.throws(
    () => requireLocalLaneObservation(withTaskStates([lane(1)], [{ ...complete, reap: true }])),
    (error) => error instanceof LocalLaneObservationError && /unknown field/u.test(error.message),
  );
  assert.throws(
    () => requireLocalLaneObservation(withTaskStates(
      [lane(1)], [{ ...complete, evidenceReason: 'ARTIFACT_IN_PROGRESS' }],
    )),
    (error) => error instanceof LocalLaneObservationError,
    'a reason that names a different state is a contradiction, not a caption',
  );
  assert.throws(
    () => requireLocalLaneObservation(withTaskStates(
      [lane(1)], [{ ...complete, evidenceReason: 'WORK_LOOKS_DONE' }],
    )),
    (error) => error instanceof LocalLaneObservationError,
  );
  assert.throws(
    () => requireLocalLaneObservation(withTaskStates([lane(1)], [complete, complete])),
    (error) => error instanceof LocalLaneObservationError && /order/u.test(error.message),
  );
  for (const generation of [-1, 1.5, MAX_LANE_GENERATION + 1, '0', null]) {
    assert.throws(
      () => requireLocalLaneObservation(withTaskStates(
        [lane(1)], [completedEntry({ generation })],
      )),
      (error) => error instanceof LocalLaneObservationError,
      `generation ${JSON.stringify(generation)} is not a bounded generation`,
    );
  }
  assert.equal(MAX_LANE_TASK_STATES, 128);
});
