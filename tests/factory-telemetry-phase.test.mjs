import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runFactoryDashboardCli } from '../scripts/factory-dashboard.mjs';
import {
  FACTORY_TELEMETRY_PHASES,
  FACTORY_TELEMETRY_PHASE_RECEIPT_SCHEMA,
  FactoryTelemetryPhaseError,
  recordFactoryTelemetryPhase,
} from '../src/factory-telemetry-phase.mjs';
import {
  factoryTelemetryLogLockPath,
  factoryTelemetryLogPath,
  readFactoryTelemetryLog,
} from '../src/factory-telemetry-log.mjs';
import {
  FACTORY_TELEMETRY_EVENTS,
  replayFactoryTelemetry,
} from '../src/factory-telemetry.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-telemetry-phase-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const WORK_ITEM = Object.freeze({
  repository: 'GuitarAlchemist/gaia',
  itemKind: 'ISSUE',
  itemId: 'issue-27',
  itemNumber: 27,
  title: 'Add the passive factory telemetry spine',
  state: 'READY',
  updatedAt: '2026-08-29T12:00:00.000Z',
});

const SUBJECT = Object.freeze({
  repository: 'GuitarAlchemist/gaia',
  itemId: 'issue-27',
  itemNumber: 27,
  lane: 'LANE_A',
  agent: 'CLAUDE_WORKER',
  itemRevision: 'UNKNOWN',
});

