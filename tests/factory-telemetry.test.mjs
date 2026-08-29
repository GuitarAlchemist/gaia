import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  FACTORY_TELEMETRY_EVENTS,
  FACTORY_TELEMETRY_EVENT_SCHEMA,
  FACTORY_TELEMETRY_MACHINE,
  FACTORY_TELEMETRY_PROJECTION_SCHEMA,
  FactoryTelemetryError,
  buildFactoryTelemetryEvent,
  replayFactoryTelemetry,
  verifyFactoryTelemetryEvent,
} from '../src/factory-telemetry.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const SUBJECT = Object.freeze({
  repository: 'GuitarAlchemist/gaia',
  itemId: 'issue-27',
  itemNumber: 27,
  lane: 'LANE_A',
  agent: 'CLAUDE_WORKER',
  itemRevision: 'a'.repeat(64),
});

const EVIDENCE = 'b'.repeat(64);

/** Build one chained run through the public builder, exactly as a writer would. */
function run(runId, steps, subject = SUBJECT) {
  const events = [];
  let previous = null;
  for (const step of steps) {
    previous = buildFactoryTelemetryEvent({ runId, subject, previous, ...step });
    events.push(previous);
  }
  return events;
}

const CLOSED_RUN = [
  { event: 'run.started', observedAt: '2026-08-29T18:00:00.000Z', evidenceRevision: EVIDENCE },
  { event: 'run.heartbeat', observedAt: '2026-08-29T18:00:05.000Z' },
  { event: 'gate.entered', gate: 'CLAIMED', observedAt: '2026-08-29T18:00:06.000Z' },
  {
    event: 'gate.passed',
    gate: 'CLAIMED',
    observedAt: '2026-08-29T18:00:07.000Z',
    evidenceRevision: 'c'.repeat(64),
  },
  {
    event: 'run.completed',
    observedAt: '2026-08-29T18:00:08.000Z',
    evidenceRevision: 'c'.repeat(64),
  },
];

/**
 * Re-hash a mutated body so the mutation reaches the gate under test rather than merely
 * failing the content-address check that guards every other gate.
 */
function forge(event, overrides, { rehash = true } = {}) {
  const { revision, ...body } = { ...event, ...overrides };
  return rehash ? { ...body, revision: sha256(canonicalJson(body)) } : { ...body, revision };
}

test('the closed event set is exactly the seven passive facts the spine may record', () => {
  assert.deepEqual([...FACTORY_TELEMETRY_EVENTS].sort(), [
    'gate.entered', 'gate.failed', 'gate.passed',
    'run.blocked', 'run.completed', 'run.heartbeat', 'run.started',
  ]);
});

test('one started event binds typed identity and an honest UNKNOWN where evidence is absent', () => {
  const [started] = run('run-27-alpha', [
    { event: 'run.started', observedAt: '2026-08-29T18:00:00.000Z' },
  ]);

  assert.equal(started.schema, FACTORY_TELEMETRY_EVENT_SCHEMA);
  assert.equal(started.machineId, FACTORY_TELEMETRY_MACHINE.machineId);
  assert.equal(started.machineVersion, FACTORY_TELEMETRY_MACHINE.machineVersion);
  assert.equal(started.rulesRevision, FACTORY_TELEMETRY_MACHINE.rulesRevision);
  assert.equal(started.runId, 'run-27-alpha');
  assert.equal(started.repository, SUBJECT.repository);
  assert.equal(started.itemId, SUBJECT.itemId);
  assert.equal(started.itemNumber, SUBJECT.itemNumber);
  assert.equal(started.lane, SUBJECT.lane);
  assert.equal(started.agent, SUBJECT.agent);
  assert.equal(started.itemRevision, SUBJECT.itemRevision);
  assert.equal(started.sequence, 0);
  assert.equal(started.previousRevision, null);
  assert.equal(started.gate, null);
  assert.equal(started.blocker, null);
  assert.equal(started.evidenceRevision, 'UNKNOWN');
  assert.equal(started.observedAt, '2026-08-29T18:00:00.000Z');
  const { revision, ...body } = started;
  assert.equal(revision, sha256(canonicalJson(body)));
  assert.equal(Object.isFrozen(started), true);
  assert.equal(verifyFactoryTelemetryEvent(started), started);
});

