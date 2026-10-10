/**
 * worktree-root.test.mjs — the one guard that decides "this path is the root of a Git worktree".
 *
 * Issue #224. Three entry points used to decide this with three idioms, and #218 R0 shipped a
 * fourth that lost the root binding. The cases below are the ones #218 R1 tried against
 * `verifyCommittedHead`, tested once here. docs/worktree-root-guard.md records the measurement
 * they come from: without repository locators in the environment every idiom agreed on them; with
 * `GIT_DIR` in the environment every idiom was fooled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  REPOSITORY_LOCATORS, WorktreeRootError, repositoryNeutralEnvironment, requireWorktreeRoot,
} from '../src/worktree-root.mjs';

const WINDOWS = process.platform === 'win32';
const scratch = mkdtempSync(join(tmpdir(), 'gaia-worktree-root-'));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', env: repositoryNeutralEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repository(name) {
  const path = join(scratch, name);
  mkdirSync(path);
  git(path, 'init', '-q');
  git(path, '-c', 'user.name=Gaia Test', '-c', 'user.email=gaia@example.invalid',
    'commit', '-q', '--allow-empty', '-m', name);
  return path;
}

// One primary checkout and one linked worktree with a long name, so Windows gives it an 8.3 alias.
const primary = repository('primary');
const worktree = join(scratch, 'LinkedWorktreeWithLongName');
git(primary, 'worktree', 'add', '-q', '-b', 'linked', worktree, 'HEAD');
const subdirectory = join(worktree, 'LongSubdirectoryName');
mkdirSync(join(subdirectory, 'deep'), { recursive: true });
const other = repository('other');
const plain = join(scratch, 'plain');
mkdirSync(plain);
const junction = WINDOWS ? 'junction' : 'dir';
const aliasOfRoot = join(scratch, 'alias-of-root');
symlinkSync(worktree, aliasOfRoot, junction);
const aliasOfOwnSubdirectory = join(worktree, 'alias-of-own-subdirectory');
symlinkSync(join(subdirectory, 'deep'), aliasOfOwnSubdirectory, junction);
const aliasOfOtherRoot = join(worktree, 'alias-of-other-root');
symlinkSync(other, aliasOfOtherRoot, junction);

const canonical = (path) => realpathSync.native(path);

function refusedWith(code) {
  return (error) => error instanceof WorktreeRootError && error.code === code;
}

// The 8.3 alias of a directory, or null when the volume does not generate them.
function shortName(path) {
  const short = execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:GAIA_SHORT_NAME_OF).ShortPath',
  ], { encoding: 'utf8', env: { ...process.env, GAIA_SHORT_NAME_OF: path }, windowsHide: true }).trim();
  return short.toLowerCase() === path.toLowerCase() ? null : short;
}

// Run `fn` with variables set in the real process environment, as a Git hook would leave them.
function withAmbient(variables, fn) {
  const saved = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('accepts the root however the path spells it, and returns its canonical path', () => {
  const root = canonical(worktree);
  for (const spelling of [
    worktree,
    relative(process.cwd(), worktree),
    `${worktree}${WINDOWS ? '\\' : '/'}`,
    join(subdirectory, '..'),
    aliasOfRoot,
  ]) {
    assert.equal(requireWorktreeRoot(spelling), root, spelling);
  }
  assert.equal(requireWorktreeRoot(primary), canonical(primary));
});

test('accepts an upper-cased path and an 8.3 name of the root on Windows', { skip: !WINDOWS }, (t) => {
  const root = canonical(worktree);
  assert.equal(requireWorktreeRoot(worktree.toUpperCase()), root);
  const short = shortName(worktree);
  if (short === null) {
    t.diagnostic('this volume generates no 8.3 names; the short-name case is vacuous here');
    return;
  }
  assert.equal(requireWorktreeRoot(short), root);
});

test('refuses a subdirectory as NOT_WORKTREE_ROOT, also through a junction or an 8.3 name', () => {
  assert.throws(() => requireWorktreeRoot(subdirectory), refusedWith('NOT_WORKTREE_ROOT'));
  assert.throws(() => requireWorktreeRoot(join(subdirectory, 'deep')), refusedWith('NOT_WORKTREE_ROOT'));
  assert.throws(() => requireWorktreeRoot(aliasOfOwnSubdirectory), refusedWith('NOT_WORKTREE_ROOT'));
  if (WINDOWS) {
    const short = shortName(subdirectory);
    if (short !== null) assert.throws(() => requireWorktreeRoot(short), refusedWith('NOT_WORKTREE_ROOT'));
  }
});

test('a junction inside the root that points at another repository\'s root is that root', () => {
  assert.equal(requireWorktreeRoot(aliasOfOtherRoot), canonical(other));
});

test('refuses what is not a worktree as NOT_A_WORKTREE', () => {
  const bogus = join(scratch, 'bogus-gitfile');
  mkdirSync(bogus);
  writeFileSync(join(bogus, '.git'), 'gitdir: nowhere\n', 'utf8');
  for (const path of [plain, join(scratch, 'missing'), join(primary, '.git'), bogus]) {
    assert.throws(() => requireWorktreeRoot(path), refusedWith('NOT_A_WORKTREE'), path);
  }
  for (const path of [undefined, null, '', 7]) {
    assert.throws(() => requireWorktreeRoot(path), refusedWith('NOT_A_WORKTREE'), String(path));
  }
});

test('a repository locator in the environment cannot move the root', () => {
  // A hook exports GIT_DIR and GIT_WORK_TREE (githooks(5)). Measured on main before this guard:
  // with GIT_DIR naming another repository, Git called a subdirectory, a .git directory and a
  // plain directory "the top of the work tree".
  const root = canonical(worktree);
  for (const ambient of [
    { GIT_DIR: join(other, '.git') },
    { GIT_WORK_TREE: worktree },
    { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: plain },
    { GIT_CEILING_DIRECTORIES: scratch, GIT_COMMON_DIR: join(other, '.git') },
  ]) {
    withAmbient(ambient, () => {
      const label = JSON.stringify(Object.keys(ambient));
      assert.equal(requireWorktreeRoot(worktree), root, label);
      assert.throws(() => requireWorktreeRoot(subdirectory), refusedWith('NOT_WORKTREE_ROOT'), label);
      assert.throws(() => requireWorktreeRoot(join(primary, '.git')), refusedWith('NOT_A_WORKTREE'), label);
      assert.throws(() => requireWorktreeRoot(plain), refusedWith('NOT_A_WORKTREE'), label);
    });
  }
});

test('the neutral environment drops every repository locator in any case and keeps the rest', () => {
  const env = repositoryNeutralEnvironment({
    PATH: '/bin', GIT_DIR: 'x', git_work_tree: 'y', Git_Index_File: 'z', GIT_AUTHOR_NAME: 'kept',
  });
  assert.deepEqual(env, { PATH: '/bin', GIT_AUTHOR_NAME: 'kept' });
  for (const name of REPOSITORY_LOCATORS) {
    assert.deepEqual(repositoryNeutralEnvironment({ [name]: 'x' }), {}, name);
  }
  assert.ok(REPOSITORY_LOCATORS.includes('GIT_DIR') && REPOSITORY_LOCATORS.includes('GIT_WORK_TREE'));
  assert.ok(Object.isFrozen(REPOSITORY_LOCATORS));
});
