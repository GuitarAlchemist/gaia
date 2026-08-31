/**
 * pr-review-thread.mjs — `gaia-pr-review-thread/1`, the closed reading of whether one GitHub pull
 * request review thread is an actionable finding, and what may be done about it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Gaia read PR #39 as mergeable because CI was green, while a `COMMENTED` Codex review on it
 * carried two P1 inline findings. A `COMMENTED` review never moves `reviewDecision`, so no gate
 * activated and nothing was measured. The defect is not a missing poll: it is that the pump read
 * *GitHub's review state* as if it were *the severity of what the review said*.
 *
 * THE TWO FACTS, KEPT APART
 * -------------------------
 * `reviewState` is republished from GitHub verbatim. `severity` is measured here, from the
 * thread's own inline comments, against a closed marker grammar. `blocksMerge` is a function of
 * the severity, the resolution and the dispute — and of nothing GitHub decided. An `APPROVED`
 * review carrying a P0 thread blocks; a `CHANGES_REQUESTED` review carrying only a P3 does not.
 *
 * An absent marker is `UNCLASSIFIED` with a named reason, never `P3` and never `NONE`. Nobody
 * writing a severity and somebody writing that this is minor are different states of the world,
 * and only one of them is a measurement.
 *
 * WHY THE GRAMMAR IS CLOSED
 * -------------------------
 * A classifier loose enough to read prose lets the sentence "this is not a P1 concern" open a
 * blocker. Two line-anchored forms are accepted and everything else is `UNCLASSIFIED`, so a
 * blocker is opened by evidence rather than by a word.
 *
 * WHAT CANNOT ENTER
 * -----------------
 * The observation has exactly eleven fields and an unknown one is refused, so there is no
 * `heartbeatAt`, `pid` or `prompt` for a liveness signal to arrive in. Comment bodies are read
 * here and classified here, and nothing but the derived token and the comment ids leaves: no
 * caller of this module can obtain review prose back out of a reading or a rendered checklist.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It reads no file, opens no socket, holds no clock and performs no effect: `effect` and
 * `authority` are fixed at `NONE`. It cannot express an integration, an approval or a push,
 * because it has no port through which to express one.
 */

import { createHash } from 'node:crypto';

export const PR_REVIEW_THREAD_SCHEMA = 'gaia-pr-review-thread/1';
export const PR_REVIEW_THREAD_OBSERVATION_SCHEMA = 'gaia-pr-review-thread-observation/1';
export const PR_REVIEW_THREAD_READING_SCHEMA = 'gaia-pr-review-thread-reading/1';

/** GitHub's own fact about the enclosing review, republished and never interpreted. */
export const PR_REVIEW_STATES = Object.freeze([
  'PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED',
]);

/** Measured here, from the thread's comments. `UNCLASSIFIED` is a reading, not a default. */
export const PR_REVIEW_SEVERITIES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'UNCLASSIFIED']);
export const PR_REVIEW_ACTIONABLE_SEVERITIES = Object.freeze(['P0', 'P1']);

export const PR_REVIEW_APPLICABILITY_VERDICTS = Object.freeze(['APPLIES', 'STALE', 'UNKNOWN']);
export const PR_REVIEW_APPLICABILITY_BASES = Object.freeze([
  'SAME_HEAD', 'THREAD_OUTDATED', 'ANCHOR_REPROVEN', 'ANCHOR_CHANGED', 'ANCHOR_UNKNOWN',
]);

export const PR_REVIEW_CHECK_CONCLUSIONS = Object.freeze([
  'SUCCESS', 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'SKIPPED', 'NEUTRAL', 'UNKNOWN',
]);

export const PR_REVIEW_THREAD_STATES = Object.freeze([
  'NOT_ACTIONABLE', 'THREAD_RESOLVED', 'ACTIONABLE_UNCLAIMED', 'REPAIR_IN_PROGRESS',
  'AWAITING_VERIFICATION', 'AWAITING_COMMENT', 'AWAITING_RESOLUTION', 'REFUSED',
]);

