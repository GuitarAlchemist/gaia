/**
 * Pure read model for Gaia's operator-facing control room.
 *
 * The input is an already reconciled portfolio-drain projection. This module grants no
 * authority, performs no I/O, and never turns an open-ended portfolio into a fabricated
 * project-completion percentage.
 */

import { createHash } from 'node:crypto';

import { FACTORY_TELEMETRY_PROJECTION_SCHEMA } from './factory-telemetry.mjs';
import {
  requireControlRoomActivity, summarizeControlRoomActivity,
} from './control-room-activity.mjs';
import {
  PORTFOLIO_DRAIN_OBSTRUCTION_SCHEMA,
  PORTFOLIO_DRAIN_OBSTRUCTION_STATES,
  classifyPortfolioDrainObstruction,
} from './portfolio-drain-obstruction.mjs';

export const CONTROL_ROOM_SCHEMA = 'gaia-control-room/1';

const HEARTBEAT_FRESH_MS = 30_000;
const LIVE_TELEMETRY_RUN_STATES = new Set(['RUNNING', 'IN_GATE']);
const RUNNING_STAGES = new Set([
  'worker_running', 'initial_review_running', 'repair_running', 'final_review_running',
]);
const LIFECYCLE_PROGRESS = Object.freeze({
  QUEUED: [0, 'Claim a bounded factory run'],
  CLAIMED: [1, 'Start the authorized factory run'],
  RUNNING: [2, 'Build and independently review the candidate'],
  CANDIDATE_READY: [3, 'Publish the reviewed candidate'],
  AWAITING_MERGE_AUTHORITY: [4, 'Obtain explicit merge authority'],
  PUBLISHED: [4, 'Merge or close the published pull request'],
  TERMINAL_MERGED: [5, 'Complete'],
  TERMINAL_CLOSED: [5, 'Complete'],
});
const BLOCKED_STATES = new Set([
  'BLOCKED_DEPENDENCY', 'BLOCKED_DRAFT', 'BLOCKED_EVIDENCE', 'BLOCKED_HUMAN',
  'BLOCKED_POLICY', 'BLOCKED_REVIEW', 'BLOCKED_TRIAGE', 'BLOCKED_UNKNOWN',
  'FAILED_AUTHORITY_CONSUMED', 'RECONCILE_REQUIRED',
]);
const PARTIAL_KNOWLEDGE_STATES = new Set([
  'READY_WITH_UNKNOWN', 'CHECKS_UNKNOWN', 'REVIEW_UNKNOWN',
  'CHECKS_AND_REVIEW_UNKNOWN',
]);
const KNOWN_KNOWLEDGE_STATES = new Set([
  'READY', 'BLOCKED_DEPENDENCY', 'AWAITING_HUMAN', 'DRAFT', 'BLOCKED_REVIEW',
  'DUPLICATE', 'ARCHIVED', 'NEEDS_TRIAGE',
]);
const UNOBSERVED_KNOWLEDGE_STATES = new Set([
  'EVIDENCE_UNKNOWN', 'MISSING_FROM_OPEN_SNAPSHOT',
]);

/**
 * What kind of thing the window start is, over a closed two-value vocabulary.
 *
 * `MEASURED` says the start is evidence of *earlier* observation: a verified first-observation
 * instant this publisher carried forward, or an input timestamp at or before the instant it was
 * observed. `UNOBSERVED` says the publisher had no such evidence at all and the window therefore
 * begins at the observation instant.
 *
 * Both publish a window; only one of them publishes a measurement. Without this field a window
 * the publisher declined to measure and a window it measured as one instant old were byte-equal,
 * and `Evidence age 0s` — the single most reassuring reading available — was printed for both.
 */
const EVIDENCE_BASES = new Set(['MEASURED', 'UNOBSERVED']);

export class ControlRoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlRoomError';
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

function requireProjection(value) {
  if (!value || value.schema !== 'gaia-portfolio-drain-projection/1'
      || value.effect !== 'NONE' || value.authority !== 'NONE'
      || !Array.isArray(value.items) || !Array.isArray(value.decisions)) {
    throw new ControlRoomError(
      'InvalidProjection', 'an authority-free Gaia portfolio-drain projection is required',
    );
  }
  const { revision, ...body } = value;
  const expectedRevision = createHash('sha256').update(canonicalJson(body)).digest('hex');
  if (typeof revision !== 'string' || revision !== expectedRevision) {
    throw new ControlRoomError(
      'InvalidProjection', 'the portfolio-drain projection revision does not match its content',
    );
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function requireTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ControlRoomError('InvalidObservation', 'observedAt must be an ISO timestamp');
  }
  return value;
}

/**
 * `UNOBSERVED` is a statement about what the publisher lacked, so it can only ever describe a
 * window that starts where the observation does. Allowing it over a longer window would let the
 * marker dress up a measurement nobody took, which is the defect it exists to remove.
 */
function requireEvidenceBasis(basis, sourceChangedAt, observedAt) {
  if (!EVIDENCE_BASES.has(basis)
      || (basis === 'UNOBSERVED' && sourceChangedAt !== observedAt)) {
    throw new ControlRoomError(
      'InvalidEvidenceBasis',
      'the source-changed-at basis must be MEASURED, or UNOBSERVED over a window that starts at'
      + ' the instant it was observed',
    );
  }
  return basis;
}

function latestProgressByItem(observations) {
  if (!Array.isArray(observations)) {
    throw new ControlRoomError('InvalidObservation', 'progressObservations must be an array');
  }
  const latest = new Map();
  for (const observation of observations) {
    if (!observation || typeof observation.itemId !== 'string'
        || typeof observation.capturedAt !== 'string'
        || !Number.isFinite(Date.parse(observation.capturedAt))
        || observation.record?.schema !== 'gaia-cli-progress/1') {
      throw new ControlRoomError('InvalidObservation', 'progress observation shape is invalid');
    }
    const previous = latest.get(observation.itemId);
    const previousAt = previous ? Date.parse(previous.capturedAt) : Number.NEGATIVE_INFINITY;
    const currentAt = Date.parse(observation.capturedAt);
    if (previous && previousAt === currentAt
        && canonicalJson(previous.record) !== canonicalJson(observation.record)) {
      throw new ControlRoomError(
        'InvalidObservation', 'conflicting progress observations share one item and timestamp',
      );
    }
    if (!previous || previousAt < currentAt) {
      latest.set(observation.itemId, observation);
    }
  }
  return latest;
}

/**
 * The telemetry projection is evidence, so it is verified rather than trusted: an
 * unsupported schema, a claimed authority, a selected run that is absent, or content that
 * moved under an unchanged revision all fail closed instead of animating the operator view.
 */
function requireTelemetryProjection(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)
      || value.schema !== FACTORY_TELEMETRY_PROJECTION_SCHEMA
      || value.effect !== 'NONE' || value.authority !== 'NONE'
      || !Array.isArray(value.runs) || !Array.isArray(value.items)
      || typeof value.revision !== 'string') {
    throw new ControlRoomError(
      'InvalidTelemetry', 'a content-addressed factory telemetry projection is required',
    );
  }
  const { revision, ...body } = value;
  if (createHash('sha256').update(canonicalJson(body)).digest('hex') !== revision) {
    throw new ControlRoomError(
      'InvalidTelemetry', 'the telemetry projection revision does not match its content',
    );
  }
  return value;
}

/**
 * Resolve the one run the spine selected per item, and refuse any run observed after this
 * snapshot instant. A fact from the future is a forged or misconfigured sensor, never news.
 */
function selectTelemetryRuns(projection, observedAtMs) {
  if (projection === null) return new Map();
  const runs = new Map();
  for (const run of projection.runs) {
    const lastEventMs = Date.parse(run?.lastEventAt);
    if (!Number.isFinite(lastEventMs) || lastEventMs > observedAtMs) {
      throw new ControlRoomError(
        'InvalidTelemetry', 'a telemetry run reports evidence after the snapshot instant',
      );
    }
    runs.set(run.runId, run);
  }
  const selected = new Map();
  for (const { itemId, runId } of projection.items) {
    const run = runs.get(runId);
    if (!run || run.itemId !== itemId) {
      throw new ControlRoomError(
        'InvalidTelemetry', 'the telemetry projection selects a run it does not carry',
      );
    }
    selected.set(itemId, run);
  }
  return selected;
}

/** Freshness is decided here, against this observer's clock and one explicit window. */
function itemTelemetry(run, observedAtMs) {
  if (!run) return null;
  const heartbeatMs = run.lastHeartbeatAt === null
    ? Number.NaN : Date.parse(run.lastHeartbeatAt);
  return {
    runId: run.runId,
    lane: run.lane,
    agent: run.agent,
    itemRevision: run.itemRevision,
    runState: run.runState,
    currentGate: run.currentGate,
    blocker: run.blocker,
    lastTransition: run.lastTransition,
    lastHeartbeatAt: run.lastHeartbeatAt,
    heartbeatFresh: Number.isFinite(heartbeatMs)
      && observedAtMs >= heartbeatMs
      && observedAtMs - heartbeatMs <= HEARTBEAT_FRESH_MS,
    freshnessWindowMs: HEARTBEAT_FRESH_MS,
    evidenceAgeMs: observedAtMs - Date.parse(run.lastEventAt),
    elapsedMs: run.elapsedMs,
  };
}

function itemProgress(drainState) {
  const value = LIFECYCLE_PROGRESS[drainState];
  if (!value) {
    return {
      completedGates: null,
      totalGates: 5,
      percentage: null,
      currentGate: 'Resolve the named blocker before measuring progress',
    };
  }
  return {
    completedGates: value[0],
    totalGates: 5,
    percentage: value[0] * 20,
    currentGate: value[1],
  };
}

