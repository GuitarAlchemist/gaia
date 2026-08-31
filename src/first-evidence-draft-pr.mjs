/**
 * first-evidence-draft-pr.mjs — `gaia-first-evidence-draft-pr/1`, the closed reading of whether
 * a task's first evidence-bearing commit is visible on GitHub as a Draft pull request.
 *
 * WHY THIS EXISTS
 * ---------------
 * The control room could already say *a lane is alive* and *nothing tracked is claimed*. Neither
 * is repository movement. This module answers one different question — is there a durable commit,
 * and is it visible — and it answers it with a denominator, so "no Draft PR" is a measurement
 * rather than a silence.
 *
 * WHAT CANNOT ENTER, AND WHY THAT IS A CONSTRUCTION RATHER THAN A PROMISE
 * ----------------------------------------------------------------------
 * The observation has exactly thirteen fields and an unknown one is refused, so there is no
 * `heartbeatAt`, `pid`, `prompt` or `wrapperStartedAt` for a wrapper start or a liveness signal to
 * arrive in. An activity signal is not weighted low here, it is unsayable.
 *
 * The same construction carries "committed, not merely changed". Evidence has exactly one
 * admissible `durability`, `COMMITTED`, and carries a measured `commitsAheadOfBase`. This is the
 * load-bearing difference from the existing candidate publication path, where the candidate is an
 * uncommitted working-tree diff and `candidate.headOid` is the BASE commit — an ancestor that
 * predates the run. A Draft PR bound to that value would be bound to work that never happened.
 *
 * IDENTITY
 * --------
 * The operation identity binds canonical repository identity, task identity, base branch, head
 * branch generation and the evidence-bearing head SHA. It deliberately does NOT bind the run id,
 * the lane generation, the clock or the source revision: those are recorded on every transition,
 * but if they entered the identity then re-running the same task would mint a second identity and
 * therefore a second pull request, which is the exact defect this contract exists to prevent.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It reads nothing, opens nothing, holds no clock and performs no effect: `effect` and `authority`
 * are fixed at `NONE`. Draft visibility is not approval, and this module cannot express a merge, a
 * deployment, a retry or a promotion to ready.
 */

import { createHash } from 'node:crypto';

import { isExactInstant } from './local-lane-observation.mjs';

export const FIRST_EVIDENCE_DRAFT_PR_SCHEMA = 'gaia-first-evidence-draft-pr/1';
export const FIRST_EVIDENCE_OBSERVATION_SCHEMA = 'gaia-first-evidence-draft-pr-observation/1';
export const FIRST_EVIDENCE_VISIBILITY_SCHEMA = 'gaia-first-evidence-draft-pr-visibility/1';

/**
 * The four absence states, in the order the operator reads them: healthy idle, the pre-commit
 * gate, the gap this feature closes, and the goal. Only `MISSING_DRAFT` may reach an effect.
 */
export const DRAFT_PR_PRESENCE_STATES = Object.freeze([
  'EXPECTED_NONE', 'AWAITING_FIRST_COMMIT', 'MISSING_DRAFT', 'DRAFT_OPEN',
]);

export const DRAFT_PR_TERMINAL_OUTCOMES = Object.freeze(['CREATED', 'REUSED', 'REFUSED']);
export const DRAFT_PR_TRANSITIONS = Object.freeze(['INTENT', ...DRAFT_PR_TERMINAL_OUTCOMES]);

export const FIRST_EVIDENCE_IDENTITY_FIELDS = Object.freeze([
  'repository', 'task', 'baseBranch', 'headBranch', 'headBranchGeneration', 'evidenceHeadOid',
]);

export const FIRST_EVIDENCE_OBSERVATION_FIELDS = Object.freeze([
  'schema', 'observedAt', 'repository', 'task', 'baseBranch', 'baseOid', 'headBranch',
  'headBranchGeneration', 'run', 'sourceRevision', 'claim', 'evidence', 'drafts',
]);

export const FIRST_EVIDENCE_TASK_FIELDS = Object.freeze(['kind', 'number']);
export const FIRST_EVIDENCE_RUN_FIELDS = Object.freeze(['runId', 'laneGeneration']);

export const FIRST_EVIDENCE_EVIDENCE_FIELDS = Object.freeze([
  'headOid', 'baseOid', 'committedAt', 'durability', 'commitsAheadOfBase',
]);

export const FIRST_EVIDENCE_DRAFT_FIELDS = Object.freeze([
  'number', 'url', 'headOid', 'baseBranch', 'isDraft', 'state', 'operationIdentity',
]);

