/**
 * local-lane-sensor.mjs — structured wmux agent metadata to one sealed local lane observation.
 *
 * This is the whole sensor, and it is a pure function. It holds no clock, opens no file, spawns
 * no process, calls no provider and mutates nothing; the process boundary that actually invokes
 * `wmux agent list` lives in `scripts/local-lane-sensor.mjs` and hands its parsed output here.
 *
 * WHAT IT READS, AND WHY A SEVENTH FIELD IS UNREACHABLE
 * ----------------------------------------------------
 * Six fields, by name, one at a time. A live `wmux agent list` record also carries `cmd` — a full
 * command line with local absolute paths — plus `pid`, `spawnTime` and `exitCode`, and a future
 * wmux could add a screen, a prompt or a transcript. None of them can reach an observation,
 * because this function never spreads a record and never iterates its keys: it names what it
 * wants and builds a new object. A negative control proves the property rather than asserting it,
 * but the property is a construction either way.
 *
 * `spawnTime` is available and stays unread on purpose. The moment a lane elapsed time is
 * published, something will divide it by something, and R0 measures liveness only.
 *
 * WHAT IT REFUSES, AND WHAT IT WITHHOLDS
 * --------------------------------------
 * A malformed identity refuses the whole observation, because an identity is the address an
 * operator uses to find the pane and a wrong one is worse than none. A label is a name rather
 * than an address, so an unreadable one is withheld under its own `labelState` and its lane is
 * still reported — dropping the lane would under-report exactly the lanes the operator is hunting
 * for, and rewriting the label would rename someone's work.
 *
 * A status outside the exact map is `UNKNOWN`, never live. There is no prefix match, no case
 * folding and no fuzzy match, so `Running`, `running-ish` and a status invented three wmux
 * releases from now all fail the same closed way.
 *
 * THE SECOND AXIS
 * ---------------
 * `deriveLaneTaskStates` is the other half of this module and is pure in exactly the same way: it
 * takes lanes, operator-authored bindings, ALREADY-READ artifact evidence, the previous tick's
 * task states and one instant, and returns the state machine's answer. It opens no file — the
 * artifact reads live at the same process boundary the wmux read does.
 *
 * The two axes never learn from each other. A wrapper that outlives its provider makes
 * `RUNNING` beside `COMPLETED_EVIDENCE` the normal reading rather than a contradiction, and the
 * whole point of R0 is that both can be said at once. docs/artifact-completion-signals.md.
 */

import {
  ARTIFACT_REFUSAL_REASONS, LANE_TASK_STATES, LOCAL_LANE_LIFECYCLES, LOCAL_LANE_LABEL_STATES,
  MAX_LANE_GENERATION, UNKNOWN_IDENTITY,
  isSafeLaneIdentity, isSafeLaneLabel, isSha256Hex, laneArtifactBindingRevision,
  laneCompletionEvidenceRevision, laneOrderKey, sealLocalLaneObservation,
} from './local-lane-observation.mjs';

/** The exact metadata fields this sensor reads. It reads these and cannot reach a seventh. */
export const WMUX_LANE_METADATA_FIELDS = Object.freeze([
  'workspaceId', 'paneId', 'surfaceId', 'agentId', 'label', 'status',
]);

/** Exact-equality status map. Null-prototype, so `constructor` is not a wmux status. */
export const WMUX_STATUS_LIFECYCLE = Object.freeze(Object.assign(Object.create(null), {
  running: 'RUNNING',
  exited: 'EXITED',
}));

export class LocalLaneSensorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalLaneSensorError';
    this.code = code;
  }
}

/**
 * Absent is `UNKNOWN`; present and readable is verbatim; present and malformed is a refusal.
 *
 * The middle case is the one worth stating: a bounded identity that wmux actually emits passes
 * through untouched, so the value an operator reads on the page is the value they can paste into
 * `wmux agent status`.
 */
function identity(record, field) {
  const value = record[field];
  if (value === undefined || value === null) return UNKNOWN_IDENTITY;
  if (!isSafeLaneIdentity(value)) {
    throw new LocalLaneSensorError(
      'LaneIdentityUnreadable',
      `a wmux ${field} of ${JSON.stringify(value)} is not a bounded identity;`
      + ' refusing the observation rather than publishing an address that does not resolve',
    );
  }
  return value;
}

