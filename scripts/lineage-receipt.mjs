#!/usr/bin/env node
/**
 * lineage-receipt.mjs — emit a holdout-safe lineage receipt, register an exposure, or check
 * that a receipt is still fresh.
 *
 * Usage
 *   node scripts/lineage-receipt.mjs --successor <dir> --predecessor <dir> --lineage <id>
 *                                    --declaration <path> [--sealed
 *                                    --sealed-manifest <path-outside-every-root>
 *                                    --t-seal <prose>] [--open-store <dir>]...
 *                                    [--receipt <path-outside-both-roots>] [--json]
 *
 *   node scripts/lineage-receipt.mjs --verify <receipt-path> --successor <dir>
 *                                    [--predecessor <dir>]
 *
 *   node scripts/lineage-receipt.mjs --register-exposure --lineage <id> --reader <ref>
 *                                    --released <digest> --register <path>
 *
 * WHAT `--sealed` CHANGES
 * -----------------------
 * A lineage is *declared* sealed; the declaration changes what this tool will emit and
 * refuses the combinations that make no sense. In sealed mode the cross-revision document is
 * written to `--sealed-manifest` and NOTHING about it but its digest reaches stdout or the
 * open receipt; the receipt does not name the predecessor at all. Without `--sealed` the tool
 * reproduces today's behaviour: both revisions' own fixed points, openly. A sealed manifest
 * path in unsealed mode is refused rather than ignored, and so is its absence in sealed mode.
 *
 * `--sealed-manifest` is REFUSED if it resolves inside the successor root, the predecessor
 * root, or any `--open-store`. `--receipt` is REFUSED if it resolves inside either measured
 * root. Both are decided on filesystem identity, so an 8.3 alias, a junction, a `\\?\`
 * spelling or an admin-share UNC path cannot walk around them — and at ANY nesting depth,
 * because the guard walks the target's whole chain of ancestors to the filesystem root
 * rather than a fixed number of them.
 *
 * `--declaration` is a JSON file carrying exactly `cleanliness`, `tests`, `evidence`,
 * `verdict` and `notesDigest` — the single-revision measurements the reviewer made. It never
 * carries a root, a path or a count of anything cross-revision.
 *
 * WRITE ORDER
 * -----------
 * Sealed manifest → fsync → digest → open receipt → fsync. Payload before pointer, always. A
 * crash can leave an orphaned sealed manifest, which publishes nothing, or a receipt naming a
 * digest that does not resolve, which is a refusal for its consumer. No crash window can
 * publish a vector.
 *
 * Both documents are content-addressed in effect: re-running against unmoved trees rewrites
 * byte-identical bytes, and the exposure register treats an identical release as a no-op.
 *
 * READ-ONLY with respect to both measured roots, unconditionally. There is no flag that makes
 * this command write inside `--successor` or `--predecessor`.
 *
 * Exit codes follow the product contract: 0 ok, 2 usage error, 3 fail-closed and nothing was
 * PUBLISHED.
 *
 * "Published" is the precise word and it is narrower than "written". Containment is decided
 * before any file OF EITHER MEASURED ROOT is read and before any parent directory is created,
 * so no refusal — containment or otherwise — ever writes inside a measured root or a declared
 * open store. That guarantee is unconditional. One file IS read earlier — `--declaration` —
 * which is why the guarantee names the measured trees rather than reads in general: that file
 * is the caller's own, nothing is measured from it, and this tool does not constrain where it
 * sits.
 *
 * But a refusal raised AFTER the sealed manifest is durable, a replay divergence for
 * instance, leaves that manifest orphaned in the sealed store. An orphan publishes nothing:
 * no open receipt points at it and no open artifact carries its digest. It is the deliberate
 * cost of writing the payload before the pointer, and it is cheaper than the failure that
 * order prevents.
 *
 * A refusal prints `REFUSED: <code>` and nothing else — error text is an open
 * document too, so no diagnostic here carries a path from either root, a row or a cardinality.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  buildLineageReceipt, verifyLineageReceipt, appendExposureRelease,
  assertSealedStoreContainment, canonicalLineageJson, lineageDocumentDigest,
  LINEAGE_TREE_RECIPE, LINEAGE_SEALED_MANIFEST_SCHEMA, LineageReceiptError,
} from '../src/lineage-receipt.mjs';

const KNOWN_FLAGS = new Set([
  'successor', 'predecessor', 'lineage', 'declaration', 'sealed', 'sealed-manifest', 't-seal',
  'open-store', 'receipt', 'json', 'verify', 'register-exposure', 'reader', 'released',
  'register', 'help',
]);
const VALUED_FLAGS = new Set([
  'successor', 'predecessor', 'lineage', 'declaration', 'sealed-manifest', 't-seal',
  'open-store', 'receipt', 'verify', 'reader', 'released', 'register',
]);
const REPEATED_FLAGS = new Set(['open-store']);

const USAGE = 'usage: node scripts/lineage-receipt.mjs --successor <dir> --predecessor <dir> '
  + '--lineage <id> --declaration <path> [--sealed --sealed-manifest <path> --t-seal <prose>] '
  + '[--open-store <dir>]... [--receipt <path>] [--json]\n'
  + '       node scripts/lineage-receipt.mjs --verify <receipt-path> --successor <dir> '
  + '[--predecessor <dir>]\n'
  + '       node scripts/lineage-receipt.mjs --register-exposure --lineage <id> --reader <ref> '
  + '--released <digest> --register <path>\n';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!KNOWN_FLAGS.has(name)) throw new Error(`unknown flag: ${token}`);
    if (!VALUED_FLAGS.has(name)) { flags[name] = true; continue; }
    const value = argv[i += 1];
    if (value === undefined) throw new Error(`${token} needs a value`);
    if (REPEATED_FLAGS.has(name)) (flags[name] ??= []).push(value);
    else if (flags[name] !== undefined) throw new Error(`${token} given more than once`);
    else flags[name] = value;
  }
  return flags;
}

/** Write bytes and make them durable before anything points at them. */
function writeDurable(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const handle = openSync(path, 'w');
  try {
    writeSync(handle, text);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function readDeclarationFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('--declaration must name a readable JSON file');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--declaration must contain one JSON object');
  }
  const wanted = ['cleanliness', 'evidence', 'notesDigest', 'tests', 'verdict'];
  const actual = Object.keys(parsed).sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`--declaration must carry exactly ${wanted.join(', ')}`);
  }
  return parsed;
}

