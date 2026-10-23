import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { measureAgentFactoryChangeSet } from './factory-agent.mjs';
import { repositoryNeutralEnvironment } from './worktree-root.mjs';

const execFileAsync = promisify(execFile);
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REMOTE_FORMS = [
  /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?github\.com(?::\d+)?\/(.+)$/u,
  /^(?:[^@/:]+@)?github\.com:(.+)$/u,
];
// Neither a hook from a configured hooks directory nor the file system monitor runs on the
// publishing side, so none adds to the commit or acts with the push's credentials. Git still looks
// for hooks at the drive root (docs/github-portfolio-publication.md). Replace refs are off, so
// every check reads the objects the push sends.
const PUBLICATION_GIT = Object.freeze([
  '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.useReplaceRefs=false',
]);

export class GitGhPublicationEffectsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitGhPublicationEffectsError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GitGhPublicationEffectsError(code, message);
}

function text(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail('InvalidRequest', `${field} must be canonical text`);
  }
  return value;
}

function repository(value, field) {
  const candidate = text(value, field);
  if (!REPOSITORY.test(candidate)) fail('InvalidRequest', `${field} must be owner/name`);
  return candidate;
}

function branch(value, field) {
  const candidate = text(value, field);
  if (!BRANCH.test(candidate) || candidate.includes('..') || candidate.endsWith('.lock')) {
    fail('InvalidRequest', `${field} must be a conservative Git branch name`);
  }
  return candidate;
}

function oid(value, field) {
  const candidate = text(value, field);
  if (!OID.test(candidate)) fail('InvalidRequest', `${field} must be a Git object id`);
  return candidate;
}

function sha(value, field) {
  const candidate = text(value, field);
  if (!SHA256.test(candidate)) fail('InvalidRequest', `${field} must be a lowercase SHA-256`);
  return candidate;
}

function physicalDirectory(supplied) {
  let metadata;
  try {
    metadata = lstatSync(supplied);
  } catch {
    fail('InvalidWorktree', 'worktree must be a real existing directory');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('InvalidWorktree', 'worktree must be a real existing directory');
  }
  return realpathSync.native(resolve(supplied));
}

function remoteIdentity(value) {
  const trimmed = String(value).trim();
  for (const form of REMOTE_FORMS) {
    const match = form.exec(trimmed);
    if (!match) continue;
    const path = match[1].replace(/\/+$/u, '').replace(/\.git$/u, '');
    if (REPOSITORY.test(path)) return path;
  }
  return null;
}

function oneRemoteOid(value, ref) {
  const rows = String(value).trim().split(/\r?\n/u).filter(Boolean);
  if (rows.length === 0) return null;
  if (rows.length !== 1) fail('RemoteStateInvalid', `remote returned multiple rows for ${ref}`);
  const [valueOid, valueRef, ...extra] = rows[0].split(/\s+/u);
  if (extra.length > 0 || valueRef !== ref || !OID.test(valueOid)) {
    fail('RemoteStateInvalid', `remote returned an invalid row for ${ref}`);
  }
  return valueOid;
}

function json(value, field) {
  try {
    return JSON.parse(String(value).trim());
  } catch {
    fail('ProviderResultInvalid', `${field} returned invalid JSON`);
  }
}

async function defaultRun(command, args, options) {
  return execFileAsync(command, args, options);
}

