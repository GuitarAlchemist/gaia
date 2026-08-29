/**
 * Pure, advisory detection and repair planning for structural plan contradictions.
 *
 * This module consumes caller-supplied, digest-bound observations. It does not read
 * repositories, execute SQL, mutate Markdown, schedule work, publish, or grant authority.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './epistemic-research.mjs';

export const PLAN_CONTRADICTION_AUDIT_SCHEMA = 'urn:gaia:plan-contradiction-audit:v0.1';
export const CONTRADICTION_REPAIR_SCHEMA = 'urn:gaia:contradiction-repair-proposal:v0.1';

const SHA256 = /^[a-f0-9]{64}$/;
const LIFECYCLE_SCOPES = new Set(['CURRENT', 'PARKED', 'ARCHIVED']);
const REGISTRY_STATUSES = new Set([
  'PARKED_DECLARATION',
  'ARCHIVED_DECLARATION',
  'DECLARED_DELIVERED',
  'DECLARED_PARTIAL_OR_ACTIVE',
  'DECLARED_NOT_IMPLEMENTED',
  'CHECKLIST_COMPLETE_STATUS_UNKNOWN',
  'CHECKLIST_OPEN_STATUS_UNKNOWN',
  'STATUS_UNKNOWN',
]);
const UNKNOWN_STATUSES = new Set([
  'CHECKLIST_COMPLETE_STATUS_UNKNOWN',
  'CHECKLIST_OPEN_STATUS_UNKNOWN',
  'STATUS_UNKNOWN',
]);
const EVIDENCE_STATUSES = new Set(['DECLARATION_UNVERIFIED']);
const HYPOTHESIS_ROLES = new Set(['null', 'alternative']);
const DISPOSITIONS = new Set([
  'retain-both',
  'qualify-scope',
  'request-new-evidence',
  'quarantine-proposal',
  'supersede-with-new-artifact-proposal',
]);
const AUDIT_KEYS = [
  'auditId', 'authority', 'contradiction', 'input', 'kind', 'revision', 'ruleId',
  'schema', 'status',
];
const REPAIR_KEYS = [
  'authority', 'budget', 'contradictionRevision', 'createdAt', 'downstreamClaimRefs',
  'expiresAt', 'hypotheses', 'kind', 'probe', 'proposedDispositions', 'repairId',
  'revision', 'schema', 'status', 'uncertainty',
];

export class PlanContradictionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlanContradictionError';
    this.code = code;
  }
}

const reject = (code, message) => { throw new PlanContradictionError(code, message); };
const present = (value) => typeof value === 'string' && value.trim().length > 0;

function requireText(value, path) {
  if (!present(value)) reject('MISSING_TEXT', `${path} must be a non-empty string`);
  return value.trim();
}

function requireSha256(value, path) {
  if (!SHA256.test(value)) reject('INVALID_DIGEST', `${path} must be a lowercase sha256 digest`);
  return value;
}

function revisionRef(value, path) {
  if (!value || value.algorithm !== 'sha256') {
    reject('INVALID_DIGEST', `${path}.algorithm must be sha256`);
  }
  return { algorithm: 'sha256', digest: requireSha256(value.digest, `${path}.digest`) };
}

function artifactRef(value, path = 'artifact') {
  return {
    uri: requireText(value?.uri, `${path}.uri`),
    ...revisionRef(value, path),
  };
}

function requireCount(value, path) {
  if (!Number.isInteger(value) || value < 0) {
    reject('INVALID_COUNT', `${path} must be a non-negative integer`);
  }
  return value;
}

function authorityBoundary() {
  return {
    mode: 'advisory',
    effect: 'NONE',
    sourceMutationAuthorized: false,
    executionAuthorized: false,
    requestedAuthority: [],
  };
}

function digestOf(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function exactKeys(value, expected, path) {
  if (!value || typeof value !== 'object'
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    reject('INVALID_MATERIALIZATION', `${path} is not the exact materialized shape`);
  }
}

function contradictionFor(input, nonDeferredOpenCount) {
  const body = {
    leftClaimRef: { ...input.artifact, span: 'declared-status' },
    leftClaim: {
      field: 'registryStatus',
      value: input.registryStatus,
      evidenceStatus: input.evidenceStatus,
    },
    rightClaimRef: { ...input.artifact, span: 'acceptance-checklist' },
    rightClaim: {
      field: 'nonDeferredOpenCount',
      value: nonDeferredOpenCount,
      evidenceStatus: input.evidenceStatus,
    },
    relation: 'logical',
    sharedSubject: input.subject,
    detectedBy: 'deterministic-rule',
    status: 'unresolved',
  };
  const digest = digestOf(body);
  return {
    ...body,
    contradictionId: `con-${digest}`,
    revision: { algorithm: 'sha256', digest },
  };
}

/**
 * Audit one normalized plan declaration. A contradiction is an observation about
 * two retained declarations, never a decision that either declaration is true.
 */
