import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAutonomousRepository } from './autonomous-factory-contract.mjs';
import { measureAgentFactoryChangeSet } from './factory-agent.mjs';
import { readDraftExpectation } from './github-draft-admission.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
export function runHost(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false, ...options });
}

export function realDirectory(path) {
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail('InvalidDirectory');
  return realpathSync.native(path);
}

/** Two GETs, no GitHub mutation, retry, process launch, or execution replay. */
export function readClosedJobDisposition(intent, run = runHost) {
  if (!isAutonomousRepository(intent.repository)
      || !Number.isSafeInteger(intent.itemNumber) || intent.itemNumber < 1
      || !Number.isSafeInteger(intent.draft?.number) || intent.draft.number < 1) fail('InvalidIntent');
  const issue = JSON.parse(run('gh', ['api', '--method', 'GET',
    `repos/${intent.repository}/issues/${intent.itemNumber}`]));
  const draft = JSON.parse(run('gh', ['api', '--method', 'GET',
    `repos/${intent.repository}/pulls/${intent.draft.number}`]));
  if (issue.pull_request || issue.repository_url?.toLowerCase() !== `https://api.github.com/repos/${intent.repository}`.toLowerCase()
      || draft.base?.repo?.full_name?.toLowerCase() !== intent.repository.toLowerCase()
      || draft.head?.repo?.full_name?.toLowerCase() !== intent.repository.toLowerCase()) fail('DispositionMismatch');
  return { repository: intent.repository, itemId: issue.node_id, itemNumber: issue.number,
    issueState: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    issueStateReason: issue.state_reason === 'completed' ? 'COMPLETED' : 'UNKNOWN',
    draftNumber: draft.number, draftState: draft.state === 'closed' ? 'CLOSED' : 'OPEN',
    draftMerged: draft.merged, headRef: draft.head?.ref, headRevision: draft.head?.sha };
}

// Artifacts are expectations only. Application admission always reads GitHub again.
// A bounded discovery window is deliberate; it is not an exhaustive historical queue.
export function collectHostedDraftReceipts({ repository, cacheDir, run = runHost }) {
  if (!isAutonomousRepository(repository)) fail('InvalidRepository');
  const cache = realDirectory(cacheDir);
  const runs = JSON.parse(run('gh', ['run', 'list', '-R', repository, '--workflow', 'hosted-draft-intake.yml',
    '--branch', 'main', '--status', 'success', '--limit', '20', '--json', 'databaseId,headSha,event']));
  if (!Array.isArray(runs) || runs.length > 20) fail('InvalidRunList');
  const results = [];
  const refusals = [];
  for (const entry of runs) {
    if (!Number.isSafeInteger(entry.databaseId) || entry.databaseId < 1
        || !['schedule', 'issues', 'workflow_dispatch'].includes(entry.event)
        || !/^[a-f0-9]{40}$/.test(entry.headSha)) continue;
    const folder = join(cache, String(entry.databaseId));
    if (!existsSync(folder)) {
      const temporary = mkdtempSync(join(cache, 'download-'));
      try {
        run('gh', ['run', 'download', String(entry.databaseId), '-R', repository,
          '--name', 'gaia-hosted-draft-intake-receipt', '--dir', temporary]);
      } catch {
        refusals.push({ runId: entry.databaseId, code: 'ArtifactUnavailable' });
        continue;
      }
      // Publish a complete cache directory, preserving failed downloads for diagnosis.
      try { renameSync(temporary, folder); }
      catch (error) { if (!existsSync(folder)) throw error; }
    }
    realDirectory(folder);
    const path = join(folder, 'gaia-hosted-draft-intake-receipt.json');
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) fail('InvalidIntakeReceipt');
    const receiptText = readFileSync(path, 'utf8');
    try {
      const expectation = readDraftExpectation(receiptText, repository);
      results.push({ runId: entry.databaseId, path, receiptText, expectation });
    } catch { /* A green intake may be refused/no-op. It grants no execution. */ }
  }
  return { entries: results, refusals };
}