let counter = 0;
function workspace(workItems = [WORK_ITEM]) {
  counter += 1;
  const base = join(scratch, `case-${counter}`);
  mkdirSync(base, { recursive: true });
  const body = { schema: 'gaia-github-portfolio/1', policyRevision: 'policy-r0', workItems };
  const portfolio = {
    ...body,
    revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
  const portfolioPath = join(base, 'portfolio.json');
  writeFileSync(portfolioPath, `${JSON.stringify(portfolio, null, 2)}\n`, 'utf8');
  return { base, portfolioPath, telemetryDirectory: join(base, 'telemetry') };
}

/** Every phase call is its own invocation, so the clock is explicit rather than sequential. */
const at = (instant) => () => new Date(instant);

/** Render the shipped dashboard from the durable log, exactly as an operator would. */
function render({ base, portfolioPath, telemetryDirectory }, label, observedAt) {
  const htmlPath = join(base, `control-room-${label}.html`);
  const snapshot = runFactoryDashboardCli([
    '--portfolio', portfolioPath,
    '--telemetry', telemetryDirectory,
    '--snapshot-out', join(base, `control-room-${label}.json`),
    '--html-out', htmlPath,
  ], { now: at(observedAt), writeStdout: () => {} });
  return { snapshot, html: readFileSync(htmlPath, 'utf8') };
}

test('the phase seam maps exactly the seven existing telemetry event kinds', () => {
  const kinds = Object.values(FACTORY_TELEMETRY_PHASES);
  assert.deepEqual([...kinds].sort(), [...FACTORY_TELEMETRY_EVENTS].sort());
  assert.equal(new Set(kinds).size, FACTORY_TELEMETRY_EVENTS.length);
  assert.equal(Object.isFrozen(FACTORY_TELEMETRY_PHASES), true);
});

test('a run held open across phases renders ACTIVE, then STALE, then settled across separate dashboard invocations', () => {
  const space = workspace();
  const { telemetryDirectory } = space;
  const runId = 'run-27-phase-arc';
  const logPath = factoryTelemetryLogPath(telemetryDirectory);

  const started = recordFactoryTelemetryPhase({
    directory: telemetryDirectory,
    runId,
    phase: 'start',
    subject: SUBJECT,
    now: at('2026-08-29T18:00:00.000Z'),
  });
  assert.equal(started.schema, FACTORY_TELEMETRY_PHASE_RECEIPT_SCHEMA);
  assert.equal(started.event, 'run.started');
  assert.equal(started.sequence, 0);
  assert.equal(started.runState, 'RUNNING');
  assert.equal(started.effect, 'LOCAL_TELEMETRY_APPEND');
  assert.equal(started.authority, 'NONE');

  // The seam returned. Nothing terminal was written, so the run is genuinely open on disk.
  const openLog = readFactoryTelemetryLog({ directory: telemetryDirectory });
  assert.equal(openLog.count, 1);
  assert.equal(
    replayFactoryTelemetry({ events: openLog.events }).runs[0].runState, 'RUNNING',
  );

  recordFactoryTelemetryPhase({
    directory: telemetryDirectory, runId, phase: 'heartbeat', now: at('2026-08-29T18:00:01.000Z'),
  });
  recordFactoryTelemetryPhase({
    directory: telemetryDirectory,
    runId,
    phase: 'gate-entered',
    gate: 'CLAIMED',
    now: at('2026-08-29T18:00:02.000Z'),
  });
  const beat = recordFactoryTelemetryPhase({
    directory: telemetryDirectory, runId, phase: 'heartbeat', now: at('2026-08-29T18:00:03.000Z'),
  });
  assert.equal(beat.runState, 'IN_GATE');
  assert.equal(beat.currentGate, 'CLAIMED');

  const bytesWhileOpen = readFileSync(logPath, 'utf8');

  // 1. A separate dashboard invocation, reading only the durable log, sees a moving run.
  const active = render(space, 'active', '2026-08-29T18:00:08.000Z');
  assert.equal(active.snapshot.headline.state, 'ACTIVE');
  assert.equal(active.snapshot.showSpinner, true);
  assert.equal(active.snapshot.telemetry.activeRuns, 1);
  assert.equal(active.snapshot.items[0].activity.state, 'ACTIVE');
  assert.equal(active.snapshot.items[0].activity.showPulse, true);
  assert.equal(active.snapshot.items[0].activity.stage, 'CLAIMED');
  assert.equal(active.snapshot.items[0].telemetry.runState, 'IN_GATE');
  assert.equal(active.snapshot.items[0].telemetry.heartbeatFresh, true);
  assert.equal(active.snapshot.nextAction.kind, 'OBSERVE_ACTIVE_RUN');
  assert.match(active.html, /class="heartbeat-pulse"/u);
  assert.match(active.html, /@keyframes heartbeat/u);

  // 2. Freshness expires with no further heartbeat, and the SAME log now reads STALE.
  const stale = render(space, 'stale', '2026-08-29T18:00:33.001Z');
  assert.equal(stale.snapshot.headline.state, 'STALE');
  assert.equal(stale.snapshot.showSpinner, false);
  assert.equal(stale.snapshot.telemetry.activeRuns, 0);
  assert.equal(stale.snapshot.telemetry.staleRuns, 1);
  assert.equal(stale.snapshot.items[0].activity.state, 'STALE');
  assert.equal(stale.snapshot.items[0].activity.showPulse, false);
  assert.equal(stale.snapshot.items[0].telemetry.heartbeatFresh, false);
  assert.ok(stale.snapshot.items[0].telemetry.evidenceAgeMs >= 30_001);
  assert.deepEqual(
    stale.snapshot.blockers.find(({ state }) => state === 'TELEMETRY_HEARTBEAT_EXPIRED'),
    { state: 'TELEMETRY_HEARTBEAT_EXPIRED', count: 1 },
  );
  assert.equal(stale.snapshot.nextAction.kind, 'CHECK_STALE_RUN');
  assert.equal(stale.snapshot.nextAction.itemId, 'issue-27');
  assert.doesNotMatch(stale.html, /class="heartbeat-pulse"/u);

  // Nothing was written to reach STALE: the transition is time passing, not an event.
  assert.equal(readFileSync(logPath, 'utf8'), bytesWhileOpen);

  // 3. The same run is closed by a later invocation and settles for good.
  recordFactoryTelemetryPhase({
    directory: telemetryDirectory,
    runId,
    phase: 'gate-passed',
    gate: 'CLAIMED',
    now: at('2026-08-29T18:00:34.000Z'),
  });
  const finished = recordFactoryTelemetryPhase({
    directory: telemetryDirectory, runId, phase: 'finish', now: at('2026-08-29T18:00:35.000Z'),
  });
  assert.equal(finished.event, 'run.completed');
  assert.equal(finished.runState, 'COMPLETED');

  const settled = render(space, 'settled', '2026-08-29T18:00:40.000Z');
  assert.equal(settled.snapshot.headline.state, 'PAUSED');
  assert.equal(settled.snapshot.showSpinner, false);
  assert.equal(settled.snapshot.items[0].activity.state, 'IDLE');
  assert.equal(settled.snapshot.items[0].telemetry.runState, 'COMPLETED');
  assert.deepEqual(settled.snapshot.blockers, []);
  assert.doesNotMatch(settled.html, /class="heartbeat-pulse"/u);

  // The log only ever grew, and the bytes observed while the run was open are still a prefix.
  const finalBytes = readFileSync(logPath, 'utf8');
  assert.equal(finalBytes.startsWith(bytesWhileOpen), true);
  assert.equal(finalBytes.split('\n').filter(Boolean).length, 6);
});

test('the durable phase log replays deterministically and carries only the closed fields', () => {
  const { telemetryDirectory } = workspace();
  const runId = 'run-27-phase-replay';
  const now = at('2026-08-29T18:00:00.000Z');
  recordFactoryTelemetryPhase({
    directory: telemetryDirectory,
    runId,
    phase: 'start',
    subject: { ...SUBJECT, itemRevision: 'a'.repeat(64) },
    now,
  });
  recordFactoryTelemetryPhase({
    directory: telemetryDirectory, runId, phase: 'heartbeat', now: at('2026-08-29T18:00:01.000Z'),
  });

  const { events } = readFactoryTelemetryLog({ directory: telemetryDirectory });
  const first = replayFactoryTelemetry({ events });
  const shuffled = replayFactoryTelemetry({ events: [...events].reverse() });
  assert.equal(first.revision, shuffled.revision);
  assert.equal(replayFactoryTelemetry({ events: [...events, ...events] }).revision, first.revision);

  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [
      'agent', 'blocker', 'evidenceRevision', 'event', 'gate', 'itemId', 'itemNumber',
      'itemRevision', 'lane', 'machineId', 'machineVersion', 'observedAt', 'previousRevision',
      'repository', 'revision', 'rulesRevision', 'runId', 'schema', 'sequence',
    ].sort());
  }
});

