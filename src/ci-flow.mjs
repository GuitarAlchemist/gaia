/**
 * ci-flow.mjs — `gaia-ci-flow/1`, the closed contract for one sealed set of CLOSED continuous
 * integration observations, and the one derivation from it to the block the control room
 * publishes.
 *
 * WHY THIS EXISTS
 * ---------------
 * The control room could already say the engineering queue moved and how fast. It could say
 * nothing at all about the machine standing between a commit and a merge: the portfolio adapter
 * reports `checks: 'UNKNOWN'` because it collected no run identity, no attempt, no queue time and
 * no conclusion. So an operator asking *why is CI slow* could not distinguish runners never being
 * available from one job serialising behind another from the same work running four times per
 * push — three causes with three different fixes.
 *
 * WHAT CANNOT ENTER, AND WHY THAT IS A CONSTRUCTION RATHER THAN A PROMISE
 * ----------------------------------------------------------------------
 * The conclusion vocabulary has no name for a run that is still going, and the completion instant
 * is not nullable, so an in-flight run is unsayable rather than counted as fast. Admissibility is
 * checked at seal, BEFORE any identity is consulted, because de-duplication makes the first write
 * under an identity final — checking after it would let the mechanism that protects against
 * redelivery cement a truncated first read.
 *
 * The observation field list has no field a patch, a command or a workflow path could travel in,
 * so this module cannot be extended into a remediator without an edit to that list.
 *
 * THE THREE MEASUREMENTS THAT WOULD OTHERWISE BE PLAUSIBLE AND WRONG
 * -----------------------------------------------------------------
 * 1. Queue latency on a re-run. A provider keeps the original run creation instant and moves only
 *    the attempt start, so the obvious subtraction reports the days a human took to click re-run
 *    as runner queue latency. Correct arithmetic over the wrong basis; review does not catch it.
 *    `enqueueBasis` makes the basis explicit and the shortcut refusable.
 * 2. A duration distribution that admits cancellations. A lever whose whole effect is cancelling
 *    superseded runs then appears to halve the median, because it adds a population of
 *    twenty-second runs to it. The comparable set is a named constant, not a filter predicate.
 * 3. The slowest check called the critical path. A five-minute job running fully in parallel can
 *    be the slowest check and contribute nothing to the path; shortening it saves nothing. Both
 *    are published, under two names, and the path requires a carried edge set.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It decides no lifecycle state and grants no authority: `effect` and `authority` are fixed at
 * `NONE` and are not per-observation fields. It reads nothing, opens nothing, writes nothing and
 * holds no clock. A green conclusion is a statement that the configured checks passed on the SHA
 * they ran against; the published block says `readiness: 'NOT_CLAIMED'` out loud so that no
 * consumer has to infer it.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './epistemic-research.mjs';
import { isExactInstant } from './local-lane-observation.mjs';

export const CI_FLOW_SCHEMA = 'gaia-ci-flow/1';

/** The one source this schema describes. A constant, not a caller-chosen string. */
export const CI_FLOW_SOURCE = 'GAIA_CI_FLOW';

/**
 * The closed provider list. Nothing else in this module branches on it, which is what
 * "provider-neutral" buys: a second provider is an entry here plus a collector, never a rewrite.
 */
export const CI_FLOW_PROVIDERS = Object.freeze(['GITHUB_ACTIONS']);

/**
 * How stale a CI READING may be before its present-tense cells stop being readable as "now".
 * Fifteen minutes is longer than most pipelines and shorter than any working session.
 */
export const CI_FLOW_FRESH_MS = 900_000;

/** The smallest honest comparable sample, quoted by the percentiles and by every comparison. */
export const CI_FLOW_MIN_SAMPLE = 5;

/** Document-size bounds, not policies about how much CI may exist. */
export const MAX_CI_FLOW_OBSERVATIONS = 512;
export const MAX_CI_FLOW_CHECKS = 128;

/** The exact field sets. Anything else is refused, never ignored. */
export const CI_FLOW_FIELDS = Object.freeze([
  'schema', 'effect', 'authority', 'observedAt', 'windowStartedAt', 'sequence', 'observations',
  'revision',
]);
export const CI_FLOW_OBSERVATION_FIELDS = Object.freeze([
  'provider', 'repositoryId', 'repository', 'workflow', 'runId', 'attempt', 'sha', 'branch',
  'pullRequest', 'trigger', 'enqueueBasis', 'enqueuedAt', 'runnerAcquiredAt', 'startedAt',
  'completedAt', 'conclusion', 'billableMs', 'complete', 'checks', 'dependencies',
]);
export const CI_FLOW_CHECK_FIELDS = Object.freeze([
  'checkId', 'name', 'conclusion', 'startedAt', 'completedAt', 'setupMs', 'workDigest',
]);

/**
 * Every conclusion is terminal. That is the whole admissibility rule, stated as a vocabulary
 * rather than as a check somebody has to remember to write.
 */
