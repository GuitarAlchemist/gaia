/**
 * portfolio-drain-ledger.mjs — crash-safe persistence for portfolio drain receipts.
 *
 * This Adapter owns exactly one append-only JSONL file and one lock directory. It performs
 * lock → re-read → compare-and-swap → semantic replay → append → fsync. `tickPortfolioDrain`
 * is read-only: it returns the same projection for the same portfolio and ledger head and
 * never starts a worker or consumes authority.
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
  PORTFOLIO_DRAIN_MACHINE,
  reconcilePortfolioDrain,
  verifyPortfolioDrainReceipt,
} from './portfolio-drain.mjs';

export const PORTFOLIO_DRAIN_LEDGER_SCHEMA = 'gaia-portfolio-drain-ledger/1';
export const PORTFOLIO_DRAIN_LEDGER_RECORD_SCHEMA = 'gaia-portfolio-drain-ledger-record/1';

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

export const EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION = sha256(canonicalJson({
  schema: PORTFOLIO_DRAIN_LEDGER_SCHEMA,
  machine: PORTFOLIO_DRAIN_MACHINE,
  records: [],
}));

export class PortfolioDrainLedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortfolioDrainLedgerError';
    this.code = code;
  }
}

function requireDirectory(directory) {
  if (typeof directory !== 'string' || directory.trim() !== directory
      || directory.length === 0) {
    throw new PortfolioDrainLedgerError('LedgerPathInvalid', 'directory must be explicit');
  }
  return resolve(directory);
}

function requireRevision(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new PortfolioDrainLedgerError('LedgerRequestInvalid', `${field} must be a SHA-256`);
  }
  return value;
}

export function portfolioDrainLedgerPath(directory) {
  return join(requireDirectory(directory), 'portfolio-drain.jsonl');
}

export function portfolioDrainLedgerLockPath(directory) {
  return join(requireDirectory(directory), 'portfolio-drain.lock');
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withLedgerLock(directory, operation, {
  timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS,
} = {}) {
  const root = requireDirectory(directory);
  const lock = portfolioDrainLedgerLockPath(root);
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
          `could not acquire ${lock} within ${timeoutMs}ms; refusing to access the ledger `
          + `without its lock (fail closed; stale threshold ${staleMs}ms)`,
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
  if (!record || record.type !== 'portfolio-drain.receipt'
      || record.schema !== PORTFOLIO_DRAIN_LEDGER_RECORD_SCHEMA) {
    throw new CorruptLogError('portfolio drain ledger contains an unsupported record');
  }
  const { revision, ...body } = record;
  requireRevision(revision, 'record.revision');
  if (revision !== sha256(canonicalJson(body))) {
    throw new CorruptLogError('portfolio drain ledger record revision does not match its content');
  }
  if (record.machineId !== PORTFOLIO_DRAIN_MACHINE.machineId
      || record.machineVersion !== PORTFOLIO_DRAIN_MACHINE.machineVersion
      || record.rulesRevision !== PORTFOLIO_DRAIN_MACHINE.rulesRevision) {
    throw new CorruptLogError('portfolio drain ledger record binds an unsupported machine');
  }
  if (record.ordinal !== expectedOrdinal
      || record.previousRevision !== expectedPreviousRevision) {
    throw new CorruptLogError('portfolio drain ledger record chain is not contiguous');
  }
  verifyPortfolioDrainReceipt(record.receipt);
  return record;
}

function readRecordsUnlocked(directory) {
  const path = portfolioDrainLedgerPath(directory);
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
  const receipts = records.map(({ receipt }) => receipt);
  return deepFreeze({
    schema: PORTFOLIO_DRAIN_LEDGER_SCHEMA,
    machine: PORTFOLIO_DRAIN_MACHINE,
    revision: records.at(-1)?.revision ?? EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION,
    count: records.length,
    receipts,
  });
}

export function readPortfolioDrainLedger({ directory, lockOptions } = {}) {
  const root = requireDirectory(directory);
  if (!existsSync(root)) return snapshot([]);
  return withLedgerLock(root, () => snapshot(readRecordsUnlocked(root)), lockOptions);
}

function appendRecord(directory, record) {
  const path = portfolioDrainLedgerPath(directory);
  const line = `${canonicalJson(record)}\n`;
  appendFileSync(path, line, 'utf8');
  const descriptor = openSync(path, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function appendPortfolioDrainReceipt({
  directory, portfolio, receipt, expectedLedgerRevision, lockOptions,
}) {
  const root = requireDirectory(directory);
  requireRevision(expectedLedgerRevision, 'expectedLedgerRevision');
  verifyPortfolioDrainReceipt(receipt);
  return withLedgerLock(root, () => {
    const records = readRecordsUnlocked(root);
    const before = snapshot(records);
    if (before.revision !== expectedLedgerRevision) {
      throw new PortfolioDrainLedgerError(
        'LedgerCasMismatch', 'portfolio drain ledger changed since the caller observed it',
      );
    }
    const projection = reconcilePortfolioDrain({
      portfolio, receipts: [...before.receipts, receipt],
    });
    const projectedItem = projection.items.find(({ itemId }) => itemId === receipt.itemId);
    if (!projectedItem || projectedItem.drainState === 'RECONCILE_REQUIRED') {
      throw new PortfolioDrainLedgerError(
        'LedgerObservationDrift',
        'receipt observation is no longer exact; reconcile before recording another transition',
      );
    }
    const body = {
      type: 'portfolio-drain.receipt',
      schema: PORTFOLIO_DRAIN_LEDGER_RECORD_SCHEMA,
      ...PORTFOLIO_DRAIN_MACHINE,
      ordinal: records.length,
      previousRevision: records.at(-1)?.revision ?? null,
      receipt,
    };
    const record = deepFreeze({ ...body, revision: sha256(canonicalJson(body)) });
    appendRecord(root, record);
    return snapshot([...records, record]);
  }, lockOptions);
}

export function tickPortfolioDrain({ directory, portfolio, holds = [], capacity = 4, lockOptions }) {
  const ledger = readPortfolioDrainLedger({ directory, lockOptions });
  const projection = reconcilePortfolioDrain({
    portfolio, receipts: ledger.receipts, holds, capacity,
  });
  return deepFreeze({
    schema: 'gaia-portfolio-drain-tick/1',
    machine: PORTFOLIO_DRAIN_MACHINE,
    ledgerRevision: ledger.revision,
    projection,
    effect: 'NONE',
    authority: 'NONE',
  });
}