export const PR_REVIEW_THREAD_ACTIONS = Object.freeze([
  'NONE', 'CLAIM', 'COMMENT', 'RESOLVE', 'REFUSE',
]);

/** The lifecycle issue #43 names, in its order, plus the only other terminal. */
export const PR_REVIEW_THREAD_TRANSITIONS = Object.freeze([
  'RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED', 'RESOLVED', 'REFUSED',
]);

export const PR_REVIEW_THREAD_LIFECYCLE = Object.freeze(
  PR_REVIEW_THREAD_TRANSITIONS.filter((verb) => verb !== 'REFUSED'),
);

/**
 * The five refusals the reading can reach, plus `AUTHORITY_REFUSED`, which only the durable half
 * can reach. It is declared here so that one closed vocabulary covers every refusal that can
 * become durable: a grant that was declined must not be recorded as an unverified repair.
 */
export const PR_REVIEW_THREAD_REFUSALS = Object.freeze([
  'FINDING_STALE', 'APPLICABILITY_UNKNOWN', 'THREAD_DISPUTED', 'REPAIR_UNVERIFIED',
  'PARTIALLY_ADDRESSED', 'AUTHORITY_REFUSED',
]);

export const PR_REVIEW_THREAD_IDENTITY_FIELDS = Object.freeze([
  'repository', 'pullRequestNumber', 'reviewThreadId', 'reviewedHeadOid',
]);

export const PR_REVIEW_THREAD_OBSERVATION_FIELDS = Object.freeze([
  'schema', 'observedAt', 'repository', 'pullRequest', 'review', 'reviewThread', 'currentHeadOid',
  'applicability', 'repair', 'checks', 'run', 'sourceRevision',
]);

export const PR_REVIEW_PULL_REQUEST_FIELDS = Object.freeze(['number', 'baseBranch']);
export const PR_REVIEW_REVIEW_FIELDS = Object.freeze([
  'id', 'state', 'submittedAt', 'reviewedHeadOid',
]);
export const PR_REVIEW_THREAD_FIELDS = Object.freeze([
  'id', 'path', 'line', 'isResolved', 'isOutdated', 'disputed', 'comments',
]);
export const PR_REVIEW_COMMENT_FIELDS = Object.freeze(['id', 'body']);
export const PR_REVIEW_APPLICABILITY_FIELDS = Object.freeze([
  'anchorDigestAtReview', 'anchorDigestAtCurrentHead',
]);
export const PR_REVIEW_REPAIR_FIELDS = Object.freeze([
  'headOid', 'descendsFromReviewedHead', 'touchesAnchorPath', 'commitsAheadOfReviewedHead',
  'addressedCommentIds',
]);
export const PR_REVIEW_CHECKS_FIELDS = Object.freeze([
  'headOid', 'requiredContexts', 'conclusions',
]);
export const PR_REVIEW_CONCLUSION_FIELDS = Object.freeze(['context', 'conclusion']);
export const PR_REVIEW_RUN_FIELDS = Object.freeze(['runId', 'laneGeneration']);

/**
 * Below this many completed lanes the ETA is `UNKNOWN` with a reason. A fabricated ETA is worse
 * than no ETA, because an operator plans against it.
 */
export const PR_REVIEW_ETA_MINIMUM_SAMPLE = 3;

/** The token a posted comment carries so reconciliation is exact rather than probable. */
export const PR_REVIEW_REPAIR_MARKER_PREFIX = 'gaia-repair-thread: ';

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const NODE_ID = /^[A-Za-z0-9_-]{1,255}$/u;
const CHECK_CONTEXT = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,127}$/u;
const RUN_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ANCHOR_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,255}$/u;
const MAX_COMMENT_BODY = 65_536;

export class PrReviewThreadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrReviewThreadError';
    this.code = code;
  }
}

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * A plain own-data object carrying exactly `fields`. Getters, symbol keys, non-enumerable
 * properties and foreign prototypes are refused rather than read, because reading them is how a
 * poisoned prototype or a side-effecting getter reaches a durable record.
 */
