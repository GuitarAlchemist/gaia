/**
 * Read-only durable bus evidence plus one internal idempotent send operation.
 *
 * This module adds no bus verb. `commitSendIfAbsent` executes the existing pure
 * `send` transition under the existing event-log lock, after replaying the exact
 * durable log. Its only idempotency key is the caller-supplied correlation id.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { classifyAuthority, commit, replay } from './bus-core.mjs';
import {
  BUS_EVIDENCE_CURSOR_SCHEMA,
  isBusEvidenceCursor,
} from './bus-evidence-contract.mjs';
import {
  refuse,
} from './continuity-contract.mjs';
import {
  appendEvents,
  BusInstanceMetadataError,
  flushFileAndPublication,
  logPath,
  parseEventLog,
  readBusInstanceMetadata,
  withLock,
} from './event-log.mjs';

export { busMetadataPath } from './event-log.mjs';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

export class BusEvidenceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BusEvidenceError';
    this.code = code;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function mapMetadataError(error) {
  if (!(error instanceof BusInstanceMetadataError)) throw error;
  const code = error.code === 'GAIA_BUS_INSTANCE_MISSING'
    ? 'BUS_INSTANCE_MISSING'
    : 'BUS_INSTANCE_CORRUPT';
  throw new BusEvidenceError(error.message, code);
}

function readMetadata({ createIfEmpty = false, migrateLegacy = false } = {}) {
  try {
    return readBusInstanceMetadata({ createIfEmpty, migrateLegacy });
  } catch (error) {
    return mapMetadataError(error);
  }
}

function decodeAndParse(raw, source = logPath()) {
  let text;
  try {
    text = UTF8.decode(raw);
  } catch (error) {
    throw new BusEvidenceError(`${source}: event log is not valid UTF-8 (${error.message})`, 'BUS_LOG_CORRUPT');
  }
  try {
    return parseEventLog(text, { source });
  } catch (error) {
    throw new BusEvidenceError(error.message, 'BUS_LOG_CORRUPT');
  }
}

function readRawAndEvents() {
  const path = logPath();
  const raw = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  return { raw, events: decodeAndParse(raw, path) };
}

function finalLineBytes(raw) {
  if (raw.length === 0) return null;
  const previousNewline = raw.lastIndexOf(0x0a, raw.length - 2);
  return raw.subarray(previousNewline + 1);
}

function makeCursor(instanceId, raw, events) {
  const finalLine = finalLineBytes(raw);
  return Object.freeze({
    schema: BUS_EVIDENCE_CURSOR_SCHEMA,
    instanceId,
    recordCount: events.length,
    byteOffset: raw.length,
    finalEventIdentity: finalLine === null ? null : sha256(finalLine),
    prefixSha256: sha256(raw),
  });
}

function assertCursorShape(cursor) {
  if (!isBusEvidenceCursor(cursor)) {
    throw new BusEvidenceError('invalid bus evidence cursor shape', 'BUS_CURSOR_INVALID');
  }
}

function captureUnlocked({ createIfEmpty = false, migrateLegacy = false } = {}) {
  const metadata = readMetadata({ createIfEmpty, migrateLegacy });
  const { raw, events } = readRawAndEvents();
  return makeCursor(metadata.instanceId, raw, events);
}

export function captureBusCursor(lockOptions) {
  return withLock(() => captureUnlocked({ createIfEmpty: true }), lockOptions);
}

function captureContinuityBusCursor(lockOptions) {
  return withLock(
    () => captureUnlocked({ createIfEmpty: true, migrateLegacy: true }),
    lockOptions,
  );
}

function countRecords(prefix) {
  let count = 0;
  for (const byte of prefix) if (byte === 0x0a) count += 1;
  return count;
}

function validateUnlocked(cursor, snapshot = null) {
    const metadata = snapshot?.metadata ?? readMetadata();
    if (metadata.instanceId !== cursor.instanceId) {
      throw new BusEvidenceError(
        `bus instance ${metadata.instanceId} does not match checkpoint ${cursor.instanceId}`,
        'BUS_INSTANCE_MISMATCH',
      );
    }

    const path = logPath();
    const raw = snapshot?.raw ?? (existsSync(path) ? readFileSync(path) : Buffer.alloc(0));
    if (raw.length < cursor.byteOffset) {
      throw new BusEvidenceError(
        `${path}: ${raw.length} bytes is shorter than checkpoint offset ${cursor.byteOffset}`,
        'BUS_LOG_TRUNCATED',
      );
    }

    // Validate the full current log as well as the checkpoint prefix. A good prefix
    // followed by a torn or corrupt append is not stable evidence.
    const currentEvents = snapshot?.events ?? decodeAndParse(raw, path);
    const prefix = raw.subarray(0, cursor.byteOffset);
    if (sha256(prefix) !== cursor.prefixSha256) {
      throw new BusEvidenceError(`${path}: checkpoint prefix digest mismatch`, 'BUS_PREFIX_MISMATCH');
    }
    const prefixRecordCount = countRecords(prefix);
    if (prefixRecordCount !== cursor.recordCount) {
      throw new BusEvidenceError(
        `${path}: checkpoint record count ${prefixRecordCount} does not match ${cursor.recordCount}`,
        'BUS_CURSOR_MISMATCH',
      );
    }
    const finalLine = finalLineBytes(prefix);
    const finalIdentity = finalLine === null ? null : sha256(finalLine);
    if (finalIdentity !== cursor.finalEventIdentity) {
      throw new BusEvidenceError(`${path}: checkpoint final event identity mismatch`, 'BUS_CURSOR_MISMATCH');
    }

    return Object.freeze({
      checkpoint: cursor,
      current: makeCursor(metadata.instanceId, raw, currentEvents),
      currentEvents,
    });
}

export function validateBusCursor(cursor, lockOptions) {
  assertCursorShape(cursor);
  return withLock(() => {
    const { currentEvents: _events, ...evidence } = validateUnlocked(cursor);
    return Object.freeze(evidence);
  }, lockOptions);
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function addressMatches(value, ref, name) {
  return typeof value === 'string' && [ref, name].includes(value.trim());
}

function sameSendSemantics(existing, command) {
  const message = existing?.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const requested = Array.isArray(command.requestedAuthority) ? command.requestedAuthority : [];
  if (!requested.every((item) => typeof item === 'string' && item.trim().length > 0)) return false;
  const authority = classifyAuthority(requested);
  const replyMatches = command.replyTo == null || (typeof command.replyTo === 'string' && command.replyTo.trim().length === 0)
    ? message.replyTo === message.from
    : addressMatches(command.replyTo, message.replyTo, message.replyToName);
  const kind = typeof command.kind === 'string' && command.kind.trim().length > 0
    ? command.kind.trim()
    : 'note';
  return command.at === message.sentAt
    && addressMatches(command.from, message.from, message.fromName)
    && addressMatches(command.to, message.to, message.toName)
    && replyMatches
    && command.text === message.text
    && kind === message.kind
    && Boolean(command.expectsReply) === message.expectsReply
    && command.correlationId.trim() === message.correlationId
    && sameArray(authority.granted, message.authority?.granted)
    && sameArray(authority.denied, message.authority?.denied);
}

export function commitSendIfAbsent(command, lockOptions) {
  if (!command || command.type !== 'send') {
    throw new BusEvidenceError('commitSendIfAbsent requires the existing send command', 'BUS_SEND_REFUSED');
  }
  if (typeof command.correlationId !== 'string' || command.correlationId.trim().length === 0) {
    throw new BusEvidenceError('commitSendIfAbsent requires an explicit deterministic correlationId', 'BUS_SEND_REFUSED');
  }

  return withLock(() => {
    const metadata = readMetadata({ createIfEmpty: true });
    const { raw: existingRaw, events: existing } = readRawAndEvents();
    let state;
    try {
      state = replay(existing);
    } catch (error) {
      throw new BusEvidenceError(`event log replay failed (${error.message})`, 'BUS_LOG_CORRUPT');
    }

    const correlationId = command.correlationId.trim();
    let match = null;
    for (const record of existing) {
      if (record.type !== 'message.sent' || record.message?.correlationId !== correlationId) continue;
      if (match !== null) {
        throw new BusEvidenceError(
          `correlation ${correlationId} has multiple durable message records`,
          'BUS_DUPLICATE_SEND',
        );
      }
      match = record;
    }
    if (match !== null) {
      if (!sameSendSemantics(match, command)) {
        throw new BusEvidenceError(
          `correlation ${correlationId} is already bound to different send semantics`,
          'BUS_CORRELATION_CONFLICT',
        );
      }
      flushFileAndPublication(logPath());
      return Object.freeze({
        status: 'EXISTING',
        record: match,
        cursor: makeCursor(metadata.instanceId, existingRaw, existing),
      });
    }

    const outcome = commit(state, command);
    if (outcome.error) {
      throw new BusEvidenceError(`send transition refused: ${outcome.error}`, 'BUS_SEND_REFUSED');
    }
    const expected = outcome.events.find((event) => event.type === 'message.sent');
    if (!expected) {
      throw new BusEvidenceError('send transition returned no message.sent event', 'BUS_SEND_REFUSED');
    }

    // The existing transition remains the sole owner of address, authority, text,
    // correlation, counter and message-shape validation. Append exactly its events.
    appendEvents(outcome.events);
    const { raw, events } = readRawAndEvents();
    return Object.freeze({
      status: 'APPENDED',
      record: expected,
      cursor: makeCursor(metadata.instanceId, raw, events),
    });
  }, lockOptions);
}

function requireSendCommand(command) {
  if (!command || command.type !== 'send') {
    throw new BusEvidenceError('wake evidence port requires the existing send command', 'BUS_SEND_REFUSED');
  }
  if (typeof command.correlationId !== 'string' || command.correlationId.trim().length === 0) {
    throw new BusEvidenceError('wake evidence port requires an explicit deterministic correlationId', 'BUS_SEND_REFUSED');
  }
}

function expectedSendRecord(events, command) {
  let state;
  try {
    state = replay(events);
  } catch (error) {
    throw new BusEvidenceError(`event log replay failed (${error.message})`, 'BUS_LOG_CORRUPT');
  }
  const outcome = commit(state, command);
  if (outcome.error) {
    throw new BusEvidenceError(`send transition refused: ${outcome.error}`, 'BUS_SEND_REFUSED');
  }
  const record = outcome.events.find(event => event.type === 'message.sent');
  if (!record) throw new BusEvidenceError('send transition returned no message.sent event', 'BUS_SEND_REFUSED');
  return { outcome, record };
}

/**
 * Validate one checkpoint, send iff absent, and reconcile exact evidence under
 * one lock and one full-log parse.
 */
