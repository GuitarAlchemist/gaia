/**
 * Lookup-only settlement decision for one EFFECT_AMBIGUOUS Draft operation (Gaia issue #176).
 *
 * An ambiguous operation's only exit today is REUSED, which reconcileDraft takes when its exact
 * marker lookup finds the Draft. When the lookup finds nothing, the operation stays pending for
 * ever, because nothing tells "found nothing" apart from "searched badly". This module makes that
 * call from a saved lookup, and only that call: it reads no network, no clock and no ledger, and
 * it never creates, retries or cancels an effect. Writing a settlement is the envelope module's
 * `settleAmbiguousDraft` (#161), which re-reads its evidence here whenever the ledger is read.
 *
 * The operation is the ledger's own record: its envelope, identity, state and committed revision.
 * Its identity is recomputed here from the envelope, exactly as the envelope module derives it, so
 * an operation id cannot be paired with another generation's head. The lookup is the search the
 * Draft provider runs (src/gh-draft-operation-provider.mjs): the repository identity first, then
 * every pull request on the operation's head branch in every state, as `gh pr list --json` rows,
 * after reading the operation at the ambiguous revision it names. The provider creates a Draft only
 * on that head, a pull request's head branch never changes, and a pull request is never deleted.
 * So a complete, untruncated search that returns no pull request finds the Draft absent at the
 * moment it ran; that it stays absent needs the create call to be over, which is the envelope's
 * check on the executor run, not this module's. Anything short of that stays unsettled.
 */

import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/u;
const LOOKUP_OUTCOMES = new Set(['COMPLETE', 'PARTIAL', 'ERRORED']);
const PULL_REQUEST_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);
// The provider's own search bound (`gh pr list --limit 100`); a lookup records exactly that search.
const PROVIDER_SEARCH_LIMIT = 100;
const CANDIDATE_KEYS = [
  'number', 'url', 'isDraft', 'state', 'baseRefName', 'headRefName', 'headRefOid',
  'headRepositoryOwner', 'body',
];

export const SETTLEMENT_DECISIONS = Object.freeze(['SETTLE_REUSED', 'SETTLE_ABANDONED', 'STAY_UNSETTLED']);

export class AmbiguitySettlementError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AmbiguitySettlementError';
    this.code = code;
  }
}

const fail = (code) => { throw new AmbiguitySettlementError(code); };

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const contentRevision = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The exact own data fields of a plain object, copied. Everything after this reads the copy, so
 * what is validated is what is decided on and hashed: no accessor, prototype or extra key.
 */
function fields(value, expected, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string'
    || !expected.includes(key))) fail(code);
  const copy = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    copy[key] = descriptor.value;
  }
  return copy;
}

/** A plain array's items, copied: no holes, no extra own property, no other prototype. */
function items(value, maximum, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const { length } = value;
  if (!Number.isSafeInteger(length) || length > maximum
    || Reflect.ownKeys(value).length !== length + 1) fail(code);
  const copy = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    copy.push(descriptor.value);
  }
  return copy;
}

function text(value, code, maximum = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function branch(value, code) {
  const candidate = text(value, code);
  if (!BRANCH.test(candidate) || candidate.includes('..') || candidate.endsWith('.lock')) fail(code);
  return candidate;
}

function repository(value, code) {
  const copy = fields(value, ['nodeId', 'owner', 'name'], code);
  const owner = text(copy.owner, code);
  const name = text(copy.name, code);
  if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) fail(code);
  return { nodeId: text(copy.nodeId, code), owner, name };
}

function pattern(value, regex, code) {
  if (typeof value !== 'string' || !regex.test(value)) fail(code);
  return value;
}

function instant(value, code) {
  pattern(value, INSTANT, code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().replace('.000Z', 'Z') !== value) fail(code);
  return value;
}

/** The ledger's envelope, validated field by field (src/draft-operation-envelope.mjs). */
function envelopeOf(value, code) {
  const envelope = fields(value, [
    'schema', 'repository', 'workItem', 'readyItem', 'observedSourceRevision', 'generation',
    'requestedEffect',
  ], code);
  if (envelope.schema !== 'GaiaDraftOperationEnvelopeV0' || envelope.requestedEffect !== 'CREATE_DRAFT') {
    fail(code);
  }
  const workItem = fields(envelope.workItem, ['kind', 'number'], code);
  if (workItem.kind !== 'ISSUE' || !Number.isSafeInteger(workItem.number) || workItem.number <= 0) {
    fail(code);
  }
  const readyItem = fields(envelope.readyItem, ['schema', 'queueReceiptRevision', 'occurrence', 'id'], code);
  if (readyItem.schema !== 'GaiaReadyItemIdentityV0' || !Number.isSafeInteger(readyItem.occurrence)
    || readyItem.occurrence <= 0) fail(code);
  const generation = fields(envelope.generation, ['baseRef', 'headRef', 'headRevision', 'policyRevision'], code);
  return {
    schema: envelope.schema,
    repository: repository(envelope.repository, code),
    workItem: { kind: 'ISSUE', number: workItem.number },
    readyItem: {
      schema: readyItem.schema,
      queueReceiptRevision: pattern(readyItem.queueReceiptRevision, SHA256, code),
      occurrence: readyItem.occurrence,
      id: pattern(readyItem.id, SHA256, code),
    },
    observedSourceRevision: pattern(envelope.observedSourceRevision, SHA256, code),
    generation: {
      baseRef: branch(generation.baseRef, code),
      headRef: branch(generation.headRef, code),
      headRevision: pattern(generation.headRevision, GIT_OID, code),
      policyRevision: pattern(generation.policyRevision, GIT_OID, code),
    },
    requestedEffect: envelope.requestedEffect,
  };
}