function exactObject(value, fields, label, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new PrReviewThreadError(code, `${label} must be a plain object`);
  }
  const own = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.some((key) => typeof key !== 'string')
      || own.length !== fields.length
      || own.some((key) => !fields.includes(key))
      || own.some((key) => !descriptors[key]?.enumerable
        || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new PrReviewThreadError(code, `${label} must contain exactly its schema fields`);
  }
  return value;
}

function matching(pattern, value, field, label, code) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new PrReviewThreadError(code, `${label}.${field} is not a canonical ${field}`);
  }
  return value;
}

function member(vocabulary, value, field, label, code) {
  if (!vocabulary.includes(value)) {
    throw new PrReviewThreadError(code, `${label}.${field} is outside its closed vocabulary`);
  }
  return value;
}

function positiveInteger(value, field, label, code) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PrReviewThreadError(code, `${label}.${field} must be a positive integer`);
  }
  return value;
}

function boolean(value, field, label, code) {
  if (typeof value !== 'boolean') {
    throw new PrReviewThreadError(code, `${label}.${field} must be a boolean`);
  }
  return value;
}

function instant(value, field, label, code) {
  if (typeof value !== 'string' || !INSTANT.test(value)
      || Number.isNaN(Date.parse(value))
      || new Date(Date.parse(value)).toISOString() !== value) {
    throw new PrReviewThreadError(code, `${label}.${field} must be an exact instant`);
  }
  return value;
}

/** A SHA-256 digest, or the explicit sentinel for "this was not measured". */
function digestOrUnknown(value, field, label, code) {
  if (value === 'UNKNOWN') return 'UNKNOWN';
  return matching(SHA256, value, field, label, code);
}

/* --------------------------------------------------------------------------------------------- *
 * Identity
 * ------------------------------------------------------------------------------------------- */

/**
 * The one identity recipe: repository, pull request, review thread and the head the finding was
 * MADE ON. Repository identity is lower-cased because GitHub owner and repository names are
 * case-insensitive, so two spellings must not mint two claims.
 *
 * Deliberately absent: the review id and the comment ids, so one `COMMENTED` review with two
 * inline comments in one thread is one claim; and the run id, the lane generation and the clock,
 * so a re-run, a restart or a second supervisor lands on the same claim rather than a second one.
 *
 * Deliberately present: the REVIEWED head. A genuine re-review of the same thread against a new
 * head is a new finding that has to be proven against the head it was made on, and a repair
 * verified against last week's head must not silently discharge it.
 */
export function prReviewThreadIdentity(binding) {
  const code = 'InvalidIdentity';
  exactObject(binding, PR_REVIEW_THREAD_IDENTITY_FIELDS, 'identity', code);
  return sha256({
    schema: PR_REVIEW_THREAD_SCHEMA,
    repository: matching(REPOSITORY, binding.repository, 'repository', 'identity', code)
      .toLowerCase(),
    pullRequestNumber: positiveInteger(binding.pullRequestNumber, 'pullRequestNumber', 'identity', code),
    reviewThreadId: matching(NODE_ID, binding.reviewThreadId, 'reviewThreadId', 'identity', code),
    reviewedHeadOid: matching(GIT_OID, binding.reviewedHeadOid, 'reviewedHeadOid', 'identity', code),
  });
}

export const repairIdentityMarker = (threadIdentity) => `${PR_REVIEW_REPAIR_MARKER_PREFIX}${
  matching(SHA256, threadIdentity, 'threadIdentity', 'marker', 'InvalidIdentity')}`;

/* --------------------------------------------------------------------------------------------- *
 * Severity, measured from the thread's own comments
 * ------------------------------------------------------------------------------------------- */

/**
 * The two accepted, line-anchored marker forms. Everything else is `UNCLASSIFIED`.
 *
 * The opener admits an optional list bullet and optional bold, then either a bracketed token
 * (`[P1]`) or a bare token immediately followed by a separator (`P1:`, `P0 —`). The bare form
 * REQUIRES that separator, which is the whole reason "this is not a P1 concern" and "the P10 lane
 * is fine" classify as nothing: neither begins a line with a severity token that introduces
 * something.
 */
