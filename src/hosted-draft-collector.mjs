import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ghFailure, isRateLimited } from './gh-failure.mjs';
import { isExactInstant } from './local-lane-observation.mjs';

const GIT_OID = /^[a-f0-9]{40}$/u;
const GITHUB_SECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const READY_LABEL = 'ready-for-agent';
const ALLOWED_PERMISSIONS = new Set(['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']);
const REQUIRED_METHODS = Object.freeze([
  'resolveRepository', 'readIssue', 'readPermission', 'listHeadRefs', 'readCommit', 'readPolicy',
]);
const execFileAsync = promisify(execFile);

export class HostedDraftCollectorError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'HostedDraftCollectorError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new HostedDraftCollectorError(code, message);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
  ).join(',')}}`;
}

const sha256 = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function ownDataObject(value, fields, code, allowNullPrototype = false) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype
        && !(allowNullPrototype && Object.getPrototypeOf(value) === null))) fail(code, code);
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => typeof key !== 'string')
      || keys.length !== fields.length
      || keys.some((key) => !fields.includes(key))
      || keys.some((key) => !descriptors[key]?.enumerable
        || !Object.hasOwn(descriptors[key], 'value'))) fail(code, code);
  return value;
}

function text(value, code) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(code, code);
  }
  return value;
}

function commitMessage(value) {
  if (typeof value !== 'string' || value.length === 0 || /\u0000/u.test(value)) {
    fail('CommitObservationInvalid', 'commit message is invalid');
  }
  return value;
}

function providerInstant(value, code) {
  const normalized = typeof value === 'string' && GITHUB_SECOND_INSTANT.test(value)
    ? `${value.slice(0, -1)}.000Z`
    : value;
  if (!isExactInstant(normalized)) fail(code, code);
  return normalized;
}

function oid(value, code) {
  if (typeof value !== 'string' || !GIT_OID.test(value)) fail(code, code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, code);
  return value;
}

function githubSegment(value, code) {
  const segment = text(value, code);
  if (!/^[A-Za-z0-9_.-]+$/u.test(segment)) fail(code, code);
  return segment;
}

function requireSelector(value) {
  const code = 'InvalidSelector';
  ownDataObject(value, ['repository', 'workItem'], code, true);
  ownDataObject(value.repository, ['owner', 'name'], code, true);
  ownDataObject(value.workItem, ['kind', 'number'], code, true);
  if (value.workItem.kind !== 'ISSUE') fail(code, code);
  return {
    repository: { owner: text(value.repository.owner, code), name: text(value.repository.name, code) },
    workItem: { kind: 'ISSUE', number: positiveInteger(value.workItem.number, code) },
  };
}

function requireRepository(value) {
  const code = 'RepositoryObservationInvalid';
  ownDataObject(value, [
    'nodeId', 'owner', 'name', 'defaultBranch', 'defaultBranchRevision',
  ], code);
  return {
    nodeId: text(value.nodeId, code),
    owner: githubSegment(value.owner, code),
    name: githubSegment(value.name, code),
    defaultBranch: text(value.defaultBranch, code),
    defaultBranchRevision: oid(value.defaultBranchRevision, code),
  };
}

async function runGh(args) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('gh', args, {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    }));
  } catch (error) {
    throw ghFailure(error?.stderr);
  }
  const output = stdout.trim();
  if (output.length === 0) return null;
  return JSON.parse(output);
}

function repositoryPath(repository) {
  return `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function requireRawObject(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code, code);
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, code);
  return value;
}

/**
 * What the intake reads to keep only the frontier: open native blockers, sub-issues, and the body
 * whose `Blocked by` lines are the fallback. `blocked_by` counts open blockers; the total would
 * also count closed ones. A row without its summaries cannot prove nothing blocks it, so it refuses.
 */
