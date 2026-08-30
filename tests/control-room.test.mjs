import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildControlRoomSnapshot, renderControlRoomHtml } from '../src/control-room.mjs';
import {
  buildFactoryTelemetryEvent,
  replayFactoryTelemetry,
} from '../src/factory-telemetry.mjs';

const SHA = 'a'.repeat(64);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

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
  return {
    ...body,
    revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}

function item(overrides = {}) {
  return {
    repository: 'GuitarAlchemist/gaia',
    itemKind: 'ISSUE',
    itemId: 'issue-17',
    itemNumber: 17,
    title: 'Integrate the factory control room',
    sourceState: 'READY',
    observedPortfolioRevision: SHA,
    drainState: 'RUNNING',
    hold: null,
    ...overrides,
  };
}

test('an idle portfolio is plainly paused and never gets a spinner or invented ETA', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection(),
    observedAt: '2026-08-29T18:40:00.000Z',
  });

  assert.equal(snapshot.schema, 'gaia-control-room/1');
  assert.equal(snapshot.effect, 'NONE');
  assert.equal(snapshot.authority, 'NONE');
  assert.deepEqual(snapshot.headline, {
    state: 'PAUSED',
    label: 'Paused',
    detail: 'No tracked factory run is moving. '
      + 'The drain is empty: no work item is eligible to move.',
  });
  assert.equal(snapshot.activeCount, 0);
  assert.equal(snapshot.showSpinner, false);
  assert.deepEqual(snapshot.eta, {
    state: 'UNKNOWN',
    label: 'Unknown',
    reason: 'There is no active run to estimate.',
  });
  assert.equal(snapshot.portfolioCompletion.percentage, null);
  assert.match(snapshot.portfolioCompletion.reason, /open queue/u);
  const { revision, ...body } = snapshot;
  assert.equal(
    revision,
    createHash('sha256').update(canonicalJson(body)).digest('hex'),
    'the displayed snapshot binds every displayed field',
  );
});

test('only a fresh running heartbeat animates and the item exposes named lifecycle gates', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: '2026-08-29T18:40:20.000Z',
    progressObservations: [{
      itemId: 'issue-17',
      capturedAt: '2026-08-29T18:40:15.000Z',
      record: {
        schema: 'gaia-cli-progress/1',
        stage: 'worker_running',
        elapsedMs: 35_000,
        remainingProviderInvocations: 4,
        remainingProviderTimeUpperBoundMs: 2_400_000,
        heartbeat: true,
      },
    }],
  });

  assert.equal(snapshot.headline.state, 'ACTIVE');
  assert.equal(snapshot.activeCount, 1);
  assert.equal(snapshot.showSpinner, true);
  assert.equal(snapshot.items[0].activity.state, 'ACTIVE');
  assert.equal(snapshot.items[0].activity.stage, 'worker_running');
  assert.deepEqual(snapshot.items[0].progress, {
    completedGates: 2,
    totalGates: 5,
    percentage: 40,
    currentGate: 'Build and independently review the candidate',
  });
  assert.deepEqual(snapshot.nextAction, {
    kind: 'OBSERVE_ACTIVE_RUN',
    itemId: 'issue-17',
    label: 'Wait for the worker result, then run the independent review.',
  });
});

test('a recorded RUNNING item without a fresh heartbeat is visibly stale, not animated', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: '2026-08-29T18:41:00.000Z',
    progressObservations: [{
      itemId: 'issue-17',
      capturedAt: '2026-08-29T18:40:00.000Z',
      record: {
        schema: 'gaia-cli-progress/1',
        stage: 'worker_running',
        elapsedMs: 35_000,
        remainingProviderInvocations: 4,
        remainingProviderTimeUpperBoundMs: 2_400_000,
        heartbeat: true,
      },
    }],
  });

  assert.equal(snapshot.headline.state, 'STALE');
  assert.equal(snapshot.activeCount, 0);
  assert.equal(snapshot.showSpinner, false);
  assert.equal(snapshot.items[0].activity.state, 'STALE');
  assert.deepEqual(snapshot.nextAction, {
    kind: 'CHECK_STALE_RUN',
    itemId: 'issue-17',
    label: 'Check the run: its last heartbeat is stale.',
  });
});

test('a fresh progress record without a real heartbeat is stale and never animates', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: '2026-08-29T18:40:20.000Z',
    progressObservations: [{
      itemId: 'issue-17', capturedAt: '2026-08-29T18:40:15.000Z',
      record: {
        schema: 'gaia-cli-progress/1', stage: 'worker_running', elapsedMs: 35_000,
        heartbeat: false,
      },
    }],
  });

  assert.equal(snapshot.headline.state, 'STALE');
  assert.equal(snapshot.activeCount, 0);
  assert.equal(snapshot.showSpinner, false);
  assert.equal(snapshot.items[0].activity.state, 'STALE');
});

