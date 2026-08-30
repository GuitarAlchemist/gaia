/**
 * ci-flow-journal.mjs — the append-only evidence journal for closed CI observations, and the one
 * deterministic projection from it.
 *
 * THE COMMIT PROTOCOL
 * -------------------
 * lock -> re-read the whole journal -> decide -> one append of complete newline-terminated lines
 * -> fsync -> release. The lock is a DIRECTORY, because `mkdir` is the atomic primitive that
 * either succeeds for exactly one caller or throws. On Windows a contended release surfaces as
 * EPERM or EACCES rather than EEXIST, so all three mean "retry", never "give up" and never
 * "proceed". This is the protocol `factory-telemetry-log.mjs` already runs; it is mirrored rather
 * than re-invented, because a second lock protocol is a second set of races.
 *
 * IDEMPOTENCE, AND WHY IT IS NOT DE-DUPLICATION
 * --------------------------------------------
 * An observation already held under its identity, byte for byte, is absorbed: nothing is appended
 * and the projection does not move. An observation that CONFLICTS with one already held is
 * refused and named. Those are different rules and the difference is the whole point — picking a
 * winner between two records that disagree, by last write or by merging fields, would publish a
 * run that never happened, assembled from two readings of which at least one is wrong.
 *
 * THE PROJECTION IS ANALYTICAL READ STATE ONLY
 * --------------------------------------------
 * Nothing in this product reads the projection to decide anything, hold a state, or grant an
 * authority. It exists to be read by an analyst bench, and its shape is chosen for that: flat
 * rows, no nesting, explicit column order, integer milliseconds, exact ISO instants, and a
 * canonical key-sorted digest. Those five choices are aimed at the five things that actually
 * break determinism — insertion-ordered keys, locale-aware sorting, floating-point arithmetic,
 * timezone-rendered dates, and a clock read inside the derivation. This module holds no clock.
 *
 * The pump therefore has no analytical-store call site at all. That is a stronger property than a
 * degradation path around one, because there is nothing to be unavailable rather than a promise
 * that unavailability was handled.
 */

import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  LOCK_RM_OPTIONS, LOCK_STALE_MS, LOCK_TIMEOUT_MS, LockTimeoutError,
} from './event-log.mjs';
import { canonicalJson } from './epistemic-research.mjs';
import {
  CI_FLOW_COMPARABLE_CONCLUSIONS,
  ciFlowObservationIdentity,
  deriveCiFlowObservationMeasures,
  requireCiFlowObservation,
} from './ci-flow.mjs';

export const CI_FLOW_JOURNAL_RECORD_SCHEMA = 'gaia-ci-flow-journal-record/1';
export const CI_FLOW_PROJECTION_SCHEMA = 'gaia-ci-flow-projection/1';

/**
 * The projected relation, column by column, in the one order every row is emitted in.
 *
 * Every measured quantity is paired with the reason it is absent when it is absent, so the
 * relation carries the same distinction the block does: an empty cell here is never a zero, and a
 * reader querying `queueLatencyMs IS NULL` can tell "the provider does not expose it" from "this
 * was a re-run carrying only the original creation instant" without leaving the row.
 */
export const CI_FLOW_PROJECTION_COLUMNS = Object.freeze([
  'identity', 'provider', 'repositoryId', 'repository', 'workflow', 'runId', 'attempt',
  'sha', 'branch', 'pullRequest', 'pullRequestBinding', 'trigger',
  'enqueueBasis', 'enqueuedAt', 'runnerAcquiredAt', 'startedAt', 'completedAt',
  'conclusion', 'complete', 'comparable', 'billableMs',
  'executionMs', 'executionReason',
  'queueLatencyMs', 'queueLatencyReason',
  'runnerStartupMs', 'runnerStartupReason',
  'setupMs', 'setupReason',
  'checkCount', 'dependencyCount',
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export class CiFlowJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CiFlowJournalError';
    this.code = code;
  }
}

function requireDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new CiFlowJournalError('JournalRequestInvalid', 'a journal directory is required');
  }
  return directory;
}

export function ciFlowJournalPath(directory) {
  return join(requireDirectory(directory), 'ci-flow.jsonl');
}