/** The only task kind this contract can name. A pull request is not a first-evidence subject. */
export const FIRST_EVIDENCE_TASK_KINDS = Object.freeze(['ISSUE']);

/** The only durability that is evidence. There is deliberately no token for a dirty tree. */
export const FIRST_EVIDENCE_DURABILITY = 'COMMITTED';

export const DRAFT_PR_CLAIM_STATES = Object.freeze(['CLAIMED', 'UNCLAIMED']);
export const DRAFT_PR_CI_STATES = Object.freeze(['UNKNOWN', 'PENDING', 'PASSING', 'FAILING']);
export const DRAFT_PR_REVIEW_GATES = Object.freeze([
  'UNKNOWN', 'NOT_REQUESTED', 'PENDING', 'APPROVED', 'CHANGES_REQUESTED',
]);

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RUN_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const PULL_REQUEST_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9]\d*$/u;

export class FirstEvidenceDraftPrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FirstEvidenceDraftPrError';
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
    throw new FirstEvidenceDraftPrError(code, `${label} must be a plain object`);
  }
  const own = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.some((key) => typeof key !== 'string')
      || own.length !== fields.length
      || own.some((key) => !fields.includes(key))
      || own.some((key) => !descriptors[key]?.enumerable
        || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new FirstEvidenceDraftPrError(code, `${label} must contain exactly its schema fields`);
  }
  return value;
}

const matching = (pattern, value, field, label, code) => {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new FirstEvidenceDraftPrError(code, `${label}.${field} is not a canonical ${field}`);
  }
  return value;
};

function requireTask(value, label, code) {
  exactObject(value, FIRST_EVIDENCE_TASK_FIELDS, `${label}.task`, code);
  if (!FIRST_EVIDENCE_TASK_KINDS.includes(value.kind)) {
    throw new FirstEvidenceDraftPrError(code, `${label}.task.kind is not a known task kind`);
  }
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    throw new FirstEvidenceDraftPrError(code, `${label}.task.number must be a positive integer`);
  }
  return { kind: value.kind, number: value.number };
}

function requireBranch(value, field, label, code) {
  const branch = matching(BRANCH, value, field, label, code);
  if (branch.includes('..') || branch.endsWith('.lock') || branch.endsWith('/')) {
    throw new FirstEvidenceDraftPrError(code, `${label}.${field} is not a conservative branch`);
  }
  return branch;
}

function requireGeneration(value, label, code) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FirstEvidenceDraftPrError(
      code, `${label}.headBranchGeneration must be a positive integer`,
    );
  }
  return value;
}

/**
 * The one identity recipe. Repository identity is lower-cased because GitHub owner and repository
 * names are case-insensitive, so two spellings of one repository must not mint two operations.
 */
export function firstEvidenceOperationIdentity(binding) {
  const code = 'InvalidIdentity';
  exactObject(binding, FIRST_EVIDENCE_IDENTITY_FIELDS, 'identity', code);
  return sha256({
    schema: FIRST_EVIDENCE_DRAFT_PR_SCHEMA,
    repository: matching(REPOSITORY, binding.repository, 'repository', 'identity', code)
      .toLowerCase(),
    task: requireTask(binding.task, 'identity', code),
    baseBranch: requireBranch(binding.baseBranch, 'baseBranch', 'identity', code),
    headBranch: requireBranch(binding.headBranch, 'headBranch', 'identity', code),
    headBranchGeneration: requireGeneration(binding.headBranchGeneration, 'identity', code),
    evidenceHeadOid: matching(GIT_OID, binding.evidenceHeadOid, 'evidenceHeadOid', 'identity', code),
  });
}

function requireEvidence(value) {
  const code = 'InvalidObservation';
  exactObject(value, FIRST_EVIDENCE_EVIDENCE_FIELDS, 'evidence', code);
  if (value.durability !== FIRST_EVIDENCE_DURABILITY) {
    throw new FirstEvidenceDraftPrError(
      code, 'evidence.durability must be COMMITTED; an uncommitted change is not evidence',
    );
  }
  if (!isExactInstant(value.committedAt)) {
    throw new FirstEvidenceDraftPrError(code, 'evidence.committedAt must be an exact instant');
  }
  if (!Number.isSafeInteger(value.commitsAheadOfBase) || value.commitsAheadOfBase < 0) {
    throw new FirstEvidenceDraftPrError(
      code, 'evidence.commitsAheadOfBase must be a non-negative integer',
    );
  }
  return {
    headOid: matching(GIT_OID, value.headOid, 'headOid', 'evidence', code),
    baseOid: matching(GIT_OID, value.baseOid, 'baseOid', 'evidence', code),
    committedAt: value.committedAt,
    durability: value.durability,
    commitsAheadOfBase: value.commitsAheadOfBase,
  };
}