test('ETA appears only from at least five comparable completed runs and states its sample', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: '2026-08-29T18:40:20.000Z',
    progressObservations: [{
      itemId: 'issue-17',
      capturedAt: '2026-08-29T18:40:15.000Z',
      record: {
        schema: 'gaia-cli-progress/1', stage: 'worker_running', elapsedMs: 35_000,
        remainingProviderInvocations: 4, remainingProviderTimeUpperBoundMs: 2_400_000,
        heartbeat: true,
      },
    }],
    completedRuns: [80_000, 100_000, 120_000, 140_000, 160_000].map((elapsedMs) => ({
      workflow: 'portfolio-factory-run', outcome: 'COMPLETED', elapsedMs,
    })),
  });

  assert.deepEqual(snapshot.pace, {
    state: 'MEASURED',
    sampleSize: 5,
    medianCycleMs: 120_000,
    label: 'Historical median: 2m per comparable completed run.',
  });
  assert.deepEqual(snapshot.eta, {
    state: 'FORECAST',
    label: 'Between 1m 5s and 1m 45s',
    remainingRangeMs: [65_000, 105_000],
    sampleSize: 5,
    method: 'historical-interquartile-range',
  });
});

test('a portfolio with multiple active runs has no fabricated single-run ETA', () => {
  const active = (itemId, elapsedMs) => ({
    itemId, capturedAt: '2026-08-29T18:40:15.000Z',
    record: { schema: 'gaia-cli-progress/1', stage: 'worker_running', elapsedMs, heartbeat: true },
  });
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([
      item({ itemId: 'issue-17' }), item({ itemId: 'issue-18', itemNumber: 18 }),
    ]),
    observedAt: '2026-08-29T18:40:20.000Z',
    progressObservations: [active('issue-17', 35_000), active('issue-18', 50_000)],
    completedRuns: [80_000, 100_000, 120_000, 140_000, 160_000].map((elapsedMs) => ({
      workflow: 'portfolio-factory-run', outcome: 'COMPLETED', elapsedMs,
    })),
  });

  assert.deepEqual(snapshot.eta, {
    state: 'UNKNOWN', label: 'Unknown', reason: 'More than one run is active.',
  });
});

test('the projection revision is verified and the content-addressed snapshot is deeply immutable', () => {
  const input = projection([item()]);
  assert.throws(() => buildControlRoomSnapshot({
    drainProjection: { ...input, revision: '0'.repeat(64) },
    observedAt: '2026-08-29T18:40:20.000Z',
  }), (error) => error.code === 'InvalidProjection');

  const snapshot = buildControlRoomSnapshot({
    drainProjection: input,
    observedAt: '2026-08-29T18:40:20.000Z',
  });
  assert.equal(Object.isFrozen(snapshot.items), true);
  assert.equal(Object.isFrozen(snapshot.items[0]), true);
  assert.equal(Object.isFrozen(snapshot.items[0].progress), true);
  assert.throws(() => { snapshot.items[0].title = 'mutated'; }, TypeError);
});

test('the selected dashboard seam is bound by a replayable Decision Receipt', () => {
  const design = readFileSync(new URL('../docs/factory-control-room.md', import.meta.url), 'utf8');
  const bodies = [...design.matchAll(/Canonical receipt body:\s*```json\s*([^\n]+)\s*```/gu)]
    .map((match) => JSON.parse(match[1]));
  assert.equal(bodies.length, 2);
  const [body, fogBody] = bodies;

  assert.equal(body.selectedDesign, 'pure-content-addressed-control-room-read-model');
  assert.equal(body.reversibility, 'freely-reversible');
  assert.equal(fogBody.selectedDesign, 'snapshot-bound-fog-of-war-projection');
  assert.equal(fogBody.baseCommit, 'a17392d3cf967bf2d7906d2cbd77dbc01f5f3c87');
  assert.equal(fogBody.reversibility, 'freely-reversible');
  for (const receipt of bodies) {
    const digest = createHash('sha256').update(canonicalJson(receipt)).digest('hex');
    assert.equal(design.includes(`Receipt SHA-256:\n\`${digest}\``), true);
  }
});

test('the standalone dashboard spends its default view only on operator questions and evidence', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'CANDIDATE_READY' })], [{
      action: 'PREPARE_PUBLICATION_INTENT', itemId: 'issue-17', effect: 'NONE',
      requiredAuthority: 'NONE', repository: 'GuitarAlchemist/gaia',
      itemKind: 'ISSUE', itemNumber: 17,
    }]),
    observedAt: '2026-08-29T18:40:20.000Z',
  });
  const html = renderControlRoomHtml(snapshot);

  assert.match(html, /<h1>Gaia — real status<\/h1>/u);
  assert.match(html, /Now/u);
  assert.match(html, /Next action/u);
  assert.match(html, /Verifiable progress/u);
  assert.match(html, /Pace and ETA/u);
  assert.match(html, /Evidence/u);
  assert.match(html, /PREPARE_PUBLICATION_INTENT/u);
  assert.match(html, new RegExp(snapshot.sourceRevision, 'u'));
  assert.match(html, new RegExp(snapshot.revision, 'u'));
  assert.match(html, /60%/u);
  assert.match(html, /The portfolio is an open queue/u);
  assert.doesNotMatch(html, /https?:\/\//u, 'the artifact has no remote dependency');
  assert.doesNotMatch(html, /class="heartbeat-pulse"/u, 'idle state never animates');
});

test('the dashboard pulse is present only when the snapshot carries a fresh real heartbeat', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: '2026-08-29T18:40:20.000Z',
    progressObservations: [{
      itemId: 'issue-17', capturedAt: '2026-08-29T18:40:15.000Z',
      record: {
        schema: 'gaia-cli-progress/1', stage: 'worker_running', elapsedMs: 35_000,
        remainingProviderInvocations: 4, remainingProviderTimeUpperBoundMs: 2_400_000,
        heartbeat: true,
      },
    }],
  });

  const html = renderControlRoomHtml(snapshot);
  assert.match(html, /class="heartbeat-pulse"/u);
  assert.match(html, /data-heartbeat-at="2026-08-29T18:40:15.000Z"/u);
  assert.match(html, /Real heartbeat received/u);
});

