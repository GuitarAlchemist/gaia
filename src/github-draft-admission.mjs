/**
 * github-draft-admission.mjs — the shipped `draftAdmission` read port.
 *
 * This is a precondition and an evidence binding, never authority. It answers one
 * question for the portfolio factory: is the exact Draft the hosted pump says it created
 * for this issue still there, still a Draft, still on the same head? It answers by
 * reading GitHub again through the existing Draft provider, whose `lookupExact` already
 * enforces the repository identity, the branch, the exact operation marker, ambiguity,
 * the OPEN-draft state, the non-fork owner, and head-revision equality.
 *
 * The expectation comes from the hosted pump's intake receipt file. That file is untrusted
 * input: it is validated to its closed shape and its work/operation identities are recomputed
 * using the envelope's canonical form, so a receipt naming an issue its work key does not derive
 * from is refused before GitHub is consulted. The receipt is never treated as proof that
 * the Draft exists; only the readback is.
 *
 * No effect, no bus verb, no grant. A refusal here is raised inside the factory before
 * `authority.consume`, so nothing is spent and no agent starts.
 */

import { createHash } from 'node:crypto';

import { createGhDraftOperationProvider } from './gh-draft-operation-provider.mjs';

export class DraftAdmissionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'DraftAdmissionError';
    this.code = code;
  }
}

// The envelope's identity function, restated: sorted-key canonical JSON hashed with
// SHA-256. It is repeated here rather than imported so this read-only adapter does not
// widen the envelope's exported surface. Tests that restate this form alone cannot prove
// compatibility with a changed producer; producer-derived evidence is a separate check.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const contentRevision = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const invalid = (detail) => new DraftAdmissionError(
  'DraftExpectationInvalid', `draft expectation ${detail}`,
);

function ownFields(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalid(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  if (own.some((key) => typeof key !== 'string')
      || JSON.stringify([...own].sort()) !== JSON.stringify([...keys].sort())
      || own.some((key) => !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    throw invalid(`${label} must carry exactly its closed fields`);
  }
  return value;
}

const text = (value, label) => {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
      || /[\p{Cc}]/u.test(value)) {
    throw invalid(`${label} must be canonical text`);
  }
  return value;
};
const revision = (value, label) => {
  if (typeof value !== 'string' || !SHA256.test(value)) throw invalid(`${label} must be a SHA-256`);
  return value;
};
const gitOid = (value, label) => {
  if (typeof value !== 'string' || !GIT_OID.test(value)) throw invalid(`${label} must be a Git revision`);
  return value;
};
const positiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid(`${label} must be a positive integer`);
  return value;
};

/**
 * Parse and bind one hosted pump intake receipt into a closed Draft expectation.
 *
 * Exported for the operator's own tests; the CLI reaches it only through the adapter.
 */