export function commitAndReconcileFromCursor({ checkpoint, command }, lockOptions, durabilityOptions) {
  assertCursorShape(checkpoint);
  requireSendCommand(command);
  return withLock(() => {
    const metadata = readMetadata();
    const { raw, events } = readRawAndEvents();
    validateUnlocked(checkpoint, { metadata, raw, events });

    const correlationId = command.correlationId.trim();
    const matchingIndexes = [];
    for (let index = checkpoint.recordCount; index < events.length; index += 1) {
      const record = events[index];
      if (record.type === 'message.sent' && record.message?.correlationId === correlationId) {
        matchingIndexes.push(index);
      }
    }
    if (matchingIndexes.length > 1) {
      throw new BusEvidenceError('multiple matching post-checkpoint send records', 'BUS_DUPLICATE_SEND');
    }

    if (matchingIndexes.length === 1) {
      const index = matchingIndexes[0];
      const expected = expectedSendRecord(events.slice(0, index), command).record;
      const record = events[index];
      if (JSON.stringify(record) !== JSON.stringify(expected)) {
        throw new BusEvidenceError('post-checkpoint send record conflicts with expected evidence', 'BUS_CORRELATION_CONFLICT');
      }
      // A prior append may have become visible before its fsync failed. Exact retry
      // repeats both the file and publication barriers before accepting it.
      flushFileAndPublication(logPath(), durabilityOptions);
      return Object.freeze({
        status: 'EXISTING',
        record,
        cursor: makeCursor(metadata.instanceId, raw, events),
      });
    }

    if (events.slice(0, checkpoint.recordCount).some(record =>
      record.type === 'message.sent' && record.message?.correlationId === correlationId)) {
      throw new BusEvidenceError('matching send predates the durable checkpoint', 'BUS_CORRELATION_CONFLICT');
    }

    const { outcome, record } = expectedSendRecord(events, command);
    appendEvents(outcome.events, durabilityOptions);
    const appended = Buffer.from(`${outcome.events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    const postRaw = Buffer.concat([raw, appended]);
    return Object.freeze({
      status: 'APPENDED',
      record,
      cursor: makeCursor(metadata.instanceId, postRaw, [...events, ...outcome.events]),
    });
  }, lockOptions);
}

export function reconcileSendFromCursor(cursor, expectedRecord, lockOptions) {
  assertCursorShape(cursor);
  if (!expectedRecord || expectedRecord.type !== 'message.sent'
    || typeof expectedRecord.message?.correlationId !== 'string') {
    throw new BusEvidenceError('reconciliation requires an exact message.sent record', 'BUS_RECONCILIATION_INVALID');
  }
  return withLock(() => {
    const validated = validateUnlocked(cursor);
    let match = null;
    for (let index = cursor.recordCount; index < validated.currentEvents.length; index += 1) {
      const record = validated.currentEvents[index];
      if (record.type !== 'message.sent'
        || record.message?.correlationId !== expectedRecord.message.correlationId) continue;
      if (match !== null) {
        throw new BusEvidenceError('multiple matching post-checkpoint send records', 'BUS_DUPLICATE_SEND');
      }
      match = record;
    }
    if (match === null) {
      throw new BusEvidenceError('no matching post-checkpoint send record', 'BUS_SEND_MISSING');
    }
    if (JSON.stringify(match) !== JSON.stringify(expectedRecord)) {
      throw new BusEvidenceError('post-checkpoint send record conflicts with expected evidence', 'BUS_CORRELATION_CONFLICT');
    }
    return Object.freeze({
      record: match,
      cursor: validated.current,
    });
  }, lockOptions);
}

export function createWakeEvidencePort() {
  return Object.freeze({
    captureCheckpoint() {
      // Explicit one-time migration is continuity-owned; ordinary bus writes stay
      // compatible with pre-sidecar logs.
      return captureContinuityBusCursor();
    },
    commitAndReconcile({ checkpoint, command }) {
      return commitAndReconcileFromCursor({ checkpoint, command });
    },
  });
}

export function createContinuityBusAdapter({ controller }) {
  if (!controller || typeof controller.deliverWake !== 'function') refuse('INVALID_REQUEST');
  return Object.freeze({ deliver: input => controller.deliverWake(input) });
}