export const CI_FLOW_CONCLUSIONS = Object.freeze([
  'ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'NEUTRAL', 'SKIPPED', 'STARTUP_FAILURE',
  'SUCCESS', 'TIMED_OUT',
]);
export const CI_FLOW_TERMINAL_CONCLUSIONS = CI_FLOW_CONCLUSIONS;

/**
 * The conclusions whose durations may be compared with one another.
 *
 * A named set rather than a predicate, so widening it is a visible edit to a constant. A
 * `CANCELLED` run's duration is real but truncated; a `TIMED_OUT` run's is the ceiling, not the
 * work; a `SKIPPED` run has no duration at all. Any of them in a median turns a lever that only
 * cancels more runs into a large, false improvement.
 */
export const CI_FLOW_COMPARABLE_CONCLUSIONS = Object.freeze(['SUCCESS', 'FAILURE']);

/** Whether the enqueue instant belongs to THIS attempt or to the run's original creation. */
export const CI_FLOW_ENQUEUE_BASES = Object.freeze(['ATTEMPT', 'RUN_CREATION']);

export const CI_FLOW_TRIGGERS = Object.freeze([
  'MANUAL', 'OTHER', 'PULL_REQUEST', 'PUSH', 'SCHEDULE',
]);

/**
 * The closed reason vocabulary. Each entry exists because the operator's next move differs:
 * stop asking, collect more, re-collect, or fix the producer. Collapsing any of them into a zero
 * would publish the most reassuring available reading for evidence nobody has.
 */
export const CI_FLOW_REASONS = Object.freeze([
  'NOT_EXPOSED', 'INSUFFICIENT_HISTORY', 'STALE', 'CORRUPT', 'NOT_APPLICABLE',
  'ATTEMPT_QUEUE_BASIS_NOT_EXPOSED', 'ATTEMPT_HISTORY_NOT_COLLECTED',
  'NO_PROVEN_DEPENDENCY_GRAPH', 'BILLING_NOT_EXPOSED', 'OBSERVATION_INCOMPLETE',
  'NO_OBSERVATIONS', 'NO_DETECTABLE_EFFECT',
]);

export const CI_FLOW_MEASUREMENT_STATES = Object.freeze(['MEASURED', 'UNKNOWN']);

/** An identity admits no whitespace, quote, angle bracket, slash or newline. */
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
/** A check label may carry spaces and punctuation — matrix legs are named that way — but no
 *  control character, quote or angle bracket, so it can never break out of an attribute. */