export function readDraftExpectation(receiptText, expectedRepository) {
  if (typeof expectedRepository !== 'string' || !OWNER_NAME.test(expectedRepository)) {
    throw new DraftAdmissionError('InvalidArgument', 'expectedRepository must be owner/name');
  }
  let receipt;
  try {
    receipt = JSON.parse(String(receiptText));
  } catch {
    throw invalid('is not JSON');
  }
  ownFields(receipt, [
    'schema', 'command', 'trigger', 'phase', 'operationId', 'workKey', 'committedRevision',
    'workItem', 'unsettledCount', 'result', 'skipped', 'telemetry',
    ...(receipt && Object.hasOwn(receipt, 'observation') ? ['observation'] : []),
  ], 'receipt');
  // The hosted CLI adds this diagnostic after the evidence receipt is produced.
  // It cannot replace the fresh provider lookup or confer admission/authority.
  if (Object.hasOwn(receipt, 'observation')) {
    const annotation = receipt.observation;
    if (annotation?.state === 'PRODUCED') {
      ownFields(annotation, ['state', 'revision'], 'observation');
      revision(annotation.revision, 'observation.revision');
    } else if (annotation?.state === 'REFUSED') {
      ownFields(annotation, ['state', 'reason'], 'observation');
      if (!['InvalidHostedDraftPumpReceipt', 'UnobservableHostedDraftPumpReceipt',
        'InvalidHostedDraftPump', 'IncoherentHostedDraftPump', 'ObservationFailed']
        .includes(annotation.reason)) throw invalid('observation reason is undeclared');
    } else {
      throw invalid('observation state is undeclared');
    }
  }
  if (receipt.schema !== 'GaiaHostedDraftPumpCliReceiptV0') throw invalid('has a foreign schema');
  if (receipt.command !== 'intake') throw invalid('is not an intake receipt');
  ownFields(receipt.workItem, ['kind', 'number'], 'workItem');
  if (receipt.workItem.kind !== 'ISSUE') throw invalid('workItem must be an ISSUE');
  const number = positiveInteger(receipt.workItem.number, 'workItem.number');

  const result = ownFields(receipt.result, [
    'kind', 'outcome', 'effect', 'operationId', 'workKey', 'generationKey', 'generation',
    'observedSourceRevision', 'pullRequest', 'refusal', 'committedRevision', 'actionRevision',
    'checklistRevision', 'sourceRevision',
  ], 'result');
  if (result.kind !== 'Terminal') throw invalid('result is not terminal');
  if (!['CREATED', 'REUSED'].includes(result.outcome)) throw invalid('result did not produce a Draft');
  const workKey = revision(result.workKey, 'result.workKey');
  const generationKey = revision(result.generationKey, 'result.generationKey');
  const operationId = revision(result.operationId, 'result.operationId');
  if (receipt.workKey !== workKey || receipt.operationId !== operationId) {
    throw invalid('receipt identity does not match its result');
  }
  const generation = ownFields(result.generation, [
    'baseRef', 'headRef', 'headRevision', 'policyRevision',
  ], 'generation');
  const baseRef = text(generation.baseRef, 'generation.baseRef');
  const headRef = text(generation.headRef, 'generation.headRef');
  const headRevision = gitOid(generation.headRevision, 'generation.headRevision');

  const pullRequest = ownFields(result.pullRequest, [
    'number', 'url', 'isDraft', 'state', 'operationMarker', 'repository', 'baseRef', 'headRef',
    'headRevision',
  ], 'pullRequest');
  const repository = ownFields(pullRequest.repository, ['nodeId', 'owner', 'name'], 'repository');
  const bound = Object.freeze({
    nodeId: text(repository.nodeId, 'repository.nodeId'),
    owner: text(repository.owner, 'repository.owner'),
    name: text(repository.name, 'repository.name'),
  });
  if (pullRequest.baseRef !== baseRef || pullRequest.headRef !== headRef
      || pullRequest.headRevision !== headRevision) {
    throw invalid('pull request generation does not match the operation generation');
  }
  if (pullRequest.operationMarker !== operationId) {
    throw invalid('pull request marker is not the operation identity');
  }
  const pullRequestNumber = positiveInteger(pullRequest.number, 'pullRequest.number');

  // The chain the ledger built, rebuilt: the issue derives the work key, and the work key
  // with the generation derives the operation identity that the Draft carries as its marker.
  const derivedWorkKey = contentRevision({
    schema: 'GaiaDraftWorkKeyV0',
    repositoryNodeId: bound.nodeId,
    workItem: { kind: 'ISSUE', number },
    requestedEffect: 'CREATE_DRAFT',
  });
  if (derivedWorkKey !== workKey) {
    throw invalid('work key does not derive from its repository and issue');
  }
  const derivedOperationId = contentRevision({
    schema: 'GaiaDraftOperationIdV0', workKey, generationKey,
  });
  if (derivedOperationId !== operationId) {
    throw invalid('operation identity does not derive from its work key and generation');
  }

  const repositoryName = `${bound.owner}/${bound.name}`;
  if (repositoryName.toLowerCase() !== expectedRepository.toLowerCase()) {
    throw new DraftAdmissionError(
      'DraftExpectationForeign', 'the draft expectation names a repository other than the one pre-committed',
    );
  }
  return Object.freeze({
    repository: bound,
    repositoryName,
    workItem: Object.freeze({ kind: 'ISSUE', number }),
    baseRef,
    headRef,
    headRevision,
    operationMarker: operationId,
    number: pullRequestNumber,
  });
}

