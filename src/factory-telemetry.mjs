/**
 * factory-telemetry.mjs - the pure kernel of Gaia's passive factory telemetry spine.
 *
 * A sensor emits one of exactly seven bounded facts about a local run. This module binds each
 * fact to a closed, content-addressed record and replays an unordered set of them into one
 * deterministic projection. It performs no I/O, owns no credentials, launches nothing and
 * grants no authority: it only says what was already observed.
 *
 * Every field is a typed identity or a canonical token. There is deliberately no free-text
 * field anywhere in the record, so a prompt, a reasoning trace, a credential, a screen capture,
 * a source fragment or an arbitrary log line has no place to live even if a caller tries. Where
 * evidence is genuinely absent the record says `UNKNOWN` rather than inventing a value.
 *
 * Freshness is not decided here. Replay is a pure function of the event set, so the same events
 * always yield the same projection; whether a heartbeat is still fresh is a question about the
 * observer's clock and belongs to the read model that asks it.
 */

import { createHash } from 'node:crypto';

export const FACTORY_TELEMETRY_EVENT_SCHEMA = 'gaia-factory-telemetry-event/1';
export const FACTORY_TELEMETRY_PROJECTION_SCHEMA = 'gaia-factory-telemetry-projection/1';

/** The closed event set. Anything outside it fails closed rather than being ignored. */
export const FACTORY_TELEMETRY_EVENTS = Object.freeze([
  'run.started',
  'run.heartbeat',
  'gate.entered',
  'gate.passed',
  'gate.failed',
  'run.blocked',
  'run.completed',
]);

const GATE_EVENTS = Object.freeze(['gate.entered', 'gate.passed', 'gate.failed']);

/**
 * One run is a small explicit machine. `RUNNING` means started and outside any gate;
 * `IN_GATE` means exactly one named gate is open. Both terminal states admit nothing.
 */
const TRANSITIONS = Object.freeze({
  RUNNING: Object.freeze({
    'run.heartbeat': 'RUNNING',
    'gate.entered': 'IN_GATE',
    'run.blocked': 'BLOCKED',
    'run.completed': 'COMPLETED',
  }),
  IN_GATE: Object.freeze({
    'run.heartbeat': 'IN_GATE',
    'gate.passed': 'RUNNING',
    'gate.failed': 'RUNNING',
    'run.blocked': 'BLOCKED',
  }),
  BLOCKED: Object.freeze({}),
  COMPLETED: Object.freeze({}),
});

const ACTIVE_RUN_STATES = Object.freeze(['RUNNING', 'IN_GATE']);
const UNKNOWN = 'UNKNOWN';
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,63}$/u;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const TOKEN = /^[A-Z][A-Z0-9_]{0,31}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const ordinal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const EVENT_KEYS = Object.freeze([
  'agent', 'blocker', 'evidenceRevision', 'event', 'gate', 'itemId', 'itemNumber',
  'itemRevision', 'lane', 'machineId', 'machineVersion', 'observedAt', 'previousRevision',
  'repository', 'revision', 'rulesRevision', 'runId', 'schema', 'sequence',
].sort(ordinal));

export class FactoryTelemetryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FactoryTelemetryError';
    this.code = code;
  }
}

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

const MACHINE_RULES = {
  machineId: 'gaia.factory-telemetry',
  machineVersion: 1,
  events: FACTORY_TELEMETRY_EVENTS,
  gateEvents: GATE_EVENTS,
  transitions: TRANSITIONS,
  activeRunStates: ACTIVE_RUN_STATES,
  eventKeys: EVENT_KEYS,
};

/**
 * Exact interpreter identity recorded beside every durable event.
 *
 * A future rule change adds a new machine version and keeps this interpreter available for
 * replay. It must never silently reinterpret events written by a previous version.
 */
export const FACTORY_TELEMETRY_MACHINE = deepFreeze({
  machineId: MACHINE_RULES.machineId,
  machineVersion: MACHINE_RULES.machineVersion,
  rulesRevision: sha256(canonicalJson(MACHINE_RULES)),
});

function invalid(message) {
  return new FactoryTelemetryError('TelemetryEventInvalid', message);
}

function requireInstant(value, field) {
  if (typeof value !== 'string' || !INSTANT.test(value)
      || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    throw invalid(`${field} must be an exact UTC instant such as 2026-08-29T18:00:00.000Z`);
  }
  return value;
}