const LABEL = /^[^\u0000-\u001f<>"'&]{1,128}$/u;

export class CiFlowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CiFlowError';
    this.code = code;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/**
 * Ordinal comparison. Deliberately not the locale-aware string comparator, whose result depends
 * on the host's ICU version and active locale — two readers would then disagree about "sorted",
 * and the projection digest would stop being a verification mechanism.
 */
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const isSafeIdentity = (value) => typeof value === 'string' && IDENTITY.test(value);

/** One check rebuilt in one fixed key order, so the digest is independent of construction. */
const projectCheck = (entry) => ({
  checkId: entry.checkId,
  name: entry.name,
  conclusion: entry.conclusion,
  startedAt: entry.startedAt,
  completedAt: entry.completedAt,
  setupMs: entry.setupMs ?? null,
  workDigest: entry.workDigest ?? null,
});

const projectObservation = (entry) => ({
  provider: entry.provider,
  repositoryId: entry.repositoryId,
  repository: entry.repository,
  workflow: entry.workflow,
  runId: entry.runId,
  attempt: entry.attempt,
  sha: entry.sha,
  branch: entry.branch,
  pullRequest: entry.pullRequest ?? null,
  trigger: entry.trigger,
  enqueueBasis: entry.enqueueBasis,
  enqueuedAt: entry.enqueuedAt ?? null,
  runnerAcquiredAt: entry.runnerAcquiredAt ?? null,
  startedAt: entry.startedAt,
  completedAt: entry.completedAt,
  conclusion: entry.conclusion,
  billableMs: entry.billableMs ?? null,
  complete: entry.complete,
  checks: (entry.checks ?? []).map(projectCheck),
  dependencies: entry.dependencies === null || entry.dependencies === undefined
    ? null
    : entry.dependencies.map(([from, to]) => [from, to]),
});

/**
 * The immutable identity of one closed observation.
 *
 * Four parts the provider never reassigns. `repositoryId` rather than the human-readable name:
 * repositories are renamed and transferred, and keying on the name would split one run series in
 * two at the rename, silently halving every rate and resetting a pinned baseline mid-comparison.
 *
 * NUL separates the parts because it is the one character no identity can contain, so no
 * combination of them can spoof a field boundary. The attempt is zero-padded so that the ordinal
 * order of the key is also the numeric order of the attempts.
 */
export function ciFlowObservationIdentity(observation) {
  return `${observation.provider}\u0000${observation.repositoryId}\u0000${observation.runId}`
    + `\u0000${String(observation.attempt).padStart(6, '0')}`;
}

/** The run an observation is an attempt OF, which is its identity minus the attempt. */
const runKeyOf = (observation) => `${observation.provider}\u0000${observation.repositoryId}`
  + `\u0000${observation.runId}`;

/**
 * The one digest recipe, exported because the seal, the verifier and the control room's render
 * seam all need it. A second implementation is how two verifiers come to disagree.
 */
export function ciFlowRevision({
  observedAt, windowStartedAt, sequence, observations = [],
} = {}) {
  return createHash('sha256').update(canonicalJson({
    schema: CI_FLOW_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    observedAt,
    windowStartedAt,
    sequence,
    observations: observations.map(projectObservation),
  })).digest('hex');
}

// -------------------------------------------------------------------------------------------
// Verification. Every refusal is a refusal to DISPLAY, never a repair.
// -------------------------------------------------------------------------------------------

function requireChecks(observation, refuse) {
  const { checks } = observation;
  if (!Array.isArray(checks)) refuse('an observation must carry a check array');
  if (checks.length > MAX_CI_FLOW_CHECKS) {
    refuse(`an observation carries at most ${MAX_CI_FLOW_CHECKS} checks`);
  }
  const startedAtMs = Date.parse(observation.startedAt);
  const completedAtMs = Date.parse(observation.completedAt);
  const seen = new Set();
  for (const entry of checks) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) refuse('a check must be an object');
    for (const field of Object.keys(entry)) {
      if (!CI_FLOW_CHECK_FIELDS.includes(field)) {
        refuse(`a check carries an unknown field ${JSON.stringify(field)}`);
      }
    }
    if (!isSafeIdentity(entry.checkId)) refuse('a check identity is not a bounded identity');
    if (typeof entry.name !== 'string' || !LABEL.test(entry.name)) {
      refuse(`check ${JSON.stringify(entry.checkId)} has no usable label`);
    }
    // The admissibility rule, applied one level down. A run whose status is terminal may still
    // hold a check that has not finalised, and reading it in that instant yields a truncated
    // duration that de-duplication would then make permanent.
    if (!CI_FLOW_TERMINAL_CONCLUSIONS.includes(entry.conclusion)) {
      refuse(`check ${JSON.stringify(entry.checkId)} carries no terminal conclusion`);
    }
    if (!isExactInstant(entry.startedAt) || !isExactInstant(entry.completedAt)) {
      refuse(`check ${JSON.stringify(entry.checkId)} has no exact canonical instants`);
    }
    const checkStarted = Date.parse(entry.startedAt);
    const checkCompleted = Date.parse(entry.completedAt);
    if (checkCompleted < checkStarted) {
      refuse(`check ${JSON.stringify(entry.checkId)} completed before it started`);
    }
    if (checkStarted < startedAtMs || checkCompleted > completedAtMs) {
      refuse(`check ${JSON.stringify(entry.checkId)} lies outside the run it belongs to`);
    }
    if (entry.setupMs !== null
      && !(Number.isSafeInteger(entry.setupMs) && entry.setupMs >= 0)) {
      refuse(`check ${JSON.stringify(entry.checkId)} names an unusable setup duration`);
    }
    if (entry.workDigest !== null
      && !(typeof entry.workDigest === 'string' && DIGEST.test(entry.workDigest))) {
      refuse(`check ${JSON.stringify(entry.checkId)} names an unusable work digest`);
    }
    if (seen.has(entry.checkId)) {
      refuse(`check identity ${JSON.stringify(entry.checkId)} is repeated`);
    }
    seen.add(entry.checkId);
  }
  return seen;
}

/**
 * The dependency edge set, verified as a directed acyclic graph over the carried checks.
 *
 * A cycle is refused rather than searched, because a longest-path search over a cycle does not
 * terminate and clamping the search depth would silently publish a truncated path as the whole
 * one.
 */
function requireDependencies(observation, checkIds, refuse) {
  const { dependencies } = observation;
  if (dependencies === null) return;
  if (!Array.isArray(dependencies)) refuse('a dependency edge set must be an array, or null');
  const seen = new Set();
  const adjacency = new Map([...checkIds].map((id) => [id, []]));
  for (const edge of dependencies) {
    if (!Array.isArray(edge) || edge.length !== 2) refuse('a dependency edge must be a pair');
    const [from, to] = edge;
    if (!checkIds.has(from) || !checkIds.has(to)) {
      refuse(`dependency edge ${JSON.stringify(edge)} names a check the observation does not carry`);
    }
    if (from === to) refuse(`dependency edge ${JSON.stringify(edge)} depends on itself`);
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) refuse(`dependency edge ${JSON.stringify(edge)} is repeated`);
    seen.add(key);
    adjacency.get(from).push(to);
  }
  const state = new Map([...checkIds].map((id) => [id, 0]));
  const visit = (node) => {
    if (state.get(node) === 1) refuse('the dependency edge set contains a cycle');
    if (state.get(node) === 2) return;
    state.set(node, 1);
    for (const next of adjacency.get(node)) visit(next);
    state.set(node, 2);
  };
  for (const id of checkIds) visit(id);
}

