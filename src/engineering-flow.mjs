/**
 * engineering-flow.mjs — `gaia-engineering-flow/1`, the closed contract for one sealed set of
 * discrete engineering events, and the one derivation from it to the block the control room
 * publishes.
 *
 * WHY THIS EXISTS
 * ---------------
 * The control room could already say *something is alive* — a lane, a heartbeat, a process — and
 * *nothing tracked is claimed*. Both are true and neither is throughput. This module holds the
 * evidence that answers a different question: did the engineering queue move, and how fast.
 *
 * WHAT CANNOT ENTER, AND WHY THAT IS A CONSTRUCTION RATHER THAN A PROMISE
 * ----------------------------------------------------------------------
 * The family vocabulary has no name for a heartbeat, a token, a byte of stdout, a spinner or a
 * live process id, and an unknown family is refused. That is the whole enforcement: an activity
 * signal is not weighted low here, it is unsayable.
 *
 * The same construction carries "explicit events only". There are exactly nine per-event fields
 * and an unknown one is refused, so there is no `updatedAt`-shaped field to infer a creation or a
 * closure from. A producer cannot add one, because the field list — not a review habit — is what
 * admits a field.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It decides no lifecycle state. It records events that already happened; it never sets or
 * contradicts a drain state, a telemetry run state or a portfolio item state, and it holds no
 * authority: `effect` and `authority` are fixed at `NONE` and are not per-event fields, so an
 * event cannot claim a different one.
 *
 * It reads nothing, opens nothing and holds no clock. It imports `node:crypto` and the one shared
 * exact-instant predicate. That second import is deliberate: re-spelling the rule here to keep an
 * import list of one would give this product two definitions of what a valid instant is, which is
 * the defect, not the fix.
 */

import { createHash } from 'node:crypto';

import { isExactInstant } from './local-lane-observation.mjs';

export const ENGINEERING_FLOW_SCHEMA = 'gaia-engineering-flow/1';

/** The one source this schema describes. A constant, not a caller-chosen string. */
export const ENGINEERING_FLOW_SOURCE = 'GAIA_ENGINEERING_FLOW';

/**
 * How stale a throughput READING may be before it stops being readable as "the last hour".
 *
 * Its own constant, deliberately. The heartbeat window answers "did the run prove it is alive?"
 * and the lane window answers "did the sensor run?". This one answers "how old is this
 * measurement?", and five minutes is more than eight per cent of the shortest published window.
 */
export const ENGINEERING_FLOW_FRESH_MS = 300_000;

/** A document-size bound, not a policy about how much work may exist. */
export const MAX_ENGINEERING_FLOW_EVENTS = 512;

/**
 * The smallest honest cycle-time sample, quoted from the existing pace policy rather than
 * re-invented, so this page and the pace card cannot disagree about what "enough" means.
 */
export const ENGINEERING_FLOW_CYCLE_TIME_MIN_SAMPLE = 5;

/** The exact top-level and per-event field sets. Anything else is refused, never ignored. */
export const ENGINEERING_FLOW_FIELDS = Object.freeze([
  'schema', 'effect', 'authority', 'observedAt', 'windowStartedAt', 'sequence', 'events',
  'revision',
]);
export const ENGINEERING_FLOW_EVENT_FIELDS = Object.freeze([
  'eventId', 'occurredAt', 'family', 'outcome', 'repository', 'workItemId',
  'startedAt', 'sourceKind', 'sourceRevision',
]);

/** The five families that materially change the engineering queue. Closed. */
export const ENGINEERING_FLOW_FAMILIES = Object.freeze([
  'ISSUE', 'PULL_REQUEST', 'COMMIT', 'FACTORY_RUN', 'EVIDENCE_REVIEW',
]);

/**
 * Null-prototype lookups throughout, so a family or outcome spelled `constructor` or `toString`
 * answers `undefined` rather than a function, and is refused like any other unknown token.
 */
const closedMap = (entries) => Object.freeze(Object.assign(Object.create(null), entries));

export const ENGINEERING_FLOW_OUTCOMES = closedMap({
  ISSUE: Object.freeze(['OPENED', 'REOPENED', 'CLOSED']),
  PULL_REQUEST: Object.freeze(['OPENED', 'REOPENED', 'MERGED', 'CLOSED_WITHOUT_MERGE']),
  COMMIT: Object.freeze(['PRODUCED_ON_WORK_BRANCH', 'INTEGRATED_INTO_DEFAULT_BRANCH']),
  FACTORY_RUN: Object.freeze(['COMPLETED', 'FAILED']),
  EVIDENCE_REVIEW: Object.freeze(['APPROVED', 'REFUSED']),
});

