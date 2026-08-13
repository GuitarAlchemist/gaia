/**
 * inventory.mjs — `inventory-digest/1`: a tree fixed point anyone can recompute.
 *
 * Every review of this product binds its subject with a tree digest, and until now no
 * shipped code produced one. The label `inventory-digest-1` that names an earlier
 * snapshot is not reproducible from the tree it names, so each reviewing lane had to
 * state a private recipe and hope the next lane guessed the same one. A fixed point
 * nobody else can recompute is a claim, not evidence.
 *
 * THE RECIPE, EXACTLY
 * -------------------
 * `inventory-digest/1` is the output contract; `ordinal-path-bytes-sha256/1` is the
 * hash recipe it emits, and the digest is never printed without that recipe beside it.
 *
 *   1. Walk every regular file under the root, skipping any directory named `.git` or
 *      `node_modules` at any depth. Nothing else is skipped: dotfiles and hidden
 *      directories are ordinary files and are included.
 *   2. For each file, take its path RELATIVE to the root with every path separator
 *      rewritten to `/`, its exact byte count, and the SHA-256 of its exact bytes as
 *      lowercase hex.
 *   3. Emit one line per file, `relative/path|byte-count|file-sha256`.
 *   4. Sort those lines by their path, ORDINAL — by UTF-16 code unit, never
 *      `localeCompare`, never case-folded. `B.txt` < `Z.txt` < `_.txt` < `a.txt`.
 *   5. Join with LF. NO trailing LF.
 *   6. The digest is the SHA-256 of the UTF-8 encoding of that document, lowercase hex.
 *
 * WHY EACH CLAUSE IS THERE
 * ------------------------
 * - **Raw bytes, never decoded text.** A CRLF checkout and an LF checkout of the same
 *   sources are different trees and must have different fixed points. This repository
 *   pins `* -text` in `.gitattributes` precisely so that a clean checkout on any host
 *   reproduces the bytes that were hashed — without that pin the recipe would be
 *   reproducible only on the host that wrote it.
 * - **Ordinal, not locale.** `localeCompare` is host- and ICU-version-dependent, so a
 *   locale-aware sort silently produces a different fixed point on a different machine.
 * - **`/` separators, relative paths.** The hashed document contains no absolute path
 *   and no platform separator, so the digest is a function of the contents and the
 *   shape of the tree and of nothing else — including where the tree happens to sit.
 * - **No trailing LF.** Stated because it changes the digest, and because it is the
 *   detail two independent reimplementations most often disagree about.
 * - **An entry that is neither a regular file nor a directory is REFUSED**, by name,
 *   rather than silently skipped. Silently skipping is the dangerous direction: the
 *   result would be a fixed point of a tree that is not the tree on disk, and two hosts
 *   could disagree about which entries exist without either of them saying so.
 * - **Empty directories contribute nothing**, because only files are hashed. Two trees
 *   differing only in an empty directory share a digest, and that is stated rather than
 *   discovered.
 *
 * DELIBERATE COMPATIBILITY DIFFERENCE
 * -----------------------------------
 * This adopts the `ordinal-path-bytes-sha256/1` recipe an independent review stated and
 * used, byte for byte, so the value that review published for this tree is reproducible
 * here. It does NOT attempt to reproduce the older `inventory-digest-1` label attached
 * to an earlier snapshot: that value is not derivable from any tree this product ships,
 * and inventing a recipe that happened to hit it would be fitting a number rather than
 * defining one. Fixed points from before this module exist stay unreproducible, and are
 * to be treated as labels, not as digests.
 *
 * ON WINDOWS AND ON POSIX
 * -----------------------
 * On Windows `\` is a separator and cannot occur inside a file name, so rewriting it to
 * `/` is lossless. On POSIX `\` is a legal character IN a file name and is left exactly
 * as it is — only `/` is a separator there, and it is already the output form. A file
 * named `a\b` therefore digests differently from a file `b` inside a directory `a`, on
 * both platforms, which is the correct answer on both.
 *
 * This module reads. It creates nothing, writes nothing, and locks nothing.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** The output contract this module implements. */
export const INVENTORY_FORMAT = 'inventory-digest/1';

/** The hash recipe it emits. A digest is never reported without it. */
export const INVENTORY_RECIPE = 'ordinal-path-bytes-sha256/1';

/**
 * The only directory names excluded, at any depth.
 *
 * Fixed rather than configurable: an exclusion flag would make `inventory-digest/1`
 * ambiguous, and a digest whose meaning depends on the arguments it was produced with
 * is not a fixed point. Neither name occurs in this product's own shipped tree, so for
 * that tree the rule is stated but not load-bearing; it matters for a working copy.
 */