const SEVERITY_OPENER = /^[^\S\n]{0,8}(?:[-*+][^\S\n]{1,4})?(?:\*\*)?(?:\[(P[0-3])\]|(P[0-3])[^\S\n]{0,4}[:–—-])/u;
const SEVERITY_LABEL = /^[^\S\n]{0,8}(?:\*\*)?Severity(?:\*\*)?[^\S\n]{0,4}:[^\S\n]{0,4}(?:\*\*)?\[?(P[0-3])\]?/iu;

const severityRank = (severity) => PR_REVIEW_SEVERITIES.indexOf(severity);

function requireComment(value, index) {
  const code = 'ObservationInvalid';
  const label = `reviewThread.comments[${index}]`;
  exactObject(value, PR_REVIEW_COMMENT_FIELDS, label, code);
  matching(NODE_ID, value.id, 'id', label, code);
  if (typeof value.body !== 'string' || value.body.length > MAX_COMMENT_BODY) {
    throw new PrReviewThreadError(code, `${label}.body must be bounded text`);
  }
  return { id: value.id, body: value.body };
}

/** The most severe marker one comment carries, or `UNCLASSIFIED`. */
function commentSeverity(body) {
  return body.split(/\r?\n/u).reduce((worst, line) => {
    const opener = SEVERITY_OPENER.exec(line);
    const label = SEVERITY_LABEL.exec(line);
    const found = opener?.[1] ?? opener?.[2] ?? label?.[1]?.toUpperCase() ?? null;
    if (found === null) return worst;
    return severityRank(found) < severityRank(worst) ? found : worst;
  }, 'UNCLASSIFIED');
}

/**
 * Classify one thread. The severity is the most severe marker across its comments; the actionable
 * comment ids are those comments that themselves carry a P0 or P1 marker, in comment order.
 */
export function classifyReviewThreadSeverity(comments) {
  if (!Array.isArray(comments) || comments.length === 0) {
    throw new PrReviewThreadError('ObservationInvalid', 'a review thread must carry a comment');
  }
  const classified = comments.map((entry, index) => {
    const { id, body } = requireComment(entry, index);
    return { id, severity: commentSeverity(body) };
  });
  const severity = classified.reduce(
    (worst, entry) => (severityRank(entry.severity) < severityRank(worst) ? entry.severity : worst),
    'UNCLASSIFIED',
  );
  return deepFreeze({
    severity,
    actionableCommentIds: classified
      .filter((entry) => PR_REVIEW_ACTIONABLE_SEVERITIES.includes(entry.severity))
      .map((entry) => entry.id),
    reason: severity === 'UNCLASSIFIED' ? 'NO_SEVERITY_MARKER' : 'MARKER_FOUND',
  });
}

/* --------------------------------------------------------------------------------------------- *
 * The closed observation
 * ------------------------------------------------------------------------------------------- */

const code = 'ObservationInvalid';

function requirePullRequest(value) {
  exactObject(value, PR_REVIEW_PULL_REQUEST_FIELDS, 'pullRequest', code);
  return {
    number: positiveInteger(value.number, 'number', 'pullRequest', code),
    baseBranch: matching(BRANCH, value.baseBranch, 'baseBranch', 'pullRequest', code),
  };
}

function requireReview(value) {
  exactObject(value, PR_REVIEW_REVIEW_FIELDS, 'review', code);
  return {
    id: matching(NODE_ID, value.id, 'id', 'review', code),
    state: member(PR_REVIEW_STATES, value.state, 'state', 'review', code),
    submittedAt: instant(value.submittedAt, 'submittedAt', 'review', code),
    reviewedHeadOid: matching(GIT_OID, value.reviewedHeadOid, 'reviewedHeadOid', 'review', code),
  };
}

