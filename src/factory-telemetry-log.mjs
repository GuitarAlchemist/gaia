/**
 * factory-telemetry-log.mjs - crash-safe persistence for passive factory telemetry events.
 *
 * This Adapter owns exactly one append-only JSONL file and one lock directory. It performs
 * lock -> re-read -> compare-and-swap -> semantic replay -> append -> fsync, which makes the
 * durable log the single authoritative record of what was observed. Reads are locked too, so
 * a caller never projects a half-written tail.
 *
 * It is passive by construction. Nothing here starts a worker, calls a provider, retries an
 * operation, routes a message or consumes any authority; the only effect is one local append
 * of facts that already happened.
 */

import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  CorruptLogError, LOCK_RM_OPTIONS, LOCK_STALE_MS, LOCK_TIMEOUT_MS, LockTimeoutError,
  parseEventLog,
} from './event-log.mjs';
import {
  FACTORY_TELEMETRY_MACHINE,
  replayFactoryTelemetry,
  verifyFactoryTelemetryEvent,
} from './factory-telemetry.mjs';

export const FACTORY_TELEMETRY_LOG_SCHEMA = 'gaia-factory-telemetry-log/1';
export const FACTORY_TELEMETRY_LOG_RECORD_SCHEMA = 'gaia-factory-telemetry-log-record/1';
export const FACTORY_TELEMETRY_TICK_SCHEMA = 'gaia-factory-telemetry-tick/1';

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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const EMPTY_FACTORY_TELEMETRY_LOG_REVISION = sha256(canonicalJson({
  schema: FACTORY_TELEMETRY_LOG_SCHEMA,
  machine: FACTORY_TELEMETRY_MACHINE,
  records: [],
}));

export class FactoryTelemetryLogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FactoryTelemetryLogError';
    this.code = code;
  }
}

function requireDirectory(directory) {
  if (typeof directory !== 'string' || directory.trim() !== directory
      || directory.length === 0) {
    throw new FactoryTelemetryLogError('LogPathInvalid', 'directory must be explicit');
  }
  return resolve(directory);
}

function requireRevision(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new FactoryTelemetryLogError('LogRequestInvalid', `${field} must be a SHA-256`);
  }
  return value;
}

export function factoryTelemetryLogPath(directory) {
  return join(requireDirectory(directory), 'factory-telemetry.jsonl');
}

export function factoryTelemetryLogLockPath(directory) {
  return join(requireDirectory(directory), 'factory-telemetry.lock');
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withLogLock(directory, operation, {
  timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS,
} = {}) {
  const root = requireDirectory(directory);
  const lock = factoryTelemetryLogLockPath(root);
  mkdirSync(root, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let held = false;
  while (!held) {
    try {
      mkdirSync(lock);
      held = true;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          `could not acquire ${lock} within ${timeoutMs}ms; refusing to access the telemetry `
          + `log without its lock (fail closed; stale threshold ${staleMs}ms)`,
        );
      }
      sleepSync(15);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lock, LOCK_RM_OPTIONS);
  }
}

function verifyRecord(record, expectedOrdinal, expectedPreviousRevision) {
  if (!record || record.type !== 'factory-telemetry.event'
      || record.schema !== FACTORY_TELEMETRY_LOG_RECORD_SCHEMA) {
    throw new CorruptLogError('factory telemetry log contains an unsupported record');
  }
  const { revision, ...body } = record;
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision)
      || revision !== sha256(canonicalJson(body))) {
    throw new CorruptLogError('factory telemetry log record revision does not match its content');
  }
  if (record.machineId !== FACTORY_TELEMETRY_MACHINE.machineId
      || record.machineVersion !== FACTORY_TELEMETRY_MACHINE.machineVersion
      || record.rulesRevision !== FACTORY_TELEMETRY_MACHINE.rulesRevision) {
    throw new CorruptLogError('factory telemetry log record binds an unsupported machine');
  }
  if (record.ordinal !== expectedOrdinal
      || record.previousRevision !== expectedPreviousRevision) {
    throw new CorruptLogError('factory telemetry log record chain is not contiguous');
  }
  try {
    verifyFactoryTelemetryEvent(record.event);
  } catch (error) {
    throw new CorruptLogError(
      `factory telemetry log record holds an invalid event: ${error.message}`,
    );
  }
  return record;
}

