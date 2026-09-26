import { createHash } from 'node:crypto';

export class AutonomousFactoryContractError extends Error {
  constructor(code) { super(code); this.name = 'AutonomousFactoryContractError'; this.code = code; }
}
const fail = code => { throw new AutonomousFactoryContractError(code); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const repositoryName = value => typeof value === 'string'
  && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/u.test(value)
  && !['.', '..'].includes(value.split('/')[1]);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0
  && value.length <= max && value.trim() === value && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);

// Reject getters, prototypes, lossy JSON values and excessive evidence before
// serialization. The canonical form is shared with portfolio intent hashing.
function encode(value, code) {
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 100000 || depth > 64) fail(code);
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') { if (item.length > 4 * 1024 * 1024) fail(code); return JSON.stringify(item); }
    if (typeof item === 'number') { if (!Number.isFinite(item) || Object.is(item, -0)) fail(code); return JSON.stringify(item); }
    if (!item || typeof item !== 'object') fail(code);
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string' || (key !== 'length' || !array)
      && (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')))) fail(code);
    if (array) {
      if (item.length > 100000 || keys.length !== item.length + 1 || keys.some(key => key !== 'length'
        && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length))) fail(code);
      return `[${Array.from({ length: item.length }, (_, index) => visit(descriptors[index].value, depth + 1)).join(',')}]`;
    }
    return `{${keys.sort().map(key => `${JSON.stringify(key)}:${visit(descriptors[key].value, depth + 1)}`).join(',')}}`;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > 4 * 1024 * 1024) fail(code);
  return result;
}
function exact(value, keys, code) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(code);
}
function validateIntent(value) {
  const serialized = encode(value, 'InvalidIntent');
  if (serialized.length > 16384) fail('InvalidIntent');
  const intent = JSON.parse(serialized);
  exact(intent, ['action', 'repository', 'itemKind', 'itemId', 'itemNumber', 'draft', 'task',
    'evidenceState', 'snapshotRevision', 'requiredAuthority', 'intentRevision'], 'InvalidIntent');
  exact(intent.draft, ['number', 'headRef', 'headRevision'], 'InvalidIntent');
  if (intent.action !== 'RUN_FACTORY_AGENT' || intent.itemKind !== 'ISSUE'
    || intent.requiredAuthority !== 'FACTORY_RUN' || !repositoryName(intent.repository)
    || !text(intent.itemId, 256) || !/^[A-Za-z0-9_=-]+$/u.test(intent.itemId)
    || !positive(intent.itemNumber) || !positive(intent.draft.number)
    || !text(intent.draft.headRef, 1024) || /\s/u.test(intent.draft.headRef)
    || !/^[a-f0-9]{40}$/u.test(intent.draft.headRevision)
    || !text(intent.task, 8192) || !['READY', 'READY_WITH_UNKNOWN'].includes(intent.evidenceState)
    || !digest(intent.snapshotRevision) || !digest(intent.intentRevision)) fail('InvalidIntent');
  const { intentRevision, ...body } = intent;
  if (sha256(encode(body, 'InvalidIntent')) !== intentRevision) fail('InvalidIntent');
  return intent;
}
export function autonomousJobKey(value) {
  const intent = validateIntent(value);
  return sha256(encode({ repository: intent.repository.toLowerCase(), itemId: intent.itemId,
    draftNumber: intent.draft.number }, 'InvalidIntent'));
}
function validateJob(input) {
  const intent = validateIntent(input?.intent);
  if (!digest(input.jobKey) || !digest(input.idempotencyKey)
    || input.jobKey !== autonomousJobKey(intent)
    || input.idempotencyKey !== sha256(encode({ grantId: input.jobKey, intentRevision: intent.intentRevision }, 'InvalidJob'))) fail('InvalidJob');
  return { jobKey: input.jobKey, intent, idempotencyKey: input.idempotencyKey };
}
function validateEvidence(value, roles) {
  exact(value, ['bytes', 'mediaType', 'path', 'policy', 'role', 'sha256'], 'InvalidReceipt');
  if (!roles.includes(value.role) || !text(value.path) || !nonnegative(value.bytes)
    || !digest(value.sha256) || value.mediaType !== 'text/plain; charset=utf-8'
    || value.policy !== 'local-sensitive-content-addressed') fail('InvalidReceipt');
}
function validateWorker(value) {
  exact(value, ['authority', 'evidence', 'observedScope', 'provider', 'requestedScope'], 'InvalidReceipt');
  validateEvidence(value.evidence, ['worker']);
  if (!text(value.provider, 256) || value.authority !== 'host-user-process'
    || value.requestedScope !== 'linked-worktree-only'
    || value.observedScope !== 'git-candidate-and-worktree-tree') fail('InvalidReceipt');
}
function validateReviewer(value, evidenceRole) {
  exact(value, ['authority', 'evidence', 'provider', 'verifiedPostcondition', 'verdict'], 'InvalidReceipt');
  validateEvidence(value.evidence, [evidenceRole]);
  if (!text(value.provider, 256) || value.authority !== 'sandbox-requested-read-only'
    || value.verifiedPostcondition !== 'git-head-index-and-worktree-tree-unchanged'
    || !['APPROVE', 'REQUEST_CHANGES'].includes(value.verdict)) fail('InvalidReceipt');
}
function validateRepair(value, terminalIdentity) {
  exact(value, ['authority', 'evidence', 'initialCandidateIdentity', 'observedScope', 'provider',
    'repairedCandidateIdentity', 'requestedScope'], 'InvalidReceipt');
  validateEvidence(value.evidence, ['repair']);
  if (!text(value.provider, 256) || value.authority !== 'host-user-process'
    || value.requestedScope !== 'linked-worktree-only'
    || value.observedScope !== 'git-candidate-and-worktree-tree'
    || !digest(value.initialCandidateIdentity) || !digest(value.repairedCandidateIdentity)
    || value.initialCandidateIdentity === value.repairedCandidateIdentity
    || value.repairedCandidateIdentity !== terminalIdentity) fail('InvalidReceipt');
}
function validateChangeSet(value, head, noChange = false) {
  exact(value, ['baseHead', 'files', 'identity', 'patchBytes', 'patchSha256',
    'statusBytes', 'statusSha256'], 'InvalidReceipt');
  if (value.baseHead !== head || !nonnegative(value.statusBytes) || !digest(value.statusSha256)
    || !nonnegative(value.patchBytes) || !digest(value.patchSha256) || !digest(value.identity)
    || !Array.isArray(value.files) || (!noChange && value.files.length === 0)
    || value.files.length > 10000) fail('InvalidReceipt');
  if (noChange && (value.files.length !== 0 || value.statusBytes !== 0 || value.patchBytes !== 0
    || value.statusSha256 !== sha256('') || value.patchSha256 !== sha256(''))) fail('InvalidReceipt');
  const files = value.files.map(file => {
    exact(file, ['bytes', 'path', 'sha256', 'state'], 'InvalidReceipt');
    if (!text(file.path, 4096) || file.path.includes('\\') || file.path.startsWith('/')
      || file.path.split('/').some(part => part === '' || part === '.' || part === '..')
      || !['present', 'deleted'].includes(file.state) || !nonnegative(file.bytes)
      || (file.state === 'present' ? !digest(file.sha256) : file.sha256 !== null || file.bytes !== 0)) {
      fail('InvalidReceipt');
    }
    return { path: file.path, state: file.state, bytes: file.bytes, sha256: file.sha256 };
  });
  if (new Set(files.map(file => file.path)).size !== files.length
    || files.some((file, index) => index > 0 && files[index - 1].path >= file.path)) fail('InvalidReceipt');
  const body = { baseHead: value.baseHead, statusBytes: value.statusBytes,
    statusSha256: value.statusSha256, patchBytes: value.patchBytes,
    patchSha256: value.patchSha256, files };
  if (sha256(`${JSON.stringify(body)}\n`) !== value.identity) fail('InvalidReceipt');
}
function validateReceipt(value, job) {
  const serialized = encode(value, 'InvalidReceipt');
  const receipt = JSON.parse(serialized);
  if (receipt?.schema === 'gaia-autonomous-retirement/1') {
    exact(receipt, ['schema', 'status', 'jobKey', 'intentRevision', 'idempotencyKey', 'observation'], 'InvalidReceipt');
    if (receipt.status !== 'ABANDONED' || receipt.jobKey !== job.jobKey
      || receipt.intentRevision !== job.intent.intentRevision || receipt.idempotencyKey !== job.idempotencyKey) fail('InvalidReceipt');
    const observed = receipt.observation;
    exact(observed, ['repository', 'itemId', 'itemNumber', 'issueState', 'issueStateReason',
      'draftNumber', 'draftState', 'draftMerged', 'headRef', 'headRevision'], 'InvalidReceipt');
    if (observed.repository !== job.intent.repository || observed.itemId !== job.intent.itemId
      || observed.itemNumber !== job.intent.itemNumber || observed.issueState !== 'CLOSED'
      || observed.issueStateReason !== 'COMPLETED' || observed.draftNumber !== job.intent.draft.number
      || observed.draftState !== 'CLOSED' || observed.draftMerged !== false
      || observed.headRef !== job.intent.draft.headRef || observed.headRevision !== job.intent.draft.headRevision) fail('InvalidReceipt');
    return serialized;
  }
  exact(receipt, ['schema', 'status', 'jobKey', 'intentRevision', 'idempotencyKey', 'factory'], 'InvalidReceipt');
  const factory = receipt.factory;
  if (receipt.schema !== 'gaia-autonomous-factory-receipt/1'
    || !['CANDIDATE_READY', 'CANDIDATE_REJECTED', 'NO_CANDIDATE'].includes(receipt.status)
    || receipt.jobKey !== job.jobKey || receipt.intentRevision !== job.intent.intentRevision
    || receipt.idempotencyKey !== job.idempotencyKey || !factory || typeof factory !== 'object'
    || Array.isArray(factory) || factory.schema !== 'gaia-agent-factory-receipt/1'
    || factory.status !== (receipt.status === 'NO_CANDIDATE' ? 'no-change'
      : receipt.status === 'CANDIDATE_READY' ? 'completed' : 'rejected')
    || factory.task !== job.intent.task) fail('InvalidReceipt');
  const repaired = Object.hasOwn(factory, 'repair') || Object.hasOwn(factory, 'reviews');
  const noChange = receipt.status === 'NO_CANDIDATE';
  exact(factory, ['schema', 'status', 'task', 'base', 'worker', 'changeSet',
    ...(noChange ? ['reason'] : ['reviewer']),
    ...(repaired ? ['repair', 'reviews'] : [])], 'InvalidReceipt');
  exact(factory.base, ['executionBoundary', 'head', 'isolation'], 'InvalidReceipt');
  if (factory.base.head !== job.intent.draft.headRevision
    || factory.base.isolation !== 'caller-supplied-linked-git-worktree'
    || factory.base.executionBoundary !== 'host-user-process') fail('InvalidReceipt');
  validateWorker(factory.worker);
  validateChangeSet(factory.changeSet, factory.base.head, noChange);
  if (noChange) {
    if (repaired || factory.reason !== 'NoCandidateChange') fail('InvalidReceipt');
    return serialized;
  }
  if (!repaired) {
    validateReviewer(factory.reviewer, 'reviewer');
    if (factory.status !== 'completed' || factory.reviewer.verdict !== 'APPROVE') {
      fail('InvalidReceipt');
    }
    return serialized;
  }
  exact(factory.reviews, ['final', 'initial'], 'InvalidReceipt');
  validateRepair(factory.repair, factory.changeSet.identity);
  validateReviewer(factory.reviews.initial, 'reviewer');
  validateReviewer(factory.reviews.final, 'reviewer-final');
  validateReviewer(factory.reviewer, 'reviewer-final');
  if (factory.reviews.initial.verdict !== 'REQUEST_CHANGES'
    || encode(factory.reviewer, 'InvalidReceipt') !== encode(factory.reviews.final, 'InvalidReceipt')
    || factory.reviews.final.verdict
      !== (factory.status === 'completed' ? 'APPROVE' : 'REQUEST_CHANGES')) fail('InvalidReceipt');
  return serialized;
}

export {
  encode as canonicalAutonomousJson,
  digest as isAutonomousDigest,
  repositoryName as isAutonomousRepository,
  validateIntent as validateAutonomousIntent,
  validateJob as validateAutonomousJob,
  validateReceipt as validateAutonomousReceipt,
};
