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
 * THE SECOND AXIS, ADDED IN R0 OF THE ARTIFACT COMPLETION SIGNALS
 * ---------------------------------------------------------------
 * A provider can write its exact terminal artifact marker while wmux still reports the wrapper as
 * `running`, so process liveness and task completion are two different facts and this module now
 * carries both vocabularies. `lifecycle` is what wmux observed about a process and is unchanged;
 * `taskStates` is what the artifact bytes prove about the work, derived only from an explicit,
 * operator-authored, content-addressed `gaia-lane-artifact-bindings/1` record. Neither is ever
 * inferred from the other. docs/artifact-completion-signals.md is the normative contract.
 *
 * This module reads nothing, opens nothing, and holds no clock. It imports `node:crypto` for the
 * digests and `node:path` for the two lexical path rules, both of which are pure.
 */

import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';

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
  'schema', 'source', 'effect', 'authority', 'observedAt', 'lanes', 'taskStates', 'revision',
]);
export const LOCAL_LANE_FIELDS = Object.freeze([
  'workspaceId', 'paneId', 'surfaceId', 'agentId', 'label', 'labelState', 'lifecycle',
]);

// ---------------------------------------------------------------------------
// gaia-lane-artifact-bindings/1 — the operator-authored input, and nothing else
// ---------------------------------------------------------------------------

/** The closed input document. It is read; it is never produced by an observation. */
export const LANE_ARTIFACT_BINDINGS_SCHEMA = 'gaia-lane-artifact-bindings/1';

/** The two inner schemas exist only as digest domain separators, never as published documents. */
const LANE_ARTIFACT_BINDING_RECORD_SCHEMA = 'gaia-lane-artifact-binding-record/1';
const LANE_COMPLETION_EVIDENCE_SCHEMA = 'gaia-lane-completion-evidence/1';

export const LANE_ARTIFACT_BINDINGS_FIELDS = Object.freeze([
  'schema', 'effect', 'authority', 'bindings', 'revision',
]);
export const LANE_ARTIFACT_BINDING_FIELDS = Object.freeze([
  'workspaceId', 'paneId', 'surfaceId', 'agentId',
  'allowedRoot', 'artifactPath', 'completionMarker', 'sourceRevision',
]);

/** The closed task-state vocabulary. Five answers, and no sixth. */
export const LANE_TASK_STATES = Object.freeze([
  'UNBOUND', 'RUNNING', 'COMPLETED_EVIDENCE', 'REFUSED_EVIDENCE', 'UNKNOWN',
]);

/**
 * Every reason names exactly one state.
 *
 * A reason is not a caption. Publishing them as a map rather than as a list is what lets the
 * verifier refuse a tampered pair — `COMPLETED_EVIDENCE` beside `ARTIFACT_IN_PROGRESS` is a
 * contradiction an operator would otherwise have to notice by reading.
 *
 * Null-prototype, so `constructor` and `toString` are not evidence reasons.
 */
export const LANE_EVIDENCE_REASONS = Object.freeze(Object.assign(Object.create(null), {
  NO_BINDING: 'UNBOUND',
  ARTIFACT_IN_PROGRESS: 'RUNNING',
  NO_COMPLETION_EVIDENCE: 'UNKNOWN',
  MARKER_VERIFIED: 'COMPLETED_EVIDENCE',
  DUPLICATE_MARKER: 'REFUSED_EVIDENCE',
  MARKER_NOT_TERMINAL: 'REFUSED_EVIDENCE',
  PATH_ESCAPES_ALLOWED_ROOT: 'REFUSED_EVIDENCE',
  NOT_A_REGULAR_FILE: 'REFUSED_EVIDENCE',
  ARTIFACT_TOO_LARGE: 'REFUSED_EVIDENCE',
  ARTIFACT_UNSTABLE: 'REFUSED_EVIDENCE',
  ARTIFACT_UNREADABLE: 'REFUSED_EVIDENCE',
  NO_ARTIFACT_OBSERVATION: 'REFUSED_EVIDENCE',
  COMPLETION_EVIDENCE_CONTRADICTED: 'REFUSED_EVIDENCE',
  REFUSAL_IS_STICKY_WITHIN_GENERATION: 'REFUSED_EVIDENCE',
}));

