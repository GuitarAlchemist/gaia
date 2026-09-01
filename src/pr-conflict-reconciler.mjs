/**
 * pr-conflict-reconciler.mjs — `gaia-pr-conflict-classification/1`, slice 1 of issue #82: the one
 * read-only reading of whether a pull request is actually conflicting, and the one decision from
 * that reading to a closed state.
 *
 * WHY THIS EXISTS
 * ---------------
 * A merge conflict is a terminal hole in Gaia's engineering pump. GitHub exposes it, no durable
 * transition owns it, and a pull request therefore stays open until a human happens to look. The
 * obvious fix is worse than the hole: a reconciler that reads a pull request as conflicting when
 * nobody proved it, that names paths no provider returned, that guesses at a semantic overlap, or
 * that acts on behalf of a generation which has already moved. Each of those turns a stalled pull
 * request into a wrong branch edit, and a wrong branch edit is not recoverable by waiting.
 *
 * So this module decides, and it does nothing. It performs no merge, opens no file, spawns no
 * process, holds no clock and carries no credential. It converts one structured observation into
 * one content-addressed reading. Every effect belongs to a later slice.
 *
 * THE FIVE RULES THAT DECIDE EVERY ANSWER
 * ---------------------------------------
 * 1. **Incomplete evidence is incomplete, never a conflict.** `mergeability` has exactly three
 *    readings and exactly one of them — `CONFLICTING` — can conclude a conflict. `UNKNOWN` is a
 *    provider that has not finished computing, and it concludes nothing.
 * 2. **A conflicting path is evidence somebody produced, not a field somebody read.** No provider
 *    mergeability field returns the conflicting paths; they come from a merge performed elsewhere
 *    or from a declared fixture. Every reading therefore republishes the source of its paths, and
 *    a reading with no named source may not carry paths at all.
 * 3. **A mergeability nobody bound to these two commits is about some other pair of commits.**
 *    `EXACT_OIDS` carries declared binding base and head OIDs and they must equal this observation.
 *    This is structural equality, not provider provenance; a later producer must establish where
 *    those values came from. `UNBOUND` carries neither OID and decides `UNKNOWN`.
 * 4. **The strategy registry is closed and versioned, and refuses by default.** An entry is
 *    admitted only by a registered strategy's own predicate. Anything unregistered — arbitrary
 *    source overlap, modify/delete, rename ambiguity, binaries, protected paths, permission
 *    changes, unproven content — escalates, and one unsafe entry escalates the whole reading.
 * 5. **Work identity is not generation identity.** One pull request has one `workKey` for its
 *    whole life and a new `generation` for each `(baseOid, headOid)` pair. A claim on a
 *    generation that is no longer the observed one is `SUPERSEDED` before anything is proposed to
 *    it. Generations compare by equality only; an OID has no order, and comparing two of them
 *    with `<` is how a stale replay comes to look newer than a live one.
 *
 * FOUR CORRECTIONS THIS MODULE MAKES TO ITS OWN DESIGN
 * ---------------------------------------------------
 * `docs/pr-conflict-reconciler.md` was written before the tooling was read. Four of its claims
 * did not survive that read, and the corrections are structural here rather than advisory:
 *
 * - "Capture the conflicting paths" is unsatisfiable from a provider mergeability read. Rule 2.
 * - "Byte-identical add/add content" is not reachable from `MERGE_TREE`: `ort` resolves it without
 *   reporting a conflict. A fixture can test refusal logic, but cannot authorize production
 *   automation. Slice 1 therefore reserves `AUTO_RESOLVABLE` while registering no strategy.
 * - One idempotency key cannot both name the work and name the generation, so it cannot detect two
 *   live generations of the same pull request. Rule 5 splits them, then parses every claimed
 *   generation back to the same normalized repository and pull request before superseding it.
 * - A bare `EXACT_OIDS` assertion proves nothing. Rule 3 makes its base/head binding explicit.
 *
 * It imports a digest and the one shared exact-instant predicate. Re-spelling that predicate here
 * would give this product two definitions of what a valid instant is, which is the defect rather
 * than the fix.
 */

