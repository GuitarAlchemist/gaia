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
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LOCAL_LANE_LABEL_STATES,
  LOCAL_LANE_LIFECYCLES,
  LOCAL_LANE_OBSERVATION_FRESH_MS,
  LOCAL_LANE_OBSERVATION_SCHEMA,
  LOCAL_LANE_SOURCE,
  LocalLaneObservationError,
  MAX_OBSERVED_LANES,
  UNKNOWN_IDENTITY,
  requireLocalLaneObservation,
  sealLocalLaneObservation,
} from '../src/local-lane-observation.mjs';
import {
  LocalLaneSensorError,
  WMUX_LANE_METADATA_FIELDS,
  WMUX_STATUS_LIFECYCLE,
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