function requireThread(value) {
  exactObject(value, PR_REVIEW_THREAD_FIELDS, 'reviewThread', code);
  if (!Array.isArray(value.comments)) {
    throw new PrReviewThreadError(code, 'reviewThread.comments must be an array');
  }
  return {
    id: matching(NODE_ID, value.id, 'id', 'reviewThread', code),
    path: matching(ANCHOR_PATH, value.path, 'path', 'reviewThread', code),
    line: positiveInteger(value.line, 'line', 'reviewThread', code),
    isResolved: boolean(value.isResolved, 'isResolved', 'reviewThread', code),
    isOutdated: boolean(value.isOutdated, 'isOutdated', 'reviewThread', code),
    disputed: boolean(value.disputed, 'disputed', 'reviewThread', code),
    comments: value.comments.map((entry, index) => requireComment(entry, index)),
  };
}

function requireApplicabilityEvidence(value) {
  exactObject(value, PR_REVIEW_APPLICABILITY_FIELDS, 'applicability', code);
  return {
    anchorDigestAtReview: digestOrUnknown(
      value.anchorDigestAtReview, 'anchorDigestAtReview', 'applicability', code,
    ),
    anchorDigestAtCurrentHead: digestOrUnknown(
      value.anchorDigestAtCurrentHead, 'anchorDigestAtCurrentHead', 'applicability', code,
    ),
  };
}

function requireRepair(value) {
  if (value === null) return null;
  exactObject(value, PR_REVIEW_REPAIR_FIELDS, 'repair', code);
  if (!Array.isArray(value.addressedCommentIds)) {
    throw new PrReviewThreadError(code, 'repair.addressedCommentIds must be an array');
  }
  if (!Number.isSafeInteger(value.commitsAheadOfReviewedHead)
      || value.commitsAheadOfReviewedHead < 0) {
    throw new PrReviewThreadError(
      code, 'repair.commitsAheadOfReviewedHead must be a non-negative integer',
    );
  }
  return {
    headOid: matching(GIT_OID, value.headOid, 'headOid', 'repair', code),
    descendsFromReviewedHead: boolean(
      value.descendsFromReviewedHead, 'descendsFromReviewedHead', 'repair', code,
    ),
    touchesAnchorPath: boolean(value.touchesAnchorPath, 'touchesAnchorPath', 'repair', code),
    commitsAheadOfReviewedHead: value.commitsAheadOfReviewedHead,
    addressedCommentIds: value.addressedCommentIds.map(
      (id, index) => matching(NODE_ID, id, `addressedCommentIds[${index}]`, 'repair', code),
    ),
  };
}

function requireChecks(value) {
  if (value === null) return null;
  exactObject(value, PR_REVIEW_CHECKS_FIELDS, 'checks', code);
  if (!Array.isArray(value.requiredContexts) || !Array.isArray(value.conclusions)) {
    throw new PrReviewThreadError(code, 'checks.requiredContexts and .conclusions must be arrays');
  }
  return {
    headOid: matching(GIT_OID, value.headOid, 'headOid', 'checks', code),
    requiredContexts: value.requiredContexts.map(
      (context, index) => matching(CHECK_CONTEXT, context, `requiredContexts[${index}]`, 'checks', code),
    ),
    conclusions: value.conclusions.map((entry, index) => {
      const label = `checks.conclusions[${index}]`;
      exactObject(entry, PR_REVIEW_CONCLUSION_FIELDS, label, code);
      return {
        context: matching(CHECK_CONTEXT, entry.context, 'context', label, code),
        conclusion: member(PR_REVIEW_CHECK_CONCLUSIONS, entry.conclusion, 'conclusion', label, code),
      };
    }),
  };
}

function requireRun(value) {
  exactObject(value, PR_REVIEW_RUN_FIELDS, 'run', code);
  return {
    runId: matching(RUN_ID, value.runId, 'runId', 'run', code),
    laneGeneration: positiveInteger(value.laneGeneration, 'laneGeneration', 'run', code),
  };
}

