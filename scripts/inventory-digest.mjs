#!/usr/bin/env node
/**
 * inventory-digest.mjs — print the `inventory-digest/1` fixed point of a tree.
 *
 * Usage
 *   node scripts/inventory-digest.mjs [--root <dir>] [--json]
 *                                     [--manifest <path-outside-root>] [--print-manifest]
 *
 *   --root <dir>         tree to measure. Default: this plugin's own root.
 *   --json               emit one JSON object instead of the key=value lines.
 *   --manifest <path>    also write the exact hashed document to <path>.
 *                        REFUSED if <path> is inside --root: a manifest that lands in
 *                        the measured tree changes the tree, so the digest reported
 *                        beside it would not be the digest of the tree asked about.
 *   --print-manifest     print the hashed document to stdout before the summary.
 *                        Writes nothing anywhere.
 *
 * Default output, one field per line:
 *
 *   format=inventory-digest/1
 *   root=<absolute path measured>
 *   count=<files hashed>
 *   bytes=<total bytes hashed>
 *   digest=ordinal-path-bytes-sha256/1 <64 hex chars>
 *
 * The digest is never printed without the recipe that produced it, because a bare hex
 * string is the thing that gets copied into a review and later cannot be reproduced.
 *
 * READ-ONLY with respect to the measured tree, unconditionally. There is no flag that
 * makes this command write inside `--root`. It opens files for reading, computes, and
 * prints; `--manifest` is the only write it can perform and it cannot land in the root.
 *
 * The exact replay recipe, what each clause is for, and the deliberate compatibility
 * difference from the older `inventory-digest-1` label all live in `src/inventory.mjs`
 * and in the README's "Inventory digest" section.
 *
 * Exit codes follow the product contract: 0 ok, 2 usage error.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  inventoryRows, manifestDocument, assertManifestOutsideRoot,
  INVENTORY_FORMAT, INVENTORY_RECIPE, InventoryError,
} from '../src/inventory.mjs';
import { pluginRoot } from '../src/templates.mjs';
import { createHash } from 'node:crypto';

const KNOWN_FLAGS = new Set(['root', 'json', 'manifest', 'print-manifest', 'help']);
const VALUED_FLAGS = new Set(['root', 'manifest']);

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!KNOWN_FLAGS.has(name)) throw new Error(`unknown flag: ${token}`);
    if (VALUED_FLAGS.has(name)) {
      const value = argv[i += 1];
      if (value === undefined) throw new Error(`${token} needs a value`);
      flags[name] = value;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write('usage: node scripts/inventory-digest.mjs [--root <dir>] [--json] '
      + '[--manifest <path-outside-root>] [--print-manifest]\n');
    return 0;
  }

  const root = flags.root ?? pluginRoot();

  // Refused BEFORE anything is read or written, so a self-referential request never
  // gets as far as creating a parent directory for its own output.
  if (flags.manifest !== undefined) assertManifestOutsideRoot(root, flags.manifest);

  const rows = inventoryRows(root);
  const document = manifestDocument(rows);
  const result = {
    format: INVENTORY_FORMAT,
    recipe: INVENTORY_RECIPE,
    root,
    count: rows.length,
    bytes: rows.reduce((total, r) => total + r.bytes, 0),
    digest: createHash('sha256').update(document, 'utf8').digest('hex'),
  };

  if (flags.manifest !== undefined) {
    mkdirSync(dirname(flags.manifest), { recursive: true });
    // The file carries the hashed document plus one terminating newline, so it is a
    // well-formed text file. The document that was HASHED has no trailing newline; the
    // recipe is the document, not the file.
    writeFileSync(flags.manifest, document + '\n', 'utf8');
    result.manifest = flags.manifest;
  }

  if (flags['print-manifest']) process.stdout.write(document + '\n');

  if (flags.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  }
  process.stdout.write(`format=${result.format}\n`
    + `root=${result.root}\n`
    + `count=${result.count}\n`
    + `bytes=${result.bytes}\n`
    + (result.manifest ? `manifest=${result.manifest}\n` : '')
    + `digest=${result.recipe} ${result.digest}\n`);
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  const refused = err instanceof InventoryError;
  process.stderr.write(`${refused ? 'REFUSED' : 'usage error'}: ${err.message}\n`);
  process.exit(2);
}
