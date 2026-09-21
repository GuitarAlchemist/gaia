import { createHash } from 'node:crypto';

export const PORTABLE_RECEIPT_SCHEMA = 'continuity.successor-transition-receipt/1';
const DIGEST = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[!-~]{1,128}$/u;
const MEDIA_TYPE = /^[ -~]{1,128}$/u;

export class ContinuityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ContinuityError';
    this.code = code;
  }
}

export const refuse = code => { throw new ContinuityError(code); };

function encodeString(value) {
  let result = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) refuse('INVALID_CANONICAL_VALUE');
    if (code === 0x22) result += '\\"';
    else if (code === 0x5c) result += '\\\\';
    else if (code < 0x20) result += `\\u${code.toString(16).padStart(4, '0')}`;
    else result += value[index];
  }
  return `${result}"`;
}

function encode(value, depth) {
  if (depth > 8) refuse('INVALID_CANONICAL_VALUE');
  if (value === null) return 'null';
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) refuse('INVALID_CANONICAL_VALUE');
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 16) refuse('INVALID_CANONICAL_VALUE');
    return `[${value.map(item => encode(item, depth + 1)).join(',')}]`;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    refuse('INVALID_CANONICAL_VALUE');
  }
  const keys = Object.keys(value);
  if (keys.length > 32) refuse('INVALID_CANONICAL_VALUE');
  for (const key of keys) {
    if (!IDENTIFIER.test(key) || value[key] === undefined) refuse('INVALID_CANONICAL_VALUE');
  }
  keys.sort((left, right) => Buffer.from(left, 'ascii').compare(Buffer.from(right, 'ascii')));
  return `{${keys.map(key => `${encodeString(key)}:${encode(value[key], depth + 1)}`).join(',')}}`;
}

export const canonicalContinuityJson = value => encode(value, 0);

export function digestContinuityValue(domain, value) {
  if (!IDENTIFIER.test(domain)) refuse('INVALID_CANONICAL_VALUE');
  return createHash('sha256').update(domain, 'ascii').update(Buffer.from([0]))
    .update(canonicalContinuityJson(value), 'utf8').digest('hex');
}

export function continuityRequestDigest(action, request) {
  return digestContinuityValue('continuity.operation-request/1', { action, request });
}

export function requireExactObjectKeys(value, keys, code = 'INVALID_REQUEST') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    refuse(code);
  }
}

const requireDigest = value => {
  if (typeof value !== 'string' || !DIGEST.test(value)) refuse('INVALID_PORTABLE_RECEIPT');
};
const requireIdentifier = value => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) refuse('INVALID_PORTABLE_RECEIPT');
};

export function portableReceiptDigest(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    refuse('INVALID_PORTABLE_RECEIPT');
  }
  const projection = { ...receipt };
  delete projection.receiptDigest;
  return digestContinuityValue(PORTABLE_RECEIPT_SCHEMA, projection);
}

export function validatePortableReceipt(receipt) {
  try {
    requireExactObjectKeys(receipt, ['schema', 'workIdentity', 'workGeneration', 'successorSlot',
      'successor', 'commitmentDigest', 'incomingReviewDigest', 'decisionDigest', 'decision',
      'outputArtifact', 'consumptionDigest', 'consumption', 'authority', 'receiptDigest'],
    'INVALID_PORTABLE_RECEIPT');
    if (receipt.schema !== PORTABLE_RECEIPT_SCHEMA || receipt.workGeneration !== 0
      || receipt.successorSlot !== 'review-successor'
      || receipt.decision !== 'ACCEPTED_FOR_NEXT_STAGE') refuse('INVALID_PORTABLE_RECEIPT');
    for (const value of [receipt.workIdentity, receipt.commitmentDigest,
      receipt.incomingReviewDigest, receipt.decisionDigest, receipt.consumptionDigest,
      receipt.receiptDigest]) requireDigest(value);

    requireExactObjectKeys(receipt.successor, ['actorRef', 'sessionRef', 'sessionGeneration'],
      'INVALID_PORTABLE_RECEIPT');
    requireIdentifier(receipt.successor.actorRef);
    requireIdentifier(receipt.successor.sessionRef);
    if (receipt.successor.sessionGeneration !== 1) refuse('INVALID_PORTABLE_RECEIPT');

    requireExactObjectKeys(receipt.outputArtifact, ['mediaType', 'sha256', 'bytes'],
      'INVALID_PORTABLE_RECEIPT');
    if (typeof receipt.outputArtifact.mediaType !== 'string'
      || !MEDIA_TYPE.test(receipt.outputArtifact.mediaType)) refuse('INVALID_PORTABLE_RECEIPT');
    requireDigest(receipt.outputArtifact.sha256);
    if (!Number.isSafeInteger(receipt.outputArtifact.bytes)
      || receipt.outputArtifact.bytes < 1 || receipt.outputArtifact.bytes > 65_536) {
      refuse('INVALID_PORTABLE_RECEIPT');
    }

    requireExactObjectKeys(receipt.consumption, ['consumerIdentity', 'consumedAtRef', 'ordinal'],
      'INVALID_PORTABLE_RECEIPT');
    requireIdentifier(receipt.consumption.consumerIdentity);
    requireDigest(receipt.consumption.consumedAtRef);
    if (receipt.consumption.ordinal !== 0) refuse('INVALID_PORTABLE_RECEIPT');
    requireExactObjectKeys(receipt.authority, ['effects'], 'INVALID_PORTABLE_RECEIPT');
    if (!Array.isArray(receipt.authority.effects) || receipt.authority.effects.length !== 0) {
      refuse('INVALID_PORTABLE_RECEIPT');
    }
    canonicalContinuityJson(receipt);
    if (portableReceiptDigest(receipt) !== receipt.receiptDigest) refuse('INVALID_PORTABLE_RECEIPT');
    return receipt;
  } catch (error) {
    if (error instanceof ContinuityError && error.code === 'INVALID_PORTABLE_RECEIPT') throw error;
    refuse('INVALID_PORTABLE_RECEIPT');
  }
}

export const isContinuityDigest = value => typeof value === 'string' && DIGEST.test(value);
export const isContinuityIdentifier = value => typeof value === 'string' && IDENTIFIER.test(value);
export const isContinuityMediaType = value => typeof value === 'string' && MEDIA_TYPE.test(value);