function dependencyFacts(raw) {
  const code = 'IssueObservationInvalid';
  if (raw.body !== null && typeof raw.body !== 'string') fail(code, code);
  return {
    number: positiveInteger(raw.number, code),
    body: raw.body ?? '',
    openBlockers: nonNegativeInteger(raw.issue_dependencies_summary?.blocked_by, code),
    subIssues: nonNegativeInteger(raw.sub_issues_summary?.total, code),
  };
}

function flattenPages(value, code) {
  if (!Array.isArray(value) || value.some((page) => !Array.isArray(page))) fail(code, code);
  return value.flat();
}

/**
 * Every branch with its tip commit's message, a page of one hundred per GraphQL call. The collector
 * must see every tip to prove exactly one carries the evidence trailers; reading each tip over REST
 * cost one call per branch per issue, and a busy evening of intakes spent the pump App's hourly
 * quota on it.
 */
const HEAD_COMMITS_QUERY = [
  'query($owner: String!, $name: String!, $endCursor: String) {',
  '  repository(owner: $owner, name: $name) {',
  '    refs(refPrefix: "refs/heads/", first: 100, after: $endCursor) {',
  '      pageInfo { hasNextPage endCursor }',
  '      nodes { name target { __typename oid ... on Commit { message } } }',
  '    }',
  '  }',
  '}',
].join('\n');

function headCommitNodes(pages) {
  const code = 'HeadObservationInvalid';
  if (!Array.isArray(pages)) fail(code, code);
  return pages.flatMap((page) => {
    const nodes = page?.data?.repository?.refs?.nodes;
    if (!Array.isArray(nodes)) fail(code, code);
    return nodes;
  });
}

// Bounds the messages one adapter keeps; a single intake run lists far fewer branches than this.
const COMMIT_MESSAGE_CACHE_LIMIT = 4096;