/**
 * Three closed answers about a name, never a fourth and never a silent drop.
 *
 * The unsafe branch is the security-relevant one: a label may be chosen by whoever spawned the
 * pane, so it is the one field an observed process can influence. It is withheld rather than
 * cleaned, because cleaning would publish a transformation of attacker-shaped input instead of
 * refusing to publish it.
 */
function name(record) {
  const value = record.label;
  if (value === undefined || value === null) return { label: null, labelState: 'ABSENT' };
  if (typeof value !== 'string') {
    throw new LocalLaneSensorError(
      'LaneLabelUnreadable', 'a wmux label must be a string or absent',
    );
  }
  return isSafeLaneLabel(value)
    ? { label: value, labelState: 'OBSERVED' }
    : { label: null, labelState: 'WITHHELD_UNSAFE' };
}

/** Exact equality only. Everything else is `UNKNOWN`, which is never live. */
function lifecycle(record) {
  const status = record.status;
  const mapped = typeof status === 'string' ? WMUX_STATUS_LIFECYCLE[status] : undefined;
  return mapped === undefined ? 'UNKNOWN' : mapped;
}

/**
 * Observe every lane in one already-parsed `wmux agent list` payload.
 *
 * `agents` is the structured array the CLI emits. Silence is not an empty result: anything that
 * is not an exact array of objects is a refusal, because an observation that quietly reports zero
 * lanes is indistinguishable from the operator failure this sensor exists to fix.
 */
export function observeLocalLanes({
  agents, observedAt,
  bindings = [], artifactEvidence = new Map(), previousTaskStates = [],
} = {}) {
  if (!Array.isArray(agents)) {
    throw new LocalLaneSensorError(
      'AgentsUnreadable',
      "structured wmux agent metadata is required: an exact 'agents' array, never terminal text",
    );
  }
  const lanes = agents.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new LocalLaneSensorError(
        'AgentsUnreadable', 'each wmux agent record must be a structured object',
      );
    }
    // Six named reads. Nothing here spreads the record or walks its keys, so `cmd`, `pid`,
    // `spawnTime`, a screen, a prompt or a transcript cannot travel with the lane.
    return {
      workspaceId: identity(record, 'workspaceId'),
      paneId: identity(record, 'paneId'),
      surfaceId: identity(record, 'surfaceId'),
      agentId: identity(record, 'agentId'),
      ...name(record),
      lifecycle: lifecycle(record),
    };
  });

  const seen = new Set();
  for (const lane of lanes) {
    const key = laneOrderKey(lane);
    if (seen.has(key)) {
      throw new LocalLaneSensorError(
        'DuplicateLaneIdentity',
        `wmux reported the lane ${key} twice; refusing rather than counting one lane as two`,
      );
    }
    seen.add(key);
  }
  return sealLocalLaneObservation({
    observedAt,
    lanes,
    taskStates: deriveLaneTaskStates({
      lanes, bindings, artifactEvidence, previousTaskStates, observedAt,
    }),
  });
}

// ---------------------------------------------------------------------------
// the second axis: what the artifact bytes prove about the work
// ---------------------------------------------------------------------------

/** The three closed answers a process boundary may give about one artifact. */
export const ARTIFACT_EVIDENCE_OUTCOMES = Object.freeze(['ABSENT', 'READ', 'REFUSED']);

/** Only ASCII whitespace may follow a terminal marker. Prose may not. */
const TRAILING_ASCII_WHITESPACE = /^[\r\n\t ]*$/u;

/** An internal sentinel: bound, readable, and carrying no completion yet. Never published. */
const PENDING = 'PENDING';

/**
 * Occurrences counted with overlap, advancing one code unit at a time.
 *
 * A non-overlapping count would read `AAAA` as one occurrence of `AAA` and let a second marker
 * hide inside the first. The marker vocabulary makes this unlikely and the counter makes it
 * impossible, which is the difference between a convention and a rule.
 */
function countOccurrences(text, marker) {
  let count = 0;
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) count += 1;
  return count;
}

/**
 * One artifact observation to one evidence verdict, with no memory and no clock.
 *
 * A structurally invalid outcome throws rather than degrading: it can only come from this
 * product's own boundary, so it is a defect rather than an input, and swallowing it would let a
 * boundary bug read as work in progress.
 */