/**
 * Total verification of ONE closed observation, on its own terms.
 *
 * Exported because the journal admits observations one at a time and must apply exactly these
 * rules — a second, looser check at the journal boundary is how an observation the artifact would
 * refuse ends up durable. The window and reading-instant bounds are optional, because a journal
 * has no reading instant: it holds evidence, and the artifact is where that evidence is claimed to
 * be complete over an interval.
 */
export function requireCiFlowObservation(observation, {
  observedAtMs = null, windowStartedAtMs = null,
} = {}) {
  const refuse = (message) => {
    throw new CiFlowError('InvalidCiFlow', message);
  };
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    refuse('an observation must be an object');
  }
  for (const field of Object.keys(observation)) {
    if (!CI_FLOW_OBSERVATION_FIELDS.includes(field)) {
      refuse(`an observation carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  if (!CI_FLOW_PROVIDERS.includes(observation.provider)) {
    refuse(`provider ${JSON.stringify(observation.provider)} is outside the closed vocabulary`);
  }
  if (!isSafeIdentity(observation.repositoryId)) refuse('a repository identity is not bounded');
  if (typeof observation.repository !== 'string' || !REPOSITORY.test(observation.repository)) {
    refuse('an observation has no usable repository label');
  }
  if (!isSafeIdentity(observation.workflow)) refuse('a workflow identity is not bounded');
  if (!isSafeIdentity(observation.runId)) refuse('a run identity is not bounded');
  if (!Number.isSafeInteger(observation.attempt) || observation.attempt < 1) {
    refuse('an attempt must be a safe integer of one or more');
  }
  if (typeof observation.sha !== 'string' || !COMMIT.test(observation.sha)) {
    refuse('an observation names no commit');
  }
  if (typeof observation.branch !== 'string' || !REF.test(observation.branch)) {
    refuse('an observation names no usable ref');
  }
  // Nullable, and `null` means NOT PROVEN. Nothing below reads any other field to fill it in.
  if (observation.pullRequest !== null
    && !(Number.isSafeInteger(observation.pullRequest) && observation.pullRequest >= 1)) {
    refuse('a pull request binding must be a positive integer, or null when it is not proven');
  }
  if (!CI_FLOW_TRIGGERS.includes(observation.trigger)) {
    refuse(`trigger ${JSON.stringify(observation.trigger)} is outside the closed vocabulary`);
  }
  if (!CI_FLOW_ENQUEUE_BASES.includes(observation.enqueueBasis)) {
    refuse(`enqueue basis ${JSON.stringify(observation.enqueueBasis)} is outside the closed vocabulary`);
  }
  if (!CI_FLOW_TERMINAL_CONCLUSIONS.includes(observation.conclusion)) {
    refuse(`conclusion ${JSON.stringify(observation.conclusion)} is not a terminal conclusion`);
  }
  if (!isExactInstant(observation.startedAt) || !isExactInstant(observation.completedAt)) {
    refuse(`run ${JSON.stringify(observation.runId)} has no exact canonical instants`);
  }
  const startedAtMs = Date.parse(observation.startedAt);
  const completedAtMs = Date.parse(observation.completedAt);
  if (completedAtMs < startedAtMs) {
    refuse(`run ${JSON.stringify(observation.runId)} completed before it started`);
  }
  if (observation.enqueuedAt !== null) {
    if (!isExactInstant(observation.enqueuedAt)) refuse('an enqueue instant must be exact, or null');
    if (Date.parse(observation.enqueuedAt) > startedAtMs) {
      refuse(`run ${JSON.stringify(observation.runId)} started before it was enqueued`);
    }
  }
  if (observation.runnerAcquiredAt !== null) {
    if (!isExactInstant(observation.runnerAcquiredAt)) refuse('a runner instant must be exact, or null');
    const acquiredMs = Date.parse(observation.runnerAcquiredAt);
    if (acquiredMs > startedAtMs
      || (observation.enqueuedAt !== null && acquiredMs < Date.parse(observation.enqueuedAt))) {
      refuse(`run ${JSON.stringify(observation.runId)} acquired a runner outside its own queue interval`);
    }
  }
  if (observation.billableMs !== null
    && !(Number.isSafeInteger(observation.billableMs) && observation.billableMs >= 0)) {
    refuse(`run ${JSON.stringify(observation.runId)} names an unusable billable duration`);
  }
  if (typeof observation.complete !== 'boolean') {
    refuse('an observation must state whether the producer read it completely');
  }
  const checkIds = requireChecks(observation, refuse);
  requireDependencies(observation, checkIds, refuse);
  if (observedAtMs !== null && Date.parse(observation.completedAt) > observedAtMs) {
    refuse(`run ${JSON.stringify(observation.runId)} is dated after the evidence was observed`);
  }
  if (windowStartedAtMs !== null && Date.parse(observation.completedAt) < windowStartedAtMs) {
    refuse(`run ${JSON.stringify(observation.runId)} closed before the window it claims to be inside`);
  }
  return projectObservation(observation);
}


/**
 * Total verification of one published `gaia-ci-flow/1` value.
 *
 * Nothing here is clamped: a future instant is not pulled back to now, an unknown conclusion is
 * not bucketed as other, a negative duration is not raised to zero and a duplicate identity is not
 * de-duplicated. Each of those repairs turns incoherent evidence into a confident reading.
 */
export function requireCiFlowArtifact(value) {
  const refuse = (message) => {
    throw new CiFlowError('InvalidCiFlow', message);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('a Gaia CI flow artifact object is required');
  }
  for (const field of Object.keys(value)) {
    if (!CI_FLOW_FIELDS.includes(field)) {
      refuse(`the artifact carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  if (value.schema !== CI_FLOW_SCHEMA || value.effect !== 'NONE' || value.authority !== 'NONE'
      || typeof value.revision !== 'string' || !Array.isArray(value.observations)) {
    refuse('an authority-free Gaia CI flow artifact is required');
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
  if (value.observations.length > MAX_CI_FLOW_OBSERVATIONS) {
    refuse(`an artifact carries at most ${MAX_CI_FLOW_OBSERVATIONS} observations`);
  }

  const seenIdentities = new Set();
  let previousKey = null;
  for (const entry of value.observations) {
    requireCiFlowObservation(entry, { observedAtMs, windowStartedAtMs });

    const identity = ciFlowObservationIdentity(entry);
    if (seenIdentities.has(identity)) {
      refuse(`observation identity for run ${JSON.stringify(entry.runId)} attempt ${entry.attempt}`
        + ' is repeated');
    }
    seenIdentities.add(identity);
    if (previousKey !== null && ordinal(previousKey, identity) >= 0) {
      refuse('observations must be in strictly ascending identity order');
    }
    previousKey = identity;
  }

  if (value.revision !== ciFlowRevision(value)) {
    refuse('the CI flow revision does not match its content');
  }
  return deepFreeze(value);
}

/**
 * Seal one artifact: order the observations by identity, verify the whole value, content-address
 * it. Ordering here rather than in every caller is what makes two readings of the same evidence
 * byte-identical; the verifier still enforces the order, so a hand-written file gets no
 * dispensation a producer enjoys.
 */
export function sealCiFlow({ observedAt, windowStartedAt, sequence, observations = [] } = {}) {
  if (!Array.isArray(observations)) {
    throw new CiFlowError('InvalidCiFlow', 'observations must be an array');
  }
  const ordered = [...observations]
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new CiFlowError('InvalidCiFlow', 'an observation must be an object');
      }
      // Refused rather than projected away. Silently dropping an unknown field would let a
      // producer believe a field it wrote was being honoured.
      for (const field of Object.keys(entry)) {
        if (!CI_FLOW_OBSERVATION_FIELDS.includes(field)) {
          throw new CiFlowError(
            'InvalidCiFlow', `an observation carries an unknown field ${JSON.stringify(field)}`,
          );
        }
      }
      for (const nested of entry.checks ?? []) {
        if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
          throw new CiFlowError('InvalidCiFlow', 'a check must be an object');
        }
        for (const field of Object.keys(nested)) {
          if (!CI_FLOW_CHECK_FIELDS.includes(field)) {
            throw new CiFlowError(
              'InvalidCiFlow', `a check carries an unknown field ${JSON.stringify(field)}`,
            );
          }
        }
      }
      return projectObservation(entry);
    })
    .sort((left, right) => ordinal(
      ciFlowObservationIdentity(left), ciFlowObservationIdentity(right),
    ));

  return requireCiFlowArtifact({
    schema: CI_FLOW_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    observedAt,
    windowStartedAt,
    sequence,
    observations: ordered,
    revision: ciFlowRevision({ observedAt, windowStartedAt, sequence, observations: ordered }),
  });
}