export const EXCLUDED_DIRECTORY_NAMES = Object.freeze(['.git', 'node_modules']);

/** Raised for anything that would make the reported digest not the tree's digest. */
export class InventoryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InventoryError';
  }
}

/** Ordinal string comparison. Not `localeCompare`, and not case-folded. */
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A relative path in the one spelling the recipe hashes.
 *
 * On Windows every separator becomes `/`; on POSIX a backslash is part of the file name
 * and survives untouched. See the platform note in the module header.
 */
const toRecipePath = (rel) => (sep === '\\' ? rel.split('\\').join('/') : rel);

/**
 * Every regular file under `root`, as `{ path, bytes, sha256 }`, in recipe order.
 *
 * Throws `InventoryError` if the root is not a readable directory, or if the walk meets
 * an entry that is neither a regular file nor a directory.
 */
export function inventoryRows(root) {
  const base = resolve(root);
  let stat;
  try {
    stat = statSync(base);
  } catch (err) {
    throw new InventoryError(`${base}: cannot be read as a directory (${err.code ?? err.message})`);
  }
  if (!stat.isDirectory()) throw new InventoryError(`${base}: not a directory`);

  const rows = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.includes(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      const full = join(dir, entry.name);
      const rel = toRecipePath(relative(base, full));
      if (!entry.isFile()) {
        // Named, not skipped: see the module header. A symbolic link, junction, socket,
        // FIFO or device node has no byte content this recipe can define, and omitting
        // it would produce a fixed point of a tree that is not the one on disk.
        throw new InventoryError(`${rel}: not a regular file, and this recipe refuses to `
          + 'silently omit an entry it cannot hash');
      }
      const buf = readFileSync(full);
      rows.push({ path: rel, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
    }
  };
  walk(base);

  // Sorted after the walk, never relying on directory order: `readdir` order is a
  // filesystem detail and differs between hosts and between runs.
  rows.sort((a, b) => ordinal(a.path, b.path));
  return rows;
}

/** The exact document that gets hashed: LF-joined lines, no trailing LF. */
export function manifestDocument(rows) {
  return rows.map((r) => `${r.path}|${r.bytes}|${r.sha256}`).join('\n');
}

/**
 * The fixed point of a tree: format, recipe, file count, byte total, digest.
 *
 * Pure with respect to the filesystem — it opens files for reading and creates nothing.
 */
export function inventoryDigest(root) {
  const rows = inventoryRows(root);
  const document = manifestDocument(rows);
  return {
    format: INVENTORY_FORMAT,
    recipe: INVENTORY_RECIPE,
    count: rows.length,
    bytes: rows.reduce((total, r) => total + r.bytes, 0),
    digest: createHash('sha256').update(document, 'utf8').digest('hex'),
  };
}

/** The filesystem's own identity for a path that exists: volume plus file id. */
function identityOf(p) {
  try {
    const st = statSync(p, { bigint: true });
    return st.dev && st.ino ? `${st.dev}:${st.ino}` : null;
  } catch {
    return null;
  }
}

/**
 * Refuse to write a manifest anywhere inside the tree it describes.
 *
 * A manifest that lands in the measured tree changes that tree, so the digest reported
 * beside it is never the digest of the tree it was asked about — the output would be
 * self-referential, and a self-referential fixed point is worse than none. This is a
 * refusal rather than a documented caveat for that reason.
 *
 * Containment is decided on filesystem identity where the path exists, exactly as the
 * output-directory guard does, so an 8.3 alias, a junction, the extended-length
 * namespace or an admin-share UNC spelling of the root cannot walk around it. Where
 * nothing on the chain exists, it falls back to comparing resolved strings, which is a
 * spelling test and is the weaker of the two — stated rather than implied.
 */
export function assertManifestOutsideRoot(root, manifestPath) {
  const base = resolve(root);
  const target = resolve(manifestPath);
  const baseId = identityOf(base);

  const refuse = () => {
    throw new InventoryError(`${target} is inside the tree it measures (${base}); a self-referential `
      + 'manifest changes the digest it reports. Name a path outside the root.');
  };

  let cursor = dirname(target);
  for (let depth = 0; depth < 64; depth += 1) {
    const id = identityOf(cursor);
    if (baseId !== null && id !== null && id === baseId) refuse();
    if (cursor === base) refuse();
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
