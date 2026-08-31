/**
 * merge-queue-capability.mjs — `gaia-merge-queue-capability/1`, the closed contract for one
 * observation of whether a repository's default branch actually has a merge queue, and the one
 * decision from it to a closed state.
 *
 * WHY THIS EXISTS
 * ---------------
 * Gaia waited for a pull request to enter a merge queue that did not exist. The repository had
 * zero rulesets and an unprotected default branch; the pull request was clean, green, and carried
 * no auto-merge request. Gaia held only the third fact and read it as "the queue has not picked it
 * up yet". An absent capability was reported as slow progress, and waiting is free, so nothing
 * stopped.
 *
 * WHAT CANNOT ENTER, AND WHY THAT IS A CONSTRUCTION RATHER THAN A PROMISE
 * ----------------------------------------------------------------------
 * This schema has no field for a pull request's mergeability, its merge-state status, its
 * auto-merge request, its check conclusion or its review decision, and an unknown field is
 * refused. Those describe an item *under* a configuration; this describes the configuration. The
 * inference that caused the incident is therefore not discouraged here, it is unsayable — a
 * producer has nowhere to put it, and one gate greps this file to prove the names appear nowhere
 * in it, because naming a field is the first step to reading it.
 *
 * THE FOUR RULES THAT DECIDE EVERY ANSWER
 * ---------------------------------------
 * 1. **A read that did not succeed can never conclude absence.** GitHub answers 403 for a missing
 *    permission, 403 for a rate limit, 403 for an unsatisfied single-sign-on session, and 404 for
 *    a resource the caller may not see. Each maps to its own state before any content is read.
 *    `ABSENT` requires a complete, successful listing that found nothing.
 * 2. **Absence of understanding is not evidence of absence.** A rule type this version does not
 *    model may be the one that governs merging, so it decides `UNKNOWN`.
 * 3. **Freshness is the reader's verdict, not the producer's.** The artifact records what was seen
 *    and when. Whether that is still usable depends on when it is read, which the producer cannot
 *    know, so every state decays to `STALE` — including `ABSENT`.
 * 4. **Remediation refuses by default.** Only `ABSENT` is remediable, only additively, only after
 *    a compare-and-swap, and only ever once. This module performs no effect of its own: the
 *    executor is handed a function and calls it at most one time.
 *
 * It reads nothing, opens nothing and holds no clock. It imports `node:crypto` and the one shared
 * exact-instant predicate; re-spelling that rule here would give this product two definitions of
 * what a valid instant is, which is the defect rather than the fix.
 *
 * The design decision, its rejected alternatives, its falsifiers and its rejection criterion are
 * in `docs/merge-queue-capability.md`.
 */

import { createHash } from 'node:crypto';

import { isExactInstant } from './local-lane-observation.mjs';

export const MERGE_QUEUE_CAPABILITY_SCHEMA = 'gaia-merge-queue-capability/1';

/** The one source this schema describes. A constant, not a caller-chosen string. */
export const MERGE_QUEUE_CAPABILITY_SOURCE = 'GAIA_MERGE_QUEUE_CAPABILITY';

/** The closed vocabulary. No other value is ever reported. */
export const MERGE_QUEUE_CAPABILITY_STATES = Object.freeze([
  'AVAILABLE',
  'ABSENT',
  'MISCONFIGURED',
  'PERMISSION_DENIED',
  'STALE',
  'UNKNOWN',
]);

/**
 * How old a capability reading may be before it stops being readable as a fact about now.
 *
 * Its own constant, deliberately. The heartbeat window answers "did the run prove it is alive?",
 * the lane window answers "did the sensor run?", and the flow window answers "how old is this
 * measurement?". This one answers "could an administrator have changed this since we looked?",
 * and five minutes is deliberately shorter than any wait it authorises.
 */
export const MERGE_QUEUE_CAPABILITY_FRESH_MS = 300_000;

export const MERGE_QUEUE_CAPABILITY_FIELDS = Object.freeze([
  'authority', 'defaultBranch', 'effect', 'observation', 'observedAt', 'repository',
  'repositoryId', 'revision', 'schema',
]);

export const MERGE_QUEUE_OBSERVATION_FIELDS = Object.freeze([
  'adminPermission', 'protectionRead', 'rulesetDigest', 'rulesets', 'rulesetsComplete',
  'rulesetsRead', 'unknownRuleTypes',
]);

export const MERGE_QUEUE_RULESET_FIELDS = Object.freeze([
  'enforcement', 'mergeQueueRule', 'name', 'rulesetId', 'targetsDefaultBranch',
]);

/** What a read of GitHub came back as. `OK` is the only one that can conclude anything positive. */
export const MERGE_QUEUE_READ_OUTCOMES = Object.freeze([
  'OK', 'FORBIDDEN', 'RATE_LIMITED', 'NOT_FOUND', 'FAILED',
]);

/** GitHub's own three enforcement levels. Only `active` gates anything. */
export const MERGE_QUEUE_ENFORCEMENTS = Object.freeze(['active', 'evaluate', 'disabled']);

/** Evidence about writing. It gates remediation and never the capability verdict. */
export const MERGE_QUEUE_ADMIN_PERMISSIONS = Object.freeze(['PRESENT', 'ABSENT', 'UNKNOWN']);

export const MERGE_QUEUE_REMEDIATION_INTENT_SCHEMA = 'gaia-merge-queue-remediation-intent/1';

/** The closed field list of one intent. An unknown field is refused, never ignored. */
export const MERGE_QUEUE_REMEDIATION_INTENT_FIELDS = Object.freeze([
  'additions', 'defaultBranch', 'desiredRuleDigest', 'expectedRulesetDigest', 'intentId',
  'observedAt', 'preserved', 'repository', 'repositoryId', 'revision', 'schema', 'stamp',
]);
export const MERGE_QUEUE_REMEDIATION_REFUSAL_SCHEMA = 'gaia-merge-queue-remediation-refusal/1';
export const MERGE_QUEUE_REMEDIATION_RECEIPT_SCHEMA = 'gaia-merge-queue-remediation-receipt/1';