/** Normalize one observation, refusing anything the contract cannot name. */
export function requirePrReviewThreadObservation(observation) {
  exactObject(observation, PR_REVIEW_THREAD_OBSERVATION_FIELDS, 'observation', code);
  if (observation.schema !== PR_REVIEW_THREAD_OBSERVATION_SCHEMA) {
    throw new PrReviewThreadError(code, 'observation.schema is not this contract');
  }
  return deepFreeze({
    schema: observation.schema,
    observedAt: instant(observation.observedAt, 'observedAt', 'observation', code),
    repository: matching(REPOSITORY, observation.repository, 'repository', 'observation', code),
    pullRequest: requirePullRequest(observation.pullRequest),
    review: requireReview(observation.review),
    reviewThread: requireThread(observation.reviewThread),
    currentHeadOid: matching(GIT_OID, observation.currentHeadOid, 'currentHeadOid', 'observation', code),
    applicability: requireApplicabilityEvidence(observation.applicability),
    repair: requireRepair(observation.repair),
    checks: requireChecks(observation.checks),
    run: requireRun(observation.run),
    sourceRevision: matching(SHA256, observation.sourceRevision, 'sourceRevision', 'observation', code),
  });
}

/* --------------------------------------------------------------------------------------------- *
 * Applicability — does the finding still apply to the current head?
 * ------------------------------------------------------------------------------------------- */

/**
 * Derived only from what GitHub and git already publish. `UNKNOWN` is not a yes: an unmeasured
 * anchor is an unanswered question, and a pump that treats an unanswered question as a yes is the
 * defect this feature repairs, pointing the other way.
 */
export function derivePrReviewThreadApplicability(observation) {
  const observed = Object.isFrozen(observation) && observation.schema
    === PR_REVIEW_THREAD_OBSERVATION_SCHEMA && Object.hasOwn(observation, 'reviewThread')
    ? observation
    : requirePrReviewThreadObservation(observation);
  const verdict = (result, basis) => deepFreeze({ verdict: result, basis });
  if (observed.reviewThread.isOutdated) return verdict('STALE', 'THREAD_OUTDATED');
  if (observed.currentHeadOid === observed.review.reviewedHeadOid) {
    return verdict('APPLIES', 'SAME_HEAD');
  }
  const { anchorDigestAtReview: atReview, anchorDigestAtCurrentHead: atHead } = observed.applicability;
  if (atReview === 'UNKNOWN' || atHead === 'UNKNOWN') return verdict('UNKNOWN', 'ANCHOR_UNKNOWN');
  return atReview === atHead
    ? verdict('APPLIES', 'ANCHOR_REPROVEN')
    : verdict('STALE', 'ANCHOR_CHANGED');
}

/* --------------------------------------------------------------------------------------------- *
 * The plan
 * ------------------------------------------------------------------------------------------- */

/**
 * The distinct transitions recorded for one identity, in canonical order. A history that is not a
 * contiguous prefix of the lifecycle — a gap, a reordering, an unknown verb — is corrupt and is
 * refused rather than interpreted, because `VERIFIED` without `REPAIRED` is a claim that verified
 * nothing.
 */
function requireHistory(history) {
  if (!Array.isArray(history)) {
    throw new PrReviewThreadError('HistoryInvalid', 'history must be an array of transitions');
  }
  const refused = history.at(-1) === 'REFUSED';
  const prefix = refused ? history.slice(0, -1) : history;
  const expected = PR_REVIEW_THREAD_LIFECYCLE.slice(0, prefix.length);
  if (prefix.length !== expected.length
      || prefix.some((verb, index) => verb !== expected[index])) {
    throw new PrReviewThreadError(
      'HistoryInvalid', 'history must be a contiguous prefix of the lifecycle',
    );
  }
  return { seen: new Set(history), refused };
}

/**
 * Decide what may be done about one review thread, from one observation and the transitions
 * already durable for it. Pure: it reads nothing, and every gate below is re-derived from the
 * observation rather than recalled from the ledger, because the failure mode is a world that
 * moved after the claim was written.
 */