// -------------------------------------------------------------------------------------------
// Derivation. One block, re-derivable by any reader from the evidence it carries.
// -------------------------------------------------------------------------------------------

const measured = (value) => ({ state: 'MEASURED', reasonCode: null, value });
const withheld = (reasonCode) => ({ state: 'UNKNOWN', reasonCode, value: null });

const spanOf = (entry) => Date.parse(entry.completedAt) - Date.parse(entry.startedAt);

const isComparable = (observation) => observation.complete
  && CI_FLOW_COMPARABLE_CONCLUSIONS.includes(observation.conclusion);

/**
 * The queue interval, refused on a re-run that carries only the original run's creation instant.
 *
 * This is the single most consequential refusal in the module. The subtraction it declines to do
 * is arithmetically correct and yields a large, plausible, actionable number that points the
 * operator at runner scarcity when the real cause was a human clicking re-run two days later.
 */
function deriveQueueLatency(observation) {
  if (observation.attempt > 1 && observation.enqueueBasis === 'RUN_CREATION') {
    return withheld('ATTEMPT_QUEUE_BASIS_NOT_EXPOSED');
  }
  if (observation.enqueuedAt === null) return withheld('NOT_EXPOSED');
  return measured(Date.parse(observation.startedAt) - Date.parse(observation.enqueuedAt));
}