test('a complete local run replays into one closed projection with its verified transition', () => {
  const projection = replayFactoryTelemetry({ events: run('run-27-alpha', CLOSED_RUN) });

  assert.equal(projection.schema, FACTORY_TELEMETRY_PROJECTION_SCHEMA);
  assert.equal(projection.effect, 'NONE');
  assert.equal(projection.authority, 'NONE');
  assert.equal(projection.runs.length, 1);
  const [only] = projection.runs;
  assert.equal(only.runId, 'run-27-alpha');
  assert.equal(only.runState, 'COMPLETED');
  assert.equal(only.currentGate, null);
  assert.equal(only.blocker, null);
  assert.equal(only.startedAt, '2026-08-29T18:00:00.000Z');
  assert.equal(only.lastEventAt, '2026-08-29T18:00:08.000Z');
  assert.equal(only.elapsedMs, 8_000);
  assert.equal(only.lastHeartbeatAt, '2026-08-29T18:00:05.000Z');
  assert.deepEqual(only.lastTransition, {
    event: 'run.completed',
    gate: null,
    sequence: 4,
    observedAt: '2026-08-29T18:00:08.000Z',
    evidenceRevision: 'c'.repeat(64),
  });
  assert.equal(only.gatesPassed, 1);
  assert.equal(only.gatesFailed, 0);
  assert.equal(only.eventCount, 5);
  assert.deepEqual(projection.items, [{ itemId: 'issue-27', runId: 'run-27-alpha' }]);
  assert.deepEqual(projection.counts, { runs: 1, active: 0, blocked: 0, completed: 1 });
  const { revision, ...body } = projection;
  assert.equal(revision, sha256(canonicalJson(body)));
});

test('a run still inside a gate reports that gate and heartbeat without inventing progress', () => {
  const projection = replayFactoryTelemetry({
    events: run('run-27-alpha', CLOSED_RUN.slice(0, 3)),
  });
  const [only] = projection.runs;

  assert.equal(only.runState, 'IN_GATE');
  assert.equal(only.currentGate, 'CLAIMED');
  assert.equal(only.lastHeartbeatAt, '2026-08-29T18:00:05.000Z');
  assert.deepEqual(only.lastTransition, {
    event: 'gate.entered',
    gate: 'CLAIMED',
    sequence: 2,
    observedAt: '2026-08-29T18:00:06.000Z',
    evidenceRevision: 'UNKNOWN',
  });
  assert.deepEqual(projection.counts, { runs: 1, active: 1, blocked: 0, completed: 0 });
});

test('replay is deterministic under shuffling and idempotent under duplicate delivery', () => {
  const events = run('run-27-alpha', CLOSED_RUN);
  const once = replayFactoryTelemetry({ events });
  const shuffled = replayFactoryTelemetry({
    events: [events[3], events[0], events[4], events[1], events[2]],
  });
  const duplicated = replayFactoryTelemetry({ events: [...events, ...events] });

  assert.equal(shuffled.revision, once.revision);
  assert.equal(duplicated.revision, once.revision);
  assert.equal(duplicated.runs[0].eventCount, 5);
});

