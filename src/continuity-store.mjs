import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ContinuityError,
  canonicalContinuityJson,
  digestContinuityValue,
  isContinuityDigest,
  isContinuityIdentifier,
  refuse,
} from './continuity-contract.mjs';

const EXPECTED_TABLES = Object.freeze([
  'continuity_events',
  'continuity_inspections',
  'continuity_meta',
  'continuity_operation_reservations',
  'continuity_operations',
  'continuity_state',
]);
const INSPECTION_OPERATION_LIMIT = 32;

function validatePath(input) {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) refuse('INVALID_PATH');
  const path = resolve(input);
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) refuse('INVALID_PATH');
  } catch (error) {
    if (error.code !== 'ENOENT') refuse('INVALID_PATH');
  }
  return path;
}

function isNormalizedUtc(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function normalizeUtc(value) {
  if (!isNormalizedUtc(value)) refuse('INVALID_CLOCK');
  return value;
}

export function openContinuityStore({ path: inputPath, clock = () => new Date().toISOString(),
  clockEpoch = randomBytes(32).toString('hex') }) {
  const path = validatePath(inputPath);
  if (typeof clock !== 'function' || !isContinuityDigest(clockEpoch)) refuse('INVALID_CLOCK');
  let isNew = false;
  try { lstatSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') refuse('INVALID_PATH');
    isNew = true;
  }
  let db;
  let closed = false;

  const rollback = () => { try { db.exec('ROLLBACK'); } catch { /* no active transaction */ } };
  function begin() {
    if (closed) refuse('STORE_CLOSED');
    try { db.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      refuse(error.code === 'ERR_SQLITE_ERROR' && /busy|locked/iu.test(error.message)
        ? 'STORE_BUSY' : 'STORE_CORRUPT');
    }
  }
  function readState() {
    const row = db.prepare('SELECT revision,state_json FROM continuity_state WHERE id=1').get();
    if (!row) return null;
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) refuse('STORE_CORRUPT');
    try { return { ...JSON.parse(row.state_json), revision }; }
    catch { refuse('STORE_CORRUPT'); }
  }
  function readClock() {
    const row = db.prepare(`SELECT clock_epoch,clock_sequence,clock_head,last_candidate_utc
      FROM continuity_meta WHERE id=1`).get();
    if (!row || !isContinuityDigest(row.clock_epoch) || !isContinuityDigest(row.clock_head)
      || !Number.isSafeInteger(Number(row.clock_sequence))
      || Number(row.clock_sequence) < 0
      || (row.last_candidate_utc !== null && !isNormalizedUtc(row.last_candidate_utc))) {
      refuse('STORE_CORRUPT');
    }
    return { epoch: row.clock_epoch, sequence: Number(row.clock_sequence), head: row.clock_head,
      lastCandidateUtc: row.last_candidate_utc };
  }
  function durablePayloadBytes() {
    const payload = db.prepare(`SELECT
      COALESCE((SELECT sum(length(CAST(response_json AS BLOB))) FROM continuity_operations),0)
      + COALESCE((SELECT sum(length(CAST(response_json AS BLOB))) FROM continuity_inspections),0)
      + COALESCE((SELECT sum(length(CAST(event_json AS BLOB))) FROM continuity_events),0)
      + COALESCE((SELECT length(CAST(state_json AS BLOB)) FROM continuity_state WHERE id=1),0)
      AS bytes`).get();
    return Number(payload.bytes);
  }

  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const mode = db.prepare('PRAGMA journal_mode=WAL').get();
    if (mode.journal_mode !== 'wal') refuse('WAL_UNAVAILABLE');
    db.exec('BEGIN IMMEDIATE');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all().map(table => table.name).sort();
    if (tables.length === 0) {
      // A pre-existing empty or erased ledger is corruption, not fresh authority.
      if (!isNew) refuse('STORE_CORRUPT');
      db.exec(`CREATE TABLE continuity_meta (
        id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=1),
        clock_epoch TEXT NOT NULL, clock_sequence INTEGER NOT NULL CHECK(clock_sequence>=0),
        clock_head TEXT NOT NULL, last_candidate_utc TEXT) STRICT;
        CREATE TABLE continuity_state (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=1),
        state_json TEXT NOT NULL) STRICT;
        CREATE TABLE continuity_operations (
        operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, response_json TEXT NOT NULL) STRICT;
        CREATE TABLE continuity_operation_reservations (
        operation_id TEXT PRIMARY KEY, owner_operation_id TEXT NOT NULL) STRICT;
        CREATE TABLE continuity_inspections (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL, response_json TEXT NOT NULL) STRICT;
        CREATE TABLE continuity_events (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, event_json TEXT NOT NULL) STRICT;`);
      db.prepare('INSERT INTO continuity_meta VALUES (1,1,?,0,?,NULL)')
        .run(clockEpoch, '0'.repeat(64));
    } else if (tables.join(',') !== EXPECTED_TABLES.join(',')) {
      refuse('STORE_CORRUPT');
    }
    const metadataRows = db.prepare('SELECT id,schema_version FROM continuity_meta').all();
    if (metadataRows.length !== 1 || metadataRows[0].id !== 1
      || metadataRows[0].schema_version !== 1) refuse('STORE_CORRUPT');
    const persistedClock = readClock();
    if (persistedClock.epoch !== clockEpoch) {
      // The durable epoch wins on restart. A caller-provided epoch may only initialize a new store.
      clockEpoch = persistedClock.epoch;
    }
    const storedState = readState();
    const lifecycleOperationCount = Number(db.prepare(`SELECT count(*) AS count
      FROM continuity_operations`).get().count);
    const eventCount = Number(db.prepare('SELECT count(*) AS count FROM continuity_events').get().count);
    if (storedState === null && (lifecycleOperationCount !== 0 || eventCount !== 0)) {
      refuse('STORE_CORRUPT');
    }
    db.exec('COMMIT');
  } catch (error) {
    rollback();
    try { db?.close(); } catch { /* preserve original refusal */ }
    if (error instanceof ContinuityError) throw error;
    refuse('STORE_CORRUPT');
  }

  function runOperation({ operationId, requestDigest, transition, operationClass = 'lifecycle',
    reservationOwner = null }) {
    if (!isContinuityIdentifier(operationId) || !isContinuityDigest(requestDigest)
      || typeof transition !== 'function'
      || !['inspection', 'lifecycle'].includes(operationClass)
      || (reservationOwner !== null && !isContinuityIdentifier(reservationOwner))) {
      refuse('INVALID_OPERATION');
    }
    begin();
    try {
      const prior = db.prepare(`SELECT request_digest,response_json FROM continuity_operations
        WHERE operation_id=? UNION ALL SELECT request_digest,response_json FROM continuity_inspections
        WHERE operation_id=?`).get(operationId, operationId);
      if (prior) {
        if (prior.request_digest !== requestDigest) refuse('OPERATION_CONFLICT');
        db.exec('COMMIT');
        return { responseBytes: prior.response_json, replayed: true };
      }
      const reservation = db.prepare(`SELECT owner_operation_id FROM continuity_operation_reservations
        WHERE operation_id=?`).get(operationId);
      if (reservation && reservation.owner_operation_id !== reservationOwner) {
        refuse('OPERATION_CONFLICT');
      }
      if (reservationOwner !== null && !reservation) refuse('OPERATION_CONFLICT');
      if (operationClass === 'inspection') {
        const inspectionCount = Number(db.prepare(`SELECT count(*) AS count
          FROM continuity_inspections`).get().count);
        if (inspectionCount >= INSPECTION_OPERATION_LIMIT) refuse('BOUND_EXCEEDED');
      }
      const state = readState();
      const reserveOperationIds = operationIds => {
        if (!Array.isArray(operationIds) || operationIds.length === 0
          || new Set([operationId, ...operationIds]).size !== operationIds.length + 1
          || operationIds.some(candidate => !isContinuityIdentifier(candidate))) {
          refuse('OPERATION_CONFLICT');
        }
        for (const candidate of operationIds) {
          const existing = db.prepare(`SELECT operation_id FROM continuity_operations WHERE operation_id=?
            UNION ALL SELECT operation_id FROM continuity_inspections WHERE operation_id=?
            UNION ALL SELECT operation_id FROM continuity_operation_reservations WHERE operation_id=?`)
            .get(candidate, candidate, candidate);
          if (existing) refuse('OPERATION_CONFLICT');
        }
        const insert = db.prepare(`INSERT INTO continuity_operation_reservations
          (operation_id,owner_operation_id) VALUES (?,?)`);
        for (const candidate of operationIds) insert.run(candidate, operationId);
      };
      let minted = false;
      let timeReceipt;
      const mintTime = () => {
        if (minted) refuse('INVALID_TRANSITION');
        minted = true;
        const current = readClock();
        const clockCandidate = normalizeUtc(clock());
        const candidateUtc = current.lastCandidateUtc !== null
          && Date.parse(current.lastCandidateUtc) > Date.parse(clockCandidate)
          ? current.lastCandidateUtc : clockCandidate;
        const body = { epoch: current.epoch, sequence: current.sequence + 1,
          candidateUtc, previousHead: current.head };
        timeReceipt = { ...body, head: digestContinuityValue('continuity.time-receipt/1', body) };
        db.prepare(`UPDATE continuity_meta SET clock_sequence=?,clock_head=?,last_candidate_utc=?
          WHERE id=1`).run(timeReceipt.sequence, timeReceipt.head, candidateUtc);
        return timeReceipt;
      };
      const outcome = transition({ state, mintTime, reserveOperationIds });
      if (!minted || !outcome || typeof outcome !== 'object') refuse('INVALID_TRANSITION');
      const responseBytes = canonicalContinuityJson(outcome.response);
      if (Buffer.byteLength(responseBytes, 'utf8') > 32_768) refuse('BOUND_EXCEEDED');
      if (operationClass === 'inspection') {
        if (outcome.state !== undefined || outcome.event !== undefined) refuse('INVALID_TRANSITION');
        if (durablePayloadBytes() + Buffer.byteLength(responseBytes, 'utf8') > 524_288) {
          refuse('BOUND_EXCEEDED');
        }
        db.prepare('INSERT INTO continuity_inspections(operation_id,request_digest,response_json) VALUES (?,?,?)')
          .run(operationId, requestDigest, responseBytes);
        db.exec('COMMIT');
        return { responseBytes, replayed: false };
      }
      let stateJson = '';
      if (outcome.state !== undefined) {
        const revision = outcome.state?.revision;
        if (!Number.isSafeInteger(revision) || revision < 1) refuse('INVALID_TRANSITION');
        const stored = { ...outcome.state };
        delete stored.revision;
        stateJson = canonicalContinuityJson(stored);
        if (Buffer.byteLength(stateJson, 'utf8') > 32_768) refuse('BOUND_EXCEEDED');
        db.prepare(`INSERT INTO continuity_state(id,revision,state_json) VALUES (1,?,?)
          ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json`)
          .run(revision, stateJson);
      }
      let eventJson = '';
      if (outcome.event) {
        if (!isContinuityIdentifier(outcome.event.type)) refuse('INVALID_TRANSITION');
        eventJson = canonicalContinuityJson(outcome.event);
        if (Buffer.byteLength(eventJson, 'utf8') > 32_768) refuse('BOUND_EXCEEDED');
        db.prepare('INSERT INTO continuity_events(event_type,event_json) VALUES (?,?)')
          .run(outcome.event.type, eventJson);
      }
      const operationCount = Number(db.prepare('SELECT count(*) AS count FROM continuity_operations').get().count);
      const eventCount = Number(db.prepare('SELECT count(*) AS count FROM continuity_events').get().count);
      if (operationCount >= 12 || eventCount > 16) refuse('BOUND_EXCEEDED');
      if (durablePayloadBytes() + Buffer.byteLength(responseBytes, 'utf8') > 524_288) {
        refuse('BOUND_EXCEEDED');
      }
      db.prepare('INSERT INTO continuity_operations VALUES (?,?,?)')
        .run(operationId, requestDigest, responseBytes);
      if (reservationOwner !== null) {
        const released = db.prepare(`DELETE FROM continuity_operation_reservations
          WHERE operation_id=? AND owner_operation_id=?`).run(operationId, reservationOwner);
        if (Number(released.changes) !== 1) refuse('STORE_CORRUPT');
      }
      db.exec('COMMIT');
      return { responseBytes, replayed: false };
    } catch (error) {
      rollback();
      if (error instanceof ContinuityError) throw error;
      refuse(error.code === 'ERR_SQLITE_ERROR' && /busy|locked/iu.test(error.message)
        ? 'STORE_BUSY' : 'STORE_CORRUPT');
    }
  }

  return Object.freeze({
    runOperation,
    status() {
      if (closed) refuse('STORE_CLOSED');
      return readState();
    },
    clockStatus() {
      if (closed) refuse('STORE_CLOSED');
      return readClock();
    },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}
