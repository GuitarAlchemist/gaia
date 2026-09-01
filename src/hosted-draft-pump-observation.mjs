/**
 * hosted-draft-pump-observation.mjs — one hosted Draft pump transition, sealed and re-derivable.
 *
 * Issue #70 names the defect this module exists to close: the Control Room "cannot distinguish a
 * healthy empty queue from a pump that was never triggered". A drain with no eligible work and a
 * pump that has not ticked in three days read identically today.
 *
 * The durable authority for what the pump did is the append-only Git Data ledger in GitHub. This
 * module never reaches for it, never reaches for anything, and performs nothing: it imports one
 * hashing primitive and is otherwise total and pure. A producer reads the ledger and seals what it
 * read; the read model verifies the seal and re-derives every published cell from the carried
 * evidence. The JSON a caller hands to an adapter is transport, and the content-addressed
 * `revision` is what makes it verifiable regardless of which file it arrived in.
 *
 * It is deliberately not placed in `src/hosted-draft-pump.mjs`: that module's entry points perform
 * durable effects, and a read model that publishes `effect: 'NONE'` must not carry an effectful
 * module in its import graph.
 */

import { createHash } from 'node:crypto';

export const HOSTED_DRAFT_PUMP_SCHEMA = 'gaia-hosted-draft-pump/1';
export const HOSTED_DRAFT_PUMP_SOURCE = 'GAIA_HOSTED_DRAFT_PUMP';

/**
 * Published pump state — closed, and derived rather than copied.
 *
 * `ADVANCED` and `REPLAYED` are separate because collapsing them would let a recovery tick that
 * performed no effect read as intake progress. `REPLAYED` is healthy, not neutral: the concurrency
 * contract requires a lost effect response to reconcile before retry, so a replay is the mechanism
 * working.
 */
export const HOSTED_DRAFT_PUMP_STATES = Object.freeze([
  'ADVANCED', 'REPLAYED', 'EXPECTED_NONE', 'BLOCKED', 'UNSETTLED', 'STALE',
]);

/** Typed blockers — closed. An unrecognised token fails closed rather than rendering as a state. */
export const HOSTED_DRAFT_PUMP_BLOCKERS = Object.freeze([
  'NONE', 'PROVIDER_UNAVAILABLE', 'PROVIDER_PROTOCOL_VIOLATION', 'NO_EFFECT_CAPACITY',
  'EFFECT_AMBIGUOUS', 'CROSS_GENERATION_INTENT',
]);

/**
 * Triggers — closed. The distinction is what an operator needs: a `SCHEDULED_RECOVERY` tick that
 * found `EXPECTED_NONE` is the healthiest possible reading, while a `MANUAL_DISPATCH`-only history
 * means the automation is not actually running.
 */
export const HOSTED_DRAFT_PUMP_TRIGGERS = Object.freeze([
  'READY_LABEL', 'SCHEDULED_RECOVERY', 'MANUAL_DISPATCH',
]);

/** The envelope's own outcome vocabulary, carried verbatim so the derivation stays checkable. */
export const HOSTED_DRAFT_PUMP_OUTCOMES = Object.freeze([
  'CREATED', 'REUSED', 'REFUSED', 'CANCELLED', 'PENDING', 'EXPECTED_NONE',
]);

export const HOSTED_DRAFT_PUMP_EFFECTS = Object.freeze(['CREATE_DRAFT', 'NONE', 'UNKNOWN']);

/**
 * The freshness window, fixed and exported rather than configurable.
 *
 * A configurable threshold would make `STALE` mean something different depending on the arguments
 * the artifact was produced with. This one answers "should the pump have ticked by now?", which is
 * a fact about the recovery schedule: it is twice the declared intake cron interval of six hours,
 * so one missed scheduled tick is tolerated and two are not.
 */
export const HOSTED_DRAFT_PUMP_FRESH_MS = 43_200_000;

export const HOSTED_DRAFT_PUMP_FIELDS = Object.freeze([
  'schema', 'effect', 'authority', 'observedAt', 'windowStartedAt', 'sequence',
  'repository', 'repositoryNodeId', 'ledgerRootOid', 'ledgerRootRevision',
  'transition', 'unsettledCount', 'revision',
]);

export const HOSTED_DRAFT_PUMP_TRANSITION_FIELDS = Object.freeze([
  'tickAt', 'trigger', 'outcome', 'effect', 'operationId', 'workKey', 'generationKey',
  'committedRevision', 'observedSourceRevision', 'workItem', 'pullRequest', 'blocker',
]);

