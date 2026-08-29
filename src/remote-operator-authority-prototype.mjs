/**
 * Authority-free tracer bullet for the selected remote exact-intent authority Seam.
 *
 * This Module proves rematerialization, expiry, executor binding and one-use consumption
 * mechanics. It deliberately cannot authorize factory execution: every receipt says
 * effect=NONE, authority=NONE and executionAuthorized=false.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';

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
const MAX_APPROVAL_TTL_MS = 5 * 60 * 1000;

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
  const publicKeyText = text(input.publicKey, 'publicKey');
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyText);
  } catch {
    throw new RemoteAuthorityPrototypeError(
      'InvalidSchema', 'publicKey must be an Ed25519 public key',
    );
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new RemoteAuthorityPrototypeError(
      'InvalidSchema', 'publicKey must be an Ed25519 public key',
    );
  }
  const canonicalPublicKey = publicKey.export({ format: 'pem', type: 'spki' }).toString().trim();
  if (publicKeyText !== canonicalPublicKey) {
    throw new RemoteAuthorityPrototypeError(
      'InvalidSchema', 'publicKey must be canonical SPKI public-key PEM',
    );
  }
  const derivedThumbprint = sha256(publicKey.export({ format: 'der', type: 'spki' }));
  if (digest(input.thumbprint, 'thumbprint') !== derivedThumbprint) {
    throw new RemoteAuthorityPrototypeError(
      'ExecutorBindingMismatch', 'executor thumbprint does not identify its public key',
    );
  }
  return {
    binding: {
      schema: input.schema,
      algorithm: input.algorithm,
      publicKey: publicKeyText,
      thumbprint: derivedThumbprint,
      nonce,
    },
    publicKey,
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
  remeasureIntent, requestHumanApproval, proveExecutorPossession, now = () => new Date(),
} = {}) {
  if (typeof remeasureIntent !== 'function' || typeof requestHumanApproval !== 'function'
      || typeof proveExecutorPossession !== 'function' || typeof now !== 'function') {
    throw new TypeError(
      'remeasureIntent, requestHumanApproval, proveExecutorPossession, and now must be functions',
    );
  }
  const consumedApprovalIds = new Set();

  return Object.freeze({
    async consumeExactIntent(input) {
      exactObject(input, ['executionBinding', 'measurement'], 'consumeExactIntent input');
      const measured = ownMeasurement(input.measurement);
      const { binding: executor, publicKey: executorPublicKey } = ownBinding(
        input.executionBinding,
      );
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

      const proofChallenge = deepFreeze({
        schema: 'gaia-ephemeral-executor-proof-challenge/1',
        approvalIdHash: sha256(approval.approvalId),
        requestRevision: request.revision,
        intentRevision: measured.intentRevision,
        executorThumbprint: executor.thumbprint,
        nonce: executor.nonce,
      });
      const proofText = text(
        await proveExecutorPossession(proofChallenge), 'executorProof',
      );
      if (!/^[A-Za-z0-9_-]{86}$/u.test(proofText)
          || !verify(
            null,
            Buffer.from(canonicalJson(proofChallenge)),
            executorPublicKey,
            Buffer.from(proofText, 'base64url'),
          )) {
        throw new RemoteAuthorityPrototypeError(
          'ExecutorBindingMismatch', 'executor did not prove possession of its private key',
        );
      }

      const observedNow = validNow(now);
      const approvedAt = Date.parse(approval.approvedAt);
      const expiresAt = Date.parse(approval.expiresAt);
      if (approvedAt >= expiresAt || expiresAt - approvedAt > MAX_APPROVAL_TTL_MS
          || observedNow.valueOf() < approvedAt) {
        throw new RemoteAuthorityPrototypeError(
          'ApprovalWindowInvalid', 'approval time window is invalid',
        );
      }
      if (observedNow.valueOf() >= expiresAt) {
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
        consumedAt: observedNow.toISOString(),
        expiresAt: approval.expiresAt,
      };
      return deepFreeze({
        ...receiptBody, revision: sha256(canonicalJson(receiptBody)),
      });
    },
  });
}