/** The subset a process boundary may return about one artifact read. */
export const ARTIFACT_REFUSAL_REASONS = Object.freeze([
  'PATH_ESCAPES_ALLOWED_ROOT', 'NOT_A_REGULAR_FILE', 'ARTIFACT_TOO_LARGE',
  'ARTIFACT_UNSTABLE', 'ARTIFACT_UNREADABLE',
]);

export const LANE_TASK_STATE_FIELDS = Object.freeze([
  'workspaceId', 'paneId', 'surfaceId', 'agentId',
  'processLifecycle', 'taskState', 'evidenceReason',
  'bindingRevision', 'generation',
  'artifactDigest', 'completionObservedAt', 'completionEvidenceRevision',
]);

/** Document-size bounds. The union of observed lanes and declared bindings is bounded by both. */
export const MAX_ARTIFACT_BINDINGS = 64;
export const MAX_LANE_TASK_STATES = 128;

/**
 * A generation counter, bounded so it stays a small readable integer rather than a clock.
 *
 * A million restarts of one pane is not reachable by any operator; the bound exists so the field
 * cannot be grown into a duration by a caller who increments it on a timer.
 */
export const MAX_LANE_GENERATION = 1_000_000;

/** Four mebibytes of handoff is already implausible; past it the sensor refuses rather than reads. */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

/** Long enough for a real Windows worktree path, short enough to bound every comparison. */
export const MAX_LOCAL_PATH_LENGTH = 512;

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * ASCII graphic characters only, and never a space.
 *
 * A marker is compared byte for byte. Admitting Unicode would put normalisation, confusables and
 * invisible code points between "the provider wrote its marker" and "the sensor found it", and
 * every one of those differences resolves in favour of whoever chose the bytes.
 */
const COMPLETION_MARKER = /^[\x21-\x7E]{8,200}$/u;

export const isSha256Hex = (value) => typeof value === 'string' && SHA256_HEX.test(value);
export const isSafeCompletionMarker = (value) => typeof value === 'string'
  && COMPLETION_MARKER.test(value);

/**
 * One equality carries the whole lexical path rule: `resolve(p) === p`.
 *
 * That refuses relative paths, `.` and `..` segments, trailing separators, duplicated separators
 * and every other non-canonical spelling in a single check on both platforms, without a bespoke
 * traversal parser — and a bespoke traversal parser is the thing that has a bypass in it.
 *
 * The leading-double-separator refusal is the network boundary: a UNC path is not a local file,
 * and this product opens no network.
 */
export const isSafeLocalPath = (value) => typeof value === 'string'
  && value.length > 0 && value.length <= MAX_LOCAL_PATH_LENGTH
  && !value.includes('\u0000')
  && !value.startsWith(`${sep}${sep}`) && !value.startsWith('//')
  && isAbsolute(value)
  && resolve(value) === value;

/**
 * The allowed root is a fence, not a hint: the artifact must be strictly beneath it.
 *
 * Prefix equality is deliberate rather than `path.relative`, because `relative` answers a
 * navigation question and this is a containment question. `/root-evil/x` shares a prefix with
 * `/root` and is refused precisely because the separator is required.
 */
export const isBoundArtifactPath = ({ allowedRoot, artifactPath } = {}) => isSafeLocalPath(allowedRoot)
  && isSafeLocalPath(artifactPath)
  && artifactPath.length > allowedRoot.length + sep.length
  && artifactPath.startsWith(`${allowedRoot}${sep}`);

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

/**
 * The content address of one binding record, over all eight of its fields.
 *
 * This is what a task state names instead of naming a path. The observation already excludes
 * `cmd` because it carries local absolute paths, and a completion signal that published
 * `artifactPath` would put back exactly what that exclusion removed. An operator resolves this
 * digest against the binding file they wrote.
 *
 * The inner schema string is a digest domain separator, so a binding record and a completion
 * evidence tuple with coincidentally equal fields cannot address to the same value.
 */
export function laneArtifactBindingRevision(binding = {}) {
  return createHash('sha256').update(canonicalJson({
    schema: LANE_ARTIFACT_BINDING_RECORD_SCHEMA,
    ...projectArtifactBinding(binding),
  })).digest('hex');
}

