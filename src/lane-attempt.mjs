/**
 * Lane-attempt decisions (#180): a per-attempt deadline, a heartbeat timeout and a compensation
 * record, decided over the lane lifecycle net that already ships (`LANE_NET_TEMPLATE` in
 * `src/drain-petri-net.mjs`). docs/lane-attempt-decisions.md is the decision table.
 *
 * Two calls decide one running attempt. Each returns one of five decisions:
 *   - `CONTINUE`: nothing is due yet;
 *   - `COMPLETE`: the completion marker arrived first;
 *   - `DEADLINE_EXCEEDED`: the attempt's deadline came first;
 *   - `HEARTBEAT_TIMEOUT`: the heartbeat went quiet for the timeout first;
 *   - `ABORTED`: an abort order came first.
 *
 * `decideLaneAttempt({ attempt, observation, now })` reads a snapshot: the last heartbeat, and when
 * a marker and an abort order were first seen. `replayLaneAttempt({ attempt, events, now })` reads
 * the attempt's event log and decides at every event before folding it in, so a timeout that
 * expired between two heartbeats is not erased by the later one.
 *
 * WHICH EVENT DECIDES
 * -------------------
 * Each terminal decision has an instant: the marker's, the abort order's, the deadline, and the
 * last heartbeat (or the start, before any heartbeat) plus the timeout. Among the instants at or
 * before `now`, the earliest decides; boundaries are inclusive. Equal instants resolve in
 * `LANE_ATTEMPT_PRECEDENCE` order, failures before completion, so a marker written at the deadline
 * instant does not complete the attempt. For one snapshot, asking later gives the same decision
 * once every instant is past. For one event log, replay gives the same terminal decision at every
 * `now` from the instant it fell due, however rarely the caller asks, as long as no event lands
 * later with an earlier instant. The bus stamps an event before it takes the log lock, so one can:
 * the caller persists the first terminal decision it acts on and never derives it again.
 *
 * A heartbeat or an abort order observed before the attempt's start counts at the start, so clock
 * skew between the lane and the coordinator never blocks the deadline. A marker observed before
 * the start was left by an earlier attempt: it never completes this one, and the decision reports
 * it as `staleMarkerAt`. An instant after `now` is refused: read the observation first, then take
 * `now`.
 *
 * WHAT THE NET CAN CARRY
 * ----------------------
 * In the shipped net an attempt leaves `L_ATTEMPT_RUNNING` only through an observed exit
 * (`T_EXIT_ERROR`, `T_EXIT_CLEAN`), and a running attempt cannot be aborted. `COMPLETE` maps to
 * `T_EXIT_CLEAN`, which still fires only on its own receptivity, an `exit=0` heartbeat: after
 * `COMPLETE` the caller keeps watching for the exit. `DEADLINE_EXCEEDED`, `HEARTBEAT_TIMEOUT` and
 * `ABORTED` have no transition yet; they are listed in `UNMAPPED`, and this slice does not change
 * the net (#103 owns that).
 *
 * Every terminal decision other than `COMPLETE` carries a compensation record naming what the
 * caller has to undo or report. The record describes work; nothing here performs it.
 *
 * Pure: no clock, no process, no filesystem, no environment, no imports. Every input field is read
 * once, so what is validated is what is decided. A decision grants no authority.
 */

export const LANE_ATTEMPT_DECISION_SCHEMA = 'gaia-lane-attempt-decision/1';
export const LANE_ATTEMPT_COMPENSATION_SCHEMA = 'gaia-lane-attempt-compensation/1';
export const MAX_LANE_ATTEMPT_EVENTS = 65_536;

export const LANE_ATTEMPT_DECISIONS = Object.freeze([
  'CONTINUE', 'COMPLETE', 'DEADLINE_EXCEEDED', 'HEARTBEAT_TIMEOUT', 'ABORTED',
]);

/** How equal instants resolve: an order or a limit is honoured before a completion is accepted. */
export const LANE_ATTEMPT_PRECEDENCE = Object.freeze([
  'ABORTED', 'DEADLINE_EXCEEDED', 'HEARTBEAT_TIMEOUT', 'COMPLETE',
]);

/** The lane-net transition that carries a decision out of `L_ATTEMPT_RUNNING`. */
export const LANE_ATTEMPT_TRANSITIONS = Object.freeze({ COMPLETE: 'T_EXIT_CLEAN' });

/** Terminal decisions the shipped lane net has no transition for. */
export const UNMAPPED = Object.freeze(['DEADLINE_EXCEEDED', 'HEARTBEAT_TIMEOUT', 'ABORTED']);