test('an identical phase re-delivery is an idempotent no-op', () => {
  const { telemetryDirectory } = workspace();
  const runId = 'run-27-phase-idempotent';
  recordFactoryTelemetryPhase({
    directory: telemetryDirectory,
    runId,
    phase: 'start',
    subject: SUBJECT,
    now: at('2026-08-29T18:00:00.000Z'),
  });
  const first = recordFactoryTelemetryPhase({
    directory: telemetryDirectory, runId, phase: 'heartbeat', now: at('2026-08-29T18:00:01.000Z'),
  });
  const again = recordFactoryTelemetryPhase({
    directory: telemetryDirectory, runId, phase: 'heartbeat', now: at('2026-08-29T18:00:01.000Z'),
  });

  assert.equal(first.duplicate, false);
  assert.equal(first.effect, 'LOCAL_TELEMETRY_APPEND');
  assert.equal(again.duplicate, true);
  assert.equal(again.effect, 'NONE');
  assert.equal(again.eventRevision, first.eventRevision);
  assert.equal(readFactoryTelemetryLog({ directory: telemetryDirectory }).count, 2);
});

test('the phase seam fails closed and writes nothing on every malformed request', () => {
  const { telemetryDirectory } = workspace();
  const runId = 'run-27-phase-refusals';
  const before = () => readFactoryTelemetryLog({ directory: telemetryDirectory });

  const refuses = (request, code) => {
    const count = before().count;
    assert.throws(
      () => recordFactoryTelemetryPhase({ directory: telemetryDirectory, ...request }),
      (error) => error?.code === code,
      `expected ${code}`,
    );
    assert.equal(before().count, count, `${code} must write nothing`);
  };

  refuses({ runId, phase: 'run.resumed', now: at('2026-08-29T18:00:00.000Z') }, 'PhaseUnknown');
  refuses({ runId, phase: 'heartbeat', now: at('2026-08-29T18:00:00.000Z') }, 'PhaseRunUnstarted');
  refuses({ runId, phase: 'start', now: at('2026-08-29T18:00:00.000Z') }, 'PhaseSubjectRequired');

  recordFactoryTelemetryPhase({
    directory: telemetryDirectory,
    runId,
    phase: 'start',
    subject: SUBJECT,
    now: at('2026-08-29T18:00:00.000Z'),
  });

  refuses(
    { runId, phase: 'start', subject: SUBJECT, now: at('2026-08-29T18:00:01.000Z') },
    'PhaseRunAlreadyStarted',
  );
  refuses(
    {
      runId,
      phase: 'heartbeat',
      subject: { ...SUBJECT, agent: 'SOMEONE_ELSE' },
      now: at('2026-08-29T18:00:01.000Z'),
    },
    'PhaseSubjectSubstituted',
  );
  refuses(
    { runId, phase: 'gate-passed', gate: 'CLAIMED', now: at('2026-08-29T18:00:01.000Z') },
    'TelemetryTransitionInvalid',
  );
  refuses(
    { runId, phase: 'gate-entered', now: at('2026-08-29T18:00:01.000Z') },
    'TelemetryEventInvalid',
  );
  refuses(
    { runId, phase: 'block', now: at('2026-08-29T18:00:01.000Z') },
    'TelemetryEventInvalid',
  );

  recordFactoryTelemetryPhase({
    directory: telemetryDirectory, runId, phase: 'finish', now: at('2026-08-29T18:00:02.000Z'),
  });
  refuses(
    { runId, phase: 'heartbeat', now: at('2026-08-29T18:00:03.000Z') },
    'TelemetryTransitionInvalid',
  );
});