export function createGhDraftCollectorApi({ run = runGh } = {}) {
  if (typeof run !== 'function') fail('InvalidGhAdapter', 'run must be a function');
  const call = async (args) => {
    try {
      return await run(args);
    } catch (error) {
      if (isRateLimited(error)) fail('GitHubRateLimited', 'GitHub rate limit reached');
      fail('GitHubObservationUnavailable', 'GitHub observation is unavailable');
    }
  };

  // A commit is immutable, so the message the head listing returned for a tip is the message a
  // later read of that commit would return. `readCommit` answers from here and reaches GitHub only
  // for a revision no listing named.
  const commitMessages = new Map();
  const messageKey = (repository, revision) => `${repositoryPath(repository)}\0${revision}`;
  const rememberMessage = (key, message) => {
    if (commitMessages.has(key)) return;
    if (commitMessages.size >= COMMIT_MESSAGE_CACHE_LIMIT) {
      commitMessages.delete(commitMessages.keys().next().value);
    }
    commitMessages.set(key, message);
  };

  return Object.freeze({
    async resolveRepository({ owner, name }) {
      const requestedOwner = githubSegment(owner, 'RepositoryObservationInvalid');
      const requestedName = githubSegment(name, 'RepositoryObservationInvalid');
      const raw = requireRawObject(await call([
        'api', `repos/${encodeURIComponent(requestedOwner)}/${encodeURIComponent(requestedName)}`,
      ]), 'RepositoryObservationInvalid');
      const canonicalOwner = githubSegment(raw.owner?.login, 'RepositoryObservationInvalid');
      const canonicalName = githubSegment(raw.name, 'RepositoryObservationInvalid');
      const defaultBranch = text(raw.default_branch, 'RepositoryObservationInvalid');
      const base = requireRawObject(await call([
        'api', `repos/${encodeURIComponent(canonicalOwner)}/${encodeURIComponent(canonicalName)}`
          + `/commits/${encodeURIComponent(defaultBranch)}`,
      ]), 'RepositoryObservationInvalid');
      return {
        nodeId: text(raw.node_id, 'RepositoryObservationInvalid'),
        owner: canonicalOwner,
        name: canonicalName,
        defaultBranch,
        defaultBranchRevision: oid(base.sha, 'RepositoryObservationInvalid'),
      };
    },

    async readIssue({ repository, number }) {
      const path = repositoryPath(repository);
      const raw = requireRawObject(await call([
        'api', `repos/${path}/issues/${positiveInteger(number, 'IssueObservationInvalid')}`,
      ]), 'IssueObservationInvalid');
      const pages = flattenPages(await call([
        'api', `repos/${path}/issues/${number}/events?per_page=100`, '--paginate', '--slurp',
      ]), 'IssueObservationInvalid');
      if (!Array.isArray(raw.labels)) fail('IssueObservationInvalid', 'issue labels are absent');
      return {
        nodeId: text(raw.node_id, 'IssueObservationInvalid'),
        number: positiveInteger(raw.number, 'IssueObservationInvalid'),
        state: String(raw.state).toUpperCase(),
        updatedAt: providerInstant(raw.updated_at, 'IssueObservationInvalid'),
        labels: raw.labels.map((label) => text(label?.name, 'IssueObservationInvalid')),
        labelEvents: pages.filter((event) => event?.event === 'labeled').map((event) => ({
          nodeId: text(event.node_id, 'IssueObservationInvalid'),
          label: text(event.label?.name, 'IssueObservationInvalid'),
          createdAt: providerInstant(event.created_at, 'IssueObservationInvalid'),
          actor: {
            nodeId: text(event.actor?.node_id, 'IssueObservationInvalid'),
            login: githubSegment(event.actor?.login, 'IssueObservationInvalid'),
          },
        })),
      };
    },

    async readPermission({ repository, login }) {
      const raw = requireRawObject(await call([
        'api', `repos/${repositoryPath(repository)}/collaborators/`
          + `${encodeURIComponent(githubSegment(login, 'PermissionObservationInvalid'))}/permission`,
      ]), 'PermissionObservationInvalid');
      return text(raw.permission, 'PermissionObservationInvalid').toUpperCase();
    },

    async listHeadRefs({ repository }) {
      const nodes = headCommitNodes(await call([
        'api', 'graphql', '--paginate', '--slurp',
        '-f', `owner=${githubSegment(repository.owner, 'HeadObservationInvalid')}`,
        '-f', `name=${githubSegment(repository.name, 'HeadObservationInvalid')}`,
        '-f', `query=${HEAD_COMMITS_QUERY}`,
      ]));
      const heads = nodes.map((node) => {
        const target = requireRawObject(node?.target, 'HeadObservationInvalid');
        if (target.__typename !== 'Commit') fail('HeadObservationInvalid', 'HeadObservationInvalid');
        return {
          name: text(node.name, 'HeadObservationInvalid'),
          revision: oid(target.oid, 'HeadObservationInvalid'),
          message: commitMessage(target.message),
        };
      });
      for (const head of heads) rememberMessage(messageKey(repository, head.revision), head.message);
      return heads.map(({ name, revision }) => ({ name, revision }));
    },

    async readCommit({ repository, revision }) {
      const known = commitMessages.get(
        messageKey(repository, oid(revision, 'CommitObservationInvalid')),
      );
      if (known !== undefined) return { message: known };
      const raw = requireRawObject(await call([
        'api', `repos/${repositoryPath(repository)}/git/commits/${revision}`,
      ]), 'CommitObservationInvalid');
      return { message: commitMessage(raw.message) };
    },

    async listReadyIssues({ repository }) {
      const pages = flattenPages(await call([
        'api', `repos/${repositoryPath(repository)}/issues`
          + `?state=open&labels=${encodeURIComponent(READY_LABEL)}&per_page=100`,
        '--paginate', '--slurp',
      ]), 'IssueObservationInvalid');
      return pages
        .filter((row) => row !== null && typeof row === 'object'
          && !Object.hasOwn(row, 'pull_request'))
        .map(dependencyFacts)
        .sort((left, right) => left.number - right.number);
    },

    async readIssueDependencies({ repository, number }) {
      const raw = requireRawObject(await call([
        'api', `repos/${repositoryPath(repository)}/issues/`
          + `${positiveInteger(number, 'IssueObservationInvalid')}`,
      ]), 'IssueObservationInvalid');
      return {
        ...dependencyFacts(raw),
        state: text(raw.state, 'IssueObservationInvalid').toUpperCase(),
      };
    },

    async readPolicy({ repository, baseRevision }) {
      const raw = requireRawObject(await call([
        'api', `repos/${repositoryPath(repository)}/contents/.github/gaia/pump-policy.json`
          + `?ref=${encodeURIComponent(oid(baseRevision, 'PolicyObservationInvalid'))}`,
      ]), 'PolicyObservationInvalid');
      return { revision: oid(raw.sha, 'PolicyObservationInvalid') };
    },
  });
}

