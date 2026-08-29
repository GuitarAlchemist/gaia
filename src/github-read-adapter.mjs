import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runGh(args) {
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function labelsOf(item) {
  if (!Array.isArray(item?.labels)) throw new TypeError('gh item labels must be an array');
  return item.labels.map((label) => {
    if (!label || typeof label !== 'object' || Array.isArray(label)
        || typeof label.name !== 'string') {
      throw new TypeError('every gh item label must have a string name');
    }
    return label.name;
  });
}

function qualifiedReference(reference, repository) {
  return reference.startsWith('#') ? `${repository}${reference}` : reference;
}

function declaredRelationships(body, repository) {
  const dependencies = [];
  const duplicates = [];
  let dependenciesAreEmpty = false;
  let duplicatesAreEmpty = false;
  for (const line of String(body ?? '').split(/\r?\n/u)) {
    const match = line.match(/^\s*(Depends-On|Blocked-By|Duplicate-Of):\s*(NONE|(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9]\d*)\s*$/iu);
    if (!match) continue;
    const relationship = match[1].toLowerCase();
    const isDuplicate = relationship === 'duplicate-of';
    if (match[2].toUpperCase() === 'NONE') {
      if (relationship === 'blocked-by') {
        throw new TypeError('NONE is supported only for Depends-On and Duplicate-Of');
      }
      if (isDuplicate) duplicatesAreEmpty = true;
      else if (relationship === 'depends-on') dependenciesAreEmpty = true;
      continue;
    }
    const reference = qualifiedReference(match[2], repository);
    if (isDuplicate) duplicates.push(reference);
    else dependencies.push(reference);
  }
  const uniqueDuplicates = [...new Set(duplicates)];
  if (uniqueDuplicates.length > 1) dependencies.push(...uniqueDuplicates);
  if ((dependenciesAreEmpty && dependencies.length > 0)
      || (duplicatesAreEmpty && duplicates.length > 0)) {
    throw new TypeError('NONE cannot be combined with a concrete relationship');
  }
  return {
    dependencies: dependenciesAreEmpty ? []
      : dependencies.length > 0 ? [...new Set(dependencies)] : 'UNKNOWN',
    duplicateOf: duplicatesAreEmpty ? null
      : uniqueDuplicates.length === 1 ? uniqueDuplicates[0] : 'UNKNOWN',
  };
}

function searchMetadataPath(organization, itemKind) {
  const query = encodeURIComponent(`org:${organization} is:${itemKind} is:open`);
  return `search/issues?q=${query}&per_page=1`;
}

function searchIsComplete(rows, metadata, resultLimit) {
  return metadata && metadata.incomplete_results === false
    && Number.isSafeInteger(metadata.total_count)
    && metadata.total_count === rows.length
    && rows.length < resultLimit;
}

export function createGitHubReadAdapter({ run = runGh, resultLimit = 1000 } = {}) {
  if (typeof run !== 'function') {
    throw new TypeError('run must be a function');
  }
  if (!Number.isSafeInteger(resultLimit) || resultLimit < 1 || resultLimit > 1000) {
    throw new TypeError('resultLimit must be between 1 and 1000');
  }

  return Object.freeze({
    async read({ organization }) {
      const [repositoryRows, issueRows, pullRequestRows, issueMetadata, pullRequestMetadata]
        = await Promise.all([
        run([
          'repo', 'list', organization, '--limit', String(resultLimit),
          '--json', 'id,nameWithOwner,isArchived,defaultBranchRef',
        ]),
        run([
          'search', 'issues', '--owner', organization, '--state', 'open',
          '--limit', String(resultLimit),
          '--json', 'id,number,title,updatedAt,body,labels,repository',
        ]),
        run([
          'search', 'prs', '--owner', organization, '--state', 'open',
          '--limit', String(resultLimit),
          '--json', 'id,number,title,updatedAt,body,isDraft,labels,repository',
        ]),
        run(['api', searchMetadataPath(organization, 'issue'), '--method', 'GET']),
        run(['api', searchMetadataPath(organization, 'pr'), '--method', 'GET']),
      ]);
      if (!Array.isArray(repositoryRows) || !Array.isArray(issueRows)
          || !Array.isArray(pullRequestRows)) {
        throw new TypeError('gh returned a non-array portfolio response');
      }

      const repositories = await Promise.all(repositoryRows.map(async (repository) => {
        const branch = repository.defaultBranchRef?.name;
        const defaultBranchOid = typeof branch === 'string'
          ? await run([
            'api', `repos/${repository.nameWithOwner}/commits/${encodeURIComponent(branch)}`,
            '--jq', '.sha',
          ])
          : 'UNKNOWN';
        return {
          id: repository.id,
          nameWithOwner: repository.nameWithOwner,
          archived: repository.isArchived,
          defaultBranchOid: typeof defaultBranchOid === 'string' ? defaultBranchOid : 'UNKNOWN',
          issues: [],
          pullRequests: [],
        };
      }));
      const byName = new Map(repositories.map((repository) => [repository.nameWithOwner, repository]));
      let unmapped = 0;
      for (const issue of issueRows) {
        const repository = byName.get(issue.repository?.nameWithOwner);
        if (!repository) {
          unmapped += 1;
          continue;
        }
        const relationships = declaredRelationships(issue.body, repository.nameWithOwner);
        repository.issues.push({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          updatedAt: issue.updatedAt,
          labels: labelsOf(issue),
          ...relationships,
        });
      }
      for (const pullRequest of pullRequestRows) {
        const repository = byName.get(pullRequest.repository?.nameWithOwner);
        if (!repository) {
          unmapped += 1;
          continue;
        }
        const relationships = declaredRelationships(
          pullRequest.body, repository.nameWithOwner,
        );
        repository.pullRequests.push({
          id: pullRequest.id,
          number: pullRequest.number,
          title: pullRequest.title,
          updatedAt: pullRequest.updatedAt,
          isDraft: pullRequest.isDraft,
          headOid: 'UNKNOWN',
          baseOid: repository.defaultBranchOid,
          labels: labelsOf(pullRequest),
          checks: 'UNKNOWN',
          review: 'UNKNOWN',
          ...relationships,
        });
      }

      return {
        schema: 'gaia-github-read-snapshot/1',
        organization,
        scope: 'all-repositories-visible-to-adapter',
        complete: repositoryRows.length < resultLimit
          && searchIsComplete(issueRows, issueMetadata, resultLimit)
          && searchIsComplete(pullRequestRows, pullRequestMetadata, resultLimit)
          && unmapped === 0,
        repositories,
      };
    },
  });
}