function itemActivity(item, observation, observedAtMs, telemetry) {
  // Telemetry is the stronger evidence: it is a verified transition chain rather than a
  // best-effort CLI line, so when a run is observed it decides the animation outright.
  if (telemetry !== null) {
    const live = LIVE_TELEMETRY_RUN_STATES.has(telemetry.runState);
    const moving = live && telemetry.heartbeatFresh;
    return {
      state: live ? (moving ? 'ACTIVE' : 'STALE') : 'IDLE',
      stage: telemetry.currentGate,
      elapsedMs: Number.isSafeInteger(telemetry.elapsedMs) ? telemetry.elapsedMs : null,
      lastHeartbeatAt: moving ? telemetry.lastHeartbeatAt : null,
      showPulse: moving,
    };
  }
  if (!['CLAIMED', 'RUNNING'].includes(item.drainState)) {
    return {
      state: 'IDLE', stage: null, elapsedMs: null, lastHeartbeatAt: null, showPulse: false,
    };
  }
  const stage = observation?.record?.stage ?? null;
  const capturedAtMs = observation ? Date.parse(observation.capturedAt) : Number.NaN;
  const fresh = Number.isFinite(capturedAtMs)
    && observedAtMs >= capturedAtMs
    && observedAtMs - capturedAtMs <= HEARTBEAT_FRESH_MS;
  const running = fresh && observation.record.heartbeat === true && RUNNING_STAGES.has(stage);
  return {
    state: running ? 'ACTIVE' : 'STALE',
    stage,
    elapsedMs: Number.isSafeInteger(observation?.record?.elapsedMs)
      ? observation.record.elapsedMs : null,
    lastHeartbeatAt: observation?.record?.heartbeat === true ? observation.capturedAt : null,
    showPulse: running && observation.record.heartbeat === true,
  };
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function measurePace(completedRuns) {
  if (!Array.isArray(completedRuns)) {
    throw new ControlRoomError('InvalidHistory', 'completedRuns must be an array');
  }
  for (const run of completedRuns) {
    if (!run || typeof run.workflow !== 'string' || typeof run.outcome !== 'string'
        || !Number.isSafeInteger(run.elapsedMs) || run.elapsedMs < 1) {
      throw new ControlRoomError('InvalidHistory', 'completed run shape is invalid');
    }
  }
  const durations = completedRuns
    .filter(({ workflow, outcome }) => (
      workflow === 'portfolio-factory-run' && outcome === 'COMPLETED'
    ))
    .map(({ elapsedMs }) => elapsedMs)
    .sort((left, right) => left - right);
  if (durations.length < 5) {
    return {
      pace: {
        state: 'UNKNOWN',
        sampleSize: durations.length,
        medianCycleMs: null,
        label: 'Unknown pace: fewer than 5 comparable completed runs.',
      },
      durations,
    };
  }
  const medianCycleMs = durations[Math.floor(durations.length / 2)];
  return {
    pace: {
      state: 'MEASURED',
      sampleSize: durations.length,
      medianCycleMs,
      label: `Historical median: ${formatDuration(medianCycleMs)} per comparable completed run.`,
    },
    durations,
  };
}

function forecastEta({ activeItems, pace, durations }) {
  if (activeItems.length === 0) return null;
  if (activeItems.length > 1) {
    return { state: 'UNKNOWN', label: 'Unknown', reason: 'More than one run is active.' };
  }
  if (pace.state !== 'MEASURED') {
    return {
      state: 'UNKNOWN', label: 'Unknown', reason: 'Insufficient comparable history.',
    };
  }
  const elapsedMs = activeItems[0].activity.elapsedMs;
  if (!Number.isSafeInteger(elapsedMs)) {
    return { state: 'UNKNOWN', label: 'Unknown', reason: 'Elapsed time is unavailable.' };
  }
  const lowerTotal = durations[Math.floor((durations.length - 1) * 0.25)];
  const upperTotal = durations[Math.ceil((durations.length - 1) * 0.75)];
  const remainingRangeMs = [
    Math.max(0, lowerTotal - elapsedMs),
    Math.max(0, upperTotal - elapsedMs),
  ];
  return {
    state: 'FORECAST',
    label: `Between ${formatDuration(remainingRangeMs[0])} and ${formatDuration(remainingRangeMs[1])}`,
    remainingRangeMs,
    sampleSize: pace.sampleSize,
    method: 'historical-interquartile-range',
  };
}

function blockerSummary(items) {
  const counts = new Map();
  const record = (state) => counts.set(state, (counts.get(state) ?? 0) + 1);
  for (const item of items) {
    if (BLOCKED_STATES.has(item.drainState)) record(item.drainState);
    if (item.telemetry === null) continue;
    // An observed run never simply stops being reported: it is either blocked by a named
    // token or its evidence expired, and both are blockages an operator can act on.
    if (item.telemetry.runState === 'BLOCKED') record(`TELEMETRY_${item.telemetry.blocker}`);
    else if (item.activity.state === 'STALE') record('TELEMETRY_HEARTBEAT_EXPIRED');
  }
  return [...counts.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((left, right) => right.count - left.count || left.state.localeCompare(right.state));
}

function knowledgeState(sourceState) {
  if (KNOWN_KNOWLEDGE_STATES.has(sourceState)) return 'KNOWN';
  if (PARTIAL_KNOWLEDGE_STATES.has(sourceState)) return 'PARTIAL';
  if (UNOBSERVED_KNOWLEDGE_STATES.has(sourceState)) return 'UNOBSERVED';
  return 'UNOBSERVED';
}

function measureKnowledgeCoverage(items) {
  const coverage = { known: 0, partial: 0, unobserved: 0 };
  for (const item of items) {
    coverage[item.knowledgeState.toLowerCase()] += 1;
  }
  const total = items.length;
  const knownPercentage = total === 0 ? null : Math.round((coverage.known / total) * 100);
  const frontierCount = coverage.partial + coverage.unobserved;
  return {
    ...coverage,
    total,
    knownPercentage,
    label: total === 0
      ? 'No portfolio items are available to classify.'
      : `${knownPercentage}% currently classified from sufficient evidence (${coverage.known}/${total}).`,
    caveat: 'Evidence coverage only — not completion, correctness or model confidence.',
    frontier: {
      kind: 'RECONNOITER_UNKNOWN_EVIDENCE',
      count: frontierCount,
      label: `Investigate ${frontierCount} partially observed or unobserved items.`,
    },
  };
}

/**
 * Total verification of one published `gaia-control-room/1` artifact.
 *
 * Exported because the file-fed adapter reads exactly these bytes back as its observation-window
 * carrier, and a reader of a published artifact must not be more credulous than its renderer. An
 * adapter that trusted three shallow fields could adopt a window start out of a file this
 * function refuses, and publish a stall measured in years over evidence observed for seconds.
 */
export function requireControlRoomSnapshot(value) {
  if (!value || value.schema !== CONTROL_ROOM_SCHEMA
      || value.effect !== 'NONE' || value.authority !== 'NONE'
      || !Array.isArray(value.items) || typeof value.revision !== 'string') {
    throw new ControlRoomError('InvalidSnapshot', 'a content-addressed Gaia control-room snapshot is required');
  }
  const { revision, ...body } = value;
  const expectedRevision = createHash('sha256').update(canonicalJson(body)).digest('hex');
  if (revision !== expectedRevision) {
    throw new ControlRoomError('InvalidSnapshot', 'the control-room snapshot revision does not match its content');
  }
  if (value.items.some((item) => item?.knowledgeState !== knowledgeState(item?.sourceState))) {
    throw new ControlRoomError('InvalidSnapshot', 'the control-room snapshot knowledge states are invalid');
  }
  const expectedCoverage = measureKnowledgeCoverage(value.items);
  if (canonicalJson(value.knowledgeCoverage) !== canonicalJson(expectedCoverage)) {
    throw new ControlRoomError('InvalidSnapshot', 'the control-room snapshot knowledge coverage is invalid');
  }
  requireEvidenceBasis(value.sourceChangedAtBasis, value.sourceChangedAt, value.observedAt);
  requireObstruction(value.obstruction, value);
  return value;
}

/**
 * The obstruction cannot be re-derived here — that needs the drain projection, which the
 * snapshot deliberately does not carry — so it is checked three ways instead: its own digest must
 * match its own content, its content must satisfy the invariants the classifier guarantees, and
 * it must be bound to the snapshot it is displayed with. A displayed obstruction that names no
 * recovery, or names a state outside the closed vocabulary, is refused rather than shown.
 *
 * The binding is the difference between "this obstruction is internally consistent" and "this
 * obstruction is about this evidence". Without it a self-consistent obstruction classified from
 * another projection over another window can be grafted into a resealed snapshot and rendered
 * beside a `sourceRevision` that contradicts every word of it. Full re-derivation is impossible
 * here; equality of three fields already in hand is not, and all three are checked.
 *
 * All three, because `endedAt` is the half of the window that cannot be stretched without also
 * lying about `observedAt`, which is bound — and `startedAt` is the half that lengthens it.
 * `buildControlRoomSnapshot` assigns the window start and `sourceChangedAt` from the same
 * variable, so this can refuse no snapshot the builder itself produced.
 */
function requireObstruction(obstruction, snapshot) {
  if (!obstruction || typeof obstruction !== 'object' || Array.isArray(obstruction)
      || obstruction.schema !== PORTFOLIO_DRAIN_OBSTRUCTION_SCHEMA
      || obstruction.effect !== 'NONE' || obstruction.authority !== 'NONE'
      || !PORTFOLIO_DRAIN_OBSTRUCTION_STATES.includes(obstruction.state)
      || !Array.isArray(obstruction.affectedItemIds)
      || obstruction.affectedCount !== obstruction.affectedItemIds.length
      || typeof obstruction.observationWindow?.durationMs !== 'number') {
    throw new ControlRoomError(
      'InvalidSnapshot', 'the control-room snapshot obstruction is not a Gaia obstruction',
    );
  }
  const { revision, ...body } = obstruction;
  if (revision !== createHash('sha256').update(canonicalJson(body)).digest('hex')) {
    throw new ControlRoomError(
      'InvalidSnapshot', 'the control-room snapshot obstruction revision does not match its content',
    );
  }
  const bounded = obstruction.state === 'NONE'
    ? obstruction.recovery === null
    : obstruction.recovery?.effect === 'NONE' && obstruction.recovery?.authority === 'NONE'
      && obstruction.recovery?.advisory === true
      && typeof obstruction.recovery?.kind === 'string';
  if (!bounded) {
    throw new ControlRoomError(
      'InvalidSnapshot',
      'a named obstruction must carry exactly one bounded advisory recovery, and NONE must carry none',
    );
  }
  if (obstruction.evidenceRevision !== snapshot.sourceRevision
      || obstruction.observationWindow.endedAt !== snapshot.observedAt
      || obstruction.observationWindow.startedAt !== snapshot.sourceChangedAt) {
    throw new ControlRoomError(
      'InvalidSnapshot',
      'the control-room snapshot obstruction is not bound to this snapshot evidence and window',
    );
  }
  return obstruction;
}

function blockerAction(blocker) {
  const labels = {
    BLOCKED_EVIDENCE: `${blocker.count} items need missing evidence before Gaia can schedule them.`,
    BLOCKED_HUMAN: `${blocker.count} items need a human decision.`,
    BLOCKED_DRAFT: `${blocker.count} draft pull requests need to become reviewable.`,
    BLOCKED_UNKNOWN: `${blocker.count} items need their unknown state investigated.`,
  };
  return {
    kind: `TRIAGE_${blocker.state}`,
    itemId: null,
    label: labels[blocker.state]
      ?? `${blocker.count} items require ${blocker.state.toLowerCase().replaceAll('_', ' ')} resolution.`,
  };
}

function nextActionFor(items, decisions, blockers) {
  const stale = items.find(({ activity }) => activity.state === 'STALE');
  if (stale) {
    return {
      kind: 'CHECK_STALE_RUN',
      itemId: stale.itemId,
      label: 'Check the run: its last heartbeat is stale.',
    };
  }
  const active = items.find(({ activity }) => activity.state === 'ACTIVE');
  if (active) {
    return {
      kind: 'OBSERVE_ACTIVE_RUN',
      itemId: active.itemId,
      label: 'Wait for the worker result, then run the independent review.',
    };
  }
  const decision = decisions[0];
  if (decision) {
    return {
      kind: decision.action,
      itemId: decision.itemId,
      label: decision.action === 'CLAIM_FACTORY_RUN'
        ? 'Authorize and claim the next bounded factory run.'
        : 'Prepare the authority-free publication intent.',
    };
  }
  if (blockers.length > 0) return blockerAction(blockers[0]);
  return { kind: 'NONE', itemId: null, label: 'No executable next action is available.' };
}

export function buildControlRoomSnapshot({
  drainProjection, observedAt, sourceChangedAt = observedAt,
  sourceChangedAtBasis = 'MEASURED',
  progressObservations = [], completedRuns = [], telemetryProjection = null,
  dependencies = null,
}) {
  const projection = requireProjection(drainProjection);
  const at = requireTimestamp(observedAt);
  const changedAt = requireTimestamp(sourceChangedAt);
  const basis = requireEvidenceBasis(sourceChangedAtBasis, changedAt, at);
  const observedAtMs = Date.parse(at);
  const latest = latestProgressByItem(progressObservations);
  const spine = requireTelemetryProjection(telemetryProjection);
  const selectedRuns = selectTelemetryRuns(spine, observedAtMs);
  const items = structuredClone(projection.items).map((item) => {
    const telemetry = itemTelemetry(selectedRuns.get(item.itemId) ?? null, observedAtMs);
    return {
      ...item,
      knowledgeState: knowledgeState(item.sourceState),
      progress: itemProgress(item.drainState),
      telemetry,
      activity: itemActivity(item, latest.get(item.itemId), observedAtMs, telemetry),
    };
  });
  const observedItemIds = new Set(items.map(({ itemId }) => itemId));
  const activeCount = items.filter(({ activity }) => activity.state === 'ACTIVE').length;
  const staleCount = items.filter(({ activity }) => activity.state === 'STALE').length;
  const blockers = blockerSummary(items);
  const blockedCount = blockers.reduce((total, blocker) => total + blocker.count, 0);
  const state = activeCount > 0 ? 'ACTIVE' : staleCount > 0 ? 'STALE' : 'PAUSED';
  const measured = measurePace(completedRuns);
  const activeItems = items.filter(({ activity }) => activity.state === 'ACTIVE');
  const forecast = forecastEta({ activeItems, ...measured });
  // Liveness is decided here, once, against this observer's clock, and handed to the
  // classifier already decided. The obstruction module re-measures no heartbeat, so "stale"
  // keeps meaning exactly one thing. The observation window is the interval over which this
  // publisher has continuously observed this exact projection revision — a measured lower bound
  // on the age of the evidence, never a claim about when the upstream world changed.
  //
  // Evidence dated after the instant it was observed is refused rather than clamped. R0 clamped
  // it to a zero-length window, which rendered as "Evidence age 0s" — a reassuring measurement
  // nobody took — and marked the substitution nowhere in the published evidence. A caller that
  // cannot say when its evidence was current gets a typed refusal and keeps its last complete
  // artifact set, which is the honest failure.
  if (Date.parse(changedAt) > observedAtMs) {
    throw new ControlRoomError(
      'IncoherentEvidence',
      `evidence dated ${changedAt} is after the instant it was observed, ${at};`
      + ' a clock or a source timestamp is wrong and no observation window can be measured',
    );
  }
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection,
    observedAt: at,
    windowStartedAt: changedAt,
    liveness: items.map(({ itemId, activity }) => ({ itemId, state: activity.state })),
    dependencies,
  });

  const body = {
    schema: CONTROL_ROOM_SCHEMA,
    observedAt: at,
    sourceChangedAt: changedAt,
    // Sealed into the snapshot revision, so the distinction between a window this publisher
    // measured and one it declined to measure cannot be added, removed or flipped without
    // breaking the digest. A distinction that lives only in prose does not reach a consumer.
    sourceChangedAtBasis: basis,
    sourceRevision: projection.revision,
    effect: 'NONE',
    authority: 'NONE',
    headline: state === 'PAUSED'
      ? {
        state: 'PAUSED',
        label: 'Paused',
        // An empty drain and a systemically blocked drain are operationally opposite and
        // used to share this one sentence. They no longer do.
        detail: obstruction.state === 'NONE'
          ? 'No tracked factory run is moving right now.'
          : `No tracked factory run is moving. ${obstruction.label}`,
      }
      : state === 'ACTIVE' ? {
        state: 'ACTIVE',
        label: 'Active',
        detail: `${activeCount} Gaia ${activeCount === 1 ? 'run is' : 'runs are'} moving.`,
      } : {
        state: 'STALE',
        label: 'Needs attention',
        detail: `${staleCount} recorded ${staleCount === 1 ? 'run has' : 'runs have'} no fresh heartbeat.`,
      },
    activeCount,
    staleCount,
    blockedCount,
    totalItems: items.length,
    capacity: { ...projection.counts },
    blockers,
    obstruction,
    showSpinner: items.some(({ activity }) => activity.showPulse),
    pace: measured.pace,
    eta: forecast ?? (activeCount === 0
      ? {
        state: 'UNKNOWN',
        label: 'Unknown',
        reason: staleCount > 0
          ? 'The heartbeat is stale; no reliable ETA exists.'
          : 'There is no active run to estimate.',
      }
      : {
        state: 'UNKNOWN',
        label: 'Unknown',
        reason: 'Insufficient comparable history.',
      }),
    portfolioCompletion: {
      percentage: null,
      reason: 'The portfolio is an open queue; it has no truthful global completion percentage.',
    },
    knowledgeCoverage: measureKnowledgeCoverage(items),
    telemetry: {
      observedRuns: spine === null ? 0 : spine.runs.length,
      activeRuns: items.filter(
        ({ telemetry, activity }) => telemetry !== null && activity.state === 'ACTIVE',
      ).length,
      staleRuns: items.filter(
        ({ telemetry, activity }) => telemetry !== null && activity.state === 'STALE',
      ).length,
      blockedRuns: items.filter(
        ({ telemetry }) => telemetry !== null && telemetry.runState === 'BLOCKED',
      ).length,
      unmatchedRuns: spine === null ? 0 : spine.items.filter(
        ({ itemId }) => !observedItemIds.has(itemId),
      ).length,
      freshnessWindowMs: HEARTBEAT_FRESH_MS,
      projectionRevision: spine === null ? null : spine.revision,
    },
    nextAction: nextActionFor(items, projection.decisions, blockers),
    items,
  };
  return deepFreeze({
    ...body,
    revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const RENDER_COPY = Object.freeze({
  en: Object.freeze({
    title: 'Gaia — real status', now: 'Now', next: 'Next action', progress: 'Verifiable progress',
    paceEta: 'Pace and ETA', evidence: 'Evidence', snapshot: 'Snapshot', source: 'Source projection',
    checked: 'Checked', changed: 'source changed', age: 'age', moving: 'Moving', stale: 'Stale',
    blocked: 'Blocked', slots: 'Free slots', currentGate: 'Current gate', noHeartbeat: 'No active heartbeat',
    staleHeartbeat: 'Stale heartbeat', realHeartbeat: 'Real heartbeat received', notMeasurable: 'Not measurable while blocked',
    pace: 'Pace', eta: 'ETA', backlog: 'Portfolio backlog', topWork: 'Highest-priority work',
    fog: 'Fog of war', known: 'Known', partial: 'Partial', unobserved: 'Unobserved',
    frontier: 'Reconnaissance frontier',
    more: 'more items remain in the content-addressed snapshot', noItems: 'No work items in this snapshot.',
    items: 'items', noBlockers: 'No blockers recorded.',
    readOnly: 'Read-only dashboard: effect=NONE and authority=NONE.', technical: 'Technical identities',
    run: 'Run', transition: 'Last verified transition', evidenceAge: 'Evidence age',
    notYetMeasured: 'Not yet measured',
    currentRun: 'Current run', stageOrGate: 'Current stage or gate', elapsedWork: 'Elapsed work',
    freshness: 'Evidence freshness',
    freshnessCaveat: 'A heartbeat proves the sensor is alive, not that work advanced.',
    nextCheckpoint: 'Next evidence checkpoint or blocker',
    noCurrentRun: 'No run is currently claimed or observed.',
    noneRecorded: 'None recorded', runSignals: 'Observed run signals', ago: 'ago',
    noBoundInstant: 'no bound instant', verified: 'verified', unverified: 'unverified',
    asOf: 'as of', of: 'of', share: 'share of portfolio',
    backlogCaveat: 'These counts are portfolio-wide and are not blockers of the current run.',
    operatorForecast: 'Operator forecast',
    forecastCaveat: 'Human-supplied; not measured from evidence and not used in the ETA.',
    activitySummary: 'Activity summary',
    state: { ACTIVE: 'Active', STALE: 'Needs attention', PAUSED: 'Paused' },
    evidenceState: { FRESH: 'Fresh', PARTIAL: 'Partial', STALE: 'Stale', UNKNOWN: 'Unknown' },
    bulletKind: { ACTION: 'Doing', RESULT: 'Produced', CHECKPOINT: 'Next', BLOCKER: 'Blocked' },
    obstruction: 'Why the drain is not moving', recovery: 'Bounded recovery',
    affected: 'Affected items', declaredEdges: 'Declared dependency evidence',
    obstructionState: {
      NONE: 'No obstruction detected', NO_ELIGIBLE_WORK: 'Empty drain',
      EVIDENCE_STARVATION: 'Missing evidence', LANE_STALE: 'Stale lane',
      DEPENDENCY_DEADLOCK: 'Declared dependency cycle', REVIEW_STARVATION: 'Missing review',
      AUTHORITY_STARVATION: 'Missing authority', RECONCILE_REQUIRED: 'Reconcile required',
      THROUGHPUT_STALL: 'Throughput stalled',
    },
  }),
  fr: Object.freeze({
    title: 'Gaia — état réel', now: 'Maintenant', next: 'Prochaine action', progress: 'Avancement vérifiable',
    paceEta: 'Rythme et ETA', evidence: 'Preuve', snapshot: 'Snapshot', source: 'Projection source',
    checked: 'Vérifié', changed: 'source modifiée', age: 'âge', moving: 'En cours', stale: 'Périmé',
    blocked: 'Bloqué', slots: 'Lanes libres', currentGate: 'Gate actuelle', noHeartbeat: 'Aucun heartbeat actif',
    staleHeartbeat: 'Heartbeat périmé', realHeartbeat: 'Heartbeat réel reçu', notMeasurable: 'Non mesurable tant que bloqué',
    pace: 'Rythme', eta: 'ETA', backlog: 'Backlog du portfolio', topWork: 'Travail prioritaire',
    fog: 'Brouillard de connaissance', known: 'Connu', partial: 'Partiel', unobserved: 'Non observé',
    frontier: 'Frontière de reconnaissance',
    more: 'autres éléments restent dans le snapshot content-addressed', noItems: 'Aucun élément dans ce snapshot.',
    items: 'éléments', noBlockers: 'Aucun blocage enregistré.',
    readOnly: 'Dashboard read-only : effect=NONE et authority=NONE.', technical: 'Identités techniques',
    run: 'Exécution', transition: 'Dernière transition vérifiée', evidenceAge: 'Âge de la preuve',
    notYetMeasured: 'Pas encore mesuré',
    currentRun: 'Exécution en cours', stageOrGate: 'Étape ou gate actuelle', elapsedWork: 'Temps de travail écoulé',
    freshness: 'Fraîcheur de la preuve',
    freshnessCaveat: 'Un heartbeat prouve que le capteur est vivant, pas que le travail a avancé.',
    nextCheckpoint: 'Prochaine preuve attendue ou blocage',
    noCurrentRun: 'Aucune exécution réclamée ni observée actuellement.',
    noneRecorded: 'Rien d’enregistré', runSignals: 'Signaux d’exécution observés', ago: 'plus tôt',
    noBoundInstant: 'aucun instant lié', verified: 'vérifié', unverified: 'non vérifié',
    asOf: 'au', of: 'sur', share: 'part du portfolio',
    backlogCaveat: 'Ces comptes concernent tout le portfolio et ne bloquent pas l’exécution en cours.',
    operatorForecast: 'Prévision opérateur',
    forecastCaveat: 'Fournie par un humain ; non mesurée à partir des preuves et exclue de l’ETA.',
    activitySummary: 'Résumé d’activité',
    state: { ACTIVE: 'En cours', STALE: 'À vérifier', PAUSED: 'En pause' },
    evidenceState: { FRESH: 'Fraîche', PARTIAL: 'Partielle', STALE: 'Périmée', UNKNOWN: 'Inconnue' },
    bulletKind: { ACTION: 'En cours', RESULT: 'Produit', CHECKPOINT: 'Ensuite', BLOCKER: 'Bloqué' },
    obstruction: 'Pourquoi le drain n’avance pas', recovery: 'Reprise bornée',
    affected: 'Éléments concernés', declaredEdges: 'Preuve de dépendances déclarée',
    obstructionState: {
      NONE: 'Aucun blocage détecté', NO_ELIGIBLE_WORK: 'Drain vide',
      EVIDENCE_STARVATION: 'Preuves manquantes', LANE_STALE: 'Lane périmée',
      DEPENDENCY_DEADLOCK: 'Cycle de dépendances déclaré', REVIEW_STARVATION: 'Review manquante',
      AUTHORITY_STARVATION: 'Autorité manquante', RECONCILE_REQUIRED: 'Réconciliation requise',
      THROUGHPUT_STALL: 'Débit à l’arrêt',
    },
  }),
});

/**
 * French is a presentation layer over the same closed `code` and the same bound `params`. It
 * derives no new fact and re-decides no state, exactly as `localizedObstructionLabel` already
 * does, so the published English sentence and the rendered French one cannot disagree about
 * anything except the language they are written in.
 */
const FR_ACTIVITY_TEXT = Object.freeze({
  IN_GATE: 'Dans la gate {gate}.',
  BETWEEN_GATES: 'En cours entre deux gates.',
  RUN_BLOCKED: 'Arrêté sur {blocker}.',
  RUN_FINISHED: 'Exécution arrêtée : terminée.',
  PROGRESS_STAGE: '{sentence} — rapporté par l’exécution elle-même, non vérifié.',
  PROGRESS_STAGE_UNRECOGNISED: 'Étape de progression non reconnue ; à traiter comme non observée.',
  LANE_CLAIMED_UNOBSERVED: 'Lane réclamée ; aucun enregistrement de démarrage observé.',
  LANE_RUNNING_UNOBSERVED: 'Enregistré comme en cours ; aucune exécution observée.',
  STATE_UNRECOGNISED: 'État d’exécution non reconnu {runState} ; à traiter comme non observé.',
  RUN_STARTED: 'Exécution démarrée.',
  GATE_ENTERED: 'Entrée dans la gate {gate}.',
  GATE_PASSED: 'Gate {gate} passée.',
  GATE_FAILED: 'Gate {gate} échouée.',
  RUN_BLOCKED_RESULT: 'Exécution bloquée sur {blocker}.',
  RUN_COMPLETED: 'Exécution terminée.',
  NO_VERIFIED_RESULT: 'Aucun résultat vérifié n’a été enregistré pour cet élément.',
  AWAIT_GATE_OUTCOME: 'Prochaine preuve vérifiable : gate.passed ou gate.failed sur {gate}.',
  AWAIT_GATE_OR_COMPLETION: 'Prochaine preuve vérifiable : un enregistrement gate.entered, ou run.completed.',
  AWAIT_DRAIN_RECONCILIATION: 'Exécution terminée ; le drain n’a pas enregistré la transition correspondante.',
  AWAIT_RUN_STARTED: 'Prochaine preuve vérifiable : un enregistrement run.started pour cette lane.',
  TELEMETRY_BLOCKED: 'Bloqué : {blocker}. L’exécution l’a enregistré et s’est arrêtée.',
  DRAIN_BLOCKED: 'Bloqué : {drainState}.',
});

const FR_STAGE_SENTENCES = Object.freeze({
  VALIDATING: 'Validation de l’exécution',
  EXECUTION_STARTING: 'Démarrage de l’exécution',
  AUTHORIZED_EXECUTION: 'Démarrage de l’exécution autorisée',
  WORKER_RUNNING: 'Worker en cours',
  WORKER_COMPLETED: 'Worker terminé',
  INITIAL_REVIEW_RUNNING: 'Review initiale en cours',
  INITIAL_REVIEW_VERDICT: 'Verdict de la review initiale',
  REPAIR_RUNNING: 'Réparation en cours',
  REPAIR_COMPLETED: 'Réparation terminée',
  FINAL_REVIEW_RUNNING: 'Review finale en cours',
  FINAL_REVIEW_VERDICT: 'Verdict de la review finale',
  TERMINAL_OUTCOME: 'Exécution terminée',
});

/** Four evidence states, each with a word and a symbol. Colour alone is never the meaning. */
const EVIDENCE_PRESENTATION = Object.freeze({
  FRESH: { severity: 'healthy', symbol: '●' },
  PARTIAL: { severity: 'warning', symbol: '◐' },
  STALE: { severity: 'warning', symbol: '▲' },
  UNKNOWN: { severity: 'neutral', symbol: '○' },
});

/**
 * A human forecast is the one sentence on this page Gaia did not derive, so it is fenced rather
 * than trusted: a short line of ordinary words and digits, with no colon, no slash and no angle
 * bracket, which leaves no room for a URL, a path, a credential or markup. It is labelled as
 * human-supplied wherever it appears and is excluded from every measured number beside it.
 */
const OPERATOR_FORECAST = /^[\p{L}\p{N} ,.;()'’–—-]{1,120}$/u;

function requireOperatorForecast(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !OPERATOR_FORECAST.test(value)) {
    throw new ControlRoomError(
      'InvalidOperatorForecast',
      'an operator forecast must be one short line of plain words, never a URL, path or markup',
    );
  }
  return value;
}

/**
 * The activity summary the document displays.
 *
 * Supplying it is additive and optional: with no option the renderer derives the same value from
 * the same snapshot, so the two calls are byte-identical. A value that *is* supplied is not
 * trusted — it is verified on its own terms and then bound to this snapshot, because internally
 * consistent is not the same as about this evidence. Without the binding a self-consistent
 * summary of another projection, at another instant, could be rendered beside a `sourceRevision`
 * that contradicts every sentence in it.
 */
function requireActivity(candidate, snapshot) {
  if (candidate === null || candidate === undefined) {
    return summarizeControlRoomActivity({ snapshot });
  }
  const refuse = (message) => {
    throw new ControlRoomError('InvalidActivity', message);
  };
  try {
    requireControlRoomActivity(candidate);
  } catch (error) {
    refuse(error?.message ?? 'the supplied activity summary is not a Gaia activity summary');
  }
  const known = new Set(snapshot.items.map(({ itemId }) => itemId));
  if (candidate.snapshotRevision !== snapshot.revision
      || candidate.observedAt !== snapshot.observedAt
      || candidate.sourceRevision !== snapshot.sourceRevision
      || candidate.telemetryRevision !== snapshot.telemetry.projectionRevision
      || candidate.items.some(({ itemId }) => !known.has(itemId))) {
    refuse('the supplied activity summary is not bound to this snapshot and its evidence');
  }
  return candidate;
}

function localizedHeadline(snapshot, language) {
  if (language === 'en') return snapshot.headline;
  const details = {
    PAUSED: snapshot.obstruction.state === 'NONE'
      ? 'Aucune exécution suivie de la factory ne progresse actuellement.'
      : `Aucune exécution suivie de la factory ne progresse. ${
        localizedObstructionLabel(snapshot.obstruction, 'fr')}`,
    ACTIVE: `${snapshot.activeCount} exécution${snapshot.activeCount === 1 ? '' : 's'} Gaia en cours.`,
    STALE: `${snapshot.staleCount} exécution${snapshot.staleCount === 1 ? '' : 's'} sans heartbeat récent.`,
  };
  return {
    state: snapshot.headline.state,
    label: RENDER_COPY.fr.state[snapshot.headline.state],
    detail: details[snapshot.headline.state],
  };
}

function localizedNextAction(snapshot, language) {
  if (language === 'en') return snapshot.nextAction.label;
  const blockerCount = snapshot.blockers.find(
    ({ state }) => `TRIAGE_${state}` === snapshot.nextAction.kind,
  )?.count ?? 0;
  const labels = {
    CHECK_STALE_RUN: 'Vérifier l’exécution : son dernier heartbeat est périmé.',
    OBSERVE_ACTIVE_RUN: 'Attendre le résultat du worker, puis lancer la review indépendante.',
    CLAIM_FACTORY_RUN: 'Autoriser et réclamer la prochaine exécution bornée de la factory.',
    PREPARE_PUBLICATION_INTENT: 'Préparer l’intention de publication sans autorité.',
    TRIAGE_BLOCKED_EVIDENCE: `${blockerCount} éléments nécessitent des preuves manquantes avant leur planification.`,
    TRIAGE_BLOCKED_HUMAN: `${blockerCount} éléments nécessitent une décision humaine.`,
    NONE: 'Aucune prochaine action exécutable n’est disponible.',
  };
  return labels[snapshot.nextAction.kind]
    ?? `${blockerCount} éléments nécessitent la résolution du blocage indiqué.`;
}

function localizedGate(item, language) {
  if (language === 'en') return item.progress.currentGate;
  return {
    QUEUED: 'Réclamer une exécution bornée de la factory',
    CLAIMED: 'Démarrer l’exécution autorisée de la factory',
    RUNNING: 'Construire puis faire relire indépendamment le candidat',
    CANDIDATE_READY: 'Publier le candidat relu',
    AWAITING_MERGE_AUTHORITY: 'Obtenir une autorisation explicite de fusion',
    PUBLISHED: 'Fusionner ou fermer la pull request publiée',
    TERMINAL_MERGED: 'Terminé',
    TERMINAL_CLOSED: 'Terminé',
  }[item.drainState] ?? 'Résoudre le blocage nommé avant de mesurer l’avancement';
}

/**
 * Pace is a calibration, not a verdict: `n/5` says how far this publisher is from the five
 * comparable completed runs the ETA policy requires, whether or not it has them yet. R0 printed
 * "fewer than 5", which told an operator nothing about whether the next run would close the gap.
 */
function localizedPace(snapshot, language) {
  const { state, sampleSize, medianCycleMs } = snapshot.pace;
  if (language === 'fr') {
    return state === 'MEASURED'
      ? `Calibration du rythme : ${sampleSize}/5 exécutions comparables terminées.`
        + ` Médiane historique : ${formatDuration(medianCycleMs)} par exécution.`
      : `Calibration du rythme : ${sampleSize}/5 exécutions comparables terminées.`
        + ' Rythme inconnu tant que cinq ne sont pas enregistrées.';
  }
  return state === 'MEASURED'
    ? `Pace calibration: ${sampleSize}/5 comparable completed runs.`
      + ` Historical median ${formatDuration(medianCycleMs)} per comparable completed run.`
    : `Pace calibration: ${sampleSize}/5 comparable completed runs.`
      + ' Pace is unknown until five are recorded.';
}

/**
 * When there is no statistical ETA, name the evidence that is missing rather than the mood.
 * "Insufficient comparable history." is true and unactionable; "3 more comparable completed
 * portfolio-factory-run samples" is the same fact with the operator's next move inside it.
 */
const ETA_MISSING_EVIDENCE = Object.freeze({
  en: Object.freeze({
    'Insufficient comparable history.': (snapshot) => (
      `${5 - snapshot.pace.sampleSize} more comparable completed portfolio-factory-run samples`
      + ` (${snapshot.pace.sampleSize} of 5 recorded).`
    ),
    'Elapsed time is unavailable.': () => 'the elapsed time of the active run.',
    'More than one run is active.': (snapshot) => (
      `a single active run; ${snapshot.activeCount} are active.`
    ),
    'The heartbeat is stale; no reliable ETA exists.': () => 'a fresh heartbeat for the recorded run.',
    'There is no active run to estimate.': () => 'an active run to estimate.',
  }),
  fr: Object.freeze({
    'Insufficient comparable history.': (snapshot) => (
      `${5 - snapshot.pace.sampleSize} exécutions comparables terminées de plus`
      + ` (${snapshot.pace.sampleSize} sur 5 enregistrées).`
    ),
    'Elapsed time is unavailable.': () => 'le temps écoulé de l’exécution active.',
    'More than one run is active.': (snapshot) => (
      `une seule exécution active ; ${snapshot.activeCount} le sont.`
    ),
    'The heartbeat is stale; no reliable ETA exists.': () => 'un heartbeat frais pour l’exécution enregistrée.',
    'There is no active run to estimate.': () => 'une exécution active à estimer.',
  }),
});

function localizedEta(snapshot, language) {
  if (snapshot.eta.state === 'FORECAST') {
    return language === 'fr'
      ? `Entre ${formatDuration(snapshot.eta.remainingRangeMs[0])} et ${formatDuration(snapshot.eta.remainingRangeMs[1])}`
        + ` · ${snapshot.eta.sampleSize} exécutions comparables · intervalle interquartile`
      : `${snapshot.eta.label} · ${snapshot.eta.sampleSize} comparable runs · interquartile range`;
  }
  const detail = ETA_MISSING_EVIDENCE[language][snapshot.eta.reason]?.(snapshot)
    ?? (language === 'fr' ? 'des preuves comparables suffisantes.' : 'sufficient comparable evidence.');
  return language === 'fr'
    ? `Inconnue · Preuve manquante : ${detail}`
    : `Unknown · Missing evidence: ${detail}`;
}

/**
 * The obstruction's own English sentence comes from the truth Module, so JSON and HTML cannot
 * disagree about it. French is a presentation layer over the same bound counts and window; it
 * derives no new fact and re-decides no state.
 */
function localizedObstructionLabel(obstruction, language) {
  if (language === 'en') return obstruction.label;
  const count = obstruction.affectedCount;
  const many = count === 1 ? '' : 's';
  return {
    NONE: 'Aucun blocage détectable avec ces preuves sur cette fenêtre.',
    NO_ELIGIBLE_WORK: 'Le drain est vide : aucun élément n’est éligible.',
    EVIDENCE_STARVATION: `${count} élément${many} bloqué${many} en attente de preuves que Gaia ne détient pas.`,
    LANE_STALE: `${count} lane${many} occupée${many} sans preuve de heartbeat vivante.`,
    DEPENDENCY_DEADLOCK: `${count} élément${many} sur un cycle de dépendances déclaré.`,
    REVIEW_STARVATION: `${count} élément${many} en attente d’une review qui n’arrive pas.`,
    AUTHORITY_STARVATION: `${count} élément${many} en attente d’une autorisation explicite.`,
    RECONCILE_REQUIRED: `${count} élément${many} dont la preuve enregistrée contredit l’observation.`,
    THROUGHPUT_STALL: `${count} élément${many} éligible${many} et de la capacité libre immobiles`
      + ` depuis ${formatDuration(obstruction.observationWindow.durationMs)}.`,
  }[obstruction.state];
}

function localizedRecoveryLabel(obstruction, language) {
  if (language === 'en') return obstruction.recovery.label;
  return {
    SURVEY_PORTFOLIO_FOR_NEW_WORK: 'Lancer un relevé read-only du portfolio : rien n’est éligible.',
    COLLECT_MISSING_EVIDENCE: 'Collecter les preuves manquantes des éléments nommés, puis réconcilier le drain.',
    CHECK_STALE_LANE: 'Vérifier les lanes nommées dont la preuve de heartbeat a expiré, puis réconcilier.',
    BREAK_DEPENDENCY_CYCLE: 'Retirer une arête de dépendance déclarée parmi les éléments nommés.',
    REQUEST_INDEPENDENT_REVIEW: 'Demander une review indépendante pour les éléments nommés.',
    REQUEST_EXPLICIT_AUTHORITY: 'Demander à un humain l’autorisation explicite attendue.',
    RECONCILE_DRAIN_EVIDENCE: 'Ré-observer les éléments nommés et réconcilier la chaîne de reçus.',
    CLAIM_QUEUED_WORK: 'Autoriser une exécution bornée de la factory pour le travail éligible.',
  }[obstruction.recovery.kind] ?? obstruction.recovery.label;
}

const OBSTRUCTION_SEVERITY = Object.freeze({
  NONE: 'healthy',
  NO_ELIGIBLE_WORK: 'neutral',
  LANE_STALE: 'warning',
  THROUGHPUT_STALL: 'warning',
  RECONCILE_REQUIRED: 'warning',
  EVIDENCE_STARVATION: 'blocked',
  REVIEW_STARVATION: 'blocked',
  AUTHORITY_STARVATION: 'blocked',
  DEPENDENCY_DEADLOCK: 'blocked',
});

/**
 * Why the drain is not moving: one named state, the age of the evidence that named it, the
 * items it affects and one bounded advisory recovery. No animation lives here — an obstruction
 * is a standing fact, and a spinner would suggest something is happening about it.
 */
function renderObstruction(snapshot, copy, language) {
  const { obstruction } = snapshot;
  // A window nobody measured must not print the most reassuring number available for it.
  const evidenceAge = snapshot.sourceChangedAtBasis === 'UNOBSERVED'
    ? copy.notYetMeasured
    : formatDuration(obstruction.observationWindow.durationMs);
  const affected = obstruction.affectedItemIds.length === 0
    ? ''
    : `<p class="evidence-line"><strong>${copy.affected}:</strong> `
      + `${obstruction.affectedItemIds.slice(0, 8).map(
        (itemId) => `<code>${escapeHtml(itemId)}</code>`,
      ).join(' ')}`
      + (obstruction.affectedItemIds.length > 8
        ? ` + ${obstruction.affectedItemIds.length - 8}` : '')
      + ` (${obstruction.affectedCount})</p>`;
  const recovery = obstruction.recovery === null
    ? ''
    : `<div class="fact">${copy.recovery} <code>${escapeHtml(obstruction.recovery.kind)}</code>`
      + `<strong>${escapeHtml(localizedRecoveryLabel(obstruction, language))}</strong></div>`;
  const declaredEdges = obstruction.dependencyEvidenceRevision === null
    ? ''
    : `<p class="evidence-line">${copy.declaredEdges}: `
      + `<code>${escapeHtml(obstruction.dependencyEvidenceRevision)}</code></p>`;
  return `<section class="section-panel" data-severity="${OBSTRUCTION_SEVERITY[obstruction.state]}">
    <h2>${copy.obstruction}</h2>
    <div class="facts">
      <div class="fact"><span class="semantic-symbol" aria-hidden="true">■</span>${escapeHtml(copy.obstructionState[obstruction.state])} <code>${escapeHtml(obstruction.state)}</code><strong>${escapeHtml(localizedObstructionLabel(obstruction, language))}</strong></div>
      <div class="fact">${copy.evidenceAge}<strong>${escapeHtml(evidenceAge)}</strong></div>
      ${recovery}
    </div>
    ${affected}
    ${declaredEdges}
    <p class="evidence-line"><code>${escapeHtml(obstruction.revision)}</code> · effect=NONE · authority=NONE</p>
  </section>`;
}

function activityText(bullet, language) {
  if (language === 'en') return bullet.text;
  const template = FR_ACTIVITY_TEXT[bullet.code];
  if (template === undefined) return bullet.text;
  const values = { ...bullet.params, sentence: FR_STAGE_SENTENCES[bullet.params.stage] };
  return template.replaceAll(/\{([a-zA-Z]+)\}/gu, (whole, key) => (
    Object.hasOwn(values, key) && values[key] !== undefined ? values[key] : whole
  ));
}

/** The age of one bullet's own evidence, derived here so no moving number lives in a digest. */
function bulletAge(bullet, snapshot, copy) {
  if (bullet.observedAt === null) return copy.noBoundInstant;
  return `${formatDuration(Date.parse(snapshot.observedAt) - Date.parse(bullet.observedAt))} ${copy.ago}`;
}

/** At most three sentences per live task: doing, produced, next — each naming its own evidence. */
function renderActivityBullets(entry, snapshot, copy, language) {
  if (!entry) return '';
  return `<ol class="activity-bullets">${entry.bullets.map((bullet) => {
    const shown = EVIDENCE_PRESENTATION[bullet.evidenceState];
    return `<li class="activity-bullet" data-kind="${escapeHtml(bullet.kind)}"`
      + ` data-code="${escapeHtml(bullet.code)}"`
      + ` data-evidence-state="${escapeHtml(bullet.evidenceState)}"`
      + ` data-severity="${shown.severity}">`
      + `<span class="semantic-symbol" aria-hidden="true">${shown.symbol}</span>`
      + `<span class="bullet-kind">${copy.bulletKind[bullet.kind]}</span>`
      + `<span class="bullet-text">${escapeHtml(activityText(bullet, language))}</span>`
      + `<span class="bullet-meta">${copy.evidenceState[bullet.evidenceState]}`
      + ` · <code>${escapeHtml(bullet.source)}</code>`
      + ` · ${bullet.verified ? copy.verified : copy.unverified}`
      + (bullet.evidenceRevision === null ? '' : ` · <code>${escapeHtml(bullet.evidenceRevision)}</code>`)
      + ` · ${escapeHtml(bulletAge(bullet, snapshot, copy))}</span></li>`;
  }).join('')}</ol>`;
}

const fact = (label, value, extra = '', attributes = '') => (
  `<div class="fact"${attributes}><span class="fact-label">${label}</span>`
  + `<strong>${value}</strong>${extra}</div>`
);

/**
 * The first and largest card, because it answers the operator's first question.
 *
 * Elapsed work and evidence freshness are two separate facts on purpose. R0 put a heartbeat chip
 * beside a gate label and let the reader decide which of them meant progress; a fresh ping means
 * only that a sensor is alive, and the card now says so in words next to the number.
 */
function renderCurrentRun(snapshot, activity, copy, language) {
  const entry = activity.items[0] ?? null;
  const item = entry === null
    ? null
    : snapshot.items.find(({ itemId }) => itemId === entry.itemId) ?? null;
  const headline = localizedHeadline(snapshot, language);
  const evidence = entry === null ? null : EVIDENCE_PRESENTATION[entry.evidenceState];
  const telemetry = item?.telemetry ?? null;
  const observedMs = Date.parse(snapshot.observedAt);
  // Never the raw self-reported stage string: the closed token the phrasebook already validated,
  // so nothing a running process chose freely is displayed as this run's current gate.
  const gate = telemetry?.currentGate ?? telemetry?.lastTransition?.gate
    ?? entry?.bullets[0]?.params?.stage ?? null;
  // This card is about one run, so `Now` is that run's own liveness, not the portfolio headline.
  // The portfolio state keeps its own chip in the header, where it is a statement about the queue.
  const liveness = item === null ? snapshot.headline.state : {
    ACTIVE: 'ACTIVE', STALE: 'STALE', IDLE: 'PAUSED',
  }[item.activity.state];
  const now = headlinePresentation(liveness);
  const elapsedMs = item?.activity?.elapsedMs ?? null;
  const heartbeatAt = telemetry?.lastHeartbeatAt ?? item?.activity?.lastHeartbeatAt ?? null;
  const closing = entry === null ? null : entry.bullets[2];
  const signals = snapshot.blockers.filter(({ state }) => state.startsWith('TELEMETRY_'));
  const transition = telemetry === null ? copy.noneRecorded
    : `<code>${escapeHtml(telemetry.lastTransition.event)}</code>`
      + (telemetry.lastTransition.gate === null
        ? '' : ` · <code>${escapeHtml(telemetry.lastTransition.gate)}</code>`);
  const transitionExtra = telemetry === null ? ''
    : `<span class="fact-note"><time>${escapeHtml(telemetry.lastTransition.observedAt)}</time>`
      + ` · <code>${escapeHtml(telemetry.lastTransition.evidenceRevision)}</code></span>`;
  const nextLine = closing === null
    ? escapeHtml(localizedObstructionLabel(snapshot.obstruction, language))
    : escapeHtml(activityText(closing, language));
  return `<section class="current-run" data-severity="${entry === null ? 'neutral' : evidence.severity}">
    <div class="section-heading"><h2>${copy.currentRun}</h2>${
  entry === null ? '' : `<span class="as-of"><code>${escapeHtml(entry.itemId)}</code>${
    entry.runId === null ? '' : ` · <code>${escapeHtml(entry.runId)}</code>`}${
    entry.lane === null ? '' : ` · <code>${escapeHtml(entry.lane)}</code>`}</span>`}</div>
    <div class="current-run-facts">
      ${fact(
    copy.now,
    `<span class="semantic-symbol" aria-hidden="true">${now.symbol}</span>${escapeHtml(copy.state[liveness])}`,
    `<span class="fact-note">${item === null ? escapeHtml(headline.detail)
      : `<code>${escapeHtml(item.telemetry?.runState ?? item.drainState)}</code>`}</span>`,
  )}
      ${fact(copy.stageOrGate, gate === null ? copy.noneRecorded : `<code>${escapeHtml(gate)}</code>`)}
      ${fact(copy.elapsedWork, elapsedMs === null ? copy.noneRecorded : escapeHtml(formatDuration(elapsedMs)))}
      ${fact(copy.transition, transition, transitionExtra)}
      ${fact(
    copy.freshness,
    entry === null
      ? copy.noneRecorded
      : `<span class="semantic-symbol" aria-hidden="true">${evidence.symbol}</span>${escapeHtml(copy.evidenceState[entry.evidenceState])}`,
    `<span class="fact-note">${heartbeatAt === null ? copy.noHeartbeat
      : `${escapeHtml(formatDuration(observedMs - Date.parse(heartbeatAt)))} ${copy.ago}`}`
        + ` — ${copy.freshnessCaveat}</span>`,
    ` data-evidence-state="${entry === null ? 'UNKNOWN' : escapeHtml(entry.evidenceState)}"`,
  )}
      ${fact(copy.nextCheckpoint, entry === null && snapshot.obstruction.state === 'NONE' ? copy.noCurrentRun : nextLine)}
    </div>
    ${signals.length === 0 ? '' : `<p class="evidence-line">${copy.runSignals}: ${signals.map(
    ({ state, count }) => `<code>${escapeHtml(state)}</code> ×${count}`,
  ).join(' · ')}</p>`}
  </section>`;
}

/**
 * The portfolio backlog, kept deliberately away from the current run.
 *
 * These counts are a property of the whole tracked queue, and R0 rendered them under "Why work is
 * blocked" beside the run card, where an operator reasonably read them as the reason *this* run
 * was not moving. They now carry their own scope, their own as-of instant, a total and a share,
 * and say in words what they are not. Run-level `TELEMETRY_*` signals stay with the run.
 */
function renderBacklog(snapshot, copy) {
  const portfolio = snapshot.blockers.filter(({ state }) => !state.startsWith('TELEMETRY_'));
  const total = snapshot.totalItems;
  const blocked = portfolio.reduce((sum, { count }) => sum + count, 0);
  const share = (count) => (total === 0 ? '—' : `${Math.round((count / total) * 100)}%`);
  const rows = portfolio.length === 0
    ? `<p class="empty">${copy.noBlockers}</p>`
    : `<div class="backlog-list wide-scroll">${portfolio.slice(0, 8).map(({ state, count }) => (
      `<div data-severity="blocked"><span><span class="semantic-symbol" aria-hidden="true">■</span>`
      + `<code>${escapeHtml(state)}</code></span><strong>${count}</strong>`
      + `<span class="backlog-share" title="${copy.share}">${share(count)}</span></div>`
    )).join('')}</div>`;
  return `<section class="section-panel" data-severity="neutral">
    <div class="section-heading"><h2>${copy.backlog}</h2>
      <span class="as-of">${copy.asOf} <time>${escapeHtml(snapshot.observedAt)}</time></span></div>
    <p class="evidence-line">${copy.backlogScope(total)}</p>
    ${rows}
    <p class="backlog-total"><strong>${blocked} ${copy.of} ${total} ${copy.items}</strong> · ${share(blocked)}</p>
    <p class="evidence-line">${copy.backlogCaveat}</p>
  </section>`;
}

/** Show the observed run itself: who, which gate, the last verified transition, its age. */
function renderTelemetry(item, copy) {
  const { telemetry } = item;
  if (!telemetry) return '';
  const gate = telemetry.currentGate ?? telemetry.lastTransition.gate;
  return `<p class="evidence-line telemetry-line">`
    + `<strong>${copy.run}:</strong> <code>${escapeHtml(telemetry.runId)}</code>`
    + ` · <code>${escapeHtml(telemetry.lane)}</code>/<code>${escapeHtml(telemetry.agent)}</code>`
    + (gate === null ? '' : ` · <strong>${copy.currentGate}:</strong> <code>${escapeHtml(gate)}</code>`)
    + ` · <strong>${copy.transition}:</strong> <code>${escapeHtml(telemetry.lastTransition.event)}</code>`
    + ` · <strong>${copy.evidenceAge}:</strong> ${escapeHtml(formatDuration(telemetry.evidenceAgeMs))}`
    + (telemetry.blocker === null
      ? ''
      : ` · <strong>${copy.blocked}:</strong> <code>${escapeHtml(telemetry.blocker)}</code>`)
    + `</p>`;
}

function renderProgress(item, snapshot, activity, copy, language) {
  const { progress, activity: liveness } = item;
  const entry = activity.items.find(({ itemId }) => itemId === item.itemId) ?? null;
  const severity = liveness.showPulse ? 'healthy'
    : liveness.state === 'STALE' ? 'warning'
      : BLOCKED_STATES.has(item.drainState) || item.telemetry?.runState === 'BLOCKED'
        ? 'blocked' : 'neutral';
  const heartbeat = liveness.showPulse
    ? `<span class="heartbeat-pulse" data-heartbeat-at="${escapeHtml(liveness.lastHeartbeatAt)}"`
      + ` role="status">${copy.realHeartbeat}</span>`
    : liveness.state === 'STALE'
      ? `<span class="signal stale" role="status">${copy.staleHeartbeat}</span>`
      : `<span class="signal">${copy.noHeartbeat}</span>`;
  const meter = progress.percentage === null
    ? `<span class="not-measurable">${copy.notMeasurable}</span>`
    : `<progress max="100" value="${progress.percentage}">${progress.percentage}%</progress>`
      + `<strong>${progress.percentage}%</strong>`;
  return `<article class="work-item" data-severity="${severity}">
    <div class="item-heading">
      <div><span class="repo">${escapeHtml(item.repository)}</span>
        <h3>${escapeHtml(item.title)}</h3></div>
      ${heartbeat}
    </div>
    <div class="meter">${meter}</div>
    <p><strong>${copy.currentGate}:</strong> ${escapeHtml(localizedGate(item, language))}</p>
    <p class="evidence-line"><code>${escapeHtml(item.drainState)}</code> · ${escapeHtml(item.itemKind)} #${item.itemNumber}</p>
    ${renderTelemetry(item, copy)}
    ${renderActivityBullets(entry, snapshot, copy, language)}
  </article>`;
}

function headlinePresentation(state) {
  return {
    ACTIVE: { severity: 'healthy', symbol: '●' },
    STALE: { severity: 'warning', symbol: '▲' },
    PAUSED: { severity: 'neutral', symbol: '○' },
  }[state];
}

/** Render one dependency-free, shareable operator artifact. */
export function renderControlRoomHtml(candidate, {
  language = 'en', activity = null, operatorForecast = null,
} = {}) {
  const snapshot = requireControlRoomSnapshot(candidate);
  const copy = RENDER_COPY[language];
  if (!copy) throw new ControlRoomError('InvalidLanguage', 'language must be en or fr');
  const forecast = requireOperatorForecast(operatorForecast);
  const summary = requireActivity(activity, snapshot);
  const prioritized = [...snapshot.items].sort((left, right) => {
    const rank = { ACTIVE: 0, STALE: 1, IDLE: 2 };
    return rank[left.activity.state] - rank[right.activity.state]
      || (right.progress.percentage ?? -1) - (left.progress.percentage ?? -1)
      || left.repository.localeCompare(right.repository)
      || left.itemNumber - right.itemNumber;
  });
  const visible = prioritized.slice(0, 3);
  const items = visible.length > 0
    ? visible.map((item) => renderProgress(item, snapshot, summary, copy, language)).join('\n')
    : `<p class="empty">${copy.noItems}</p>`;
  const remaining = Math.max(0, snapshot.items.length - visible.length);
  const coverage = snapshot.knowledgeCoverage;
  const coverageLabel = language === 'fr'
    ? coverage.total === 0
      ? 'Aucun élément du portfolio à classifier.'
      : `${coverage.knownPercentage}% actuellement classifié avec des preuves suffisantes (${coverage.known}/${coverage.total}).`
    : coverage.label;
  const coverageCaveat = language === 'fr'
    ? 'Couverture des preuves uniquement — ni avancement, ni exactitude, ni confiance du modèle.'
    : coverage.caveat;
  const frontierLabel = language === 'fr'
    ? `Examiner ${coverage.frontier.count} éléments partiellement observés ou non observés.`
    : coverage.frontier.label;
  const denominator = Math.max(coverage.total, 1);
  const knownWidth = (coverage.known / denominator) * 100;
  const partialWidth = (coverage.partial / denominator) * 100;
  const unobservedWidth = (coverage.unobserved / denominator) * 100;
  const pulseCss = snapshot.showSpinner
    ? `
      @keyframes heartbeat { 50% { outline-color: transparent; } }
      .heartbeat-pulse { animation: heartbeat 1.2s step-end infinite; }
      @media (prefers-reduced-motion: reduce) { .heartbeat-pulse { animation: none; } }`
    : '';
  const headline = headlinePresentation(snapshot.headline.state);
  const nextSeverity = snapshot.nextAction.kind === 'NONE' ? 'neutral'
    : snapshot.nextAction.kind === 'OBSERVE_ACTIVE_RUN' ? 'healthy' : 'warning';
  const backlogCopy = {
    ...copy,
    backlogScope: (total) => (language === 'fr'
      ? `Portée : l’ensemble du portfolio suivi, ${total} éléments.`
      : `Scope: the whole tracked portfolio, ${total} items.`),
  };
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>${copy.title}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; --bg: #07101c; --panel: #0d1928; --panel-2: #101f31; --line: #253750; --muted: #8fa3bd; --text: #f3f7fc; --green: #54dc91; --amber: #ffbd59; --red: #ff6b78; --blue: #6ea8fe; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    main { margin: 0 auto; max-width: 620px; padding: 16px; }
    main :where(section, article, div, p, ol, li, span) { min-width: 0; }
    header { border-bottom: 1px solid var(--line); display: grid; gap: 10px; margin-bottom: 18px; padding-bottom: 16px; }
    section { margin-bottom: 16px; }
    h1 { font-size: 23px; letter-spacing: -.02em; margin: 0 0 6px; }
    h2 { color: var(--muted); font-size: 12px; letter-spacing: .11em; margin: 0 0 10px; text-transform: uppercase; }
    h3 { font-size: 16px; line-height: 1.35; margin: 4px 0 0; }
    p { line-height: 1.45; }
    .as-of, .evidence-line, .repo, .bullet-meta, .fact-note { color: var(--muted); font-size: 12px; }
    .status-chip { border: 1px solid var(--line); font-size: 12px; font-weight: 750; justify-self: start; padding: 8px 11px; text-transform: uppercase; }
    [data-severity="healthy"] { --semantic: var(--green); }
    [data-severity="warning"] { --semantic: var(--amber); }
    [data-severity="blocked"] { --semantic: var(--red); }
    [data-severity="neutral"] { --semantic: #c8d2df; }
    .semantic-symbol { color: var(--semantic); font-weight: 900; margin-right: 5px; }
    .status-chip { border-color: var(--semantic); color: var(--semantic); }
    .hero { display: grid; gap: 14px; }
    .current-run, .next { background: var(--panel); border: 1px solid var(--line); padding: 18px; }
    .current-run { border-left: 4px solid var(--semantic, var(--blue)); }
    .next { border-left: 4px solid var(--semantic, var(--blue)); }
    .next code { display: block; margin-bottom: 12px; }
    .current-run-facts { display: grid; gap: 10px; }
    .fact { background: var(--panel-2); border-left: 3px solid var(--blue); padding: 13px; }
    .fact strong { display: block; font-size: 17px; line-height: 1.35; margin-top: 4px; }
    .fact-label { color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
    .fact-note { display: block; margin-top: 6px; }
    .metrics { display: grid; gap: 10px; }
    .metric { background: var(--panel-2); border: 1px solid var(--line); border-top: 2px solid var(--semantic, var(--line)); padding: 14px; }
    .metric span { color: var(--muted); display: block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
    .metric strong { display: block; font-size: 27px; margin-top: 5px; }
    .section-panel { background: var(--panel); border: 1px solid var(--line); padding: 18px; }
    .section-heading { align-items: baseline; display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; }
    .work-list { display: grid; gap: 10px; }
    .work-item { background: var(--panel-2); border: 1px solid var(--line); border-left: 3px solid var(--semantic, var(--line)); padding: 15px; }
    .item-heading { align-items: start; display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; }
    .heartbeat-pulse, .signal { border: 1px solid var(--green); color: var(--green); font-size: 10px; outline: 2px solid var(--green); outline-offset: 2px; padding: 4px 6px; white-space: nowrap; }
    .signal { border-color: #40516a; color: var(--muted); outline: 0; } .signal.stale { border-color: var(--amber); color: var(--amber); }
    .meter { align-items: center; display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) auto; margin-top: 16px; }
    progress { accent-color: var(--green); height: 10px; width: 100%; } .not-measurable { color: var(--amber); }
    .activity-bullets { display: grid; gap: 8px; list-style: none; margin: 14px 0 0; padding: 0; }
    .activity-bullet { border-left: 3px solid var(--semantic, var(--line)); display: grid; padding: 8px 0 8px 10px; }
    .bullet-kind { color: var(--muted); font-size: 10px; letter-spacing: .09em; text-transform: uppercase; }
    .bullet-text { font-size: 14px; line-height: 1.4; }
    .bullet-meta { margin-top: 3px; }
    .lower-grid { display: grid; gap: 14px; }
    .fog-grid { display: grid; gap: 16px; }
    .fog-meter { background: #050a12; border: 1px solid var(--line); display: flex; height: 18px; overflow: hidden; }
    .fog-meter span { display: block; }
    .fog-known { background: var(--green); } .fog-partial { background: var(--amber); } .fog-unobserved { background: #35435a; }
    .fog-counts { display: grid; gap: 8px; margin-top: 12px; }
    .fog-counts div { background: var(--panel-2); border: 1px solid var(--line); padding: 10px; }
    .fog-counts span { color: var(--muted); display: block; font-size: 11px; text-transform: uppercase; }
    .fog-counts strong { display: block; font-size: 22px; margin-top: 3px; }
    .fog-frontier { border-left: 3px solid var(--amber); margin: 0; padding-left: 14px; }
    .facts { display: grid; gap: 10px; }
    .backlog-list { display: grid; gap: 8px; }
    .backlog-list div { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 10px; justify-content: space-between; padding: 8px 0; }
    .backlog-list strong { font-size: 20px; margin-left: auto; }
    .backlog-share { color: var(--muted); font-size: 12px; min-width: 44px; text-align: right; }
    .backlog-total { margin: 12px 0 4px; }
    .evidence { align-items: start; display: grid; gap: 14px; }
    .wide-scroll { overflow-x: auto; }
    code { color: #bdd2f2; overflow-wrap: anywhere; } .empty { color: var(--muted); }
    @media (min-width: 768px) {
      main { max-width: 880px; padding: 22px; }
      header { align-items: end; display: flex; justify-content: space-between; }
      .current-run-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .work-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .lower-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .evidence { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .fog-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .fog-counts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (min-width: 1024px) {
      main { max-width: 1240px; padding: 26px 32px; }
      .hero { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
      .metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .work-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (min-width: 1440px) {
      main { max-width: 1600px; padding: 30px 44px; }
      .hero { grid-template-columns: minmax(0, 2.2fr) minmax(0, 1fr); }
      .current-run-facts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .work-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .lower-grid { grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); }
      .fog-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    }
    ${pulseCss}
  </style>
</head>
<body data-snapshot-at="${escapeHtml(snapshot.observedAt)}">
<main>
  <header>
    <div><h1>${copy.title}</h1>
    <div class="as-of">${copy.checked} <time>${escapeHtml(snapshot.observedAt)}</time> · ${copy.changed} <time>${escapeHtml(snapshot.sourceChangedAt)}</time> · ${copy.age} <span id="snapshot-age">…</span></div></div>
    <div class="status-chip" data-severity="${headline.severity}"><span class="semantic-symbol" aria-hidden="true">${headline.symbol}</span>${copy.state[snapshot.headline.state]}</div>
  </header>
  <section class="hero">
    ${renderCurrentRun(snapshot, summary, copy, language)}
    <div class="next" data-severity="${nextSeverity}">
      <h2>${copy.next}</h2>
      <code>${escapeHtml(snapshot.nextAction.kind)}</code>
      <div>${escapeHtml(localizedNextAction(snapshot, language))}</div>
    </div>
  </section>
  <section class="metrics" aria-label="Portfolio facts">
    <div class="metric" data-severity="healthy"><span><span class="semantic-symbol" aria-hidden="true">●</span>${copy.moving}</span><strong>${snapshot.activeCount}</strong></div>
    <div class="metric" data-severity="warning"><span><span class="semantic-symbol" aria-hidden="true">▲</span>${copy.stale}</span><strong>${snapshot.staleCount}</strong></div>
    <div class="metric" data-severity="blocked"><span><span class="semantic-symbol" aria-hidden="true">■</span>${copy.blocked}</span><strong>${snapshot.blockedCount}</strong></div>
    <div class="metric" data-severity="neutral"><span><span class="semantic-symbol" aria-hidden="true">○</span>${copy.slots}</span><strong>${snapshot.capacity.available}/${snapshot.capacity.occupied + snapshot.capacity.available}</strong></div>
  </section>
  ${renderObstruction(snapshot, copy, language)}
  <section class="section-panel">
    <div class="section-heading"><h2>${copy.progress}</h2><span class="as-of">${snapshot.totalItems} ${copy.items}</span></div>
    <h3>${copy.topWork}</h3>
    <div class="work-list">${items}</div>
    ${remaining > 0 ? `<p class="evidence-line">+ ${remaining} ${copy.more}.</p>` : ''}
    <p class="evidence-line">${language === 'fr'
    ? 'Le portfolio est une file ouverte ; il n’a pas de pourcentage global d’achèvement fiable.'
    : escapeHtml(snapshot.portfolioCompletion.reason)}</p>
  </section>
  <section class="lower-grid">
    <div class="section-panel">
      <h2>${copy.paceEta}</h2>
      <div class="facts">
        ${fact(copy.pace, escapeHtml(localizedPace(snapshot, language)))}
        ${fact(copy.eta, escapeHtml(localizedEta(snapshot, language)))}
        ${forecast === null ? '' : fact(
    copy.operatorForecast,
    `<span class="semantic-symbol" aria-hidden="true">○</span>${escapeHtml(forecast)}`,
    `<span class="fact-note">${copy.forecastCaveat}</span>`,
  )}
      </div>
    </div>
    ${renderBacklog(snapshot, backlogCopy)}
  </section>
  <section class="section-panel">
    <h2>${copy.fog}</h2>
    <div class="fog-grid">
      <div>
        <h3>${escapeHtml(coverageLabel)}</h3>
        <div class="fog-meter" role="img" aria-label="${escapeHtml(`${copy.known} ${coverage.known}, ${copy.partial} ${coverage.partial}, ${copy.unobserved} ${coverage.unobserved}`)}">
          <span class="fog-known" style="width:${knownWidth}%"></span>
          <span class="fog-partial" style="width:${partialWidth}%"></span>
          <span class="fog-unobserved" style="width:${unobservedWidth}%"></span>
        </div>
        <div class="fog-counts">
          <div><span>● ${copy.known}</span><strong>${coverage.known}</strong></div>
          <div><span>▲ ${copy.partial}</span><strong>${coverage.partial}</strong></div>
          <div><span>○ ${copy.unobserved}</span><strong>${coverage.unobserved}</strong></div>
        </div>
      </div>
      <div>
        <p class="fog-frontier"><strong>${copy.frontier}</strong><br>${escapeHtml(frontierLabel)}</p>
        <p class="evidence-line">${escapeHtml(coverageCaveat)}</p>
      </div>
    </div>
  </section>
  <section class="section-panel">
    <h2>${copy.evidence}</h2>
    <div class="evidence"><p>${copy.snapshot}<br><code>${escapeHtml(snapshot.revision)}</code></p>
      <p>${copy.source}<br><code>${escapeHtml(snapshot.sourceRevision)}</code></p>
      <p>${copy.activitySummary}<br><code>${escapeHtml(summary.revision)}</code></p></div>
    <p class="evidence-line">${copy.readOnly}</p>
  </section>
</main>
<script>
  const freshnessMs = ${HEARTBEAT_FRESH_MS};
  function refreshAges() {
    const now = Date.now();
    const snapshotAt = Date.parse(document.body.dataset.snapshotAt);
    const age = Math.max(0, Math.floor((now - snapshotAt) / 1000));
    document.getElementById('snapshot-age').textContent = age + 's';
    for (const pulse of document.querySelectorAll('.heartbeat-pulse')) {
      if (now - Date.parse(pulse.dataset.heartbeatAt) > freshnessMs) {
        pulse.className = 'signal stale';
        pulse.textContent = ${JSON.stringify(copy.staleHeartbeat)};
      }
    }
  }
  refreshAges();
  setInterval(refreshAges, 1000);
</script>
</body>
</html>`;
}