/** The identity the envelope module derives from an envelope; any other identity is not its own. */
function identityOf(envelope) {
  const workKey = contentRevision({
    schema: 'GaiaDraftWorkKeyV0', repositoryNodeId: envelope.repository.nodeId,
    workItem: envelope.workItem, requestedEffect: 'CREATE_DRAFT',
  });
  const readyItemId = contentRevision({
    schema: 'GaiaReadyItemIdV0', workKey,
    queueReceiptRevision: envelope.readyItem.queueReceiptRevision,
    occurrence: envelope.readyItem.occurrence,
    observedSourceRevision: envelope.observedSourceRevision,
  });
  const generationKey = contentRevision({
    schema: 'GaiaDraftGenerationKeyV0', readyItemId, generation: envelope.generation,
  });
  const operationId = contentRevision({ schema: 'GaiaDraftOperationIdV0', workKey, generationKey });
  return { workKey, readyItemId, generationKey, operationId };
}

/** The operation as the ledger holds it: identity, state, revision and envelope. */
function validateOperation(value) {
  const code = 'InvalidOperation';
  const operation = fields(value, [
    'operationId', 'workKey', 'generationKey', 'committedRevision', 'state', 'envelope',
  ], code);
  pattern(operation.operationId, SHA256, code);
  pattern(operation.workKey, SHA256, code);
  pattern(operation.generationKey, SHA256, code);
  pattern(operation.committedRevision, SHA256, code);
  if (typeof operation.state !== 'string') fail(code);
  const envelope = envelopeOf(operation.envelope, code);
  const derived = identityOf(envelope);
  if (derived.readyItemId !== envelope.readyItem.id || derived.workKey !== operation.workKey
    || derived.generationKey !== operation.generationKey
    || derived.operationId !== operation.operationId) fail('OperationIdentityMismatch');
  if (operation.state !== 'EFFECT_AMBIGUOUS') fail('OperationNotAmbiguous');
  return {
    operationId: operation.operationId, workKey: operation.workKey,
    generationKey: operation.generationKey, committedRevision: operation.committedRevision,
    envelope,
  };
}

function validateCandidateRow(value, headRef) {
  const code = 'InvalidLookup';
  const row = fields(value, CANDIDATE_KEYS, code);
  const owner = fields(row.headRepositoryOwner, ['id', 'login'], code);
  if (!Number.isSafeInteger(row.number) || row.number <= 0
    || typeof row.url !== 'string' || typeof row.isDraft !== 'boolean'
    || !PULL_REQUEST_STATES.has(row.state) || typeof row.baseRefName !== 'string'
    || typeof row.headRefOid !== 'string' || typeof row.body !== 'string'
    || typeof owner.id !== 'string' || typeof owner.login !== 'string') fail(code);
  // `gh pr list --head` returns only this head; a row on another head is not that search.
  if (row.headRefName !== headRef) fail(code);
  return { ...row, headRepositoryOwner: owner };
}

/**
 * The saved search, in the provider's order: the ambiguous revision it was run after, the
 * repository identity it checked, then every pull request on the head in every state.
 */
