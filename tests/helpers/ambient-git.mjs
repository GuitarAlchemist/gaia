import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