function requireEvidence(value, field) {
  if (value !== UNKNOWN && (typeof value !== 'string' || !REVISION.test(value))) {
    throw invalid(`${field} must be a lowercase SHA-256 or the honest sentinel UNKNOWN`);
  }
  return value;
}

function requireToken(value, field) {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw invalid(`${field} must be a canonical uppercase token`);
  }
  return value;
}

function requireSubject(subject) {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) {
    throw invalid('subject must be an object binding the observed item identity');
  }
  if (typeof subject.repository !== 'string' || !REPOSITORY.test(subject.repository)) {
    throw invalid('subject.repository must be owner/name');
  }
  if (typeof subject.itemId !== 'string' || !ITEM_ID.test(subject.itemId)) {
    throw invalid('subject.itemId must be a canonical identifier');
  }
  if (!Number.isSafeInteger(subject.itemNumber) || subject.itemNumber < 1) {
    throw invalid('subject.itemNumber must be a positive integer');
  }
  requireToken(subject.lane, 'subject.lane');
  requireToken(subject.agent, 'subject.agent');
  requireEvidence(subject.itemRevision, 'subject.itemRevision');
  return subject;
}

function requireClosedEventObject(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
      || Object.getPrototypeOf(event) !== Object.prototype) {
    throw invalid('telemetry event must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(event);
  const keys = Reflect.ownKeys(event);
  if (keys.some((key) => typeof key !== 'string')
      || keys.some((key) => !descriptors[key]?.enumerable
        || !Object.hasOwn(descriptors[key], 'value'))
      || canonicalJson([...keys].sort(ordinal)) !== canonicalJson(EVENT_KEYS)) {
    throw invalid('telemetry event must contain exactly the closed typed fields');
  }
}

function requireGateAndBlocker({ event, gate, blocker }) {
  if (GATE_EVENTS.includes(event)) requireToken(gate, 'gate');
  else if (gate !== null) throw invalid(`${event} must not carry a gate token`);
  if (event === 'run.blocked') requireToken(blocker, 'blocker');
  else if (blocker !== null) throw invalid(`${event} must not carry a blocker token`);
}

/**
 * Build one immutable telemetry event. Semantic transition validity is checked during replay,
 * where the whole run is available; this function binds identity and predecessor exactly.
 */
export function buildFactoryTelemetryEvent({
  runId, subject, previous = null, event, gate = null, blocker = null,
  observedAt, evidenceRevision = UNKNOWN,
}) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
    throw invalid('runId must be a canonical lowercase identifier of 8 to 64 characters');
  }
  requireSubject(subject);
  if (!FACTORY_TELEMETRY_EVENTS.includes(event)) {
    throw new FactoryTelemetryError(
      'TelemetryEventUnknown', `unsupported telemetry event ${String(event)}`,
    );
  }
  requireGateAndBlocker({ event, gate, blocker });
  requireInstant(observedAt, 'observedAt');
  requireEvidence(evidenceRevision, 'evidenceRevision');
  if (previous !== null) {
    verifyFactoryTelemetryEvent(previous);
    if (previous.runId !== runId) throw invalid('previous event must bind the same run');
    if (previous.repository !== subject.repository || previous.itemId !== subject.itemId
        || previous.itemNumber !== subject.itemNumber || previous.lane !== subject.lane
        || previous.agent !== subject.agent
        || previous.itemRevision !== subject.itemRevision) {
      throw invalid('previous event must bind the same observed subject');
    }
    if (Date.parse(observedAt) < Date.parse(previous.observedAt)) {
      throw invalid('observedAt must not precede the previous event in the same run');
    }
  }
  const body = {
    schema: FACTORY_TELEMETRY_EVENT_SCHEMA,
    ...FACTORY_TELEMETRY_MACHINE,
    runId,
    repository: subject.repository,
    itemId: subject.itemId,
    itemNumber: subject.itemNumber,
    lane: subject.lane,
    agent: subject.agent,
    itemRevision: subject.itemRevision,
    sequence: previous === null ? 0 : previous.sequence + 1,
    previousRevision: previous === null ? null : previous.revision,
    observedAt,
    event,
    gate,
    blocker,
    evidenceRevision,
  };
  return deepFreeze({ ...body, revision: sha256(canonicalJson(body)) });
}