test('status meaning is carried by words and symbols, never colour alone', () => {
  const blocked = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'BLOCKED_EVIDENCE' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
  });
  const active = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: '2026-08-29T18:40:20.000Z',
    progressObservations: [{
      itemId: 'issue-17', capturedAt: '2026-08-29T18:40:15.000Z',
      record: {
        schema: 'gaia-cli-progress/1', stage: 'worker_running', elapsedMs: 35_000,
        remainingProviderInvocations: 4, remainingProviderTimeUpperBoundMs: 2_400_000,
        heartbeat: true,
      },
    }],
  });

  assert.match(renderControlRoomHtml(blocked), /data-severity="blocked"[^>]*>.*■.*Blocked/us);
  assert.match(renderControlRoomHtml(blocked), /data-severity="warning"[^>]*>.*▲/us);
  assert.match(renderControlRoomHtml(active), /data-severity="healthy"[^>]*>.*●.*Active/us);
});

test('the optional French renderer translates operator guidance, not only headings', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([17, 18, 19, 20].map((itemNumber) => item({
      itemId: `issue-${itemNumber}`, itemNumber, drainState: 'BLOCKED_EVIDENCE',
    }))),
    observedAt: '2026-08-29T18:40:20.000Z',
  });
  const html = renderControlRoomHtml(snapshot, { language: 'fr' });

  assert.match(html, /Aucune exécution suivie de la factory ne progresse\./u);
  assert.match(html, /4 éléments bloqués en attente de preuves que Gaia ne détient pas/u);
  assert.match(html, /éléments nécessitent des preuves manquantes/u);
  assert.match(html, /Résoudre le blocage nommé avant de mesurer l’avancement/u);
  assert.match(html, /Rythme inconnu/u);
  assert.match(html, /snapshot content-addressed/u);
  assert.doesNotMatch(html, /signed snapshot|snapshot signé/u);
  assert.doesNotMatch(html, /No Gaia work|Aucun travail Gaia|items need missing evidence|Resolve the named blocker/u);
});

test('a blocked portfolio names the dominant blocker instead of pretending there is no next action', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([
      item({ itemId: 'issue-17', drainState: 'BLOCKED_EVIDENCE' }),
      item({ itemId: 'issue-18', drainState: 'BLOCKED_EVIDENCE' }),
      item({ itemId: 'issue-19', drainState: 'BLOCKED_HUMAN' }),
    ]),
    observedAt: '2026-08-29T18:40:20.000Z',
  });

  assert.deepEqual(snapshot.blockers, [
    { state: 'BLOCKED_EVIDENCE', count: 2 },
    { state: 'BLOCKED_HUMAN', count: 1 },
  ]);
  assert.deepEqual(snapshot.nextAction, {
    kind: 'TRIAGE_BLOCKED_EVIDENCE',
    itemId: null,
    label: '2 items need missing evidence before Gaia can schedule them.',
  });
});

test('fog of war distinguishes known, partial and unobserved work without inventing confidence', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([
      item({ itemId: 'issue-known', sourceState: 'AWAITING_HUMAN', drainState: 'BLOCKED_HUMAN' }),
      item({ itemId: 'issue-partial', sourceState: 'CHECKS_AND_REVIEW_UNKNOWN', drainState: 'BLOCKED_EVIDENCE' }),
      item({ itemId: 'issue-ready-unknown', sourceState: 'READY_WITH_UNKNOWN', drainState: 'BLOCKED_UNKNOWN' }),
      item({ itemId: 'issue-unobserved', sourceState: 'EVIDENCE_UNKNOWN', drainState: 'BLOCKED_EVIDENCE' }),
      item({ itemId: 'issue-missing', sourceState: 'MISSING_FROM_OPEN_SNAPSHOT', drainState: 'RECONCILE_REQUIRED' }),
    ]),
    observedAt: '2026-08-29T18:40:20.000Z',
  });

  assert.deepEqual(snapshot.knowledgeCoverage, {
    known: 1,
    partial: 2,
    unobserved: 2,
    total: 5,
    knownPercentage: 20,
    label: '20% currently classified from sufficient evidence (1/5).',
    caveat: 'Evidence coverage only — not completion, correctness or model confidence.',
    frontier: {
      kind: 'RECONNOITER_UNKNOWN_EVIDENCE',
      count: 4,
      label: 'Investigate 4 partially observed or unobserved items.',
    },
  });
  assert.deepEqual(snapshot.items.map(({ knowledgeState }) => knowledgeState), [
    'KNOWN', 'PARTIAL', 'PARTIAL', 'UNOBSERVED', 'UNOBSERVED',
  ]);

  const html = renderControlRoomHtml(snapshot);
  assert.match(html, /Fog of war/u);
  assert.match(html, /20% currently classified from sufficient evidence \(1\/5\)/u);
  assert.match(html, /Known.*1.*Partial.*2.*Unobserved.*2/us);
  assert.match(html, /Evidence coverage only — not completion, correctness or model confidence/u);
  assert.match(html, /Investigate 4 partially observed or unobserved items/u);
});