/** The exits that return a running attempt's `LANE_SLOTS` token in the shipped net. */
export const LANE_SLOT_RETURNING_EXITS = Object.freeze(['T_EXIT_CLEAN', 'T_EXIT_ERROR']);

/** What a compensation record may ask the caller to undo, in the order it is listed. */
export const COMPENSATION_ACTIONS = Object.freeze([
  // The provider process may still be running after the decision.
  'STOP_ATTEMPT_PROCESS',
  // An unmapped decision returns no token; release it unless an exit in `releaseSlotUnless` fires.
  'RELEASE_LANE_SLOT',
  // Whatever the attempt wrote is not this attempt's verified result.
  'DISCARD_UNVERIFIED_OUTPUT',
  // A marker came too late to count: keep the output aside for a person, never as the result.
  'QUARANTINE_LATE_OUTPUT',
]);

/** What a compensation record asks the caller to report. */
const REPORTS = Object.freeze({
  // The net's `L_LANE_ABORTED_SENT` receptivity: the lane sends lane-aborted after an acked abort.
  ABORTED: 'SEND_LANE_ABORTED',
  DEADLINE_EXCEEDED: 'ESCALATE_TO_COORDINATOR',
  HEARTBEAT_TIMEOUT: 'ESCALATE_TO_COORDINATOR',
});

/** The closed refusal vocabulary for input this module cannot judge. */
export const LANE_ATTEMPT_REFUSAL_CODES = Object.freeze([
  'InvalidCall',
  'InvalidAttempt',
  'InvalidLaneId',
  'InvalidAttemptNumber',
  'InvalidInstant',
  'DeadlineNotAfterStart',
  'InvalidHeartbeatTimeout',
  'InvalidObservation',
  'InvalidHeartbeatStep',
  'InvalidEvents',
  'InvalidEvent',
  'NowBeforeStart',
  'ObservationOutOfRange',
]);

export class LaneAttemptError extends Error {
  constructor(code, detail = null) {
    super(detail === null ? code : `${code} (${detail})`);
    this.name = 'LaneAttemptError';
    this.code = code;
    this.detail = detail;
  }
}

const refuse = (code, detail = null) => { throw new LaneAttemptError(code, detail); };

const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const STEP = /^L[0-9]{1,4}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const EVENT_KEYS = Object.freeze({
  HEARTBEAT: ['at', 'kind', 'step'],
  MARKER: ['at', 'kind'],
  ABORT: ['at', 'kind'],
});

/** A plain object with exactly `keys`, each read once into a fresh record. */
function readFields(value, keys, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    refuse(code);
  }
  const fields = {};
  for (const key of keys) fields[key] = value[key];
  return fields;
}

/** An ISO-8601 UTC instant, to the second or the millisecond, that names a real calendar time. */
function instantMs(value, detail) {
  if (typeof value !== 'string' || !INSTANT.test(value)) refuse('InvalidInstant', detail);
  const ms = Date.parse(value);
  const canonical = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  if (canonical === null || (canonical !== value && canonical.replace('.000Z', 'Z') !== value)) {
    refuse('InvalidInstant', detail);
  }
  return ms;
}

const iso = (ms) => new Date(ms).toISOString();

function readAttempt(value) {
  const attempt = readFields(value,
    ['laneId', 'attemptNumber', 'startedAt', 'deadline', 'heartbeatTimeoutMs'], 'InvalidAttempt');
  if (typeof attempt.laneId !== 'string' || !LANE_ID.test(attempt.laneId)) refuse('InvalidLaneId');
  if (!Number.isSafeInteger(attempt.attemptNumber) || attempt.attemptNumber < 1) {
    refuse('InvalidAttemptNumber');
  }
  const startedAt = instantMs(attempt.startedAt, 'startedAt');
  const deadline = instantMs(attempt.deadline, 'deadline');
  if (deadline <= startedAt) refuse('DeadlineNotAfterStart');
  if (!Number.isSafeInteger(attempt.heartbeatTimeoutMs) || attempt.heartbeatTimeoutMs < 1) {
    refuse('InvalidHeartbeatTimeout');
  }
  return {
    laneId: attempt.laneId, attemptNumber: attempt.attemptNumber,
    startedAt, deadline, heartbeatTimeoutMs: attempt.heartbeatTimeoutMs,
  };
}

/** An observed instant, refused after `now`. */
function observedMs(value, nowMs, detail) {
  const ms = instantMs(value, detail);
  if (ms > nowMs) refuse('ObservationOutOfRange', detail);
  return ms;
}