// The provider validates a presentation at construction because it can also create
// Drafts. This adapter never calls that path; the template exists only to satisfy the
// constructor and describes itself as what it is.
const ADMISSION_PRESENTATION = Object.freeze({
  owner: 'gaia-draft-admission',
  gate: 'read-only admission',
  checklist: Object.freeze(['read-only readback; this adapter creates nothing']),
  eta: Object.freeze({ minimumMinutes: 1, maximumMinutes: 1 }),
});

export function createGitHubDraftAdmissionAdapter({
  expectedRepository,
  receiptText,
  run,
  createProvider = createGhDraftOperationProvider,
} = {}) {
  if (typeof expectedRepository !== 'string' || !OWNER_NAME.test(expectedRepository)) {
    throw new DraftAdmissionError('InvalidArgument', 'expectedRepository must be owner/name');
  }
  if (typeof createProvider !== 'function' || (run !== undefined && typeof run !== 'function')) {
    throw new DraftAdmissionError('InvalidArgument', 'createProvider and run must be functions');
  }
  // The receipt is validated on the first read, not at construction, so that a malformed
  // or foreign receipt is refused inside the factory's admission boundary — after the
  // operator has reserved its receipt path and before any grant — rather than as an
  // argument error that leaves no receipt behind. The expectation is bound once.
  let bound = null;
  const expectationAndProvider = () => {
    if (bound === null) {
      const expectation = readDraftExpectation(receiptText, expectedRepository);
      const provider = createProvider({
        expectedRepository: expectation.repository,
        presentation: ADMISSION_PRESENTATION,
        ...(run === undefined ? {} : { run }),
      });
      bound = Object.freeze({ expectation, provider });
    }
    return bound;
  };

  return Object.freeze({
    async target() {
      const { expectation } = expectationAndProvider();
      return Object.freeze({ repository: expectation.repositoryName,
        itemKind: expectation.workItem.kind, itemNumber: expectation.workItem.number });
    },
    async read({ repository, itemKind, itemNumber } = {}) {
      const { expectation, provider } = expectationAndProvider();
      if (itemKind !== 'ISSUE' || typeof repository !== 'string'
          || repository.toLowerCase() !== expectation.repositoryName.toLowerCase()
          || itemNumber !== expectation.workItem.number) {
        throw new DraftAdmissionError(
          'DraftExpectationForeign', 'the scheduled work item is not the one the draft expectation names',
        );
      }
      // Provider refusals (ProviderAmbiguous, ProviderConflict, ProviderUnavailable,
      // RepositoryIdentityMismatch) propagate with their code; the factory keeps the code
      // and drops the message.
      const draft = await provider.lookupExact({
        repository: expectation.repository,
        baseRef: expectation.baseRef,
        headRef: expectation.headRef,
        headRevision: expectation.headRevision,
        operationMarker: expectation.operationMarker,
        workItem: expectation.workItem,
      });
      if (draft === null) return null;
      if (draft.number !== expectation.number) {
        throw new DraftAdmissionError(
          'DraftExpectationMismatch', 'the observed pull request is not the one named by the receipt',
        );
      }
      if (draft.mergedEvidence !== undefined) {
        return {
          number: draft.number, isDraft: false, state: 'MERGED',
          headRef: draft.headRef, headRevision: draft.headRevision,
        };
      }
      return {
        number: draft.number,
        isDraft: draft.isDraft,
        state: draft.state,
        headRef: draft.headRef,
        headRevision: draft.headRevision,
      };
    },
  });
}