test('fog of war fails closed when a future source state is not yet understood', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([
      item({ sourceState: 'FUTURE_UNRECOGNIZED_STATE', drainState: 'BLOCKED_UNKNOWN' }),
    ]),
    observedAt: '2026-08-29T18:40:20.000Z',
  });

  assert.equal(snapshot.items[0].knowledgeState, 'UNOBSERVED');
  assert.equal(snapshot.knowledgeCoverage.knownPercentage, 0);
  assert.equal(snapshot.knowledgeCoverage.frontier.count, 1);
});

test('the renderer refuses fog-of-war content that moved under an unchanged revision', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({
      sourceState: 'EVIDENCE_UNKNOWN', drainState: 'BLOCKED_EVIDENCE',
    })]),
    observedAt: '2026-08-29T18:40:20.000Z',
  });
  const tampered = structuredClone(snapshot);
  tampered.knowledgeCoverage.known = 1;
  tampered.knowledgeCoverage.unobserved = 0;
  tampered.knowledgeCoverage.knownPercentage = 100;
  tampered.knowledgeCoverage.label = '100% currently classified from sufficient evidence (1/1).';

  assert.throws(
    () => renderControlRoomHtml(tampered),
    (error) => error?.name === 'ControlRoomError' && error.code === 'InvalidSnapshot',
  );
});

test('the renderer gives a typed refusal for a legacy snapshot without fog-of-war evidence', () => {
  const snapshot = structuredClone(buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: '2026-08-29T18:40:20.000Z',
  }));
  delete snapshot.knowledgeCoverage;
  for (const workItem of snapshot.items) delete workItem.knowledgeState;
  const { revision: ignored, ...body } = snapshot;
  snapshot.revision = createHash('sha256').update(canonicalJson(body)).digest('hex');

  assert.throws(
    () => renderControlRoomHtml(snapshot),
    (error) => error?.name === 'ControlRoomError' && error.code === 'InvalidSnapshot',
  );
});

// ---------------------------------------------------------------------------
// passive factory telemetry spine
// ---------------------------------------------------------------------------

const TELEMETRY_SUBJECT = Object.freeze({
  repository: 'GuitarAlchemist/gaia',
  itemId: 'issue-17',
  itemNumber: 17,
  lane: 'LANE_A',
  agent: 'CLAUDE_WORKER',
  itemRevision: 'a'.repeat(64),
});

/** Replay a real telemetry run through the public kernel, never a hand-written stub. */
function telemetry(steps, { subject = TELEMETRY_SUBJECT, runId = 'run-17-alpha' } = {}) {
  let previous = null;
  const events = steps.map((step) => {
    previous = buildFactoryTelemetryEvent({ runId, subject, previous, ...step });
    return previous;
  });
  return replayFactoryTelemetry({ events });
}

const OPEN_RUN = [
  { event: 'run.started', observedAt: '2026-08-29T18:39:00.000Z' },
  { event: 'gate.entered', gate: 'CLAIMED', observedAt: '2026-08-29T18:39:05.000Z' },
  { event: 'run.heartbeat', observedAt: '2026-08-29T18:40:10.000Z' },
];

test('a fresh telemetry heartbeat animates the control room while the drain queue is idle', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'QUEUED' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    telemetryProjection: telemetry(OPEN_RUN),
  });

  assert.equal(snapshot.headline.state, 'ACTIVE');
  assert.equal(snapshot.activeCount, 1);
  assert.equal(snapshot.showSpinner, true);
  assert.equal(snapshot.nextAction.kind, 'OBSERVE_ACTIVE_RUN');
  const [only] = snapshot.items;
  assert.equal(only.activity.state, 'ACTIVE');
  assert.equal(only.activity.showPulse, true);
  assert.equal(only.activity.stage, 'CLAIMED');
  assert.equal(only.activity.lastHeartbeatAt, '2026-08-29T18:40:10.000Z');
  assert.equal(only.telemetry.runId, 'run-17-alpha');
  assert.equal(only.telemetry.lane, 'LANE_A');
  assert.equal(only.telemetry.agent, 'CLAUDE_WORKER');
  assert.equal(only.telemetry.runState, 'IN_GATE');
  assert.equal(only.telemetry.currentGate, 'CLAIMED');
  assert.equal(only.telemetry.blocker, null);
  assert.equal(only.telemetry.heartbeatFresh, true);
  assert.equal(only.telemetry.freshnessWindowMs, 30_000);
  assert.equal(only.telemetry.evidenceAgeMs, 10_000);
  assert.deepEqual(only.telemetry.lastTransition, {
    event: 'gate.entered',
    gate: 'CLAIMED',
    sequence: 1,
    observedAt: '2026-08-29T18:39:05.000Z',
    evidenceRevision: 'UNKNOWN',
  });
  assert.deepEqual(snapshot.telemetry, {
    observedRuns: 1,
    activeRuns: 1,
    staleRuns: 0,
    blockedRuns: 0,
    unmatchedRuns: 0,
    freshnessWindowMs: 30_000,
    projectionRevision: telemetry(OPEN_RUN).revision,
  });
});