function requireDraft(value) {
  const code = 'InvalidObservation';
  exactObject(value, FIRST_EVIDENCE_DRAFT_FIELDS, 'draft', code);
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    throw new FirstEvidenceDraftPrError(code, 'draft.number must be a positive integer');
  }
  if (typeof value.isDraft !== 'boolean') {
    throw new FirstEvidenceDraftPrError(code, 'draft.isDraft must be a boolean');
  }
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(value.state)) {
    throw new FirstEvidenceDraftPrError(code, 'draft.state must be OPEN, CLOSED or MERGED');
  }
  return {
    number: value.number,
    url: matching(PULL_REQUEST_URL, value.url, 'url', 'draft', code),
    headOid: matching(GIT_OID, value.headOid, 'headOid', 'draft', code),
    baseBranch: requireBranch(value.baseBranch, 'baseBranch', 'draft', code),
    isDraft: value.isDraft,
    state: value.state,
    operationIdentity: matching(SHA256, value.operationIdentity, 'operationIdentity', 'draft', code),
  };
}

/** Validate and normalize one observation. Named reads only; no record is ever spread. */
export function requireFirstEvidenceObservation(value) {
  const code = 'InvalidObservation';
  exactObject(value, FIRST_EVIDENCE_OBSERVATION_FIELDS, 'observation', code);
  if (value.schema !== FIRST_EVIDENCE_OBSERVATION_SCHEMA) {
    throw new FirstEvidenceDraftPrError(code, 'observation.schema is not this contract');
  }
  if (!isExactInstant(value.observedAt)) {
    throw new FirstEvidenceDraftPrError(code, 'observation.observedAt must be an exact instant');
  }
  if (!DRAFT_PR_CLAIM_STATES.includes(value.claim)) {
    throw new FirstEvidenceDraftPrError(code, 'observation.claim must be CLAIMED or UNCLAIMED');
  }
  exactObject(value.run, FIRST_EVIDENCE_RUN_FIELDS, 'observation.run', code);
  if (!Number.isSafeInteger(value.run.laneGeneration) || value.run.laneGeneration < 0) {
    throw new FirstEvidenceDraftPrError(
      code, 'observation.run.laneGeneration must be a non-negative integer',
    );
  }
  if (!Array.isArray(value.drafts)) {
    throw new FirstEvidenceDraftPrError(code, 'observation.drafts must be an array');
  }
  return deepFreeze({
    schema: value.schema,
    observedAt: value.observedAt,
    repository: matching(REPOSITORY, value.repository, 'repository', 'observation', code),
    task: requireTask(value.task, 'observation', code),
    baseBranch: requireBranch(value.baseBranch, 'baseBranch', 'observation', code),
    baseOid: matching(GIT_OID, value.baseOid, 'baseOid', 'observation', code),
    headBranch: requireBranch(value.headBranch, 'headBranch', 'observation', code),
    headBranchGeneration: requireGeneration(value.headBranchGeneration, 'observation', code),
    run: {
      runId: matching(RUN_ID, value.run.runId, 'runId', 'observation.run', code),
      laneGeneration: value.run.laneGeneration,
    },
    sourceRevision: matching(SHA256, value.sourceRevision, 'sourceRevision', 'observation', code),
    claim: value.claim,
    evidence: value.evidence === null ? null : requireEvidence(value.evidence),
    drafts: value.drafts.map(requireDraft),
  });
}

const plan = (state, action, refusal, operationIdentity, pullRequest) => deepFreeze({
  schema: FIRST_EVIDENCE_DRAFT_PR_SCHEMA,
  state,
  action,
  refusal,
  operationIdentity,
  pullRequest,
  effect: 'NONE',
  authority: 'NONE',
});

/**
 * Decide which of the four absence states holds, and whether create-or-reuse may proceed.
 *
 * Stale, future, contradictory and unclaimed evidence throw rather than degrade to a healthy
 * state: a silent downgrade to `AWAITING_FIRST_COMMIT` would report corruption as patience.
 */