import { createHash } from 'node:crypto';

import { isExactInstant } from './local-lane-observation.mjs';

export const PR_CONFLICT_OBSERVATION_SCHEMA = 'gaia-pr-conflict-observation/2';
export const PR_CONFLICT_CLASSIFICATION_SCHEMA = 'gaia-pr-conflict-classification/1';

/** The registry version every reading is decided under, so two readings are comparable. */
export const PR_CONFLICT_STRATEGY_REGISTRY_VERSION = 'gaia-pr-conflict-strategies/2';

/**
 * The three readings of mergeability, already normalised by the producer.
 *
 * A provider's own vocabulary — `MERGEABLE`, `DIRTY`, `BLOCKED`, `DRAFT`, `BEHIND`, an absent
 * merge commit — is the adapter's problem. Widening this set is how a status that means "a review
 * is missing" comes to mean "the branches disagree".
 */
export const PR_CONFLICT_MERGEABILITIES = Object.freeze(['UNKNOWN', 'CLEAN', 'CONFLICTING']);

/** Whether declared binding OIDs are absent or structurally equal to this exact base and head. */
export const PR_CONFLICT_MERGEABILITY_BINDINGS = Object.freeze(['UNBOUND', 'EXACT_OIDS']);

/**
 * Where the conflicting paths came from. `NONE` is the only source a non-conflicting reading may
 * name, and it may carry no paths.
 *
 * There is deliberately no `PROVIDER_MERGEABILITY` member: no provider mergeability field returns
 * conflicting paths, so a producer has nowhere to record that it got them that way.
 */
export const PR_CONFLICT_EVIDENCE_SOURCES = Object.freeze([
  'NONE', 'MERGE_TREE', 'INJECTED_FIXTURE',
]);

/** The closed output vocabulary. No other value is ever reported. */
export const PR_CONFLICT_CLASSIFICATIONS = Object.freeze([
  'UNKNOWN', 'CLEAN', 'AUTO_RESOLVABLE', 'ESCALATION_REQUIRED', 'SUPERSEDED',
]);

/** The conflict shapes a merge can report. `UNKNOWN` is a shape this version does not model. */
export const PR_CONFLICT_ENTRY_KINDS = Object.freeze([
  'ADD_ADD', 'MODIFY_MODIFY', 'MODIFY_DELETE', 'DELETE_MODIFY',
  'RENAME_RENAME', 'RENAME_DELETE', 'UNKNOWN',
]);

/**
 * Why an entry was not admitted. Each is a refusal to act, never a repair.
 *
 * `EVIDENCE_INCOMPLETE` is the honest reading of a digest or a mode nobody captured: not knowing
 * whether two sides agree is recorded as not knowing, never as a proven difference and never as a
 * proven match.
 */
export const PR_CONFLICT_REFUSALS = Object.freeze([
  'BINARY_CONTENT', 'CONTENT_NOT_IDENTICAL', 'EVIDENCE_INCOMPLETE', 'MODE_CHANGE',
  'PROTECTED_PATH', 'SEMANTIC_SOURCE_OVERLAP', 'UNREGISTERED_CONFLICT_KIND',
]);

/**
 * Git's four tree entry modes. A mode is read from a tree entry, never from the filesystem: a
 * checkout with `core.filemode=false` reports every file as `100644`, which would make a
 * permission conflict invisible exactly where it matters most.
 */
export const PR_CONFLICT_FILE_MODES = Object.freeze([
  '100644', '100755', '120000', '160000',
]);

/**
 * Paths no automatic strategy may touch, whatever their content proves.
 *
 * Exact paths and prefixes rather than patterns: the safety envelope is an explicit closed policy,
 * not a guess based on a filename fragment. Credentials, security policy, architecture policy,
 * contract schemas, workflow files, and code-owner policy remain human-owned.
 */