const WORK_ITEM_FIELDS = Object.freeze(['kind', 'number']);
const PULL_REQUEST_FIELDS = Object.freeze(['number', 'isDraft', 'state']);
const PULL_REQUEST_STATES = Object.freeze(['OPEN', 'CLOSED', 'MERGED']);

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const EXACT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class HostedDraftPumpObservationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'HostedDraftPumpObservationError';
    this.code = code;
  }
}

/** Malformed shape, unknown token, or a digest that does not match its content. */
function invalid(detail) {
  throw new HostedDraftPumpObservationError('InvalidHostedDraftPump', detail);
}

/**
 * Evidence that cannot be true at once: dated after the instant it was read, or behind a reading
 * this consumer already accepted. Refused rather than clamped, because a duration formatter floors
 * a negative age at zero and `0s ago` is the single most reassuring reading available.
 */
function incoherent(detail) {
  throw new HostedDraftPumpObservationError('IncoherentHostedDraftPump', detail);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Field-set totality, asserted before any value is read.
 *
 * An unknown key is refused by name rather than projected away, because silently dropping a field
 * would let a producer believe something it wrote was being honoured.
 */
function exactFields(value, fields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  for (const key of actual) {
    if (!expected.includes(key)) invalid(`${label} carries an unknown field: ${key}`);
  }
  for (const key of expected) {
    if (!actual.includes(key)) invalid(`${label} is missing a required field: ${key}`);
  }
  return value;
}

function instant(value, label) {
  if (typeof value !== 'string' || !EXACT_INSTANT.test(value)
    || new Date(value).toISOString() !== value) {
    invalid(`${label} must be an exact instant`);
  }
  return value;
}

function sha256Text(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(`${label} must be a sha-256 digest`);
  return value;
}

function nullableSha256(value, label) {
  return value === null ? null : sha256Text(value, label);
}

function token(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    invalid(`${label} is not a recognised token: ${String(value)}`);
  }
  return value;
}