export const ENGINEERING_FLOW_SOURCE_KINDS = Object.freeze([
  'GITHUB_EVENT', 'GIT_HISTORY', 'FACTORY_TELEMETRY', 'DRAIN_RECEIPT', 'EVIDENCE_LEDGER',
]);

/** The three published windows, in the order they are rendered. */
export const ENGINEERING_FLOW_WINDOWS = Object.freeze([
  Object.freeze({ window: 'PT1H', windowMs: 3_600_000 }),
  Object.freeze({ window: 'P1D', windowMs: 86_400_000 }),
  Object.freeze({ window: 'P7D', windowMs: 604_800_000 }),
]);

/**
 * Which outcomes add to the queue, which take from it, and which close a comparable duration.
 *
 * `FACTORY_RUN` and `EVIDENCE_REVIEW` carry an EMPTY inflow list rather than a fabricated
 * `RUN_STARTED`, because no such discrete, independently sourced event was observed to exist.
 * Their queue arithmetic is reported as unknown with a named reason; it is never printed as zero
 * so that a net could appear.
 */
const FAMILY_FLOW = closedMap({
  ISSUE: Object.freeze({
    inflow: Object.freeze(['OPENED', 'REOPENED']),
    outflow: Object.freeze(['CLOSED']),
    closing: Object.freeze(['CLOSED']),
  }),
  PULL_REQUEST: Object.freeze({
    inflow: Object.freeze(['OPENED', 'REOPENED']),
    outflow: Object.freeze(['MERGED', 'CLOSED_WITHOUT_MERGE']),
    closing: Object.freeze(['MERGED', 'CLOSED_WITHOUT_MERGE']),
  }),
  COMMIT: Object.freeze({
    inflow: Object.freeze(['PRODUCED_ON_WORK_BRANCH']),
    outflow: Object.freeze(['INTEGRATED_INTO_DEFAULT_BRANCH']),
    closing: Object.freeze(['INTEGRATED_INTO_DEFAULT_BRANCH']),
  }),
  FACTORY_RUN: Object.freeze({
    inflow: Object.freeze([]),
    outflow: Object.freeze(['COMPLETED', 'FAILED']),
    closing: Object.freeze(['COMPLETED', 'FAILED']),
  }),
  EVIDENCE_REVIEW: Object.freeze({
    inflow: Object.freeze([]),
    outflow: Object.freeze(['APPROVED', 'REFUSED']),
    closing: Object.freeze(['APPROVED', 'REFUSED']),
  }),
});

/**
 * Outcomes that cannot both be true of one subject.
 *
 * Deliberately short. An issue closed, reopened and closed again is an ordinary history, and a
 * review that requested changes and later approved is the review process working; refusing those
 * would be a fabricated contradiction, which is the same class of error as a fabricated count.
 */
const EXCLUSIVE_TERMINALS = closedMap({
  PULL_REQUEST: Object.freeze(['MERGED', 'CLOSED_WITHOUT_MERGE']),
  FACTORY_RUN: Object.freeze(['COMPLETED', 'FAILED']),
});

/** An identity admits no whitespace, quote, angle bracket, slash or newline. */
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export class EngineeringFlowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineeringFlowError';
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
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/**
 * One event rebuilt in one fixed key order over the nine known fields.
 *
 * This is what makes the digest independent of how a caller happened to construct the object, and
 * it is also why an artifact carrying a tenth field still seals correctly: the extra field cannot
 * enter the digest, so the closed field list — not the digest — is what refuses it. A gate that
 * caught such a field only through a broken digest would be testing the wrong mechanism.
 */
const projectEvent = (entry) => ({
  eventId: entry.eventId,
  occurredAt: entry.occurredAt,
  family: entry.family,
  outcome: entry.outcome,
  repository: entry.repository ?? null,
  workItemId: entry.workItemId,
  startedAt: entry.startedAt ?? null,
  sourceKind: entry.sourceKind,
  sourceRevision: entry.sourceRevision,
});