function deriveRunnerStartup(observation) {
  if (observation.runnerAcquiredAt === null) return withheld('NOT_EXPOSED');
  return measured(Date.parse(observation.startedAt) - Date.parse(observation.runnerAcquiredAt));
}

function deriveExecution(observation) {
  // A skipped run never ran. Zero would be a lie of type, not merely a lie of degree.
  if (observation.conclusion === 'SKIPPED') return withheld('NOT_APPLICABLE');
  return measured(spanOf(observation));
}

/**
 * The setup share of the span, withheld whole when the decomposition exceeds what it decomposes.
 *
 * The span itself stays MEASURED in that case: it is still evidence, and only the split is
 * incoherent. Refusing both would discard a good measurement because a worse one disagreed.
 */
function deriveSetup(observation) {
  const { checks } = observation;
  if (checks.length === 0) return withheld('NOT_EXPOSED');
  if (checks.some((entry) => entry.setupMs === null)) return withheld('NOT_EXPOSED');
  const total = checks.reduce((sum, entry) => sum + entry.setupMs, 0);
  if (total > spanOf(observation)) return withheld('CORRUPT');
  return measured(total);
}

/**
 * The four phase measurements for one observation, as cells.
 *
 * Exported because the published block and the analytical projection must agree cell for cell. A
 * second implementation on the projection side is how a dashboard and an analyst bench come to
 * report different queue latencies for the same run and nobody can say which is right.
 */
export function deriveCiFlowObservationMeasures(observation) {
  return Object.freeze({
    queueLatencyMs: deriveQueueLatency(observation),
    runnerStartupMs: deriveRunnerStartup(observation),
    setupMs: deriveSetup(observation),
    executionMs: deriveExecution(observation),
  });
}

function deriveSlowestCheck(observation) {
  const { checks } = observation;
  if (checks.length === 0) {
    return { state: 'UNKNOWN', reasonCode: 'NOT_EXPOSED', checkId: null, name: null, durationMs: null };
  }
  const best = [...checks].sort((left, right) => (spanOf(right) - spanOf(left))
    || ordinal(left.checkId, right.checkId))[0];
  return {
    state: 'MEASURED', reasonCode: null, checkId: best.checkId, name: best.name,
    durationMs: spanOf(best),
  };
}

/**
 * The longest chain through the carried dependency graph.
 *
 * A path, not a vertex. Without a proven edge set this is refused, because the available
 * substitute — the slowest check — is a different quantity that happens to be easy, and a
 * five-minute job running fully in parallel is on no critical path at all.
 */
function deriveCriticalPath(observation) {
  const edges = observation.dependencies;
  if (edges === null) {
    return {
      state: 'UNKNOWN', reasonCode: 'NO_PROVEN_DEPENDENCY_GRAPH', checkIds: [], durationMs: null,
    };
  }
  const byId = new Map(observation.checks.map((entry) => [entry.checkId, entry]));
  const successors = new Map([...byId.keys()].map((id) => [id, []]));
  for (const [from, to] of edges) successors.get(from).push(to);

  const best = new Map();
  const longestFrom = (id) => {
    const cached = best.get(id);
    if (cached !== undefined) return cached;
    let winner = { durationMs: spanOf(byId.get(id)), checkIds: [id] };
    for (const next of [...successors.get(id)].sort(ordinal)) {
      const tail = longestFrom(next);
      const candidate = {
        durationMs: spanOf(byId.get(id)) + tail.durationMs,
        checkIds: [id, ...tail.checkIds],
      };
      if (candidate.durationMs > winner.durationMs
        || (candidate.durationMs === winner.durationMs
          && ordinal(candidate.checkIds.join('\u0000'), winner.checkIds.join('\u0000')) < 0)) {
        winner = candidate;
      }
    }
    best.set(id, winner);
    return winner;
  };

  let path = null;
  for (const id of [...byId.keys()].sort(ordinal)) {
    const candidate = longestFrom(id);
    if (path === null || candidate.durationMs > path.durationMs) path = candidate;
  }
  if (path === null) {
    return {
      state: 'UNKNOWN', reasonCode: 'NOT_EXPOSED', checkIds: [], durationMs: null,
    };
  }
  return {
    state: 'MEASURED', reasonCode: null, checkIds: path.checkIds, durationMs: path.durationMs,
  };
}

/**
 * `sorted[floor(n / 2)]` for the median, quoting `measurePace`'s existing formula rather than
 * re-deriving one, and nearest-rank for the ninety-fifth, so neither depends on how it was
 * printed and no floating-point interpolation enters a millisecond count.
 */
const percentileAt = (sorted, numerator, denominator) => sorted[
  Math.min(sorted.length - 1, Math.ceil((sorted.length * numerator) / denominator) - 1)
];

