import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
    detail: 'No tracked factory run is moving right now.',
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

  assert.match(html, /Aucune exécution suivie de la factory ne progresse actuellement/u);
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