function validateLookup(value) {
  const code = 'InvalidLookup';
  const lookup = fields(value, [
    'schema', 'committedRevision', 'repository', 'repositoryCheck', 'headRef', 'marker', 'search',
    'observedAt', 'outcome', 'candidates',
  ], code);
  if (lookup.schema !== 'GaiaDraftMarkerLookupV0' || !LOOKUP_OUTCOMES.has(lookup.outcome)) fail(code);
  const search = fields(lookup.search, ['state', 'limit'], code);
  if (search.state !== 'all' || search.limit !== PROVIDER_SEARCH_LIMIT) fail(code);
  const headRef = branch(lookup.headRef, code);
  const rows = items(lookup.candidates, PROVIDER_SEARCH_LIMIT, code);
  let repositoryCheck = null;
  if (lookup.repositoryCheck !== null) {
    const check = fields(lookup.repositoryCheck, ['id', 'nameWithOwner'], code);
    repositoryCheck = { id: text(check.id, code), nameWithOwner: text(check.nameWithOwner, code) };
  }
  // Only a search that failed may lack the identity check, and a failed search holds no rows.
  if (lookup.outcome === 'ERRORED' ? rows.length !== 0 : repositoryCheck === null) fail(code);
  return {
    schema: lookup.schema,
    committedRevision: pattern(lookup.committedRevision, SHA256, code),
    repository: repository(lookup.repository, code),
    repositoryCheck,
    headRef,
    marker: pattern(lookup.marker, SHA256, code),
    search: { state: 'all', limit: PROVIDER_SEARCH_LIMIT },
    observedAt: instant(lookup.observedAt, code),
    outcome: lookup.outcome,
    candidates: rows.map((row) => validateCandidateRow(row, headRef)),
  };
}

function markerLine(marker) {
  return `<!-- gaia-operation:${marker} -->`;
}

// The provider's own rule: the marker line appears exactly once, as a whole line.
function carriesMarker(body, marker) {
  return body.split(/\r?\n/u).filter((line) => line === markerLine(marker)).length === 1;
}

// What reconcileDraft adopts without merge evidence: the one open Draft this generation created.
function adoptable(row, envelope) {
  const { repository: expected, generation } = envelope;
  const match = PULL_REQUEST_URL.exec(row.url);
  return match !== null && Number(match[3]) === row.number
    && match[1] === expected.owner && match[2] === expected.name
    && row.isDraft === true && row.state === 'OPEN'
    && row.baseRefName === generation.baseRef && row.headRefName === generation.headRef
    && row.headRefOid === generation.headRevision
    && row.headRepositoryOwner.id.length > 0
    && row.headRepositoryOwner.login === expected.owner;
}

function decide(operation, lookup) {
  if (lookup.outcome === 'ERRORED') return { decision: 'STAY_UNSETTLED', reason: 'LookupErrored' };
  if (lookup.outcome === 'PARTIAL') return { decision: 'STAY_UNSETTLED', reason: 'LookupPartial' };
  // A page as long as its limit may have left pull requests behind.
  if (lookup.candidates.length >= lookup.search.limit) {
    return { decision: 'STAY_UNSETTLED', reason: 'LookupTruncated' };
  }
  if (lookup.candidates.length === 0) {
    return { decision: 'SETTLE_ABANDONED', reason: 'MarkerProvablyAbsent' };
  }
  if (lookup.candidates.length > 1) {
    return { decision: 'STAY_UNSETTLED', reason: 'SeveralPullRequestsOnHead' };
  }
  const [row] = lookup.candidates;
  if (!carriesMarker(row.body, operation.operationId)) {
    return { decision: 'STAY_UNSETTLED', reason: 'UnmarkedPullRequestOnHead', row };
  }
  // A merged, closed or moved Draft is reconcileDraft's to judge with its own reads, not ours.
  if (!adoptable(row, operation.envelope)) {
    return { decision: 'STAY_UNSETTLED', reason: 'MarkedPullRequestNotAdoptable', row };
  }
  return { decision: 'SETTLE_REUSED', reason: 'MarkedDraftFound', row };
}

/**
 * Decide what one ambiguous operation's saved marker lookup proves.
 *
 * Returns `{ decision, reason, evidence }`, deep-frozen. `evidence` is the record a settlement
 * would carry: the operation, its generation and the revision it applies to, the lookup's own
 * content revision, identity check and bounds, the pull request found (if any), and its own
 * content revision. Throws AmbiguitySettlementError with a named code when the inputs do not
 * describe one ambiguous operation and a lookup of exactly its marker, head and repository, run
 * after reading it at the revision it is decided at.
 */
