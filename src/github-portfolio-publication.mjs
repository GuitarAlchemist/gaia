import { createHash } from 'node:crypto';

export const GITHUB_CANDIDATE_PUBLICATION_RECEIPT_SCHEMA =
  'gaia-github-candidate-publication-receipt/1';

export class GitHubCandidatePublicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubCandidatePublicationError';
    this.code = code;
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const OPERATIONS = Object.freeze([
  'COMMIT_CANDIDATE', 'PUSH_CANDIDATE_BRANCH', 'OPEN_PULL_REQUEST',
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
  throw new GitHubCandidatePublicationError(code, message);
}

function exactObject(value, keys, field, code = 'InvalidIntent') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${field} must be a plain object`);
  }
  const actual = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (actual.some((key) => typeof key !== 'string')
      || actual.length !== keys.length
      || [...actual].sort().some((key, index) => key !== [...keys].sort()[index])
      || actual.some((key) => !descriptors[key]?.enumerable
        || !Object.hasOwn(descriptors[key], 'value'))) {
    fail(code, `${field} must contain exactly its schema fields`);
  }
}

function text(value, field, code = 'InvalidIntent') {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(code, `${field} must be canonical text`);
  }
  return value;
}

function digest(value, field, code = 'InvalidIntent') {
  if (!SHA256.test(text(value, field, code))) fail(code, `${field} must be a lowercase SHA-256`);
  return value;
}

function oid(value, field, code = 'InvalidIntent') {
  if (!GIT_OID.test(text(value, field, code))) fail(code, `${field} must be a Git object id`);
  return value;
}

function repository(value, field, code = 'InvalidIntent') {
  if (!REPOSITORY.test(text(value, field, code))) fail(code, `${field} must be owner/name`);
  return value;
}

function validateIntent(value) {
  exactObject(
    value,
    ['schema', 'effect', 'source', 'repository', 'item', 'candidate', 'requestedOperations', 'revision'],
    'intent',
  );
  if (value.schema !== 'gaia-github-candidate-publish-intent/1' || value.effect !== 'NONE') {
    fail('InvalidIntent', 'only the no-effect candidate publication intent is supported');
  }
  exactObject(
    value.source,
    [
      'transitionRevision', 'executionReceiptRevision', 'intentRevision',
      'portfolioRevision', 'idempotencyKey',
    ],
    'intent.source',
  );
  for (const field of Object.keys(value.source)) digest(value.source[field], `intent.source.${field}`);
  const repo = repository(value.repository, 'intent.repository');
  exactObject(value.item, ['kind', 'id', 'number'], 'intent.item');
  if (!['ISSUE', 'PULL_REQUEST'].includes(value.item.kind)
      || !Number.isSafeInteger(value.item.number) || value.item.number < 1) {
    fail('InvalidIntent', 'intent.item must identify one GitHub issue or pull request');
  }
  text(value.item.id, 'intent.item.id');
  exactObject(
    value.candidate,
    ['headOid', 'baseOid', 'changeSetIdentity', 'observation'],
    'intent.candidate',
  );
  const headOid = oid(value.candidate.headOid, 'intent.candidate.headOid');
  const baseOid = oid(value.candidate.baseOid, 'intent.candidate.baseOid');
  const changeSetIdentity = digest(
    value.candidate.changeSetIdentity, 'intent.candidate.changeSetIdentity',
  );
  if (value.candidate.observation !== 'CALLER_OBSERVED_READ_ONLY_DATA') {
    fail('InvalidIntent', 'intent candidate must retain its caller-observed epistemic label');
  }
  if (!Array.isArray(value.requestedOperations)
      || canonicalJson(value.requestedOperations) !== canonicalJson(OPERATIONS)) {
    fail('InvalidIntent', 'intent operations must be the closed publication sequence');
  }
  const revision = digest(value.revision, 'intent.revision');
  const { revision: _discard, ...body } = value;
  if (sha256(body) !== revision) {
    fail('IntentRevisionMismatch', 'publication intent content does not match its revision');
  }
  return { value, revision, repo, headOid, baseOid, changeSetIdentity };
}

function validateObservation(value, expected) {
  exactObject(
    value,
    ['repository', 'headOid', 'baseOid', 'changeSetIdentity'],
    'observation',
    'ObservationInvalid',
  );
  const observed = {
    repository: repository(value.repository, 'observation.repository', 'ObservationInvalid'),
    headOid: oid(value.headOid, 'observation.headOid', 'ObservationInvalid'),
    baseOid: oid(value.baseOid, 'observation.baseOid', 'ObservationInvalid'),
    changeSetIdentity: digest(
      value.changeSetIdentity, 'observation.changeSetIdentity', 'ObservationInvalid',
    ),
  };
  if (observed.repository.toLowerCase() !== expected.repo.toLowerCase()) {
    fail('RepositoryIdentityMismatch', 'observed repository does not match the publication intent');
  }
  if (observed.headOid !== expected.headOid || observed.baseOid !== expected.baseOid) {
    fail('CandidateStale', 'candidate HEAD or GitHub base moved before authorization');
  }
  if (observed.changeSetIdentity !== expected.changeSetIdentity) {
    fail('CandidateChanged', 'candidate change set moved before authorization');
  }
  return observed;
}

function validateAuthorization(value, intentRevision) {
  exactObject(
    value,
    ['status', 'grantId', 'intentRevision'],
    'authorization',
    'AuthorityInvalid',
  );
  if (value.status !== 'AUTHORIZED' || value.intentRevision !== intentRevision) {
    fail('AuthorityInvalid', 'authority did not consume an exact publication grant');
  }
  return { grantId: text(value.grantId, 'authorization.grantId', 'AuthorityInvalid') };
}

function validateCommit(value) {
  exactObject(value, ['commitOid'], 'commit result', 'EffectResultInvalid');
  return oid(value.commitOid, 'commit.commitOid', 'EffectResultInvalid');
}

function validatePush(value, commitOid) {
  exactObject(value, ['headOid'], 'push result', 'EffectResultInvalid');
  const headOid = oid(value.headOid, 'push.headOid', 'EffectResultInvalid');
  if (headOid !== commitOid) fail('EffectResultInvalid', 'push did not publish the committed object');
}

function validatePullRequest(value, commitOid, expectedRepository) {
  exactObject(value, ['number', 'url', 'headOid'], 'pull request result', 'EffectResultInvalid');
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    fail('EffectResultInvalid', 'pull request number must be positive');
  }
  const url = text(value.url, 'pullRequest.url', 'EffectResultInvalid');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('EffectResultInvalid', 'pull request URL must be a canonical GitHub URL');
  }
  const expectedPath = `/${expectedRepository}/pull/${value.number}`.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com'
      || parsed.port !== '' || parsed.username !== '' || parsed.password !== ''
      || parsed.search !== '' || parsed.hash !== ''
      || parsed.pathname.toLowerCase() !== expectedPath) {
    fail('EffectResultInvalid', 'pull request URL does not bind the expected repository and number');
  }
  const headOid = oid(value.headOid, 'pullRequest.headOid', 'EffectResultInvalid');
  if (headOid !== commitOid) {
    fail('EffectResultInvalid', 'pull request does not expose the committed object');
  }
  return { number: value.number, url, headOid };
}

async function invokeEffect(stage, action) {
  try {
    return await action();
  } catch {
    fail(`${stage}Failed`, `${stage} effect failed without exposing provider diagnostics`);
  }
}

async function consumeAuthority(authority, request) {
  try {
    return await authority.consume(request);
  } catch {
    fail('AuthorityRefused', 'publication authority refused without exposing diagnostics');
  }
}

export function createGitHubCandidatePublicationAdapter({
  expectedRepository, authority, effects,
}) {
  const expected = repository(
    expectedRepository, 'expectedRepository', 'InvalidAdapter',
  );
  if (!authority || typeof authority.consume !== 'function'
      || !effects || ['observe', 'commit', 'push', 'openPullRequest'].some(
        (method) => typeof effects[method] !== 'function',
      )) {
    fail('InvalidAdapter', 'authority and the closed GitHub effect Adapter are required');
  }

  return Object.freeze({
    async publish(request) {
      exactObject(request, ['intent', 'grant'], 'request', 'InvalidRequest');
      const intent = validateIntent(request.intent);
      if (intent.repo.toLowerCase() !== expected.toLowerCase()) {
        fail('RepositoryScopeMismatch', 'intent repository does not match this Adapter');
      }

      const observation = validateObservation(await invokeEffect(
        'Observation', () => effects.observe({ repository: intent.repo }),
      ), intent);
      const authorityIntent = {
        intentRevision: intent.revision,
        action: 'PUBLISH_CANDIDATE',
        repository: intent.repo,
        itemKind: intent.value.item.kind,
        itemId: intent.value.item.id,
        itemNumber: intent.value.item.number,
        snapshotRevision: intent.value.source.portfolioRevision,
      };
      const authorization = validateAuthorization(
        await consumeAuthority(authority, { grant: request.grant, intent: authorityIntent }),
        intent.revision,
      );
      const idempotencyKey = sha256({
        grantId: authorization.grantId,
        intentRevision: intent.revision,
      });
      const branch = `gaia/${intent.value.item.kind.toLowerCase()}-${intent.value.item.number}`
        + `-${intent.revision.slice(0, 12)}`;
      const isIssue = intent.value.item.kind === 'ISSUE';
      const commitOid = validateCommit(await invokeEffect('Commit', () => effects.commit({
        repository: intent.repo,
        branch,
        expectedHeadOid: observation.headOid,
        changeSetIdentity: observation.changeSetIdentity,
        message: isIssue
          ? `chore: resolve issue #${intent.value.item.number}`
          : `chore: follow up pull request #${intent.value.item.number}`,
        idempotencyKey,
      })));
      validatePush(await invokeEffect('Push', () => effects.push({
        repository: intent.repo,
        branch,
        commitOid,
        expectedBaseOid: observation.baseOid,
        idempotencyKey,
      })), commitOid);
      const pullRequest = validatePullRequest(await invokeEffect(
        'OpenPullRequest', () => effects.openPullRequest({
        repository: intent.repo,
        branch,
        commitOid,
        baseOid: observation.baseOid,
        title: isIssue
          ? `Resolve issue #${intent.value.item.number}`
          : `Follow up pull request #${intent.value.item.number}`,
        body: isIssue
          ? `Closes #${intent.value.item.number}`
          : `Follow-up to #${intent.value.item.number}`,
        idempotencyKey,
        }),
      ), commitOid, intent.repo);

      const body = {
        schema: GITHUB_CANDIDATE_PUBLICATION_RECEIPT_SCHEMA,
        status: 'completed',
        repository: intent.repo,
        item: { ...intent.value.item },
        intentRevision: intent.revision,
        authorization: { status: 'AUTHORIZED', grantId: authorization.grantId },
        idempotencyKey,
        branch,
        commitOid,
        pullRequest,
      };
      return { ...body, revision: sha256(body) };
    },
  });
}
