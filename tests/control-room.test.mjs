import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildControlRoomSnapshot, renderControlRoomHtml } from '../src/control-room.mjs';

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
  return {
    schema: 'gaia-portfolio-drain-projection/1',
    portfolioRevision: SHA,
    effect: 'NONE',
    authority: 'NONE',
    capacity: 4,
    counts: { occupied: 0, available: 4 },
    items,
    decisions,
    revision: 'b'.repeat(64),
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
    detail: 'No Gaia work is moving right now.',
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