export function planFirstEvidenceDraftPr({ observation }) {
  const observed = requireFirstEvidenceObservation(observation);
  const { evidence } = observed;

  if (evidence === null) {
    return plan(
      observed.claim === 'CLAIMED' ? 'AWAITING_FIRST_COMMIT' : 'EXPECTED_NONE',
      'NONE', null, null, null,
    );
  }
  if (observed.claim !== 'CLAIMED') {
    throw new FirstEvidenceDraftPrError(
      'EvidenceUnclaimed', 'a commit exists for an item nothing has claimed',
    );
  }
  if (evidence.baseOid !== observed.baseOid) {
    throw new FirstEvidenceDraftPrError(
      'EvidenceBaseChanged', 'the evidence was measured against a different base',
    );
  }
  if (Date.parse(evidence.committedAt) > Date.parse(observed.observedAt)) {
    throw new FirstEvidenceDraftPrError(
      'EvidenceFromFuture', 'the evidence claims to have been committed after it was observed',
    );
  }
  if ((evidence.headOid === evidence.baseOid) !== (evidence.commitsAheadOfBase === 0)) {
    throw new FirstEvidenceDraftPrError(
      'EvidenceIncoherent', 'the measured commit count disagrees with the measured object ids',
    );
  }
  if (evidence.commitsAheadOfBase === 0) {
    return plan('AWAITING_FIRST_COMMIT', 'NONE', null, null, null);
  }

  const operationIdentity = firstEvidenceOperationIdentity({
    repository: observed.repository,
    task: observed.task,
    baseBranch: observed.baseBranch,
    headBranch: observed.headBranch,
    headBranchGeneration: observed.headBranchGeneration,
    evidenceHeadOid: evidence.headOid,
  });
  const refuse = (refusal) => plan('MISSING_DRAFT', 'REFUSE', refusal, operationIdentity, null);

  if (observed.drafts.length === 0) {
    return plan('MISSING_DRAFT', 'CREATE_OR_REUSE', null, operationIdentity, null);
  }
  const matches = observed.drafts.filter((candidate) => candidate.operationIdentity === operationIdentity
    && candidate.headOid === evidence.headOid
    && candidate.baseBranch === observed.baseBranch);
  if (matches.length > 1) return refuse('DraftAmbiguous');
  if (matches.length === 0) return refuse('DraftIdentityConflict');
  const [found] = matches;
  if (!found.isDraft) return refuse('DraftPromoted');
  if (found.state !== 'OPEN') return refuse('DraftClosed');
  return plan('DRAFT_OPEN', 'NONE', null, operationIdentity, found);
}

const ageMs = (observedAt, instant) => (instant === null || instant === undefined
  ? null
  : Date.parse(observedAt) - Date.parse(instant));

const closedToken = (value, allowed) => (allowed.includes(value) ? value : 'UNKNOWN');

/**
 * One control-room block. It reports Draft age, last-commit age, CI state, review gate and
 * obstruction, and it says in its own vocabulary that it measures no local process liveness —
 * `liveness: 'NOT_MEASURED_HERE'` exists so that a reader cannot mistake this block's silence
 * about a lane for a claim that the lane is dead.
 *
 * Nothing here is a spread. The pull request contributes exactly its number and its URL; a title,
 * a body, a branch path or an author would have to be named to travel, and none is.
 */
export function deriveDraftVisibilityBlock({ observation, observedAt, pullRequest = null }) {
  const decided = planFirstEvidenceDraftPr({ observation });
  const observed = requireFirstEvidenceObservation(observation);
  if (!isExactInstant(observedAt)) {
    throw new FirstEvidenceDraftPrError('InvalidObservation', 'observedAt must be an exact instant');
  }
  const bound = decided.pullRequest ?? pullRequest;
  const body = {
    schema: FIRST_EVIDENCE_VISIBILITY_SCHEMA,
    observedAt,
    state: decided.state,
    repository: observed.repository,
    task: observed.task,
    baseBranch: observed.baseBranch,
    headBranch: observed.headBranch,
    headBranchGeneration: observed.headBranchGeneration,
    run: observed.run,
    sourceRevision: observed.sourceRevision,
    operationIdentity: decided.operationIdentity,
    draftAgeMs: ageMs(observedAt, pullRequest?.openedAt ?? null),
    lastCommitAgeMs: ageMs(observedAt, observed.evidence?.committedAt ?? null),
    ciState: closedToken(pullRequest?.ciState, DRAFT_PR_CI_STATES),
    reviewGate: closedToken(pullRequest?.reviewGate, DRAFT_PR_REVIEW_GATES),
    obstruction: decided.refusal === null
      ? (decided.state === 'MISSING_DRAFT' ? 'MISSING_DRAFT' : null)
      : 'AMBIGUOUS_DRAFT',
    // Deliberately a constant. This block feeds no spinner and contradicts no lane; it says only
    // that repository visibility and process liveness are two different measurements.
    liveness: 'NOT_MEASURED_HERE',
    pullRequest: bound === null || bound === undefined
      ? null
      : { number: bound.number, url: bound.url },
    effect: 'NONE',
    authority: 'NONE',
  };
  return deepFreeze({ ...body, revision: sha256(body) });
}