test('NEGATIVE CONTROL: an expired heartbeat becomes a named blockage and stops animating', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'RUNNING' })]),
    observedAt: '2026-08-29T18:40:40.001Z',
    telemetryProjection: telemetry(OPEN_RUN),
  });

  assert.equal(snapshot.headline.state, 'STALE');
  assert.equal(snapshot.activeCount, 0);
  assert.equal(snapshot.staleCount, 1);
  assert.equal(snapshot.showSpinner, false);
  assert.equal(snapshot.nextAction.kind, 'CHECK_STALE_RUN');
  const [only] = snapshot.items;
  assert.equal(only.activity.state, 'STALE');
  assert.equal(only.activity.showPulse, false);
  assert.equal(only.activity.lastHeartbeatAt, null);
  assert.equal(only.telemetry.heartbeatFresh, false);
  assert.equal(only.telemetry.evidenceAgeMs, 30_001);
  assert.deepEqual(
    snapshot.blockers.find(({ state }) => state === 'TELEMETRY_HEARTBEAT_EXPIRED'),
    { state: 'TELEMETRY_HEARTBEAT_EXPIRED', count: 1 },
  );
  assert.equal(snapshot.eta.state, 'UNKNOWN');
  assert.doesNotMatch(renderControlRoomHtml(snapshot), /class="heartbeat-pulse"/u);
});

test('NEGATIVE CONTROL: a started run with no heartbeat at all never animates', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'RUNNING' })]),
    observedAt: '2026-08-29T18:39:10.000Z',
    telemetryProjection: telemetry(OPEN_RUN.slice(0, 2)),
  });

  assert.equal(snapshot.headline.state, 'STALE');
  assert.equal(snapshot.showSpinner, false);
  assert.equal(snapshot.items[0].activity.state, 'STALE');
  assert.equal(snapshot.items[0].telemetry.lastHeartbeatAt, null);
  assert.equal(snapshot.items[0].telemetry.heartbeatFresh, false);
});

test('NEGATIVE CONTROL: telemetry observed after the snapshot instant fails closed', () => {
  assert.throws(
    () => buildControlRoomSnapshot({
      drainProjection: projection([item()]),
      observedAt: '2026-08-29T18:39:04.000Z',
      telemetryProjection: telemetry(OPEN_RUN),
    }),
    (error) => error?.name === 'ControlRoomError' && error.code === 'InvalidTelemetry',
  );
});

test('NEGATIVE CONTROL: a tampered telemetry projection fails closed', () => {
  const tampered = structuredClone(telemetry(OPEN_RUN));
  tampered.runs[0].lastHeartbeatAt = '2026-08-29T18:40:19.000Z';

  assert.throws(
    () => buildControlRoomSnapshot({
      drainProjection: projection([item()]),
      observedAt: '2026-08-29T18:40:20.000Z',
      telemetryProjection: tampered,
    }),
    (error) => error?.name === 'ControlRoomError' && error.code === 'InvalidTelemetry',
  );

  const wrongEffect = structuredClone(telemetry(OPEN_RUN));
  wrongEffect.effect = 'FACTORY_RUN';
  assert.throws(
    () => buildControlRoomSnapshot({
      drainProjection: projection([item()]),
      observedAt: '2026-08-29T18:40:20.000Z',
      telemetryProjection: wrongEffect,
    }),
    (error) => error?.name === 'ControlRoomError' && error.code === 'InvalidTelemetry',
  );
});

test('NEGATIVE CONTROL: a heartbeat recorded against another item cannot animate this one', () => {
  const copied = telemetry(OPEN_RUN, {
    subject: { ...TELEMETRY_SUBJECT, itemId: 'issue-99', itemNumber: 99 },
    runId: 'run-99-alpha',
  });
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'QUEUED' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    telemetryProjection: copied,
  });

  assert.equal(snapshot.headline.state, 'PAUSED');
  assert.equal(snapshot.showSpinner, false);
  assert.equal(snapshot.items[0].telemetry, null);
  assert.equal(snapshot.telemetry.unmatchedRuns, 1);
  assert.equal(snapshot.telemetry.activeRuns, 0);
});

test('a blocked telemetry run is a named blocker and never keeps spinning', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'RUNNING' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    telemetryProjection: telemetry([
      ...OPEN_RUN,
      { event: 'gate.failed', gate: 'CLAIMED', observedAt: '2026-08-29T18:40:12.000Z' },
      {
        event: 'run.blocked',
        blocker: 'TRANSITION_NOT_PERMITTED',
        observedAt: '2026-08-29T18:40:13.000Z',
      },
    ]),
  });

  assert.equal(snapshot.headline.state, 'PAUSED');
  assert.equal(snapshot.showSpinner, false);
  assert.equal(snapshot.items[0].activity.state, 'IDLE');
  assert.equal(snapshot.items[0].telemetry.runState, 'BLOCKED');
  assert.equal(snapshot.items[0].telemetry.blocker, 'TRANSITION_NOT_PERMITTED');
  assert.deepEqual(
    snapshot.blockers.find(({ state }) => state === 'TELEMETRY_TRANSITION_NOT_PERMITTED'),
    { state: 'TELEMETRY_TRANSITION_NOT_PERMITTED', count: 1 },
  );
  assert.equal(snapshot.telemetry.blockedRuns, 1);
  const html = renderControlRoomHtml(snapshot);
  assert.match(html, /<article class="work-item" data-severity="blocked">/u);
  assert.match(html, /TRANSITION_NOT_PERMITTED/u);
  assert.doesNotMatch(html, /class="heartbeat-pulse"/u);
});

