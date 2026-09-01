import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isExactInstant } from './local-lane-observation.mjs';

const GIT_OID = /^[a-f0-9]{40}$/u;
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

function ownDataObject(value, fields, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(code, code);
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
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(code, code);
  return new Date(value).toISOString();
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
  ownDataObject(value, ['repository', 'workItem'], code);
  ownDataObject(value.repository, ['owner', 'name'], code);
  ownDataObject(value.workItem, ['kind', 'number'], code);
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
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
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

function flattenPages(value, code) {
  if (!Array.isArray(value) || value.some((page) => !Array.isArray(page))) fail(code, code);
  return value.flat();
}

export function createGhDraftCollectorApi({ run = runGh } = {}) {
  if (typeof run !== 'function') fail('InvalidGhAdapter', 'run must be a function');

  return Object.freeze({
    async resolveRepository({ owner, name }) {
      const requestedOwner = githubSegment(owner, 'RepositoryObservationInvalid');
      const requestedName = githubSegment(name, 'RepositoryObservationInvalid');
      const raw = requireRawObject(await run([
        'api', `repos/${encodeURIComponent(requestedOwner)}/${encodeURIComponent(requestedName)}`,
      ]), 'RepositoryObservationInvalid');
      const canonicalOwner = githubSegment(raw.owner?.login, 'RepositoryObservationInvalid');
      const canonicalName = githubSegment(raw.name, 'RepositoryObservationInvalid');
      const defaultBranch = text(raw.default_branch, 'RepositoryObservationInvalid');
      const base = requireRawObject(await run([
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
      const raw = requireRawObject(await run([
        'api', `repos/${path}/issues/${positiveInteger(number, 'IssueObservationInvalid')}`,
      ]), 'IssueObservationInvalid');
      const pages = flattenPages(await run([
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
      const raw = requireRawObject(await run([
        'api', `repos/${repositoryPath(repository)}/collaborators/`
          + `${encodeURIComponent(githubSegment(login, 'PermissionObservationInvalid'))}/permission`,
      ]), 'PermissionObservationInvalid');
      return text(raw.permission, 'PermissionObservationInvalid').toUpperCase();
    },

    async listHeadRefs({ repository }) {
      const pages = flattenPages(await run([
        'api', `repos/${repositoryPath(repository)}/git/matching-refs/heads/?per_page=100`,
        '--paginate', '--slurp',
      ]), 'HeadObservationInvalid');
      return pages.map((row) => ({
        name: text(row?.ref, 'HeadObservationInvalid').replace(/^refs\/heads\//u, ''),
        revision: oid(row?.object?.sha, 'HeadObservationInvalid'),
      }));
    },

    async readCommit({ repository, revision }) {
      const raw = requireRawObject(await run([
        'api', `repos/${repositoryPath(repository)}/git/commits/${oid(revision, 'CommitObservationInvalid')}`,
      ]), 'CommitObservationInvalid');
      return { message: commitMessage(raw.message) };
    },

    async readPolicy({ repository, baseRevision }) {
      const raw = requireRawObject(await run([
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
  if (!value.labels.includes('ready-for-agent')) fail('IssueNotReady', 'issue is not ready');
  const labelEvents = value.labelEvents.map(requireLabelEvent);
  for (let index = 1; index < labelEvents.length; index += 1) {
    if (labelEvents[index - 1].createdAt > labelEvents[index].createdAt) {
      fail(code, 'label events are not chronological');
    }
  }
  const readyEvents = labelEvents.filter((event) => event.label === 'ready-for-agent');
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

async function selectHead(github, repository, issueNumber, queueReceiptRevision) {
  const rows = await github.listHeadRefs({ repository });
  if (!Array.isArray(rows)) fail('HeadObservationInvalid', 'head refs must be an array');
  const matching = [];
  for (const row of rows) {
    ownDataObject(row, ['name', 'revision'], 'HeadObservationInvalid');
    const head = { name: text(row.name, 'HeadObservationInvalid'), revision: oid(row.revision, 'HeadObservationInvalid') };
    const commit = await github.readCommit({ repository, revision: head.revision });
    ownDataObject(commit, ['message'], 'CommitObservationInvalid');
    if (exactTrailer(commit.message, 'Gaia-Issue', String(issueNumber))
        && exactTrailer(commit.message, 'Gaia-Ready-Receipt', queueReceiptRevision)) matching.push(head);
  }
  if (matching.length !== 1) fail('HeadIdentityAmbiguous', 'exactly one evidence head is required');
  return matching[0];
}

export function createHostedDraftCollector({ github }) {
  ownDataObject({ github }, ['github'], 'InvalidCollectorPorts');
  if (github === null || typeof github !== 'object'
      || REQUIRED_METHODS.some((method) => typeof github[method] !== 'function')) {
    fail('InvalidCollectorPorts', 'the closed GitHub observation port is required');
  }

  return Object.freeze({
    async collect(selectorInput) {
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
      const head = await selectHead(
        github, repository, selector.workItem.number, queueReceiptRevision,
      );
      const policy = await github.readPolicy({
        repository, baseRevision: repository.defaultBranchRevision,
      });
      ownDataObject(policy, ['revision'], 'PolicyObservationInvalid');
      const policyRevision = oid(policy.revision, 'PolicyObservationInvalid');
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