export function verifyFactoryTelemetryEvent(event) {
  requireClosedEventObject(event);
  if (event.schema !== FACTORY_TELEMETRY_EVENT_SCHEMA) {
    throw invalid('unsupported telemetry event schema');
  }
  if (event.machineId !== FACTORY_TELEMETRY_MACHINE.machineId
      || event.machineVersion !== FACTORY_TELEMETRY_MACHINE.machineVersion
      || event.rulesRevision !== FACTORY_TELEMETRY_MACHINE.rulesRevision) {
    throw new FactoryTelemetryError(
      'TelemetryMachineUnsupported', 'event binds an unsupported telemetry interpreter',
    );
  }
  if (!FACTORY_TELEMETRY_EVENTS.includes(event.event)) {
    throw new FactoryTelemetryError(
      'TelemetryEventUnknown', `unsupported telemetry event ${String(event.event)}`,
    );
  }
  if (typeof event.runId !== 'string' || !RUN_ID.test(event.runId)) {
    throw invalid('event.runId must be a canonical identifier');
  }
  requireSubject(event);
  requireGateAndBlocker(event);
  requireInstant(event.observedAt, 'event.observedAt');
  requireEvidence(event.evidenceRevision, 'event.evidenceRevision');
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
    throw invalid('event.sequence must be a non-negative integer');
  }
  if (event.sequence === 0
    ? event.previousRevision !== null
    : typeof event.previousRevision !== 'string' || !REVISION.test(event.previousRevision)) {
    throw invalid('event.previousRevision must be null exactly at sequence 0');
  }
  const { revision, ...body } = event;
  if (typeof revision !== 'string' || !REVISION.test(revision)
      || sha256(canonicalJson(body)) !== revision) {
    throw invalid('event content does not match its revision');
  }
  return event;
}

function sameSubject(left, right) {
  return left.repository === right.repository && left.itemId === right.itemId
    && left.itemNumber === right.itemNumber && left.lane === right.lane
    && left.agent === right.agent && left.itemRevision === right.itemRevision;
}

function replayRun(runId, indexed) {
  const ordered = [...indexed.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, event]) => event);
  for (const [position, event] of ordered.entries()) {
    if (event.sequence !== position) {
      throw new FactoryTelemetryError(
        'TelemetrySequenceGap', `run ${runId} is missing sequence ${position}`,
      );
    }
  }
  const [first] = ordered;
  if (first.event !== 'run.started') {
    throw new FactoryTelemetryError(
      'TelemetryRunUnstarted', `run ${runId} does not begin with run.started`,
    );
  }

  let runState = 'RUNNING';
  let currentGate = null;
  let blocker = null;
  let previousRevision = first.revision;
  let previousObservedAt = Date.parse(first.observedAt);
  let lastHeartbeatAt = null;
  let lastTransition = {
    event: first.event,
    gate: first.gate,
    sequence: first.sequence,
    observedAt: first.observedAt,
    evidenceRevision: first.evidenceRevision,
  };
  const counts = { entered: 0, passed: 0, failed: 0, heartbeats: 0 };

  for (const event of ordered.slice(1)) {
    if (!sameSubject(event, first)) {
      throw new FactoryTelemetryError(
        'TelemetryIdentitySubstituted', `run ${runId} changed its observed subject`,
      );
    }
    if (event.previousRevision !== previousRevision) {
      throw new FactoryTelemetryError(
        'TelemetryChainBroken', `run ${runId} chain broke at sequence ${event.sequence}`,
      );
    }
    if (Date.parse(event.observedAt) < previousObservedAt) {
      throw new FactoryTelemetryError(
        'TelemetryTimestampReordered',
        `run ${runId} observed sequence ${event.sequence} before its predecessor`,
      );
    }
    const next = TRANSITIONS[runState][event.event];
    if (!next) {
      throw new FactoryTelemetryError(
        'TelemetryTransitionInvalid',
        `${event.event} cannot follow ${runState} in run ${runId}`,
      );
    }
    if (event.event === 'gate.entered') {
      currentGate = event.gate;
      counts.entered += 1;
    } else if (event.event === 'gate.passed' || event.event === 'gate.failed') {
      if (event.gate !== currentGate) {
        throw new FactoryTelemetryError(
          'TelemetryGateMismatch',
          `run ${runId} left gate ${event.gate} while ${currentGate} was open`,
        );
      }
      currentGate = null;
      counts[event.event === 'gate.passed' ? 'passed' : 'failed'] += 1;
    } else if (event.event === 'run.blocked') {
      blocker = event.blocker;
    }
    if (event.event === 'run.heartbeat') {
      counts.heartbeats += 1;
      lastHeartbeatAt = event.observedAt;
    } else {
      lastTransition = {
        event: event.event,
        gate: event.gate,
        sequence: event.sequence,
        observedAt: event.observedAt,
        evidenceRevision: event.evidenceRevision,
      };
    }
    runState = next;
    previousRevision = event.revision;
    previousObservedAt = Date.parse(event.observedAt);
  }

  const last = ordered.at(-1);
  return {
    runId,
    repository: first.repository,
    itemId: first.itemId,
    itemNumber: first.itemNumber,
    lane: first.lane,
    agent: first.agent,
    itemRevision: first.itemRevision,
    runState,
    currentGate,
    blocker,
    startedAt: first.observedAt,
    lastEventAt: last.observedAt,
    elapsedMs: Date.parse(last.observedAt) - Date.parse(first.observedAt),
    lastHeartbeatAt,
    lastTransition,
    gatesEntered: counts.entered,
    gatesPassed: counts.passed,
    gatesFailed: counts.failed,
    heartbeatCount: counts.heartbeats,
    eventCount: ordered.length,
  };
}