export function planPrReviewThreadRepair({ observation, history = [] }) {
  const observed = requirePrReviewThreadObservation(observation);
  const { seen } = requireHistory(history);
  const classified = classifyReviewThreadSeverity(observed.reviewThread.comments);
  const applicable = derivePrReviewThreadApplicability(observed);
  const threadIdentity = prReviewThreadIdentity({
    repository: observed.repository,
    pullRequestNumber: observed.pullRequest.number,
    reviewThreadId: observed.reviewThread.id,
    reviewedHeadOid: observed.review.reviewedHeadOid,
  });

  const actionable = PR_REVIEW_ACTIONABLE_SEVERITIES.includes(classified.severity);
  // Not a function of `reviewState`. That is the whole feature.
  const blocksMerge = actionable
    && !observed.reviewThread.isResolved
    && !observed.reviewThread.disputed;

  const { repair, checks } = observed;
  const addressed = new Set(repair?.addressedCommentIds ?? []);
  const { actionableCommentIds } = classified;
  const covered = repair !== null
    && actionableCommentIds.every((id) => addressed.has(id));
  const repairProven = repair !== null
    && repair.descendsFromReviewedHead
    && repair.touchesAnchorPath;

  const byContext = new Map((checks?.conclusions ?? []).map(
    (entry) => [entry.context, entry.conclusion],
  ));
  const required = checks?.requiredContexts ?? [];
  const checksBindRepair = checks !== null && repair !== null && checks.headOid === repair.headOid;
  const everyRequiredReported = required.length > 0 && required.every((c) => byContext.has(c));
  const anyRequiredPending = everyRequiredReported
    && required.some((c) => byContext.get(c) === 'UNKNOWN');
  const verificationProven = checksBindRepair && everyRequiredReported && !anyRequiredPending
    && required.every((c) => byContext.get(c) === 'SUCCESS');

  const reading = (state, action, refusal = null) => deepFreeze({
    ...(() => {
      const body = {
        schema: PR_REVIEW_THREAD_READING_SCHEMA,
        state,
        action,
        refusal,
        reviewState: observed.review.state,
        severity: classified.severity,
        severityReason: classified.reason,
        actionableCommentIds: [...actionableCommentIds],
        blocksMerge,
        applicability: applicable.verdict,
        applicabilityBasis: applicable.basis,
        threadIdentity,
        repairHeadOid: repair?.headOid ?? null,
        repairProven,
        verificationProven,
        effect: 'NONE',
        authority: 'NONE',
      };
      return { ...body, revision: sha256(body) };
    })(),
  });

  if (seen.has('REFUSED')) return reading('REFUSED', 'NONE');
  if (seen.has('RESOLVED') || observed.reviewThread.isResolved) {
    return reading('THREAD_RESOLVED', 'NONE');
  }
  if (!actionable) return reading('NOT_ACTIONABLE', 'NONE');
  if (observed.reviewThread.disputed) return reading('REFUSED', 'REFUSE', 'THREAD_DISPUTED');
  // One gate, two tokens. `STALE` and `UNKNOWN` both refuse; only `APPLIES` may proceed.
  if (applicable.verdict !== 'APPLIES') {
    return reading(
      'REFUSED', 'REFUSE',
      applicable.verdict === 'STALE' ? 'FINDING_STALE' : 'APPLICABILITY_UNKNOWN',
    );
  }
  if (!seen.has('CLAIMED')) return reading('ACTIONABLE_UNCLAIMED', 'CLAIM');
  if (!repairProven) return reading('REPAIR_IN_PROGRESS', 'NONE');
  if (checks === null) return reading('AWAITING_VERIFICATION', 'NONE');
  if (!checksBindRepair || !everyRequiredReported) {
    // A check run at another head is not evidence about this one, a required context absent from
    // the reported conclusions is not a passing check, and an empty required set is not proof.
    return reading('REFUSED', 'REFUSE', 'REPAIR_UNVERIFIED');
  }
  if (anyRequiredPending) return reading('AWAITING_VERIFICATION', 'NONE');
  if (!verificationProven) return reading('REFUSED', 'REFUSE', 'REPAIR_UNVERIFIED');
  if (!covered) return reading('REFUSED', 'REFUSE', 'PARTIALLY_ADDRESSED');
  if (!seen.has('COMMENTED')) return reading('AWAITING_COMMENT', 'COMMENT');
  return reading('AWAITING_RESOLUTION', 'RESOLVE');
}

/* --------------------------------------------------------------------------------------------- *
 * The evidence-based ETA, and the published checklist
 * ------------------------------------------------------------------------------------------- */