test('a blocked run names its blocker and admits nothing afterwards', () => {
  const blocked = run('run-27-alpha', [
    CLOSED_RUN[0],
    CLOSED_RUN[1],
    CLOSED_RUN[2],
    { event: 'gate.failed', gate: 'CLAIMED', observedAt: '2026-08-29T18:00:07.000Z' },
    {
      event: 'run.blocked',
      blocker: 'TRANSITION_NOT_PERMITTED',
      observedAt: '2026-08-29T18:00:08.000Z',
    },
  ]);
  const projection = replayFactoryTelemetry({ events: blocked });
  const [only] = projection.runs;

  assert.equal(only.runState, 'BLOCKED');
  assert.equal(only.blocker, 'TRANSITION_NOT_PERMITTED');
  assert.equal(only.gatesFailed, 1);
  assert.deepEqual(projection.counts, { runs: 1, active: 0, blocked: 1, completed: 0 });

  const afterwards = forge(blocked.at(-1), {
    sequence: 5,
    previousRevision: blocked.at(-1).revision,
    event: 'run.heartbeat',
    blocker: null,
    observedAt: '2026-08-29T18:00:09.000Z',
  });
  assert.throws(
    () => replayFactoryTelemetry({ events: [...blocked, afterwards] }),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryTransitionInvalid',
  );
});

test('NEGATIVE CONTROL: a gap in the monotonic sequence fails closed', () => {
  const events = run('run-27-alpha', CLOSED_RUN);
  assert.throws(
    () => replayFactoryTelemetry({ events: [events[0], events[2], events[3], events[4]] }),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetrySequenceGap',
  );
});

test('NEGATIVE CONTROL: two different events at one sequence position fail closed', () => {
  const events = run('run-27-alpha', CLOSED_RUN);
  const substitute = forge(events[1], { observedAt: '2026-08-29T18:00:04.000Z' });
  assert.notEqual(substitute.revision, events[1].revision);
  assert.throws(
    () => replayFactoryTelemetry({ events: [...events, substitute] }),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetrySequenceConflict',
  );
});

test('NEGATIVE CONTROL: a reordered predecessor link fails closed', () => {
  const events = run('run-27-alpha', CLOSED_RUN);
  const detached = forge(events[2], { previousRevision: events[0].revision });
  assert.throws(
    () => replayFactoryTelemetry({ events: [events[0], events[1], detached] }),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryChainBroken',
  );
});

test('NEGATIVE CONTROL: substituting the item, lane or agent mid-run fails closed', () => {
  const events = run('run-27-alpha', CLOSED_RUN);
  for (const substitution of [
    { itemId: 'issue-99' }, { repository: 'GuitarAlchemist/ix' }, { itemNumber: 99 },
    { lane: 'LANE_B' }, { agent: 'CODEX_REVIEWER' }, { itemRevision: 'd'.repeat(64) },
  ]) {
    const forged = forge(events[1], substitution);
    assert.throws(
      () => replayFactoryTelemetry({ events: [events[0], forged] }),
      (error) => error instanceof FactoryTelemetryError
        && error.code === 'TelemetryIdentitySubstituted',
      `${canonicalJson(substitution)} must not be accepted`,
    );
  }
});

test('NEGATIVE CONTROL: impossible transitions fail closed', () => {
  const [started] = run('run-27-alpha', CLOSED_RUN);
  const passedWithoutEntering = forge(started, {
    sequence: 1,
    previousRevision: started.revision,
    event: 'gate.passed',
    gate: 'CLAIMED',
    observedAt: '2026-08-29T18:00:01.000Z',
  });
  assert.throws(
    () => replayFactoryTelemetry({ events: [started, passedWithoutEntering] }),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryTransitionInvalid',
  );

  const opened = run('run-27-alpha', CLOSED_RUN.slice(0, 3));
  const completedInsideGate = forge(opened.at(-1), {
    sequence: 3,
    previousRevision: opened.at(-1).revision,
    event: 'run.completed',
    gate: null,
    observedAt: '2026-08-29T18:00:07.000Z',
  });
  assert.throws(
    () => replayFactoryTelemetry({ events: [...opened, completedInsideGate] }),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryTransitionInvalid',
  );
});