function wholeNumber(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a whole number`);
  return value;
}

export function hostedDraftPumpRevision(body) {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function requireWorkItem(value) {
  if (value === null) return null;
  exactFields(value, WORK_ITEM_FIELDS, 'workItem');
  if (value.kind !== 'ISSUE') invalid('workItem.kind must be ISSUE');
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    invalid('workItem.number must be a positive integer');
  }
  return { kind: 'ISSUE', number: value.number };
}

function requirePullRequest(value) {
  if (value === null) return null;
  exactFields(value, PULL_REQUEST_FIELDS, 'pullRequest');
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    invalid('pullRequest.number must be a positive integer');
  }
  if (typeof value.isDraft !== 'boolean') invalid('pullRequest.isDraft must be a boolean');
  token(value.state, PULL_REQUEST_STATES, 'pullRequest.state');
  return { number: value.number, isDraft: value.isDraft, state: value.state };
}

function requireTransition(value) {
  exactFields(value, HOSTED_DRAFT_PUMP_TRANSITION_FIELDS, 'transition');
  const transition = {
    tickAt: instant(value.tickAt, 'transition.tickAt'),
    trigger: token(value.trigger, HOSTED_DRAFT_PUMP_TRIGGERS, 'transition.trigger'),
    outcome: token(value.outcome, HOSTED_DRAFT_PUMP_OUTCOMES, 'transition.outcome'),
    effect: token(value.effect, HOSTED_DRAFT_PUMP_EFFECTS, 'transition.effect'),
    operationId: nullableSha256(value.operationId, 'transition.operationId'),
    workKey: nullableSha256(value.workKey, 'transition.workKey'),
    generationKey: nullableSha256(value.generationKey, 'transition.generationKey'),
    committedRevision: nullableSha256(value.committedRevision, 'transition.committedRevision'),
    observedSourceRevision: sha256Text(
      value.observedSourceRevision, 'transition.observedSourceRevision',
    ),
    workItem: requireWorkItem(value.workItem),
    pullRequest: requirePullRequest(value.pullRequest),
    blocker: token(value.blocker, HOSTED_DRAFT_PUMP_BLOCKERS, 'transition.blocker'),
  };
  // A pull request is a fact about an operation. Publishing one without the operation it belongs
  // to would put an unbound number on the page.
  if (transition.pullRequest !== null && transition.operationId === null) {
    invalid('transition.pullRequest is present without an operation identity');
  }
  if (transition.outcome === 'EXPECTED_NONE' && transition.operationId !== null) {
    invalid('an EXPECTED_NONE tick admitted no work and carries no operation identity');
  }
  return transition;
}

function requireBody(value) {
  exactFields(value, HOSTED_DRAFT_PUMP_FIELDS, 'the hosted Draft pump observation');
  if (value.schema !== HOSTED_DRAFT_PUMP_SCHEMA) invalid('schema must be the hosted pump schema');
  if (value.effect !== 'NONE') invalid('effect must be NONE');
  if (value.authority !== 'NONE') invalid('authority must be NONE');
  if (typeof value.repository !== 'string' || !REPOSITORY.test(value.repository)) {
    invalid('repository must be owner/name');
  }
  if (typeof value.repositoryNodeId !== 'string' || value.repositoryNodeId.length === 0) {
    invalid('repositoryNodeId must be a node identifier');
  }
  if (typeof value.ledgerRootOid !== 'string' || !GIT_OID.test(value.ledgerRootOid)) {
    invalid('ledgerRootOid must be a Git object identifier');
  }
  return {
    schema: HOSTED_DRAFT_PUMP_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    observedAt: instant(value.observedAt, 'observedAt'),
    windowStartedAt: instant(value.windowStartedAt, 'windowStartedAt'),
    sequence: wholeNumber(value.sequence, 'sequence'),
    repository: value.repository,
    repositoryNodeId: value.repositoryNodeId,
    ledgerRootOid: value.ledgerRootOid,
    ledgerRootRevision: sha256Text(value.ledgerRootRevision, 'ledgerRootRevision'),
    transition: requireTransition(value.transition),
    unsettledCount: wholeNumber(value.unsettledCount, 'unsettledCount'),
  };
}

/** The two instants that cannot disagree: a tick cannot be later than the read that observed it. */
function requireCoherence(body) {
  if (Date.parse(body.windowStartedAt) > Date.parse(body.observedAt)) {
    incoherent('the observation window starts after the instant it was read');
  }
  if (Date.parse(body.transition.tickAt) > Date.parse(body.observedAt)) {
    incoherent('the pump transition is dated after the instant it was read');
  }
  return body;
}

/**
 * Monotonicity against the previously published reading.
 *
 * The carrier is the published artifact and nothing else, so no private state store is introduced
 * and an operator can read the value a refusal was measured against. A producer republishing an
 * older reading as current is indistinguishable from a fresh one, and here that is worse than for
 * a pipeline: a stale replay of an old ADVANCED would say intake is moving while the pump is dead.
 */
function requireMonotonic(body, priorObservation) {
  if (priorObservation === null || priorObservation === undefined) return body;
  const prior = priorObservation;
  if (typeof prior.observedAt === 'string'
    && Date.parse(prior.observedAt) > Date.parse(body.observedAt)) {
    incoherent('the hosted pump observation is older than the one already published');
  }
  if (Number.isSafeInteger(prior.sequence) && prior.sequence > body.sequence) {
    incoherent('the hosted pump observation sequence went backwards');
  }
  // The ledger is compare-and-swap append-only, so a work key already reported at a higher
  // committed revision cannot legitimately be re-reported at a lower one: that is a producer
  // reading a stale ref, and a stale loser performs no effect.
  if (typeof prior.workKey === 'string' && prior.workKey === body.transition.workKey
    && typeof prior.committedRevision === 'string'
    && typeof body.transition.committedRevision === 'string'
    && body.transition.committedRevision < prior.committedRevision) {
    incoherent('the hosted pump committed revision went backwards for one work key');
  }
  return body;
}

export function sealHostedDraftPumpObservation(observation) {
  const body = requireCoherence(requireBody({
    schema: HOSTED_DRAFT_PUMP_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    revision: '',
    ...observation,
  }));
  return deepFreeze({ ...body, revision: hostedDraftPumpRevision(body) });
}

export function requireHostedDraftPumpObservation(value, { priorObservation = null } = {}) {
  const body = requireBody(value);
  if (hostedDraftPumpRevision(body) !== value.revision) {
    invalid('the hosted pump observation revision does not match its content');
  }
  requireCoherence(body);
  requireMonotonic(body, priorObservation);
  return deepFreeze({ ...body, revision: value.revision });
}

/**
 * The published state, derived from the transition rather than copied from it.
 *
 * `STALE` displaces every other reading. A stale observation may not publish a present-tense pump
 * state, because the transition it describes may have been superseded by one this reader never
 * saw — and an old ADVANCED read as current is exactly the defect this block exists to close.
 */
function deriveState({ transition, unsettledCount, observationAgeMs }) {
  if (observationAgeMs > HOSTED_DRAFT_PUMP_FRESH_MS) return 'STALE';
  if (transition.blocker !== 'NONE' || transition.outcome === 'REFUSED') return 'BLOCKED';
  if (transition.outcome === 'PENDING' || unsettledCount > 0) return 'UNSETTLED';
  if (transition.outcome === 'EXPECTED_NONE') return 'EXPECTED_NONE';
  if (transition.outcome === 'CREATED' && transition.effect === 'CREATE_DRAFT') return 'ADVANCED';
  return 'REPLAYED';
}

const SEVERITY = Object.freeze({
  ADVANCED: 'healthy',
  REPLAYED: 'healthy',
  EXPECTED_NONE: 'healthy',
  BLOCKED: 'blocked',
  UNSETTLED: 'warning',
  STALE: 'warning',
});

// Without this, a state added to the vocabulary and forgotten here renders the literal string
// `undefined` as a severity, and colour would be the only thing carrying the reading.
for (const state of HOSTED_DRAFT_PUMP_STATES) {
  if (!Object.hasOwn(SEVERITY, state)) {
    throw new HostedDraftPumpObservationError(
      'InvalidHostedDraftPump', `no severity is declared for ${state}`,
    );
  }
}

/**
 * Derive the published block.
 *
 * Reads only the fields it publishes, so the verify seam can re-derive the block from the block
 * itself: a digest taken over evidence the verifier cannot see is not verifiable.
 */
export function deriveHostedDraftPumpBlock({ artifact, observedAt }) {
  const at = instant(observedAt, 'observedAt');
  const transition = requireTransition(artifact?.transition);
  const readAt = instant(artifact?.observedAt, 'artifact.observedAt');
  const atMs = Date.parse(at);
  if (Date.parse(readAt) > atMs) {
    incoherent('the hosted pump observation is dated after the instant the page was built');
  }
  const unsettledCount = wholeNumber(artifact?.unsettledCount, 'unsettledCount');
  const observationAgeMs = atMs - Date.parse(readAt);
  const transitionAgeMs = atMs - Date.parse(transition.tickAt);
  const state = deriveState({ transition, unsettledCount, observationAgeMs });
  return deepFreeze({
    source: HOSTED_DRAFT_PUMP_SOURCE,
    state,
    severity: SEVERITY[state],
    // Published, not merely absent: this block claims no portfolio binding and no readiness, and
    // says so in a named cell rather than by omission.
    binding: 'NONE',
    readiness: 'NOT_CLAIMED',
    observedAt: readAt,
    windowStartedAt: instant(artifact?.windowStartedAt, 'artifact.windowStartedAt'),
    sequence: wholeNumber(artifact?.sequence, 'sequence'),
    artifactRevision: sha256Text(artifact?.revision, 'artifact.revision'),
    repository: artifact?.repository,
    ledgerRootRevision: sha256Text(artifact?.ledgerRootRevision, 'ledgerRootRevision'),
    // Two separate facts on purpose: a reading taken two seconds ago about a transition from three
    // days ago must not be able to read as recent.
    observationAgeMs,
    transitionAgeMs,
    freshnessWindowMs: HOSTED_DRAFT_PUMP_FRESH_MS,
    operationId: transition.operationId,
    workKey: transition.workKey,
    committedRevision: transition.committedRevision,
    workItem: transition.workItem,
    pullRequest: transition.pullRequest,
    // The association is a named state, never an inference.
    pullRequestBinding: transition.pullRequest === null ? 'PR_NOT_PROVEN' : 'PROVEN',
    blocker: transition.blocker,
    trigger: transition.trigger,
    unsettledCount,
    transition,
  });
}

/** Re-derive a published block from its own carried evidence, so resealing cannot forge a state. */
export function requireHostedDraftPumpBlock({ block, observedAt }) {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    invalid('the hosted pump block must be an object');
  }
  const expected = deriveHostedDraftPumpBlock({
    artifact: {
      observedAt: block.observedAt,
      windowStartedAt: block.windowStartedAt,
      sequence: block.sequence,
      repository: block.repository,
      ledgerRootRevision: block.ledgerRootRevision,
      revision: block.artifactRevision,
      transition: block.transition,
      unsettledCount: block.unsettledCount,
    },
    observedAt,
  });
  if (canonicalJson(expected) !== canonicalJson(block)) {
    invalid('the hosted pump block is not what its own evidence derives');
  }
  return block;
}

export function summarizeHostedDraftPump({ artifact, observedAt, priorObservation = null }) {
  const verified = requireHostedDraftPumpObservation(artifact, { priorObservation });
  return deriveHostedDraftPumpBlock({ artifact: verified, observedAt });
}