function readRecordsUnlocked(directory) {
  const path = factoryTelemetryLogPath(directory);
  if (!existsSync(path)) return [];
  const records = parseEventLog(readFileSync(path, 'utf8'), { source: path });
  let previousRevision = null;
  for (const [ordinal, record] of records.entries()) {
    verifyRecord(record, ordinal, previousRevision);
    previousRevision = record.revision;
  }
  return records;
}

function snapshot(records) {
  return deepFreeze({
    schema: FACTORY_TELEMETRY_LOG_SCHEMA,
    machine: FACTORY_TELEMETRY_MACHINE,
    revision: records.at(-1)?.revision ?? EMPTY_FACTORY_TELEMETRY_LOG_REVISION,
    count: records.length,
    events: records.map(({ event }) => event),
  });
}

export function readFactoryTelemetryLog({ directory, lockOptions } = {}) {
  const root = requireDirectory(directory);
  if (!existsSync(root)) return snapshot([]);
  return withLogLock(root, () => snapshot(readRecordsUnlocked(root)), lockOptions);
}

function appendRecord(directory, record) {
  const path = factoryTelemetryLogPath(directory);
  appendFileSync(path, `${canonicalJson(record)}\n`, 'utf8');
  const descriptor = openSync(path, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Append one observed fact under compare-and-swap.
 *
 * Duplicate delivery of the identical content-addressed event is a no-op regardless of the
 * head the caller observed, because a retried sensor legitimately holds a stale head. Every
 * other divergence - a lost update, a broken run, a future observation - fails closed and
 * writes nothing.
 */
export function appendFactoryTelemetryEvent({
  directory, event, expectedLogRevision, notAfter = new Date().toISOString(), lockOptions,
}) {
  const root = requireDirectory(directory);
  requireRevision(expectedLogRevision, 'expectedLogRevision');
  verifyFactoryTelemetryEvent(event);
  return withLogLock(root, () => {
    const records = readRecordsUnlocked(root);
    const before = snapshot(records);
    if (records.some(({ event: existing }) => existing.revision === event.revision)) {
      return deepFreeze({ duplicate: true, log: before });
    }
    if (before.revision !== expectedLogRevision) {
      throw new FactoryTelemetryLogError(
        'LogCasMismatch', 'the telemetry log changed since the caller observed it',
      );
    }
    // Fails closed on gaps, reordering, substitution, impossible transitions, unknown event
    // types, corrupted history and future timestamps before anything reaches the disk.
    replayFactoryTelemetry({ events: [...before.events, event], notAfter });
    const body = {
      type: 'factory-telemetry.event',
      schema: FACTORY_TELEMETRY_LOG_RECORD_SCHEMA,
      ...FACTORY_TELEMETRY_MACHINE,
      ordinal: records.length,
      previousRevision: records.at(-1)?.revision ?? null,
      event,
    };
    const record = deepFreeze({ ...body, revision: sha256(canonicalJson(body)) });
    appendRecord(root, record);
    return deepFreeze({ duplicate: false, log: snapshot([...records, record]) });
  }, lockOptions);
}

/** Replay the durable log into one passive projection. Read-only at every seam. */
export function projectFactoryTelemetryLog({
  directory, notAfter = new Date().toISOString(), lockOptions,
} = {}) {
  const log = readFactoryTelemetryLog({ directory, lockOptions });
  return deepFreeze({
    schema: FACTORY_TELEMETRY_TICK_SCHEMA,
    machine: FACTORY_TELEMETRY_MACHINE,
    logRevision: log.revision,
    projection: replayFactoryTelemetry({ events: log.events, notAfter }),
    effect: 'NONE',
    authority: 'NONE',
  });
}