/** A heartbeat or an abort order observed before the start counts at the start. */
const fromStart = (ms, run) => Math.max(ms, run.startedAt);

/** The step a heartbeat reported, as a number: `L12` is 12. */
const stepNumber = (step) => Number(step.slice(1));

function readStep(value) {
  if (typeof value !== 'string' || !STEP.test(value)) refuse('InvalidHeartbeatStep');
  return value;
}

/** A snapshot, and a marker it holds from before the start, which belongs to no running attempt. */
function readObservation(value, run, nowMs) {
  const observation = readFields(value, ['heartbeat', 'markerSeenAt', 'abortOrderedAt'], 'InvalidObservation');
  let heartbeat = null;
  if (observation.heartbeat !== null) {
    const fields = readFields(observation.heartbeat, ['at', 'step'], 'InvalidObservation');
    const step = readStep(fields.step);
    heartbeat = { at: fromStart(observedMs(fields.at, nowMs, 'heartbeat.at'), run), step };
  }
  const optional = (field, detail) => (field === null ? null : observedMs(field, nowMs, detail));
  const marker = optional(observation.markerSeenAt, 'markerSeenAt');
  const abort = optional(observation.abortOrderedAt, 'abortOrderedAt');
  const stale = marker !== null && marker < run.startedAt;
  return {
    seen: {
      heartbeat,
      markerSeenAt: stale ? null : marker,
      abortOrderedAt: abort === null ? null : fromStart(abort, run),
    },
    staleMarkerAt: stale ? marker : null,
  };
}

/** The log sorted by instant, each instant as observed: nothing is moved to the start here. */
function readEvents(value, nowMs) {
  if (!Array.isArray(value)) refuse('InvalidEvents');
  // Read once: a log that grows while it is read is decided as it stood at the bound check.
  const length = value.length;
  if (length > MAX_LANE_ATTEMPT_EVENTS) refuse('InvalidEvents');
  const events = [];
  for (let index = 0; index < length; index += 1) {
    const entry = value[index];
    const kind = entry !== null && typeof entry === 'object' ? entry.kind : undefined;
    if (typeof kind !== 'string' || !Object.hasOwn(EVENT_KEYS, kind)) refuse('InvalidEvent', `events[${index}]`);
    const fields = readFields(entry, EVENT_KEYS[kind], 'InvalidEvent');
    if (fields.kind !== kind) refuse('InvalidEvent', `events[${index}]`);
    events.push({
      kind,
      at: observedMs(fields.at, nowMs, `events[${index}].at`),
      step: kind === 'HEARTBEAT' ? readStep(fields.step) : null,
    });
  }
  // A stable sort keeps the log's own order among events of the same instant.
  return events.sort((left, right) => left.at - right.at);
}

/** The earliest terminal decision due at `atMs` for one observation, or null when none is. */
function firstDue(run, seen, atMs) {
  const instants = {
    ABORTED: seen.abortOrderedAt,
    DEADLINE_EXCEEDED: run.deadline,
    HEARTBEAT_TIMEOUT: (seen.heartbeat?.at ?? run.startedAt) + run.heartbeatTimeoutMs,
    COMPLETE: seen.markerSeenAt,
  };
  const due = LANE_ATTEMPT_PRECEDENCE.map((decision) => [decision, instants[decision]])
    .filter(([, at]) => at !== null && at <= atMs);
  // Stable sort: candidates start in precedence order, so equal instants keep it.
  due.sort((left, right) => left[1] - right[1]);
  return due.length === 0 ? null : { decision: due[0][0], at: due[0][1] };
}

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
};

function compensationFor(decision, decisiveAt, run, seen, lateMarkerAt) {
  const unmapped = UNMAPPED.includes(decision);
  return {
    schema: LANE_ATTEMPT_COMPENSATION_SCHEMA,
    laneId: run.laneId,
    attemptNumber: run.attemptNumber,
    decision,
    decisiveAt: iso(decisiveAt),
    lastStep: seen.heartbeat?.step ?? null,
    lastHeartbeatAt: seen.heartbeat === null ? null : iso(seen.heartbeat.at),
    lateMarkerAt: lateMarkerAt === null ? null : iso(lateMarkerAt),
    undo: [
      'STOP_ATTEMPT_PROCESS',
      ...(unmapped ? ['RELEASE_LANE_SLOT'] : []),
      lateMarkerAt === null ? 'DISCARD_UNVERIFIED_OUTPUT' : 'QUARANTINE_LATE_OUTPUT',
    ],
    // The slot goes back once: by one of these exits if it fires for this attempt, else by the caller.
    releaseSlotUnless: unmapped ? [...LANE_SLOT_RETURNING_EXITS] : [],
    report: REPORTS[decision],
  };
}