function requireActor(value) {
  const code = 'IssueObservationInvalid';
  ownDataObject(value, ['nodeId', 'login'], code);
  return { nodeId: text(value.nodeId, code), login: text(value.login, code) };
}

function requireLabelEvent(value) {
  const code = 'IssueObservationInvalid';
  ownDataObject(value, ['nodeId', 'label', 'createdAt', 'actor'], code);
  if (!isExactInstant(value.createdAt)) fail(code, code);
  return {
    nodeId: text(value.nodeId, code),
    label: text(value.label, code),
    createdAt: value.createdAt,
    actor: requireActor(value.actor),
  };
}

function requireIssue(value, number) {
  const code = 'IssueObservationInvalid';
  ownDataObject(value, [
    'nodeId', 'number', 'state', 'updatedAt', 'labels', 'labelEvents',
  ], code);
  if (value.number !== number || value.state !== 'OPEN' || !isExactInstant(value.updatedAt)
      || !Array.isArray(value.labels) || !Array.isArray(value.labelEvents)
      || value.labels.some((label) => typeof label !== 'string')) fail(code, code);
  if (!value.labels.includes(READY_LABEL)) fail('IssueNotReady', 'issue is not ready');
  const labelEvents = value.labelEvents.map(requireLabelEvent);
  for (let index = 1; index < labelEvents.length; index += 1) {
    if (labelEvents[index - 1].createdAt > labelEvents[index].createdAt) {
      fail(code, 'label events are not chronological');
    }
  }
  const readyEvents = labelEvents.filter((event) => event.label === READY_LABEL);
  if (readyEvents.length === 0) fail('ReadyReceiptMissing', 'ready label event is absent');
  return {
    nodeId: text(value.nodeId, code),
    updatedAt: value.updatedAt,
    readyEvent: readyEvents.at(-1),
    occurrence: readyEvents.length,
  };
}

function exactTrailer(message, name, expected) {
  if (typeof message !== 'string') return false;
  const matches = message.split(/\r?\n/u).filter((line) => line === `${name}: ${expected}`);
  return matches.length === 1;
}

/**
 * The two trailer lines an evidence commit must carry, each exactly once. The seeder writes these
 * and `findEvidenceHeads` reads them, so the producer cannot drift from the collector.
 */
export function evidenceTrailerLines(issueNumber, queueReceiptRevision) {
  return [
    `Gaia-Issue: ${positiveInteger(issueNumber, 'InvalidSelector')}`,
    `Gaia-Ready-Receipt: ${text(queueReceiptRevision, 'InvalidSelector')}`,
  ];
}

/**
 * Every branch whose tip commit carries this issue's evidence trailers for this exact ready
 * receipt. The collector requires exactly one; zero and several both refuse.
 */