/** The content address of the whole binding document, re-derived by its verifier. */
export function laneArtifactBindingsRevision({ bindings = [] } = {}) {
  return createHash('sha256').update(canonicalJson({
    schema: LANE_ARTIFACT_BINDINGS_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    bindings: bindings.map(projectArtifactBinding),
  })).digest('hex');
}

/**
 * The content address of one completion, over the binding, the generation, the digest and the
 * instant it was first seen.
 *
 * `processLifecycle` is deliberately outside the recipe: it is the OTHER axis, it moves on its own
 * schedule while a completion stays true, and folding it in would make a wrapper exiting look like
 * the completion changing.
 */
export function laneCompletionEvidenceRevision({
  workspaceId, paneId, surfaceId, agentId,
  bindingRevision, generation, artifactDigest, completionObservedAt,
} = {}) {
  return createHash('sha256').update(canonicalJson({
    schema: LANE_COMPLETION_EVIDENCE_SCHEMA,
    workspaceId,
    paneId,
    surfaceId,
    agentId,
    bindingRevision,
    generation,
    artifactDigest,
    completionObservedAt,
  })).digest('hex');
}

/** Rebuilt in one fixed key order, so bytes cannot depend on how a caller built the object. */
const projectArtifactBinding = (binding) => ({
  workspaceId: binding.workspaceId,
  paneId: binding.paneId,
  surfaceId: binding.surfaceId,
  agentId: binding.agentId,
  allowedRoot: binding.allowedRoot,
  artifactPath: binding.artifactPath,
  completionMarker: binding.completionMarker,
  sourceRevision: binding.sourceRevision,
});

const projectLaneTaskState = (state) => ({
  workspaceId: state.workspaceId,
  paneId: state.paneId,
  surfaceId: state.surfaceId,
  agentId: state.agentId,
  processLifecycle: state.processLifecycle,
  taskState: state.taskState,
  evidenceReason: state.evidenceReason,
  bindingRevision: state.bindingRevision,
  generation: state.generation,
  artifactDigest: state.artifactDigest,
  completionObservedAt: state.completionObservedAt,
  completionEvidenceRevision: state.completionEvidenceRevision,
});

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
  // The second axis, verified against the first rather than beside it. Absent means the key is
  // omitted: a present `null` is refused rather than read as absence, for the same reason the
  // control room refuses a null lane block — that spelling is the one an editor reaches for.
  if (Object.hasOwn(value, 'taskStates')) {
    if (!Array.isArray(value.taskStates)) {
      refuse('an absent task state list omits the field entirely, and never publishes null');
    }
    requireLaneTaskStates(value.taskStates, value.lanes, refuse);
  }
  return deepFreeze(value);
}

/**
 * Total verification of the task-state axis, against the lanes it must agree with.
 *
 * The load-bearing check is the last group: `processLifecycle` is not believed, it is compared to
 * the lifecycle the lane it names actually reported. Without that comparison the two axes are two
 * strings in one document rather than two facts about one pane, and a resealed observation could
 * report a completed task beside a lane that says nothing of the sort.
 */
