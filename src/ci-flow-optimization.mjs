/**
 * ci-flow-optimization.mjs — advisory optimization candidates, and the one comparison that can
 * promote a hypothesis to a result.
 *
 * ADVISORY MEANS ADVISORY, AS A FIELD LIST RATHER THAN AS A POLICY
 * ---------------------------------------------------------------
 * A candidate carries a lever, a rationale and the evidence identifiers that support it. There is
 * no fourth field, so there is nowhere for a change to a workflow file to travel. This module
 * imports no filesystem, starts no process and opens nothing; a `REVERT` verdict is the operator
 * instructing themselves, and nothing here carries it out.
 *
 * A candidate is emitted only when the evidence that would support it is present. Its ABSENCE is
 * therefore never an assertion that the lever would not help — only that nothing here can see
 * whether it would.
 *
 * WHY A COMPARISON IS SO CONSTRAINED
 * ----------------------------------
 * This is the only place in the slice whose defects cost a week of somebody's engineering time,
 * so three rules are structural rather than procedural:
 *
 * 1. The guard enters the digest. A guard loosened after seeing the result produces a comparison
 *    with a new revision, so it cannot pass as the guard that was fixed beforehand.
 * 2. One lever. Two levers moved together produce a result that cannot attribute the change,
 *    which is a result nobody can act on.
 * 3. One observation cannot close two comparisons. Each comparison consumes an explicit identity
 *    set, and an identity already consumed elsewhere is refused. Without it, two advisories each
 *    claiming a twenty per cent win can both rest on the same twenty per cent — and a single
 *    anomalous week inflates both at once, so cross-checking one against the other appears to
 *    corroborate.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './epistemic-research.mjs';
import { isExactInstant } from './local-lane-observation.mjs';
import {
  CI_FLOW_COMPARABLE_CONCLUSIONS,
  CI_FLOW_MIN_SAMPLE,
  ciFlowObservationIdentity,
  deriveCiFlowObservationMeasures,
} from './ci-flow.mjs';

export const CI_FLOW_COMPARISON_SCHEMA = 'gaia-ci-flow-comparison/1';

/**
 * The four levers, each chosen because it has a distinct evidence precondition the observations
 * can actually satisfy. A lever nobody can gather evidence for is an opinion with a name.
 */
export const CI_FLOW_LEVERS = Object.freeze([
  'CANCEL_SUPERSEDED_RUNS', 'DEDUPLICATE_WORK', 'INTRODUCE_CACHING', 'SAFE_JOB_PARALLELISM',
]);

export const CI_FLOW_CANDIDATE_FIELDS = Object.freeze(['lever', 'rationale', 'evidence']);

export const CI_FLOW_COMPARISON_FIELDS = Object.freeze([
  'schema', 'effect', 'authority', 'lever', 'baselineRevision', 'guard', 'observedAt',
  'baseline', 'candidate', 'revision',
]);

export const CI_FLOW_GUARD_FIELDS = Object.freeze(['maxRegressionMs', 'minImprovementMs']);

export const CI_FLOW_VERDICTS = Object.freeze(['KEEP', 'REVERT', 'UNKNOWN']);

/**
 * Setup is worth caching when it is at least this share of the span it sits inside.
 *
 * Held as a numerator and a denominator so the test is integer arithmetic. A floating-point ratio
 * would make the boundary case depend on the last bits of a division.
 */
export const CI_FLOW_CACHING_SETUP_SHARE = Object.freeze({ numerator: 1, denominator: 4 });

const DIGEST = /^[0-9a-f]{64}$/u;

export class CiFlowOptimizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CiFlowOptimizationError';
    this.code = code;
  }
}

/** Ordinal comparison, so two hosts with unlike ICU versions agree about "sorted". */
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const spanOf = (entry) => Date.parse(entry.completedAt) - Date.parse(entry.startedAt);

const isComparable = (observation) => observation.complete
  && CI_FLOW_COMPARABLE_CONCLUSIONS.includes(observation.conclusion);

const candidate = (lever, rationale, evidence) => Object.freeze({
  lever,
  rationale,
  evidence: Object.freeze([...new Set(evidence)].sort(ordinal)),
});

/**
 * Two closed runs of one workflow, on one branch, whose intervals overlapped — so a later push
 * did not stop the earlier run and both consumed a runner to answer about the same branch.
 */