test('NEGATIVE CONTROL: leaving a different gate than the one entered fails closed', () => {
  const opened = run('run-27-alpha', CLOSED_RUN.slice(0, 3));
  const wrongGate = forge(opened.at(-1), {
    sequence: 3,
    previousRevision: opened.at(-1).revision,
    event: 'gate.passed',
    gate: 'PUBLISHED',
    observedAt: '2026-08-29T18:00:07.000Z',
  });
  assert.throws(
    () => replayFactoryTelemetry({ events: [...opened, wrongGate] }),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryGateMismatch',
  );
});

test('NEGATIVE CONTROL: a run that never started fails closed', () => {
  const events = run('run-27-alpha', CLOSED_RUN);
  const orphan = forge(events[1], { sequence: 0, previousRevision: null });
  assert.throws(
    () => replayFactoryTelemetry({ events: [orphan] }),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryRunUnstarted',
  );
});

test('NEGATIVE CONTROL: an unknown future event type fails closed rather than being ignored', () => {
  const [started] = run('run-27-alpha', CLOSED_RUN);
  const future = forge(started, {
    sequence: 1,
    previousRevision: started.revision,
    event: 'run.resumed',
    observedAt: '2026-08-29T18:00:01.000Z',
  });
  assert.throws(
    () => verifyFactoryTelemetryEvent(future),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryEventUnknown',
  );
  assert.throws(
    () => replayFactoryTelemetry({ events: [started, future] }),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryEventUnknown',
  );
});

