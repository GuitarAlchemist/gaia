import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildControlRoomSnapshot } from '../src/control-room.mjs';
import {
  DRAIN_TELEMETRY_STEP_SCHEMA,
  DrainTelemetryError,
  runInstrumentedDrainTransition,
} from '../src/factory-drain-telemetry.mjs';
import { replayFactoryTelemetry } from '../src/factory-telemetry.mjs';
import {
  factoryTelemetryLogPath,
  readFactoryTelemetryLog,
} from '../src/factory-telemetry-log.mjs';
import {
  portfolioDrainLedgerPath,
  readPortfolioDrainLedger,
} from '../src/portfolio-drain-ledger.mjs';
import { reconcilePortfolioDrain } from '../src/portfolio-drain.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'gaia-drain-telemetry-test-'));
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

const TITLE = 'Repair the passive telemetry spine before the operator review';
const WORK_ITEM = Object.freeze({
  repository: 'GuitarAlchemist/gaia',
  itemKind: 'ISSUE',
  itemId: 'issue-27',
  itemNumber: 27,
  title: TITLE,
  state: 'READY',
  updatedAt: '2026-08-29T12:00:00.000Z',
});

function portfolio(workItems = [WORK_ITEM]) {
  const body = { schema: 'gaia-github-portfolio/1', policyRevision: 'policy-a', workItems };
  return { ...body, revision: sha256(canonicalJson(body)) };
}

let scratchCounter = 0;
function workspace(name) {
  scratchCounter += 1;
  const base = join(ROOT, `${name}-${scratchCounter}`);
  return { ledgerDirectory: join(base, 'ledger'), telemetryDirectory: join(base, 'telemetry') };
}

/** A deterministic, strictly increasing local clock so replay evidence is exact. */
function clock(startedAt = '2026-08-29T18:00:00.000Z', stepMs = 1_000) {
  let tick = -1;
  return () => {
    tick += 1;
    return new Date(Date.parse(startedAt) + (tick * stepMs));
  };
}

const BASE = {
  lane: 'LANE_A',
  agent: 'CLAUDE_WORKER',
  runId: 'run-27-alpha',
};

test('one bounded drain transition emits the closed arc and records exactly one receipt', () => {
  const { ledgerDirectory, telemetryDirectory } = workspace('recorded');
  const snapshot = portfolio();

  const step = runInstrumentedDrainTransition({
    ...BASE,
    ledgerDirectory,
    telemetryDirectory,
    portfolio: snapshot,
    itemId: 'issue-27',
    event: 'CLAIMED',
    now: clock(),
  });

  assert.equal(step.schema, DRAIN_TELEMETRY_STEP_SCHEMA);
  assert.equal(step.outcome, 'TRANSITION_RECORDED');
  assert.equal(step.blocker, null);
  assert.equal(step.authority, 'NONE');
  assert.equal(step.effect, 'LOCAL_LEDGER_APPEND');
  assert.equal(step.runId, 'run-27-alpha');
  assert.equal(step.repository, 'GuitarAlchemist/gaia');
  assert.equal(step.drainStateBefore, 'QUEUED');
  assert.equal(step.drainStateAfter, 'CLAIMED');
  assert.match(step.receiptRevision, /^[a-f0-9]{64}$/u);

  const ledger = readPortfolioDrainLedger({ directory: ledgerDirectory });
  assert.equal(ledger.count, 1);
  assert.equal(ledger.receipts[0].event, 'CLAIMED');
  assert.equal(ledger.revision, step.ledgerRevisionAfter);

  const log = readFactoryTelemetryLog({ directory: telemetryDirectory });
  assert.deepEqual(log.events.map(({ event }) => event), [
    'run.started', 'run.heartbeat', 'gate.entered', 'gate.passed', 'run.completed',
  ]);
  assert.deepEqual(log.events.map(({ sequence }) => sequence), [0, 1, 2, 3, 4]);
  assert.equal(log.events[2].gate, 'CLAIMED');
  assert.equal(log.events[3].gate, 'CLAIMED');
  assert.equal(log.revision, step.telemetryLogRevision);

  const projection = replayFactoryTelemetry({ events: log.events });
  assert.equal(projection.runs[0].runState, 'COMPLETED');
  assert.equal(projection.runs[0].lane, 'LANE_A');
  assert.equal(projection.runs[0].agent, 'CLAUDE_WORKER');
});