export const PR_CONFLICT_PROTECTED_PATHS = Object.freeze([
  '.env', 'ARCHITECTURE.md', 'SECURITY.md',
]);

export const PR_CONFLICT_PROTECTED_PATH_PREFIXES = Object.freeze([
  '.git/', '.github/', 'docs/contracts/',
]);

export const PR_CONFLICT_OBSERVATION_FIELDS = Object.freeze([
  'baseOid', 'baseRef', 'bindingBaseOid', 'bindingHeadOid', 'conflictEvidence', 'conflicts',
  'conflictsComplete', 'headOid', 'headRef', 'mergeBaseOid', 'mergeability',
  'mergeabilityBinding', 'observedAt', 'pullRequest', 'repository', 'schema',
]);

export const PR_CONFLICT_ENTRY_FIELDS = Object.freeze([
  'baseDigest', 'baseMode', 'binary', 'headDigest', 'headMode', 'kind', 'path',
]);

export const PR_CONFLICT_CLAIM_FIELDS = Object.freeze(['generation', 'workKey']);

export const PR_CONFLICT_CLASSIFICATION_FIELDS = Object.freeze([
  'authority', 'baseOid', 'classification', 'conflictEvidence', 'conflictPaths', 'effect',
  'generation', 'headOid', 'mergeBaseOid', 'mergeability', 'observedAt', 'pullRequest',
  'refusals', 'registry', 'repository', 'revision', 'schema', 'strategy', 'workKey',
]);

/** A git object name, SHA-1 or SHA-256, lowercase. Case is not normalised: it is refused. */
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CLAIM_GENERATION = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})#([1-9][0-9]*):([0-9a-f]{40}|[0-9a-f]{64}):([0-9a-f]{40}|[0-9a-f]{64})$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;

const MAX_CONFLICTS = 512;
const MAX_CONFLICT_PATH_LENGTH = 4096;
const MAX_PULL_REQUEST = 1_000_000;

/** Ordinal comparison. Not `localeCompare`, which is host- and ICU-version-dependent. */
const ordinal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export class PrConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrConflictError';
    this.code = code;
  }
}

const refuse = (message) => {
  throw new PrConflictError('InvalidPrConflictObservation', message);
};

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

/**
 * The identity of the work, stable for the whole life of one pull request.
 *
 * Lowercased, because a provider treats `Owner/Name` and `owner/name` as one repository and two
 * work keys for one pull request would let two workers each believe they hold it.
 */
export function prConflictWorkKey({ repository, pullRequest }) {
  if (typeof repository !== 'string' || !REPOSITORY_NAME.test(repository)) {
    refuse('the repository must be owner/name');
  }
  requirePullRequestNumber(pullRequest);
  return sha256(`${repository.toLowerCase()}#${pullRequest}`);
}

/**
 * The identity of one generation of that work: `repo#pr:baseOid:headOid`, as issue #82 specifies.
 *
 * A value, not an order. Two generations are the same one or they are not; which of them is later
 * is not readable from the string and is never asked.
 */
export function prConflictGeneration({ repository, pullRequest, baseOid, headOid }) {
  if (typeof repository !== 'string' || !REPOSITORY_NAME.test(repository)) {
    refuse('the repository must be owner/name');
  }
  requirePullRequestNumber(pullRequest);
  for (const [name, oid] of [['baseOid', baseOid], ['headOid', headOid]]) {
    if (typeof oid !== 'string' || !OID.test(oid)) {
      refuse(`${name} must be a lowercase git object name`);
    }
  }
  return `${repository.toLowerCase()}#${pullRequest}:${baseOid}:${headOid}`;
}

function requirePullRequestNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PULL_REQUEST) {
    refuse('the pull request must be a positive integer number');
  }
}