/**
 * The one digest recipe, exported because the seal, the verifier and the control room's render
 * seam all need it. A second implementation is how two verifiers come to disagree about what a
 * revision means.
 */
export function engineeringFlowRevision({
  observedAt, windowStartedAt, sequence, events = [],
} = {}) {
  return createHash('sha256').update(canonicalJson({
    schema: ENGINEERING_FLOW_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    observedAt,
    windowStartedAt,
    sequence,
    events: events.map(projectEvent),
  })).digest('hex');
}

/** Ordinal comparison. Not `localeCompare`, which is host- and ICU-version-dependent. */
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The one ordering key. NUL separates the two parts because it is the one character neither an
 * instant nor an identity can contain, so no pair can spoof the field boundary.
 */
const eventOrderKey = (entry) => `${entry.occurredAt}\u0000${entry.eventId}`;

const isSafeIdentity = (value) => typeof value === 'string' && IDENTITY.test(value);

/**
 * Total verification of one published `gaia-engineering-flow/1` value.
 *
 * Every refusal is a refusal to DISPLAY, never a repair. Nothing here is clamped: a future instant
 * is not pulled back to now, an unknown family is not bucketed as other, and a duplicate identity
 * is not de-duplicated. Each of those repairs would turn incoherent evidence into a confident
 * reading, which is the failure this whole section exists to prevent.
 */