test('NEGATIVE CONTROL: invalid and future observation times fail closed', () => {
  const events = run('run-27-alpha', CLOSED_RUN);
  const backwards = forge(events[1], { observedAt: '2026-08-29T17:59:59.000Z' });
  assert.throws(
    () => replayFactoryTelemetry({ events: [events[0], backwards] }),
    (error) => error instanceof FactoryTelemetryError
      && error.code === 'TelemetryTimestampReordered',
  );
  assert.throws(
    () => replayFactoryTelemetry({ events, notAfter: '2026-08-29T18:00:06.500Z' }),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryTimestampFuture',
  );
  assert.doesNotThrow(
    () => replayFactoryTelemetry({ events, notAfter: '2026-08-29T18:00:08.000Z' }),
  );
  for (const observedAt of [
    '2026-08-29', '2026-08-29T18:00:00Z', '2026-08-29T18:00:00.000+02:00', 'later',
  ]) {
    assert.throws(
      () => buildFactoryTelemetryEvent({
        runId: 'run-27-alpha', subject: SUBJECT, previous: null, event: 'run.started', observedAt,
      }),
      (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryEventInvalid',
      `${observedAt} must not be accepted`,
    );
  }
});

test('NEGATIVE CONTROL: a corrupted event body fails closed against its content address', () => {
  const [started] = run('run-27-alpha', CLOSED_RUN);
  const corrupted = forge(started, { itemId: 'issue-99' }, { rehash: false });
  assert.throws(
    () => verifyFactoryTelemetryEvent(corrupted),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryEventInvalid',
  );
});

test('NEGATIVE CONTROL: the closed field set refuses prompt, reasoning and log payloads', () => {
  const [started] = run('run-27-alpha', CLOSED_RUN);
  for (const smuggled of [
    { prompt: 'system prompt text' }, { reasoning: 'chain of thought' },
    { stdout: 'terminal screen' }, { token: 'ghp_secret' }, { diff: 'source contents' },
  ]) {
    const forged = forge(started, smuggled);
    assert.throws(
      () => verifyFactoryTelemetryEvent(forged),
      (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryEventInvalid',
      `${Object.keys(smuggled)[0]} must not be persistable`,
    );
  }
});

test('NEGATIVE CONTROL: gate and blocker tokens are closed to the event that owns them', () => {
  const invalid = (error) => error instanceof FactoryTelemetryError
    && error.code === 'TelemetryEventInvalid';
  assert.throws(() => buildFactoryTelemetryEvent({
    runId: 'run-27-alpha', subject: SUBJECT, previous: null, event: 'run.started',
    observedAt: '2026-08-29T18:00:00.000Z', gate: 'CLAIMED',
  }), invalid);
  assert.throws(() => buildFactoryTelemetryEvent({
    runId: 'run-27-alpha', subject: SUBJECT, previous: null, event: 'run.started',
    observedAt: '2026-08-29T18:00:00.000Z', blocker: 'NOPE',
  }), invalid);
  const [started] = run('run-27-alpha', CLOSED_RUN);
  assert.throws(() => buildFactoryTelemetryEvent({
    runId: 'run-27-alpha', subject: SUBJECT, previous: started, event: 'gate.entered',
    observedAt: '2026-08-29T18:00:01.000Z',
  }), invalid);
  assert.throws(() => buildFactoryTelemetryEvent({
    runId: 'run-27-alpha', subject: SUBJECT, previous: started, event: 'run.blocked',
    observedAt: '2026-08-29T18:00:01.000Z',
  }), invalid);
});

test('NEGATIVE CONTROL: identity fields are canonical tokens, never free text', () => {
  for (const subject of [
    { ...SUBJECT, lane: 'lane a' },
    { ...SUBJECT, agent: 'Claude Code session log line' },
    { ...SUBJECT, repository: 'not a repository' },
    { ...SUBJECT, itemId: 'issue 27 reviewed by someone' },
    { ...SUBJECT, itemRevision: 'not-a-revision' },
    { ...SUBJECT, itemNumber: 0 },
  ]) {
    assert.throws(
      () => buildFactoryTelemetryEvent({
        runId: 'run-27-alpha', subject, previous: null, event: 'run.started',
        observedAt: '2026-08-29T18:00:00.000Z',
      }),
      (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryEventInvalid',
      `${canonicalJson(subject)} must not be accepted`,
    );
  }
  for (const runId of ['Run-27', 'run 27', 'short', '']) {
    assert.throws(
      () => buildFactoryTelemetryEvent({
        runId, subject: SUBJECT, previous: null, event: 'run.started',
        observedAt: '2026-08-29T18:00:00.000Z',
      }),
      (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryEventInvalid',
      `${runId} must not be accepted`,
    );
  }
});

test('NEGATIVE CONTROL: two concurrent unfinished runs for one item fail closed', () => {
  const first = run('run-27-alpha', CLOSED_RUN.slice(0, 2));
  const second = run('run-27-bravo', CLOSED_RUN.slice(0, 2));
  assert.throws(
    () => replayFactoryTelemetry({ events: [...first, ...second] }),
    (error) => error instanceof FactoryTelemetryError && error.code === 'TelemetryItemAmbiguous',
  );
});

test('a finished run and a fresh run for the same item select the unfinished one', () => {
  const finished = run('run-27-alpha', CLOSED_RUN);
  const fresh = run('run-27-bravo', [
    { event: 'run.started', observedAt: '2026-08-29T18:10:00.000Z' },
    { event: 'run.heartbeat', observedAt: '2026-08-29T18:10:05.000Z' },
  ]);
  const projection = replayFactoryTelemetry({ events: [...finished, ...fresh] });

  assert.equal(projection.runs.length, 2);
  assert.deepEqual(projection.items, [{ itemId: 'issue-27', runId: 'run-27-bravo' }]);
  assert.deepEqual(projection.counts, { runs: 2, active: 1, blocked: 0, completed: 1 });
});

test('an unsupported interpreter binding fails closed rather than being reinterpreted', () => {
  const [started] = run('run-27-alpha', CLOSED_RUN);
  const unsupported = (error) => error instanceof FactoryTelemetryError
    && error.code === 'TelemetryMachineUnsupported';
  assert.throws(() => verifyFactoryTelemetryEvent(forge(started, { machineVersion: 2 })), unsupported);
  assert.throws(
    () => verifyFactoryTelemetryEvent(forge(started, { rulesRevision: 'e'.repeat(64) })),
    unsupported,
  );
});