function evaluateArtifact(binding, outcome) {
  const verdict = (taskState, evidenceReason, artifactDigest = null) => ({
    taskState, evidenceReason, artifactDigest,
  });
  if (outcome === undefined) {
    // Bound, but the boundary reported nothing at all. Failing closed here is what stops a
    // dropped read from being indistinguishable from a file that does not exist yet.
    return verdict('REFUSED_EVIDENCE', 'NO_ARTIFACT_OBSERVATION');
  }
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)
      || !ARTIFACT_EVIDENCE_OUTCOMES.includes(outcome.outcome)) {
    throw new LocalLaneSensorError(
      'ArtifactEvidenceUnreadable',
      `an artifact observation must be one of ${ARTIFACT_EVIDENCE_OUTCOMES.join(', ')}`,
    );
  }
  if (outcome.outcome === 'REFUSED') {
    if (!ARTIFACT_REFUSAL_REASONS.includes(outcome.reason)) {
      throw new LocalLaneSensorError(
        'ArtifactEvidenceUnreadable',
        `a refused artifact names one of ${ARTIFACT_REFUSAL_REASONS.join(', ')}`,
      );
    }
    return verdict('REFUSED_EVIDENCE', outcome.reason);
  }
  if (outcome.outcome === 'ABSENT') return verdict(PENDING, null);

  if (!isSha256Hex(outcome.digest) || typeof outcome.text !== 'string') {
    throw new LocalLaneSensorError(
      'ArtifactEvidenceUnreadable', 'a read artifact carries a sha256 digest and decoded text',
    );
  }
  const occurrences = countOccurrences(outcome.text, binding.completionMarker);
  if (occurrences === 0) return verdict(PENDING, null);
  if (occurrences > 1) return verdict('REFUSED_EVIDENCE', 'DUPLICATE_MARKER');
  const after = outcome.text.slice(
    outcome.text.indexOf(binding.completionMarker) + binding.completionMarker.length,
  );
  // A marker in a place the contract does not allow is evidence of something, and the honest
  // report is a refusal rather than "still working".
  if (!TRAILING_ASCII_WHITESPACE.test(after)) {
    return verdict('REFUSED_EVIDENCE', 'MARKER_NOT_TERMINAL');
  }
  return verdict('COMPLETED_EVIDENCE', 'MARKER_VERIFIED', outcome.digest);
}

/**
 * The whole state machine, as one pure function of five inputs.
 *
 * It opens nothing, holds no clock and calls no provider: `artifactEvidence` is already-read
 * evidence keyed by lane identity, and `observedAt` is supplied. Given the same five inputs it
 * returns byte-identical output, which is what makes replay a test rather than a claim.
 *
 * One entry per identity in the union of observed lanes and declared bindings, so a lane with no
 * binding is reported UNBOUND rather than omitted, and a binding whose pane wmux never reported
 * is still evaluated rather than forgotten.
 */
