/**
 * reporting-context.mjs — structural two-channel finalization for lineage reports.
 *
 * The caller supplies private evidence and one captured write capability. The returned report
 * carries only content commitments and the successor-safe lineage receipt. Nothing in this module sends a
 * bus message, authenticates an actor, grants authority, or decides whether a review approves.
 */

import { createHash } from 'node:crypto';

import {
  buildLineageReceipt,
} from './lineage-receipt.mjs';
import { canonicalJson } from './epistemic-research.mjs';

export const REPORTING_POLICY_SCHEMA = 'gaia-inventory-routing-policy/1';
export const REPORT_REQUEST_SCHEMA = 'gaia-inventory-routed-report-request/1';
export const REPORT_SCHEMA = 'gaia-inventory-routed-report/1';
export const PRIVATE_REPORT_EVIDENCE_SCHEMA = 'gaia-inventory-routed-private-evidence/1';
export const REPORTING_ERROR_SCHEMA = 'gaia-inventory-routing-error/1';

export const REPORT_ARTIFACT_CLASSES = Object.freeze([
  'handoff',
  'standards-review',
  'spec-review',
  'reconciliation',
  'preflight',
  'readiness',
]);

const RESULTS_BY_CLASS = Object.freeze({
  handoff: Object.freeze(['COMPLETE', 'BLOCKED']),
  'standards-review': Object.freeze(['APPROVE', 'REQUEST_CHANGES']),
  'spec-review': Object.freeze(['APPROVE', 'REQUEST_CHANGES']),
  reconciliation: Object.freeze(['RECONCILED', 'CONFLICT']),
  preflight: Object.freeze(['READY', 'NOT_READY']),
  readiness: Object.freeze(['READY', 'NOT_READY']),
});

const ROLE_BY_CLASS = Object.freeze({
  handoff: 'writer',
  'standards-review': 'standards-reviewer',
  'spec-review': 'spec-reviewer',
  reconciliation: 'reconciler',
  preflight: 'preflight-reviewer',
  readiness: 'readiness-reviewer',
});

const HEX_64 = /^[0-9a-f]{64}$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ReportingContextError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReportingContextError';
    this.code = code;
    this.schema = REPORTING_ERROR_SCHEMA;
    this.failClosed = true;
    this.authorityEffect = 'none';
  }
}

const refuse = (code) => new ReportingContextError(code);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function ownCanonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw refuse('ReportFieldSetViolation');
  seen.add(value);

  let owned;
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    const expectedKeys = new Set(['length', ...Array.from({ length: value.length }, (_, index) => `${index}`)]);
    if (keys.length !== expectedKeys.size || keys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))) {
      throw refuse('ReportFieldSetViolation');
    }
    owned = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw refuse('ReportFieldSetViolation');
      }
      owned.push(ownCanonicalValue(descriptor.value, seen));
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw refuse('ReportFieldSetViolation');
    owned = Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) throw refuse('ReportFieldSetViolation');
    for (const key of [...keys].sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw refuse('ReportFieldSetViolation');
      }
      owned[key] = ownCanonicalValue(descriptor.value, seen);
    }
  }

  seen.delete(value);
  return owned;
}

function exactKeys(value, keys, code = 'ReportFieldSetViolation') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refuse(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw refuse(code);
  }
}