/**
 * Git paths are slash-delimited repository-relative names, not host filesystem paths.
 *
 * Keep the caller's JS string exactly: no Unicode normalization, separator conversion, resolve,
 * or filesystem access. The bound limits hostile observations without narrowing valid names to
 * ASCII. Empty components are not tree entries, and dot segments would make the name ambiguous.
 */
function isBoundedGitPath(value) {
  if (typeof value !== 'string' || value.length === 0
      || value.length > MAX_CONFLICT_PATH_LENGTH || value.includes('\0')
      || value.startsWith('/')) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Total verification of one `gaia-pr-conflict-observation/2` value.
 *
 * Every refusal is a refusal to *use the evidence*, never a repair. Nothing is clamped, defaulted
 * or dropped: an unknown field is not ignored, an unrecognised mergeability is not bucketed as
 * "other", a missing digest is not treated as a match, and an out-of-range file mode is not
 * rounded to the nearest one. Each of those repairs would turn incoherent evidence into a
 * confident reading, which is the failure this module exists to stop.
 */
export function requirePrConflictObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('a Gaia pull-request conflict observation object is required');
  }
  for (const field of Object.keys(value)) {
    if (!PR_CONFLICT_OBSERVATION_FIELDS.includes(field)) {
      refuse(`the observation carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  for (const field of PR_CONFLICT_OBSERVATION_FIELDS) {
    if (!Object.hasOwn(value, field)) refuse(`the observation is missing ${field}`);
  }
  if (value.schema !== PR_CONFLICT_OBSERVATION_SCHEMA) {
    refuse('a gaia-pr-conflict-observation/2 value is required');
  }
  if (!isExactInstant(value.observedAt)) {
    refuse('the observation instant must be an exact ISO timestamp');
  }
  if (typeof value.repository !== 'string' || !REPOSITORY_NAME.test(value.repository)) {
    refuse('the repository must be owner/name');
  }
  requirePullRequestNumber(value.pullRequest);
  for (const field of ['baseRef', 'headRef']) {
    if (typeof value[field] !== 'string' || !BRANCH.test(value[field])) {
      refuse(`${field} must be a bounded branch name`);
    }
  }
  for (const field of ['baseOid', 'headOid']) {
    if (typeof value[field] !== 'string' || !OID.test(value[field])) {
      refuse(`${field} must be a lowercase git object name`);
    }
  }
  // Null, not absent: two commits with no common ancestor are a real reading, and forcing the
  // producer to invent one would be the fabrication this module refuses everywhere else.
  if (value.mergeBaseOid !== null
      && (typeof value.mergeBaseOid !== 'string' || !OID.test(value.mergeBaseOid))) {
    refuse('the merge base must be a lowercase git object name or null');
  }
  if (!PR_CONFLICT_MERGEABILITIES.includes(value.mergeability)) {
    refuse('the mergeability must be one of the three normalised readings');
  }
  if (!PR_CONFLICT_MERGEABILITY_BINDINGS.includes(value.mergeabilityBinding)) {
    refuse('the mergeability binding must be one of the closed bindings');
  }
  if (value.mergeabilityBinding === 'UNBOUND') {
    if (value.bindingBaseOid !== null || value.bindingHeadOid !== null) {
      refuse('an unbound mergeability reading must carry null binding OIDs');
    }
  } else {
    for (const field of ['bindingBaseOid', 'bindingHeadOid']) {
      if (typeof value[field] !== 'string' || !OID.test(value[field])) {
        refuse(`${field} must be a lowercase git object name for an exact binding`);
      }
    }
    if (value.bindingBaseOid !== value.baseOid || value.bindingHeadOid !== value.headOid) {
      refuse('the exact mergeability binding OIDs must equal the observation OIDs');
    }
  }
  if (!PR_CONFLICT_EVIDENCE_SOURCES.includes(value.conflictEvidence)) {
    refuse('the conflict evidence source must be one of the closed sources');
  }
  if (typeof value.conflictsComplete !== 'boolean') {
    refuse('conflictsComplete must be a boolean: an enumeration is exhausted or it is not');
  }
  if (!Array.isArray(value.conflicts) || value.conflicts.length > MAX_CONFLICTS) {
    refuse(`the observation must carry at most ${MAX_CONFLICTS} conflict entries`);
  }
  requireEvidenceCoherence(value);
  const seen = new Set();
  for (const entry of value.conflicts) {
    requireConflictEntry(entry, value.conflictEvidence);
    if (seen.has(entry.path)) refuse(`the conflict path ${JSON.stringify(entry.path)} is repeated`);
    seen.add(entry.path);
  }
  return value;
}

/**
 * The rules that make a fabricated conflict unsayable rather than merely discouraged.
 *
 * A producer that wanted to record "GitHub said UNKNOWN and here are the paths" has nowhere to put
 * either half of that sentence.
 */
function requireEvidenceCoherence(value) {
  const conflicting = value.mergeability === 'CONFLICTING';
  const bound = value.mergeabilityBinding === 'EXACT_OIDS';
  if (!conflicting || !bound) {
    if (value.conflicts.length > 0) {
      refuse('only a bound, conflicting reading may carry conflict entries');
    }
    if (value.conflictEvidence !== 'NONE') {
      refuse('only a bound, conflicting reading may name a conflict evidence source');
    }
    if (value.conflictsComplete) {
      refuse('only a bound, conflicting reading may claim an exhausted conflict enumeration');
    }
    return;
  }
  if (value.conflictEvidence === 'NONE') {
    refuse('a conflicting reading must name where its conflicting paths came from');
  }
  if (value.conflictsComplete && value.conflicts.length === 0) {
    refuse('an exhausted enumeration of a conflicting merge that found nothing is incoherent');
  }
}

function requireConflictEntry(entry, source) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    refuse('every conflict entry must be a plain object');
  }
  for (const field of Object.keys(entry)) {
    if (!PR_CONFLICT_ENTRY_FIELDS.includes(field)) {
      refuse(`a conflict entry carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  for (const field of PR_CONFLICT_ENTRY_FIELDS) {
    if (!Object.hasOwn(entry, field)) refuse(`a conflict entry is missing ${field}`);
  }
  if (!isBoundedGitPath(entry.path)) {
    refuse('a conflict path must be a bounded repository-relative path');
  }
  if (!PR_CONFLICT_ENTRY_KINDS.includes(entry.kind)) {
    refuse(`the conflict kind for ${JSON.stringify(entry.path)} is outside the closed set`);
  }
  if (typeof entry.binary !== 'boolean') {
    refuse(`binary must be a boolean for ${JSON.stringify(entry.path)}`);
  }
  for (const field of ['baseDigest', 'headDigest']) {
    if (entry[field] !== null && (typeof entry[field] !== 'string' || !DIGEST.test(entry[field]))) {
      refuse(`${field} must be a SHA-256 content digest or null`);
    }
  }
  for (const field of ['baseMode', 'headMode']) {
    if (entry[field] !== null && !PR_CONFLICT_FILE_MODES.includes(entry[field])) {
      refuse(`${field} must be a git tree entry mode or null`);
    }
  }
  if (source === 'MERGE_TREE' && isSilentlyResolvedAddAdd(entry)) {
    // Verified against the shipped tooling: the `ort` driver resolves an add/add whose two blobs
    // and modes agree, and reports nothing. Evidence claiming a merge reported one did not come
    // from a merge, and admitting it would auto-resolve on a claim the merge already made.
    refuse(`a merge cannot report a byte-identical add/add: ${JSON.stringify(entry.path)}`);
  }
}

const isSilentlyResolvedAddAdd = (entry) => entry.kind === 'ADD_ADD' && !entry.binary
  && entry.baseDigest !== null && entry.baseDigest === entry.headDigest
  && entry.baseMode !== null && entry.baseMode === entry.headMode;

const isProtectedPath = (path) => PR_CONFLICT_PROTECTED_PATHS.includes(path)
  || PR_CONFLICT_PROTECTED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));

