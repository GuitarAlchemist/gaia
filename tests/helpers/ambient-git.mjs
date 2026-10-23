import { execFileSync } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ambient settings that hide an untracked `file` from an unpinned `git status`, one row per
 * source Git reads them from, plus the `clean` control (#251). A row is a set of environment
 * overrides, where `undefined` removes the variable. The files the rows name are written in `dir`.
 */
export function untrackedHidingRows(dir, file) {
  mkdirSync(dir, { recursive: true });
  const hidden = '[status]\n\tshowUntrackedFiles = no\n';
  const globalConfig = join(dir, 'global.gitconfig');
  writeFileSync(globalConfig, hidden, 'utf8');
  const home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), hidden, 'utf8');
  const excludes = join(dir, 'excludes');
  writeFileSync(excludes, `${file}\n`, 'utf8');
  // With core.excludesFile unset, Git reads a default ignore file. The row names it through
  // XDG_CONFIG_HOME, which Git prefers over $HOME/.config and which a Linux runner already sets.
  const xdgConfig = join(dir, 'xdg');
  mkdirSync(join(xdgConfig, 'git'), { recursive: true });
  writeFileSync(join(xdgConfig, 'git', 'ignore'), `${file}\n`, 'utf8');
  return {
    clean: {},
    GIT_CONFIG_COUNT: {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'status.showUntrackedFiles', GIT_CONFIG_VALUE_0: 'no',
    },
    GIT_CONFIG_PARAMETERS: { GIT_CONFIG_PARAMETERS: "'status.showUntrackedFiles=no'" },
    GIT_CONFIG_GLOBAL: { GIT_CONFIG_GLOBAL: globalConfig },
    HOME: { HOME: home, USERPROFILE: undefined, HOMEDRIVE: undefined, HOMEPATH: undefined },
    excludesFile: {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: excludes,
    },
    ignore: { XDG_CONFIG_HOME: xdgConfig },
  };
}

/**
 * Ambient settings that hide a change from a `git status` or `git diff` that trusts Git's file
 * system monitor, plus the `clean` control (#256). The hook named by `core.fsmonitor` prints a
 * token and no path, so once a read has stored the token in the index, Git believes that nothing
 * changed since. With `core.untrackedCache` the same read also stores which files are untracked,
 * and Git trusts the hook for that list too. The hook is written in `dir`; each run of it appends
 * a line to `dir/fsmonitor-ran`.
 */
export function changeHidingRows(dir) {
  mkdirSync(dir, { recursive: true });
  const fwd = (path) => path.replaceAll('\\', '/');
  const hook = join(dir, 'fsmonitor-hook');
  // Git runs the hook through its shell, which reads a backslash as an escape.
  writeFileSync(hook, `#!/bin/sh\necho ran >> "${fwd(join(dir, 'fsmonitor-ran'))}"\nprintf 'gaia-token\\0'\n`,
    { mode: 0o755 });
  const fsmonitor = { GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: fwd(hook) };
  return {
    clean: {},
    fsmonitor: { GIT_CONFIG_COUNT: '1', ...fsmonitor },
    'fsmonitor and untrackedCache': {
      GIT_CONFIG_COUNT: '2', ...fsmonitor,
      GIT_CONFIG_KEY_1: 'core.untrackedCache', GIT_CONFIG_VALUE_1: 'true',
    },
  };
}

/**
 * What the factory's `git status` reported in `cwd` before #256, under #255's pin alone, with the
 * NUL separators shown as `|`. Under a `changeHidingRows` row it also stores the hook's token, and
 * the untracked list, in the index, as the factory's own entry check did.
 */
export function pre256Status(cwd) {
  return execFileSync('git', [
    '-c', 'core.excludesFile=/dev/null', 'status', '--porcelain=v1', '-z', '--untracked-files=normal',
  ], { cwd, encoding: 'utf8', windowsHide: true }).replaceAll('\0', '|');
}

const ONE_SECOND = new Date(Date.UTC(2001, 0, 1));

/**
 * Sets the timestamp of the directory `cwd` to one whole second. Held across a prime and a change,
 * it stands in for a change that lands within the timestamp's resolution: an untracked cache built
 * then keeps a timestamp that still matches, and a later read that skips the monitor trusts the
 * cached list once the index is newer. In #256's controls the same cell passed or failed with the
 * clock until the tests held it.
 */
export function holdTimestamp(cwd) {
  utimesSync(cwd, ONE_SECOND, ONE_SECOND);
}

/** Primes `cwd` with `pre256Status`, then runs `change`, holding the timestamp across both. */
export function primeThenChange(cwd, change) {
  holdTimestamp(cwd);
  pre256Status(cwd);
  change(cwd);
  holdTimestamp(cwd);
}

/** Runs `fn` with `overrides` applied to `process.env`, then restores every key it touched. */
export async function withEnvironment(overrides, fn) {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Whether an unpinned `git status`, the factory's call before #251, shows anything in `cwd`. */
export function rawStatus(cwd) {
  const porcelain = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
  return porcelain === '' ? 'hidden' : 'shown';
}