function superseded(observations) {
  const byBranch = new Map();
  for (const entry of observations) {
    const key = `${entry.repositoryId}\u0000${entry.workflow}\u0000${entry.branch}`;
    byBranch.set(key, [...(byBranch.get(key) ?? []), entry]);
  }
  const evidence = [];
  for (const key of [...byBranch.keys()].sort(ordinal)) {
    const held = byBranch.get(key);
    for (let i = 0; i < held.length; i += 1) {
      for (let j = i + 1; j < held.length; j += 1) {
        const [left, right] = [held[i], held[j]];
        if (left.runId === right.runId) continue;
        const overlaps = Date.parse(left.startedAt) < Date.parse(right.completedAt)
          && Date.parse(right.startedAt) < Date.parse(left.completedAt);
        if (overlaps) evidence.push(ciFlowObservationIdentity(left), ciFlowObservationIdentity(right));
      }
    }
  }
  if (evidence.length === 0) return null;
  return candidate(
    'CANCEL_SUPERSEDED_RUNS',
    'two closed runs of one workflow on one branch overlapped, so an earlier run kept a runner'
    + ' busy answering about a commit a later push had already replaced',
    evidence,
  );
}

/** Whether `to` is reachable from `from` along the carried edges. */
function reaches(successors, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === to) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...successors.get(node));
  }
  return false;
}

/**
 * Two checks with no path between them in either direction that nonetheless ran one after the
 * other. A proven graph is required: without it, sequence proves nothing about independence,
 * because the reason they ran in order may be an edge nobody wrote down.
 */
function safeParallelism(observations) {
  const evidence = [];
  for (const entry of observations) {
    if (entry.dependencies === null) continue;
    const successors = new Map(entry.checks.map((check) => [check.checkId, []]));
    for (const [from, to] of entry.dependencies) successors.get(from).push(to);
    for (let i = 0; i < entry.checks.length; i += 1) {
      for (let j = i + 1; j < entry.checks.length; j += 1) {
        const [left, right] = [entry.checks[i], entry.checks[j]];
        if (reaches(successors, left.checkId, right.checkId)
          || reaches(successors, right.checkId, left.checkId)) continue;
        const sequential = Date.parse(right.startedAt) >= Date.parse(left.completedAt)
          || Date.parse(left.startedAt) >= Date.parse(right.completedAt);
        if (sequential) evidence.push(ciFlowObservationIdentity(entry));
      }
    }
  }
  if (evidence.length === 0) return null;
  return candidate(
    'SAFE_JOB_PARALLELISM',
    'two checks with no proven dependency between them ran one after the other, so the graph'
    + ' permits them to run at the same time',
    evidence,
  );
}