function decisionAt(run, seen, nowMs, { lateMarkerAt, staleMarkerAt }) {
  const base = {
    schema: LANE_ATTEMPT_DECISION_SCHEMA,
    laneId: run.laneId,
    attemptNumber: run.attemptNumber,
    decidedAt: iso(nowMs),
    // A marker from before the start never decides; it is reported whatever the decision.
    staleMarkerAt: staleMarkerAt === null ? null : iso(staleMarkerAt),
  };
  const due = firstDue(run, seen, nowMs);
  if (due === null) {
    const heartbeatExpiry = (seen.heartbeat?.at ?? run.startedAt) + run.heartbeatTimeoutMs;
    return deepFreeze({
      ...base, decision: 'CONTINUE', decisiveAt: null, transition: null,
      nextDueAt: iso(Math.min(run.deadline, heartbeatExpiry)), compensation: null,
    });
  }
  if (due.decision === 'COMPLETE') {
    return deepFreeze({
      ...base, decision: 'COMPLETE', decisiveAt: iso(due.at),
      transition: LANE_ATTEMPT_TRANSITIONS.COMPLETE, nextDueAt: null, compensation: null,
    });
  }
  return deepFreeze({
    ...base, decision: due.decision, decisiveAt: iso(due.at), transition: null, nextDueAt: null,
    compensation: compensationFor(due.decision, due.at, run, seen, lateMarkerAt),
  });
}

/**
 * Decide one running lane attempt from a snapshot at the caller's `now`. Throws
 * `LaneAttemptError` with a code from `LANE_ATTEMPT_REFUSAL_CODES` for input it cannot judge.
 */
export function decideLaneAttempt(input) {
  const call = readFields(input, ['attempt', 'observation', 'now'], 'InvalidCall');
  const run = readAttempt(call.attempt);
  const nowMs = instantMs(call.now, 'now');
  if (nowMs < run.startedAt) refuse('NowBeforeStart');
  const { seen, staleMarkerAt } = readObservation(call.observation, run, nowMs);
  return decisionAt(run, seen, nowMs, { lateMarkerAt: seen.markerSeenAt, staleMarkerAt });
}

/**
 * Decide one running lane attempt from its event log at the caller's `now`. Events are
 * `{ kind: 'HEARTBEAT', at, step }`, `{ kind: 'MARKER', at }` or `{ kind: 'ABORT', at }`, in any
 * order. At each observed instant, its markers and aborts are folded in and the instant is judged
 * against the heartbeat before it; only then does a heartbeat of that instant replace it, the
 * highest step if several share the instant. The first terminal decision stands.
 */
export function replayLaneAttempt(input) {
  const call = readFields(input, ['attempt', 'events', 'now'], 'InvalidCall');
  const run = readAttempt(call.attempt);
  const nowMs = instantMs(call.now, 'now');
  if (nowMs < run.startedAt) refuse('NowBeforeStart');
  const observed = readEvents(call.events, nowMs);
  const isStale = (event) => event.kind === 'MARKER' && event.at < run.startedAt;
  const staleMarkerAt = observed.find(isStale)?.at ?? null;
  // Moving an instant up to the start keeps the log sorted.
  const events = observed.filter((event) => !isStale(event))
    .map((event) => ({ ...event, at: fromStart(event.at, run) }));

  let seen = { heartbeat: null, markerSeenAt: null, abortOrderedAt: null };
  for (let index = 0; index < events.length;) {
    // Everything observed at one instant is judged together, so ties keep their precedence.
    const instant = events[index].at;
    let heartbeat = null;
    for (; index < events.length && events[index].at === instant; index += 1) {
      const event = events[index];
      if (event.kind === 'MARKER') seen = { ...seen, markerSeenAt: instant };
      else if (event.kind === 'ABORT') seen = { ...seen, abortOrderedAt: instant };
      else if (heartbeat === null || stepNumber(event.step) > stepNumber(heartbeat.step)) {
        heartbeat = { at: instant, step: event.step };
      }
    }
    // Judge the instant against the heartbeat before it, then let its own heartbeat replace it.
    if (firstDue(run, seen, instant) !== null) break;
    if (heartbeat !== null) seen = { ...seen, heartbeat };
  }
  const lateMarkerAt = events.find((event) => event.kind === 'MARKER')?.at ?? null;
  return decisionAt(run, seen, nowMs, { lateMarkerAt, staleMarkerAt });
}