export function auditPlanClaim(value) {
  if (!value || typeof value !== 'object') reject('INVALID_INPUT', 'plan claim must be an object');
  const lifecycleScope = requireText(value.lifecycleScope, 'lifecycleScope');
  if (!LIFECYCLE_SCOPES.has(lifecycleScope)) {
    reject('INVALID_LIFECYCLE_SCOPE', `unsupported lifecycle scope: ${lifecycleScope}`);
  }
  const registryStatus = requireText(value.registryStatus, 'registryStatus');
  if (!REGISTRY_STATUSES.has(registryStatus)) {
    reject('INVALID_REGISTRY_STATUS', `unsupported registry status: ${registryStatus}`);
  }
  const evidenceStatus = requireText(value.evidenceStatus, 'evidenceStatus');
  if (!EVIDENCE_STATUSES.has(evidenceStatus)) {
    reject('INVALID_EVIDENCE_STATUS', `unsupported evidence status: ${evidenceStatus}`);
  }
  const checkedCount = requireCount(value.checkedCount, 'checkedCount');
  const uncheckedCount = requireCount(value.uncheckedCount, 'uncheckedCount');
  const deferredOpenCount = requireCount(value.deferredOpenCount, 'deferredOpenCount');
  if (deferredOpenCount > uncheckedCount) {
    reject('INVALID_COUNT', 'deferredOpenCount cannot exceed uncheckedCount');
  }

  const input = {
    artifact: artifactRef(value.artifact),
    subject: requireText(value.subject, 'subject'),
    lifecycleScope,
    registryStatus,
    checkedCount,
    uncheckedCount,
    deferredOpenCount,
    nonDeferredOpenCount: uncheckedCount - deferredOpenCount,
    evidenceStatus,
  };

  let status = 'NO_STRUCTURAL_CONFLICT';
  let ruleId = 'NO_STRUCTURAL_CONFLICT';
  let contradiction = null;
  if (lifecycleScope === 'CURRENT'
      && registryStatus === 'DECLARED_DELIVERED'
      && input.nonDeferredOpenCount > 0) {
    status = 'CONTRADICTION';
    ruleId = 'DELIVERED_WITH_NON_DEFERRED_OPEN_CHECKLIST';
    contradiction = contradictionFor(input, input.nonDeferredOpenCount);
  } else if (UNKNOWN_STATUSES.has(registryStatus)) {
    status = 'UNKNOWN';
    ruleId = 'STATUS_EVIDENCE_REQUIRED';
  } else if (lifecycleScope === 'CURRENT'
      && registryStatus === 'DECLARED_PARTIAL_OR_ACTIVE'
      && checkedCount > 0
      && uncheckedCount === 0) {
    status = 'REVIEW_REQUIRED';
    ruleId = 'ACTIVE_WITH_COMPLETE_CHECKLIST_REVIEW';
  }

  const body = {
    schema: PLAN_CONTRADICTION_AUDIT_SCHEMA,
    kind: 'plan-contradiction-audit',
    status,
    ruleId,
    input,
    contradiction,
    authority: authorityBoundary(),
  };
  const digest = digestOf(body);
  return deepFreeze({
    ...body,
    auditId: `pca-${digest}`,
    revision: { algorithm: 'sha256', digest },
  });
}