/** Two checks in one run whose work digests are identical: the same work, computed twice. */
function duplicateWork(observations) {
  const evidence = [];
  for (const entry of observations) {
    const counts = new Map();
    for (const check of entry.checks) {
      if (check.workDigest === null) continue;
      counts.set(check.workDigest, (counts.get(check.workDigest) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count > 1)) {
      evidence.push(ciFlowObservationIdentity(entry));
    }
  }
  if (evidence.length === 0) return null;
  return candidate(
    'DEDUPLICATE_WORK',
    'two checks in one run carry the same work digest, so identical work was computed twice',
    evidence,
  );
}

/**
 * A check whose own setup is a real share of its OWN span.
 *
 * The share is measured per check, and this is the whole mechanism. Summing the setup of jobs
 * that ran at the same time and dividing by one wall-clock span makes the numerator a sum and the
 * denominator a maximum, so the share is inflated by the fan-out: four one-minute jobs each
 * spending ten seconds on setup — a true share of one sixth — read as two thirds and raise this
 * lever on evidence that does not support it. That is the same error the contract already refuses
 * for cost, and the consequence is the week of somebody's engineering time this module exists to
 * protect. Naming the check rather than the run is also the more useful answer: it says which job
 * to cache instead of leaving an operator to read four logs to find out.
 */
function caching(observations) {
  const { numerator, denominator } = CI_FLOW_CACHING_SETUP_SHARE;
  const evidence = [];
  for (const entry of observations) {
    const { setupMs, executionMs } = deriveCiFlowObservationMeasures(entry);
    // An unexposed setup is not a small setup, and an incoherent one is not evidence at all. A
    // cell that is UNKNOWN supports no candidate, so both are consulted as coherence gates only.
    if (setupMs.state !== 'MEASURED' || executionMs.state !== 'MEASURED') continue;
    // Named, because the pairing of a numerator with its own denominator IS the mechanism; MR9
    // reverts exactly this line to the summed-setup-over-one-wall-clock form.
    const share = (item) => [item.setupMs, spanOf(item)];
    for (const item of entry.checks) {
      const [setup, span] = share(item);
      // A check with no span has no share to be a fraction of; zero over zero is not a quarter.
      if (span > 0 && setup * denominator >= span * numerator) {
        evidence.push(`${ciFlowObservationIdentity(entry)}\u0000${item.checkId}`);
      }
    }
  }
  if (evidence.length === 0) return null;
  return candidate(
    'INTRODUCE_CACHING',
    `at least one check spent one ${denominator}th or more of its own span on setup, so work that`
    + ' could be restored instead of rebuilt is being rebuilt; the evidence names the run and the'
    + ' check inside it, separated by NUL',
    evidence,
  );
}

/**
 * Every candidate the evidence supports, ordered by lever so two readings of one artifact are
 * byte-identical.
 *
 * Incomplete observations are excluded outright: a partial read may be missing exactly the check,
 * the run or the phase that would have decided the question, and a candidate raised on it would
 * be a hypothesis about evidence nobody has.
 */
export function deriveCiFlowCandidates({ artifact }) {
  const observations = artifact.observations.filter((entry) => entry.complete);
  return Object.freeze([
    superseded(observations),
    safeParallelism(observations),
    duplicateWork(observations),
    caching(observations),
  ].filter((entry) => entry !== null).sort((left, right) => ordinal(left.lever, right.lever)));
}

// -------------------------------------------------------------------------------------------
// The pinned comparison.
// -------------------------------------------------------------------------------------------

function requireGuard(guard, refuse) {
  if (!guard || typeof guard !== 'object' || Array.isArray(guard)) {
    refuse('a regression guard object is required');
  }
  for (const field of Object.keys(guard)) {
    if (!CI_FLOW_GUARD_FIELDS.includes(field)) {
      refuse(`the guard carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  for (const field of CI_FLOW_GUARD_FIELDS) {
    if (!Number.isSafeInteger(guard[field]) || guard[field] < 0) {
      refuse(`the guard's ${field} must be a safe integer of zero or more`);
    }
  }
  return { maxRegressionMs: guard.maxRegressionMs, minImprovementMs: guard.minImprovementMs };
}

function requireArm(value, name, refuse) {
  if (!Array.isArray(value) || value.length === 0) {
    refuse(`the ${name} arm must be a non-empty array of observation identities`);
  }
  for (const identity of value) {
    if (typeof identity !== 'string' || identity.length === 0) {
      refuse(`the ${name} arm carries an unusable observation identity`);
    }
  }
  if (new Set(value).size !== value.length) {
    refuse(`the ${name} arm names one observation more than once`);
  }
  return [...value];
}

export function ciFlowComparisonRevision({
  lever, baselineRevision, guard, observedAt, baseline, candidate: candidateArm,
}) {
  return createHash('sha256').update(canonicalJson({
    schema: CI_FLOW_COMPARISON_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    lever,
    baselineRevision,
    // Inside the digest deliberately: this is what makes a guard loosened after the fact visible
    // as a new revision rather than passing as the guard that was fixed in advance.
    guard,
    observedAt,
    baseline,
    candidate: candidateArm,
  })).digest('hex');
}

/**
 * Pin one comparison: one lever, one baseline artifact revision, one guard, two disjoint arms.
 * Nothing here reads any observation; a comparison is a question, and `compareCiFlow` is the only
 * thing that answers it.
 */
export function sealCiFlowComparison({
  lever, baselineRevision, guard, observedAt, baseline, candidate: candidateArm,
} = {}) {
  const refuse = (message) => {
    throw new CiFlowOptimizationError('InvalidCiFlowComparison', message);
  };
  if (typeof lever !== 'string' || !CI_FLOW_LEVERS.includes(lever)) {
    refuse(`a comparison names exactly one known lever, not ${JSON.stringify(lever)}`);
  }
  if (typeof baselineRevision !== 'string' || !DIGEST.test(baselineRevision)) {
    refuse('a comparison pins the baseline artifact by its revision');
  }
  if (!isExactInstant(observedAt)) {
    refuse('the comparison instant must be an exact ISO timestamp');
  }
  const checkedGuard = requireGuard(guard, refuse);
  const baselineArm = requireArm(baseline, 'baseline', refuse);
  const candidateIdentities = requireArm(candidateArm, 'candidate', refuse);
  // An observation in both arms would be its own control, which answers nothing and hides that it
  // answered nothing behind a plausible delta.
  const shared = baselineArm.filter((identity) => candidateIdentities.includes(identity));
  if (shared.length > 0) {
    refuse(`${shared.length} observation(s) appear in both arms of one comparison`);
  }
  const body = {
    schema: CI_FLOW_COMPARISON_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    lever,
    baselineRevision,
    guard: checkedGuard,
    observedAt,
    baseline: baselineArm,
    candidate: candidateIdentities,
  };
  return Object.freeze({ ...body, revision: ciFlowComparisonRevision(body) });
}

/**
 * `sorted[floor(n / 2)]`, the same median formula the flow page and the pace card already use, so
 * three surfaces cannot come to mean three things by "median".
 */
const medianOf = (durations) => durations[Math.floor(durations.length / 2)];

function armReading(identities, byIdentity) {
  const comparable = identities
    .map((identity) => byIdentity.get(identity))
    .filter(isComparable);
  return {
    sampleSize: comparable.length,
    medianMs: comparable.length === 0
      ? null
      : medianOf(comparable.map(spanOf).sort((left, right) => left - right)),
  };
}

/**
 * Read one pinned comparison against the artifact it was pinned to.
 *
 * The answer is `KEEP`, `REVERT`, or `UNKNOWN` with a named reason — and early on `UNKNOWN` is the
 * common case, which is the honest outcome rather than a failure of the method.
 */
export function compareCiFlow({ comparison, artifact, claimedIdentities = [] }) {
  if (artifact.revision !== comparison.baselineRevision) {
    throw new CiFlowOptimizationError(
      'BaselineRevisionMismatch',
      `this comparison is pinned to artifact revision ${comparison.baselineRevision} and was`
      + ` handed ${artifact.revision}; a comparison read against evidence other than the evidence`
      + ' it pinned is not the comparison that was fixed in advance',
    );
  }
  const byIdentity = new Map(
    artifact.observations.map((entry) => [ciFlowObservationIdentity(entry), entry]),
  );
  const consumed = [...comparison.baseline, ...comparison.candidate];
  for (const identity of consumed) {
    if (!byIdentity.has(identity)) {
      throw new CiFlowOptimizationError(
        'UnknownObservation',
        `this comparison names an observation the artifact does not carry (${identity}); a named`
        + ' observation that is missing is a broken pin, never an arm with less evidence in it',
      );
    }
  }
  const claimed = new Set(claimedIdentities);
  for (const identity of consumed) {
    if (claimed.has(identity)) {
      throw new CiFlowOptimizationError(
        'ObservationAlreadyClaimed',
        `observation ${identity} has already been consumed by another comparison; one run cannot`
        + ' close two of them, or the same improvement is spent twice on two unrelated changes',
      );
    }
  }

  const baselineReading = armReading(comparison.baseline, byIdentity);
  const candidateReading = armReading(comparison.candidate, byIdentity);
  // The WHOLE comparison is withheld when either arm is short, not the short half of it. A median
  // published beside a null is an invitation to compare it against nothing, and the sample sizes
  // below still tell the operator how far from a legal reading they are.
  const readable = baselineReading.sampleSize >= CI_FLOW_MIN_SAMPLE
    && candidateReading.sampleSize >= CI_FLOW_MIN_SAMPLE;
  const claimedOut = Object.freeze([...consumed].sort(ordinal));

  const shape = (verdict, reasonCode, deltaMs) => Object.freeze({
    schema: CI_FLOW_COMPARISON_SCHEMA,
    verdict,
    reasonCode,
    lever: comparison.lever,
    baselineRevision: comparison.baselineRevision,
    guard: { ...comparison.guard },
    baselineP50Ms: readable ? baselineReading.medianMs : null,
    candidateP50Ms: readable ? candidateReading.medianMs : null,
    deltaMs,
    baselineSampleSize: baselineReading.sampleSize,
    candidateSampleSize: candidateReading.sampleSize,
    claimedIdentities: claimedOut,
  });

  if (!readable) return shape('UNKNOWN', 'INSUFFICIENT_HISTORY', null);
  const deltaMs = candidateReading.medianMs - baselineReading.medianMs;
  if (deltaMs > comparison.guard.maxRegressionMs) return shape('REVERT', null, deltaMs);
  if (deltaMs <= -comparison.guard.minImprovementMs) return shape('KEEP', null, deltaMs);
  // Inside the guard in both directions. Naming that is the whole point: the alternative is
  // reporting whichever of KEEP or REVERT the sign of a gap smaller than the guard happens
  // to suggest, which is noise wearing a decision.
  return shape('UNKNOWN', 'NO_DETECTABLE_EFFECT', deltaMs);
}
