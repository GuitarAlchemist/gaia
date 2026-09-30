import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

import {
  MAX_RESUME_PROMPT_CHARS, MAX_UPSTREAM_ARTIFACT_CHARS, ResumeManifestError, requireResumeManifest,
} from './resume-manifest.mjs';

/**
 * The resume check's observation adapter: reads one declared subject worktree with Git, resolves
 * the declared base on its remote, and reads the declared upstream artifacts. It measures only;
 * it decides nothing (`src/resume-manifest.mjs` decides) and it writes nothing: Git runs with
 * optional locks off, so even `git status` does not refresh the index.
 *
 * The base is resolved with `ls-remote` against the remote itself, not from the local
 * remote-tracking ref. A tracking ref is only as fresh as the last fetch, and a stale base copied
 * from a stale clone is exactly the Y2 defect this check exists to refuse.
 *
 * Every failure to observe is `RESUME_OBSERVATION_UNAVAILABLE` with a closed detail. An
 * unobservable world is never reported as agreement.
 */

const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
// Variables that would point Git at a repository other than the one named by the subject path.
const REPOSITORY_LOCATORS = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES',
]);

const unavailable = (detail) => {
  throw new ResumeManifestError('RESUME_OBSERVATION_UNAVAILABLE', detail);
};

function gitEnvironment() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) {
    if (REPOSITORY_LOCATORS.has(key.toUpperCase())) delete env[key];
  }
  return env;
}

function git(cwd, args, detail) {
  const run = spawnSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_LIMIT, env: gitEnvironment(),
  });
  if (run.error !== undefined || run.status !== 0) unavailable(detail);
  return run.stdout;
}

const isDirectory = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** Strict UTF-8 text of one regular file of at most `maxBytes`; `fail` throws. */
function readText(path, maxBytes, fail) {
  let stat;
  try { stat = statSync(path); } catch { return fail('UNREADABLE'); }
  if (!stat.isFile()) fail('UNREADABLE');
  if (stat.size > maxBytes) fail('TOO_LARGE');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch {
    return fail('UNREADABLE');
  }
}

function resolveBase(cwd, ref) {
  const slash = ref.indexOf('/');
  const remote = ref.slice(0, slash);
  const head = `refs/heads/${ref.slice(slash + 1)}`;
  // A name that is not a configured remote would be read as a URL or a path by ls-remote.
  git(cwd, ['config', '--get', `remote.${remote}.url`], 'BASE_REMOTE_UNKNOWN');
  const lines = git(cwd, ['ls-remote', '--exit-code', remote, head], 'BASE_UNRESOLVED')
    .split('\n').filter((line) => line !== '');
  const exact = lines.map((line) => line.split('\t')).filter(([, name]) => name === head);
  if (exact.length !== 1 || !/^[0-9a-f]{40}$/u.test(exact[0][0])) unavailable('BASE_UNRESOLVED');
  return exact[0][0];
}

/**
 * Observe the world one resume manifest is declared against. The subject must be the root of a
 * Git worktree: a subdirectory would report the HEAD of whatever repository contains it.
 */
export function observeResumeWorld(manifest) {
  requireResumeManifest(manifest);
  const cwd = manifest.subject.path;
  if (!isDirectory(cwd)) unavailable('SUBJECT_UNREADABLE');
  if (git(cwd, ['rev-parse', '--is-inside-work-tree'], 'SUBJECT_NOT_WORKTREE_ROOT').trim() !== 'true'
      || git(cwd, ['rev-parse', '--show-prefix'], 'SUBJECT_NOT_WORKTREE_ROOT').trim() !== '') {
    unavailable('SUBJECT_NOT_WORKTREE_ROOT');
  }
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'SUBJECT_UNREADABLE').trim();
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    'SUBJECT_UNREADABLE');
  return {
    subject: { path: cwd, head, clean: status.length === 0 },
    base: manifest.base === null ? null
      : { ref: manifest.base.ref, head: resolveBase(cwd, manifest.base.ref) },
    upstream: manifest.upstream.map((path) => ({
      path,
      text: readText(path, MAX_UPSTREAM_ARTIFACT_CHARS, (kind) => unavailable(`UPSTREAM_${kind}`)),
    })),
  };
}

/** Read a prompt file as the lane will receive it: strict UTF-8, bounded. */
export function readResumePrompt(path) {
  return readText(path, MAX_RESUME_PROMPT_CHARS * 4, () => {
    throw new ResumeManifestError('RESUME_PROMPT_INVALID');
  });
}