export function decideAmbiguousSettlement(input) {
  const given = fields(input, ['operation', 'lookup'], 'InvalidSettlementInput');
  const operation = validateOperation(given.operation);
  const lookup = validateLookup(given.lookup);
  if (lookup.marker !== operation.operationId) fail('LookupMarkerMismatch');
  const { repository: expected, generation } = operation.envelope;
  if (lookup.headRef !== generation.headRef || canonical(lookup.repository) !== canonical(expected)
    || (lookup.repositoryCheck !== null && (lookup.repositoryCheck.id !== expected.nodeId
      || lookup.repositoryCheck.nameWithOwner !== `${expected.owner}/${expected.name}`))) {
    fail('LookupScopeMismatch');
  }
  // A search from before the ambiguity proves nothing about it: the lookup names the revision the
  // operation was read at before searching, and it must be the revision decided at.
  if (lookup.committedRevision !== operation.committedRevision) fail('LookupRevisionMismatch');
  const { decision, reason, row = null } = decide(operation, lookup);
  const record = {
    schema: 'GaiaDraftAmbiguitySettlementV0',
    decision,
    reason,
    operationId: operation.operationId,
    workKey: operation.workKey,
    generationKey: operation.generationKey,
    committedRevision: operation.committedRevision,
    repository: expected,
    workItem: operation.envelope.workItem,
    generation,
    lookup: {
      revision: contentRevision(lookup),
      repositoryCheck: lookup.repositoryCheck,
      headRef: lookup.headRef,
      search: lookup.search,
      observedAt: lookup.observedAt,
      outcome: lookup.outcome,
      candidateCount: lookup.candidates.length,
    },
    pullRequest: row === null ? null : {
      number: row.number, url: row.url, state: row.state, isDraft: row.isDraft,
      headRevision: row.headRefOid,
    },
    effect: 'NONE',
    authority: 'NONE',
  };
  const evidence = { ...record, revision: contentRevision(record) };
  return deepFreeze({ decision, reason, evidence: structuredClone(evidence) });
}

/** A deep copy of plain JSON data, refusing anything else: what is compared is what was stored. */
function plainData(value, code, depth = 0) {
  if (depth > 8) fail(code);
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) {
    return items(value, PROVIDER_SEARCH_LIMIT, code).map((item) => plainData(item, code, depth + 1));
  }
  if (typeof value !== 'object') fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) fail(code);
  const copy = fields(value, keys, code);
  return Object.fromEntries(keys.map((key) => [key, plainData(copy[key], code, depth + 1)]));
}

// The V0 abandonment's search, pinned: a stored record is re-read by every later version of this
// module, so a change to the provider's bound must not turn old records into corruption.
const ABANDONMENT_V0_SEARCH = Object.freeze({ state: 'all', limit: 100 });

/**
 * An abandonment read back from the ledger, checked against the operation it settles.
 *
 * The ledger stores the evidence decideAmbiguousSettlement returned for SETTLE_ABANDONED. Every
 * field of it but the lookup's instant is fixed by the operation (identity, scope, generation, the
 * ambiguous revision it settles) or by what an abandonment requires of its lookup (complete,
 * identity-checked, no pull request, the V0 bound). Even the lookup is: an empty search of this
 * operation differs from any other only by when it ran. So the lookup and the record are rebuilt
 * from those, both re-hashed, and the record compared whole with what was stored: a record that
 * disagrees anywhere, or that was written for another operation or another revision, is refused.
 *
 * This is a consistency check of what the ledger holds, not a proof that a search ran: whoever can
 * write the ledger can write a consistent record. The ledger's one writer is the pump App.
 *
 * Takes `{ operation, evidence }`, the operation in decideAmbiguousSettlement's shape. Returns the
 * evidence, deep-frozen, or throws AmbiguitySettlementError.
 */
export function validateAbandonmentEvidence(input) {
  const given = fields(input, ['operation', 'evidence'], 'InvalidSettlementInput');
  const operation = validateOperation(given.operation);
  const code = 'InvalidSettlementEvidence';
  const stored = plainData(given.evidence, code);
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) fail(code);
  const lookup = stored.lookup;
  if (lookup === null || typeof lookup !== 'object' || Array.isArray(lookup)) fail(code);
  const { repository: expected, generation, workItem } = operation.envelope;
  const observedAt = instant(lookup.observedAt, code);
  const repositoryCheck = { id: expected.nodeId, nameWithOwner: `${expected.owner}/${expected.name}` };
  const searched = {
    schema: 'GaiaDraftMarkerLookupV0',
    committedRevision: operation.committedRevision,
    repository: expected,
    repositoryCheck,
    headRef: generation.headRef,
    marker: operation.operationId,
    search: ABANDONMENT_V0_SEARCH,
    observedAt,
    outcome: 'COMPLETE',
    candidates: [],
  };
  const record = {
    schema: 'GaiaDraftAmbiguitySettlementV0',
    decision: 'SETTLE_ABANDONED',
    reason: 'MarkerProvablyAbsent',
    operationId: operation.operationId,
    workKey: operation.workKey,
    generationKey: operation.generationKey,
    committedRevision: operation.committedRevision,
    repository: expected,
    workItem,
    generation,
    lookup: {
      revision: contentRevision(searched),
      repositoryCheck,
      headRef: generation.headRef,
      search: ABANDONMENT_V0_SEARCH,
      observedAt,
      outcome: 'COMPLETE',
      candidateCount: 0,
    },
    pullRequest: null,
    effect: 'NONE',
    authority: 'NONE',
  };
  const evidence = { ...record, revision: contentRevision(record) };
  if (canonical(stored) !== canonical(evidence)) fail(code);
  return deepFreeze(structuredClone(evidence));
}
