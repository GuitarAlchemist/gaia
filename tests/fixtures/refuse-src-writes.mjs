/**
 * refuse-src-writes.mjs — preload that refuses, and records, every write a test aims
 * at the shipped tree.
 *
 * Loaded through `NODE_OPTIONS=--import=<this file>` so it reaches every process the
 * `node:test` runner spawns. `GAIA_SRC_WRITE_GUARD_ROOT` names the directory to guard
 * and `GAIA_SRC_WRITE_GUARD_LOG` the file that receives one JSON line per refused call.
 * Without both variables the preload is inert.
 *
 * Why it exists (#98): a production gate planted a transient mutant inside `src/` while
 * the product gates, and `verify`, enumerated that same tree; one full run in three saw
 * the entry in `readdir` and ENOENT on `open`. The tree that ships is read-only to the
 * suite, and this preload is how that invariant is measured rather than trusted.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const guarded = process.env.GAIA_SRC_WRITE_GUARD_ROOT;
const log = process.env.GAIA_SRC_WRITE_GUARD_LOG;

if (guarded && log) {
  const root = `${resolve(guarded).toLowerCase()}${sep}`;
  const append = fs.appendFileSync;
  const WRITE_FLAG = /[wa+]/;

  const toPath = (target) => {
    if (target instanceof URL) return fileURLToPath(target);
    if (Buffer.isBuffer(target)) return target.toString();
    return typeof target === 'string' ? target : null;
  };
  const opensForWrite = (flags) => (typeof flags === 'string'
    ? WRITE_FLAG.test(flags)
    : typeof flags === 'number' && (flags & 3) !== 0);
  const refuse = (operation, target) => {
    const path = toPath(target);
    if (path === null || !`${resolve(path).toLowerCase()}${sep}`.startsWith(root)) return;
    append(log, `${JSON.stringify({ operation, path: resolve(path), pid: process.pid })}\n`);
    const error = new Error(`refused ${operation} under the guarded tree: ${path}`);
    error.code = 'GAIA_SRC_WRITE_REFUSED';
    throw error;
  };
  const guard = (owner, name, targetIndex, label = name) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = function guardedFsCall(...args) {
      refuse(label, args[targetIndex]);
      return original.apply(this, args);
    };
  };
  const guardOpen = (owner, name, label = name) => {
    const original = owner[name];
    owner[name] = function guardedOpen(path, flags, ...rest) {
      if (opensForWrite(flags)) refuse(label, path);
      return original.call(this, path, flags, ...rest);
    };
  };

  const DESTINATION_FIRST = ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rmdir', 'truncate'];
  const DESTINATION_SECOND = ['copyFile', 'rename', 'link', 'symlink', 'cp'];
  for (const name of DESTINATION_FIRST) {
    guard(fs, name, 0);
    guard(fs, `${name}Sync`, 0);
    guard(fs.promises, name, 0, `promises.${name}`);
  }
  for (const name of DESTINATION_SECOND) {
    guard(fs, name, 1);
    guard(fs, `${name}Sync`, 1);
    guard(fs.promises, name, 1, `promises.${name}`);
  }
  guard(fs, 'createWriteStream', 0);
  guardOpen(fs, 'open');
  guardOpen(fs, 'openSync');
  guardOpen(fs.promises, 'open', 'promises.open');
  syncBuiltinESMExports();
}