test('a completed telemetry run truthfully stops moving and expires', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'CANDIDATE_READY' })]),
    observedAt: '2026-08-29T18:41:20.000Z',
    telemetryProjection: telemetry([
      ...OPEN_RUN,
      { event: 'gate.passed', gate: 'CLAIMED', observedAt: '2026-08-29T18:40:12.000Z' },
      {
        event: 'run.completed',
        observedAt: '2026-08-29T18:40:13.000Z',
        evidenceRevision: 'c'.repeat(64),
      },
    ]),
  });

  assert.equal(snapshot.headline.state, 'PAUSED');
  assert.equal(snapshot.showSpinner, false);
  assert.equal(snapshot.items[0].activity.state, 'IDLE');
  assert.equal(snapshot.items[0].telemetry.runState, 'COMPLETED');
  assert.equal(snapshot.items[0].telemetry.lastTransition.event, 'run.completed');
  assert.equal(snapshot.items[0].telemetry.lastTransition.evidenceRevision, 'c'.repeat(64));
  assert.equal(snapshot.telemetry.activeRuns, 0);
  assert.equal(snapshot.telemetry.staleRuns, 0);
});

test('the rendered control room shows run, gate, last verified transition and evidence age', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'RUNNING' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    telemetryProjection: telemetry(OPEN_RUN),
  });
  const html = renderControlRoomHtml(snapshot);

  assert.match(html, /run-17-alpha/u);
  assert.match(html, /gate\.entered/u);
  assert.match(html, /CLAIMED/u);
  assert.match(html, /Evidence age/u);
  assert.match(html, /class="heartbeat-pulse"/u);
  assert.match(renderControlRoomHtml(snapshot, { language: 'fr' }), /run-17-alpha/u);
});

test('a snapshot with no telemetry keeps its existing shape and reports an empty spine', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: '2026-08-29T18:40:20.000Z',
  });

  assert.equal(snapshot.items[0].telemetry, null);
  assert.deepEqual(snapshot.telemetry, {
    observedRuns: 0,
    activeRuns: 0,
    staleRuns: 0,
    blockedRuns: 0,
    unmatchedRuns: 0,
    freshnessWindowMs: 30_000,
    projectionRevision: null,
  });
});

test('a paused empty drain and a paused blocked drain no longer look the same', () => {
  const emptyDrain = buildControlRoomSnapshot({
    drainProjection: projection(),
    observedAt: '2026-08-29T18:40:20.000Z',
  });
  const blockedDrain = buildControlRoomSnapshot({
    drainProjection: projection([
      item({ itemId: 'issue-17', drainState: 'BLOCKED_EVIDENCE', sourceState: 'CHECKS_UNKNOWN' }),
      item({
        itemId: 'issue-18', itemNumber: 18, drainState: 'BLOCKED_EVIDENCE',
        sourceState: 'CHECKS_UNKNOWN',
      }),
    ]),
    observedAt: '2026-08-29T18:40:20.000Z',
  });

  assert.equal(emptyDrain.headline.state, 'PAUSED');
  assert.equal(blockedDrain.headline.state, 'PAUSED');
  assert.equal(emptyDrain.obstruction.state, 'NO_ELIGIBLE_WORK');
  assert.equal(blockedDrain.obstruction.state, 'EVIDENCE_STARVATION');
  assert.notEqual(
    emptyDrain.headline.detail, blockedDrain.headline.detail,
    'the two opposite pauses must not share one sentence',
  );
  assert.deepEqual(blockedDrain.obstruction.affectedItemIds, ['issue-17', 'issue-18']);
  assert.equal(blockedDrain.obstruction.recovery.kind, 'COLLECT_MISSING_EVIDENCE');
  assert.equal(blockedDrain.obstruction.recovery.effect, 'NONE');
  assert.equal(blockedDrain.obstruction.recovery.authority, 'NONE');
  assert.equal(blockedDrain.obstruction.evidenceRevision, blockedDrain.sourceRevision);
});

test('the obstruction is bound by the snapshot revision it is displayed with', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'BLOCKED_REVIEW' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
  });

  const { revision, ...body } = snapshot;
  assert.equal(revision, createHash('sha256').update(canonicalJson(body)).digest('hex'));
  const { revision: obstructionRevision, ...obstructionBody } = snapshot.obstruction;
  assert.equal(
    obstructionRevision,
    createHash('sha256').update(canonicalJson(obstructionBody)).digest('hex'),
  );
  assert.equal(snapshot.obstruction.state, 'REVIEW_STARVATION');
});

test('the observation window is measured from the pinned evidence, not invented', () => {
  const stalled = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'QUEUED' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:30:20.000Z',
  });
  const justChanged = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'QUEUED' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:40:00.000Z',
  });

  assert.equal(stalled.obstruction.state, 'THROUGHPUT_STALL');
  assert.deepEqual(stalled.obstruction.observationWindow, {
    startedAt: '2026-08-29T18:30:20.000Z',
    endedAt: '2026-08-29T18:40:20.000Z',
    durationMs: 600_000,
  });
  assert.equal(justChanged.obstruction.state, 'NONE');
  assert.equal(justChanged.obstruction.recovery, null);
});

test('NEGATIVE CONTROL: a live heartbeat on long-running work is never an obstruction', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:20:20.000Z',
    progressObservations: [{
      itemId: 'issue-17',
      capturedAt: '2026-08-29T18:40:15.000Z',
      record: {
        schema: 'gaia-cli-progress/1', stage: 'worker_running', elapsedMs: 3_600_000,
        heartbeat: true,
      },
    }],
  });

  assert.equal(snapshot.headline.state, 'ACTIVE');
  assert.equal(snapshot.items[0].activity.elapsedMs, 3_600_000);
  assert.equal(snapshot.obstruction.state, 'NONE');
  assert.equal(snapshot.obstruction.recovery, null);
});