test('the telemetry evidence reference binds the exact ledger heads the run observed', () => {
  const { ledgerDirectory, telemetryDirectory } = workspace('evidence');
  const step = runInstrumentedDrainTransition({
    ...BASE,
    ledgerDirectory,
    telemetryDirectory,
    portfolio: portfolio(),
    itemId: 'issue-27',
    event: 'CLAIMED',
    now: clock(),
  });
  const { events } = readFactoryTelemetryLog({ directory: telemetryDirectory });

  assert.equal(events[0].evidenceRevision, step.ledgerRevisionBefore);
  assert.equal(events[3].evidenceRevision, step.ledgerRevisionAfter);
  assert.equal(events[4].evidenceRevision, step.ledgerRevisionAfter);
  assert.notEqual(step.ledgerRevisionBefore, step.ledgerRevisionAfter);
});

test('NEGATIVE CONTROL: an impermissible transition is an explicit no-op that blocks truthfully', () => {
  const { ledgerDirectory, telemetryDirectory } = workspace('refused');

  const step = runInstrumentedDrainTransition({
    ...BASE,
    ledgerDirectory,
    telemetryDirectory,
    portfolio: portfolio(),
    itemId: 'issue-27',
    event: 'PUBLISHED',
    now: clock(),
  });

  assert.equal(step.outcome, 'TRANSITION_REFUSED');
  assert.equal(step.blocker, 'TRANSITION_INVALID');
  assert.equal(step.effect, 'NONE');
  assert.equal(step.authority, 'NONE');
  assert.equal(step.receiptRevision, null);
  assert.equal(step.ledgerRevisionAfter, step.ledgerRevisionBefore);
  assert.equal(step.drainStateAfter, 'QUEUED');
  assert.equal(readPortfolioDrainLedger({ directory: ledgerDirectory }).count, 0);

  const { events } = readFactoryTelemetryLog({ directory: telemetryDirectory });
  assert.deepEqual(events.map(({ event }) => event), [
    'run.started', 'run.heartbeat', 'gate.entered', 'gate.failed', 'run.blocked',
  ]);
  assert.equal(events[4].blocker, 'TRANSITION_INVALID');
  const projection = replayFactoryTelemetry({ events });
  assert.equal(projection.runs[0].runState, 'BLOCKED');
  assert.equal(projection.runs[0].blocker, 'TRANSITION_INVALID');
});

test('the observed run animates at its heartbeat and expires truthfully afterwards', () => {
  const { ledgerDirectory, telemetryDirectory } = workspace('animation');
  const snapshot = portfolio();
  const drainProjection = reconcilePortfolioDrain({ portfolio: snapshot, receipts: [] });
  const views = [];

  const step = runInstrumentedDrainTransition({
    ...BASE,
    ledgerDirectory,
    telemetryDirectory,
    portfolio: snapshot,
    itemId: 'issue-27',
    event: 'CLAIMED',
    now: clock(),
    observe: ({ event, log }) => {
      if (event.event !== 'run.heartbeat') return;
      const telemetryProjection = replayFactoryTelemetry({ events: log.events });
      const beatMs = Date.parse(event.observedAt);
      views.push(['fresh', buildControlRoomSnapshot({
        drainProjection,
        observedAt: new Date(beatMs).toISOString(),
        telemetryProjection,
      })]);
      views.push(['expired', buildControlRoomSnapshot({
        drainProjection,
        observedAt: new Date(beatMs + 30_001).toISOString(),
        telemetryProjection,
      })]);
    },
  });

  assert.equal(step.outcome, 'TRANSITION_RECORDED');
  const [[, fresh], [, expired]] = views;
  assert.equal(fresh.headline.state, 'ACTIVE');
  assert.equal(fresh.showSpinner, true);
  assert.equal(fresh.items[0].telemetry.runState, 'RUNNING');
  assert.equal(fresh.telemetry.activeRuns, 1);

  assert.equal(expired.headline.state, 'STALE');
  assert.equal(expired.showSpinner, false);
  assert.equal(expired.nextAction.kind, 'CHECK_STALE_RUN');
  assert.equal(expired.items[0].telemetry.evidenceAgeMs, 30_001);
  assert.deepEqual(
    expired.blockers.find(({ state }) => state === 'TELEMETRY_HEARTBEAT_EXPIRED'),
    { state: 'TELEMETRY_HEARTBEAT_EXPIRED', count: 1 },
  );

  const finished = buildControlRoomSnapshot({
    drainProjection,
    observedAt: '2026-08-29T18:10:00.000Z',
    telemetryProjection: replayFactoryTelemetry({
      events: readFactoryTelemetryLog({ directory: telemetryDirectory }).events,
    }),
  });
  assert.equal(finished.headline.state, 'PAUSED');
  assert.equal(finished.showSpinner, false);
  assert.equal(finished.items[0].telemetry.runState, 'COMPLETED');
  assert.equal(finished.items[0].activity.state, 'IDLE');
});

