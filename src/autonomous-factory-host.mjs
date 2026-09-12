import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
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

// Artifacts are expectations only. Application admission always reads GitHub again.
// A bounded discovery window is deliberate; it is not an exhaustive historical queue.
export function collectHostedDraftReceipts({ repository, cacheDir, run = runHost }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)) fail('InvalidRepository');
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