function derivePercentiles(observations) {
  const comparable = observations.filter(isComparable);
  const sampleSize = comparable.length;
  if (sampleSize < CI_FLOW_MIN_SAMPLE) {
    return {
      state: 'UNKNOWN',
      reasonCode: 'INSUFFICIENT_HISTORY',
      p50Ms: null,
      p95Ms: null,
      sampleSize,
      comparableConclusions: [...CI_FLOW_COMPARABLE_CONCLUSIONS],
    };
  }
  const durations = comparable.map(spanOf).sort((left, right) => left - right);
  return {
    state: 'MEASURED',
    reasonCode: null,
    p50Ms: durations[Math.floor(durations.length / 2)],
    p95Ms: percentileAt(durations, 95, 100),
    sampleSize,
    comparableConclusions: [...CI_FLOW_COMPARABLE_CONCLUSIONS],
  };
}

/** Per-run arithmetic: three quantities that must never substitute for one another. */
function deriveRuns(observations) {
  const grouped = new Map();
  for (const entry of observations) {
    const key = runKeyOf(entry);
    const held = grouped.get(key) ?? [];
    held.push(entry);
    grouped.set(key, held);
  }
  return [...grouped.keys()].sort(ordinal).map((key) => {
    const attempts = [...grouped.get(key)].sort((left, right) => left.attempt - right.attempt);
    const highest = attempts.at(-1);
    // Holding attempt 3 proves nothing about attempts 1 and 2: a collector reading only the
    // latest attempt sees a healthy workflow that in fact fails twice on every run.
    const chainComplete = attempts.every((entry, index) => entry.attempt === index + 1);
    return {
      runKey: key,
      provider: highest.provider,
      repositoryId: highest.repositoryId,
      repository: highest.repository,
      workflow: highest.workflow,
      runId: highest.runId,
      branch: highest.branch,
      attemptCount: attempts.length,
      attemptChainComplete: chainComplete,
      terminalDurationMs: spanOf(highest),
      totalConsumedMs: attempts.reduce((total, entry) => total + spanOf(entry), 0),
      conclusion: highest.conclusion,
    };
  });
}

function deriveRetries(runs) {
  if (runs.some((run) => !run.attemptChainComplete)) {
    return withheld('ATTEMPT_HISTORY_NOT_COLLECTED');
  }
  return measured(runs.reduce((total, run) => total + (run.attemptCount - 1), 0));
}

/**
 * Provider-reported billable time, summed. Never derived from wall clock: a provider rounds each
 * job up to the whole minute and multiplies by an operating-system rate, and parallel jobs bill
 * concurrently, so a duration converted to cost is always wrong and always plausible.
 */
function deriveConsumedRunner(observations) {
  const comparable = observations.filter(isComparable);
  const billed = comparable.filter((entry) => entry.billableMs !== null);
  if (comparable.length === 0 || billed.length !== comparable.length) {
    return {
      state: 'UNKNOWN',
      reasonCode: 'BILLING_NOT_EXPOSED',
      totalMs: null,
      minutes: null,
      sampleSize: billed.length,
    };
  }
  const totalMs = billed.reduce((total, entry) => total + entry.billableMs, 0);
  return {
    state: 'MEASURED',
    reasonCode: null,
    totalMs,
    // One deterministic rounding, so a figure never depends on how it happened to be printed.
    minutes: Math.round((totalMs / 60_000) * 100) / 100,
    sampleSize: billed.length,
  };
}

const withheldGate = (reasonCode) => ({
  state: 'UNKNOWN',
  reasonCode,
  conclusion: null,
  repository: null,
  workflow: null,
  runId: null,
  attempt: null,
  sha: null,
  branch: null,
  pullRequest: null,
  pullRequestBinding: null,
  completedAt: null,
});

/**
 * The one derivation from a verified artifact to the published block.
 *
 * Called by the control-room builder and by its render seam alike, so a snapshot whose published
 * block is not what its own carried evidence derives is refused rather than displayed.
 *
 * How stale the reading is travels separately, against its own freshness window. When it is
 * stale, the PRESENT-TENSE cells — the current gate and its decomposition — are withheld, because
 * "the current gate" is a claim about now that old evidence cannot support. The percentiles are a
 * claim about a closed past and survive.
 */