/**
 * The four terminal readings of a reconciliation. `NOT_APPLIED` is a verdict, not a retry policy:
 * it permits the one effect the intent was created for and schedules nothing.
 */
export const MERGE_QUEUE_REMEDIATION_VERDICTS = Object.freeze([
  'APPLIED', 'SUPERSEDED', 'NOT_APPLIED', 'AMBIGUOUS',
]);

/**
 * Why there is no separate ambiguity refusal: a repository with two competing active merge queue
 * carriers decides `MISCONFIGURED`, and `MISCONFIGURED` is already not remediable. A second name
 * for the same refusal would be unreachable, and an unreachable refusal is a claim no test can
 * hold.
 */
export const MERGE_QUEUE_REMEDIATION_REFUSALS = Object.freeze([
  'CAPABILITY_NOT_REMEDIABLE', 'DESTRUCTIVE_REPLACEMENT', 'INSUFFICIENT_AUTHORITY',
  'PRECONDITION_CHANGED', 'UNKNOWN_RULE_PRESENT',
]);

/**
 * The one rule this module is prepared to add, as a constant rather than a parameter.
 *
 * A caller-chosen merge method or grouping strategy would make "the merge queue Gaia asks for"
 * mean something different depending on the arguments it was called with, and would fork the
 * effect identity below along with it.
 */
export const DESIRED_MERGE_QUEUE_RULE = Object.freeze({ type: 'merge_queue' });

/** A bounded identity. Anything a producer cannot fit in this shape is recorded as absent. */
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const RULE_TYPE = /^[a-z][a-z0-9_]{0,63}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

const MAX_RULESETS = 64;
const MAX_UNKNOWN_RULE_TYPES = 64;

/** Ordinal comparison. Not `localeCompare`, which is host- and ICU-version-dependent. */
const ordinal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export class MergeQueueCapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MergeQueueCapabilityError';
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
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** The projection every digest is taken over, so the recipe cannot drift between call sites. */
const projectRuleset = (entry) => ({
  rulesetId: entry.rulesetId,
  name: entry.name ?? null,
  enforcement: entry.enforcement,
  targetsDefaultBranch: entry.targetsDefaultBranch,
  mergeQueueRule: entry.mergeQueueRule === null ? null : { enabled: entry.mergeQueueRule.enabled },
});

/**
 * The compare-and-swap token: the digest of exactly the rulesets that were read.
 *
 * Exported as one recipe because the seal, the verifier and the executor's precondition check all
 * take it, and a second implementation is how two of them come to disagree about whether the
 * configuration moved. It is deliberately not GitHub's `updated_at`, which is second-granularity
 * and does not move for every semantically relevant edit.
 */
export function mergeQueueRulesetDigest(rulesets = []) {
  return sha256(canonicalJson(rulesets.map(projectRuleset)));
}

const projectObservation = (observation) => ({
  rulesetsRead: observation.rulesetsRead,
  rulesetsComplete: observation.rulesetsComplete,
  protectionRead: observation.protectionRead,
  rulesets: observation.rulesets.map(projectRuleset),
  rulesetDigest: observation.rulesetDigest,
  adminPermission: observation.adminPermission,
  unknownRuleTypes: [...observation.unknownRuleTypes],
});

/**
 * The one digest recipe, exported because the seal, the verifier and the control room's render
 * seam all need it.
 */
export function mergeQueueCapabilityRevision({
  observedAt, repositoryId, repository, defaultBranch, observation,
} = {}) {
  return sha256(canonicalJson({
    schema: MERGE_QUEUE_CAPABILITY_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    observedAt,
    repositoryId,
    repository,
    defaultBranch,
    observation: projectObservation(observation),
  }));
}

/** Seal one observation into a content-addressed artifact. */
export function sealMergeQueueCapability({
  observedAt, repositoryId, repository, defaultBranch, observation,
}) {
  const body = {
    schema: MERGE_QUEUE_CAPABILITY_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    observedAt,
    repositoryId,
    repository,
    defaultBranch,
    observation: projectObservation(observation),
  };
  return requireMergeQueueCapabilityArtifact(deepFreeze({
    ...body,
    revision: mergeQueueCapabilityRevision(body),
  }));
}

/**
 * Total verification of one published `gaia-merge-queue-capability/1` value.
 *
 * Every refusal is a refusal to *use the evidence*, never a repair. Nothing is clamped, defaulted
 * or dropped: an unknown field is not ignored, a wrong digest is not recomputed, and a read
 * outcome outside the closed set is not bucketed as "other". Each of those repairs would turn
 * incoherent evidence into a confident reading, which is the failure this module exists to stop.
 */