/**
 * The bounded refusal policy for one conflict entry.
 *
 * Its checks run in a fixed order so that two readings of the same entry name the same refusal:
 * where the file lives, then what kind of file it is, then what kind of conflict it is, then
 * whether the content and the permission were actually proven identical.
 *
 * A null return would mean a registered strategy admitted the entry. Slice 1 has no authoritative
 * production strategy, so the formerly fixture-only shape receives an explicit unregistered
 * refusal after the safety-specific checks have named any stronger reason.
 */
function conflictEntryRefusal(entry) {
  if (isProtectedPath(entry.path)) return 'PROTECTED_PATH';
  if (entry.binary) return 'BINARY_CONTENT';
  if (entry.kind === 'MODIFY_MODIFY') return 'SEMANTIC_SOURCE_OVERLAP';
  if (entry.kind !== 'ADD_ADD') return 'UNREGISTERED_CONFLICT_KIND';
  if (entry.baseDigest === null || entry.headDigest === null) return 'EVIDENCE_INCOMPLETE';
  if (entry.baseDigest !== entry.headDigest) return 'CONTENT_NOT_IDENTICAL';
  if (entry.baseMode === null || entry.headMode === null) return 'EVIDENCE_INCOMPLETE';
  if (entry.baseMode !== entry.headMode) return 'MODE_CHANGE';
  return 'UNREGISTERED_CONFLICT_KIND'; // no authoritative slice-1 strategy admits this entry
}

