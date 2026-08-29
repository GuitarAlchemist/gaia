/**
 * Authority-free tracer bullet for the selected remote exact-intent authority Seam.
 *
 * This Module proves rematerialization, expiry, executor binding and one-use consumption
 * mechanics. It deliberately cannot authorize factory execution: every receipt says
 * effect=NONE, authority=NONE and executionAuthorized=false.
 */

import { createHash } from 'node:crypto';

export class RemoteAuthorityPrototypeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemoteAuthorityPrototypeError';
    this.code = code;
  }
}

const MEASUREMENT_KEYS = [
  'action', 'intentRevision', 'itemId', 'itemKind', 'itemNumber', 'portfolioRevision',
  'repository', 'revision', 'schema', 'snapshotRevision', 'task',
];
const BINDING_KEYS = ['algorithm', 'nonce', 'publicKey', 'schema', 'thumbprint'];
const APPROVAL_KEYS = [
  'approvalId', 'approvedAt', 'authorityMethod', 'executorThumbprint', 'expiresAt',
  'intentRevision', 'requestRevision', 'schema', 'status',
];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function exactObject(value, keys, label) {
  const ownKeys = value && typeof value === 'object' ? Reflect.ownKeys(value) : [];
  const descriptors = value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptors(value)
    : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || ownKeys.some((key) => typeof key !== 'string')
      || JSON.stringify([...ownKeys].sort()) !== JSON.stringify([...keys].sort())
      || ownKeys.some((key) => !descriptors[key]?.enumerable
        || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new RemoteAuthorityPrototypeError(
      'InvalidSchema', `${label} must contain exactly its closed schema fields`,
    );
  }
}

function text(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new RemoteAuthorityPrototypeError('InvalidSchema', `${field} must be canonical text`);
  }
  return value;
}

function digest(value, field) {
  const result = text(value, field);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw new RemoteAuthorityPrototypeError('InvalidSchema', `${field} must be a SHA-256`);
  }
  return result;
}

function timestamp(value, field) {
  const result = text(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)
      || Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new RemoteAuthorityPrototypeError(
      'InvalidSchema', `${field} must be canonical UTC milliseconds`,
    );
  }
  return result;
}

function ownMeasurement(input) {
  exactObject(input, MEASUREMENT_KEYS, 'measurement');
  if (input.schema !== 'gaia-exact-intent-measurement/1') {
    throw new RemoteAuthorityPrototypeError('InvalidSchema', 'measurement schema is unsupported');
  }
  if (!Number.isSafeInteger(input.itemNumber) || input.itemNumber < 1) {
    throw new RemoteAuthorityPrototypeError('InvalidSchema', 'itemNumber must be positive');
  }
  const body = {
    schema: input.schema,
    portfolioRevision: digest(input.portfolioRevision, 'portfolioRevision'),
    snapshotRevision: digest(input.snapshotRevision, 'snapshotRevision'),
    intentRevision: digest(input.intentRevision, 'intentRevision'),
    action: text(input.action, 'action'),
    repository: text(input.repository, 'repository'),
    itemKind: text(input.itemKind, 'itemKind'),
    itemId: text(input.itemId, 'itemId'),
    itemNumber: input.itemNumber,
    task: text(input.task, 'task'),
  };
  if (digest(input.revision, 'revision') !== sha256(canonicalJson(body))) {
    throw new RemoteAuthorityPrototypeError('DigestMismatch', 'measurement revision is invalid');
  }
  return { ...body, revision: input.revision };
}

function ownBinding(input) {
  exactObject(input, BINDING_KEYS, 'executionBinding');
  if (input.schema !== 'gaia-ephemeral-executor-binding/1' || input.algorithm !== 'Ed25519') {
    throw new RemoteAuthorityPrototypeError('InvalidSchema', 'executor binding is unsupported');
  }
  const nonce = text(input.nonce, 'nonce');
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(nonce)) {
    throw new RemoteAuthorityPrototypeError('InvalidSchema', 'nonce must be bounded base64url');
  }
  return {
    schema: input.schema,
    algorithm: input.algorithm,
    publicKey: text(input.publicKey, 'publicKey'),
    thumbprint: digest(input.thumbprint, 'thumbprint'),
    nonce,
  };
}