test('NEGATIVE CONTROL: the same run with an expired heartbeat is a named stale lane', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: '2026-08-29T18:45:20.000Z',
    sourceChangedAt: '2026-08-29T18:20:20.000Z',
    progressObservations: [{
      itemId: 'issue-17',
      capturedAt: '2026-08-29T18:40:15.000Z',
      record: {
        schema: 'gaia-cli-progress/1', stage: 'worker_running', elapsedMs: 3_600_000,
        heartbeat: true,
      },
    }],
  });

  assert.equal(snapshot.headline.state, 'STALE');
  assert.equal(snapshot.obstruction.state, 'LANE_STALE');
  assert.deepEqual(snapshot.obstruction.affectedItemIds, ['issue-17']);
  assert.equal(snapshot.obstruction.recovery.kind, 'CHECK_STALE_LANE');
});

test('a declared dependency cycle reaches the control room; identical prose alone does not', () => {
  const drainProjection = projection([
    item({ itemId: 'issue-17', drainState: 'QUEUED', title: 'Blocked by issue-18' }),
    item({
      itemId: 'issue-18', itemNumber: 18, drainState: 'QUEUED', title: 'Blocked by issue-17',
    }),
  ]);
  const shared = {
    drainProjection,
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:30:20.000Z',
  };

  const declared = buildControlRoomSnapshot({
    ...shared,
    dependencies: {
      evidenceRevision: 'b'.repeat(64),
      edges: [
        { itemId: 'issue-17', dependsOnItemId: 'issue-18' },
        { itemId: 'issue-18', dependsOnItemId: 'issue-17' },
      ],
    },
  });
  const proseOnly = buildControlRoomSnapshot(shared);

  assert.equal(declared.obstruction.state, 'DEPENDENCY_DEADLOCK');
  assert.equal(declared.obstruction.dependencyEvidenceRevision, 'b'.repeat(64));
  assert.equal(proseOnly.obstruction.state, 'THROUGHPUT_STALL');
});

test('the default English view states the obstruction, its evidence age and one bounded recovery', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([
      item({ drainState: 'BLOCKED_EVIDENCE', sourceState: 'CHECKS_UNKNOWN' }),
    ]),
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:30:20.000Z',
  });
  const html = renderControlRoomHtml(snapshot);

  assert.match(html, /Why the drain is not moving/u);
  assert.match(html, /EVIDENCE_STARVATION/u);
  assert.match(html, /Bounded recovery/u);
  assert.match(html, /COLLECT_MISSING_EVIDENCE/u);
  assert.match(html, /Collect the missing check or review evidence/u);
  assert.match(html, /Evidence age/u);
  assert.match(html, /10m/u);
  assert.equal(snapshot.showSpinner, false);
  assert.doesNotMatch(html, /class="heartbeat-pulse"/u);
  assert.doesNotMatch(html, /@keyframes/u);
});

test('the optional French view translates the obstruction and its bounded recovery', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([
      item({ drainState: 'BLOCKED_EVIDENCE', sourceState: 'CHECKS_UNKNOWN' }),
    ]),
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:30:20.000Z',
  });
  const html = renderControlRoomHtml(snapshot, { language: 'fr' });

  assert.match(html, /Pourquoi le drain n/u);
  assert.match(html, /Preuves manquantes/u);
  assert.match(html, /Reprise born/u);
  assert.match(html, /Collecter les preuves manquantes/u);
  assert.doesNotMatch(html, /Collect the missing check/u);
});

test('an obstruction edited after the snapshot was built is refused, not displayed', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([
      item({ drainState: 'BLOCKED_EVIDENCE', sourceState: 'CHECKS_UNKNOWN' }),
    ]),
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:30:20.000Z',
  });
  const withoutRevision = ({ revision, ...body }) => body;
  const reseal = (body) => ({
    ...body, revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  });

  const digestBroken = reseal({
    ...withoutRevision(snapshot),
    obstruction: { ...snapshot.obstruction, state: 'NONE' },
  });
  const semanticsBroken = reseal({
    ...withoutRevision(snapshot),
    obstruction: reseal({ ...withoutRevision(snapshot.obstruction), recovery: null }),
  });

  assert.throws(() => renderControlRoomHtml(digestBroken), /obstruction/u);
  assert.throws(() => renderControlRoomHtml(semanticsBroken), /obstruction/u);
});

/**
 * R1 blocker 3 — evidence dated after the instant it was observed is a broken sensor.
 *
 * R0 clamped the window to zero here and published a snapshot whose rendered "Evidence age" read
 * `0s` — the single most reassuring reading available — for a sensor whose true state is
 * incoherent, with nothing in the emitted obstruction marking that a clamp had occurred. The pure
 * module already refuses an inverted window; the adapter now refuses one too, in its own typed
 * vocabulary, and both command-line adapters build before they write so the last complete
 * artifact set survives the refusal.
 */
test('evidence newer than the observation is a typed refusal, never an invented zero age', () => {
  const future = () => buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'QUEUED' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:50:20.000Z',
  });
  const oneMillisecondAhead = () => buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'QUEUED' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:40:20.001Z',
  });

  assert.throws(future, (error) => {
    assert.equal(error.name, 'ControlRoomError');
    assert.equal(error.code, 'IncoherentEvidence');
    assert.match(error.message, /after the instant it was observed/u);
    return true;
  });
  assert.throws(oneMillisecondAhead, { code: 'IncoherentEvidence' });
  // The boundary itself is coherent: evidence observed at the instant it changed is a real,
  // zero-length window, and it is measured rather than synthesized.
  const boundary = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'QUEUED' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:40:20.000Z',
  });
  assert.equal(boundary.obstruction.observationWindow.durationMs, 0);
  assert.equal(boundary.obstruction.state, 'NONE');
});

