import { createHash } from 'node:crypto';

export const GITHUB_PORTFOLIO_SCHEMA = 'gaia-github-portfolio/1';

export class PortfolioFactoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortfolioFactoryError';
    this.code = code;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new PortfolioFactoryError('InvalidRequest', `${field} must be non-empty canonical text`);
  }
  return value;
}

const ordinal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function compareIdentity(left, right) {
  return ordinal(String(left.id), String(right.id));
}

function requireNumber(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PortfolioFactoryError('InvalidSnapshot', `${field} must be a positive integer`);
  }
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new PortfolioFactoryError('InvalidSnapshot', `${field} must be a boolean`);
  }
  return value;
}

function normalizeTimestamp(value, field) {
  requireText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new PortfolioFactoryError(
      'InvalidSnapshot', `${field} must include an explicit UTC or numeric timezone`,
    );
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new PortfolioFactoryError('InvalidSnapshot', `${field} must be an ISO timestamp`);
  }
  return timestamp.toISOString();
}

function normalizedTexts(value, field) {
  if (!Array.isArray(value)) {
    throw new PortfolioFactoryError('InvalidSnapshot', `${field} must be an array`);
  }
  return [...new Set(value.map((entry) => requireText(entry, field)))].sort(ordinal);
}

function normalizeRelationships(value, field) {
  if (value === 'UNKNOWN') return 'UNKNOWN';
  return normalizedTexts(value, field);
}

function normalizeDuplicate(value, field) {
  if (value === null) return null;
  if (value === 'UNKNOWN') return 'UNKNOWN';
  if (value === undefined) {
    throw new PortfolioFactoryError('InvalidSnapshot', `${field} must be explicit`);
  }
  return requireText(value, field);
}

function normalizeIssue(issue) {
  return {
    id: requireText(issue?.id, 'issue.id'),
    number: requireNumber(issue?.number, 'issue.number'),
    title: requireText(issue?.title, 'issue.title'),
    updatedAt: normalizeTimestamp(issue?.updatedAt, 'issue.updatedAt'),
    labels: normalizedTexts(issue?.labels, 'issue.labels'),
    dependencies: normalizeRelationships(issue?.dependencies, 'issue.dependencies'),
    duplicateOf: normalizeDuplicate(issue?.duplicateOf, 'issue.duplicateOf'),
  };
}

function normalizePullRequest(pullRequest) {
  return {
    id: requireText(pullRequest?.id, 'pullRequest.id'),
    number: requireNumber(pullRequest?.number, 'pullRequest.number'),
    title: requireText(pullRequest?.title, 'pullRequest.title'),
    updatedAt: normalizeTimestamp(pullRequest?.updatedAt, 'pullRequest.updatedAt'),
    isDraft: requireBoolean(pullRequest?.isDraft, 'pullRequest.isDraft'),
    headOid: requireText(pullRequest?.headOid, 'pullRequest.headOid'),
    baseOid: requireText(pullRequest?.baseOid, 'pullRequest.baseOid'),
    labels: normalizedTexts(pullRequest?.labels, 'pullRequest.labels'),
    checks: requireText(pullRequest?.checks, 'pullRequest.checks'),
    review: requireText(pullRequest?.review, 'pullRequest.review'),
    dependencies: normalizeRelationships(pullRequest?.dependencies, 'pullRequest.dependencies'),
    duplicateOf: normalizeDuplicate(pullRequest?.duplicateOf, 'pullRequest.duplicateOf'),
  };
}

