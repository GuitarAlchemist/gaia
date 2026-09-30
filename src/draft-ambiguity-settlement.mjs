/**
 * Lookup-only settlement decision for one EFFECT_AMBIGUOUS Draft operation (Gaia issue #176).
 *
 * An ambiguous operation's only exit today is REUSED, which reconcileDraft takes when its exact
 * marker lookup finds the Draft. When the lookup finds nothing, the operation stays pending for
 * ever, because nothing tells "found nothing" apart from "searched badly". This module makes that
 * call from a saved lookup, and only that call: it reads no network, no clock and no ledger, and
 * it never creates, retries or cancels an effect. Writing a settlement is #161's operator path.
 *
 * The lookup is the search the Draft provider itself runs (src/gh-draft-operation-provider.mjs):
 * every pull request on the operation's head branch, in every state, as `gh pr list --json` rows.
 * The provider creates a Draft only on that head, a pull request's head branch never changes, and
 * a pull request is never deleted. So a complete, untruncated search that returns no pull request
 * proves the Draft absent. Anything short of that stays unsettled.
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
const SEARCH_LIMIT_MAXIMUM = 1000;
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

function exactKeys(value, expected, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string'
    || !expected.includes(key))) fail(code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
  }
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
  exactKeys(value, ['nodeId', 'owner', 'name'], code);
  const owner = text(value.owner, code);
  const name = text(value.name, code);
  if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) fail(code);
  return { nodeId: text(value.nodeId, code), owner, name };
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

/** The operation as the ledger holds it: its identity, its revision, and the provider request. */
function validateOperation(value) {
  const code = 'InvalidOperation';
  exactKeys(value, ['operationId', 'workKey', 'committedRevision', 'state', 'request'], code);
  const operationId = pattern(value.operationId, SHA256, code);
  const workKey = pattern(value.workKey, SHA256, code);
  const committedRevision = pattern(value.committedRevision, SHA256, code);
  if (typeof value.state !== 'string') fail(code);
  exactKeys(value.request, [
    'repository', 'baseRef', 'headRef', 'headRevision', 'operationMarker', 'workItem',
  ], code);
  const { request } = value;
  exactKeys(request.workItem, ['kind', 'number'], code);
  if (request.workItem.kind !== 'ISSUE' || !Number.isSafeInteger(request.workItem.number)
    || request.workItem.number <= 0) fail(code);
  // The envelope marks its Draft with its own operation id; any other marker is not this operation.
  if (request.operationMarker !== operationId) fail(code);
  const operation = {
    operationId, workKey, committedRevision, state: value.state,
    request: {
      repository: repository(request.repository, code),
      baseRef: branch(request.baseRef, code),
      headRef: branch(request.headRef, code),
      headRevision: pattern(request.headRevision, GIT_OID, code),
      operationMarker: operationId,
      workItem: { kind: 'ISSUE', number: request.workItem.number },
    },
  };
  if (operation.state !== 'EFFECT_AMBIGUOUS') fail('OperationNotAmbiguous');
  return operation;
}

function validateCandidateRow(row, headRef) {
  const code = 'InvalidLookup';
  exactKeys(row, CANDIDATE_KEYS, code);
  exactKeys(row.headRepositoryOwner, ['id', 'login'], code);
  if (!Number.isSafeInteger(row.number) || row.number <= 0
    || typeof row.url !== 'string' || typeof row.isDraft !== 'boolean'
    || !PULL_REQUEST_STATES.has(row.state) || typeof row.baseRefName !== 'string'
    || typeof row.headRefOid !== 'string' || typeof row.body !== 'string'
    || typeof row.headRepositoryOwner.id !== 'string'
    || typeof row.headRepositoryOwner.login !== 'string') fail(code);
  // `gh pr list --head` returns only this head; a row on another head is not that search.
  if (row.headRefName !== headRef) fail(code);
  return row;
}

/** The saved search: every pull request on the head branch, in every state, and how it ended. */
function validateLookup(value) {
  const code = 'InvalidLookup';
  exactKeys(value, [
    'schema', 'repository', 'headRef', 'marker', 'search', 'observedAt', 'outcome', 'candidates',
  ], code);
  if (value.schema !== 'GaiaDraftMarkerLookupV0') fail(code);
  exactKeys(value.search, ['state', 'limit'], code);
  if (value.search.state !== 'all' || !Number.isSafeInteger(value.search.limit)
    || value.search.limit < 1 || value.search.limit > SEARCH_LIMIT_MAXIMUM) fail(code);
  if (!LOOKUP_OUTCOMES.has(value.outcome) || !Array.isArray(value.candidates)) fail(code);
  const headRef = branch(value.headRef, code);
  if (value.outcome === 'ERRORED' && value.candidates.length !== 0) fail(code);
  return {
    repository: repository(value.repository, code),
    headRef,
    marker: pattern(value.marker, SHA256, code),
    search: { state: 'all', limit: value.search.limit },
    observedAt: instant(value.observedAt, code),
    outcome: value.outcome,
    candidates: value.candidates.map((row) => validateCandidateRow(row, headRef)),
  };
}

function markerLine(marker) {
  return `<!-- gaia-operation:${marker} -->`;
}

// The provider's own rule: the marker line appears exactly once, as a whole line.
function carriesMarker(body, marker) {
  return body.split(/\r?\n/u).filter((line) => line === markerLine(marker)).length === 1;
}

// What reconcileDraft adopts without merge evidence: the one open Draft this request created.
function adoptable(row, request) {
  const match = PULL_REQUEST_URL.exec(row.url);
  return match !== null && Number(match[3]) === row.number
    && match[1] === request.repository.owner && match[2] === request.repository.name
    && row.isDraft === true && row.state === 'OPEN'
    && row.baseRefName === request.baseRef && row.headRefName === request.headRef
    && row.headRefOid === request.headRevision
    && row.headRepositoryOwner.id.length > 0
    && row.headRepositoryOwner.login === request.repository.owner;
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
  if (!adoptable(row, operation.request)) {
    return { decision: 'STAY_UNSETTLED', reason: 'MarkedPullRequestNotAdoptable', row };
  }
  return { decision: 'SETTLE_REUSED', reason: 'MarkedDraftFound', row };
}

/**
 * Decide what one ambiguous operation's saved marker lookup proves.
 *
 * Returns `{ decision, reason, evidence }`, deep-frozen. `evidence` is the record a settlement
 * would carry: the operation and revision it applies to, the lookup's own content revision and
 * bounds, the pull request found (if any), and its own content revision. Throws
 * AmbiguitySettlementError with a named code when the inputs do not describe one ambiguous
 * operation and a lookup of exactly its marker, head and repository.
 */
export function decideAmbiguousSettlement(input) {
  exactKeys(input, ['operation', 'lookup'], 'InvalidSettlementInput');
  const operation = validateOperation(input.operation);
  const lookup = validateLookup(input.lookup);
  if (lookup.marker !== operation.operationId) fail('LookupMarkerMismatch');
  if (lookup.headRef !== operation.request.headRef
    || canonical(lookup.repository) !== canonical(operation.request.repository)) {
    fail('LookupScopeMismatch');
  }
  const { decision, reason, row = null } = decide(operation, lookup);
  const record = {
    schema: 'GaiaDraftAmbiguitySettlementV0',
    decision,
    reason,
    operationId: operation.operationId,
    workKey: operation.workKey,
    committedRevision: operation.committedRevision,
    workItem: operation.request.workItem,
    lookup: {
      revision: contentRevision(input.lookup),
      repository: lookup.repository,
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