export function createGitGhCandidatePublicationEffects({
  expectedRepository,
  worktree,
  baseBranch,
  run = defaultRun,
}) {
  const expected = repository(expectedRepository, 'expectedRepository');
  const physicalWorktree = physicalDirectory(worktree);
  const base = branch(baseBranch, 'baseBranch');
  if (typeof run !== 'function') fail('InvalidAdapter', 'run must be a function');
  // Without the repository locators, so the worktree decides the repository (#224).
  const invoke = async (command, args, options = {}) => run(command, args, {
    cwd: physicalWorktree,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: repositoryNeutralEnvironment(),
    ...options,
  });
  const git = async (...args) => String(
    (await invoke('git', [...PUBLICATION_GIT, ...args])).stdout ?? '',
  ).trim();
  const gh = async (...args) => String((await invoke('gh', args)).stdout ?? '').trim();
  // The host is named, so GH_HOST cannot send a call to another server.
  const ghRepository = `github.com/${expected}`;
  const remoteRef = async (name) => {
    const ref = `refs/heads/${name}`;
    return oneRemoteOid(await git('ls-remote', '--heads', 'origin', ref), ref);
  };
  // The push reaches the push view, after any pushurl or pushInsteadOf, and Git pushes to every
  // URL listed: each view of origin must list one URL, the bound repository's.
  const assertRepository = async () => {
    for (const view of [['--all', 'origin'], ['--all', '--push', 'origin']]) {
      const urls = (await git('remote', 'get-url', ...view)).split(/\r?\n/u);
      const observed = urls.length === 1 ? remoteIdentity(urls[0]) : null;
      if (observed === null || observed.toLowerCase() !== expected.toLowerCase()) {
        fail('RepositoryIdentityMismatch', 'worktree origin does not match the bound repository');
      }
    }
  };
  // The commit must hold exactly the reviewed bytes: no path more or less, and every present
  // file's blob equal to the measured file, whatever the host's Git configuration did to `add`.
  // The push sends every object the commit reaches, so its only parent must be the reviewed HEAD.
  const assertCommittedTree = async (parentOid, commitOid, files) => {
    const mismatch = () => fail(
      'PublishedTreeMismatch', 'the commit does not hold the reviewed bytes',
    );
    const parents = (await git('cat-file', 'commit', commitOid)).split('\n\n')[0].split('\n')
      .filter((line) => line.startsWith('parent ')).map((line) => line.slice('parent '.length));
    if (parents.length !== 1 || parents[0] !== parentOid) mismatch();
    const fields = (await git('diff', '--name-status', '-z', '--no-renames', parentOid, commitOid))
      .split('\0').filter(Boolean);
    const committed = new Map();
    for (let index = 0; index + 1 < fields.length; index += 2) {
      committed.set(fields[index + 1], fields[index]);
    }
    if (committed.size !== files.length) mismatch();
    for (const file of files) {
      const status = committed.get(file.path);
      if (file.state === 'deleted' ? status !== 'D' : !['A', 'M'].includes(status)) mismatch();
      if (file.state === 'present') {
        const { stdout } = await invoke('git', [...PUBLICATION_GIT, 'cat-file', 'blob',
          `${commitOid}:${file.path}`], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
        if (createHash('sha256').update(stdout).digest('hex') !== file.sha256) mismatch();
      }
    }
  };

  return Object.freeze({
    async observe({ repository: requestedRepository }) {
      if (repository(requestedRepository, 'repository').toLowerCase() !== expected.toLowerCase()) {
        fail('RepositoryScopeMismatch', 'observation repository does not match this Adapter');
      }
      await assertRepository();
      const headOid = oid(await git('rev-parse', 'HEAD'), 'HEAD');
      const baseOid = await remoteRef(base);
      if (baseOid === null) fail('BaseBranchMissing', 'the bound base branch does not exist');
      return {
        repository: expected,
        headOid,
        baseOid,
        changeSetIdentity: measureAgentFactoryChangeSet(physicalWorktree, headOid).identity,
      };
    },

    async commit(request) {
      if (repository(request.repository, 'repository').toLowerCase() !== expected.toLowerCase()) {
        fail('RepositoryScopeMismatch', 'commit repository does not match this Adapter');
      }
      const publicationBranch = branch(request.branch, 'branch');
      const expectedHeadOid = oid(request.expectedHeadOid, 'expectedHeadOid');
      const expectedChangeSet = sha(request.changeSetIdentity, 'changeSetIdentity');
      text(request.message, 'message');
      sha(request.idempotencyKey, 'idempotencyKey');
      if (oid(await git('rev-parse', 'HEAD'), 'HEAD') !== expectedHeadOid) {
        fail('CandidateStale', 'local HEAD moved before commit');
      }
      const reviewed = measureAgentFactoryChangeSet(physicalWorktree, expectedHeadOid);
      if (reviewed.identity !== expectedChangeSet) {
        fail('CandidateChanged', 'candidate bytes moved before commit');
      }
      await git('switch', '--create', publicationBranch);
      await git('add', '--all');
      await git('commit', '--message', request.message);
      const commitOid = oid(await git('rev-parse', 'HEAD'), 'commitOid');
      await assertCommittedTree(expectedHeadOid, commitOid, reviewed.files);
      return { commitOid };
    },

    async push(request) {
      if (repository(request.repository, 'repository').toLowerCase() !== expected.toLowerCase()) {
        fail('RepositoryScopeMismatch', 'push repository does not match this Adapter');
      }
      const publicationBranch = branch(request.branch, 'branch');
      const commitOid = oid(request.commitOid, 'commitOid');
      const expectedBaseOid = oid(request.expectedBaseOid, 'expectedBaseOid');
      sha(request.idempotencyKey, 'idempotencyKey');
      if (await remoteRef(base) !== expectedBaseOid) {
        fail('CandidateStale', 'GitHub base moved before push');
      }
      const existing = await remoteRef(publicationBranch);
      if (existing !== null && existing !== commitOid) {
        fail('RemoteBranchConflict', 'the deterministic publication branch already differs');
      }
      if (existing === null) {
        // A program Git ran since `observe`, a clean filter in the measurement or in `git add`,
        // may have rewritten origin: both views are read again just before the push.
        await assertRepository();
        const ref = `refs/heads/${publicationBranch}`;
        await git(
          'push', '--no-follow-tags', `--force-with-lease=${ref}:`, 'origin', `${commitOid}:${ref}`,
        );
      }
      return { headOid: commitOid };
    },

    async openPullRequest(request) {
      if (repository(request.repository, 'repository').toLowerCase() !== expected.toLowerCase()) {
        fail('RepositoryScopeMismatch', 'pull request repository does not match this Adapter');
      }
      const publicationBranch = branch(request.branch, 'branch');
      const commitOid = oid(request.commitOid, 'commitOid');
      oid(request.baseOid, 'baseOid');
      text(request.title, 'title');
      text(request.body, 'body');
      sha(request.idempotencyKey, 'idempotencyKey');
      const existing = json(await gh(
        'pr', 'list', '--repo', ghRepository, '--state', 'all', '--head', publicationBranch,
        '--limit', '2', '--json', 'number,url,headRefOid,baseRefName',
      ), 'gh pr list');
      if (!Array.isArray(existing) || existing.length > 1) {
        fail('PullRequestStateInvalid', 'publication branch must identify at most one pull request');
      }
      if (existing.length === 1) {
        const found = existing[0];
        if (found.headRefOid !== commitOid || found.baseRefName !== base) {
          fail('PullRequestConflict', 'existing pull request does not bind this candidate');
        }
        return {
          number: found.number,
          url: found.url,
          headOid: found.headRefOid,
        };
      }
      const url = text(await gh(
        'pr', 'create', '--repo', ghRepository, '--head', publicationBranch, '--base', base,
        '--title', request.title, '--body', request.body,
      ), 'gh pr create URL');
      const created = json(await gh(
        'pr', 'view', url, '--repo', ghRepository, '--json', 'number,url,headRefOid',
      ), 'gh pr view');
      if (created.url !== url || created.headRefOid !== commitOid
          || !Number.isSafeInteger(created.number) || created.number < 1) {
        fail('ProviderResultInvalid', 'created pull request does not bind this candidate');
      }
      return { number: created.number, url: created.url, headOid: created.headRefOid };
    },
  });
}