function selectRunPerItem(runs) {
  const byItem = new Map();
  for (const run of runs) {
    const existing = byItem.get(run.itemId) ?? [];
    existing.push(run);
    byItem.set(run.itemId, existing);
  }
  return [...byItem.entries()].sort(([left], [right]) => ordinal(left, right)).map(
    ([itemId, candidates]) => {
      const unfinished = candidates.filter(
        ({ runState }) => ACTIVE_RUN_STATES.includes(runState),
      );
      if (unfinished.length > 1) {
        throw new FactoryTelemetryError(
          'TelemetryItemAmbiguous',
          `item ${itemId} has ${unfinished.length} unfinished runs; reconcile before projecting`,
        );
      }
      const [selected] = unfinished.length === 1 ? unfinished : [...candidates].sort(
        (left, right) => Date.parse(right.lastEventAt) - Date.parse(left.lastEventAt)
          || ordinal(right.runId, left.runId),
      );
      return { itemId, runId: selected.runId };
    },
  );
}

/**
 * Replay an unordered, possibly duplicated set of telemetry events into one deterministic
 * projection. Exact duplicates are idempotent; every other anomaly fails closed.
 */
export function replayFactoryTelemetry({ events, notAfter = null }) {
  if (!Array.isArray(events)) {
    throw invalid('events must be an array of telemetry events');
  }
  if (notAfter !== null) requireInstant(notAfter, 'notAfter');
  const horizon = notAfter === null ? null : Date.parse(notAfter);

  const seen = new Set();
  const byRun = new Map();
  for (const candidate of events) {
    const event = verifyFactoryTelemetryEvent(candidate);
    if (horizon !== null && Date.parse(event.observedAt) > horizon) {
      throw new FactoryTelemetryError(
        'TelemetryTimestampFuture',
        `run ${event.runId} reports sequence ${event.sequence} after the observation instant`,
      );
    }
    // Duplicate delivery of the identical content-addressed fact changes nothing.
    if (seen.has(event.revision)) continue;
    seen.add(event.revision);
    const indexed = byRun.get(event.runId) ?? new Map();
    if (indexed.has(event.sequence)) {
      throw new FactoryTelemetryError(
        'TelemetrySequenceConflict',
        `run ${event.runId} has two different events at sequence ${event.sequence}`,
      );
    }
    indexed.set(event.sequence, event);
    byRun.set(event.runId, indexed);
  }

  const runs = [...byRun.entries()]
    .sort(([left], [right]) => ordinal(left, right))
    .map(([runId, indexed]) => replayRun(runId, indexed));
  const body = {
    schema: FACTORY_TELEMETRY_PROJECTION_SCHEMA,
    machine: FACTORY_TELEMETRY_MACHINE,
    effect: 'NONE',
    authority: 'NONE',
    runs,
    items: selectRunPerItem(runs),
    counts: {
      runs: runs.length,
      active: runs.filter(({ runState }) => ACTIVE_RUN_STATES.includes(runState)).length,
      blocked: runs.filter(({ runState }) => runState === 'BLOCKED').length,
      completed: runs.filter(({ runState }) => runState === 'COMPLETED').length,
    },
  };
  return deepFreeze({ ...body, revision: sha256(canonicalJson(body)) });
}