function boundedId(value, code = 'ReportFieldSetViolation') {
  if (typeof value !== 'string' || !BOUNDED_ID.test(value) || value.includes('..')) throw refuse(code);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function validatePolicy(policy) {
  exactKeys(policy, [
    'activationReceiptDigest', 'artifactClasses', 'digest', 'mode', 'schema',
  ], 'RoutingPolicyRequired');
  if (policy.schema !== REPORTING_POLICY_SCHEMA || !HEX_64.test(policy.digest)
      || !HEX_64.test(policy.activationReceiptDigest)) {
    throw refuse('RoutingPolicyRequired');
  }
  if (policy.mode !== 'sealed' && policy.mode !== 'unsealed') throw refuse('RoutingPolicyRequired');
  if (!Array.isArray(policy.artifactClasses)
      || policy.artifactClasses.length !== REPORT_ARTIFACT_CLASSES.length
      || REPORT_ARTIFACT_CLASSES.some((item) => !policy.artifactClasses.includes(item))
      || new Set(policy.artifactClasses).size !== policy.artifactClasses.length) {
    throw refuse('RoutingPolicyRequired');
  }
  return policy;
}

function validateRoles(request) {
  exactKeys(request.producer, ['ref', 'role']);
  exactKeys(request.peerRoles, ['curatorRef', 'specReviewerRef', 'standardsReviewerRef']);
  const producerRef = boundedId(request.producer.ref);
  const producerRole = boundedId(request.producer.role);
  const curatorRef = boundedId(request.peerRoles.curatorRef);
  const standardsReviewerRef = boundedId(request.peerRoles.standardsReviewerRef);
  const specReviewerRef = boundedId(request.peerRoles.specReviewerRef);
  if (new Set([curatorRef, standardsReviewerRef, specReviewerRef]).size !== 3) {
    throw refuse('RoleSeparationViolation');
  }
  if (producerRef === curatorRef) throw refuse('RoleSeparationViolation');
  if (producerRole !== ROLE_BY_CLASS[request.artifactClass]) {
    throw refuse('RoleSeparationViolation');
  }
  if (request.artifactClass === 'standards-review'
      && (producerRef !== standardsReviewerRef || producerRole !== 'standards-reviewer')) {
    throw refuse('RoleSeparationViolation');
  }
  if (request.artifactClass === 'spec-review'
      && (producerRef !== specReviewerRef || producerRole !== 'spec-reviewer')) {
    throw refuse('RoleSeparationViolation');
  }
  return { ref: producerRef, role: producerRole };
}

function validatePrivateEvidence(value, request) {
  exactKeys(value, ['artifactClass', 'content', 'lineageId', 'producerRef', 'schema']);
  if (value.schema !== PRIVATE_REPORT_EVIDENCE_SCHEMA
      || value.artifactClass !== request.artifactClass
      || value.lineageId !== request.lineageDeclaration.lineageId
      || value.producerRef !== request.producer.ref) {
    throw refuse('ReportFieldSetViolation');
  }
  return value;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw refuse('ReportFieldSetViolation');
  }
  const policy = validatePolicy(request.policy);
  exactKeys(request, policy.mode === 'sealed'
    ? [
      'artifactClass', 'inputReceiptDigests', 'lineageDeclaration', 'peerRoles', 'policy',
      'privateEvidence', 'producer', 'result', 'schema',
    ]
    : [
      'artifactClass', 'inputReceiptDigests', 'lineageDeclaration', 'openEvidence', 'peerRoles',
      'policy', 'producer', 'result', 'schema',
    ]);
  if (request.schema !== REPORT_REQUEST_SCHEMA) throw refuse('ReportFieldSetViolation');
  if (!policy.artifactClasses.includes(request.artifactClass)) throw refuse('ArtifactClassNotRouted');
  if ((policy.mode === 'sealed') !== (request.lineageDeclaration?.sealed === true)) {
    throw refuse('RoutingPolicyDigestMismatch');
  }
  if (policy.mode === 'sealed') {
    const policyEvidence = request.lineageDeclaration.evidence?.filter(
      (item) => item?.label === 'reporting-policy',
    );
    if (policyEvidence?.length !== 1 || policyEvidence[0].digest !== policy.digest) {
      throw refuse('RoutingPolicyDigestMismatch');
    }
    const activationEvidence = request.lineageDeclaration.evidence?.filter(
      (item) => item?.label === 'reporting-policy-activation',
    );
    if (activationEvidence?.length !== 1
        || activationEvidence[0].digest !== policy.activationReceiptDigest) {
      throw refuse('RoutingPolicyOrderUnverifiable');
    }
  } else if (typeof request.openEvidence !== 'string') {
    throw refuse('ReportFieldSetViolation');
  }
  if (!Array.isArray(request.inputReceiptDigests)
      || request.inputReceiptDigests.some((item) => typeof item !== 'string' || !HEX_64.test(item))) {
    throw refuse('ReportFieldSetViolation');
  }
  if (new Set(request.inputReceiptDigests).size !== request.inputReceiptDigests.length) {
    throw refuse('ReportFieldSetViolation');
  }
  const inputReceiptDigests = [...request.inputReceiptDigests].sort();
  if (!RESULTS_BY_CLASS[request.artifactClass]?.includes(request.result)) {
    throw refuse('ReportFieldSetViolation');
  }
  const isReview = request.artifactClass === 'standards-review'
    || request.artifactClass === 'spec-review';
  if ((isReview && request.result !== request.lineageDeclaration.verdict)
      || (!isReview && request.lineageDeclaration.verdict !== null)) {
    throw refuse('ReportFieldSetViolation');
  }
  const producer = validateRoles(request);
  const privateEvidence = policy.mode === 'sealed'
    ? validatePrivateEvidence(request.privateEvidence, request)
    : null;
  return { inputReceiptDigests, policy, producer, privateEvidence };
}