/**
 * The median observed `CLAIMED` -> `RESOLVED` duration of this ledger's own completed lanes.
 * Below the declared minimum sample it publishes `UNKNOWN` with a reason rather than a number.
 */
export function estimateRepairEta(lanes) {
  if (!Array.isArray(lanes)) {
    throw new PrReviewThreadError('EtaRequestInvalid', 'lanes must be an array');
  }
  const durations = lanes
    .filter((lane) => typeof lane?.claimedAt === 'string' && typeof lane?.resolvedAt === 'string')
    .map((lane) => Date.parse(lane.resolvedAt) - Date.parse(lane.claimedAt))
    .filter((duration) => Number.isFinite(duration) && duration >= 0)
    .sort((left, right) => left - right);
  if (durations.length < PR_REVIEW_ETA_MINIMUM_SAMPLE) {
    return deepFreeze({
      state: 'UNKNOWN', medianMs: null, sampleSize: durations.length,
      reason: 'INSUFFICIENT_HISTORY',
    });
  }
  const middle = Math.floor(durations.length / 2);
  return deepFreeze({
    state: 'MEASURED',
    medianMs: durations.length % 2 === 1
      ? durations[middle]
      : Math.round((durations[middle - 1] + durations[middle]) / 2),
    sampleSize: durations.length,
    reason: null,
  });
}

const hours = (milliseconds) => `${Math.round(milliseconds / 360_000) / 10} hours`;

/**
 * The one comment this pump ever posts. It carries origin, the checklist, the current step, the
 * ETA, the commit and check evidence, and the identity marker that makes reconciliation exact.
 *
 * Every value below is a derived token, an identifier, an oid or a check context. No comment body
 * is reachable from here, so a credential or a path pasted into a review cannot be republished by
 * the thing that answers it.
 */
export function renderRepairChecklist({ reading, observation, eta, history = [] }) {
  const observed = requirePrReviewThreadObservation(observation);
  if (!Array.isArray(history)
      || history.some((verb) => !PR_REVIEW_THREAD_TRANSITIONS.includes(verb))) {
    throw new PrReviewThreadError('HistoryInvalid', 'checklist history must use lifecycle verbs');
  }
  const done = new Set(history);
  const currentStep = PR_REVIEW_THREAD_LIFECYCLE.find((verb) => !done.has(verb)) ?? 'RESOLVED';
  const checklist = PR_REVIEW_THREAD_LIFECYCLE.map(
    (verb) => `- [${done.has(verb) ? 'x' : ' '}] ${verb.toLowerCase()}`,
  ).join('\n');
  const etaLine = eta.state === 'MEASURED'
    ? `${hours(eta.medianMs)} (median of ${eta.sampleSize} completed repair lanes)`
    : `UNKNOWN (${eta.reason}; ${eta.sampleSize} completed repair lanes observed)`;

  return [
    '## Gaia bounded repair claim',
    '',
    `**Origin:** review thread \`${observed.reviewThread.id}\` on `
      + `${observed.repository}#${observed.pullRequest.number}, `
      + `anchored at \`${observed.reviewThread.path}\` line ${observed.reviewThread.line}.`,
    `**Review state:** ${observed.review.state}. **Measured severity:** ${reading.severity} `
      + `(${reading.severityReason}). These are separate facts; the severity is measured from the `
      + 'thread\'s own comments and is not derived from the review state.',
    `**Applicability:** ${reading.applicability} (${reading.applicabilityBasis}).`,
    '',
    `**Reviewed head:** \`${observed.review.reviewedHeadOid}\``,
    `**Repair head:** \`${reading.repairHeadOid ?? 'UNKNOWN'}\``,
    `**Required checks at the repair head:** ${
      (observed.checks?.requiredContexts ?? []).join(', ') || 'UNKNOWN'}`,
    `**Addressed comments:** ${reading.actionableCommentIds.join(', ')}`,
    '',
    '### Checklist',
    checklist,
    '',
    `**Current step:** ${currentStep.toLowerCase()}`,
    `**ETA:** ${etaLine}`,
    '',
    repairIdentityMarker(reading.threadIdentity),
  ].join('\n');
}
