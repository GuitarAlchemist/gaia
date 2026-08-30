/**
 * local-lane-observation.mjs — `gaia-local-lane-observation/1`, the closed contract for one
 * bounded reading of the local wmux lanes.
 *
 * This module knows nothing about wmux. It is the schema, its total verifier and the safe
 * patterns, and that is deliberately all it is: the sensor that produces an observation and the
 * control room that consumes one must agree on exactly one definition of what an observation is,
 * and neither of them gets to hold it.
 *
 * WHAT AN OBSERVATION MAY CARRY, AND WHY THAT IS A CONSTRUCTION
 * ------------------------------------------------------------
 * Seven top-level fields and seven per lane, and every one of them is either a fixed constant, an
 * instant, a closed token or a bounded identity. `label` is the only human-authored string, and it
 * is bounded to 64 code points of a POSITIVE Unicode allowlist — letters, digits, spaces and one
 * named punctuation set. Everything outside that allowlist is refused, which includes every
 * `\p{C}` code point rather than merely the C0 controls: U+202E RLO and U+2066-U+2069 would let a
 * label render reversed and impersonate another lane, and U+200B / U+FEFF would let two visually
 * identical labels be different strings. Labels are already duplicated on real machines, so visual
 * disambiguation is load-bearing rather than cosmetic.
 *
 * WHO CAN WRITE A LABEL, STATED RATHER THAN IMPLIED
 * ------------------------------------------------
 * A wmux label is chosen by whoever spawns the agent, and one agent may spawn another. `label` is
 * therefore a channel an observed process can influence, and it has exactly two barriers: the
 * allowlist this module enforces at the seam, and `escapeHtml` at every interpolation. That is why
 * an unreadable label is WITHHELD rather than sanitised — sanitising would run an attacker-shaped
 * string through a transformation and then display the result.
 *
 * The lane identities are what an operator uses to find the pane, so a malformed one is refused
 * rather than repaired: a wrong identity is worse than no identity. A label is different — it is a
 * name, not an address — so an unreadable one is withheld and the lane is still reported. Dropping
 * the lane would under-report exactly the lanes the operator is looking for.
 *
 * `labelState` is a separate closed field rather than a sentinel inside `label`, modelled on
 * `sourceChangedAtBasis`: a lane genuinely named `UNKNOWN` must not be indistinguishable from a
 * lane whose label was missing, and a withholding must be assertable rather than inferable from a
 * magic string.
 *
 * This module reads nothing, opens nothing, and holds no clock. It imports `node:crypto` only.
 */

import { createHash } from 'node:crypto';

export const LOCAL_LANE_OBSERVATION_SCHEMA = 'gaia-local-lane-observation/1';

/** The one sensor source this schema describes. It is a constant, not a caller-chosen string. */
export const LOCAL_LANE_SOURCE = 'LOCAL_WMUX';

/**
 * The closed lifecycle vocabulary. Only `RUNNING` is ever live.
 *
 * Three values, not four: `RUNNING` and `EXITED` are the two statuses a live wmux install was
 * observed to emit, and `UNKNOWN` is the honest answer for everything else. A speculative fourth
 * state for a status nothing has been seen to produce would be a vocabulary entry with no
 * evidence behind it.
 */
export const LOCAL_LANE_LIFECYCLES = Object.freeze(['RUNNING', 'EXITED', 'UNKNOWN']);

/** The single lifecycle that can make a lane live. Quoted, never re-spelled. */
export const LOCAL_LANE_LIVE_LIFECYCLE = 'RUNNING';

/** Three kinds of fact about a name, kept apart so none of them has to be inferred. */
export const LOCAL_LANE_LABEL_STATES = Object.freeze(['OBSERVED', 'ABSENT', 'WITHHELD_UNSAFE']);

/**
 * How recently the SENSOR reported — never how recently a worker proved liveness.
 *
 * Deliberately its own constant rather than a borrowed heartbeat-freshness window. That window
 * answers "did the run prove it is alive?"; this one answers "did the sensor run?". They happen to
 * share a value and they do not share a meaning, and collapsing two evidence axes into one number
 * is the confusion the rest of this product's lattice exists to prevent.
 */
export const LOCAL_LANE_OBSERVATION_FRESH_MS = 30_000;