function requireLaneTaskStates(taskStates, lanes, refuse) {
  if (taskStates.length > MAX_LANE_TASK_STATES) {
    refuse(`an observation carries at most ${MAX_LANE_TASK_STATES} task states`);
  }
  const laneByKey = new Map(lanes.map((lane) => [laneOrderKey(lane), lane]));

  let previous = null;
  for (const state of taskStates) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      refuse('a task state must be an object');
    }
    for (const field of Object.keys(state)) {
      if (!LANE_TASK_STATE_FIELDS.includes(field)) {
        refuse(`a task state carries an unknown field ${JSON.stringify(field)}`);
      }
    }
    for (const identity of ['workspaceId', 'paneId', 'surfaceId', 'agentId']) {
      if (!isSafeLaneIdentity(state[identity])) {
        refuse(`a task state ${identity} is not a bounded identity`);
      }
    }
    if (!LANE_TASK_STATES.includes(state.taskState)) {
      refuse(`a task state must be one of ${LANE_TASK_STATES.join(', ')}`);
    }
    // A reason is not a caption: it names one state, and a pair that disagrees is a contradiction.
    if (LANE_EVIDENCE_REASONS[state.evidenceReason] !== state.taskState) {
      refuse(
        `the evidence reason ${JSON.stringify(state.evidenceReason)} does not name the state`
        + ` ${JSON.stringify(state.taskState)}`,
      );
    }
    if (!Number.isSafeInteger(state.generation)
        || state.generation < 0 || state.generation > MAX_LANE_GENERATION) {
      refuse(`a task state generation must be an integer from 0 through ${MAX_LANE_GENERATION}`);
    }
    // Unbound is the one state with no binding, and every other state has exactly one.
    if (state.taskState === 'UNBOUND'
      ? state.bindingRevision !== null
      : !isSha256Hex(state.bindingRevision)) {
      refuse('a bound task state names its binding by content address, and an unbound one names none');
    }
    // The three evidence fields are present exactly when there is a completion to address.
    if (state.taskState === 'COMPLETED_EVIDENCE') {
      if (!isSha256Hex(state.artifactDigest) || !isExactInstant(state.completionObservedAt)
          || !isSha256Hex(state.completionEvidenceRevision)) {
        refuse('a completion carries a digest, an exact instant and a content address, or it is not one');
      }
      if (state.completionEvidenceRevision !== laneCompletionEvidenceRevision(state)) {
        refuse('the completion evidence revision does not address its own binding, digest and instant');
      }
    } else if (state.artifactDigest !== null || state.completionObservedAt !== null
        || state.completionEvidenceRevision !== null) {
      refuse('only a completion may carry completion evidence; a partial completion is not one');
    }
    if (!LOCAL_LANE_LIFECYCLES.includes(state.processLifecycle)) {
      refuse(`a task state processLifecycle must be one of ${LOCAL_LANE_LIFECYCLES.join(', ')}`);
    }
    // Work cannot be in progress in a process that is not running. Completion can outlive it,
    // which is the whole reason these are two fields.
    if (state.taskState === 'RUNNING' && state.processLifecycle !== LOCAL_LANE_LIVE_LIFECYCLE) {
      refuse('a task state of RUNNING requires a process lifecycle that is actually running');
    }
    const key = laneOrderKey(state);
    const lane = laneByKey.get(key) ?? null;
    if (lane === null
      ? state.processLifecycle !== 'UNKNOWN'
      : lane.paneId !== state.paneId || lane.lifecycle !== state.processLifecycle) {
      refuse(
        'a task state processLifecycle must be the lifecycle its own lane reported, and UNKNOWN'
        + ' when no lane reported one',
      );
    }
    if (previous !== null && ordinal(previous, key) >= 0) {
      refuse('task states must be in strictly ascending identity order, with no repeated identity');
    }
    previous = key;
  }
}

/**
 * Total verification of one `gaia-lane-artifact-bindings/1` input document.
 *
 * A malformed operator statement refuses the WHOLE document rather than the record that broke,
 * because a partly-honoured statement is a statement nobody made. That asymmetry against the
 * artifact rules — where one bad file refuses one lane — is deliberate and stated in the design.
 */
