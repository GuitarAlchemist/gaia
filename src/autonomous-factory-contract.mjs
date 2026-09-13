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
  return sha256(encode({ repository: intent.repository, itemId: intent.itemId, draftNumber: intent.draft.number }, 'InvalidIntent'));
}
function validateJob(input) {
  const intent = validateIntent(input?.intent);
  if (!digest(input.jobKey) || !digest(input.idempotencyKey)
    || input.jobKey !== autonomousJobKey(intent)
    || input.idempotencyKey !== sha256(encode({ grantId: input.jobKey, intentRevision: intent.intentRevision }, 'InvalidJob'))) fail('InvalidJob');
  return { jobKey: input.jobKey, intent, idempotencyKey: input.idempotencyKey };
}
function validateReceipt(value, job) {
  const serialized = encode(value, 'InvalidReceipt');
  const receipt = JSON.parse(serialized);
  exact(receipt, ['schema', 'status', 'jobKey', 'intentRevision', 'idempotencyKey', 'factory'], 'InvalidReceipt');
  if (receipt.schema !== 'gaia-autonomous-factory-receipt/1'
    || !['CANDIDATE_READY', 'CANDIDATE_REJECTED'].includes(receipt.status)
    || receipt.jobKey !== job.jobKey || receipt.intentRevision !== job.intent.intentRevision
    || receipt.idempotencyKey !== job.idempotencyKey
    || !receipt.factory || receipt.factory.schema !== 'gaia-agent-factory-receipt/1'
    || receipt.factory.status !== (receipt.status === 'CANDIDATE_READY' ? 'completed' : 'rejected')
    || receipt.factory.task !== job.intent.task
    || receipt.factory.base?.head !== job.intent.draft.headRevision
    || (receipt.factory.status === 'completed' && receipt.factory.reviewer?.verdict !== 'APPROVE')) fail('InvalidReceipt');
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