/**
 * A document-size bound, NOT a lane policy.
 *
 * `src/lanes.mjs` owns the supported live-lane count and its evidence; this number owns nothing
 * but the size of one JSON document, and it borrows no vocabulary from that module. Over-capacity
 * is reported by the control room against `DEFAULT_MAX_LIVE_LANES`, not enforced here.
 */
export const MAX_OBSERVED_LANES = 64;

/** The honest sentinel for an identity the sensor was never given. Never used for a label. */
export const UNKNOWN_IDENTITY = 'UNKNOWN';

/** The exact top-level and per-lane field sets. Anything else is refused, never ignored. */
export const LOCAL_LANE_OBSERVATION_FIELDS = Object.freeze([
  'schema', 'source', 'effect', 'authority', 'observedAt', 'lanes', 'revision',
]);
export const LOCAL_LANE_FIELDS = Object.freeze([
  'workspaceId', 'paneId', 'surfaceId', 'agentId', 'label', 'labelState', 'lifecycle',
]);

/**
 * An identity admits no whitespace, quote, angle bracket, slash or newline, so it cannot carry a
 * path, a URL, a command fragment or markup however it was obtained upstream.
 */
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/**
 * The positive label allowlist, in one place.
 *
 * First code point is a letter or a digit, which refuses a leading combining mark, a leading space
 * and a leading punctuation run. The continuation class adds spaces, the punctuation real lane
 * names use — including U+2014 and U+2013, which every observed wmux label on this machine carries
 * — and `\p{M}`, so a composed and a decomposed spelling of the same accented name are both
 * readable. Nothing else is admitted, so every `\p{C}` code point is outside it by construction.
 */
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{Zs}&'’,.:#()/–—_-]{0,63}$/u;

export class LocalLaneObservationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalLaneObservationError';
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
 * The observation digest recipe, in one place, because three callers need it and a second
 * implementation is how two verifiers come to disagree about what a revision means.
 *
 * `lanes` is projected to the seven observation fields on the way in, so a consumer holding a
 * derived view of the same lanes — the control room's block adds a `live` flag — re-derives the
 * same revision without having to know how to strip its own additions. Anything the projection
 * does not name cannot enter the digest, which is the same construction the field lists are.
 */
export function localLaneObservationRevision({ observedAt, lanes = [] } = {}) {
  return createHash('sha256').update(canonicalJson({
    schema: LOCAL_LANE_OBSERVATION_SCHEMA,
    source: LOCAL_LANE_SOURCE,
    effect: 'NONE',
    authority: 'NONE',
    observedAt,
    lanes: lanes.map((lane) => ({
      workspaceId: lane.workspaceId,
      paneId: lane.paneId,
      surfaceId: lane.surfaceId,
      agentId: lane.agentId,
      label: lane.label,
      labelState: lane.labelState,
      lifecycle: lane.lifecycle,
    })),
  })).digest('hex');
}

export const isSafeLaneIdentity = (value) => typeof value === 'string' && IDENTITY.test(value);
export const isSafeLaneLabel = (value) => typeof value === 'string' && LABEL.test(value);

/**
 * An instant must round-trip exactly through `Date#toISOString`. Leniently parsed timestamps are
 * how a partial date silently becomes a confident one, so `2026-08-30` is refused rather than
 * widened to midnight UTC.
 */
export const isExactInstant = (value) => typeof value === 'string'
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

/** Ordinal comparison. Not `localeCompare`, which is host- and ICU-version-dependent. */
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The one ordering key, so two implementations cannot disagree about what "sorted" means.
 *
 * NUL separates the three identities because it is the one character the identity pattern cannot
 * admit, so no combination of workspace, surface and agent ids can spoof a field boundary. It is
 * written as an escape rather than as a literal byte, so this file stays plain reviewable text.
 */
export const laneOrderKey = (lane) => `${lane.workspaceId}\u0000${lane.surfaceId}\u0000${lane.agentId}`;

/**
 * Total verification of one published `gaia-local-lane-observation/1` value.
 *
 * Every refusal here is a refusal to display, never a repair. A consumer that verified three
 * shallow fields could adopt a lane set out of a file this function refuses and animate a
 * dashboard over evidence nobody can reproduce.
 */
