/**
 * Derived DuckDB projection of the authoritative PR review-thread repair ledger.
 *
 * The append-only, locked JSONL ledger remains the replay authority. This Adapter transactionally
 * rebuilds a flat analytical table through the same optional `@duckdb/node-api` port used by
 * Gaia's raw telemetry work; DuckDB is never a scheduler, lock, claim owner, or merge authority.
 */

import { resolve } from 'node:path';

import { buildFactoryTelemetryEvent } from './factory-telemetry.mjs';
import {
  appendFactoryTelemetryEvent,
  readFactoryTelemetryLog,
} from './factory-telemetry-log.mjs';
import { projectPrReviewRepairLedger } from './pr-review-thread-repair.mjs';

export const PR_REVIEW_THREAD_DUCKDB_CLIENT = '@duckdb/node-api';
export const PR_REVIEW_THREAD_DUCKDB_SCHEMA = 'gaia-pr-review-thread-telemetry/1';

export const PR_REVIEW_THREAD_DUCKDB_STATEMENTS = Object.freeze({
  createRows: 'CREATE TABLE IF NOT EXISTS gaia_pr_review_thread_transition ('
    + ' thread_identity VARCHAR NOT NULL, transition_revision VARCHAR NOT NULL,'
    + ' ordinal INTEGER NOT NULL, transition VARCHAR NOT NULL,'
    + ' intent VARCHAR NOT NULL, repository VARCHAR NOT NULL, pull_request_number INTEGER NOT NULL,'
    + ' review_thread_id VARCHAR NOT NULL, reviewed_head_oid VARCHAR NOT NULL,'
    + ' current_head_oid VARCHAR NOT NULL, review_state VARCHAR NOT NULL, severity VARCHAR NOT NULL,'
    + ' actionable_comment_ids VARCHAR NOT NULL, repair_head_oid VARCHAR, comment_id VARCHAR,'
    + ' comment_url VARCHAR, refusal VARCHAR, owner VARCHAR NOT NULL, lease_expires_at VARCHAR,'
    + ' recorded_at VARCHAR NOT NULL)',
  createMeta: 'CREATE TABLE IF NOT EXISTS gaia_pr_review_thread_projection ('
    + ' projection_schema VARCHAR NOT NULL, source_ledger_revision VARCHAR NOT NULL,'
    + ' row_count INTEGER NOT NULL)',
  begin: 'BEGIN TRANSACTION',
  deleteRows: 'DELETE FROM gaia_pr_review_thread_transition',
  deleteMeta: 'DELETE FROM gaia_pr_review_thread_projection',
  insertRow: 'INSERT INTO gaia_pr_review_thread_transition ('
    + ' thread_identity, transition_revision, ordinal, transition, intent, repository, pull_request_number,'
    + ' review_thread_id, reviewed_head_oid, current_head_oid, review_state, severity,'
    + ' actionable_comment_ids, repair_head_oid, comment_id, comment_url, refusal, owner,'
    + ' lease_expires_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  insertMeta: 'INSERT INTO gaia_pr_review_thread_projection ('
    + ' projection_schema, source_ledger_revision, row_count) VALUES (?, ?, ?)',
  commit: 'COMMIT',
});

export class PrReviewThreadDuckDbError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrReviewThreadDuckDbError';
    this.code = code;
  }
}

function databasePath(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new PrReviewThreadDuckDbError('DatabasePathInvalid', 'databasePath must be explicit');
  }
  return resolve(value);
}