export function deriveCiFlowBlock({ artifact, observedAt }) {
  const observationAgeMs = Date.parse(observedAt) - Date.parse(artifact.observedAt);
  const fresh = observationAgeMs <= CI_FLOW_FRESH_MS;
  const observations = artifact.observations.map(projectObservation);
  const runs = deriveRuns(observations);
  const percentiles = derivePercentiles(observations);

  // The gate is the most recently closed run; identity breaks a tie, so two runs that closed in
  // the same millisecond do not make the reading depend on array order.
  const gateObservation = observations.length === 0 ? null : [...observations].sort(
    (left, right) => (Date.parse(right.completedAt) - Date.parse(left.completedAt))
      || ordinal(ciFlowObservationIdentity(right), ciFlowObservationIdentity(left)),
  )[0];

  const presentTenseReason = observations.length === 0 ? 'NO_OBSERVATIONS' : (fresh ? null : 'STALE');

  const gate = presentTenseReason !== null ? withheldGate(presentTenseReason) : {
    state: 'MEASURED',
    reasonCode: null,
    conclusion: gateObservation.conclusion,
    repository: gateObservation.repository,
    workflow: gateObservation.workflow,
    runId: gateObservation.runId,
    attempt: gateObservation.attempt,
    sha: gateObservation.sha,
    branch: gateObservation.branch,
    pullRequest: gateObservation.pullRequest,
    // Published as a named state rather than as an absence. A provider legitimately omits the
    // association for a push and for a fork pull request, and inferring it from anything else
    // would be a guess that attributes a run to the wrong lever.
    pullRequestBinding: gateObservation.pullRequest === null ? 'PR_NOT_PROVEN' : 'PROVEN',
    completedAt: gateObservation.completedAt,
  };

  const phases = presentTenseReason !== null ? {
    queueLatencyMs: withheld(presentTenseReason),
    runnerStartupMs: withheld(presentTenseReason),
    setupMs: withheld(presentTenseReason),
    executionMs: withheld(presentTenseReason),
  } : deriveCiFlowObservationMeasures(gateObservation);

  const slowestCheck = presentTenseReason !== null
    ? { state: 'UNKNOWN', reasonCode: presentTenseReason, checkId: null, name: null, durationMs: null }
    : deriveSlowestCheck(gateObservation);
  const criticalPath = presentTenseReason !== null
    ? { state: 'UNKNOWN', reasonCode: presentTenseReason, checkIds: [], durationMs: null }
    : deriveCriticalPath(gateObservation);

  return deepFreeze({
    source: CI_FLOW_SOURCE,
    state: fresh ? 'FRESH' : 'STALE',
    // Published rather than merely absent, so a consumer reads the disclaimer instead of
    // inferring a portfolio binding, or a shipping decision, from a missing field.
    binding: 'NONE',
    readiness: 'NOT_CLAIMED',
    observedAt: artifact.observedAt,
    windowStartedAt: artifact.windowStartedAt,
    artifactRevision: artifact.revision,
    sequence: artifact.sequence,
    observationAgeMs,
    freshnessWindowMs: CI_FLOW_FRESH_MS,
    observationCount: observations.length,
    runCount: runs.length,
    // Every observation is either a contributor to the distribution or withheld from it, and the
    // two counts sum to the whole, so nothing can silently vanish from a denominator.
    withheldCount: observations.length - percentiles.sampleSize,
    gate,
    phases,
    slowestCheck,
    criticalPath,
    percentiles,
    retries: deriveRetries(runs),
    cancellations: measured(
      observations.filter((entry) => entry.conclusion === 'CANCELLED').length,
    ),
    consumedRunner: deriveConsumedRunner(observations),
    runs,
    // Carried verbatim, at a deliberate size cost, for one property: the render seam re-derives
    // every cell from these observations. A digest taken over evidence the verifier cannot see is
    // not verifiable.
    observations,
  });
}

/**
 * A prior reading of the same source, used only to refuse a snapshot that went backwards.
 * A producer whose sequence or observation instant regressed is republishing stale evidence as
 * current, and the reading it would produce is indistinguishable from a fresh one.
 */
function requirePriorObservation(prior) {
  if (prior === null || prior === undefined) return null;
  if (typeof prior !== 'object' || Array.isArray(prior)
      || !isExactInstant(prior.observedAt)
      || !Number.isSafeInteger(prior.sequence) || prior.sequence < 0) {
    throw new CiFlowError(
      'InvalidCiFlow', 'a prior observation must name an exact instant and a safe sequence',
    );
  }
  return prior;
}

/**
 * Verify one sealed artifact on its own terms, check it against the reader's instant and against
 * any prior observation of the same source, and derive the published block.
 */
export function summarizeCiFlow({ artifact, observedAt, priorObservation = null }) {
  const verified = requireCiFlowArtifact(artifact);
  if (!isExactInstant(observedAt)) {
    throw new CiFlowError('InvalidCiFlow', 'the reading instant must be an exact ISO timestamp');
  }
  // Refused rather than clamped: evidence dated after the instant it was read cannot be aged, and
  // a zero age is the single most reassuring reading available.
  if (Date.parse(verified.observedAt) > Date.parse(observedAt)) {
    throw new CiFlowError(
      'IncoherentCiFlow',
      `CI flow evidence dated ${verified.observedAt} is after the instant it was read,`
      + ` ${observedAt}; a clock or a producer timestamp is wrong and no CI cost can be measured`,
    );
  }
  const prior = requirePriorObservation(priorObservation);
  if (prior !== null
      && (Date.parse(verified.observedAt) < Date.parse(prior.observedAt)
        || verified.sequence < prior.sequence)) {
    throw new CiFlowError(
      'IncoherentCiFlow',
      `this CI flow artifact (sequence ${verified.sequence} at ${verified.observedAt}) went`
      + ` backwards against the prior observation (sequence ${prior.sequence} at`
      + ` ${prior.observedAt}); a source snapshot that regressed is refused, never displayed`,
    );
  }
  return deriveCiFlowBlock({ artifact: verified, observedAt });
}