test('the phase seam refuses to touch the log without its lock', () => {
  const { telemetryDirectory } = workspace();
  const runId = 'run-27-phase-locked';
  recordFactoryTelemetryPhase({
    directory: telemetryDirectory,
    runId,
    phase: 'start',
    subject: SUBJECT,
    now: at('2026-08-29T18:00:00.000Z'),
  });
  mkdirSync(factoryTelemetryLogLockPath(telemetryDirectory));
  try {
    assert.throws(() => recordFactoryTelemetryPhase({
      directory: telemetryDirectory,
      runId,
      phase: 'heartbeat',
      now: at('2026-08-29T18:00:01.000Z'),
      lockOptions: { timeoutMs: 0 },
    }), (error) => error?.name === 'LockTimeoutError');
  } finally {
    rmSync(factoryTelemetryLogLockPath(telemetryDirectory), { recursive: true, force: true });
  }
  assert.equal(readFactoryTelemetryLog({ directory: telemetryDirectory }).count, 1);
});

test('NEGATIVE CONTROL: an open run cannot animate a dashboard whose item it is not', () => {
  const space = workspace();
  recordFactoryTelemetryPhase({
    directory: space.telemetryDirectory,
    runId: 'run-99-phase-foreign',
    phase: 'start',
    subject: { ...SUBJECT, itemId: 'issue-99', itemNumber: 99 },
    now: at('2026-08-29T18:00:00.000Z'),
  });
  recordFactoryTelemetryPhase({
    directory: space.telemetryDirectory,
    runId: 'run-99-phase-foreign',
    phase: 'heartbeat',
    now: at('2026-08-29T18:00:01.000Z'),
  });

  const { snapshot, html } = render(space, 'foreign', '2026-08-29T18:00:05.000Z');
  assert.equal(snapshot.headline.state, 'PAUSED');
  assert.equal(snapshot.showSpinner, false);
  assert.equal(snapshot.telemetry.unmatchedRuns, 1);
  assert.equal(snapshot.items[0].telemetry, null);
  assert.doesNotMatch(html, /class="heartbeat-pulse"/u);
});

test('NEGATIVE CONTROL: the phase receipt is data and the error type is exported', () => {
  assert.equal(FactoryTelemetryPhaseError.prototype instanceof Error, true);
  const { telemetryDirectory } = workspace();
  const receipt = recordFactoryTelemetryPhase({
    directory: telemetryDirectory,
    runId: 'run-27-phase-frozen',
    phase: 'start',
    subject: SUBJECT,
    now: at('2026-08-29T18:00:00.000Z'),
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(receipt.authority, 'NONE');
  assert.equal(typeof receipt.logRevision, 'string');
  assert.equal(receipt.logRevision.length, 64);
});
