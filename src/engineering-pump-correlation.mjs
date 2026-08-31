/**
 * Passive, durable correlation between one portfolio action generation and the existing
 * first-evidence delivery operation that serves it.
 *
 * This is deliberately not another lifecycle machine: it has no transitions and performs no
 * effect. Its single append-only witness prevents read-side projections from joining two
 * independent journals by issue number after the same issue is reclaimed under new evidence.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  CorruptLogError, LOCK_RM_OPTIONS, LOCK_STALE_MS, LOCK_TIMEOUT_MS, LockTimeoutError,
  parseEventLog,
} from './event-log.mjs';

export const ENGINEERING_PUMP_CORRELATION_SCHEMA = 'gaia-engineering-pump-correlation/1';
export const ENGINEERING_PUMP_CORRELATION_LEDGER_SCHEMA =
  'gaia-engineering-pump-correlation-ledger/1';
export const ENGINEERING_PUMP_CORRELATION_RECORD_SCHEMA =
  'gaia-engineering-pump-correlation-record/1';

const SHA256 = /^[a-f0-9]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ITEM_KIND = /^[A-Z][A-Z0-9_]{0,31}$/u;
const FIELDS = Object.freeze([
  'schema', 'actionIdentity', 'claimRevision', 'deliveryOperationIdentity', 'repository',
  'itemKind', 'itemId', 'itemNumber', 'subjectRevision', 'policyRevision', 'revision',
]);

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export class EngineeringPumpCorrelationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineeringPumpCorrelationError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new EngineeringPumpCorrelationError(code, message); };

function root(directory) {
  if (typeof directory !== 'string' || directory.trim() !== directory || directory.length === 0) {
    fail('CorrelationPathInvalid', 'directory must be explicit');
  }
  return resolve(directory);
}

const pathFor = (directory) => join(root(directory), 'engineering-pump-correlations.jsonl');
const lockFor = (directory) => join(root(directory), 'engineering-pump-correlations.lock');

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withLock(directory, operation, {
  timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS,
} = {}) {
  const directoryPath = root(directory);
  const lockPath = lockFor(directoryPath);
  mkdirSync(directoryPath, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          `could not acquire ${lockPath} within ${timeoutMs}ms; refusing correlation access `
          + `(fail closed; stale threshold ${staleMs}ms)`,
        );
      }
      sleep(15);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lockPath, LOCK_RM_OPTIONS);
  }
}

function exactSha(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('CorrelationInvalid', `${field} must be a lowercase SHA-256`);
  }
  return value;
}

function sealWitness(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CorrelationInvalid', 'correlation witness must be an object');
  }
  const supplied = Object.keys(value);
  const expected = FIELDS.filter((field) => field !== 'revision');
  if (supplied.length !== expected.length || supplied.some((field) => !expected.includes(field))) {
    fail('CorrelationInvalid', 'correlation witness must contain exactly its closed fields');
  }
  if (value.schema !== ENGINEERING_PUMP_CORRELATION_SCHEMA) {
    fail('CorrelationInvalid', 'correlation witness has the wrong schema');
  }
  for (const field of [
    'actionIdentity', 'claimRevision', 'deliveryOperationIdentity', 'subjectRevision',
    'policyRevision',
  ]) exactSha(value[field], field);
  if (typeof value.repository !== 'string' || !REPOSITORY.test(value.repository)) {
    fail('CorrelationInvalid', 'repository must be owner/name');
  }
  if (typeof value.itemKind !== 'string' || !ITEM_KIND.test(value.itemKind)
      || typeof value.itemId !== 'string' || value.itemId.length === 0
      || !Number.isSafeInteger(value.itemNumber) || value.itemNumber <= 0) {
    fail('CorrelationInvalid', 'item identity is invalid');
  }
  return deepFreeze({ ...value, revision: sha256(value) });
}

function readUnlocked(directory) {
  const path = pathFor(directory);
  if (!existsSync(path)) return [];
  const records = parseEventLog(readFileSync(path, 'utf8'), { source: path });
  let previousRevision = null;
  for (const [ordinal, record] of records.entries()) {
    if (!record || record.type !== 'engineering-pump.correlation'
        || record.schema !== ENGINEERING_PUMP_CORRELATION_RECORD_SCHEMA
        || record.ordinal !== ordinal || record.previousRevision !== previousRevision) {
      throw new CorruptLogError('engineering-pump correlation chain is invalid');
    }
    const { revision, ...body } = record;
    if (!SHA256.test(revision ?? '') || revision !== sha256(body)) {
      throw new CorruptLogError('engineering-pump correlation record digest is invalid');
    }
    const { revision: witnessRevision, ...witnessBody } = record.witness ?? {};
    if (witnessRevision !== sha256(witnessBody)) {
      throw new CorruptLogError('engineering-pump correlation witness digest is invalid');
    }
    try {
      if (sealWitness(witnessBody).revision !== witnessRevision) {
        throw new CorruptLogError('engineering-pump correlation witness is altered');
      }
    } catch (error) {
      if (error instanceof CorruptLogError) throw error;
      throw new CorruptLogError(`engineering-pump correlation witness is invalid: ${error.code}`);
    }
    previousRevision = revision;
  }
  return records;
}

function snapshot(records) {
  const witnesses = records.map(({ witness }) => witness);
  return deepFreeze({
    schema: ENGINEERING_PUMP_CORRELATION_LEDGER_SCHEMA,
    revision: records.at(-1)?.revision ?? sha256({
      schema: ENGINEERING_PUMP_CORRELATION_LEDGER_SCHEMA, records: [],
    }),
    count: witnesses.length,
    witnesses,
  });
}

export function readEngineeringPumpCorrelations({ directory, lockOptions } = {}) {
  const directoryPath = root(directory);
  if (!existsSync(directoryPath)) return snapshot([]);
  return withLock(directoryPath, () => snapshot(readUnlocked(directoryPath)), lockOptions);
}

export function appendEngineeringPumpCorrelation({ directory, witness, lockOptions } = {}) {
  const directoryPath = root(directory);
  const sealed = sealWitness(witness);
  return withLock(directoryPath, () => {
    const records = readUnlocked(directoryPath);
    const existing = records.find(
      ({ witness: current }) => current.actionIdentity === sealed.actionIdentity,
    );
    if (existing) {
      if (existing.witness.revision !== sealed.revision) {
        fail('CorrelationConflict', 'this action identity already binds another generation');
      }
      return deepFreeze({ duplicate: true, ledger: snapshot(records) });
    }
    const body = {
      type: 'engineering-pump.correlation',
      schema: ENGINEERING_PUMP_CORRELATION_RECORD_SCHEMA,
      ordinal: records.length,
      previousRevision: records.at(-1)?.revision ?? null,
      witness: sealed,
    };
    const record = deepFreeze({ ...body, revision: sha256(body) });
    const path = pathFor(directoryPath);
    appendFileSync(path, `${canonicalJson(record)}\n`, 'utf8');
    const descriptor = openSync(path, 'r+');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    return deepFreeze({ duplicate: false, ledger: snapshot([...records, record]) });
  }, lockOptions);
}