export async function findEvidenceHeads(
  github, repository, issueNumber, queueReceiptRevision, readMessage = directCommitReader(github, repository),
) {
  const rows = await github.listHeadRefs({ repository });
  if (!Array.isArray(rows)) fail('HeadObservationInvalid', 'head refs must be an array');
  const heads = rows.map((row) => {
    ownDataObject(row, ['name', 'revision'], 'HeadObservationInvalid');
    return { name: text(row.name, 'HeadObservationInvalid'), revision: oid(row.revision, 'HeadObservationInvalid') };
  });
  const messages = await mapBounded(heads, COMMIT_READ_CONCURRENCY, (head) => readMessage(head.revision));
  return heads.filter((head, index) => exactTrailer(messages[index], 'Gaia-Issue', String(issueNumber))
    && exactTrailer(messages[index], 'Gaia-Ready-Receipt', queueReceiptRevision));
}

// Bounded fan-out over head commits: a serial read per branch made one intake cost
// minutes per ready issue and outlive the normal-admission window.
const COMMIT_READ_CONCURRENCY = 8;

async function mapBounded(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function directCommitReader(github, repository) {
  return async (revision) => {
    const commit = await github.readCommit({ repository, revision });
    ownDataObject(commit, ['message'], 'CommitObservationInvalid');
    return commit.message;
  };
}

async function selectHead(github, repository, issueNumber, queueReceiptRevision, readMessage) {
  const matching = await findEvidenceHeads(github, repository, issueNumber, queueReceiptRevision, readMessage);
  if (matching.some((head) => head.name === repository.defaultBranch)) {
    fail('DefaultBranchSourceRejected', 'the repository default branch cannot be a Draft source');
  }
  if (matching.length !== 1) fail('HeadIdentityAmbiguous', 'exactly one evidence head is required');
  return matching[0];
}

async function requireStableHeadReadBack(github, repository, expectedHead) {
  const rows = await github.listHeadRefs({ repository });
  if (!Array.isArray(rows)) fail('HeadObservationInvalid', 'head refs must be an array');
  const revisions = [];
  for (const row of rows) {
    ownDataObject(row, ['name', 'revision'], 'HeadObservationInvalid');
    const name = text(row.name, 'HeadObservationInvalid');
    const revision = oid(row.revision, 'HeadObservationInvalid');
    if (name === expectedHead.name) revisions.push(revision);
  }
  if (revisions.length !== 1 || revisions[0] !== expectedHead.revision) {
    fail('SourceRevisionMoved', 'source revisions moved during collection');
  }
}

/**
 * The ready receipt that the latest `ready-for-agent` label event establishes, when that event's
 * actor holds triage or stronger. The collector and the evidence-head seeder both derive
 * `queueReceiptRevision` here, so a seeded branch always names the receipt the collector expects.
 */
export async function observeReadyReceipt(github, selectorInput) {
  if (github === null || typeof github !== 'object'
      || ['resolveRepository', 'readIssue', 'readPermission'].some(
        (method) => typeof github[method] !== 'function',
      )) {
    fail('InvalidCollectorPorts', 'the closed GitHub observation port is required');
  }
  const selector = requireSelector(selectorInput);
  const repository = requireRepository(await github.resolveRepository({
    owner: selector.repository.owner, name: selector.repository.name,
  }));
  const issue = requireIssue(await github.readIssue({
    repository, number: selector.workItem.number,
  }), selector.workItem.number);
  const permission = await github.readPermission({
    repository, login: issue.readyEvent.actor.login,
  });
  if (!ALLOWED_PERMISSIONS.has(permission)) {
    fail('ReadyActorUnauthorized', 'ready-label actor lacks triage permission');
  }

  const queueReceiptRevision = sha256({
    schema: 'GaiaQueueReceiptRevisionV0',
    issueNodeId: issue.nodeId,
    readyLabelEventNodeId: issue.readyEvent.nodeId,
    readyLabelEventAt: issue.readyEvent.createdAt,
    readyLabelActorNodeId: issue.readyEvent.actor.nodeId,
  });
  return { selector, repository, issue, queueReceiptRevision };
}

export function createHostedDraftCollector({ github }) {
  ownDataObject({ github }, ['github'], 'InvalidCollectorPorts');
  if (github === null || typeof github !== 'object'
      || REQUIRED_METHODS.some((method) => typeof github[method] !== 'function')) {
    fail('InvalidCollectorPorts', 'the closed GitHub observation port is required');
  }

  // A Git commit is immutable, so its message is read at most once per collector (one
  // intake run), whichever issue asks. Only successful reads are kept; a failed read is
  // retried by the next caller and still fails that collection.
  const commitMessages = new Map();
  function commitReader(repository) {
    const direct = directCommitReader(github, repository);
    return (revision) => {
      const key = `${repository.nodeId}\0${revision}`;
      if (!commitMessages.has(key)) {
        const read = direct(revision);
        commitMessages.set(key, read);
        read.catch(() => { if (commitMessages.get(key) === read) commitMessages.delete(key); });
      }
      return commitMessages.get(key);
    };
  }

  return Object.freeze({
    async collect(selectorInput) {
      const {
        selector, repository, issue, queueReceiptRevision,
      } = await observeReadyReceipt(github, selectorInput);
      const head = await selectHead(
        github, repository, selector.workItem.number, queueReceiptRevision, commitReader(repository),
      );
      const policy = await github.readPolicy({
        repository, baseRevision: repository.defaultBranchRevision,
      });
      ownDataObject(policy, ['revision'], 'PolicyObservationInvalid');
      const policyRevision = oid(policy.revision, 'PolicyObservationInvalid');
      const baseReadBack = requireRepository(await github.resolveRepository({
        owner: repository.owner, name: repository.name,
      }));
      if (baseReadBack.nodeId !== repository.nodeId
          || baseReadBack.owner !== repository.owner
          || baseReadBack.name !== repository.name
          || baseReadBack.defaultBranch !== repository.defaultBranch
          || baseReadBack.defaultBranchRevision !== repository.defaultBranchRevision) {
        fail('SourceRevisionMoved', 'source revisions moved during collection');
      }
      await requireStableHeadReadBack(github, repository, head);
      const observedSourceRevision = sha256({
        schema: 'GaiaObservedSourceRevisionV0',
        repositoryNodeId: repository.nodeId,
        canonicalOwner: repository.owner,
        canonicalName: repository.name,
        issueNodeId: issue.nodeId,
        issueUpdatedAt: issue.updatedAt,
        readyLabelEventNodeId: issue.readyEvent.nodeId,
        baseRef: repository.defaultBranch,
        baseRevision: repository.defaultBranchRevision,
        headRef: head.name,
        headRevision: head.revision,
        policyRevision,
      });
      const workItem = { kind: 'ISSUE', number: selector.workItem.number };
      const workKey = sha256({
        schema: 'GaiaDraftWorkKeyV0', repositoryNodeId: repository.nodeId,
        workItem, requestedEffect: 'CREATE_DRAFT',
      });
      const readyItemId = sha256({
        schema: 'GaiaReadyItemIdV0', workKey, queueReceiptRevision,
        occurrence: issue.occurrence, observedSourceRevision,
      });

      return deepFreeze({
        schema: 'GaiaDraftOperationEnvelopeV0',
        repository: { nodeId: repository.nodeId, owner: repository.owner, name: repository.name },
        workItem,
        readyItem: {
          schema: 'GaiaReadyItemIdentityV0', queueReceiptRevision,
          occurrence: issue.occurrence, id: readyItemId,
        },
        observedSourceRevision,
        generation: {
          baseRef: repository.defaultBranch,
          headRef: head.name,
          headRevision: head.revision,
          policyRevision,
        },
        requestedEffect: 'CREATE_DRAFT',
      });
    },
  });
}