function normalizeRepository(repository) {
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    throw new PortfolioFactoryError('InvalidSnapshot', 'repository must be an object');
  }
  if (!Array.isArray(repository.issues) || !Array.isArray(repository.pullRequests)) {
    throw new PortfolioFactoryError(
      'InvalidSnapshot', 'repository issues and pullRequests must be explicit arrays',
    );
  }
  return {
    id: requireText(repository.id, 'repository.id'),
    nameWithOwner: requireText(repository.nameWithOwner, 'repository.nameWithOwner'),
    archived: requireBoolean(repository.archived, 'repository.archived'),
    defaultBranchOid: requireText(repository.defaultBranchOid, 'repository.defaultBranchOid'),
    issues: [...repository.issues].map(normalizeIssue).sort(compareIdentity),
    pullRequests: [...repository.pullRequests]
      .map(normalizePullRequest).sort(compareIdentity),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function classifyIssue(repository, issue) {
  let state = 'NEEDS_TRIAGE';
  const evidenceUnknown = issue.duplicateOf === 'UNKNOWN' || issue.dependencies === 'UNKNOWN';
  if (repository.archived) state = 'ARCHIVED';
  else if (issue.duplicateOf && issue.duplicateOf !== 'UNKNOWN') state = 'DUPLICATE';
  else if (Array.isArray(issue.dependencies) && issue.dependencies.length > 0) {
    state = 'BLOCKED_DEPENDENCY';
  }
  else if ((issue.labels ?? []).includes('ready-for-human')) state = 'AWAITING_HUMAN';
  else if ((issue.labels ?? []).includes('ready-for-agent') && evidenceUnknown) {
    state = 'READY_WITH_UNKNOWN';
  }
  else if ((issue.labels ?? []).includes('ready-for-agent')) state = 'READY';
  else if (evidenceUnknown) state = 'EVIDENCE_UNKNOWN';
  return {
    repository: repository.nameWithOwner,
    itemKind: 'ISSUE',
    itemId: issue.id,
    itemNumber: issue.number,
    title: issue.title,
    state,
    updatedAt: issue.updatedAt,
  };
}

function classifyPullRequest(repository, pullRequest) {
  let state = 'BLOCKED_REVIEW';
  const relationshipUnknown = pullRequest.duplicateOf === 'UNKNOWN'
    || pullRequest.dependencies === 'UNKNOWN';
  if (repository.archived) state = 'ARCHIVED';
  else if (pullRequest.duplicateOf && pullRequest.duplicateOf !== 'UNKNOWN') state = 'DUPLICATE';
  else if (Array.isArray(pullRequest.dependencies) && pullRequest.dependencies.length > 0) {
    state = 'BLOCKED_DEPENDENCY';
  }
  else if (pullRequest.labels.includes('ready-for-human')) state = 'AWAITING_HUMAN';
  else if (pullRequest.isDraft) state = 'DRAFT';
  else if (pullRequest.checks === 'UNKNOWN' && pullRequest.review === 'UNKNOWN') {
    state = 'CHECKS_AND_REVIEW_UNKNOWN';
  } else if (pullRequest.checks === 'UNKNOWN') state = 'CHECKS_UNKNOWN';
  else if (pullRequest.review === 'UNKNOWN') state = 'REVIEW_UNKNOWN';
  else if (pullRequest.checks === 'PASS' && pullRequest.review === 'APPROVE') {
    state = relationshipUnknown ? 'READY_WITH_UNKNOWN' : 'READY';
  }
  return {
    repository: repository.nameWithOwner,
    itemKind: 'PULL_REQUEST',
    itemId: pullRequest.id,
    itemNumber: pullRequest.number,
    title: pullRequest.title,
    state,
    updatedAt: pullRequest.updatedAt,
  };
}

function buildSchedule(workItems) {
  const selectedRepositories = new Set();
  const schedule = [];
  for (const item of workItems.filter(
    ({ state }) => state === 'READY' || state === 'READY_WITH_UNKNOWN',
  )) {
    if (schedule.length === 4) break;
    if (selectedRepositories.has(item.repository)) continue;
    selectedRepositories.add(item.repository);
    schedule.push({
      lane: schedule.length + 1,
      repository: item.repository,
      itemKind: item.itemKind,
      itemId: item.itemId,
      itemNumber: item.itemNumber,
      reason: item.state === 'READY'
        ? 'READY_BY_EXPLICIT_PORTFOLIO_POLICY'
        : 'READY_WITH_EXPLICIT_UNKNOWNS',
    });
  }
  return schedule;
}

function assertUnique(values, field) {
  const observed = new Set();
  for (const value of values) {
    if (observed.has(value)) {
      throw new PortfolioFactoryError('DuplicateIdentity', `${field} contains duplicate ${value}`);
    }
    observed.add(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function buildPortfolio(snapshot, request) {
  if (!snapshot || snapshot.schema !== 'gaia-github-read-snapshot/1') {
    throw new PortfolioFactoryError('InvalidSnapshot', 'unsupported GitHub read snapshot');
  }
  if (snapshot.organization !== request.organization
      || snapshot.scope !== 'all-repositories-visible-to-adapter') {
    throw new PortfolioFactoryError('InvalidSnapshot', 'snapshot scope does not match the request');
  }
  if (snapshot.complete !== true) {
    throw new PortfolioFactoryError(
      'PortfolioIncomplete', 'the GitHub adapter did not prove complete pagination',
    );
  }

  if (!Array.isArray(snapshot.repositories)) {
    throw new PortfolioFactoryError('InvalidSnapshot', 'snapshot.repositories must be an array');
  }
  const repositories = [...snapshot.repositories]
    .map(normalizeRepository)
    .sort(compareIdentity);
  assertUnique(repositories.map(({ id }) => id), 'repository identities');
  assertUnique(repositories.map(({ nameWithOwner }) => nameWithOwner), 'repository names');
  const workItems = repositories.flatMap((repository) => [
    ...repository.issues.map((issue) => classifyIssue(repository, issue)),
    ...repository.pullRequests.map((pullRequest) => classifyPullRequest(repository, pullRequest)),
  ]).sort((left, right) => ordinal(left.repository, right.repository)
    || ordinal(left.itemKind, right.itemKind)
    || left.itemNumber - right.itemNumber);
  assertUnique(workItems.map(({ itemId }) => itemId), 'work item identities');
  const schedule = buildSchedule(workItems);
  const body = {
    schema: GITHUB_PORTFOLIO_SCHEMA,
    organization: request.organization,
    scope: snapshot.scope,
    policyRevision: request.policyRevision,
    complete: true,
    counts: {
      repositories: repositories.length,
      issues: repositories.reduce((count, repository) => count + repository.issues.length, 0),
      pullRequests: repositories.reduce(
        (count, repository) => count + repository.pullRequests.length, 0,
      ),
    },
    repositories,
    workItems,
    schedule,
  };
  return deepFreeze({ ...body, revision: sha256(canonicalJson(body)) });
}

function verifyPortfolio(portfolio) {
  if (!portfolio || portfolio.schema !== GITHUB_PORTFOLIO_SCHEMA
      || !/^[a-f0-9]{64}$/u.test(portfolio.revision ?? '')) {
    throw new PortfolioFactoryError('InvalidPortfolio', 'portfolio identity is invalid');
  }
  const { revision, ...body } = structuredClone(portfolio);
  if (sha256(canonicalJson(body)) !== revision) {
    throw new PortfolioFactoryError('SnapshotMismatch', 'portfolio content does not match its revision');
  }
  return body;
}

export function createPortfolioFactory({ githubRead } = {}) {
  if (!githubRead || typeof githubRead.read !== 'function') {
    throw new PortfolioFactoryError('InvalidAdapter', 'githubRead.read is required');
  }

  return Object.freeze({
    async survey(request) {
      const normalizedRequest = {
        organization: requireText(request?.organization, 'organization'),
        policyRevision: requireText(request?.policyRevision, 'policyRevision'),
      };
      const snapshot = await githubRead.read(structuredClone(normalizedRequest));
      return buildPortfolio(snapshot, normalizedRequest);
    },
    async advance(request) {
      const body = verifyPortfolio(request?.portfolio);
      const freshSnapshot = await githubRead.read({
        organization: body.organization,
        policyRevision: body.policyRevision,
      });
      const freshPortfolio = buildPortfolio(freshSnapshot, {
        organization: body.organization,
        policyRevision: body.policyRevision,
      });
      if (freshPortfolio.revision !== request.portfolio.revision) {
        throw new PortfolioFactoryError(
          'SnapshotStale', 'GitHub changed after the portfolio revision was materialized',
        );
      }
      const next = freshPortfolio.schedule[0];
      if (!next) {
        const receiptBody = {
          schema: 'gaia-github-portfolio-transition/1',
          status: 'NO_READY_WORK',
          fromRevision: request.portfolio.revision,
          intent: null,
        };
        return deepFreeze({
          ...receiptBody,
          revision: sha256(canonicalJson(receiptBody)),
        });
      }
      const receiptBody = {
        schema: 'gaia-github-portfolio-transition/1',
        status: 'AWAITING_AUTHORITY',
        fromRevision: request.portfolio.revision,
        intent: {
          action: 'RUN_FACTORY_AGENT',
          repository: next.repository,
          itemKind: next.itemKind,
          itemId: next.itemId,
          itemNumber: next.itemNumber,
          evidenceState: freshPortfolio.workItems.find(
            ({ repository, itemId }) => repository === next.repository && itemId === next.itemId,
          ).state,
          snapshotRevision: request.portfolio.revision,
          requiredAuthority: 'FACTORY_RUN',
        },
      };
      return deepFreeze({ ...receiptBody, revision: sha256(canonicalJson(receiptBody)) });
    },
  });
}