export function requireEngineeringFlowArtifact(value) {
  const refuse = (message) => {
    throw new EngineeringFlowError('InvalidEngineeringFlow', message);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('a Gaia engineering flow artifact object is required');
  }
  for (const field of Object.keys(value)) {
    if (!ENGINEERING_FLOW_FIELDS.includes(field)) {
      refuse(`the artifact carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  if (value.schema !== ENGINEERING_FLOW_SCHEMA || value.effect !== 'NONE'
      || value.authority !== 'NONE' || typeof value.revision !== 'string'
      || !Array.isArray(value.events)) {
    refuse('an authority-free Gaia engineering flow artifact is required');
  }
  if (!isExactInstant(value.observedAt)) {
    refuse('the observation instant must be an exact ISO timestamp');
  }
  if (!isExactInstant(value.windowStartedAt)) {
    refuse('the window start must be an exact ISO timestamp');
  }
  const observedAtMs = Date.parse(value.observedAt);
  const windowStartedAtMs = Date.parse(value.windowStartedAt);
  if (windowStartedAtMs > observedAtMs) {
    refuse('the window cannot start after the instant the evidence was observed');
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    refuse('the sequence must be a safe integer of zero or more');
  }
  if (value.events.length > MAX_ENGINEERING_FLOW_EVENTS) {
    refuse(`an artifact carries at most ${MAX_ENGINEERING_FLOW_EVENTS} events`);
  }

  const seenIds = new Set();
  const terminals = new Map();
  let previousKey = null;
  for (const entry of value.events) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      refuse('an event must be an object');
    }
    for (const field of Object.keys(entry)) {
      if (!ENGINEERING_FLOW_EVENT_FIELDS.includes(field)) {
        refuse(`an event carries an unknown field ${JSON.stringify(field)}`);
      }
    }
    if (!isSafeIdentity(entry.eventId)) refuse('an event identity is not a bounded identity');
    if (!isSafeIdentity(entry.workItemId)) refuse('a work item identity is not a bounded identity');
    if (!isExactInstant(entry.occurredAt)) {
      refuse(`event ${JSON.stringify(entry.eventId)} has no exact canonical instant`);
    }
    const occurredAtMs = Date.parse(entry.occurredAt);
    if (occurredAtMs > observedAtMs) {
      refuse(`event ${JSON.stringify(entry.eventId)} is dated after the evidence was observed`);
    }
    if (occurredAtMs < windowStartedAtMs) {
      refuse(`event ${JSON.stringify(entry.eventId)} is before the window it claims to complete`);
    }
    if (!ENGINEERING_FLOW_FAMILIES.includes(entry.family)) {
      refuse(`event family ${JSON.stringify(entry.family)} is outside the closed vocabulary`);
    }
    if (!ENGINEERING_FLOW_OUTCOMES[entry.family].includes(entry.outcome)) {
      refuse(`outcome ${JSON.stringify(entry.outcome)} does not belong to family ${entry.family}`);
    }
    // The two families that are not repository-scoped facts may say so; the three that are must
    // name the repository, because a count that cannot say where it happened is not evidence.
    const repositoryOptional = FAMILY_FLOW[entry.family].inflow.length === 0;
    if (entry.repository === null
      ? !repositoryOptional
      : !(typeof entry.repository === 'string' && REPOSITORY.test(entry.repository))) {
      refuse(`event ${JSON.stringify(entry.eventId)} has no usable repository identity`);
    }
    if (entry.startedAt !== null) {
      if (!isExactInstant(entry.startedAt)) refuse('a start instant must be exact, or null');
      if (Date.parse(entry.startedAt) > occurredAtMs) {
        refuse(`event ${JSON.stringify(entry.eventId)} starts after it happened`);
      }
    }
    if (!ENGINEERING_FLOW_SOURCE_KINDS.includes(entry.sourceKind)) {
      refuse(`source kind ${JSON.stringify(entry.sourceKind)} is outside the closed vocabulary`);
    }
    if (typeof entry.sourceRevision !== 'string' || !DIGEST.test(entry.sourceRevision)) {
      refuse(`event ${JSON.stringify(entry.eventId)} names no source digest`);
    }
    if (seenIds.has(entry.eventId)) {
      refuse(`event identity ${JSON.stringify(entry.eventId)} is repeated`);
    }
    seenIds.add(entry.eventId);
    const key = eventOrderKey(entry);
    if (previousKey !== null && ordinal(previousKey, key) >= 0) {
      refuse('events must be in strictly ascending order of instant then identity');
    }
    previousKey = key;

    const exclusive = EXCLUSIVE_TERMINALS[entry.family];
    if (exclusive?.includes(entry.outcome)) {
      // Keyed by family AND subject: one identity used in two families is not a contradiction
      // about either of them.
      const subject = `${entry.family}\u0000${entry.workItemId}`;
      const seen = terminals.get(subject) ?? new Set();
      seen.add(entry.outcome);
      if (seen.size > 1) {
        refuse(
          `${entry.family} ${JSON.stringify(entry.workItemId)} carries the mutually exclusive`
          + ` terminal outcomes ${[...seen].join(' and ')}`,
        );
      }
      terminals.set(subject, seen);
    }
  }

  if (value.revision !== engineeringFlowRevision(value)) {
    refuse('the engineering flow revision does not match its content');
  }
  return deepFreeze(value);
}

/**
 * Seal one artifact: order the events, verify the whole value, and content-address it.
 *
 * Ordering here rather than in every caller is what makes two readings of the same evidence
 * byte-identical. The verifier still enforces the order, so a hand-written file gets no
 * dispensation a producer enjoys.
 */
export function sealEngineeringFlow({
  observedAt, windowStartedAt, sequence, events = [],
} = {}) {
  if (!Array.isArray(events)) {
    throw new EngineeringFlowError('InvalidEngineeringFlow', 'events must be an array');
  }
  const ordered = [...events]
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new EngineeringFlowError('InvalidEngineeringFlow', 'an event must be an object');
      }
      // Refused rather than projected away. Silently dropping an unknown field would let a
      // producer believe a lifecycle field it wrote was being honoured.
      for (const field of Object.keys(entry)) {
        if (!ENGINEERING_FLOW_EVENT_FIELDS.includes(field)) {
          throw new EngineeringFlowError(
            'InvalidEngineeringFlow',
            `an event carries an unknown field ${JSON.stringify(field)}`,
          );
        }
      }
      return projectEvent(entry);
    })
    .sort((left, right) => ordinal(eventOrderKey(left), eventOrderKey(right)));

  return requireEngineeringFlowArtifact({
    schema: ENGINEERING_FLOW_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    observedAt,
    windowStartedAt,
    sequence,
    events: ordered,
    revision: engineeringFlowRevision({
      observedAt, windowStartedAt, sequence, events: ordered,
    }),
  });
}

/**
 * Whether the producer claims to have observed this whole window.
 *
 * The single most consequential predicate in this module. Every `UNKNOWN` cell on the page exists
 * because this returned false, and the alternative — treating an unobserved window as empty — is
 * how a dashboard comes to print the most reassuring reading available for evidence nobody has.
 */
const isWindowComplete = (windowStartedAt, observedAt, windowMs) => (
  Date.parse(windowStartedAt) <= Date.parse(observedAt) - windowMs
);

/** One deterministic rounding, so a rate never depends on how it happened to be printed. */
const roundRate = (value) => Math.round(value * 10_000) / 10_000;

const unknownCounts = (outcomes) => Object.fromEntries(outcomes.map((name) => [name, null]));

function deriveCycleTime({ complete, closingEvents }) {
  if (!complete) {
    return {
      state: 'UNKNOWN', reasonCode: 'WINDOW_INCOMPLETE', sampleSize: null, medianMs: null,
    };
  }
  if (closingEvents.length < ENGINEERING_FLOW_CYCLE_TIME_MIN_SAMPLE) {
    return {
      state: 'UNKNOWN',
      reasonCode: 'NOT_ENOUGH_COMPARABLE_DURATIONS',
      sampleSize: closingEvents.length,
      medianMs: null,
    };
  }
  // The whole cell is withheld rather than computed over the subset that happens to carry a
  // start: a median over that subset is a selection-biased estimate presented as a measurement.
  if (closingEvents.some(({ startedAt }) => startedAt === null)) {
    return {
      state: 'UNKNOWN',
      reasonCode: 'INCOMPLETE_COMPARABLE_DURATIONS',
      sampleSize: closingEvents.length,
      medianMs: null,
    };
  }
  const durations = closingEvents
    .map(({ occurredAt, startedAt }) => Date.parse(occurredAt) - Date.parse(startedAt))
    .sort((left, right) => left - right);
  return {
    state: 'MEASURED',
    reasonCode: null,
    sampleSize: durations.length,
    // `sorted[floor(n / 2)]`, quoting measurePace's existing formula rather than re-deriving one,
    // so this page and the pace card cannot disagree about what "median" means.
    medianMs: durations[Math.floor(durations.length / 2)],
  };
}

function deriveQueue({ complete, family, counts }) {
  const { inflow: inflowOutcomes, outflow: outflowOutcomes } = FAMILY_FLOW[family];
  // The structural reason wins where both are true: it stays true after the window fills, so
  // reporting the evidence reason would promise a net that waiting will never produce.
  if (inflowOutcomes.length === 0) {
    return {
      state: 'UNKNOWN', reasonCode: 'NO_OBSERVED_INFLOW', inflow: null, outflow: null, net: null,
    };
  }
  if (!complete) {
    return {
      state: 'UNKNOWN', reasonCode: 'WINDOW_INCOMPLETE', inflow: null, outflow: null, net: null,
    };
  }
  const inflow = inflowOutcomes.reduce((total, name) => total + counts[name], 0);
  const outflow = outflowOutcomes.reduce((total, name) => total + counts[name], 0);
  // A queue CHANGE, never a backlog: it says the tracked queue grew or shrank by this much over
  // this window, and says nothing at all about its absolute size.
  return { state: 'MEASURED', reasonCode: null, inflow, outflow, net: inflow - outflow };
}

function deriveWindow({ family, window, windowMs, events, observedAt, windowStartedAt }) {
  const outcomes = ENGINEERING_FLOW_OUTCOMES[family];
  const complete = isWindowComplete(windowStartedAt, observedAt, windowMs);
  if (!complete) {
    return {
      window,
      windowMs,
      state: 'UNKNOWN',
      reasonCode: 'WINDOW_INCOMPLETE',
      // Never `0`. Zero and unknown are opposite readings: one says the queue produced nothing,
      // the other says we did not look.
      total: null,
      ratePerHour: null,
      outcomes: unknownCounts(outcomes),
      queue: deriveQueue({ complete, family, counts: null }),
      cycleTime: deriveCycleTime({ complete, closingEvents: [] }),
    };
  }
  const from = Date.parse(observedAt) - windowMs;
  const inWindow = events.filter(
    (entry) => entry.family === family && Date.parse(entry.occurredAt) >= from,
  );
  const counts = Object.fromEntries(outcomes.map(
    (name) => [name, inWindow.filter(({ outcome }) => outcome === name).length],
  ));
  const closing = FAMILY_FLOW[family].closing;
  return {
    window,
    windowMs,
    state: 'MEASURED',
    reasonCode: null,
    total: inWindow.length,
    ratePerHour: roundRate(inWindow.length / (windowMs / 3_600_000)),
    outcomes: counts,
    queue: deriveQueue({ complete, family, counts }),
    cycleTime: deriveCycleTime({
      complete,
      closingEvents: inWindow.filter(({ outcome }) => closing.includes(outcome)),
    }),
  };
}

/**
 * The one derivation from a verified artifact to the published block.
 *
 * Called by the control-room builder and by its render seam alike, so a snapshot whose published
 * block is not what its own carried evidence derives is refused rather than displayed.
 *
 * The windows end at the ARTIFACT's instant, not the reader's. The artifact is what declares which
 * interval its evidence is complete over; ending the windows at the reader's clock would report a
 * count for an interval nobody claimed to have observed. How stale that reading is travels
 * separately, as `observationAgeMs` against its own freshness window.
 */
export function deriveEngineeringFlowBlock({ artifact, observedAt }) {
  const observationAgeMs = Date.parse(observedAt) - Date.parse(artifact.observedAt);
  const events = artifact.events.map(projectEvent);
  return deepFreeze({
    source: ENGINEERING_FLOW_SOURCE,
    state: observationAgeMs <= ENGINEERING_FLOW_FRESH_MS ? 'FRESH' : 'STALE',
    // Published rather than merely absent, so a consumer reads the disclaimer instead of
    // inferring a portfolio binding from a missing field.
    binding: 'NONE',
    observedAt: artifact.observedAt,
    windowStartedAt: artifact.windowStartedAt,
    artifactRevision: artifact.revision,
    sequence: artifact.sequence,
    observationAgeMs,
    freshnessWindowMs: ENGINEERING_FLOW_FRESH_MS,
    eventCount: events.length,
    families: ENGINEERING_FLOW_FAMILIES.map((family) => ({
      family,
      windows: ENGINEERING_FLOW_WINDOWS.map(({ window, windowMs }) => deriveWindow({
        family,
        window,
        windowMs,
        events,
        observedAt: artifact.observedAt,
        windowStartedAt: artifact.windowStartedAt,
      })),
    })),
    // Carried verbatim, at a deliberate size cost, for one property: the render seam re-derives
    // every count, rate, state, reason and median from these events. A digest taken over evidence
    // the verifier cannot see is not verifiable.
    events,
  });
}

/**
 * A prior reading of the same source, used only to refuse a snapshot that went backwards.
 *
 * A producer whose sequence or observation instant regressed is republishing stale or forged
 * evidence as current, and the reading it would produce is indistinguishable from a fresh one.
 */
function requirePriorObservation(prior) {
  if (prior === null || prior === undefined) return null;
  if (typeof prior !== 'object' || Array.isArray(prior)
      || !isExactInstant(prior.observedAt)
      || !Number.isSafeInteger(prior.sequence) || prior.sequence < 0) {
    throw new EngineeringFlowError(
      'InvalidEngineeringFlow',
      'a prior observation must name an exact instant and a safe sequence',
    );
  }
  return prior;
}

/**
 * Verify one sealed artifact on its own terms, check it against the reader's instant and against
 * any prior observation of the same source, and derive the published block.
 */
export function summarizeEngineeringFlow({ artifact, observedAt, priorObservation = null }) {
  const verified = requireEngineeringFlowArtifact(artifact);
  if (!isExactInstant(observedAt)) {
    throw new EngineeringFlowError(
      'InvalidEngineeringFlow', 'the reading instant must be an exact ISO timestamp',
    );
  }
  // Refused rather than clamped, for the same reason the lane observation is: evidence dated
  // after the instant it was read cannot be aged, and a zero age is the single most reassuring
  // reading available.
  if (Date.parse(verified.observedAt) > Date.parse(observedAt)) {
    throw new EngineeringFlowError(
      'IncoherentEngineeringFlow',
      `engineering flow evidence dated ${verified.observedAt} is after the instant it was read,`
      + ` ${observedAt}; a clock or a producer timestamp is wrong and no throughput can be measured`,
    );
  }
  const prior = requirePriorObservation(priorObservation);
  if (prior !== null
      && (Date.parse(verified.observedAt) < Date.parse(prior.observedAt)
        || verified.sequence < prior.sequence)) {
    throw new EngineeringFlowError(
      'IncoherentEngineeringFlow',
      `this engineering flow artifact (sequence ${verified.sequence} at ${verified.observedAt})`
      + ` went backwards against the prior observation (sequence ${prior.sequence} at`
      + ` ${prior.observedAt}); a source snapshot that regressed is refused, never displayed`,
    );
  }
  return deriveEngineeringFlowBlock({ artifact: verified, observedAt });
}
