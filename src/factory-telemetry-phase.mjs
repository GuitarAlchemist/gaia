/**
 * factory-telemetry-phase.mjs - the generic file-backed phase sensor for the telemetry spine.
 *
 * R0 could only record a whole run inside one process, so the durable log never held a live
 * run and no separately invoked dashboard could ever observe one moving. This seam is the
 * smallest thing that fixes that: it accepts exactly one closed lifecycle fact and returns.
 * The run stays open on disk between calls, which is what lets an independent reader see it
 * as ACTIVE, then watch its heartbeat expire, then see it settle.
 *
 * There are exactly seven phases because there are exactly seven telemetry event kinds, and
 * the map between them is a bijection. This module adds no event kind, no field and no
 * schema; it is a caller-facing name for facts the kernel already defines.
 *
 * The only argument bound to a run is its identity, and only once. After `start`, the subject
 * is read back out of the durable log rather than re-supplied, so a later sensor invocation
 * cannot quietly rebind the run to another item, lane or agent; passing a disagreeing subject
 * is a refusal, not a correction.
 *
 * It is passive by construction. Nothing here spawns a process, calls a provider, inspects a
 * prompt, reads a screen, polls for liveness or grants authority. It writes one fact that the
 * caller asserted has already happened, or it refuses.
 */

import {
  appendFactoryTelemetryEvent,
  readFactoryTelemetryLog,
} from './factory-telemetry-log.mjs';
import {
  buildFactoryTelemetryEvent,
  replayFactoryTelemetry,
} from './factory-telemetry.mjs';

export const FACTORY_TELEMETRY_PHASE_RECEIPT_SCHEMA = 'gaia-factory-telemetry-phase-receipt/1';

/** The closed phase vocabulary, one name per existing event kind. Nothing else is accepted. */
export const FACTORY_TELEMETRY_PHASES = Object.freeze({
  start: 'run.started',
  heartbeat: 'run.heartbeat',
  'gate-entered': 'gate.entered',
  'gate-passed': 'gate.passed',
  'gate-failed': 'gate.failed',
  finish: 'run.completed',
  block: 'run.blocked',
});

const SUBJECT_KEYS = Object.freeze([
  'repository', 'itemId', 'itemNumber', 'lane', 'agent', 'itemRevision',
]);

export class FactoryTelemetryPhaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FactoryTelemetryPhaseError';
    this.code = code;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const subjectOf = (event) => Object.fromEntries(SUBJECT_KEYS.map((key) => [key, event[key]]));

function sameSubject(left, right) {
  return SUBJECT_KEYS.every((key) => left[key] === right[key]);
}

/**
 * Content address of the event this request would have produced against the head's own
 * predecessor, or null when the request is not expressible at all. Used only to recognise an
 * exact re-delivery; it builds nothing durable.
 */
function rebuild({ runId, ordered, event, gate, blocker, observedAt, evidenceRevision }) {
  const head = ordered.at(-1);
  try {
    return buildFactoryTelemetryEvent({
      runId,
      subject: subjectOf(head),
      previous: ordered.length > 1 ? ordered.at(-2) : null,
      event,
      gate,
      blocker,
      observedAt,
      evidenceRevision,
    }).revision;
  } catch {
    return null;
  }
}

function phaseReceipt({ runId, phase, event, record, log, duplicate, observedAt }) {
  const run = replayFactoryTelemetry({ events: log.events, notAfter: observedAt })
    .runs.find((candidate) => candidate.runId === runId);
  return deepFreeze({
    schema: FACTORY_TELEMETRY_PHASE_RECEIPT_SCHEMA,
    runId,
    phase,
    event,
    sequence: record.sequence,
    observedAt,
    subject: subjectOf(record),
    eventRevision: record.revision,
    logRevision: log.revision,
    duplicate,
    runState: run.runState,
    currentGate: run.currentGate,
    blocker: run.blocker,
    // The one durable effect is this append, and only when it actually happened.
    effect: duplicate ? 'NONE' : 'LOCAL_TELEMETRY_APPEND',
    authority: 'NONE',
  });
}

/**
 * Record one phase of one run against the durable append-only log, then return.
 *
 * `subject` is required exactly at `start` and is otherwise recovered from the log. Every
 * divergence - an unknown phase, an unstarted or already started run, a rebound subject, an
 * impossible transition, a lost update, an unavailable lock - fails closed and writes nothing.
 */
export function recordFactoryTelemetryPhase({
  directory,
  runId,
  phase,
  subject = null,
  gate = null,
  blocker = null,
  evidenceRevision = 'UNKNOWN',
  now = () => new Date(),
  lockOptions,
}) {
  const event = Object.hasOwn(FACTORY_TELEMETRY_PHASES, phase)
    ? FACTORY_TELEMETRY_PHASES[phase] : null;
  if (event === null) {
    throw new FactoryTelemetryPhaseError(
      'PhaseUnknown',
      `unsupported telemetry phase ${String(phase)}; expected one of `
      + `${Object.keys(FACTORY_TELEMETRY_PHASES).join(', ')}`,
    );
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new FactoryTelemetryPhaseError('PhaseRequestInvalid', 'runId must be explicit');
  }
  if (typeof now !== 'function') {
    throw new FactoryTelemetryPhaseError('PhaseRequestInvalid', 'now must be a function');
  }

  const log = readFactoryTelemetryLog({ directory, lockOptions });
  const ordered = log.events
    .filter((candidate) => candidate.runId === runId)
    .sort((left, right) => left.sequence - right.sequence);
  const previous = ordered.at(-1) ?? null;
  const observedAt = now().toISOString();

  // A sensor that crashed between the append and its own acknowledgement retries the same
  // fact. Rebuild the log head against its own predecessor: identical content means this
  // call has already been recorded, so it is a no-op rather than a second observation.
  if (previous !== null
      && rebuild({ runId, ordered, event, gate, blocker, observedAt, evidenceRevision })
        === previous.revision) {
    return phaseReceipt({
      runId, phase, event, record: previous, log, duplicate: true, observedAt,
    });
  }

  let bound;
  if (phase === 'start') {
    if (previous !== null) {
      throw new FactoryTelemetryPhaseError(
        'PhaseRunAlreadyStarted', `run ${runId} is already recorded; start a new run instead`,
      );
    }
    if (subject === null) {
      throw new FactoryTelemetryPhaseError(
        'PhaseSubjectRequired', 'start must bind the observed subject exactly once',
      );
    }
    bound = subject;
  } else {
    if (previous === null) {
      throw new FactoryTelemetryPhaseError(
        'PhaseRunUnstarted', `run ${runId} has no recorded start; record start first`,
      );
    }
    bound = subjectOf(previous);
    // A later phase may restate the identity, but it may never change it.
    if (subject !== null && !sameSubject(subject, bound)) {
      throw new FactoryTelemetryPhaseError(
        'PhaseSubjectSubstituted', `run ${runId} is already bound to another observed subject`,
      );
    }
  }

  const record = buildFactoryTelemetryEvent({
    runId, subject: bound, previous, event, gate, blocker, observedAt, evidenceRevision,
  });
  const appended = appendFactoryTelemetryEvent({
    directory, event: record, expectedLogRevision: log.revision, notAfter: observedAt, lockOptions,
  });
  return phaseReceipt({
    runId, phase, event, record, log: appended.log, duplicate: appended.duplicate, observedAt,
  });
}