export function requireMergeQueueCapabilityArtifact(value) {
  const refuse = (message) => {
    throw new MergeQueueCapabilityError('InvalidMergeQueueCapability', message);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('a Gaia merge queue capability artifact object is required');
  }
  for (const field of Object.keys(value)) {
    if (!MERGE_QUEUE_CAPABILITY_FIELDS.includes(field)) {
      refuse(`the artifact carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  for (const field of MERGE_QUEUE_CAPABILITY_FIELDS) {
    if (!Object.hasOwn(value, field)) refuse(`the artifact is missing ${field}`);
  }
  if (value.schema !== MERGE_QUEUE_CAPABILITY_SCHEMA || value.effect !== 'NONE'
      || value.authority !== 'NONE') {
    refuse('an authority-free Gaia merge queue capability artifact is required');
  }
  if (!isExactInstant(value.observedAt)) {
    refuse('the observation instant must be an exact ISO timestamp');
  }
  if (typeof value.repositoryId !== 'string' || !IDENTITY.test(value.repositoryId)) {
    refuse('the repository identity must be a bounded identity, not a name');
  }
  if (typeof value.repository !== 'string' || !REPOSITORY_NAME.test(value.repository)) {
    refuse('the repository must be owner/name');
  }
  if (typeof value.defaultBranch !== 'string' || !BRANCH.test(value.defaultBranch)) {
    refuse('the default branch must be a bounded branch name');
  }
  requireObservation(value.observation, refuse);
  const { revision, ...body } = value;
  if (typeof revision !== 'string' || revision !== mergeQueueCapabilityRevision(body)) {
    refuse('the artifact revision does not match its content');
  }
  return value;
}

function requireObservation(observation, refuse) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    refuse('the artifact must carry one observation');
  }
  for (const field of Object.keys(observation)) {
    if (!MERGE_QUEUE_OBSERVATION_FIELDS.includes(field)) {
      refuse(`the observation carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  for (const field of MERGE_QUEUE_OBSERVATION_FIELDS) {
    if (!Object.hasOwn(observation, field)) refuse(`the observation is missing ${field}`);
  }
  for (const field of ['rulesetsRead', 'protectionRead']) {
    if (!MERGE_QUEUE_READ_OUTCOMES.includes(observation[field])) {
      refuse(`${field} must be one of the closed read outcomes`);
    }
  }
  if (typeof observation.rulesetsComplete !== 'boolean') {
    refuse('rulesetsComplete must be a boolean: a listing is exhausted or it is not');
  }
  if (!MERGE_QUEUE_ADMIN_PERMISSIONS.includes(observation.adminPermission)) {
    refuse('adminPermission must be one of the closed permission readings');
  }
  if (!Array.isArray(observation.rulesets) || observation.rulesets.length > MAX_RULESETS) {
    refuse(`the observation must carry at most ${MAX_RULESETS} rulesets`);
  }
  if (observation.rulesetsRead !== 'OK' && observation.rulesets.length > 0) {
    refuse('a read that did not succeed cannot carry rulesets');
  }
  for (const entry of observation.rulesets) requireRulesetEntry(entry, refuse);
  requireUnknownRuleTypes(observation.unknownRuleTypes, refuse);

  if (observation.rulesetsRead === 'OK') {
    if (observation.rulesetDigest !== mergeQueueRulesetDigest(observation.rulesets)) {
      refuse('the ruleset digest is not the digest of the rulesets it names');
    }
  } else if (observation.rulesetDigest !== null) {
    refuse('a read that did not succeed carries no ruleset digest');
  }
}

function requireRulesetEntry(entry, refuse) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    refuse('every ruleset must be a plain object');
  }
  for (const field of Object.keys(entry)) {
    if (!MERGE_QUEUE_RULESET_FIELDS.includes(field)) {
      refuse(`a ruleset carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  for (const field of MERGE_QUEUE_RULESET_FIELDS) {
    if (!Object.hasOwn(entry, field)) refuse(`a ruleset is missing ${field}`);
  }
  if (typeof entry.rulesetId !== 'string' || !IDENTITY.test(entry.rulesetId)) {
    refuse('a ruleset identity must be a bounded identity');
  }
  // A name is caller-authored free text on GitHub. One this schema cannot bound is recorded as
  // absent rather than carried, so no operator prose, URL or credential-shaped string can reach
  // the sealed evidence through it.
  if (entry.name !== null && (typeof entry.name !== 'string' || !IDENTITY.test(entry.name))) {
    refuse('a ruleset name must be a bounded identity or absent');
  }
  if (!MERGE_QUEUE_ENFORCEMENTS.includes(entry.enforcement)) {
    refuse('a ruleset enforcement must be active, evaluate or disabled');
  }
  if (typeof entry.targetsDefaultBranch !== 'boolean') {
    refuse('targetsDefaultBranch must be a resolved boolean');
  }
  if (entry.mergeQueueRule !== null
      && (typeof entry.mergeQueueRule !== 'object' || Array.isArray(entry.mergeQueueRule)
        || Object.keys(entry.mergeQueueRule).length !== 1
        || entry.mergeQueueRule.enabled !== true)) {
    refuse('a merge queue rule is either absent or the enabled record');
  }
}

function requireUnknownRuleTypes(value, refuse) {
  if (!Array.isArray(value) || value.length > MAX_UNKNOWN_RULE_TYPES) {
    refuse(`unknownRuleTypes must be at most ${MAX_UNKNOWN_RULE_TYPES} entries`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !RULE_TYPE.test(entry)) {
      refuse('every unknown rule type must be a bounded rule type name');
    }
  }
  for (let index = 1; index < value.length; index += 1) {
    if (ordinal(value[index - 1], value[index]) >= 0) {
      refuse('unknown rule types must be sorted and deduplicated');
    }
  }
}

/**
 * Resolve whether a ruleset's ref-name condition governs the named default branch.
 *
 * Both halves matter. Matching only the literal misses a `~DEFAULT_BRANCH` ruleset that really
 * does govern the branch and reports a false absence; ignoring `exclude` accepts a ruleset that
 * includes `~ALL` and then subtracts the branch, reporting a false availability — which is the
 * failure this whole module exists to prevent, arriving through the back door.
 *
 * A pattern that is neither a magic ref nor the literal ref is `'UNKNOWN'`, never a guess.
 */
export function resolveTargetsDefaultBranch({ include = [], exclude = [], defaultBranch }) {
  const literal = `refs/heads/${defaultBranch}`;
  const classify = (patterns) => {
    let matched = false;
    for (const pattern of patterns) {
      const magic = pattern === '~ALL' || pattern === '~DEFAULT_BRANCH';
      if (magic || pattern === literal) matched = true;
      else if (pattern !== '~ALL' && !isPlainRef(pattern)) return 'UNKNOWN';
    }
    return matched;
  };
  const included = classify(include);
  if (included === 'UNKNOWN') return 'UNKNOWN';
  const excluded = classify(exclude);
  if (excluded === 'UNKNOWN') return 'UNKNOWN';
  return included && !excluded;
}

/** A concrete ref this module can compare exactly. A glob is not one. */
const isPlainRef = (pattern) => typeof pattern === 'string'
  && pattern.startsWith('refs/') && !/[*?[\]]/u.test(pattern);

/**
 * The one decision, from one verified artifact and one instant to one closed state.
 *
 * Evaluated in a fixed order, first rule wins. The order is the point: a read that did not succeed
 * is classified before any content is interpreted, so a permission failure can never degrade into
 * `ABSENT` and trigger a remediation that could only ever fail.
 */
export function decideMergeQueueCapability({ artifact, observedAt }) {
  const verified = requireMergeQueueCapabilityArtifact(artifact);
  if (!isExactInstant(observedAt)) {
    throw new MergeQueueCapabilityError(
      'InvalidMergeQueueCapability', 'the reading instant must be an exact ISO timestamp',
    );
  }
  const ageMs = Date.parse(observedAt) - Date.parse(verified.observedAt);
  if (ageMs < 0) {
    // Refused, never clamped. Clamping incoherent time into "age 0" publishes a reassuring
    // freshness nobody measured, which is the same class of error as a fabricated count.
    throw new MergeQueueCapabilityError(
      'InvalidMergeQueueCapability', 'the artifact was observed after the instant it was read at',
    );
  }
  if (ageMs > MERGE_QUEUE_CAPABILITY_FRESH_MS) return 'STALE';
  return decideObservedState(verified.observation);
}

function decideObservedState(observation) {
  const { rulesetsRead, protectionRead } = observation;
  if (rulesetsRead === 'FORBIDDEN' || protectionRead === 'FORBIDDEN') return 'PERMISSION_DENIED';
  if (['RATE_LIMITED', 'FAILED'].includes(rulesetsRead)
      || ['RATE_LIMITED', 'FAILED'].includes(protectionRead)) {
    return 'UNKNOWN';
  }
  // A 404 on the rulesets *collection* means the repository was not found, not that it holds no
  // rulesets. `ABSENT` requires a successful read that returned nothing relevant.
  if (rulesetsRead !== 'OK' || !observation.rulesetsComplete
      || observation.unknownRuleTypes.length > 0) {
    return 'UNKNOWN';
  }
  const carriers = observation.rulesets.filter(({ mergeQueueRule }) => mergeQueueRule?.enabled);
  if (carriers.length === 0) return 'ABSENT';
  const serving = carriers.filter(
    ({ enforcement, targetsDefaultBranch }) => enforcement === 'active' && targetsDefaultBranch,
  );
  return serving.length === 1 ? 'AVAILABLE' : 'MISCONFIGURED';
}

/**
 * The one derivation the control-room builder and its render-seam verifier both call.
 *
 * It carries the verified observation verbatim so the seam can re-derive the whole block from the
 * evidence it publishes, rather than trusting a state that was sealed beside it.
 */
export function deriveMergeQueueCapabilityBlock({ artifact, observedAt }) {
  const verified = requireMergeQueueCapabilityArtifact(artifact);
  const state = decideMergeQueueCapability({ artifact: verified, observedAt });
  return deepFreeze({
    source: MERGE_QUEUE_CAPABILITY_SOURCE,
    state,
    binding: 'NONE',
    repositoryId: verified.repositoryId,
    repository: verified.repository,
    defaultBranch: verified.defaultBranch,
    observedAt: verified.observedAt,
    observationAgeMs: Date.parse(observedAt) - Date.parse(verified.observedAt),
    freshnessWindowMs: MERGE_QUEUE_CAPABILITY_FRESH_MS,
    artifactRevision: verified.revision,
    observation: projectObservation(verified.observation),
  });
}

// -----------------------------------------------------------------------------------------------
// The probe — the one read-only producer.
// -----------------------------------------------------------------------------------------------

/**
 * Read one repository's merge queue capability and seal it.
 *
 * Takes its own `read(path)` returning `{ status, body, complete, rateLimited }` rather than the
 * portfolio survey's `runGh`. That is not a preference: `runGh` returns `null` for empty output and
 * the raw string for a non-JSON body, and rejects with an error whose `stderr` — the only place the
 * HTTP status appears — is never read. Its return value cannot distinguish 403 from 404 from an
 * empty 200, and that distinction is the entire decision this module makes.
 */
export async function probeMergeQueueCapability({
  repository, repositoryId, defaultBranch, read, observedAt,
}) {
  const rulesets = await readOutcome(read, `repos/${repository}/rulesets`);
  const protection = await readOutcome(
    read, `repos/${repository}/branches/${defaultBranch}/protection`,
  );
  // The listing is an index, not the configuration. Each listed ruleset's own record is read
  // before anything is parsed, because the rules and the ref conditions exist only there.
  const detailed = rulesets.outcome === 'OK'
    ? await readRulesetDetails(read, repository, rulesets.answer.body)
    : { outcome: rulesets.outcome, entries: [], unreadable: false };
  const parsed = detailed.outcome === 'OK'
    ? parseRulesets(detailed.entries, defaultBranch, detailed.unreadable)
    : { rulesets: [], unknownRuleTypes: [] };

  const observation = {
    rulesetsRead: detailed.outcome,
    // A listing that was exhausted but whose details were not read is not a complete observation
    // of the configuration, and `ABSENT` is the one answer completeness is load-bearing for.
    rulesetsComplete: detailed.outcome === 'OK' ? rulesets.answer.complete === true : false,
    protectionRead: protection.outcome,
    rulesets: parsed.rulesets,
    rulesetDigest: detailed.outcome === 'OK' ? mergeQueueRulesetDigest(parsed.rulesets) : null,
    adminPermission: 'UNKNOWN',
    unknownRuleTypes: parsed.unknownRuleTypes,
  };
  return sealMergeQueueCapability({
    observedAt, repositoryId, repository, defaultBranch, observation,
  });
}

/**
 * Map one transport answer onto a closed outcome.
 *
 * A rate-limit or single-sign-on 403 is separated from a permission 403 on purpose: telling an
 * operator to widen a token's scope because a rate limit was hit is a false next action, and
 * reading either as absence is the original defect.
 */
async function readOutcome(read, path) {
  let answer;
  try {
    answer = await read(path);
  } catch {
    // The provider diagnostic is discarded rather than carried. A `gh` failure message routinely
    // contains the full request URL, which routinely contains a credential.
    return { outcome: 'FAILED', answer: null };
  }
  const status = answer?.status;
  if (status === 200) return { outcome: 'OK', answer };
  if (status === 403) return { outcome: answer.rateLimited ? 'RATE_LIMITED' : 'FORBIDDEN', answer };
  if (status === 404) return { outcome: 'NOT_FOUND', answer };
  return { outcome: 'FAILED', answer };
}

/**
 * Read every listed repository ruleset's own record, because the listing does not carry the rules.
 *
 * `GET /repos/{owner}/{repo}/rulesets` returns each ruleset's `id`, `name`, `target`, `source`,
 * `source_type` and `enforcement`. It returns no `rules` array and no `conditions` object at all.
 * Parsing that response for a `merge_queue` rule therefore finds none in *every* repository —
 * including one whose merge queue is active and governs the default branch — and rule 5 then seals
 * `ABSENT` for a configuration nobody looked at. That is the same false absence this module exists
 * to refuse, arriving through the shape of the response rather than through its status.
 *
 * `GET /repos/{owner}/{repo}/rulesets/{ruleset_id}` is the only endpoint that carries them, so one
 * detail read is issued per listed repository ruleset, in listing order. Every way that read can
 * fall short is failed closed and can never reach `ABSENT`: a transport failure, a 403, a 404 or a
 * 500 degrades `rulesetsRead` and is decided by rules 1-3, and a body that is not this ruleset,
 * carries no `rules` array or carries no resolvable ref condition is recorded as
 * `unreadable_ruleset_detail` and decided by rule 3.
 */
async function readRulesetDetails(read, repository, body) {
  const listed = Array.isArray(body) ? body : [];
  // Bounded before the first detail read. A listing longer than the artifact can carry is refused
  // at the seal either way, and spending one request per entry that cannot be sealed is not
  // boundedness — it is the same unbounded fan-out wearing a limit that arrives too late.
  if (listed.length > MAX_RULESETS) return { outcome: 'OK', entries: listed, unreadable: false };
  const entries = [];
  let outcome = 'OK';
  let unreadable = false;
  for (const entry of listed) {
    // A ruleset this repository does not own never enters `rulesets` and already forces UNKNOWN
    // through `unmodelled_governing_ruleset`, so reading a detail Gaia has already decided it
    // cannot reconcile against buys no evidence and costs a request.
    if (entry?.source_type !== 'Repository') {
      entries.push(entry);
      continue;
    }
    const rulesetId = listedRulesetId(entry);
    if (rulesetId === null) {
      unreadable = true;
      continue;
    }
    const detail = await readOutcome(read, `repos/${repository}/rulesets/${rulesetId}`);
    if (detail.outcome !== 'OK') {
      outcome = worseReadOutcome(outcome, detail.outcome);
      continue;
    }
    const complete = completeRulesetDetail(detail.answer.body, rulesetId);
    if (complete === null) {
      unreadable = true;
      continue;
    }
    entries.push(complete);
  }
  return { outcome, entries, unreadable };
}

/**
 * The one identity a detail read may be addressed by.
 *
 * A listed `id` that is not a positive integer is not something this probe will interpolate into a
 * request path — that is how a provider response starts choosing which URL Gaia calls — and it is
 * also not an identity the artifact could seal. It is an unreadable detail, never an absence.
 */
function listedRulesetId(entry) {
  const id = entry?.id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
  if (typeof id === 'string' && /^[1-9][0-9]{0,18}$/u.test(id)) return id;
  return null;
}

/**
 * The detail body, or `null` when it cannot decide anything about this ruleset.
 *
 * A body that names another ruleset is ambiguous, a body carrying no `rules` array cannot show the
 * absence of a `merge_queue` rule, and a body carrying no pair of ref-name arrays cannot resolve
 * what the ruleset governs. Each is an incomplete read of a ruleset that exists, which is an
 * evidence gap; treating any of them as "no merge queue here" is the defect in miniature.
 */
function completeRulesetDetail(body, rulesetId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (listedRulesetId(body) !== rulesetId || body.source_type !== 'Repository') return null;
  const refName = body.conditions?.ref_name;
  if (!Array.isArray(body.rules) || !refName || typeof refName !== 'object'
      || !Array.isArray(refName.include) || !Array.isArray(refName.exclude)) {
    return null;
  }
  return body;
}

/** Least to most severe, so many reads collapse into one outcome without an order of arrival. */
const READ_OUTCOME_SEVERITY = Object.freeze([
  'OK', 'NOT_FOUND', 'RATE_LIMITED', 'FAILED', 'FORBIDDEN',
]);

const worseReadOutcome = (left, right) => (
  READ_OUTCOME_SEVERITY.indexOf(right) > READ_OUTCOME_SEVERITY.indexOf(left) ? right : left
);

function parseRulesets(body, defaultBranch, unreadableDetail = false) {
  const rulesets = [];
  const unknown = new Set();
  // A ruleset that exists and whose record could not be read is not a ruleset that does not exist.
  if (unreadableDetail) unknown.add('unreadable_ruleset_detail');
  for (const entry of Array.isArray(body) ? body : []) {
    // An organization, enterprise or otherwise non-repository ruleset governs this branch but
    // cannot be read or written through this repository's endpoints, so it is not evidence this
    // module can reconcile against and it never enters `rulesets`. It is recorded rather than
    // dropped: `GET /repos/{owner}/{repo}/rulesets` defaults to `includes_parents=true`, so a
    // parent ruleset carrying an active merge queue routinely appears in exactly this response,
    // and discarding it silently turns "Gaia could not model the configuration governing this
    // branch" into "Gaia looked and there is no merge queue" — the false ABSENT this module
    // exists to refuse. Rule 3 then decides UNKNOWN, which is the true sentence.
    if (entry?.source_type !== 'Repository') {
      unknown.add('unmodelled_governing_ruleset');
      continue;
    }
    const targets = resolveTargetsDefaultBranch({
      include: entry.conditions?.ref_name?.include ?? [],
      exclude: entry.conditions?.ref_name?.exclude ?? [],
      defaultBranch,
    });
    let mergeQueueRule = null;
    for (const rule of Array.isArray(entry.rules) ? entry.rules : []) {
      if (rule?.type === 'merge_queue') mergeQueueRule = { enabled: true };
      else if (typeof rule?.type === 'string' && RULE_TYPE.test(rule.type)) unknown.add(rule.type);
      else unknown.add('unnameable_rule');
    }
    if (targets === 'UNKNOWN') unknown.add('unresolvable_ref_condition');
    const name = typeof entry.name === 'string' && IDENTITY.test(entry.name) ? entry.name : null;
    rulesets.push({
      rulesetId: String(entry.id),
      name,
      enforcement: MERGE_QUEUE_ENFORCEMENTS.includes(entry.enforcement)
        ? entry.enforcement : 'disabled',
      targetsDefaultBranch: targets === 'UNKNOWN' ? false : targets,
      mergeQueueRule,
    });
  }
  return { rulesets, unknownRuleTypes: [...unknown].sort(ordinal) };
}

// -----------------------------------------------------------------------------------------------
// Remediation — one intent, one effect, compare before write.
// -----------------------------------------------------------------------------------------------

const DESIRED_RULE_DIGEST = sha256(canonicalJson(DESIRED_MERGE_QUEUE_RULE));

/**
 * Plan one additive remediation, or refuse.
 *
 * Pure: it writes nothing and reads nothing. `ABSENT` is the only remediable state — every other
 * one, including `MISCONFIGURED`, produces no intent at all. `MISCONFIGURED` is excluded because
 * every repair for it modifies configuration a human deliberately wrote, which the destructive-
 * replacement rule refuses anyway; accepting it would mean writing a planner whose only possible
 * outcome is a refusal, and inviting a later relaxation of that rule to make it "work".
 */
export function planMergeQueueRemediation({ artifact, observedAt, authority }) {
  const verified = requireMergeQueueCapabilityArtifact(artifact);
  const state = decideMergeQueueCapability({ artifact: verified, observedAt });
  const refuse = (reasonCode) => ({
    accepted: false,
    refusal: sealRefusal({ verified, observedAt, reasonCode }),
  });

  if (state !== 'ABSENT') return refuse('CAPABILITY_NOT_REMEDIABLE');
  if (verified.observation.unknownRuleTypes.length > 0) return refuse('UNKNOWN_RULE_PRESENT');
  if (verified.observation.adminPermission !== 'PRESENT'
      || !authority || authority.repository !== verified.repository
      || authority.action !== 'ADMINISTER_REPOSITORY') {
    return refuse('INSUFFICIENT_AUTHORITY');
  }
  const intentId = remediationIntentId(verified.repositoryId, verified.defaultBranch);
  const body = {
    schema: MERGE_QUEUE_REMEDIATION_INTENT_SCHEMA,
    intentId,
    stamp: `gaia-mq-${intentId.slice(0, 16)}`,
    repositoryId: verified.repositoryId,
    repository: verified.repository,
    defaultBranch: verified.defaultBranch,
    desiredRuleDigest: DESIRED_RULE_DIGEST,
    expectedRulesetDigest: verified.observation.rulesetDigest,
    additions: [{ ...DESIRED_MERGE_QUEUE_RULE }],
    preserved: {
      rulesetIds: verified.observation.rulesets.map(({ rulesetId }) => rulesetId).sort(ordinal),
    },
    observedAt,
  };
  return deepFreeze({
    accepted: true,
    intent: requireMergeQueueRemediationIntent({ ...body, revision: sha256(canonicalJson(body)) }),
  });
}

/**
 * The effect identity: a pure function of the target and the desired end state, and nothing else.
 *
 * It must not include the authority grant — two concurrent remediators legitimately hold two
 * grants, and two identities means two stamps and two rulesets. It must not include the
 * precondition digest either, which moves whenever any unrelated ruleset does. One recipe here
 * because the planner derives it and the verifier re-derives it, and a second implementation is
 * how those two come to disagree about which intent this is.
 */
function remediationIntentId(repositoryId, defaultBranch) {
  return sha256(canonicalJson({
    repositoryId,
    defaultBranch,
    capability: 'MERGE_QUEUE',
    desiredRuleDigest: DESIRED_RULE_DIGEST,
  }));
}

/**
 * Total verification of one `gaia-merge-queue-remediation-intent/1` value.
 *
 * The intent is the only object in this module that can reach a write, and it was the only sealed
 * object nothing ever checked: the capability artifact is re-verified at every consumption seam
 * while the intent's own revision was decorative, so any caller holding a mutated intent — one
 * that crossed a process boundary, was persisted, or was edited — could put arbitrary rules into
 * the request payload. Every field is re-derived rather than believed: the identity and the stamp
 * from the target, the desired rule from the constant. Sixty-four hex characters of the wrong
 * intent is still the wrong intent.
 */
export function requireMergeQueueRemediationIntent(value) {
  const refuse = (message) => {
    throw new MergeQueueCapabilityError('InvalidMergeQueueRemediationIntent', message);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('a Gaia merge queue remediation intent object is required');
  }
  for (const field of Object.keys(value)) {
    if (!MERGE_QUEUE_REMEDIATION_INTENT_FIELDS.includes(field)) {
      refuse(`the intent carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  for (const field of MERGE_QUEUE_REMEDIATION_INTENT_FIELDS) {
    if (!Object.hasOwn(value, field)) refuse(`the intent is missing ${field}`);
  }
  if (value.schema !== MERGE_QUEUE_REMEDIATION_INTENT_SCHEMA) {
    refuse('a Gaia merge queue remediation intent is required');
  }
  if (typeof value.repositoryId !== 'string' || !IDENTITY.test(value.repositoryId)) {
    refuse('the repository identity must be a bounded identity, not a name');
  }
  if (typeof value.repository !== 'string' || !REPOSITORY_NAME.test(value.repository)) {
    refuse('the repository must be owner/name');
  }
  if (typeof value.defaultBranch !== 'string' || !BRANCH.test(value.defaultBranch)) {
    refuse('the default branch must be a bounded branch name');
  }
  if (!isExactInstant(value.observedAt)) {
    refuse('the observation instant must be an exact ISO timestamp');
  }
  // Compared against the constant rather than pattern-matched. `additions` is what reaches the
  // provider, so anything other than exactly the desired merge queue rule is a different effect
  // wearing this intent's name.
  if (canonicalJson(value.additions) !== canonicalJson([DESIRED_MERGE_QUEUE_RULE])
      || value.desiredRuleDigest !== DESIRED_RULE_DIGEST) {
    refuse('an intent may add exactly the desired merge queue rule and nothing else');
  }
  if (typeof value.expectedRulesetDigest !== 'string'
      || value.expectedRulesetDigest !== value.expectedRulesetDigest.toLowerCase()
      || !DIGEST.test(value.expectedRulesetDigest)) {
    refuse('the precondition must be one ruleset digest');
  }
  requirePreservation(value.preserved, refuse);
  const intentId = remediationIntentId(value.repositoryId, value.defaultBranch);
  if (value.intentId !== intentId) {
    refuse('the intent identity is not the identity its own target and desired end state derive');
  }
  if (value.stamp !== `gaia-mq-${intentId.slice(0, 16)}`) {
    refuse('the stamp must name the effect identity it will be written with');
  }
  const { revision, ...body } = value;
  if (typeof revision !== 'string' || revision !== sha256(canonicalJson(body))) {
    refuse('the intent revision does not match its content');
  }
  return value;
}

/**
 * The promise the intent makes by name, verified as a promise rather than accepted as a list.
 *
 * An emptied `preserved.rulesetIds` is the quiet forgery here: it passes every other check and
 * makes the executor's destructive-replacement refusal unreachable, so a provider that replaced
 * the configuration would seal a clean receipt.
 */
function requirePreservation(preserved, refuse) {
  if (!preserved || typeof preserved !== 'object' || Array.isArray(preserved)
      || Object.keys(preserved).length !== 1 || !Array.isArray(preserved.rulesetIds)
      || preserved.rulesetIds.length > MAX_RULESETS) {
    refuse(`the intent must name at most ${MAX_RULESETS} preserved rulesets and nothing else`);
  }
  for (const rulesetId of preserved.rulesetIds) {
    if (typeof rulesetId !== 'string' || !IDENTITY.test(rulesetId)) {
      refuse('every preserved ruleset must be named by a bounded identity');
    }
  }
  for (let index = 1; index < preserved.rulesetIds.length; index += 1) {
    if (ordinal(preserved.rulesetIds[index - 1], preserved.rulesetIds[index]) >= 0) {
      refuse('preserved ruleset identities must be sorted and deduplicated');
    }
  }
}

function sealRefusal({ verified, observedAt, reasonCode }) {
  const body = {
    schema: MERGE_QUEUE_REMEDIATION_REFUSAL_SCHEMA,
    reasonCode,
    repositoryId: verified.repositoryId,
    repository: verified.repository,
    defaultBranch: verified.defaultBranch,
    observedAt,
  };
  return deepFreeze({ ...body, revision: sha256(canonicalJson(body)) });
}

/**
 * Decide, from one fresh read, whether this intent's effect already landed.
 *
 * Pure, and it reaches no effect at all — the executor is the only place a write can happen. The
 * read is decidable because the stamp was written *into* the payload before the request left: a
 * mark applied after a successful response cannot survive a lost response, which is the entire
 * failure this addresses.
 */
export function reconcileMergeQueueRemediation({ intent, rulesets }) {
  const stamped = rulesets.filter(({ name }) => name === intent.stamp);
  const verdict = (() => {
    if (stamped.length > 1) return 'AMBIGUOUS';
    if (stamped.length === 1) {
      const [entry] = stamped;
      // A ruleset wearing the stamp but not carrying an active rule is not this effect having
      // landed — it is a configuration nobody here can explain, and a human decides.
      return entry.mergeQueueRule?.enabled && entry.enforcement === 'active'
        && entry.targetsDefaultBranch ? 'APPLIED' : 'AMBIGUOUS';
    }
    // Function-presence, not just name-absence. If the capability is already satisfied by someone
    // else's ruleset, writing a second one would create the duplicate this design refuses.
    const serving = rulesets.some(
      ({ mergeQueueRule, enforcement, targetsDefaultBranch }) => mergeQueueRule?.enabled
        && enforcement === 'active' && targetsDefaultBranch,
    );
    return serving ? 'SUPERSEDED' : 'NOT_APPLIED';
  })();
  return deepFreeze({
    verdict,
    receipt: sealReceipt({ intent, verdict, rulesets }),
  });
}

function sealReceipt({ intent, verdict, rulesets }) {
  // Content-addressed over the identity, the verdict and the observation — and deliberately not
  // over how many writes this particular remediator issued, so two remediators reaching the same
  // true verdict over the same configuration emit byte-identical receipts.
  const body = {
    schema: MERGE_QUEUE_REMEDIATION_RECEIPT_SCHEMA,
    intentId: intent.intentId,
    verdict,
    observedRulesetDigest: mergeQueueRulesetDigest(rulesets),
  };
  return deepFreeze({ ...body, revision: sha256(canonicalJson(body)) });
}

/**
 * Perform at most one effect, and only after a compare-and-swap.
 *
 * There is no loop here and no retry. A precondition that moved is a refusal, not a reason to
 * look again; an effect whose outcome never arrived is `AMBIGUOUS`, not a reason to write twice.
 */
export async function executeMergeQueueRemediation({ intent, readRulesets, applyRuleset }) {
  // Verified here, before the single-flight and before any read, because this is the boundary at
  // which an intent stops being data and becomes an effect. An unverifiable intent is refused
  // rather than repaired, and it registers no execution.
  const verified = requireMergeQueueRemediationIntent(intent);
  // Two remediators in one process share one execution per effect identity. This is a
  // single-flight, not a retry and not a queue: it holds the one in-flight promise for an
  // intentId and hands the same terminal receipt to every caller, so "at most one effect and one
  // terminal receipt" is true here by construction rather than by timing. Across processes it
  // cannot be true by construction — GitHub's ruleset API is not transactional and does not
  // enforce unique names — and there the stamp and the reconciliation below detect the duplicate
  // instead, terminating at AMBIGUOUS rather than writing again.
  const inFlight = EXECUTIONS.get(verified.intentId);
  if (inFlight) return inFlight;
  const execution = executeOnce({ intent: verified, readRulesets, applyRuleset })
    .finally(() => EXECUTIONS.delete(verified.intentId));
  EXECUTIONS.set(verified.intentId, execution);
  return execution;
}

/** In-flight executions by effect identity. Emptied as each settles; never a durable store. */
const EXECUTIONS = new Map();

async function executeOnce({ intent, readRulesets, applyRuleset }) {
  const before = await readRulesets();
  const reconciled = reconcileMergeQueueRemediation({ intent, rulesets: before });
  if (reconciled.verdict !== 'NOT_APPLIED') {
    // Already landed, already satisfied, or already ambiguous. Every one of those is terminal
    // without a write, which is what makes a retry after a lost response safe.
    return deepFreeze({ receipt: reconciled.receipt, writes: 0, refusal: null });
  }
  if (mergeQueueRulesetDigest(before) !== intent.expectedRulesetDigest) {
    // The plan was made against a configuration that no longer exists, and a plan is not a licence.
    return deepFreeze({
      receipt: sealReceipt({ intent, verdict: 'AMBIGUOUS', rulesets: before }),
      writes: 0,
      refusal: sealExecutionRefusal(intent, 'PRECONDITION_CHANGED'),
    });
  }
  try {
    await applyRuleset({
      name: intent.stamp,
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      // The constant, not `intent.additions`. The verifier has already refused any intent whose
      // additions are not exactly this, and taking the payload from the constant means the write
      // cannot drift even if that check is one day loosened.
      rules: [{ ...DESIRED_MERGE_QUEUE_RULE }],
    });
  } catch {
    // The write left and its outcome is unknown. That is ambiguous, not failed: the next
    // reconciliation reads the stamp and decides. Nothing is retried here.
    return deepFreeze({
      receipt: sealReceipt({ intent, verdict: 'AMBIGUOUS', rulesets: before }),
      writes: 1,
      refusal: null,
    });
  }
  const after = await readRulesets();
  // The write is additive by construction — it creates one ruleset and modifies none — but that
  // is a claim about the request, not about what the provider did with it. GitHub's ruleset and
  // branch-protection writes are replacements rather than merges, and a required status check
  // that disappears this way removes a gate nobody notices is gone. So the promise the intent
  // made by name is checked against the configuration that came back.
  const survived = new Set(after.map(({ rulesetId }) => rulesetId));
  const lost = intent.preserved.rulesetIds.filter((rulesetId) => !survived.has(rulesetId));
  if (lost.length > 0) {
    return deepFreeze({
      receipt: sealReceipt({ intent, verdict: 'AMBIGUOUS', rulesets: after }),
      writes: 1,
      refusal: sealExecutionRefusal(intent, 'DESTRUCTIVE_REPLACEMENT'),
    });
  }
  // A provider response that did not throw is not proof of the end state — that is the same
  // "infer the fact from a proxy for the fact" move this module exists to refuse, and it sealed a
  // terminal APPLIED receipt for a merge queue that did not exist. The verdict is whatever the
  // configuration that came back actually says, decided by the one reconciler, so the executor
  // and the reconciler can never give one read two opposite terminal answers.
  const landed = reconcileMergeQueueRemediation({ intent, rulesets: after });
  const settled = settledVerdict(landed.verdict);
  return deepFreeze({
    receipt: sealReceipt({ intent, verdict: settled, rulesets: after }),
    writes: 1,
    refusal: null,
  });
}

/**
 * The one place a post-write reading differs from a pre-write one.
 *
 * `NOT_APPLIED` before the write is a verdict that permits the effect. After a write that left
 * this process and was accepted, a configuration carrying nothing is not "nothing happened" — it
 * is an outcome the read cannot account for, which is what `AMBIGUOUS` names, and which
 * terminates rather than authorising a second attempt.
 */
function settledVerdict(verdict) {
  return verdict === 'NOT_APPLIED' ? 'AMBIGUOUS' : verdict;
}

function sealExecutionRefusal(intent, reasonCode) {
  const body = {
    schema: MERGE_QUEUE_REMEDIATION_REFUSAL_SCHEMA,
    reasonCode,
    intentId: intent.intentId,
  };
  return deepFreeze({ ...body, revision: sha256(canonicalJson(body)) });
}
