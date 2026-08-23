import { createHash } from 'node:crypto';

export const GITHUB_CANDIDATE_PUBLISH_INTENT_SCHEMA =
  'gaia-github-candidate-publish-intent/1';

export class GitHubCandidatePublishError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubCandidatePublishError';
    this.code = code;
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REQUESTED_OPERATIONS = Object.freeze([
  'COMMIT_CANDIDATE',
  'PUSH_CANDIDATE_BRANCH',
  'OPEN_PULL_REQUEST',
]);

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function fail(code, message) {
  throw new GitHubCandidatePublishError(code, message);
}

function requireText(value, field, code = 'InvalidTransition') {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(code, `${field} must be non-empty canonical text`);
  }
  return value;
}

function requireSha(value, field, code = 'InvalidTransition') {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(code, `${field} must be a lowercase SHA-256`);
  }
  return value;
}

function requireOid(value, field, code = 'InvalidTransition') {
  if (typeof value !== 'string' || !GIT_OID.test(value)) {
    fail(code, `${field} must be a lowercase Git object id`);
  }
  return value;
}

function requireExactKeys(value, expected, field, code = 'InvalidTransition') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${field} has an unsupported field set`);
  }
}

// Provider and caller structures are copied from descriptors before they are read. This
// keeps accessors, symbol keys, foreign prototypes, cycles and non-JSON values outside
// the content-addressed seam rather than letting canonicalization interpret them.
function ownJson(value, budget = { nodes: 65_536 }, seen = new Set(), depth = 0) {
  if (depth > 16 || budget.nodes <= 0) fail('InvalidTransition', 'input exceeds JSON bounds');
  budget.nodes -= 1;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') fail('InvalidTransition', 'input contains a non-JSON value');
  if (seen.has(value)) fail('InvalidTransition', 'input contains a cycle');
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) {
    fail('InvalidTransition', 'input must use ordinary JSON prototypes');
  }
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    fail('InvalidTransition', 'input contains a symbol-keyed field');
  }
  const read = (key) => {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('InvalidTransition', 'every input field must be enumerable own data');
    }
    return descriptor.value;
  };
  let owned;
  if (array) {
    if (keys.length !== descriptors.length.value + 1) {
      fail('InvalidTransition', 'input contains a sparse or extended array');
    }
    owned = Array.from(
      { length: descriptors.length.value },
      (_unused, index) => ownJson(read(String(index)), budget, seen, depth + 1),
    );
  } else {
    owned = {};
    for (const key of keys) {
      Object.defineProperty(owned, key, {
        value: ownJson(read(key), budget, seen, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  seen.delete(value);
  return owned;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function verifyTransition(supplied) {
  const transition = ownJson(supplied);
  requireExactKeys(
    transition,
    ['schema', 'status', 'fromRevision', 'intent', 'authority', 'execution', 'revision'],
    'transition',
  );
  if (transition.schema !== 'gaia-github-portfolio-transition/1') {
    fail('InvalidTransition', 'unsupported transition schema');
  }
  if (transition.status !== 'CANDIDATE_READY') {
    fail('CandidateNotReady', 'only CANDIDATE_READY can produce a publication intent');
  }
  requireSha(transition.revision, 'transition.revision');
  const { revision, ...transitionBody } = transition;
  if (sha256(transitionBody) !== revision) {
    fail('TransitionRevisionMismatch', 'transition content does not match its revision');
  }

  requireExactKeys(
    transition.intent,
    [
      'action', 'repository', 'itemKind', 'itemId', 'itemNumber', 'task', 'evidenceState',
      'snapshotRevision', 'requiredAuthority', 'intentRevision',
    ],
    'transition.intent',
  );
  const intent = transition.intent;
  if (intent.action !== 'RUN_FACTORY_AGENT' || intent.requiredAuthority !== 'FACTORY_RUN') {
    fail('IntentBindingMismatch', 'intent is not an exact factory-run intent');
  }
  requireText(intent.repository, 'intent.repository');
  requireText(intent.itemId, 'intent.itemId');
  requireText(intent.task, 'intent.task');
  if (!['ISSUE', 'PULL_REQUEST'].includes(intent.itemKind)
      || !Number.isSafeInteger(intent.itemNumber) || intent.itemNumber < 1) {
    fail('IntentBindingMismatch', 'intent item identity is invalid');
  }
  requireSha(intent.snapshotRevision, 'intent.snapshotRevision');
  requireSha(intent.intentRevision, 'intent.intentRevision');
  const { intentRevision, ...intentBody } = intent;
  if (sha256(intentBody) !== intentRevision) {
    fail('IntentRevisionMismatch', 'intent content does not match its revision');
  }
  if (transition.fromRevision !== intent.snapshotRevision) {
    fail('IntentBindingMismatch', 'intent snapshot does not bind the transition source');
  }

  requireExactKeys(transition.authority, ['grantId', 'intentRevision'], 'transition.authority');
  requireText(transition.authority.grantId, 'authority.grantId');
  if (transition.authority.intentRevision !== intent.intentRevision) {
    fail('IntentBindingMismatch', 'authority does not bind the exact intent');
  }

  requireExactKeys(
    transition.execution,
    ['idempotencyKey', 'receiptRevision', 'receipt'],
    'transition.execution',
  );
  const execution = transition.execution;
  requireSha(execution.idempotencyKey, 'execution.idempotencyKey');
  const expectedIdempotency = sha256({
    grantId: transition.authority.grantId,
    intentRevision: intent.intentRevision,
  });
  if (execution.idempotencyKey !== expectedIdempotency) {
    fail('IdempotencyMismatch', 'execution idempotency does not bind grant and intent');
  }
  requireSha(execution.receiptRevision, 'execution.receiptRevision');
  if (sha256(execution.receipt) !== execution.receiptRevision) {
    fail('ReceiptRevisionMismatch', 'execution receipt does not match its revision');
  }
  const receipt = execution.receipt;
  if (!receipt || receipt.schema !== 'gaia-agent-factory-receipt/1'
      || receipt.status !== 'completed' || receipt.task !== intent.task) {
    fail('IntentBindingMismatch', 'completed execution receipt does not bind the intent task');
  }
  const baseHead = requireOid(receipt.base?.head, 'receipt.base.head');
  if (receipt.changeSet?.baseHead !== baseHead) {
    fail('IntentBindingMismatch', 'candidate change set does not bind the receipt base HEAD');
  }
  const changeSetIdentity = requireSha(
    receipt.changeSet?.identity, 'receipt.changeSet.identity', 'IntentBindingMismatch',
  );
  return { transition, intent, receipt, baseHead, changeSetIdentity };
}

function ownGitObservation(value) {
  let observation;
  try {
    observation = ownJson(value);
  } catch (error) {
    if (error instanceof GitHubCandidatePublishError) {
      fail('GitReadProtocol', 'gitRead returned an unsupported observation');
    }
    throw error;
  }
  requireExactKeys(
    observation,
    ['repository', 'headOid', 'baseOid', 'changeSetIdentity'],
    'git observation',
    'GitReadProtocol',
  );
  requireText(observation.repository, 'git.repository', 'GitReadProtocol');
  requireOid(observation.headOid, 'git.headOid', 'GitReadProtocol');
  requireOid(observation.baseOid, 'git.baseOid', 'GitReadProtocol');
  requireSha(observation.changeSetIdentity, 'git.changeSetIdentity', 'GitReadProtocol');
  return observation;
}

/**
 * Turn one independently approved local candidate into descriptive publication data.
 *
 * `gitRead.read` is the only adapter seam. The request explicitly carries `effect: NONE`;
 * this module has no filesystem, network, Git mutation, credential or authority adapter.
 */
export async function buildGitHubCandidatePublishIntent({ transition, gitRead } = {}) {
  if (!gitRead || typeof gitRead.read !== 'function') {
    fail('InvalidAdapter', 'gitRead.read is required');
  }
  const verified = verifyTransition(transition);
  const observed = ownGitObservation(await gitRead.read({
    effect: 'NONE',
    repository: verified.intent.repository,
    expectedHeadOid: verified.baseHead,
    expectedChangeSetIdentity: verified.changeSetIdentity,
  }));
  if (observed.repository !== verified.intent.repository) {
    fail('RepositoryIdentityMismatch', 'candidate Git repository does not match the intent');
  }
  if (observed.headOid !== verified.baseHead || observed.baseOid !== verified.baseHead) {
    fail('CandidateStale', 'candidate HEAD or GitHub base moved after execution');
  }
  if (observed.changeSetIdentity !== verified.changeSetIdentity) {
    fail('CandidateChanged', 'candidate change set moved after independent review');
  }

  const body = {
    schema: GITHUB_CANDIDATE_PUBLISH_INTENT_SCHEMA,
    effect: 'NONE',
    source: {
      transitionRevision: verified.transition.revision,
      executionReceiptRevision: verified.transition.execution.receiptRevision,
      intentRevision: verified.intent.intentRevision,
      portfolioRevision: verified.intent.snapshotRevision,
      idempotencyKey: verified.transition.execution.idempotencyKey,
    },
    repository: verified.intent.repository,
    item: {
      kind: verified.intent.itemKind,
      id: verified.intent.itemId,
      number: verified.intent.itemNumber,
    },
    candidate: {
      headOid: observed.headOid,
      baseOid: observed.baseOid,
      changeSetIdentity: observed.changeSetIdentity,
    },
    requestedOperations: [...REQUESTED_OPERATIONS],
  };
  return deepFreeze({ ...body, revision: sha256(body) });
}