function requireFlags(flags, names, mode) {
  for (const name of names) {
    if (flags[name] === undefined) throw new Error(`${mode} needs --${name}`);
  }
}

function forbidFlags(flags, names, why) {
  for (const name of names) {
    if (flags[name] !== undefined) throw new Error(`--${name} ${why}`);
  }
}

async function emit(flags) {
  requireFlags(flags, ['successor', 'predecessor', 'lineage', 'declaration'], 'emitting a receipt');
  const sealed = flags.sealed === true;
  if (sealed) requireFlags(flags, ['sealed-manifest', 't-seal'], '--sealed');
  else forbidFlags(flags, ['sealed-manifest', 't-seal'], 'is meaningless without --sealed');

  const limbs = readDeclarationFile(flags.declaration);
  const roots = [flags.successor, flags.predecessor];

  // Containment before any file of either measured root is read and before any parent
  // directory is created: a request that would write into a tree it measures never gets that
  // far. The declaration read just above is the caller's own file, and nothing is measured
  // from it; its path is not constrained here.
  if (sealed) {
    assertSealedStoreContainment(flags['sealed-manifest'], [...roots, ...(flags['open-store'] ?? [])]);
  }
  if (flags.receipt !== undefined) assertSealedStoreContainment(flags.receipt, roots);

  const sealedSink = sealed ? {
    async writeSealed(document) {
      const text = canonicalLineageJson(document);
      writeDurable(flags['sealed-manifest'], text);
      return { digest: lineageDocumentDigest(document) };
    },
  } : undefined;

  const declaration = Object.freeze({
    cleanliness: limbs.cleanliness,
    evidence: limbs.evidence,
    lineageId: flags.lineage,
    notesDigest: limbs.notesDigest,
    predecessorRoot: flags.predecessor,
    sealed,
    successorRoot: flags.successor,
    tests: limbs.tests,
    verdict: limbs.verdict,
    ...(sealed ? { tSeal: flags['t-seal'] } : {}),
  });

  const receipt = await buildLineageReceipt(declaration, sealedSink);
  const text = canonicalLineageJson(receipt);
  if (flags.receipt !== undefined) writeDurable(flags.receipt, `${text}\n`);

  if (flags.json) {
    process.stdout.write(`${text}\n`);
    return 0;
  }
  process.stdout.write(`schema=${receipt.schema}\n`
    + `lineage=${receipt.lineage_id}\n`
    + `sealed=${receipt.sealed}\n`
    + `successor=${LINEAGE_TREE_RECIPE} ${receipt.successor.digest}\n`
    + `successor-count=${receipt.successor.count}\n`
    + `successor-bytes=${receipt.successor.bytes}\n`
    + (receipt.sealed
      ? `sealed-manifest=${LINEAGE_SEALED_MANIFEST_SCHEMA} ${receipt.sealed_manifest.digest}\n`
      : `predecessor=${LINEAGE_TREE_RECIPE} ${receipt.predecessor.digest}\n`
        + `predecessor-count=${receipt.predecessor.count}\n`
        + `predecessor-bytes=${receipt.predecessor.bytes}\n`)
    + `verdict=${receipt.verdict === null ? '' : receipt.verdict}\n`);
  return 0;
}