test('two bounded steps chain the ledger without reusing one run identity', () => {
  const { ledgerDirectory, telemetryDirectory } = workspace('chained');
  const snapshot = portfolio();
  const common = {
    ...BASE, ledgerDirectory, telemetryDirectory, portfolio: snapshot, itemId: 'issue-27',
  };

  const claimed = runInstrumentedDrainTransition({
    ...common, runId: 'run-27-alpha', event: 'CLAIMED', now: clock('2026-08-29T18:00:00.000Z'),
  });
  const started = runInstrumentedDrainTransition({
    ...common, runId: 'run-27-bravo', event: 'STARTED', now: clock('2026-08-29T18:05:00.000Z'),
  });

  assert.equal(claimed.drainStateAfter, 'CLAIMED');
  assert.equal(started.drainStateBefore, 'CLAIMED');
  assert.equal(started.drainStateAfter, 'RUNNING');
  assert.equal(readPortfolioDrainLedger({ directory: ledgerDirectory }).count, 2);

  const log = readFactoryTelemetryLog({ directory: telemetryDirectory });
  assert.equal(log.count, 10);
  const projection = replayFactoryTelemetry({ events: log.events });
  assert.equal(projection.counts.runs, 2);
  assert.equal(projection.counts.completed, 2);
  assert.deepEqual(projection.items, [{ itemId: 'issue-27', runId: 'run-27-bravo' }]);
});

test('NEGATIVE CONTROL: reusing a finished run identity fails closed and writes nothing new', () => {
  const { ledgerDirectory, telemetryDirectory } = workspace('reused');
  const snapshot = portfolio();
  const common = {
    ...BASE, ledgerDirectory, telemetryDirectory, portfolio: snapshot, itemId: 'issue-27',
  };
  runInstrumentedDrainTransition({
    ...common, event: 'CLAIMED', now: clock('2026-08-29T18:00:00.000Z'),
  });
  const before = readFactoryTelemetryLog({ directory: telemetryDirectory });

  assert.throws(
    () => runInstrumentedDrainTransition({
      ...common, event: 'STARTED', now: clock('2026-08-29T18:05:00.000Z'),
    }),
    (error) => error?.code === 'TelemetrySequenceConflict',
  );
  assert.equal(readFactoryTelemetryLog({ directory: telemetryDirectory }).count, before.count);
  assert.equal(readPortfolioDrainLedger({ directory: ledgerDirectory }).count, 1);
});

test('NEGATIVE CONTROL: an unknown item starts no run and touches neither durable log', () => {
  const { ledgerDirectory, telemetryDirectory } = workspace('unknown');

  assert.throws(
    () => runInstrumentedDrainTransition({
      ...BASE,
      ledgerDirectory,
      telemetryDirectory,
      portfolio: portfolio(),
      itemId: 'issue-404',
      event: 'CLAIMED',
      now: clock(),
    }),
    (error) => error instanceof DrainTelemetryError && error.code === 'ItemUnobserved',
  );
  assert.equal(existsSync(factoryTelemetryLogPath(telemetryDirectory)), false);
  assert.equal(existsSync(portfolioDrainLedgerPath(ledgerDirectory)), false);
});

test('NEGATIVE CONTROL: the durable telemetry bytes never carry the portfolio prose', () => {
  const { ledgerDirectory, telemetryDirectory } = workspace('prose');
  runInstrumentedDrainTransition({
    ...BASE,
    ledgerDirectory,
    telemetryDirectory,
    portfolio: portfolio(),
    itemId: 'issue-27',
    event: 'CLAIMED',
    now: clock(),
  });

  const bytes = readFileSync(factoryTelemetryLogPath(telemetryDirectory), 'utf8');
  assert.doesNotMatch(bytes, /Repair the passive telemetry spine/u);
  assert.doesNotMatch(bytes, /policy-a/u);
  assert.match(bytes, /issue-27/u);
  // The drain ledger keeps the observed source title; the telemetry spine deliberately does not.
  assert.match(readFileSync(portfolioDrainLedgerPath(ledgerDirectory), 'utf8'), /Repair the passive/u);
});

test('the arm refuses an unsupported drain event before observing anything', () => {
  const { ledgerDirectory, telemetryDirectory } = workspace('unsupported');

  assert.throws(
    () => runInstrumentedDrainTransition({
      ...BASE,
      ledgerDirectory,
      telemetryDirectory,
      portfolio: portfolio(),
      itemId: 'issue-27',
      event: 'MERGE_EVERYTHING',
      now: clock(),
    }),
    (error) => error instanceof DrainTelemetryError && error.code === 'StepRequestInvalid',
  );
  assert.equal(existsSync(factoryTelemetryLogPath(telemetryDirectory)), false);
});