export function requireLocalLaneObservation(value) {
  const refuse = (message) => {
    throw new LocalLaneObservationError('InvalidLocalLaneObservation', message);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('a Gaia local lane observation object is required');
  }
  for (const field of Object.keys(value)) {
    if (!LOCAL_LANE_OBSERVATION_FIELDS.includes(field)) {
      refuse(`the observation carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  if (value.schema !== LOCAL_LANE_OBSERVATION_SCHEMA || value.source !== LOCAL_LANE_SOURCE
      || value.effect !== 'NONE' || value.authority !== 'NONE'
      || typeof value.revision !== 'string' || !Array.isArray(value.lanes)) {
    refuse('an authority-free Gaia local lane observation is required');
  }
  if (!isExactInstant(value.observedAt)) {
    refuse('the observation instant must be an exact ISO timestamp');
  }
  if (value.lanes.length > MAX_OBSERVED_LANES) {
    refuse(`an observation carries at most ${MAX_OBSERVED_LANES} lanes`);
  }

  let previous = null;
  for (const lane of value.lanes) {
    if (!lane || typeof lane !== 'object' || Array.isArray(lane)) refuse('a lane must be an object');
    for (const field of Object.keys(lane)) {
      if (!LOCAL_LANE_FIELDS.includes(field)) {
        refuse(`a lane carries an unknown field ${JSON.stringify(field)}`);
      }
    }
    for (const identity of ['workspaceId', 'paneId', 'surfaceId', 'agentId']) {
      if (!isSafeLaneIdentity(lane[identity])) {
        refuse(`a lane ${identity} is not a bounded identity`);
      }
    }
    if (!LOCAL_LANE_LABEL_STATES.includes(lane.labelState)) {
      refuse(`a lane labelState must be one of ${LOCAL_LANE_LABEL_STATES.join(', ')}`);
    }
    // A name that was observed must be readable; a name that was not must be absent rather than
    // spelled with a token that a real lane could also be called.
    if (lane.labelState === 'OBSERVED'
      ? !isSafeLaneLabel(lane.label)
      : lane.label !== null) {
      refuse('a lane label must be a bounded human-safe name when observed, and null otherwise');
    }
    if (!LOCAL_LANE_LIFECYCLES.includes(lane.lifecycle)) {
      refuse(`a lane lifecycle must be one of ${LOCAL_LANE_LIFECYCLES.join(', ')}`);
    }
    const key = laneOrderKey(lane);
    if (previous !== null && ordinal(previous, key) >= 0) {
      refuse('lanes must be in strictly ascending identity order, with no repeated identity');
    }
    previous = key;
  }

  if (value.revision !== localLaneObservationRevision(value)) {
    refuse('the observation revision does not match its content');
  }
  return deepFreeze(value);
}

/**
 * Seal one observation: order the lanes, verify the whole value, and content-address it.
 *
 * Ordering here rather than in every caller is what makes two readings of the same lane set
 * byte-identical; the verifier still enforces the order, so a hand-written file gets no
 * dispensation the sensor enjoys.
 */
export function sealLocalLaneObservation({ observedAt, lanes = [] } = {}) {
  if (!Array.isArray(lanes)) {
    throw new LocalLaneObservationError('InvalidLocalLaneObservation', 'lanes must be an array');
  }
  const ordered = [...lanes]
    .map((lane) => {
      if (!lane || typeof lane !== 'object' || Array.isArray(lane)) {
        throw new LocalLaneObservationError('InvalidLocalLaneObservation', 'a lane must be an object');
      }
      for (const field of Object.keys(lane)) {
        if (!LOCAL_LANE_FIELDS.includes(field)) {
          throw new LocalLaneObservationError(
            'InvalidLocalLaneObservation',
            `a lane carries an unknown field ${JSON.stringify(field)}`,
          );
        }
      }
      // Rebuilt in one fixed key order, so serialized bytes cannot depend on how a caller
      // happened to construct the object.
      return {
        workspaceId: lane.workspaceId,
        paneId: lane.paneId,
        surfaceId: lane.surfaceId,
        agentId: lane.agentId,
        label: lane.label ?? null,
        labelState: lane.labelState,
        lifecycle: lane.lifecycle,
      };
    })
    .sort((left, right) => ordinal(laneOrderKey(left), laneOrderKey(right)));

  return requireLocalLaneObservation({
    schema: LOCAL_LANE_OBSERVATION_SCHEMA,
    source: LOCAL_LANE_SOURCE,
    effect: 'NONE',
    authority: 'NONE',
    observedAt,
    lanes: ordered,
    revision: localLaneObservationRevision({ observedAt, lanes: ordered }),
  });
}