/**
 * R1 blocker 1, reached through the production Adapter rather than a hand-forged liveness array.
 *
 * `itemActivity` decides ACTIVE from telemetry run state and heartbeat freshness alone, so the
 * ordinary race "GitHub reports the pull request merged before the worker emits run.completed"
 * puts a live, fresh-heartbeat run on a TERMINAL_MERGED item. That is not a live lane.
 */
test('NEGATIVE CONTROL: an open telemetry run on a terminal item never reports the drain healthy', () => {
  const drainProjection = projection([
    item({ itemId: 'issue-1', itemNumber: 1, drainState: 'BLOCKED_EVIDENCE' }),
    item({ itemId: 'issue-2', itemNumber: 2, drainState: 'BLOCKED_EVIDENCE' }),
    item({ drainState: 'TERMINAL_MERGED' }),
  ]);
  const shared = {
    drainProjection,
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:30:20.000Z',
  };

  const withoutRun = buildControlRoomSnapshot(shared);
  const withOpenRun = buildControlRoomSnapshot({
    ...shared, telemetryProjection: telemetry(OPEN_RUN),
  });

  assert.equal(withoutRun.obstruction.state, 'EVIDENCE_STARVATION');
  assert.equal(
    withOpenRun.items.find(({ itemId }) => itemId === 'issue-17').activity.state, 'ACTIVE',
    'the item really is ACTIVE — the repair is in what liveness is allowed to decide',
  );
  assert.equal(
    withOpenRun.obstruction.state, 'EVIDENCE_STARVATION',
    'a terminal item carrying an open run is not a lane the drain is draining through',
  );
  assert.deepEqual(withOpenRun.obstruction.affectedItemIds, ['issue-1', 'issue-2']);
  assert.equal(withOpenRun.obstruction.recovery.kind, 'COLLECT_MISSING_EVIDENCE');
  assert.equal(withOpenRun.blockedCount, 2);
  assert.match(
    renderControlRoomHtml(withOpenRun), /Missing evidence/u,
  );
  assert.doesNotMatch(
    renderControlRoomHtml(withOpenRun), /No obstruction detected/u,
    'the rendered page must not print "no obstruction" beside two blocked items',
  );
});

/**
 * R1 blocker 2 — the displayed obstruction must be bound to the snapshot it is displayed with.
 *
 * Checking the obstruction against itself is not enough: a self-consistent obstruction classified
 * from a different projection over a different window can be inserted into a resealed snapshot and
 * rendered beside a `sourceRevision` that contradicts every word of it. The render seam cannot
 * re-derive the obstruction — that needs the drain projection the snapshot deliberately does not
 * carry — but it holds both bound fields already and must check them.
 */
test('an obstruction from another projection or window is refused at the render seam', () => {
  const honest = buildControlRoomSnapshot({
    drainProjection: projection([
      item({ itemId: 'issue-1', itemNumber: 1, drainState: 'BLOCKED_EVIDENCE' }),
      item({ itemId: 'issue-2', itemNumber: 2, drainState: 'BLOCKED_EVIDENCE' }),
    ]),
    observedAt: '2026-08-29T18:40:20.000Z',
    sourceChangedAt: '2026-08-29T18:30:20.000Z',
  });
  const foreign = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'TERMINAL_MERGED' })]),
    observedAt: '2020-01-01T00:00:01.000Z',
    sourceChangedAt: '2020-01-01T00:00:00.000Z',
  });
  const withoutRevision = ({ revision, ...body }) => body;
  const reseal = (body) => ({
    ...body, revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  });

  // Both halves are individually honest: the foreign obstruction verifies against its own
  // content, and the graft is resealed so the snapshot verifies against its own content too.
  const grafted = reseal({ ...withoutRevision(honest), obstruction: foreign.obstruction });
  const windowGrafted = reseal({
    ...withoutRevision(honest),
    obstruction: reseal({
      ...withoutRevision(honest.obstruction),
      observationWindow: {
        startedAt: '2026-08-29T18:30:20.000Z',
        endedAt: '2026-08-29T18:39:20.000Z',
        durationMs: 540_000,
      },
    }),
  });

  assert.notEqual(foreign.obstruction.evidenceRevision, honest.sourceRevision);
  assert.equal(
    grafted.obstruction.revision,
    createHash('sha256').update(canonicalJson(withoutRevision(grafted.obstruction))).digest('hex'),
    'the graft is self-consistent, so only a binding check can catch it',
  );
  assert.throws(
    () => renderControlRoomHtml(grafted),
    /obstruction/u,
    'an obstruction naming a different evidence revision must not be displayed',
  );
  assert.throws(
    () => renderControlRoomHtml(windowGrafted),
    /obstruction/u,
    'an obstruction whose window ends at a different instant must not be displayed',
  );
  assert.equal(honest.obstruction.evidenceRevision, honest.sourceRevision);
  assert.equal(honest.obstruction.observationWindow.endedAt, honest.observedAt);
  assert.match(renderControlRoomHtml(honest), /Missing evidence/u);
});