export function deriveLaneTaskStates({
  lanes = [], bindings = [], artifactEvidence = new Map(),
  previousTaskStates = [], observedAt,
} = {}) {
  const laneByKey = new Map(lanes.map((lane) => [laneOrderKey(lane), lane]));
  const bindingByKey = new Map(bindings.map((binding) => [laneOrderKey(binding), binding]));
  const previousByKey = new Map(
    previousTaskStates.map((state) => [laneOrderKey(state), state]),
  );
  const keys = [...new Set([...laneByKey.keys(), ...bindingByKey.keys()])].sort();

  return keys.map((key) => {
    const lane = laneByKey.get(key) ?? null;
    const binding = bindingByKey.get(key) ?? null;
    const previous = previousByKey.get(key) ?? null;

    // The order key does not carry `paneId`, so a binding could match a lane on three identities
    // and disagree on the fourth. That is an operator error whose silent resolution would bind an
    // artifact to a pane nobody named, so it refuses rather than picks.
    if (lane !== null && binding !== null && lane.paneId !== binding.paneId) {
      throw new LocalLaneSensorError(
        'BindingIdentityMismatch',
        `a binding names pane ${JSON.stringify(binding.paneId)} where wmux reported`
        + ` ${JSON.stringify(lane.paneId)}; refusing rather than binding to a pane nobody named`,
      );
    }
    const identity = lane ?? binding;
    const processLifecycle = lane === null ? 'UNKNOWN' : lane.lifecycle;
    const bindingRevision = binding === null ? null : laneArtifactBindingRevision(binding);

    // A generation is one continuous run of one bound agent. Two things end it: the binding
    // content-addressing differently, and the pane returning to RUNNING after leaving it. Nothing
    // is carried across the boundary, which is what stops a restart inheriting a completion.
    const sameBinding = previous !== null && previous.bindingRevision === bindingRevision;
    const restarted = previous !== null
      && previous.processLifecycle !== 'RUNNING' && processLifecycle === 'RUNNING';
    const carried = previous !== null && sameBinding && !restarted ? previous : null;
    const generation = previous === null ? 0
      : previous.generation + (carried === null ? 1 : 0);
    if (generation > MAX_LANE_GENERATION) {
      throw new LocalLaneSensorError(
        'LaneGenerationExhausted',
        `lane ${key} has exceeded ${MAX_LANE_GENERATION} generations; refusing to keep counting`,
      );
    }

    const settled = reconcile({
      binding, carried, processLifecycle, observedAt, evidence: artifactEvidence.get(key),
    });
    const entry = {
      workspaceId: identity.workspaceId,
      paneId: identity.paneId,
      surfaceId: identity.surfaceId,
      agentId: identity.agentId,
      processLifecycle,
      taskState: settled.taskState,
      evidenceReason: settled.evidenceReason,
      bindingRevision,
      generation,
      artifactDigest: settled.artifactDigest,
      completionObservedAt: settled.completionObservedAt,
    };
    return {
      ...entry,
      completionEvidenceRevision: entry.taskState === 'COMPLETED_EVIDENCE'
        ? laneCompletionEvidenceRevision(entry)
        : null,
    };
  });
}

/**
 * This tick's verdict against the generation's history, and the only place monotonicity lives.
 *
 * A completion never reverts. Once a generation has published one, a tick that no longer finds
 * that exact digest publishes REFUSED_EVIDENCE rather than going back to RUNNING, because
 * "it was done and now it is working again" is not something an artifact can mean. A refusal is
 * sticky for the same reason: the generation already produced evidence nobody could reproduce.
 */
function reconcile({ binding, carried, processLifecycle, observedAt, evidence }) {
  const settled = (taskState, evidenceReason, artifactDigest = null, completionObservedAt = null) => ({
    taskState, evidenceReason, artifactDigest, completionObservedAt,
  });
  if (binding === null) return settled('UNBOUND', 'NO_BINDING');

  const verdict = evaluateArtifact(binding, evidence);
  if (carried !== null && carried.taskState === 'REFUSED_EVIDENCE') {
    return settled('REFUSED_EVIDENCE', 'REFUSAL_IS_STICKY_WITHIN_GENERATION');
  }
  if (carried !== null && carried.taskState === 'COMPLETED_EVIDENCE') {
    return verdict.taskState === 'COMPLETED_EVIDENCE'
      && verdict.artifactDigest === carried.artifactDigest
      // The first sighting is pinned. An instant that advanced every tick would be a pace signal.
      ? settled('COMPLETED_EVIDENCE', 'MARKER_VERIFIED', carried.artifactDigest, carried.completionObservedAt)
      : settled('REFUSED_EVIDENCE', 'COMPLETION_EVIDENCE_CONTRADICTED');
  }
  if (verdict.taskState === PENDING) {
    return processLifecycle === 'RUNNING'
      ? settled('RUNNING', 'ARTIFACT_IN_PROGRESS')
      : settled('UNKNOWN', 'NO_COMPLETION_EVIDENCE');
  }
  return settled(
    verdict.taskState, verdict.evidenceReason, verdict.artifactDigest,
    verdict.taskState === 'COMPLETED_EVIDENCE' ? observedAt : null,
  );
}

/** Re-exported so a reader of this module sees the vocabularies it maps onto, in one place. */
export { LOCAL_LANE_LIFECYCLES, LOCAL_LANE_LABEL_STATES, LANE_TASK_STATES };
