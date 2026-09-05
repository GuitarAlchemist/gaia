import { createHash } from 'node:crypto';
import { validateManagedDraftConfiguration } from './pr-delivery-round-history.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const PRINCIPAL = /^github:(?:user|team):[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;

export class CanaryAdmissionError extends Error {
  constructor(code) { super(code); this.name = 'CanaryAdmissionError'; this.code = code; }
}
function refuse(code) { throw new CanaryAdmissionError(code); }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string'
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
    || Object.keys(value).sort().join('\0') !== [...names].sort().join('\0')) {
    refuse('InvalidCanaryPolicy');
  }
}
function instant(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) refuse('InvalidCanaryTime');
  return time;
}

/** Validate explicit policy, not live evidence. A digest does not grant authority. */
export function validateCanaryAdmissionPolicy(policy) {
  exact(policy, ['schema', 'version', 'repository', 'issue', 'operationId', 'generationKey',
    'headRevision', 'effectActorId', 'validFrom', 'validUntil', 'accountableOwner',
    'effectOwner', 'reviewOwners', 'allowedEffect', 'roundBudget']);
  exact(policy.repository, ['nodeId', 'owner', 'name']);
  exact(policy.reviewOwners, ['standards', 'spec']);
  const from = instant(policy.validFrom); const until = instant(policy.validUntil);
  if (policy.schema !== 'GaiaCanaryAdmissionPolicyV0' || policy.version !== 1
    || [policy.operationId, policy.generationKey, policy.headRevision, policy.repository.nodeId,
      policy.repository.owner, policy.repository.name, policy.accountableOwner, policy.effectOwner,
      policy.reviewOwners.standards, policy.reviewOwners.spec].some(value => typeof value !== 'string')
    || policy.allowedEffect !== 'CREATE_DRAFT' || policy.roundBudget !== 1
    || !Number.isSafeInteger(policy.issue) || policy.issue <= 0
    || !Number.isSafeInteger(policy.effectActorId) || policy.effectActorId <= 0
    || !SHA256.test(policy.operationId) || !SHA256.test(policy.generationKey)
    || !SHA1.test(policy.headRevision) || until <= from || until - from > 3_600_000
    || !/^[A-Za-z0-9_-]+$/u.test(policy.repository.nodeId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(policy.repository.owner)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(policy.repository.name)
    || !PRINCIPAL.test(policy.accountableOwner)
    || !/^github:app:[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(policy.effectOwner)
    || !PRINCIPAL.test(policy.reviewOwners.standards) || !PRINCIPAL.test(policy.reviewOwners.spec)
    || policy.reviewOwners.standards === policy.reviewOwners.spec) refuse('InvalidCanaryPolicy');
  return JSON.parse(JSON.stringify(policy));
}

/** Pure derivation; caller must supply actual ledger and verified Actions observations. */
export function bindCanaryAdmissionPolicy({ policy: supplied, snapshot, pumpActorId }) {
  const policy = validateCanaryAdmissionPolicy(supplied);
  const identity = snapshot?.identity; const envelope = snapshot?.envelope;
  if (identity?.operationId !== policy.operationId || identity?.generationKey !== policy.generationKey
    || !SHA256.test(identity?.workKey) || canonical(envelope?.repository) !== canonical(policy.repository)
    || envelope?.workItem?.kind !== 'ISSUE' || envelope.workItem.number !== policy.issue
    || envelope?.generation?.headRevision !== policy.headRevision || pumpActorId !== policy.effectActorId) {
    refuse('CanaryPolicyScopeMismatch');
  }
  return policy;
}

export function prepareCanaryManagedRound({ policy: supplied, snapshot, executorEpoch, pumpActorId, observedAt }) {
  const policy = bindCanaryAdmissionPolicy({ policy: supplied, snapshot, pumpActorId, observedAt });
  const now = instant(observedAt); const identity = snapshot.identity;
  if (now < instant(policy.validFrom) || now >= instant(policy.validUntil)) refuse('CanaryPolicyExpired');
  if (snapshot.state !== 'EFFECT_STARTED' || snapshot.terminal
    || !SHA256.test(snapshot.committedRevision)
    || !Number.isSafeInteger(executorEpoch?.runId) || executorEpoch.runId <= 0
    || !Number.isSafeInteger(executorEpoch?.runAttempt) || executorEpoch.runAttempt <= 0
    || canonical(snapshot.executorEpoch) !== canonical(executorEpoch)) refuse('CanaryClaimMismatch');

  const policyRevision = digest(policy);
  const supervisor = `gaia:operation:${identity.operationId}`;
  const executionOwner = `gaia:lane:${identity.workKey}:${policy.headRevision}`;
  const responsibility = {
    ownershipRevision: digest({ policyRevision, identity, kind: 'responsibility' }),
    accountableOwner: policy.accountableOwner, supervisor, executionOwner, reportsTo: supervisor,
    reviewOwners: policy.reviewOwners, effectOwner: policy.effectOwner, escalatesTo: policy.accountableOwner,
  };
  const command = {
    commandRevision: digest({ policyRevision, identity, kind: 'command' }), commandOwner: supervisor,
    commandPath: [supervisor, executionOwner], generation: policy.headRevision,
    capabilities: ['ASSIGN', 'REVOKE', 'STOP', 'RETRY', 'ESCALATE'],
  };
  const body = {
    schema: 'GaiaRoundReceiptV0', kind: 'OPEN', ordinal: 0, predecessorRoundKey: 'NONE',
    trigger: 'DRAFT_CREATED', roundBudget: 1, responsibility, command,
    evidence: {
      designCommit: 'UNKNOWN(NOT_MEASURED)', redCommit: 'UNKNOWN(NOT_REACHED)',
      greenCommit: 'UNKNOWN(NOT_REACHED)', testEvidenceReceipt: 'UNKNOWN(NOT_REACHED)',
      reviewVerdicts: ['UNKNOWN(NOT_REACHED)'], result: 'DRAFT_ADMISSION_PENDING',
      nextStep: 'Verify Draft readback before requesting separate execution authorization',
      estimate: { range: 'UNKNOWN(NOT_MEASURED)', confidence: 'UNKNOWN(NOT_MEASURED)', origin: 'canary policy' },
      blocker: { class: 'AUTHORITY', reason: 'Agent execution requires separate operator authorization',
        owner: policy.accountableOwner, phaseDeadline: policy.validUntil,
        nextTransition: 'DRAFT_READBACK', escalationAction: 'REPORT_BLOCKER', origin: 'canary policy' },
      origin: `canary policy ${policyRevision}`,
    },
  };
  const claim = { schema: 'GaiaManagedRoundEffectClaimV0',
    claimId: digest({ policyRevision, identity, executorEpoch, committedRevision: snapshot.committedRevision }),
    observedAt, leaseExpiresAt: new Date(Math.min(now + 300_000, instant(policy.validUntil))).toISOString() };
  const result = { receipt: { ...body, revision: digest(body) }, effectActor: policy.effectOwner,
    effectClaim: { ...claim, revision: digest(claim) } };
  validateManagedDraftConfiguration(result);
  return result;
}
