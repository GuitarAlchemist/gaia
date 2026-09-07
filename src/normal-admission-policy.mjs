import { createHash } from 'node:crypto';
import { validateManagedDraftConfiguration } from './pr-delivery-round-history.mjs';
import { independentAgentReviewers } from './agent-review-identity.mjs';
import { guardDraftCreation } from './draft-operation-envelope.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const PRINCIPAL = /^github:(?:user|team):[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;

export class NormalAdmissionError extends Error {
  constructor(code) { super(code); this.name = 'NormalAdmissionError'; this.code = code; }
}
function refuse(code) { throw new NormalAdmissionError(code); }
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
    refuse('InvalidNormalPolicy');
  }
}
function instant(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) refuse('InvalidNormalTime');
  return time;
}

/**
 * Repository-scoped normal-admission policy: unlike the canary policy this pins no issue,
 * operationId, generationKey or headRevision - those are read from the live operation
 * snapshot at bind time, once per candidate. Validate explicit policy only, not live
 * evidence. A digest does not grant authority, and this never authorizes anything beyond
 * one CREATE_DRAFT round.
 */
export function validateNormalAdmissionPolicy(policy) {
  const ai = policy?.schema === 'GaiaNormalAdmissionPolicyV1';
  exact(policy, ['schema', 'version', 'repository', 'effectActorId', 'validFrom', 'validUntil',
    'accountableOwner', 'effectOwner', 'reviewOwners', 'allowedEffect', 'roundBudget',
    ...(ai ? ['writerIdentity'] : [])]);
  exact(policy.repository, ['nodeId', 'owner', 'name']);
  exact(policy.reviewOwners, ['standards', 'spec']);
  const from = instant(policy.validFrom); const until = instant(policy.validUntil);
  if ((!ai && policy.schema !== 'GaiaNormalAdmissionPolicyV0') || policy.version !== 1
    || [policy.repository.nodeId, policy.repository.owner, policy.repository.name,
      policy.accountableOwner, policy.effectOwner,
      policy.reviewOwners.standards, policy.reviewOwners.spec].some(value => typeof value !== 'string')
    || policy.allowedEffect !== 'CREATE_DRAFT' || policy.roundBudget !== 1
    || !Number.isSafeInteger(policy.effectActorId) || policy.effectActorId <= 0
    || until <= from || until - from > 3_600_000
    || !/^[A-Za-z0-9_-]+$/u.test(policy.repository.nodeId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(policy.repository.owner)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(policy.repository.name)
    || !PRINCIPAL.test(policy.accountableOwner)
    || !/^github:app:[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(policy.effectOwner)
    || (ai ? !independentAgentReviewers(policy.writerIdentity, policy.reviewOwners)
      : !PRINCIPAL.test(policy.reviewOwners.standards) || !PRINCIPAL.test(policy.reviewOwners.spec)
        || policy.reviewOwners.standards === policy.reviewOwners.spec)) refuse('InvalidNormalPolicy');
  return JSON.parse(JSON.stringify(policy));
}

/** Pure binding of an explicit repository-scoped policy to one live operation snapshot. */
export function bindNormalAdmissionPolicy({ policy: supplied, snapshot, pumpActorId }) {
  const policy = validateNormalAdmissionPolicy(supplied);
  const identity = snapshot?.identity; const envelope = snapshot?.envelope;
  if (!SHA256.test(identity?.operationId) || !SHA256.test(identity?.generationKey)
    || !SHA256.test(identity?.workKey) || canonical(envelope?.repository) !== canonical(policy.repository)
    || envelope?.workItem?.kind !== 'ISSUE' || !Number.isSafeInteger(envelope?.workItem?.number)
    || envelope.workItem.number <= 0 || typeof envelope?.generation?.headRevision !== 'string'
    || pumpActorId !== policy.effectActorId) {
    refuse('NormalPolicyScopeMismatch');
  }
  return policy;
}

export function prepareNormalManagedRound({ policy: supplied, snapshot, executorEpoch, pumpActorId, observedAt }) {
  const policy = bindNormalAdmissionPolicy({ policy: supplied, snapshot, pumpActorId });
  const now = instant(observedAt); const identity = snapshot.identity;
  const headRevision = snapshot.envelope.generation.headRevision;
  if (now < instant(policy.validFrom) || now >= instant(policy.validUntil)) refuse('NormalPolicyExpired');
  if (snapshot.state !== 'EFFECT_STARTED' || snapshot.terminal
    || !SHA256.test(snapshot.committedRevision)
    || !Number.isSafeInteger(executorEpoch?.runId) || executorEpoch.runId <= 0
    || !Number.isSafeInteger(executorEpoch?.runAttempt) || executorEpoch.runAttempt <= 0
    || canonical(snapshot.executorEpoch) !== canonical(executorEpoch)) refuse('NormalClaimMismatch');

  const policyRevision = digest(policy);
  const supervisor = `gaia:operation:${identity.operationId}`;
  const executionOwner = `gaia:lane:${identity.workKey}:${headRevision}`;
  const responsibility = {
    ownershipRevision: digest({ policyRevision, identity, kind: 'responsibility' }),
    accountableOwner: policy.accountableOwner, supervisor, executionOwner, reportsTo: supervisor,
    reviewOwners: policy.reviewOwners, effectOwner: policy.effectOwner, escalatesTo: policy.accountableOwner,
    ...(policy.schema === 'GaiaNormalAdmissionPolicyV1' ? { writerIdentity: policy.writerIdentity } : {}),
  };
  const command = {
    commandRevision: digest({ policyRevision, identity, kind: 'command' }), commandOwner: supervisor,
    commandPath: [supervisor, executionOwner], generation: headRevision,
    capabilities: ['ASSIGN', 'REVOKE', 'STOP', 'RETRY', 'ESCALATE'],
  };
  const body = {
    schema: policy.schema === 'GaiaNormalAdmissionPolicyV1' ? 'GaiaRoundReceiptV1' : 'GaiaRoundReceiptV0',
    kind: 'OPEN', ordinal: 0, predecessorRoundKey: 'NONE',
    trigger: 'DRAFT_CREATED', roundBudget: policy.roundBudget, responsibility, command,
    evidence: {
      designCommit: 'UNKNOWN(NOT_MEASURED)', redCommit: 'UNKNOWN(NOT_REACHED)',
      greenCommit: 'UNKNOWN(NOT_REACHED)', testEvidenceReceipt: 'UNKNOWN(NOT_REACHED)',
      reviewVerdicts: ['UNKNOWN(NOT_REACHED)'], result: 'DRAFT_ADMISSION_PENDING',
      nextStep: 'Verify Draft readback before requesting separate execution authorization',
      estimate: { range: 'UNKNOWN(NOT_MEASURED)', confidence: 'UNKNOWN(NOT_MEASURED)', origin: 'normal admission policy' },
      blocker: { class: 'AUTHORITY', reason: 'Agent execution requires separate operator authorization',
        owner: policy.accountableOwner, phaseDeadline: policy.validUntil,
        nextTransition: 'DRAFT_READBACK', escalationAction: 'REPORT_BLOCKER', origin: 'normal admission policy' },
      origin: `normal admission policy ${policyRevision}`,
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

/**
 * Bounded operation seam, repository-scoped. External I/O is injected; callers do not
 * sequence claim checks. The operation identity is read from the live snapshot supplied at
 * construction (not from the policy) so one policy can admit any eligible operation in its
 * declared repository rather than being replayed or renamed from a one-issue canary grant.
 */
export function createNormalDraftAdmission({ policy: supplied, snapshot, pumpActorId,
  executorEpoch, readPolicy, readOperation, reserveEffect, now, lookupExact, createDraft }) {
  if ([readPolicy, readOperation, reserveEffect, now, lookupExact, createDraft]
    .some(port => typeof port !== 'function')) refuse('InvalidNormalPorts');
  const policy = bindNormalAdmissionPolicy({ policy: supplied, snapshot, pumpActorId });
  const operationId = snapshot.identity.operationId;
  // Pin immutable identity, not the initial mutable state (which advances through ledger CAS).
  const boundIdentity = canonical(snapshot.identity);
  const boundEnvelope = canonical(snapshot.envelope);
  const verifyBinding = current => {
    if (canonical(current?.identity) !== boundIdentity
      || canonical(current?.envelope) !== boundEnvelope) refuse('NormalClaimChanged');
  };
  if (!snapshot.terminal && !['EFFECT_STARTED', 'EFFECT_AMBIGUOUS'].includes(snapshot.state)) {
    const observed = instant(now());
    if (observed < instant(policy.validFrom) || observed >= instant(policy.validUntil)) {
      refuse('NormalPolicyExpired');
    }
  }
  const unchangedPolicy = async () => {
    const current = validateNormalAdmissionPolicy(await readPolicy());
    if (digest(current) !== digest(policy)) refuse('NormalPolicyChanged');
  };
  return Object.freeze({
    lookupExact,
    createDraft: guardDraftCreation({ prepare: async () => {
      await unchangedPolicy();
      const current = await readOperation(operationId);
      verifyBinding(current);
      const prepared = prepareNormalManagedRound({ policy, snapshot: current,
        executorEpoch, pumpActorId, observedAt: now() });
      const allowed = await reserveEffect({ workKey: current.identity.workKey,
        operationId, executorEpoch, claimedRevision: current.committedRevision });
      if (allowed !== 'AVAILABLE') refuse('NormalAdmissionRefused');
      const confirmed = await readOperation(operationId);
      verifyBinding(confirmed);
      if (confirmed?.committedRevision !== current.committedRevision) refuse('NormalClaimChanged');
      await unchangedPolicy();
      const managed = prepareNormalManagedRound({ policy, snapshot: confirmed,
        executorEpoch, pumpActorId, observedAt: now() });
      if (managed.receipt.revision !== prepared.receipt.revision) refuse('NormalClaimChanged');
      return managed;
    }, invoke: (request, managed) => createDraft(request, managed) }),
  });
}