/** The closed, versioned registry. Membership is the whole of what may be automated. */
export const PR_CONFLICT_STRATEGY_REGISTRY = Object.freeze({});

export const PR_CONFLICT_STRATEGIES = Object.freeze(
  Object.keys(PR_CONFLICT_STRATEGY_REGISTRY).sort(ordinal),
);

/** The one digest recipe, over exactly the reading it is published on. */
export function prConflictClassificationRevision(body) {
  return sha256(canonicalJson(body));
}

const seal = (body) => deepFreeze({
  ...body, revision: prConflictClassificationRevision(body),
});

/**
 * The fields every reading carries whatever it concluded. The generation is always the observed
 * one, so a superseded claimant can read what beat it.
 */
const identityOf = (observation) => ({
  workKey: prConflictWorkKey(observation),
  generation: prConflictGeneration(observation),
});

function reading(observation, identity, {
  classification, strategy = null, conflictPaths = [], refusals = [], conflictEvidence,
}) {
  return seal({
    schema: PR_CONFLICT_CLASSIFICATION_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    registry: PR_CONFLICT_STRATEGY_REGISTRY_VERSION,
    observedAt: observation.observedAt,
    repository: observation.repository,
    pullRequest: observation.pullRequest,
    workKey: identity.workKey,
    generation: identity.generation,
    baseOid: observation.baseOid,
    headOid: observation.headOid,
    mergeBaseOid: observation.mergeBaseOid,
    mergeability: observation.mergeability,
    conflictEvidence,
    classification,
    strategy,
    conflictPaths,
    refusals,
  });
}

/**
 * A reading that concluded nothing actionable: no strategy, no paths, no refusals.
 *
 * `SUPERSEDED` uses this too, deliberately. The observed generation's conflicting paths are true,
 * but they are not the stale claimant's to act on, and handing them over is how a loser keeps
 * working. What it is handed is the generation that now holds.
 */
const cleanReading = (observation, identity, classification) => reading(observation, identity, {
  classification, conflictEvidence: observation.conflictEvidence,
});

const supersededReading = (observation, identity) => reading(observation, identity, {
  classification: 'SUPERSEDED', conflictEvidence: 'NONE',
});