export async function openPrReviewThreadDuckDbClient(path, { readOnly = false } = {}) {
  let api;
  try {
    api = await import(PR_REVIEW_THREAD_DUCKDB_CLIENT);
  } catch {
    throw new PrReviewThreadDuckDbError(
      'DuckDbClientAbsent', `optional ${PR_REVIEW_THREAD_DUCKDB_CLIENT} is unavailable`,
    );
  }
  const instance = await api.DuckDBInstance.create(
    databasePath(path), readOnly ? { access_mode: 'READ_ONLY' } : {},
  );
  const connection = await instance.connect();
  return {
    async run(sql, params = []) {
      if (params.length === 0) await connection.run(sql);
      else await connection.run(sql, params);
    },
    close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

const wire = (row) => [
  row.threadIdentity, row.transitionRevision, row.ordinal, row.transition, row.intent, row.repository,
  row.pullRequestNumber, row.reviewThreadId, row.reviewedHeadOid, row.currentHeadOid,
  row.reviewState, row.severity, row.actionableCommentIds, row.repairHeadOid, row.commentId,
  row.commentUrl, row.refusal, row.owner, row.leaseExpiresAt, row.recordedAt,
];

/**
 * Mirror the seven lifecycle facts into Gaia's canonical locked telemetry spine.
 *
 * The review ledger remains the domain replay authority. Stable factory-event revisions make a
 * repeated synchronization a no-op; the factory log's compare-and-swap closes concurrent writers.
 */
export function mirrorPrReviewThreadLifecycleToFactoryTelemetry({
  rows, telemetryDirectory, lockOptions,
}) {
  const groups = new Map();
  for (const row of rows) {
    const current = groups.get(row.threadIdentity) ?? [];
    current.push(row);
    groups.set(row.threadIdentity, current);
  }
  let mirrored = 0;
  for (const [threadIdentity, transitions] of [...groups.entries()].sort()) {
    const ordered = transitions.toSorted((left, right) => left.ordinal - right.ordinal);
    const first = ordered[0];
    const subject = {
      repository: first.repository,
      itemId: `review-${threadIdentity.slice(0, 32)}`,
      itemNumber: first.pullRequestNumber,
      lane: 'PR_REVIEW',
      agent: 'GAIA_PUMP',
      itemRevision: threadIdentity,
    };
    const runId = `review-${threadIdentity.slice(0, 32)}`;
    let previous = buildFactoryTelemetryEvent({
      runId, subject, event: 'run.started', observedAt: first.recordedAt,
      evidenceRevision: first.transitionRevision,
    });
    const events = [previous];
    for (const row of ordered) {
      previous = buildFactoryTelemetryEvent({
        runId, subject, previous, event: 'gate.entered', gate: row.transition,
        observedAt: row.recordedAt, evidenceRevision: row.transitionRevision,
      });
      events.push(previous);
      previous = buildFactoryTelemetryEvent({
        runId, subject, previous, event: 'gate.passed', gate: row.transition,
        observedAt: row.recordedAt, evidenceRevision: row.transitionRevision,
      });
      events.push(previous);
    }
    if (ordered.at(-1).transition === 'RESOLVED') {
      previous = buildFactoryTelemetryEvent({
        runId, subject, previous, event: 'run.completed',
        observedAt: ordered.at(-1).recordedAt,
        evidenceRevision: ordered.at(-1).transitionRevision,
      });
      events.push(previous);
    }
    for (const event of events) {
      const head = readFactoryTelemetryLog({ directory: telemetryDirectory, lockOptions });
      const appended = appendFactoryTelemetryEvent({
        directory: telemetryDirectory, event, expectedLogRevision: head.revision,
        notAfter: ordered.at(-1).recordedAt, lockOptions,
      });
      if (!appended.duplicate) mirrored += 1;
    }
  }
  return Object.freeze({ mirrored });
}

/** Rebuild the analytical table from one locked replay of the canonical repair ledger. */
export async function synchronizePrReviewThreadDuckDb({
  directory, telemetryDirectory = directory, databasePath: suppliedPath,
  openClient = openPrReviewThreadDuckDbClient, lockOptions,
} = {}) {
  const path = databasePath(suppliedPath);
  if (typeof openClient !== 'function') {
    throw new PrReviewThreadDuckDbError('InvalidAdapter', 'openClient must be a function');
  }
  const projection = projectPrReviewRepairLedger({ directory, lockOptions });
  const rows = projection.projection.rows;
  const factory = mirrorPrReviewThreadLifecycleToFactoryTelemetry({
    rows, telemetryDirectory, lockOptions,
  });
  const client = await openClient(path, { readOnly: false });
  try {
    await client.run(PR_REVIEW_THREAD_DUCKDB_STATEMENTS.createRows);
    await client.run(PR_REVIEW_THREAD_DUCKDB_STATEMENTS.createMeta);
    await client.run(PR_REVIEW_THREAD_DUCKDB_STATEMENTS.begin);
    await client.run(PR_REVIEW_THREAD_DUCKDB_STATEMENTS.deleteRows);
    await client.run(PR_REVIEW_THREAD_DUCKDB_STATEMENTS.deleteMeta);
    for (const row of rows) {
      await client.run(PR_REVIEW_THREAD_DUCKDB_STATEMENTS.insertRow, wire(row));
    }
    await client.run(PR_REVIEW_THREAD_DUCKDB_STATEMENTS.insertMeta, [
      PR_REVIEW_THREAD_DUCKDB_SCHEMA, projection.ledgerRevision, rows.length,
    ]);
    await client.run(PR_REVIEW_THREAD_DUCKDB_STATEMENTS.commit);
  } finally {
    client.close();
  }
  return Object.freeze({
    schema: PR_REVIEW_THREAD_DUCKDB_SCHEMA,
    databasePath: path,
    sourceLedgerRevision: projection.ledgerRevision,
    rowCount: rows.length,
    mirroredFactoryEvents: factory.mirrored,
    effect: 'ANALYTICAL_PROJECTION_REBUILT',
    authority: 'NONE',
  });
}
