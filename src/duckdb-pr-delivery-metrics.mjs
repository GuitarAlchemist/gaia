/**
 * duckdb-pr-delivery-metrics.mjs — the disposable analytical projection of delivery facts.
 *
 * WHAT THIS IS FOR
 * ----------------
 * `pr-delivery-metrics.mjs` computes the authoritative result rows in process. This Adapter loads
 * the same facts into the optional `@duckdb/node-api` port already used by Gaia's review-thread
 * telemetry and recomputes the named intervals and counts in SQL, so an operator can query the
 * detail and a test can cross-check one engine against the other. Deleting the store and rebuilding
 * it from the same facts must reproduce byte-equivalent canonical rows.
 *
 * WHAT NEVER REACHES THE STORE
 * ----------------------------
 * Authority-bound quantities have no column here: not the initial forecast, not the current
 * forecast, not the delivery instant, not the forecast verdict. A query cannot invent a delivery it
 * has no evidence for, and the store cannot become a second writer of an authority-bound fact.
 * Nothing here schedules, merges, approves, retries, or transitions anything.
 *
 * WHAT AN ABSENT STORE MEANS
 * --------------------------
 * The client is an optional dependency. Its absence is a named refusal — never an empty result,
 * and never a zero. The pump that owns the facts does not call this module at all, so an
 * unavailable analytical store cannot stop delivery.
 */

import { resolve } from 'node:path';

import { PR_DELIVERY_COUNTS, PR_DELIVERY_INTERVALS } from './pr-delivery-metrics.mjs';

export const PR_DELIVERY_DUCKDB_CLIENT = '@duckdb/node-api';
export const PR_DELIVERY_DUCKDB_SCHEMA = 'gaia-pr-delivery-metrics-projection/1';

const METRIC_SELECTS = [
  {
    metric: 'DRAFT_AGE',
    kind: 'INTERVAL',
    headBinding: 'PULL_REQUEST',
    value: 'CASE WHEN draft_opened IS NOT NULL AND ready IS NOT NULL THEN ready - draft_opened END',
    reason: "CASE WHEN draft_opened IS NULL THEN 'NO_DRAFT_OPENED'"
      + " WHEN ready IS NULL THEN 'NO_READY_FOR_REVIEW' END",
  },
  {
    metric: 'TIME_TO_FIRST_REVIEW',
    kind: 'INTERVAL',
    headBinding: 'PULL_REQUEST',
    value: 'CASE WHEN ready IS NOT NULL AND first_review IS NOT NULL THEN first_review - ready END',
    reason: "CASE WHEN ready IS NULL THEN 'NO_READY_FOR_REVIEW'"
      + " WHEN first_review IS NULL THEN 'NO_REVIEW_SUBMITTED' END",
  },
  {
    metric: 'CI_QUEUE_CURRENT_HEAD',
    kind: 'INTERVAL',
    headBinding: 'CURRENT_HEAD',
    value: 'CASE WHEN head_queued IS NOT NULL AND head_started IS NOT NULL'
      + ' THEN head_started - head_queued END',
    reason: "CASE WHEN head_queued IS NULL THEN 'NO_CHECK_QUEUED_ON_CURRENT_HEAD'"
      + " WHEN head_started IS NULL THEN 'NO_CHECK_STARTED_ON_CURRENT_HEAD' END",
  },
  {
    metric: 'CI_EXECUTION_CURRENT_HEAD',
    kind: 'INTERVAL',
    headBinding: 'CURRENT_HEAD',
    value: 'CASE WHEN head_started IS NOT NULL AND head_completed IS NOT NULL'
      + ' THEN head_completed - head_started END',
    reason: "CASE WHEN head_started IS NULL THEN 'NO_CHECK_STARTED_ON_CURRENT_HEAD'"
      + " WHEN head_completed IS NULL THEN 'NO_CHECK_COMPLETED_ON_CURRENT_HEAD' END",
  },
  {
    metric: 'TIME_TO_GREEN_CURRENT_HEAD',
    kind: 'INTERVAL',
    headBinding: 'CURRENT_HEAD',
    value: 'CASE WHEN head_opened IS NOT NULL AND head_green IS NOT NULL'
      + ' THEN head_green - head_opened END',
    reason: "CASE WHEN head_opened IS NULL THEN 'NO_CURRENT_GENERATION'"
      + " WHEN head_green IS NULL THEN 'NO_GREEN_CHECK_ON_CURRENT_HEAD' END",
  },
  {
    metric: 'CONFLICT_REPAIR',
    kind: 'INTERVAL',
    headBinding: 'PULL_REQUEST',
    value: 'CASE WHEN conflict_observed IS NOT NULL AND conflict_resolved IS NOT NULL'
      + ' THEN conflict_resolved - conflict_observed END',
    reason: "CASE WHEN conflict_observed IS NULL THEN 'NO_CONFLICT_OBSERVED'"
      + " WHEN conflict_resolved IS NULL THEN 'NO_CONFLICT_RESOLVED' END",
  },
  {
    metric: 'TOTAL_LEAD_TIME',
    kind: 'INTERVAL',
    headBinding: 'PULL_REQUEST',
    value: 'CASE WHEN draft_opened IS NOT NULL AND merged IS NOT NULL THEN merged - draft_opened END',
    reason: "CASE WHEN draft_opened IS NULL THEN 'NO_DRAFT_OPENED'"
      + " WHEN merged IS NULL THEN 'NOT_TERMINAL' END",
  },
  {
    metric: 'DELIVERY_ROUNDS', kind: 'COUNT', headBinding: 'PULL_REQUEST', count: 'rounds',
  },
  {
    metric: 'HEAD_CHANGES', kind: 'COUNT', headBinding: 'PULL_REQUEST', count: 'rounds - 1',
  },
  {
    metric: 'REVIEW_CYCLES', kind: 'COUNT', headBinding: 'PULL_REQUEST', count: 'reviews',
  },
  {
    metric: 'CHECK_RUNS_CURRENT_HEAD', kind: 'COUNT', headBinding: 'CURRENT_HEAD', count: 'head_checks',
  },
  {
    metric: 'CONFLICT_EPISODES', kind: 'COUNT', headBinding: 'PULL_REQUEST', count: 'conflicts',
  },
];

