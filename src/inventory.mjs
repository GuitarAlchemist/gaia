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
 * How far the containment walk climbs before it gives up — a runaway guard, and not a
 * depth at which containment stops being checked.
 *
 * Termination does not rest on it: `dirname` reaches a fixed point for every string, so the
 * walk's own exit condition always fires on its own. The bound exists only so that a
 * pathological input cannot spin.
 *
 * It is a fail-closed depth ceiling, NOT an unreachable one. 4096 ancestors sits well beyond
 * any practical tree, but it is not beyond what a filesystem can hold: Linux imposes no limit
 * on total path length and allows 255 bytes per component, and Windows drops its 260-character
 * limit under the extended-length namespace or long-path opt-in. A chain that reaches this
 * bound is therefore a real input, not one argued away — which is precisely why exhausting it
 * has to have a specified, safe outcome.
 *
 * Because it decides nothing about containment, exhausting it REFUSES rather than
 * returning. A guard that falls out of its loop and returns has answered "outside every
 * root" — the one answer it has no evidence for, and the answer that lets a document land
 * inside a tree the caller is measuring.
 */
export const ANCESTOR_WALK_BOUND = 4096;

/**
 * Refuse to write anywhere inside any of a set of roots.
 *
 * A document that lands in a tree being measured changes that tree, so the digest reported
 * beside it is never the digest of the tree it was asked about — the output would be
 * self-referential, and a self-referential fixed point is worse than none. The same
 * refusal generalises to roots that are not measured but must stay free of a document:
 * the holdout-safe lineage seam needs a sealed store proved outside both revisions AND
 * outside every declared open document store, which is one guard against several roots
 * rather than a different guard.
 *
 * Containment is decided on filesystem identity where the path exists, exactly as the
 * output-directory guard does, so an 8.3 alias, a junction, the extended-length
 * namespace or an admin-share UNC spelling of a root cannot walk around it. Where
 * nothing on the chain exists, it falls back to comparing resolved strings, which is a
 * spelling test and is the weaker of the two — stated rather than implied.
 *
 * Containment is a property of the WHOLE chain from the target to the filesystem root: a
 * target is inside a root if that root is anywhere on its chain, at any distance. The walk
 * therefore runs to the filesystem root and stops only there. It is bounded by
 * `ANCESTOR_WALK_BOUND` against a runaway, and exhausting that bound is a refusal — an
 * undecided containment is never reported as a permitted one.
 *
 * An empty root set forbids nothing, so a caller with no roots to protect needs no
 * special case.
 *
 * @param {string[]} roots directories the target must stay outside of.
 * @param {string} targetPath the document's intended path.
 * @param {(target: string, base: string) => string} [describe] the refusal wording.
 */
export function assertPathOutsideRoots(roots, targetPath, describe = undefined) {
  const target = resolve(targetPath);
  const bases = roots.map((root) => resolve(root));
  const baseIds = bases.map(identityOf);

  const refuse = (base) => {
    throw new InventoryError(describe
      ? describe(target, base)
      : `${target} is inside ${base}, a root it must stay outside of; a document written `
        + 'inside a measured tree changes the digest reported beside it. Name a path '
        + 'outside every root.');
  };

  // The walk starts AT the target, not at its parent. A target that IS a forbidden root is
  // inside it in the only sense that matters here: naming a not-yet-existing path as both the
  // document's destination and a protected root would otherwise create that path and land the
  // document exactly at the root it had to stay outside of.
  let cursor = target;
  for (let steps = 0; steps < ANCESTOR_WALK_BOUND; steps += 1) {
    const id = identityOf(cursor);
    for (let index = 0; index < bases.length; index += 1) {
      if (baseIds[index] !== null && id !== null && id === baseIds[index]) refuse(bases[index]);
      if (cursor === bases[index]) refuse(bases[index]);
    }
    const parent = dirname(cursor);
    // The filesystem root, and the only way out of this loop that means anything: the
    // whole chain was walked and no forbidden root was on it.
    if (parent === cursor) return;
    cursor = parent;
  }

  // The runaway guard was exhausted before the chain ended, so containment was never
  // decided. Undecided is refused. The wording names neither the target nor any root:
  // there is no root to name, and a refusal message is an open document too.
  throw new InventoryError(
    'the ancestors of the named path could not be walked to the filesystem root within '
    + `${ANCESTOR_WALK_BOUND} steps, so whether it lies inside a forbidden root was never `
    + 'decided; an undecided containment is refused, never permitted. Name a shallower path.');
}

/**
 * Refuse to write a manifest anywhere inside the tree it describes.
 *
 * The one-root spelling of `assertPathOutsideRoots`, kept because it is the name every
 * existing caller and test uses and because its refusal says the one thing that matters
 * to a tool measuring a single tree: the manifest would be self-referential.
 */
export function assertManifestOutsideRoot(root, manifestPath) {
  assertPathOutsideRoots([root], manifestPath, (target, base) =>
    `${target} is inside the tree it measures (${base}); a self-referential `
    + 'manifest changes the digest it reports. Name a path outside the root.');
}