export function prepareAutonomousWorktree({
  clone, worktreeRoot, operationMarker, headRef, headRevision, run = runHost,
}) {
  if (typeof headRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(headRef)
      || headRef.includes('..') || headRef.includes('//') || headRef.endsWith('.lock')) fail('InvalidHeadRef');
  if (!/^[a-f0-9]{64}$/.test(operationMarker) || !/^[a-f0-9]{40}$/.test(headRevision)) fail('InvalidGeneration');
  const cwd = realDirectory(clone);
  const root = realDirectory(worktreeRoot);
  const worktree = join(root, operationMarker);
  const git = args => run('git', args, { cwd }).trim();
  if (existsSync(worktree)) {
    realDirectory(worktree);
    const measured = run('git', ['rev-parse', 'HEAD'], { cwd: worktree }).trim();
    if (measured !== headRevision) fail('SourceMoved');
    return worktree;
  }
  git(['check-ref-format', `refs/heads/${headRef}`]);
  git(['fetch', 'origin', `refs/heads/${headRef}`]);
  if (git(['rev-parse', 'FETCH_HEAD']) !== headRevision) fail('SourceMoved');
  // Detached, immutable source; no branch reuse and no automatic cleanup of candidate edits.
  git(['-c', 'core.hooksPath=', 'worktree', 'add', '--detach', worktree, headRevision]);
  return worktree;
}

const GITHUB_REMOTES = [/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/u,
  /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/u];
// Fixed so that one operation always yields one commit object, and a retry recognises its push.
const PUBLICATION_IDENTITY = { GIT_AUTHOR_NAME: 'Gaia autonomous factory',
  GIT_AUTHOR_EMAIL: 'gaia-autonomous-factory@gaia.invalid', GIT_COMMITTER_NAME: 'Gaia autonomous factory',
  GIT_COMMITTER_EMAIL: 'gaia-autonomous-factory@gaia.invalid' };

/**
 * Git/`gh` effects for publishing one candidate to its own Draft (#236), bound at construction to
 * that Draft's number and head ref. Reads are one pull-request GET and `ls-remote`; the commit is
 * built on a temporary index so the worktree's HEAD and index never move; the only write is one
 * leased fast-forward push of the bound ref. There is no ready, merge, comment or close operation.
 */