const metricSelect = ({ metric, kind, headBinding, value, count, reason }) => 'SELECT '
  + `'${metric}' AS metric, '${kind}' AS metric_kind, '${headBinding}' AS head_binding, `
  + `${kind === 'INTERVAL' ? `CAST(${value} AS BIGINT)` : 'CAST(NULL AS BIGINT)'} AS value_ms, `
  + `${kind === 'COUNT' ? `CAST(${count} AS BIGINT)` : 'CAST(NULL AS BIGINT)'} AS metric_count, `
  + `${kind === 'INTERVAL' ? `CAST(${reason} AS VARCHAR)` : 'CAST(NULL AS VARCHAR)'} AS unknown_reason `
  + 'FROM bounds';

/**
 * The closed statement set. Every metric is named in SQL, so the query is reviewable as a
 * definition of the published vocabulary rather than as an opaque computation.
 */
export const PR_DELIVERY_DUCKDB_STATEMENTS = Object.freeze({
  createFacts: 'CREATE TABLE IF NOT EXISTS gaia_pr_delivery_fact ('
    + ' event_identity VARCHAR NOT NULL, repository VARCHAR NOT NULL,'
    + ' pull_request_number INTEGER NOT NULL, kind VARCHAR NOT NULL, head_oid VARCHAR NOT NULL,'
    + ' occurred_at VARCHAR NOT NULL, provider_event_id VARCHAR NOT NULL, subject VARCHAR NOT NULL,'
    + ' outcome VARCHAR NOT NULL, sources VARCHAR NOT NULL, evidence_revision VARCHAR NOT NULL)',
  createScope: 'CREATE TABLE IF NOT EXISTS gaia_pr_delivery_scope ('
    + ' projection_schema VARCHAR NOT NULL, facts_revision VARCHAR NOT NULL,'
    + ' current_head_oid VARCHAR NOT NULL)',
  begin: 'BEGIN TRANSACTION',
  deleteFacts: 'DELETE FROM gaia_pr_delivery_fact',
  deleteScope: 'DELETE FROM gaia_pr_delivery_scope',
  insertFact: 'INSERT INTO gaia_pr_delivery_fact ('
    + ' event_identity, repository, pull_request_number, kind, head_oid, occurred_at,'
    + ' provider_event_id, subject, outcome, sources, evidence_revision)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  insertScope: 'INSERT INTO gaia_pr_delivery_scope ('
    + ' projection_schema, facts_revision, current_head_oid) VALUES (?, ?, ?)',
  commit: 'COMMIT',
  selectMetrics: 'WITH scope AS (SELECT current_head_oid AS head FROM gaia_pr_delivery_scope),'
    + ' fact AS (SELECT kind, head_oid, outcome,'
    + ' epoch_ms(CAST(occurred_at AS TIMESTAMP)) AS at_ms FROM gaia_pr_delivery_fact),'
    + ' head_fact AS (SELECT fact.* FROM fact, scope WHERE fact.head_oid = scope.head),'
    + ' bounds AS (SELECT'
    + " (SELECT min(at_ms) FROM fact WHERE kind = 'DRAFT_OPENED') AS draft_opened,"
    + " (SELECT min(at_ms) FROM fact WHERE kind = 'READY_FOR_REVIEW') AS ready,"
    + " (SELECT min(at_ms) FROM fact WHERE kind = 'REVIEW_SUBMITTED'"
    + "  AND at_ms >= (SELECT min(at_ms) FROM fact WHERE kind = 'READY_FOR_REVIEW')) AS first_review,"
    + " (SELECT min(at_ms) FROM fact WHERE kind = 'CONFLICT_OBSERVED') AS conflict_observed,"
    + " (SELECT min(at_ms) FROM fact WHERE kind = 'CONFLICT_RESOLVED'"
    + "  AND at_ms >= (SELECT min(at_ms) FROM fact WHERE kind = 'CONFLICT_OBSERVED'))"
    + '  AS conflict_resolved,'
    + " (SELECT min(at_ms) FROM fact WHERE kind = 'MERGED') AS merged,"
    + " (SELECT min(at_ms) FROM head_fact WHERE kind = 'CHECK_QUEUED') AS head_queued,"
    + " (SELECT min(at_ms) FROM head_fact WHERE kind = 'CHECK_STARTED') AS head_started,"
    + " (SELECT max(at_ms) FROM head_fact WHERE kind = 'CHECK_COMPLETED') AS head_completed,"
    + " (SELECT min(at_ms) FROM head_fact WHERE kind = 'CHECK_COMPLETED'"
    + "  AND outcome = 'SUCCESS') AS head_green,"
    + " (SELECT min(at_ms) FROM head_fact WHERE kind IN ('DRAFT_OPENED', 'HEAD_ADVANCED'))"
    + '  AS head_opened,'
    + " (SELECT count(*) FROM fact WHERE kind IN ('DRAFT_OPENED', 'HEAD_ADVANCED')) AS rounds,"
    + " (SELECT count(*) FROM fact WHERE kind = 'REVIEW_SUBMITTED') AS reviews,"
    + " (SELECT count(*) FROM head_fact WHERE kind = 'CHECK_COMPLETED') AS head_checks,"
    + " (SELECT count(*) FROM fact WHERE kind = 'CONFLICT_OBSERVED') AS conflicts)"
    + ` ${METRIC_SELECTS.map(metricSelect).join(' UNION ALL ')}`
    + ' ORDER BY metric_kind, metric',
});

export class PrDeliveryDuckDbError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrDeliveryDuckDbError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PrDeliveryDuckDbError(code, message);
}