export function ciFlowJournalLockPath(directory) {
  return join(requireDirectory(directory), 'ci-flow.lock');
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withJournalLock(directory, operation, {
  timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS,
} = {}) {
  const root = requireDirectory(directory);
  const lock = ciFlowJournalLockPath(root);
  mkdirSync(root, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let held = false;
  while (!held) {
    try {
      mkdirSync(lock);
      held = true;
    } catch (error) {
      // EEXIST is the ordinary "someone else holds it"; EPERM and EACCES are the Windows faces of
      // the same condition, raised when the holder is inside its own release.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          `could not acquire ${lock} within ${timeoutMs}ms; refusing to touch the CI flow journal`
          + ` without its lock (fail closed; stale threshold ${staleMs}ms)`,
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

/**
 * One journal record: the sealed observation, its identity, its position, and a digest over all of
 * them. The ordinal is carried so a reader can tell a short journal from a reordered one.
 */
function buildRecord(observation, ordinal) {
  const body = {
    type: 'ci-flow.observation',
    schema: CI_FLOW_JOURNAL_RECORD_SCHEMA,
    ordinal,
    identity: ciFlowObservationIdentity(observation),
    observation,
  };
  return { ...body, revision: sha256(canonicalJson(body)) };
}

function verifyRecord(record, expectedOrdinal) {
  const corrupt = (message) => {
    throw new CiFlowJournalError('CorruptCiFlowJournal', message);
  };
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.type !== 'ci-flow.observation'
      || record.schema !== CI_FLOW_JOURNAL_RECORD_SCHEMA) {
    corrupt('the CI flow journal contains an unsupported record');
  }
  const { revision, ...body } = record;
  if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/u.test(revision)
      || revision !== sha256(canonicalJson(body))) {
    corrupt('a CI flow journal record revision does not match its content');
  }
  if (record.ordinal !== expectedOrdinal) {
    corrupt(`a CI flow journal record is out of position at ordinal ${expectedOrdinal}`);
  }
  let observation;
  try {
    observation = requireCiFlowObservation(record.observation);
  } catch (error) {
    corrupt(`a CI flow journal record carries an unusable observation: ${error.message}`);
  }
  if (record.identity !== ciFlowObservationIdentity(observation)) {
    corrupt('a CI flow journal record names an identity its observation does not have');
  }
  return record;
}

function readRecordsUnlocked(directory) {
  let text;
  try {
    text = readFileSync(ciFlowJournalPath(directory), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = text.split('\n');
  // A trailing newline is the commit protocol working. Anything after it is a torn write.
  // It is refused below rather than discarded, because a partial line is missing evidence.
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines.map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CiFlowJournalError(
        'CorruptCiFlowJournal', `CI flow journal line ${index + 1} is not a JSON document`,
      );
    }
    return verifyRecord(parsed, index);
  });
}

export function readCiFlowJournal({ directory, lockOptions } = {}) {
  const root = requireDirectory(directory);
  return withJournalLock(root, () => readRecordsUnlocked(root), lockOptions);
}

/**
 * Append one closed observation, idempotently by its immutable identity.
 *
 * The observation is verified BEFORE the identity is consulted. That ordering is the gate: because
 * the first write under an identity is final, checking admissibility afterwards would let a
 * cut-short read be cemented by the very mechanism that protects against redelivery.
 */
export function appendCiFlowObservation({ directory, observation, lockOptions } = {}) {
  const root = requireDirectory(directory);
  const verified = requireCiFlowObservation(observation);
  const identity = ciFlowObservationIdentity(verified);

  return withJournalLock(root, () => {
    const records = readRecordsUnlocked(root);
    const held = records.find((record) => record.identity === identity);
    if (held !== undefined) {
      if (canonicalJson(held.observation) === canonicalJson(verified)) {
        return {
          appended: false,
          duplicate: true,
          identity,
          ordinal: held.ordinal,
          recordRevision: held.revision,
        };
      }
      // Both readings stay in the journal, because it is append-only and cannot do otherwise.
      // Neither is promoted: one of them is wrong, and choosing between them would publish a run
      // assembled from a reading nobody can defend.
      throw new CiFlowJournalError(
        'ConflictingObservation',
        `a different observation is already held for run ${JSON.stringify(verified.runId)} attempt`
        + ` ${verified.attempt} of ${verified.repository}; an append-only journal refuses to`
        + ' choose between two readings that disagree',
      );
    }
    const record = buildRecord(verified, records.length);
    const path = ciFlowJournalPath(root);
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    const handle = openSync(path, 'r+');
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    return {
      appended: true,
      duplicate: false,
      identity,
      ordinal: record.ordinal,
      recordRevision: record.revision,
    };
  }, lockOptions);
}

/** Ordinal comparison, so two hosts with different ICU versions agree about "sorted". */
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const cellValue = (cell) => (cell.state === 'MEASURED' ? cell.value : null);
const cellReason = (cell) => (cell.state === 'MEASURED' ? null : cell.reasonCode);

/**
 * One observation as one flat row, built key by key in the published column order.
 *
 * Explicit construction rather than a spread, because object key order is what a reader's digest
 * is taken over, and a spread would make it depend on how the source object happened to be built.
 */
function projectRow(observation) {
  const measures = deriveCiFlowObservationMeasures(observation);
  return {
    identity: ciFlowObservationIdentity(observation),
    provider: observation.provider,
    repositoryId: observation.repositoryId,
    repository: observation.repository,
    workflow: observation.workflow,
    runId: observation.runId,
    attempt: observation.attempt,
    sha: observation.sha,
    branch: observation.branch,
    pullRequest: observation.pullRequest,
    pullRequestBinding: observation.pullRequest === null ? 'PR_NOT_PROVEN' : 'PROVEN',
    trigger: observation.trigger,
    enqueueBasis: observation.enqueueBasis,
    enqueuedAt: observation.enqueuedAt,
    runnerAcquiredAt: observation.runnerAcquiredAt,
    startedAt: observation.startedAt,
    completedAt: observation.completedAt,
    conclusion: observation.conclusion,
    complete: observation.complete,
    comparable: observation.complete
      && CI_FLOW_COMPARABLE_CONCLUSIONS.includes(observation.conclusion),
    billableMs: observation.billableMs,
    executionMs: cellValue(measures.executionMs),
    executionReason: cellReason(measures.executionMs),
    queueLatencyMs: cellValue(measures.queueLatencyMs),
    queueLatencyReason: cellReason(measures.queueLatencyMs),
    runnerStartupMs: cellValue(measures.runnerStartupMs),
    runnerStartupReason: cellReason(measures.runnerStartupMs),
    setupMs: cellValue(measures.setupMs),
    setupReason: cellReason(measures.setupMs),
    checkCount: observation.checks.length,
    dependencyCount: observation.dependencies === null ? null : observation.dependencies.length,
  };
}

/**
 * The projection: a pure function of the record set, sorted by identity rather than by arrival.
 *
 * Sorting by identity is what makes arrival order irrelevant. A fold over arrival order would let
 * a late attempt 1 displace attempt 3's terminal state, flipping a run from success back to
 * failure a week after it closed.
 */
export function projectCiFlowJournal(records) {
  if (!Array.isArray(records)) {
    throw new CiFlowJournalError('JournalRequestInvalid', 'a record array is required');
  }
  const rows = records
    .map((record) => projectRow(record.observation))
    .sort((left, right) => ordinal(left.identity, right.identity));
  const body = {
    schema: CI_FLOW_PROJECTION_SCHEMA,
    columns: [...CI_FLOW_PROJECTION_COLUMNS],
    rows,
  };
  return Object.freeze({ ...body, revision: sha256(canonicalJson(body)) });
}

/** Read the journal and project it. Replaying reproduces the projection exactly, by construction. */
export function replayCiFlowJournal({ directory, lockOptions } = {}) {
  return projectCiFlowJournal(readCiFlowJournal({ directory, lockOptions }));
}

/**
 * The projection as newline-delimited JSON, one row per line, keys in column order.
 *
 * An analyst bench ingests this directly. Nothing in this product reads it back.
 */
export function renderCiFlowProjection(projection) {
  return projection.rows.map((row) => JSON.stringify(row)).map((line) => `${line}\n`).join('');
}
