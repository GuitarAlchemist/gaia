import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The one decision "this path is the root of a Git worktree" (#224), and the environment every Git
 * call after it runs in. docs/worktree-root-guard.md records the measurement and the designs.
 *
 * Root means the realpath of `git rev-parse --show-toplevel` equals the realpath of the path; on
 * Windows the realpath resolves case, 8.3 names and junctions. Git runs without the variables that
 * name a repository, so the path decides which repository is read, never what a hook left in the
 * environment. Every failure to observe is a refusal.
 */

// Variables that would point Git at a repository other than the one named by the working directory.
export const REPOSITORY_LOCATORS = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES',
]);

const GIT_TIMEOUT_MS = 30_000;

export class WorktreeRootError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorktreeRootError';
    this.code = code;
  }
}

/** A copy of `env` without the repository locators, matched case-insensitively as Windows does. */
export function repositoryNeutralEnvironment(env = process.env) {
  const neutral = {};
  for (const [key, value] of Object.entries(env)) {
    if (!REPOSITORY_LOCATORS.includes(key.toUpperCase())) neutral[key] = value;
  }
  return neutral;
}

/**
 * The canonical path of the worktree root that `path` names. Refuses with `NOT_A_WORKTREE` when
 * Git sees no work tree there, and with `NOT_WORKTREE_ROOT` when the path is below the root.
 */
export function requireWorktreeRoot(path) {
  if (typeof path !== 'string' || path === '') {
    throw new WorktreeRootError('NOT_A_WORKTREE', 'a worktree path must be a non-empty string');
  }
  const cwd = resolve(path);
  const run = spawnSync('git', ['rev-parse', '--is-inside-work-tree', '--show-toplevel'], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS, env: repositoryNeutralEnvironment(),
  });
  const lines = run.error === undefined && run.status === 0 ? run.stdout.split(/\r?\n/u) : [];
  if (lines.length !== 3 || lines[0] !== 'true' || lines[1] === '' || lines[2] !== '') {
    throw new WorktreeRootError('NOT_A_WORKTREE', 'the path is not inside a Git worktree');
  }
  let root;
  let physical;
  try {
    root = realpathSync.native(lines[1]);
    physical = realpathSync.native(cwd);
  } catch {
    throw new WorktreeRootError('NOT_A_WORKTREE', 'the worktree root could not be resolved');
  }
  if (root !== physical) {
    throw new WorktreeRootError('NOT_WORKTREE_ROOT', 'the path must be the root of its Git worktree');
  }
  return root;
}
