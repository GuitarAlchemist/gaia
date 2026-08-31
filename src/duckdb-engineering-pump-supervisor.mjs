/** Rebuildable DuckDB projection of the exact stable engineering-pump source generations. */

import { resolve } from 'node:path';

import { projectEngineeringPumpTransitions } from './engineering-pump-supervisor.mjs';

export const ENGINEERING_PUMP_DUCKDB_SCHEMA = 'gaia-engineering-pump-duckdb/1';
export const ENGINEERING_PUMP_DUCKDB_CLIENT = '@duckdb/node-api';

const SQL = Object.freeze({
  createRows: 'CREATE TABLE IF NOT EXISTS gaia_engineering_pump_transition ('
    + 'source VARCHAR NOT NULL, ordinal INTEGER NOT NULL, transition VARCHAR NOT NULL,'
    + 'revision VARCHAR NOT NULL, repository VARCHAR NOT NULL, item_id VARCHAR NOT NULL,'
    + 'item_number INTEGER NOT NULL, operation_identity VARCHAR, recorded_at VARCHAR NOT NULL,'
    + 'execution_profile VARCHAR NOT NULL, observed_telemetry VARCHAR NOT NULL)',
  createMeta: 'CREATE TABLE IF NOT EXISTS gaia_engineering_pump_projection ('
    + 'schema VARCHAR NOT NULL, portfolio_revision VARCHAR NOT NULL,'
    + 'draft_revision VARCHAR NOT NULL, correlation_revision VARCHAR NOT NULL,'
    + 'row_count INTEGER NOT NULL)',
  dropMeta: 'DROP TABLE IF EXISTS gaia_engineering_pump_projection',
  begin: 'BEGIN TRANSACTION',
  deleteRows: 'DELETE FROM gaia_engineering_pump_transition',
  insertRow: 'INSERT INTO gaia_engineering_pump_transition VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  insertMeta: 'INSERT INTO gaia_engineering_pump_projection VALUES (?, ?, ?, ?, ?)',
  commit: 'COMMIT',
});

export class EngineeringPumpDuckDbError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineeringPumpDuckDbError';
    this.code = code;
  }
}

function requirePath(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new EngineeringPumpDuckDbError('DatabasePathInvalid', 'databasePath must be explicit');
  }
  return resolve(value);
}

export async function openEngineeringPumpDuckDbClient(path, { readOnly = false } = {}) {
  let api;
  try {
    api = await import(ENGINEERING_PUMP_DUCKDB_CLIENT);
  } catch {
    throw new EngineeringPumpDuckDbError(
      'DuckDbClientAbsent', `optional ${ENGINEERING_PUMP_DUCKDB_CLIENT} is unavailable`,
    );
  }
  const instance = await api.DuckDBInstance.create(
    requirePath(path), readOnly ? { access_mode: 'READ_ONLY' } : {},
  );
  const connection = await instance.connect();
  return {
    async run(sql, params = []) {
      if (params.length === 0) await connection.run(sql);
      else await connection.run(sql, params);
    },
    close() { connection.closeSync(); instance.closeSync(); },
  };
}

const wire = (row) => [
  row.source, row.ordinal, row.transition, row.revision, row.repository, row.itemId,
  row.itemNumber, row.operationIdentity, row.recordedAt,
  JSON.stringify(row.executionProfile), JSON.stringify(row.observedTelemetry),
];

export async function synchronizeEngineeringPumpDuckDb({
  directory, databasePath, openClient = openEngineeringPumpDuckDbClient, lockOptions,
} = {}) {
  const path = requirePath(databasePath);
  if (typeof openClient !== 'function') {
    throw new EngineeringPumpDuckDbError('InvalidAdapter', 'openClient must be a function');
  }
  const projection = projectEngineeringPumpTransitions({ directory, lockOptions });
  const client = await openClient(path, { readOnly: false });
  try {
    await client.run(SQL.begin);
    await client.run(SQL.createRows);
    await client.run(SQL.dropMeta);
    await client.run(SQL.createMeta);
    await client.run(SQL.deleteRows);
    for (const row of projection.rows) await client.run(SQL.insertRow, wire(row));
    await client.run(SQL.insertMeta, [
      ENGINEERING_PUMP_DUCKDB_SCHEMA,
      projection.sourceRevisions.portfolioDrain,
      projection.sourceRevisions.draftDelivery,
      projection.sourceRevisions.pumpCorrelation,
      projection.rows.length,
    ]);
    await client.run(SQL.commit);
  } finally {
    client.close();
  }
  return Object.freeze({
    schema: ENGINEERING_PUMP_DUCKDB_SCHEMA,
    databasePath: path,
    sourceRevisions: projection.sourceRevisions,
    rowCount: projection.rows.length,
    effect: 'ANALYTICAL_PROJECTION_REBUILT', authority: 'NONE',
  });
}