function databasePathOf(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    fail('DatabasePathInvalid', 'databasePath must be explicit');
  }
  return resolve(value);
}

/** Open the optional analytical client. Absence is named, never degraded into an empty result. */
export async function openPrDeliveryDuckDbClient(path, { readOnly = false } = {}) {
  let api;
  try {
    api = await import(PR_DELIVERY_DUCKDB_CLIENT);
  } catch {
    fail('DuckDbClientAbsent', `optional ${PR_DELIVERY_DUCKDB_CLIENT} is unavailable`);
  }
  const instance = await api.DuckDBInstance.create(
    databasePathOf(path), readOnly ? { access_mode: 'READ_ONLY' } : {},
  );
  const connection = await instance.connect();
  return {
    async run(sql, params = []) {
      if (params.length === 0) await connection.run(sql);
      else await connection.run(sql, params);
    },
    async rows(sql) {
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjects();
    },
    close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

const wire = (fact) => [
  fact.eventIdentity, fact.repository, fact.pullRequestNumber, fact.kind, fact.headOid,
  fact.occurredAt, fact.providerEventId, fact.subject, fact.outcome, fact.sources,
  fact.evidenceRevision,
];

function integer(value, column) {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(numeric)) {
    fail('ProjectionValueUnrepresentable', `${column} did not read back as a whole number`);
  }
  return numeric;
}

function canonicalRow(row) {
  if (typeof row?.metric !== 'string' || typeof row?.metric_kind !== 'string'
      || typeof row?.head_binding !== 'string') {
    fail('ProjectionRowInvalid', 'a metric row must name its metric, kind, and head binding');
  }
  return Object.freeze({
    metric: row.metric,
    kind: row.metric_kind,
    headBinding: row.head_binding,
    valueMilliseconds: integer(row.value_ms, row.metric),
    count: integer(row.metric_count, row.metric),
    unknownReason: row.unknown_reason ?? null,
  });
}

/**
 * Rebuild the analytical store from one fact set and read the named metrics back out of SQL.
 *
 * The store is disposable: every run deletes and reloads its two tables inside one transaction, so
 * a deleted database file and a reordered input stream both converge on the same rows.
 */
export async function projectPrDeliveryMetricsThroughDuckDb({
  ingestion, currentHeadOid, databasePath, openClient = openPrDeliveryDuckDbClient,
} = {}) {
  if (!ingestion || typeof ingestion !== 'object' || !Array.isArray(ingestion.facts)) {
    fail('InvalidIngestion', 'ingestion must carry the fact list to project');
  }
  if (typeof currentHeadOid !== 'string' || currentHeadOid.length === 0) {
    fail('InvalidHead', 'currentHeadOid must be supplied');
  }
  if (typeof openClient !== 'function') fail('InvalidAdapter', 'openClient must be a function');
  const path = databasePathOf(databasePath);
  const statements = PR_DELIVERY_DUCKDB_STATEMENTS;

  const client = await openClient(path, { readOnly: false });
  let rows;
  try {
    await client.run(statements.createFacts);
    await client.run(statements.createScope);
    await client.run(statements.begin);
    await client.run(statements.deleteFacts);
    await client.run(statements.deleteScope);
    for (const fact of ingestion.facts) await client.run(statements.insertFact, wire(fact));
    await client.run(statements.insertScope, [
      PR_DELIVERY_DUCKDB_SCHEMA, ingestion.factsRevision, currentHeadOid,
    ]);
    await client.run(statements.commit);
    rows = await client.rows(statements.selectMetrics);
  } finally {
    client.close();
  }

  const expected = PR_DELIVERY_INTERVALS.length + PR_DELIVERY_COUNTS.length;
  if (!Array.isArray(rows) || rows.length !== expected) {
    fail(
      'ProjectionRowsMissing',
      `the analytical projection returned ${Array.isArray(rows) ? rows.length : 'no'} of ${expected} named metrics`,
    );
  }
  return Object.freeze({
    schema: PR_DELIVERY_DUCKDB_SCHEMA,
    databasePath: path,
    factsRevision: ingestion.factsRevision,
    currentHeadOid,
    rows: Object.freeze(rows.map(canonicalRow)),
    effect: 'ANALYTICAL_PROJECTION_REBUILT',
    authority: 'NONE',
  });
}