export function createAutonomousDraftPublicationEffects({ repository, worktree, draft, run = runHost }) {
  if (!isAutonomousRepository(repository) || !Number.isSafeInteger(draft?.number) || draft.number < 1
      || typeof draft.headRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(draft.headRef)
      || draft.headRef.includes('..') || draft.headRef.includes('//') || draft.headRef.endsWith('.lock')
      || !/^[a-f0-9]{40}$/.test(draft.headRevision ?? '')) fail('InvalidDraft');
  const cwd = realDirectory(worktree);
  const ref = `refs/heads/${draft.headRef}`;
  const git = (args, options = {}) => String(run('git', args, { cwd, ...options })).trim();
  const remoteHead = () => {
    const rows = git(['ls-remote', 'origin', ref]).split(/\r?\n/u).map(row => row.split(/\s+/u))
      .filter(([, name]) => name === ref);
    if (rows.length !== 1 || !/^[a-f0-9]{40}$/.test(rows[0][0])) fail('DraftRefUnavailable');
    return rows[0][0];
  };
  const measured = head => measureAgentFactoryChangeSet(cwd, head);
  // The published tree must hold exactly the reviewed bytes: no path more or less, and every
  // present file's blob equal to the measured file, whatever filters the clone configures.
  const assertPublishedTree = (commitOid, files) => {
    const fields = git(['diff', '--name-status', '-z', '--no-renames', draft.headRevision, commitOid])
      .split('\0').filter(Boolean);
    const published = new Map();
    for (let index = 0; index + 1 < fields.length; index += 2) published.set(fields[index + 1], fields[index]);
    if (published.size !== files.length) fail('PublishedTreeMismatch');
    for (const file of files) {
      const status = published.get(file.path);
      if (file.state === 'deleted' ? status !== 'D' : !['A', 'M'].includes(status)) fail('PublishedTreeMismatch');
      if (file.state === 'present') {
        const blob = run('git', ['cat-file', 'blob', `${commitOid}:${file.path}`],
          { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
        if (createHash('sha256').update(blob).digest('hex') !== file.sha256) fail('PublishedTreeMismatch');
      }
    }
  };
  return Object.freeze({
    async observe() {
      const origin = git(['remote', 'get-url', 'origin']);
      if (!GITHUB_REMOTES.some(form => form.exec(origin)?.[1]?.toLowerCase() === repository.toLowerCase())) {
        fail('RepositoryIdentityMismatch');
      }
      const pull = JSON.parse(run('gh', ['api', '--method', 'GET', `repos/${repository}/pulls/${draft.number}`]));
      const headOid = git(['rev-parse', 'HEAD']);
      return {
        pullRequest: { number: pull?.number, isDraft: pull?.draft === true,
          state: pull?.merged === true ? 'MERGED' : pull?.state === 'open' ? 'OPEN' : 'CLOSED',
          headRef: pull?.head?.ref, headRepository: String(pull?.head?.repo?.full_name ?? '') },
        git: { repository, headOid, baseOid: remoteHead(), changeSetIdentity: measured(headOid).identity },
      };
    },
    async commit({ operationId, parentOid, changeSetIdentity, message }) {
      if (!/^[a-f0-9]{64}$/.test(operationId ?? '') || parentOid !== draft.headRevision
          || typeof message !== 'string' || !message.includes(operationId)) fail('InvalidRequest');
      if (git(['rev-parse', 'HEAD']) !== parentOid) fail('CandidateStale');
      const before = measured(parentOid);
      if (before.identity !== changeSetIdentity) fail('CandidateChanged');
      const scratch = mkdtempSync(join(tmpdir(), 'gaia-publication-index-'));
      try {
        const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
        git(['read-tree', parentOid], { env });
        git(['add', '--all', '--', '.'], { env });
        const tree = git(['write-tree'], { env });
        if (measured(parentOid).identity !== changeSetIdentity) fail('CandidateChanged');
        const date = `@${git(['show', '-s', '--format=%ct', parentOid])} +0000`;
        const commitOid = git(['commit-tree', '--no-gpg-sign', tree, '-p', parentOid, '-F', '-'], {
          env: { ...process.env, ...PUBLICATION_IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
          input: message });
        if (!/^[a-f0-9]{40}$/.test(commitOid)) fail('CommitInvalid');
        assertPublishedTree(commitOid, before.files);
        return { commitOid };
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    },
    async push({ headRef, commitOid, expectedOid }) {
      if (headRef !== draft.headRef) fail('DraftBranchMismatch');
      if (expectedOid !== draft.headRevision || !/^[a-f0-9]{40}$/.test(commitOid ?? '')) fail('InvalidRequest');
      try { git(['merge-base', '--is-ancestor', expectedOid, commitOid]); } catch { fail('NotFastForward'); }
      git(['push', `--force-with-lease=${ref}:${expectedOid}`, 'origin', `${commitOid}:${ref}`]);
      if (remoteHead() !== commitOid) fail('PushNotObserved');
      return { headOid: commitOid };
    },
  });
}

export function ensureHostDirectories(root) {
  const physical = realDirectory(root);
  const result = {};
  for (const name of ['cache', 'worktrees', 'evidence']) {
    const path = join(physical, name);
    if (!existsSync(path)) mkdirSync(path);
    result[name] = realDirectory(path);
  }
  return result;
}