export function verifyPlanContradictionAudit(audit) {
  exactKeys(audit, AUDIT_KEYS, 'audit');
  if (audit.schema !== PLAN_CONTRADICTION_AUDIT_SCHEMA || audit.kind !== 'plan-contradiction-audit') {
    reject('UNSUPPORTED_SCHEMA', 'audit does not use the supported schema and kind');
  }
  const { auditId, revision, ...body } = audit;
  const digest = digestOf(body);
  if (revision?.algorithm !== 'sha256' || revision.digest !== digest || auditId !== `pca-${digest}`) {
    reject('DIGEST_MISMATCH', 'audit content digest or auditId does not match its body');
  }
  const rebuilt = auditPlanClaim(audit.input);
  if (canonicalJson(rebuilt) !== canonicalJson(audit)) {
    reject('INVALID_MATERIALIZATION', 'audit is not the exact deterministic materialization');
  }
  return true;
}

export function encodePlanContradictionAudit(audit) {
  verifyPlanContradictionAudit(audit);
  return canonicalJson(audit);
}

function hypothesisSet(values) {
  if (!Array.isArray(values) || values.length < 2) {
    reject('WEAK_HYPOTHESIS_SET', 'at least two competing hypotheses are required');
  }
  const hypotheses = values.map((value, index) => {
    if (!HYPOTHESIS_ROLES.has(value?.role)) {
      reject('INVALID_HYPOTHESIS_ROLE', `hypotheses[${index}].role must be null or alternative`);
    }
    return {
      id: requireText(value.id, `hypotheses[${index}].id`),
      role: value.role,
      statement: requireText(value.statement, `hypotheses[${index}].statement`),
      falsifier: requireText(value.falsifier, `hypotheses[${index}].falsifier`),
    };
  });
  if (new Set(hypotheses.map((item) => item.id)).size !== hypotheses.length) {
    reject('DUPLICATE_HYPOTHESIS', 'hypothesis ids must be unique');
  }
  if (hypotheses.filter((item) => item.role === 'null').length !== 1) {
    reject('WEAK_HYPOTHESIS_SET', 'exactly one null hypothesis is required');
  }
  return hypotheses;
}

function boundedBudget(value) {
  if (value?.maxIncrementalPaidUsd !== 0) {
    reject('PAID_BUDGET_REQUESTED', 'repair requires zero incremental paid cost');
  }
  if (!Number.isInteger(value.maxInputArtifacts)
      || value.maxInputArtifacts < 1
      || value.maxInputArtifacts > 1_024) {
    reject('UNBOUNDED_BUDGET', 'budget.maxInputArtifacts must be an integer from 1 to 1024');
  }
  if (!Number.isInteger(value.maxDurationMs)
      || value.maxDurationMs < 1
      || value.maxDurationMs > 86_400_000) {
    reject('UNBOUNDED_BUDGET', 'budget.maxDurationMs must be an integer from 1 to 86400000');
  }
  return {
    maxIncrementalPaidUsd: 0,
    maxInputArtifacts: value.maxInputArtifacts,
    maxDurationMs: value.maxDurationMs,
  };
}

function dispositions(values) {
  if (!Array.isArray(values) || values.length === 0) {
    reject('MISSING_DISPOSITION', 'at least one proposed disposition is required');
  }
  const result = values.map((value, index) => {
    if (!DISPOSITIONS.has(value)) {
      reject('INVALID_DISPOSITION', `proposedDispositions[${index}] is unsupported`);
    }
    return value;
  });
  if (new Set(result).size !== result.length) {
    reject('DUPLICATE_DISPOSITION', 'proposed dispositions must be unique');
  }
  return result;
}