export function requireLaneArtifactBindings(value) {
  const refuse = (message) => {
    throw new LocalLaneObservationError('InvalidLaneArtifactBindings', message);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('a Gaia lane artifact binding document is required');
  }
  for (const field of Object.keys(value)) {
    if (!LANE_ARTIFACT_BINDINGS_FIELDS.includes(field)) {
      refuse(`the binding document carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  if (value.schema !== LANE_ARTIFACT_BINDINGS_SCHEMA
      || value.effect !== 'NONE' || value.authority !== 'NONE'
      || typeof value.revision !== 'string' || !Array.isArray(value.bindings)) {
    refuse('an authority-free Gaia lane artifact binding document is required');
  }
  if (value.bindings.length > MAX_ARTIFACT_BINDINGS) {
    refuse(`a binding document carries at most ${MAX_ARTIFACT_BINDINGS} bindings`);
  }

  let previous = null;
  for (const binding of value.bindings) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      refuse('a binding must be an object');
    }
    for (const field of Object.keys(binding)) {
      if (!LANE_ARTIFACT_BINDING_FIELDS.includes(field)) {
        refuse(`a binding carries an unknown field ${JSON.stringify(field)}`);
      }
    }
    for (const identity of ['workspaceId', 'paneId', 'surfaceId', 'agentId']) {
      // The sentinel is refused HERE and nowhere else: `UNKNOWN` is the honest answer for an
      // identity wmux never supplied, and a binding that named it would match every such lane.
      if (!isSafeLaneIdentity(binding[identity]) || binding[identity] === UNKNOWN_IDENTITY) {
        refuse(`a binding ${identity} must be a bounded identity, and never the UNKNOWN sentinel`);
      }
    }
    if (!isBoundArtifactPath(binding)) {
      refuse('a binding artifact path must be a safe local path strictly beneath its allowed root');
    }
    if (!isSafeCompletionMarker(binding.completionMarker)) {
      refuse('a completion marker must be 8 to 200 ASCII graphic characters, with no whitespace');
    }
    if (!isSha256Hex(binding.sourceRevision)) {
      refuse('a binding source revision must be 64 lowercase hexadecimal characters');
    }
    const key = laneOrderKey(binding);
    if (previous !== null && ordinal(previous, key) >= 0) {
      refuse('bindings must be in strictly ascending identity order, with no repeated identity');
    }
    previous = key;
  }

  if (value.revision !== laneArtifactBindingsRevision(value)) {
    refuse('the binding document revision does not match its content');
  }
  return deepFreeze(value);
}

/** Seal one binding document: order the records, verify the whole value, content-address it. */
export function sealLaneArtifactBindings({ bindings = [] } = {}) {
  if (!Array.isArray(bindings)) {
    throw new LocalLaneObservationError('InvalidLaneArtifactBindings', 'bindings must be an array');
  }
  const ordered = [...bindings]
    .map((binding) => {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
        throw new LocalLaneObservationError(
          'InvalidLaneArtifactBindings', 'a binding must be an object',
        );
      }
      for (const field of Object.keys(binding)) {
        if (!LANE_ARTIFACT_BINDING_FIELDS.includes(field)) {
          throw new LocalLaneObservationError(
            'InvalidLaneArtifactBindings',
            `a binding carries an unknown field ${JSON.stringify(field)}`,
          );
        }
      }
      return projectArtifactBinding(binding);
    })
    .sort((left, right) => ordinal(laneOrderKey(left), laneOrderKey(right)));

  return requireLaneArtifactBindings({
    schema: LANE_ARTIFACT_BINDINGS_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    bindings: ordered,
    revision: laneArtifactBindingsRevision({ bindings: ordered }),
  });
}

/**
 * Seal one observation: order the lanes, verify the whole value, and content-address it.
 *
 * Ordering here rather than in every caller is what makes two readings of the same lane set
 * byte-identical; the verifier still enforces the order, so a hand-written file gets no
 * dispensation the sensor enjoys.
 */
export function sealLocalLaneObservation({ observedAt, lanes = [], taskStates = null } = {}) {
  if (!Array.isArray(lanes)) {
    throw new LocalLaneObservationError('InvalidLocalLaneObservation', 'lanes must be an array');
  }
  if (taskStates !== null && !Array.isArray(taskStates)) {
    throw new LocalLaneObservationError(
      'InvalidLocalLaneObservation', 'taskStates must be an array when it is supplied',
    );
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

  // Ordered and re-projected exactly as the lanes are, so two readings of the same evidence are
  // byte-identical however the caller happened to build them. An omitted list stays omitted, so
  // an observation with no second axis is the same document it has always been.
  const orderedTaskStates = taskStates === null ? null : [...taskStates]
    .map((state) => {
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new LocalLaneObservationError(
          'InvalidLocalLaneObservation', 'a task state must be an object',
        );
      }
      for (const field of Object.keys(state)) {
        if (!LANE_TASK_STATE_FIELDS.includes(field)) {
          throw new LocalLaneObservationError(
            'InvalidLocalLaneObservation',
            `a task state carries an unknown field ${JSON.stringify(field)}`,
          );
        }
      }
      return projectLaneTaskState(state);
    })
    .sort((left, right) => ordinal(laneOrderKey(left), laneOrderKey(right)));

  return requireLocalLaneObservation({
    schema: LOCAL_LANE_OBSERVATION_SCHEMA,
    source: LOCAL_LANE_SOURCE,
    effect: 'NONE',
    authority: 'NONE',
    observedAt,
    lanes: ordered,
    ...(orderedTaskStates === null ? {} : { taskStates: orderedTaskStates }),
    revision: localLaneObservationRevision({ observedAt, lanes: ordered }),
  });
}
