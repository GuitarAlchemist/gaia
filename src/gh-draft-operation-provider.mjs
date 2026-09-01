import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_OID = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/u;

export class GhDraftOperationProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GhDraftOperationProviderError';
    this.code = code;
  }
}

function fail(code) {
  throw new GhDraftOperationProviderError(code);
}

function ownDataKeys(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) fail(code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
  }
  return keys;
}

function exactKeys(value, expected, code) {
  const keys = ownDataKeys(value, code).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) fail(code);
}

function text(value, code, maximum = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function repository(value, code) {
  exactKeys(value, ['nodeId', 'owner', 'name'], code);
  const nodeId = text(value.nodeId, code);
  const owner = text(value.owner, code);
  const name = text(value.name, code);
  if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) fail(code);
  return Object.freeze({ nodeId, owner, name });
}

function branch(value, code) {
  const candidate = text(value, code);
  if (!BRANCH.test(candidate) || candidate.includes('..') || candidate.endsWith('.lock')) fail(code);
  return candidate;
}

function gitOid(value, code) {
  if (typeof value !== 'string' || !GIT_OID.test(value)) fail(code);
  return value;
}

function operationMarker(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

function sameRepository(left, right) {
  return left.nodeId === right.nodeId && left.owner === right.owner && left.name === right.name;
}

function validateRequest(value, expectedRepository) {
  const code = 'InvalidRequest';
  exactKeys(value, [
    'repository', 'baseRef', 'headRef', 'headRevision', 'operationMarker', 'workItem',
  ], code);
  const candidateRepository = repository(value.repository, code);
  if (!sameRepository(candidateRepository, expectedRepository)) fail('RequestBindingMismatch');
  exactKeys(value.workItem, ['kind', 'number'], code);
  if (value.workItem.kind !== 'ISSUE' || !Number.isSafeInteger(value.workItem.number)
    || value.workItem.number <= 0) fail(code);
  return Object.freeze({
    repository: expectedRepository,
    baseRef: branch(value.baseRef, code),
    headRef: branch(value.headRef, code),
    headRevision: gitOid(value.headRevision, code),
    operationMarker: operationMarker(value.operationMarker, code),
    workItem: Object.freeze({ kind: 'ISSUE', number: value.workItem.number }),
  });
}

function presentation(value) {
  const code = 'InvalidPresentation';
  exactKeys(value, ['owner', 'gate', 'checklist', 'eta'], code);
  const owner = text(value.owner, code, 120);
  const gate = text(value.gate, code, 120);
  if (!Array.isArray(value.checklist) || value.checklist.length === 0
    || value.checklist.length > 8) fail(code);
  const checklist = Object.freeze(value.checklist.map((item) => text(item, code, 160)));
  exactKeys(value.eta, ['minimumMinutes', 'maximumMinutes'], code);
  const { minimumMinutes, maximumMinutes } = value.eta;
  if (!Number.isSafeInteger(minimumMinutes) || minimumMinutes <= 0
    || !Number.isSafeInteger(maximumMinutes) || maximumMinutes < minimumMinutes) fail(code);
  return Object.freeze({
    owner, gate, checklist,
    eta: Object.freeze({ minimumMinutes, maximumMinutes }),
  });
}

function boundPresentation(template, request) {
  return Object.freeze({
    ...template,
    title: `draft: deliver issue #${request.workItem.number}`,
    issueUrl: `https://github.com/${request.repository.owner}/${request.repository.name}`
      + `/issues/${request.workItem.number}`,
  });
}

function markerLine(marker) {
  return `<!-- gaia-operation:${marker} -->`;
}

function renderBody(display, marker) {
  return [
    markerLine(marker),
    `Issue: ${display.issueUrl}`,
    `Owner: ${display.owner}`,
    `Gate: ${display.gate}`,
    `ETA: ${display.eta.minimumMinutes}-${display.eta.maximumMinutes} minutes`,
    '',
    'Checklist:',
    ...display.checklist.map((item) => `- [ ] ${item}`),
  ].join('\n');
}

function hasExactMarker(body, marker) {
  if (typeof body !== 'string') return false;
  return body.split(/\r?\n/u).filter((line) => line === markerLine(marker)).length === 1;
}

function parseJson(stdout) {
  try {
    return JSON.parse(String(stdout).trim());
  } catch {
    fail('ProviderProtocolViolation');
  }
}

function validateCandidate(candidate, request) {
  const code = 'ProviderConflict';
  exactKeys(candidate, [
    'number', 'url', 'isDraft', 'state', 'baseRefName', 'headRefName', 'headRefOid',
    'headRepositoryOwner', 'body',
  ], code);
  exactKeys(candidate.headRepositoryOwner, ['login'], code);
  const match = typeof candidate.url === 'string' ? PULL_REQUEST_URL.exec(candidate.url) : null;
  if (!Number.isSafeInteger(candidate.number) || candidate.number <= 0
    || match === null || Number(match[3]) !== candidate.number
    || match[1] !== request.repository.owner || match[2] !== request.repository.name
    || candidate.isDraft !== true || candidate.state !== 'OPEN'
    || candidate.baseRefName !== request.baseRef || candidate.headRefName !== request.headRef
    || candidate.headRefOid !== request.headRevision
    || candidate.headRepositoryOwner.login !== request.repository.owner
    || !hasExactMarker(candidate.body, request.operationMarker)) fail(code);
  return Object.freeze({
    number: candidate.number,
    url: candidate.url,
    isDraft: true,
    state: 'OPEN',
    operationMarker: request.operationMarker,
    repository: request.repository,
    baseRef: request.baseRef,
    headRef: request.headRef,
    headRevision: request.headRevision,
  });
}

async function defaultRun(command, args, options) {
  return execFileAsync(command, args, options);
}

export function createGhDraftOperationProvider({
  expectedRepository,
  presentation: suppliedPresentation,
  run = defaultRun,
}) {
  const expected = repository(expectedRepository, 'InvalidConfiguration');
  const displayTemplate = presentation(suppliedPresentation);
  if (typeof run !== 'function') fail('InvalidAdapter');
  const repositoryName = `${expected.owner}/${expected.name}`;
  const invoke = async (...args) => {
    try {
      const result = await run('gh', args, {
        encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true,
      });
      return String(result?.stdout ?? '');
    } catch {
      fail('ProviderUnavailable');
    }
  };
  const assertRepositoryIdentity = async () => {
    const observed = parseJson(await invoke(
      'repo', 'view', repositoryName, '--json', 'id,nameWithOwner',
    ));
    exactKeys(observed, ['id', 'nameWithOwner'], 'ProviderProtocolViolation');
    if (observed.id !== expected.nodeId || observed.nameWithOwner !== repositoryName) {
      fail('RepositoryIdentityMismatch');
    }
  };
  const lookup = async (request) => {
    await assertRepositoryIdentity();
    const candidates = parseJson(await invoke(
      'pr', 'list', '--repo', repositoryName, '--state', 'open',
      '--head', request.headRef, '--limit', '100', '--json',
      'number,url,isDraft,state,baseRefName,headRefName,headRefOid,headRepositoryOwner,body',
    ));
    if (!Array.isArray(candidates)) fail('ProviderProtocolViolation');
    if (candidates.length === 0) return null;
    const marked = candidates.filter((candidate) => hasExactMarker(
      candidate?.body, request.operationMarker,
    ));
    if (marked.length > 1 || candidates.length > 1) fail('ProviderAmbiguous');
    if (marked.length === 0) fail('ProviderConflict');
    return validateCandidate(marked[0], request);
  };

  return Object.freeze({
    async lookupExact(requestInput) {
      return lookup(validateRequest(requestInput, expected));
    },

    async createDraft(requestInput) {
      const request = validateRequest(requestInput, expected);
      const existing = await lookup(request);
      if (existing !== null) fail('ProviderConflict');
      const encodedHead = encodeURIComponent(request.headRef);
      const observedHead = (await invoke(
        'api', `repos/${repositoryName}/git/ref/heads/${encodedHead}`,
        '--jq', '.object.sha',
      )).trim();
      if (!GIT_OID.test(observedHead)) fail('ProviderProtocolViolation');
      if (observedHead !== request.headRevision) fail('RequestBindingMismatch');
      const display = boundPresentation(displayTemplate, request);
      const body = renderBody(display, request.operationMarker);
      const createdUrl = (await invoke(
        'pr', 'create', '--repo', repositoryName, '--draft', '--base', request.baseRef,
        '--head', `${expected.owner}:${request.headRef}`, '--title', display.title,
        '--body', body,
      )).trim();
      const match = PULL_REQUEST_URL.exec(createdUrl);
      if (match === null || match[1] !== expected.owner || match[2] !== expected.name
        || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= 0) {
        fail('ProviderProtocolViolation');
      }
      const created = parseJson(await invoke(
        'pr', 'view', match[3], '--repo', repositoryName, '--json',
        'number,url,isDraft,state,baseRefName,headRefName,headRefOid,headRepositoryOwner,body',
      ));
      const validated = validateCandidate(created, request);
      if (validated.url !== createdUrl) fail('ProviderProtocolViolation');
      return validated;
    },
  });
}