function materializeRepairBody(input, contradictionRevision) {
  const created = Date.parse(input.createdAt);
  const expires = Date.parse(input.expiresAt);
  if (Number.isNaN(created)) reject('INVALID_TIME', 'createdAt must be an ISO date-time');
  if (Number.isNaN(expires) || expires <= created) {
    reject('INVALID_TIME', 'expiresAt must be later than createdAt');
  }
  if (expires - created > 7 * 86_400_000) {
    reject('UNBOUNDED_EXPIRY', 'repair proposal expiry cannot exceed seven days');
  }
  if (Object.hasOwn(input, 'authority')) {
    reject('AUTHORITY_WIDENING', 'repair authority is fixed and cannot be supplied by the caller');
  }
  if (!present(input.probe?.positiveControl)) {
    reject('MISSING_POSITIVE_CONTROL', 'probe requires a positive control');
  }
  if (!present(input.probe?.negativeControl)) {
    reject('MISSING_NEGATIVE_CONTROL', 'probe requires a negative control');
  }
  if (!Array.isArray(input.probe?.requiredEvidenceRefs)
      || input.probe.requiredEvidenceRefs.length === 0) {
    reject('MISSING_EVIDENCE', 'probe requires at least one immutable evidence reference');
  }
  if (input.uncertainty?.class !== 'UNKNOWN') {
    reject('INVALID_UNCERTAINTY', 'unexecuted repair uncertainty.class must be UNKNOWN');
  }

  return {
    schema: CONTRADICTION_REPAIR_SCHEMA,
    kind: 'contradiction-repair-proposal',
    status: 'advisory',
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    contradictionRevision,
    hypotheses: hypothesisSet(input.hypotheses),
    probe: {
      description: requireText(input.probe.description, 'probe.description'),
      positiveControl: input.probe.positiveControl.trim(),
      negativeControl: input.probe.negativeControl.trim(),
      requiredEvidenceRefs: input.probe.requiredEvidenceRefs.map((ref, index) => (
        artifactRef(ref, `probe.requiredEvidenceRefs[${index}]`)
      )),
    },
    budget: boundedBudget(input.budget),
    proposedDispositions: dispositions(input.proposedDispositions),
    downstreamClaimRefs: Array.isArray(input.downstreamClaimRefs)
      ? input.downstreamClaimRefs.map((ref, index) => artifactRef(ref, `downstreamClaimRefs[${index}]`))
      : reject('INVALID_DOWNSTREAM_CLAIMS', 'downstreamClaimRefs must be an array'),
    uncertainty: {
      class: 'UNKNOWN',
      rationale: requireText(input.uncertainty.rationale, 'uncertainty.rationale'),
    },
    authority: authorityBoundary(),
  };
}

/** Build a bounded proposal. It never selects or applies a disposition. */
export function proposeContradictionRepair(input) {
  if (!input || typeof input !== 'object') reject('INVALID_INPUT', 'repair input must be an object');
  const audit = input.contradictionAudit;
  verifyPlanContradictionAudit(audit);
  if (audit.status !== 'CONTRADICTION' || !audit.contradiction) {
    reject('NO_CONTRADICTION', 'a repair requires a verified unresolved contradiction');
  }
  const body = materializeRepairBody(input, revisionRef(
    audit.contradiction.revision,
    'contradictionAudit.contradiction.revision',
  ));
  const digest = digestOf(body);
  return deepFreeze({
    ...body,
    repairId: `crp-${digest}`,
    revision: { algorithm: 'sha256', digest },
  });
}

export function verifyContradictionRepair(proposal) {
  exactKeys(proposal, REPAIR_KEYS, 'repair proposal');
  if (proposal.schema !== CONTRADICTION_REPAIR_SCHEMA
      || proposal.kind !== 'contradiction-repair-proposal') {
    reject('UNSUPPORTED_SCHEMA', 'repair proposal does not use the supported schema and kind');
  }
  const { repairId, revision, ...body } = proposal;
  const digest = digestOf(body);
  if (revision?.algorithm !== 'sha256' || revision.digest !== digest || repairId !== `crp-${digest}`) {
    reject('DIGEST_MISMATCH', 'repair proposal digest or repairId does not match its body');
  }
  if (body.authority?.mode !== 'advisory'
      || body.authority.effect !== 'NONE'
      || body.authority.sourceMutationAuthorized !== false
      || body.authority.executionAuthorized !== false
      || !Array.isArray(body.authority.requestedAuthority)
      || body.authority.requestedAuthority.length !== 0) {
    reject('AUTHORITY_WIDENING', 'repair proposal authority boundary was widened');
  }
  const { authority: _authority, ...inputBody } = body;
  const rebuilt = materializeRepairBody(
    inputBody,
    revisionRef(body.contradictionRevision, 'contradictionRevision'),
  );
  if (canonicalJson(rebuilt) !== canonicalJson(body)) {
    reject('INVALID_MATERIALIZATION', 'repair proposal is not the exact deterministic materialization');
  }
  return true;
}

export function encodeContradictionRepair(proposal) {
  verifyContradictionRepair(proposal);
  return canonicalJson(proposal);
}