/**
 * Finalize one official report. In sealed mode, private evidence is written before the lineage
 * manifest; only the canonical public report is returned.
 *
 * @param {object} request descriptor-validated and synchronously copied before the first await.
 * @param {(document: object) => Promise<{digest: string}>} [sealedWrite] one captured write
 *   capability. Pass a bound method, never its readable Adapter object.
 */
export async function finalizeInventoryRoutedReport(request, sealedWrite) {
  const ownedRequest = deepFreeze(ownCanonicalValue(request));
  const { inputReceiptDigests, policy, producer, privateEvidence } = validateRequest(ownedRequest);
  if (policy.mode === 'sealed' && typeof sealedWrite !== 'function') throw refuse('SealedSinkRequired');
  if (policy.mode === 'unsealed' && sealedWrite !== undefined && sealedWrite !== null) {
    throw refuse('SealedSinkForbidden');
  }

  const sealedSink = policy.mode === 'sealed'
    ? Object.freeze({
      async writeSealed(document) {
        return sealedWrite(document);
      },
    })
    : undefined;

  let declaration = ownedRequest.lineageDeclaration;
  if (policy.mode === 'sealed') {
    const expectedPrivateDigest = sha256(privateEvidence);
    let privateWrite;
    try {
      privateWrite = await sealedSink.writeSealed(privateEvidence);
    } catch {
      throw refuse('ArtifactConflict');
    }
    if (!privateWrite || Object.keys(privateWrite).length !== 1
        || privateWrite.digest !== expectedPrivateDigest) {
      throw refuse('ArtifactConflict');
    }
    declaration = deepFreeze({
      ...ownedRequest.lineageDeclaration,
      evidence: deepFreeze([
        ...ownedRequest.lineageDeclaration.evidence.map((item) => ({ ...item })),
        { digest: expectedPrivateDigest, label: `${ownedRequest.artifactClass}-private` },
      ]),
    });
  }

  const lineageReceipt = await buildLineageReceipt(
    declaration,
    policy.mode === 'sealed' ? sealedSink : undefined,
  );
  const report = deepFreeze({
    artifact_class: ownedRequest.artifactClass,
    authority_effect: 'none',
    input_receipt_digests: inputReceiptDigests,
    lineage_id: declaration.lineageId,
    lineage_receipt: lineageReceipt,
    policy_digest: policy.digest,
    policy_activation_receipt_digest: policy.activationReceiptDigest,
    producer,
    result: ownedRequest.result,
    schema: REPORT_SCHEMA,
    ...(policy.mode === 'unsealed' ? { open_evidence: ownedRequest.openEvidence } : {}),
  });
  return deepFreeze({ canonicalJson: canonicalJson(report), report });
}