function ownApproval(input) {
  exactObject(input, APPROVAL_KEYS, 'approval');
  if (input.schema !== 'gaia-remote-human-approval/1' || input.status !== 'APPROVED'
      || input.authorityMethod !== 'remote-passkey') {
    throw new RemoteAuthorityPrototypeError('ApprovalRefused', 'approval was not explicit');
  }
  return {
    schema: input.schema,
    status: input.status,
    approvalId: text(input.approvalId, 'approvalId'),
    requestRevision: digest(input.requestRevision, 'requestRevision'),
    intentRevision: digest(input.intentRevision, 'intentRevision'),
    executorThumbprint: digest(input.executorThumbprint, 'executorThumbprint'),
    authorityMethod: input.authorityMethod,
    approvedAt: timestamp(input.approvedAt, 'approvedAt'),
    expiresAt: timestamp(input.expiresAt, 'expiresAt'),
  };
}

function validNow(now) {
  const result = now();
  if (!(result instanceof Date) || Number.isNaN(result.valueOf())) {
    throw new RemoteAuthorityPrototypeError('ClockInvalid', 'clock returned an invalid date');
  }
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/**
 * Build the authority-free in-memory Adapter used to test the selected remote Seam.
 */
export function createRemoteExactIntentAuthorityPrototype({
  remeasureIntent, requestHumanApproval, now = () => new Date(),
} = {}) {
  if (typeof remeasureIntent !== 'function' || typeof requestHumanApproval !== 'function'
      || typeof now !== 'function') {
    throw new TypeError('remeasureIntent, requestHumanApproval, and now must be functions');
  }
  const consumedApprovalIds = new Set();

  return Object.freeze({
    async consumeExactIntent(input) {
      exactObject(input, ['executionBinding', 'measurement'], 'consumeExactIntent input');
      const measured = ownMeasurement(input.measurement);
      const executor = ownBinding(input.executionBinding);
      const independentlyMeasured = ownMeasurement(await remeasureIntent({
        portfolioRevision: measured.portfolioRevision,
        repository: measured.repository,
      }));
      if (canonicalJson(independentlyMeasured) !== canonicalJson(measured)) {
        throw new RemoteAuthorityPrototypeError(
          'IntentMismatch', 'independent intent measurement does not match',
        );
      }

      const requestBody = {
        schema: 'gaia-remote-authority-prototype-request/1',
        effect: 'NONE',
        authority: 'NONE',
        prototypeOnly: true,
        measurement: measured,
        executionBinding: executor,
      };
      const request = deepFreeze({
        ...requestBody, revision: sha256(canonicalJson(requestBody)),
      });
      const approval = ownApproval(await requestHumanApproval(request));
      if (approval.requestRevision !== request.revision
          || approval.intentRevision !== measured.intentRevision) {
        throw new RemoteAuthorityPrototypeError(
          'ChallengeMismatch', 'approval does not bind this exact request',
        );
      }
      if (approval.executorThumbprint !== executor.thumbprint) {
        throw new RemoteAuthorityPrototypeError(
          'ExecutorBindingMismatch', 'approval names another executor',
        );
      }
      if (Date.parse(approval.approvedAt) >= Date.parse(approval.expiresAt)
          || validNow(now).valueOf() >= Date.parse(approval.expiresAt)) {
        throw new RemoteAuthorityPrototypeError('RequestExpired', 'approval has expired');
      }

      // No await occurs between this check and add. Within this in-memory Adapter the transition
      // is one atomic JavaScript turn, which is the prototype stand-in for a transactional CAS.
      if (consumedApprovalIds.has(approval.approvalId)) {
        throw new RemoteAuthorityPrototypeError('AlreadyConsumed', 'approval was already consumed');
      }
      consumedApprovalIds.add(approval.approvalId);

      const receiptBody = {
        schema: 'gaia-remote-authority-prototype-consumption/1',
        status: 'CONSUMED',
        effect: 'NONE',
        authority: 'NONE',
        executionAuthorized: false,
        prototypeOnly: true,
        approvalIdHash: sha256(approval.approvalId),
        requestRevision: request.revision,
        intentRevision: measured.intentRevision,
        executorThumbprint: executor.thumbprint,
        authorityMethod: approval.authorityMethod,
        approvedAt: approval.approvedAt,
        consumedAt: validNow(now).toISOString(),
        expiresAt: approval.expiresAt,
      };
      return deepFreeze({
        ...receiptBody, revision: sha256(canonicalJson(receiptBody)),
      });
    },
  });
}