function requireClaim(claim, observation, workKey) {
  if (claim === null) return null;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    refuse('a claim must be a generation-bearing object or null');
  }
  for (const field of Object.keys(claim)) {
    if (!PR_CONFLICT_CLAIM_FIELDS.includes(field)) {
      refuse(`the claim carries an unknown field ${JSON.stringify(field)}`);
    }
  }
  for (const field of PR_CONFLICT_CLAIM_FIELDS) {
    if (!Object.hasOwn(claim, field)) refuse(`the claim is missing ${field}`);
  }
  if (typeof claim.workKey !== 'string' || !DIGEST.test(claim.workKey)) {
    refuse('the claim work key must be a SHA-256 work identity');
  }
  if (typeof claim.generation !== 'string') {
    refuse('the claim generation must be a repo#pr:baseOid:headOid key');
  }
  const parsed = CLAIM_GENERATION.exec(claim.generation);
  if (parsed === null) {
    refuse('the claim generation must carry exact lowercase SHA-1 or SHA-256 object names');
  }
  const [, repository, pullRequestText, baseOid, headOid] = parsed;
  const pullRequest = Number(pullRequestText);
  requirePullRequestNumber(pullRequest);
  if (repository.toLowerCase() !== observation.repository.toLowerCase()
      || pullRequest !== observation.pullRequest) {
    refuse('the claim generation names a different pull request than the observation');
  }
  const canonicalGeneration = prConflictGeneration({ repository, pullRequest, baseOid, headOid });
  if (claim.generation !== canonicalGeneration) {
    refuse('the claim generation must use its one canonical normalized representation');
  }
  if (claim.workKey !== workKey) {
    // Not supersession. A claim about another pull request delivered here is a routing failure,
    // and answering it — with any verdict — would be Gaia deciding something it was not asked.
    refuse('the claim names a different pull request than the observation');
  }
  return claim;
}

/**
 * Classify one observation, optionally on behalf of one claim. Pure, total, and read-only.
 *
 * The order is the contract. Supersession is decided before mergeability is read at all, because a
 * claimant that has already lost must not be handed a verdict about a generation it cannot act on,
 * however clean or however conflicting that generation turns out to be.
 */
export function classifyPrConflict({ observation, claim = null }) {
  const verified = requirePrConflictObservation(observation);
  const identity = identityOf(verified);
  const claimed = requireClaim(claim, verified, identity.workKey);

  if (claimed !== null && claimed.generation !== identity.generation) {
    return supersededReading(verified, identity);
  }
  if (verified.mergeabilityBinding !== 'EXACT_OIDS') {
    return cleanReading(verified, identity, 'UNKNOWN');
  }
  if (verified.mergeability === 'UNKNOWN') return cleanReading(verified, identity, 'UNKNOWN');
  if (verified.mergeability === 'CLEAN') return cleanReading(verified, identity, 'CLEAN');
  return decideConflicting(verified, identity);
}

function decideConflicting(observation, identity) {
  const refusals = new Set();
  // An enumeration nobody finished cannot prove that what it did not list is safe. The entries it
  // did list are still classified, so the escalation says everything that is known.
  if (!observation.conflictsComplete) refusals.add('EVIDENCE_INCOMPLETE');
  for (const entry of observation.conflicts) {
    const refusal = conflictEntryRefusal(entry);
    if (refusal !== null) refusals.add(refusal);
  }
  const conflictPaths = observation.conflicts.map((entry) => entry.path).sort(ordinal);
  return escalationReading(observation, identity, conflictPaths, refusals);
}

function escalationReading(observation, identity, conflictPaths, refusals) {
  return reading(observation, identity, {
    classification: 'ESCALATION_REQUIRED',
    conflictPaths,
    refusals: [...refusals].sort(ordinal),
    conflictEvidence: observation.conflictEvidence,
  });
}