function verify(flags) {
  requireFlags(flags, ['successor'], '--verify');
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(flags.verify, 'utf8'));
  } catch {
    throw new Error('--verify must name a readable JSON receipt');
  }
  const roots = receipt?.sealed === false
    ? { predecessorRoot: flags.predecessor, successorRoot: flags.successor }
    : { successorRoot: flags.successor };
  const result = verifyLineageReceipt(receipt, roots);
  process.stdout.write(`fresh=${result.fresh}\n`
    + `sealed=${result.sealed}\n`
    + `successor=${LINEAGE_TREE_RECIPE} ${result.successor.digest}\n`);
  return 0;
}

function registerExposure(flags) {
  requireFlags(flags, ['lineage', 'reader', 'released', 'register'], '--register-exposure');
  let existing = [];
  if (existsSync(flags.register)) {
    const lines = readFileSync(flags.register, 'utf8').split('\n').filter((line) => line.length > 0);
    try {
      existing = lines.map((line) => JSON.parse(line));
    } catch {
      throw new Error('--register must name a readable JSON-lines register');
    }
  }
  const records = appendExposureRelease(existing, {
    lineageId: flags.lineage, readerRef: flags.reader, releasedDigest: flags.released,
  });
  writeDurable(flags.register, records.map((record) => canonicalLineageJson(record)).join('\n') + '\n');
  process.stdout.write(`released=${records.length}\n`);
  return 0;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const modes = ['verify', 'register-exposure'].filter((name) => flags[name] !== undefined);
  if (modes.length > 1) throw new Error('--verify and --register-exposure are separate modes');
  if (flags['register-exposure'] !== undefined) return registerExposure(flags);
  if (flags.verify !== undefined) return verify(flags);
  return emit(flags);
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof LineageReceiptError) {
    process.stderr.write(`REFUSED: ${err.code}\n`);
    process.exit(3);
  }
  process.stderr.write(`usage error: ${err.message}\n`);
  process.exit(2);
}
