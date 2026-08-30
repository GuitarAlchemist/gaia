/**
 * path-identity.mjs — "is this output the same file as an input?", decided once.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `resolve()` normalises separators and `..`. It does not resolve case, 8.3 short names,
 * junctions, the extended-length namespace or UNC admin-share spellings, so on the platform this
 * product is documented for, two different strings routinely name one file. An adapter that
 * compared resolved strings therefore accepted
 *
 *   --projection <dir>/projection.json  --snapshot-out <dir>/Projection.json
 *
 * and **overwrote the input drain projection with its own output**, after which the next run read
 * its own snapshot back as a portfolio projection. That was reproduced against the shipped
 * adapter, not hypothesised.
 *
 * The correct rule already shipped in this tree — twice, in two files, with one of them describing
 * a string comparison as "a spelling test and ... the weaker of the two" — and the third adapter
 * never got it. Two copies of a rule that disagree is the defect; this module is the repair, so
 * there is exactly one definition and both adapters import it.
 *
 * WHAT AN IDENTITY IS
 * -------------------
 * `dev:ino:<case-folded non-existent tail>`. The walk climbs to the nearest ancestor that exists,
 * takes the filesystem's own identity for it, and appends the not-yet-created suffix — so an
 * output path whose file does not exist yet still compares correctly against an input whose file
 * does. The tail is case-folded on platforms whose filesystems are case-insensitive, because there
 * the two spellings genuinely are one file.
 *
 * This module reads directory metadata and nothing else. It opens no file, writes nothing, and
 * creates nothing.
 */

import { statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/**
 * Where two spellings that differ only in case name one file. Decided by platform rather than by
 * probing, because probing would mean creating a file to find out.
 */
export const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

/** A bound on the climb, so a pathological path cannot spin. */
const MAX_PATH_DEPTH = 256;

/**
 * The filesystem identity of `path`, comparable with `===`.
 *
 * Falls back to the case-folded resolved string only when no ancestor at all can be stat'd, which
 * is strictly better than the string comparison it replaces and never worse.
 */
export function pathIdentity(path) {
  const supplied = resolve(path);
  let cursor = supplied;
  const tail = [];
  for (let depth = 0; depth < MAX_PATH_DEPTH; depth += 1) {
    try {
      const physical = statSync(cursor, { bigint: true });
      const suffix = tail.reverse().join('/');
      const canonicalSuffix = CASE_INSENSITIVE_PATHS ? suffix.toLowerCase() : suffix;
      return `${physical.dev}:${physical.ino}:${canonicalSuffix}`;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      tail.push(basename(cursor));
      cursor = parent;
    }
  }
  return CASE_INSENSITIVE_PATHS ? supplied.toLowerCase() : supplied;
}

/**
 * Refuse when any two of `paths` are one file, or when any output is one of the inputs.
 *
 * `refuse` is supplied by the caller so each adapter keeps its own typed usage error rather than
 * this module inventing a third error class for a question it only answers.
 */
export function assertDistinctFiles({ outputs, inputs = [], refuse }) {
  const outputIdentities = outputs.map(pathIdentity);
  if (new Set(outputIdentities).size !== outputIdentities.length) {
    refuse('two outputs name the same file');
  }
  const inputIdentities = new Set(inputs.filter(Boolean).map(pathIdentity));
  if (outputIdentities.some((identity) => inputIdentities.has(identity))) {
    refuse('an output path aliases an input evidence path');
  }
}
