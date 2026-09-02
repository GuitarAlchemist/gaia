/**
 * R0 contract for pull-request delivery metrics (issue #89).
 *
 * These tests exercise only public seams: normalization of GitHub-shaped observations into
 * revision-bound facts, the pure projection of named intervals and counts, the managed Markdown
 * summary, the no-effect publication intent, and the disposable analytical projection that must
 * reproduce the same canonical rows. Every input is a deterministic fixture. Nothing here reads
 * or mutates a live pull request.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUS_VERBS } from '../src/bus-core.mjs';
import {
  PR_DELIVERY_COUNTS,
  PR_DELIVERY_EVENT_KINDS,
  PR_DELIVERY_INTERVALS,
  PR_DELIVERY_SUMMARY_BEGIN,
  PR_DELIVERY_SUMMARY_END,
  PrDeliveryMetricsError,
  applyManagedPrDeliverySummary,
  ingestPrDeliveryObservations,
  preparePrDeliverySummaryPublication,
  projectPrDeliveryMetrics,
  renderPrDeliverySummary,
  sealPrDeliveryTerminalReceipt,
} from '../src/pr-delivery-metrics.mjs';
import {
  PR_DELIVERY_DUCKDB_STATEMENTS,
  PrDeliveryDuckDbError,
  projectPrDeliveryMetricsThroughDuckDb,
} from '../src/duckdb-pr-delivery-metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(
  join(here, 'fixtures', 'pr-delivery-metrics', 'pull-request-lifecycle.json'), 'utf8',
));
const REPOSITORY = FIXTURE.repository;
const PULL_REQUEST = FIXTURE.pullRequestNumber;
const HEAD_R0 = FIXTURE.heads.round0;
const HEAD_R1 = FIXTURE.heads.round1;
const OBSERVED_AT = FIXTURE.observedAt;
const MINUTE = 60_000;

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};

const observations = (mutate = (list) => list) => mutate(
  FIXTURE.observations.map((observation) => ({ ...observation })),
);

const ingest = (list = observations(), overrides = {}) => ingestPrDeliveryObservations({
  repository: REPOSITORY,
  pullRequestNumber: PULL_REQUEST,
  observations: list,
  observedAt: OBSERVED_AT,
  ...overrides,
});

const project = (list = observations(), overrides = {}) => projectPrDeliveryMetrics({
  ingestion: ingest(list),
  currentHeadOid: HEAD_R1,
  terminalReceipt: null,
  ...overrides,
});

const row = (projection, metric) => {
  const found = projection.rows.filter((candidate) => candidate.metric === metric);
  assert.equal(found.length, 1, `exactly one row for ${metric}`);
  return found[0];
};

const mergeReceipt = (overrides = {}) => sealPrDeliveryTerminalReceipt({
  repository: REPOSITORY,
  pullRequestNumber: PULL_REQUEST,
  headOid: HEAD_R1,
  deliveredAt: '2026-08-30T10:40:00.000Z',
  authority: 'GITHUB_MERGE_RECEIPT',
  ...overrides,
});

const refusal = (code, run) => {
  assert.throws(run, (error) => {
    assert.ok(error instanceof PrDeliveryMetricsError, `expected a typed refusal, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
};

test('the fixture lifecycle yields the exact expected stage intervals and counts', () => {
  const projection = project();

  assert.equal(row(projection, 'DRAFT_AGE').valueMilliseconds, 20 * MINUTE);
  assert.equal(row(projection, 'TIME_TO_FIRST_REVIEW').valueMilliseconds, 15 * MINUTE);
  assert.equal(row(projection, 'CI_QUEUE_CURRENT_HEAD').valueMilliseconds, 4 * MINUTE);
  assert.equal(row(projection, 'CI_EXECUTION_CURRENT_HEAD').valueMilliseconds, 15 * MINUTE);
  assert.equal(row(projection, 'TIME_TO_GREEN_CURRENT_HEAD').valueMilliseconds, 21 * MINUTE);
  assert.equal(row(projection, 'CONFLICT_REPAIR').valueMilliseconds, 20 * MINUTE);
  assert.equal(row(projection, 'TOTAL_LEAD_TIME').valueMilliseconds, 100 * MINUTE);

  assert.equal(row(projection, 'DELIVERY_ROUNDS').count, 2);
  assert.equal(row(projection, 'HEAD_CHANGES').count, 1);
  assert.equal(row(projection, 'REVIEW_CYCLES').count, 2);
  assert.equal(row(projection, 'CHECK_RUNS_CURRENT_HEAD').count, 1);
  assert.equal(row(projection, 'CONFLICT_EPISODES').count, 1);

  assert.deepEqual(
    projection.rows.filter(({ kind }) => kind === 'INTERVAL').map(({ metric }) => metric),
    [...PR_DELIVERY_INTERVALS].sort(),
  );
  assert.deepEqual(
    projection.rows.filter(({ kind }) => kind === 'COUNT').map(({ metric }) => metric),
    [...PR_DELIVERY_COUNTS].sort(),
  );
  assert.ok(projection.rows.every(({ unknownReason }) => unknownReason === null));
  assert.equal(projection.currentHeadOid, HEAD_R1);
  assert.equal(projection.repository, REPOSITORY);
  assert.equal(projection.pullRequestNumber, PULL_REQUEST);
});

test('every fixture observation is a member of the closed event vocabulary', () => {
  for (const observation of FIXTURE.observations) {
    assert.ok(PR_DELIVERY_EVENT_KINDS.includes(observation.kind), observation.kind);
  }
});

test('duplicate and reordered observations replay to one deterministic projection', () => {
  const straight = project();
  const shuffled = observations((list) => {
    const reordered = [...list].reverse();
    // The same provider events, observed a second time through the other channel.
    const echoes = [list[0], list[8], list[12]].map((observation) => ({
      ...observation, source: 'GITHUB_POLL',
    }));
    return [...reordered.slice(0, 4), ...echoes, ...reordered.slice(4), echoes[0]];
  });
  const replayed = project(shuffled);

  assert.equal(replayed.factsRevision, straight.factsRevision);
  assert.equal(replayed.projectionRevision, straight.projectionRevision);
  assert.equal(canonicalJson(replayed.rows), canonicalJson(straight.rows));
  assert.equal(
    ingest(shuffled).facts.length, ingest().facts.length,
    'a coalesced observation adds no row',
  );
  assert.equal(ingest(shuffled).coalescedObservations, 4);
  const merged = ingest(shuffled).facts
    .find(({ providerEventId }) => providerEventId === 'PR_ev_opened');
  assert.equal(merged.sources, 'GITHUB_FIXTURE,GITHUB_POLL', 'both observing channels are kept');
});

test('two observations that claim one identity with different content are refused', () => {
  refusal('ObservationConflict', () => ingest(observations((list) => [
    ...list, { ...list[0], occurredAt: '2026-08-30T08:59:00.000Z' },
  ])));
});

test('corrupt, future, and foreign observations are refused rather than repaired', () => {
  refusal('ObservationInvalid', () => ingest(observations((list) => [
    ...list.slice(1), { ...list[0], occurredAt: '2026-08-30 09:00:00' },
  ])));
  refusal('FutureEvidence', () => ingest(observations((list) => [
    ...list,
    { ...list[0], providerEventId: 'PR_ev_future', occurredAt: '2026-08-30T11:30:00.000Z' },
  ])));
  refusal('SubjectMismatch', () => ingest(observations((list) => [
    ...list, { ...list[0], providerEventId: 'PR_ev_other', pullRequestNumber: 78 },
  ])));
  refusal('ObservationInvalid', () => ingest(observations((list) => [
    ...list, { ...list[0], providerEventId: 'PR_ev_extra', unexpectedField: 'x' },
  ])));
});

test('a current head never borrows a superseded head green check', () => {
  const withoutSecondRound = project(observations(
    (list) => list.filter(({ providerEventId }) => !providerEventId.startsWith('CHK_r1_')),
  ));

  assert.equal(row(withoutSecondRound, 'TIME_TO_GREEN_CURRENT_HEAD').valueMilliseconds, null);
  assert.equal(
    row(withoutSecondRound, 'TIME_TO_GREEN_CURRENT_HEAD').unknownReason,
    'NO_GREEN_CHECK_ON_CURRENT_HEAD',
  );
  assert.equal(
    row(withoutSecondRound, 'CI_QUEUE_CURRENT_HEAD').unknownReason,
    'NO_CHECK_QUEUED_ON_CURRENT_HEAD',
  );
  assert.equal(row(withoutSecondRound, 'CHECK_RUNS_CURRENT_HEAD').count, 0);

  // The superseded generation keeps its own history and stays separate.
  const generations = withoutSecondRound.generations;
  assert.deepEqual(generations.map(({ headOid }) => headOid), [HEAD_R0, HEAD_R1]);
  assert.equal(generations[0].supersededAt, '2026-08-30T10:00:00.000Z');
  assert.equal(generations[1].supersededAt, null);
  assert.equal(generations[0].greenCheckAt, '2026-08-30T09:12:00.000Z');
  assert.equal(generations[1].greenCheckAt, null);
});

test('missing evidence is UNKNOWN with a reason and never zero', () => {
  const draftOnly = projectPrDeliveryMetrics({
    ingestion: ingest(observations((list) => list.filter(
      ({ kind }) => kind === 'DRAFT_OPENED',
    ))),
    currentHeadOid: HEAD_R0,
    terminalReceipt: null,
  });

  for (const metric of ['DRAFT_AGE', 'TIME_TO_FIRST_REVIEW', 'CONFLICT_REPAIR', 'TOTAL_LEAD_TIME']) {
    assert.equal(row(draftOnly, metric).valueMilliseconds, null, metric);
    assert.ok(row(draftOnly, metric).unknownReason !== null, metric);
  }
  assert.equal(row(draftOnly, 'DRAFT_AGE').unknownReason, 'NO_READY_FOR_REVIEW');
  assert.equal(row(draftOnly, 'CONFLICT_REPAIR').unknownReason, 'NO_CONFLICT_OBSERVED');
  assert.equal(row(draftOnly, 'TOTAL_LEAD_TIME').unknownReason, 'NOT_TERMINAL');
  assert.ok(
    draftOnly.rows.every(
      ({ kind, valueMilliseconds }) => kind !== 'INTERVAL' || valueMilliseconds !== 0,
    ),
    'an absent interval is never published as zero',
  );
  assert.equal(row(draftOnly, 'DELIVERY_ROUNDS').count, 1, 'a witnessed count of one is a count');
  assert.equal(draftOnly.forecast.initial.known, false);
  assert.equal(draftOnly.forecast.initial.reason, 'NO_FORECAST_RECORDED');
});

test('the initial forecast is immutable under any arrival order', () => {
  const straight = project();
  const reversed = project(observations((list) => [...list].reverse()));

  for (const projection of [straight, reversed]) {
    assert.equal(projection.forecast.initial.known, true);
    assert.equal(projection.forecast.initial.minimumMinutes, 60);
    assert.equal(projection.forecast.initial.maximumMinutes, 180);
    assert.equal(projection.forecast.initial.recordedAt, '2026-08-30T09:00:00.000Z');
    assert.equal(projection.forecast.current.minimumMinutes, 30);
    assert.equal(projection.forecast.current.maximumMinutes, 60);
  }
});

test('deliveredAt comes only from an authorized terminal receipt', () => {
  const withoutReceipt = project();
  assert.equal(withoutReceipt.forecast.deliveredAt.known, false);
  assert.equal(withoutReceipt.forecast.deliveredAt.reason, 'NO_AUTHORIZED_TERMINAL_RECEIPT');
  assert.equal(withoutReceipt.forecast.intervalOutcome.known, false);
  assert.equal(withoutReceipt.forecast.absoluteErrorMilliseconds.known, false);

  const delivered = project(observations(), { terminalReceipt: mergeReceipt() });
  assert.equal(delivered.forecast.deliveredAt.known, true);
  assert.equal(delivered.forecast.deliveredAt.instant, '2026-08-30T10:40:00.000Z');
  assert.equal(delivered.forecast.deliveredAt.authority, 'GITHUB_MERGE_RECEIPT');
  assert.equal(delivered.forecast.intervalOutcome.value, 'HIT');
  assert.equal(delivered.forecast.absoluteErrorMilliseconds.value, 20 * MINUTE);

  refusal('TerminalReceiptUnbound', () => project(observations(), {
    terminalReceipt: mergeReceipt({ headOid: HEAD_R0 }),
  }));
  refusal('TerminalReceiptUnbound', () => project(observations(), {
    terminalReceipt: mergeReceipt({ pullRequestNumber: 78 }),
  }));
  refusal('TerminalReceiptUnauthorized', () => project(observations(), {
    terminalReceipt: sealPrDeliveryTerminalReceipt({
      repository: REPOSITORY,
      pullRequestNumber: PULL_REQUEST,
      headOid: HEAD_R1,
      deliveredAt: '2026-08-30T10:40:00.000Z',
      authority: 'AGENT_SELF_REPORT',
    }),
  }));
  refusal('TerminalReceiptInvalid', () => project(observations(), {
    terminalReceipt: { ...mergeReceipt(), deliveredAt: '2026-08-30T09:00:00.000Z' },
  }));
  refusal('TerminalReceiptUnwitnessed', () => projectPrDeliveryMetrics({
    ingestion: ingest(observations((list) => list.filter(({ kind }) => kind !== 'MERGED'))),
    currentHeadOid: HEAD_R1,
    terminalReceipt: mergeReceipt(),
  }));
});

test('token and provider cost stay unknown without an attributed receipt', () => {
  const projection = project();
  assert.equal(projection.cost.tokens.known, false);
  assert.equal(projection.cost.tokens.reason, 'NO_ATTRIBUTED_RECEIPT');
  assert.equal(projection.cost.providerCost.reason, 'NO_ATTRIBUTED_RECEIPT');
});

test('the managed summary is concise, provenance-bound, and carries no composite score', () => {
  const projection = project(observations(), { terminalReceipt: mergeReceipt() });
  const summary = renderPrDeliverySummary(projection);

  assert.ok(summary.split('\n').length <= 32, 'the PR body is a summary, not an event log');
  assert.ok(summary.includes(projection.factsRevision));
  assert.ok(summary.includes(projection.projectionRevision));
  assert.ok(summary.includes(HEAD_R1.slice(0, 12)));
  assert.ok(summary.includes(`${REPOSITORY}#${PULL_REQUEST}`));
  assert.ok(!/\bscore\b/iu.test(summary), 'no opaque score');
  for (const metric of [...PR_DELIVERY_INTERVALS, ...PR_DELIVERY_COUNTS]) {
    assert.ok(summary.includes(metric), `${metric} is published by name`);
  }
  const unknownSummary = renderPrDeliverySummary(project());
  assert.ok(unknownSummary.includes('UNKNOWN(NO_AUTHORIZED_TERMINAL_RECEIPT)'));
  assert.ok(unknownSummary.includes('UNKNOWN(NO_ATTRIBUTED_RECEIPT)'));
});

test('the managed region preserves human text and stays idempotent', () => {
  const human = [
    '# Why this change', '', 'Human paragraph with a [link](https://example.invalid).', '',
  ].join('\n');
  const summary = renderPrDeliverySummary(project());
  const first = applyManagedPrDeliverySummary({ body: human, summary });

  assert.ok(first.body.startsWith(human), 'human text is preserved byte-for-byte');
  assert.equal(first.body.split(PR_DELIVERY_SUMMARY_BEGIN).length - 1, 1);
  assert.equal(first.body.split(PR_DELIVERY_SUMMARY_END).length - 1, 1);
  assert.equal(first.changed, true);

  const second = applyManagedPrDeliverySummary({ body: first.body, summary });
  assert.equal(second.body, first.body);
  assert.equal(second.changed, false);

  const edited = `${first.body}\n\nA later human note.\n`;
  const third = applyManagedPrDeliverySummary({
    body: edited,
    summary: renderPrDeliverySummary(project(observations(), { terminalReceipt: mergeReceipt() })),
  });
  assert.ok(third.body.startsWith(human), 'text before the region survives a refresh');
  assert.ok(third.body.endsWith('A later human note.\n'), 'text after it survives a refresh');
  assert.equal(third.body.split(PR_DELIVERY_SUMMARY_BEGIN).length - 1, 1);

  refusal('ManagedSectionAmbiguous', () => applyManagedPrDeliverySummary({
    body: `${first.body}\n${first.body}`, summary,
  }));
  refusal('ManagedSectionAmbiguous', () => applyManagedPrDeliverySummary({
    body: `${human}\n${PR_DELIVERY_SUMMARY_BEGIN}\nno end marker\n`, summary,
  }));
});

test('publication is a no-effect intent under compare-and-set', () => {
  const projection = project(observations(), { terminalReceipt: mergeReceipt() });
  const body = '# Why this change\n';
  const bodyRevision = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const intent = preparePrDeliverySummaryPublication({
    projection, currentHeadOid: HEAD_R1, observedBody: body, expectedBodyRevision: bodyRevision,
  });

  assert.equal(intent.effect, 'NONE');
  assert.equal(intent.authority, 'NONE');
  assert.equal(intent.repository, REPOSITORY);
  assert.equal(intent.pullRequestNumber, PULL_REQUEST);
  assert.equal(intent.headOid, HEAD_R1);
  assert.equal(intent.expectedBodyRevision, bodyRevision);
  assert.ok(intent.body.includes(PR_DELIVERY_SUMMARY_BEGIN));
  assert.ok(intent.body.startsWith(body));

  refusal('StaleManagedSummary', () => preparePrDeliverySummaryPublication({
    projection,
    currentHeadOid: HEAD_R1,
    observedBody: body,
    expectedBodyRevision: `sha256:${'0'.repeat(64)}`,
  }));
  refusal('StaleProjectionHead', () => preparePrDeliverySummaryPublication({
    projection, currentHeadOid: HEAD_R0, observedBody: body, expectedBodyRevision: bodyRevision,
  }));
});

test('the analytical projection reproduces the canonical rows and can be thrown away', async (t) => {
  const pure = project();
  const directory = mkdtempSync(join(tmpdir(), 'gaia-pr-delivery-'));
  const databasePath = join(directory, 'delivery.duckdb');
  try {
    let built;
    try {
      built = await projectPrDeliveryMetricsThroughDuckDb({
        ingestion: ingest(), currentHeadOid: HEAD_R1, databasePath,
      });
    } catch (error) {
      assert.ok(error instanceof PrDeliveryDuckDbError);
      assert.equal(error.code, 'DuckDbClientAbsent', 'an absent store is named, never a zero row');
      t.diagnostic('optional analytical client absent: SQL equivalence not measured here');
      return;
    }
    assert.equal(canonicalJson(built.rows), canonicalJson(pure.rows), 'SQL and pure rows agree');
    assert.equal(built.factsRevision, pure.factsRevision);
    assert.equal(built.effect, 'ANALYTICAL_PROJECTION_REBUILT');
    assert.equal(built.authority, 'NONE');

    rmSync(databasePath, { force: true });
    assert.equal(existsSync(databasePath), false);
    const rebuilt = await projectPrDeliveryMetricsThroughDuckDb({
      ingestion: ingest(observations((list) => [...list].reverse())),
      currentHeadOid: HEAD_R1,
      databasePath,
    });
    assert.equal(canonicalJson(rebuilt.rows), canonicalJson(built.rows), 'rebuild is equivalent');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the analytical store holds no authority-bound column', () => {
  const statements = Object.values(PR_DELIVERY_DUCKDB_STATEMENTS).join('\n');
  for (const forbidden of ['delivered_at', 'forecast_minimum', 'forecast_maximum', 'interval_outcome']) {
    assert.ok(!statements.includes(forbidden), `${forbidden} must never reach the store`);
  }
  assert.ok(!/\b(UPDATE|MERGE|ATTACH|COPY|INSTALL|LOAD)\b/u.test(statements));
});

test('the closed statement set is executed against an injected client', async () => {
  const calls = [];
  const client = {
    async run(sql, params = []) { calls.push({ sql, params }); },
    async rows() { return []; },
    close() {},
  };
  await assert.rejects(
    projectPrDeliveryMetricsThroughDuckDb({
      ingestion: ingest(),
      currentHeadOid: HEAD_R1,
      databasePath: join(tmpdir(), 'gaia-pr-delivery-unused.duckdb'),
      openClient: async () => client,
    }),
    (error) => error instanceof PrDeliveryDuckDbError && error.code === 'ProjectionRowsMissing',
  );
  assert.equal(calls[0].sql, PR_DELIVERY_DUCKDB_STATEMENTS.createFacts);
  assert.equal(
    calls.filter(({ sql }) => sql === PR_DELIVERY_DUCKDB_STATEMENTS.insertFact).length,
    ingest().facts.length,
  );
  assert.ok(calls.some(({ sql }) => sql === PR_DELIVERY_DUCKDB_STATEMENTS.begin));
  assert.ok(calls.some(({ sql }) => sql === PR_DELIVERY_DUCKDB_STATEMENTS.commit));
});

test('the metrics modules add no verb, no effect, and no provider call site', () => {
  assert.deepEqual([...BUS_VERBS], ['register', 'send', 'inbox', 'ack', 'heartbeat', 'handoff']);
  const pure = readFileSync(join(here, '..', 'src', 'pr-delivery-metrics.mjs'), 'utf8');
  const adapter = readFileSync(join(here, '..', 'src', 'duckdb-pr-delivery-metrics.mjs'), 'utf8');

  assert.ok(!/duckdb/iu.test(pure), 'the authority never speaks to the analytical store');
  for (const source of [pure, adapter]) {
    assert.ok(!/node:(?:child_process|net|http|https|dgram|tls)/u.test(source));
    assert.ok(!/\bfetch\s*\(/u.test(source), 'no network call');
    assert.ok(!/\bexecFileSync\b|\bspawnSync\b|\bexecSync\b/u.test(source), 'no command call');
    assert.ok(!/\bDate\.now\b/u.test(source), 'the observer supplies the instant');
    assert.ok(!/\bgh\s+(?:pr|api|issue)\b/u.test(source), 'no provider command');
  }
});
