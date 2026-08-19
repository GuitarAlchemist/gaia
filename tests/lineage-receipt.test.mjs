/**
 * lineage-receipt.test.mjs — the holdout-safe lineage receipt, driven from its controls.
 *
 * The module under test exists for one reason: for a lineage declared **sealed**, no open
 * artifact may carry a quantity that is a function of BOTH revisions. The changed/unchanged
 * split of a revision pair is the label vector of a per-file holdout population, and once it
 * is published no procedure recovers the population's unseen status. `docs/holdout-safe-
 * reporting.md` states the rule; this file is where the machine-checkable part of it is
 * actually driven.
 *
 * These gates are therefore written against the ways such a seam is usually wrong, not
 * against its happy path:
 *
 *   - an innocuous-looking open field turns out to be a function of the changed count;
 *   - the sealed document is "filtered" on one channel instead of routed to two;
 *   - containment is decided on how a path is SPELLED, so an 8.3 alias, a junction, a
 *     `\\?\` spelling or an admin-share UNC walks straight around it;
 *   - a refusal message helpfully interpolates the offending path;
 *   - the receipt quietly re-derives against a tree that moved, instead of refusing;
 *   - a wall clock creeps in and the receipt stops being reproducible.
 *
 * Every negative control below (`NC-H1`-`NC-H7`, `NC-H9`, `NC-H10`) is paired with a stated
 * non-vacuity mutation in the writer handoff: the control passes on the pristine module and
 * fires on the mutant. `NC-H8` — no seventh bus verb, no widened verb — deliberately adds no
 * test here: the five existing gates (`tests/product.test.mjs`, `tests/interop.test.mjs`,
 * `tests/prototype-pollution.test.mjs`, `src/verify.mjs`, and `BUS_VERBS` frozen in
 * `src/bus-core.mjs`) are that control, and duplicating them would weaken rather than
 * strengthen the evidence.
 *
 * Nothing here reads a real holdout, constitutes a curator, mints a real seal, or calls the
 * bus. Every root is a synthetic temp tree and every sink is in memory or a scratch file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
  symlinkSync,
} from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  buildLineageReceipt, verifyLineageReceipt, appendExposureRelease,
  assertSealedStoreContainment, canonicalLineageJson, lineageDocumentDigest,
  LINEAGE_RECEIPT_SCHEMA, LINEAGE_SEALED_MANIFEST_SCHEMA, LINEAGE_EXPOSURE_REGISTER_SCHEMA,
  LINEAGE_ERROR_SCHEMA, LINEAGE_TREE_RECIPE, LINEAGE_REFUSALS,
  SEALED_RECEIPT_KEYS, UNSEALED_RECEIPT_KEYS, LineageReceiptError,
} from '../src/lineage-receipt.mjs';
import {
  inventoryRows, inventoryDigest, assertPathOutsideRoots, assertManifestOutsideRoot,
  INVENTORY_RECIPE, InventoryError, ANCESTOR_WALK_BOUND,
} from '../src/inventory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'scripts', 'lineage-receipt.mjs');
const INVENTORY_CLI = join(ROOT, 'scripts', 'inventory-digest.mjs');

const SCRATCH = mkdtempSync(join(tmpdir(), 'gaia-interagent-lr-'));
let counter = 0;

test.after(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

/** Build a tree from a `{ 'a/b.txt': <string|Buffer> }` map. Returns its root. */
function tree(files, label = 'tree') {
  const root = join(SCRATCH, `${label}-${counter += 1}`);
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** A path inside SCRATCH that no test has used yet. */
const scratchPath = (label) => join(SCRATCH, `${label}-${counter += 1}`);

/**
 * The cleanliness / tests / evidence limbs of a declaration.
 *
 * The integers are chosen to avoid 2, 3, 6 and 7, which the `NC-H6` fixture uses as its
 * cross-revision cardinalities: a collision there would let the leak check pass by accident.
 */
const LIMBS = Object.freeze({
  cleanliness: Object.freeze({
    readOnlyAll: false, reparsePoints: 0, alternateStreams: 0, porcelainLines: 0,
  }),
  tests: Object.freeze({
    passed: 41, failed: 0, deterministicRepeats: 5, mutationsTotal: 11, mutationsDiscriminating: 11,
  }),
  evidence: Object.freeze([Object.freeze({ label: 'standards-review', digest: DIGEST_A })]),
  verdict: 'APPROVE',
  notesDigest: DIGEST_B,
});

function declaration(overrides = {}) {
  const base = {
    lineageId: 'lineage-alpha',
    sealed: true,
    successorRoot: overrides.successorRoot,
    predecessorRoot: overrides.predecessorRoot,
    cleanliness: { ...LIMBS.cleanliness },
    tests: { ...LIMBS.tests },
    evidence: LIMBS.evidence.map((e) => ({ ...e })),
    verdict: LIMBS.verdict,
    notesDigest: LIMBS.notesDigest,
    tSeal: 'sealed before the successor existed; forward-only',
  };
  const merged = { ...base, ...overrides };
  if (merged.sealed === false && !('tSeal' in overrides)) delete merged.tSeal;
  return Object.freeze(merged);
}

/** A sink that records what it was handed and reports the digest the module computed. */
function memorySink(options = {}) {
  const written = [];
  return {
    written,
    async writeSealed(document) {
      written.push(document);
      if (options.beforeReturn) options.beforeReturn(document);
      if (options.throws) throw options.throws;
      if (options.digest !== undefined) return { digest: options.digest };
      return { digest: lineageDocumentDigest(document) };
    },
  };
}

function run(cli, args, options = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end();
    child.on('close', (code) => res({ code, stdout, stderr }));
  });
}

/** Every file under a root, so a test can prove a refusal created nothing. */
function everyFile(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) everyFile(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** `{ 'a.b': leaf }` for every leaf in a plain JSON value. Arrays index numerically. */
function flatten(value, prefix = '', acc = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, acc));
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) flatten(value[key], prefix ? `${prefix}.${key}` : key, acc);
  } else {
    acc[prefix] = value;
  }
  return acc;
}

/** Every key name appearing anywhere in a plain JSON value. */
function everyKey(value, acc = []) {
  if (Array.isArray(value)) value.forEach((item) => everyKey(item, acc));
  else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) { acc.push(key); everyKey(value[key], acc); }
  }
  return acc;
}

const sorted = (list) => [...list].sort();

/** The 8.3 short spelling of an existing path, or null where the volume has none. */
function shortName(p) {
  try {
    const out = execSync(`for %I in ("${p}") do @echo %~sI`, { encoding: 'utf8', shell: 'cmd.exe' }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// NC-H1 — a cross-revision field creeps into the open receipt
// ---------------------------------------------------------------------------------------

test('NC-H1: the sealed open receipt key set is exactly the closed allow-list, recursively', async () => {
  // The field set is CLOSED, not extensible: a field that is a function of both revisions is
  // a schema violation, not a feature. This asserts the key set at every level, and asserts
  // separately that no predecessor field of any kind survives into sealed mode — the pairing
  // itself is a cross-revision quantity.
  const predecessor = tree({ 'a.txt': 'one\n', 'b/c.txt': 'two\n' }, 'nch1-p');
  const successor = tree({ 'a.txt': 'ONE\n', 'b/c.txt': 'two\n', 'd.txt': 'new\n' }, 'nch1-s');
  const sink = memorySink();

  const receipt = await buildLineageReceipt(declaration({ successorRoot: successor, predecessorRoot: predecessor }), sink);

  assert.deepEqual(sorted(Object.keys(receipt)), sorted(SEALED_RECEIPT_KEYS),
    'the top-level key set equals the closed sealed allow-list exactly');
  assert.deepEqual(sorted(Reflect.ownKeys(receipt)), sorted(SEALED_RECEIPT_KEYS),
    'and there is no non-enumerable field hiding beside it');
  assert.equal(Object.getPrototypeOf(receipt), Object.prototype, 'the receipt is a plain object');
  assert.ok(Object.isFrozen(receipt), 'and it is frozen, so a consumer cannot graft a field on afterwards');

  assert.deepEqual(sorted(Object.keys(receipt.successor)), ['bytes', 'count', 'digest']);
  assert.deepEqual(sorted(Object.keys(receipt.sealed_manifest)), ['digest', 'schema']);
  assert.deepEqual(sorted(Object.keys(receipt.cleanliness)),
    ['alternate_streams', 'porcelain_lines', 'read_only_all', 'reparse_points']);
  assert.deepEqual(sorted(Object.keys(receipt.tests)),
    ['deterministic_repeats', 'failed', 'mutations_discriminating', 'mutations_total', 'passed']);
  for (const item of receipt.evidence) assert.deepEqual(sorted(Object.keys(item)), ['digest', 'label']);

  assert.equal(receipt.schema, LINEAGE_RECEIPT_SCHEMA);
  assert.equal(receipt.recipe, LINEAGE_TREE_RECIPE, 'the digest never travels without its recipe');
  assert.equal(receipt.sealed, true);
  assert.equal(receipt.sealed_manifest.schema, LINEAGE_SEALED_MANIFEST_SCHEMA);

  // No predecessor field of any kind, under any spelling, at any depth.
  const keys = everyKey(receipt).map((k) => k.toLowerCase());
  for (const forbidden of ['predecessor', 'previous', 'prior', 'parent', 'base', 'before', 'from',
    'changed', 'unchanged', 'added', 'removed', 'renamed', 'diff', 'delta', 'pair', 'pairing']) {
    assert.ok(!keys.some((k) => k.includes(forbidden)),
      `no key at any depth contains "${forbidden}": ${keys.join(',')}`);
  }
  assert.ok(!('bytes' in receipt.sealed_manifest),
    'sealed_manifest.bytes is forbidden: the manifest length tracks the changed count');

  // The successor limb is a function of the successor alone, so anyone holding S recomputes it.
  assert.deepEqual(receipt.successor, {
    bytes: inventoryDigest(successor).bytes,
    count: inventoryDigest(successor).count,
    digest: inventoryDigest(successor).digest,
  });
});

// ---------------------------------------------------------------------------------------
// NC-H2 — the sealed manifest lands in an open store
// ---------------------------------------------------------------------------------------

test('NC-H2: sealed-store containment is decided on filesystem identity, in every alias spelling', () => {
  // Containment is the design's ONE machine-enforced property. It has to hold on identity
  // rather than spelling, because every spelling below names the same directory and a string
  // comparison lets all but the first one through.
  const successor = tree({ 'a.txt': 'a\n' }, 'nch2-s');
  const predecessor = tree({ 'a.txt': 'b\n' }, 'nch2-p');
  const openStore = tree({ 'reviews/keep.md': '# open\n' }, 'nch2-open');
  const roots = [successor, predecessor, openStore];
  const before = roots.flatMap((r) => everyFile(r));

  const spellings = new Map();
  const add = (label, value) => { if (value) spellings.set(label, value); };

  // Built by concatenation, not by `join`, because `join` normalises the very spellings the
  // guard has to survive — a normalised fixture would be testing `path.join`, not the guard.
  for (const [name, root] of [['successor', successor], ['predecessor', predecessor], ['open-store', openStore]]) {
    add(`${name}:plain`, `${root}${sep}manifest.txt`);
    add(`${name}:nested`, `${root}${sep}deep${sep}nested${sep}manifest.txt`);
    add(`${name}:trailing`, `${root}${sep}${sep}manifest.txt`);
    add(`${name}:doubled`, `${root}${sep}${sep}${sep}manifest.txt`);
    add(`${name}:dotseg`, `${root}${sep}.${sep}manifest.txt`);
    add(`${name}:dotdot`, `${root}${sep}sub${sep}..${sep}manifest.txt`);
    if (process.platform === 'win32') {
      add(`${name}:case`, `${root.toUpperCase()}${sep}manifest.txt`);
      add(`${name}:extended`, `\\\\?\\${root}${sep}manifest.txt`);
      add(`${name}:unc-admin`, `\\\\localhost\\${root[0]}$${root.slice(2)}${sep}manifest.txt`);
      const short = shortName(root);
      add(`${name}:short8.3`, short ? `${short}${sep}manifest.txt` : null);
    }
  }

  // A junction OUTSIDE every root, pointing at one of them: the classic way to launder a
  // forbidden destination into a permitted-looking path.
  const junction = scratchPath('nch2-junction');
  let junctionMade = null;
  for (const kind of process.platform === 'win32' ? ['junction'] : ['dir']) {
    try { symlinkSync(successor, junction, kind); junctionMade = kind; break; } catch { /* try the next */ }
  }
  assert.ok(junctionMade,
    'this host must allow a junction or directory symlink, or the alias case cannot be driven at all');
  add('junction:into-successor', join(junction, 'manifest.txt'));

  // Every spelling that resolves must resolve to the SAME directory the plain spelling names.
  // A spelling this host cannot resolve is reported by name rather than quietly dropped.
  const unresolvable = [];
  for (const [label, candidate] of spellings) {
    const parent = dirname(resolve(candidate));
    if (!existsSync(parent) && !/nested|dotdot/.test(label)) unresolvable.push(label);
  }
  assert.deepEqual(unresolvable, [],
    `every alias spelling must exist on this host, or the control is not being driven: ${unresolvable.join(', ')}`);

  const expectedSpellings = process.platform === 'win32' ? 31 : 19;
  assert.equal(spellings.size, expectedSpellings,
    `every enumerated spelling was constructed: ${[...spellings.keys()].join(', ')}`);

  for (const [label, candidate] of spellings) {
    assert.throws(
      () => assertSealedStoreContainment(candidate, roots),
      (err) => err instanceof LineageReceiptError && err.code === 'SealedStoreContainment',
      `${label} is refused on identity, not on spelling`,
    );
  }

  // -------------------------------------------------------------------------------------
  // The depth axis. Every spelling above is a direct child or two levels down, but the guard
  // decides containment by walking ANCESTORS — so a control that never nests deeply varies
  // spelling thoroughly and the walk not at all, and cannot see a bound on that walk. A
  // destination is inside a root if the root is anywhere on its chain to the filesystem root,
  // at any distance; "inside" has no depth at which it stops being true.
  // -------------------------------------------------------------------------------------
  const DEEP = 70;
  const deepTail = Array.from({ length: DEEP }, () => 'a');
  const deepSpellings = new Map();

  for (const [name, root] of [['successor', successor], ['predecessor', predecessor], ['open-store', openStore]]) {
    // Materialised on disk, so the deep case is decided on filesystem identity like the
    // shallow ones and not only on how the destination happens to be spelled.
    const parent = join(root, ...deepTail);
    mkdirSync(parent, { recursive: true });
    assert.ok(existsSync(parent),
      `this host must hold a ${DEEP}-deep fixture, or the depth axis is not being driven at all`);
    deepSpellings.set(`${name}:deep-${DEEP}`, join(parent, 'manifest.txt'));

    // And a chain far longer than any filesystem will hold, left unmaterialised: this falls
    // back to the weaker resolved-string comparison, which still has to walk the whole chain.
    deepSpellings.set(`${name}:deep-1024-unmaterialised`,
      join(root, ...Array.from({ length: 1024 }, () => 'a'), 'manifest.txt'));
  }

  assert.equal(deepSpellings.size, 6,
    `every depth spelling was constructed: ${[...deepSpellings.keys()].join(', ')}`);

  for (const [label, candidate] of deepSpellings) {
    assert.throws(
      () => assertPathOutsideRoots(roots, candidate),
      InventoryError,
      `${label} is inside a forbidden root, and the underlying guard says so`,
    );
    assert.throws(
      () => assertSealedStoreContainment(candidate, roots),
      (err) => err instanceof LineageReceiptError && err.code === 'SealedStoreContainment',
      `${label} is refused at whatever depth it sits, not only near the top of the tree`,
    );
  }

  // Depth is not itself a refusal reason. The same nesting outside every root is still
  // permitted, so the depth axis is a guard rather than a blanket deep-path refusal wearing
  // a containment name.
  const deepOutside = join(scratchPath('nch2-deep-store'), ...deepTail, 'manifest.txt');
  mkdirSync(dirname(deepOutside), { recursive: true });
  assert.doesNotThrow(() => assertSealedStoreContainment(deepOutside, roots),
    'a sealed store sited deep, but outside every root, is permitted');
  assert.doesNotThrow(() => assertPathOutsideRoots(roots, deepOutside),
    'and the underlying guard agrees');

  // A destination genuinely outside every root is permitted, so the control is a guard and
  // not a blanket refusal that would pass vacuously.
  const outside = join(scratchPath('nch2-sealed-store'), 'manifest.txt');
  assert.doesNotThrow(() => assertSealedStoreContainment(outside, roots),
    'a sealed store sited outside every root is permitted');

  assert.deepEqual(roots.flatMap((r) => everyFile(r)), before, 'a refusal wrote nothing anywhere');
});

// ---------------------------------------------------------------------------------------
// NC-H3 — cardinality leaks through a size-correlated field
// ---------------------------------------------------------------------------------------

test('NC-H3: two successors of one predecessor, differing greatly in change size, give indistinguishable receipts', async () => {
  // The novel control, and the important one. Every other gate asserts a property of a single
  // output; this asserts a DIFFERENTIAL property across two, and it is the only one that
  // catches cardinality leaking through an innocuous-looking field such as a manifest length.
  //
  // Both successors keep the predecessor's file count and byte total exactly, so `successor.count`
  // and `successor.bytes` are equal by construction and the only thing that CAN differ is
  // content. One changes a single file; the other changes twelve.
  const files = {};
  for (let i = 0; i < 16; i += 1) files[`f${String(i).padStart(2, '0')}.txt`] = `aaaa\n`;
  const predecessor = tree(files, 'nch3-p');

  const small = { ...files, 'f00.txt': 'bbbb\n' };
  const large = { ...files };
  for (let i = 0; i < 12; i += 1) large[`f${String(i).padStart(2, '0')}.txt`] = 'bbbb\n';

  const successorSmall = tree(small, 'nch3-s-small');
  const successorLarge = tree(large, 'nch3-s-large');

  const sinkSmall = memorySink();
  const sinkLarge = memorySink();
  const shared = { lineageId: 'lineage-shared', predecessorRoot: predecessor };
  const receiptSmall = await buildLineageReceipt(declaration({ ...shared, successorRoot: successorSmall }), sinkSmall);
  const receiptLarge = await buildLineageReceipt(declaration({ ...shared, successorRoot: successorLarge }), sinkLarge);

  // The sealed side really did see very different change sizes — otherwise this control would
  // be comparing two identical situations and proving nothing.
  assert.equal(sinkSmall.written[0].cardinalities.changed, 1);
  assert.equal(sinkLarge.written[0].cardinalities.changed, 12);

  const flatSmall = flatten(receiptSmall);
  const flatLarge = flatten(receiptLarge);
  assert.deepEqual(sorted(Object.keys(flatSmall)), sorted(Object.keys(flatLarge)),
    'the two receipts have identical shape');

  const differing = Object.keys(flatSmall).filter((k) => flatSmall[k] !== flatLarge[k]).sort();
  assert.deepEqual(differing, ['sealed_manifest.digest', 'successor.digest'],
    'they differ ONLY in successor.* and sealed_manifest.digest');

  assert.equal(receiptSmall.successor.count, receiptLarge.successor.count);
  assert.equal(receiptSmall.successor.bytes, receiptLarge.successor.bytes);

  const jsonSmall = canonicalLineageJson(receiptSmall);
  const jsonLarge = canonicalLineageJson(receiptLarge);
  assert.equal(Buffer.byteLength(jsonSmall, 'utf8'), Buffer.byteLength(jsonLarge, 'utf8'),
    'and the total receipt byte length is identical: nothing in it tracks the size of the change');

  // The sealed manifests DO differ in length. That is exactly why their length may not be published.
  const sealedSmall = canonicalLineageJson(sinkSmall.written[0]);
  const sealedLarge = canonicalLineageJson(sinkLarge.written[0]);
  assert.notEqual(Buffer.byteLength(sealedSmall, 'utf8'), Buffer.byteLength(sealedLarge, 'utf8'),
    'the sealed manifest length tracks the changed count, which is why sealed_manifest.bytes is forbidden');
});

// ---------------------------------------------------------------------------------------
// NC-H4 — non-determinism
// ---------------------------------------------------------------------------------------

test('NC-H4: the receipt is byte-identical across repeats, locales, timezones and working directories',
  { timeout: 120_000 }, async () => {
    // A receipt that is not reproducible is a claim rather than evidence, and a wall clock is
    // the usual way reproducibility is lost. There is no clock anywhere in this design: freshness
    // is decided by digest resolution, never by time.
    const predecessor = tree({ 'a.txt': 'one\n', 'Z.txt': 'z\n', '_.txt': 'u\n' }, 'nch4-p');
    const successor = tree({ 'a.txt': 'ONE\n', 'Z.txt': 'z\n', '_.txt': 'u\n', 'i.txt': 'I\n' }, 'nch4-s');

    const inMemory = [];
    for (let i = 0; i < 3; i += 1) {
      const sink = memorySink();
      inMemory.push(canonicalLineageJson(
        await buildLineageReceipt(declaration({ successorRoot: successor, predecessorRoot: predecessor }), sink),
      ));
    }
    assert.equal(new Set(inMemory).size, 1, 'three in-process repeats are byte-identical');

    const declFile = scratchPath('nch4-decl.json');
    writeFileSync(declFile, JSON.stringify({
      cleanliness: LIMBS.cleanliness,
      tests: LIMBS.tests,
      evidence: LIMBS.evidence,
      verdict: LIMBS.verdict,
      notesDigest: LIMBS.notesDigest,
    }), 'utf8');

    const environments = [
      { label: 'C/UTC/repo', env: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }, cwd: ROOT },
      { label: 'tr_TR/Kiritimati/scratch', env: { LC_ALL: 'tr_TR.UTF-8', LANG: 'tr_TR.UTF-8', TZ: 'Pacific/Kiritimati' }, cwd: SCRATCH },
      { label: 'de_DE/Chatham/tmp', env: { LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8', TZ: 'Pacific/Chatham' }, cwd: tmpdir() },
    ];

    const emitted = [];
    for (const [index, environment] of environments.entries()) {
      const manifestPath = join(scratchPath(`nch4-store-${index}`), 'manifest.json');
      const result = await run(CLI, [
        '--successor', successor, '--predecessor', predecessor,
        '--lineage', 'lineage-alpha', '--declaration', declFile,
        '--sealed', '--sealed-manifest', manifestPath,
        '--t-seal', 'sealed before the successor existed; forward-only',
        '--json',
      ], { cwd: environment.cwd, env: { ...process.env, ...environment.env } });
      assert.equal(result.code, 0, `${environment.label}: ${result.stdout}${result.stderr}`);
      emitted.push(result.stdout);
    }
    assert.equal(new Set(emitted).size, 1,
      `every locale, timezone and working directory produced the same bytes: ${emitted.join(' | ')}`);
    assert.equal(emitted[0].trim(), inMemory[0], 'and the CLI agrees with the module');

    // No wall-clock field, by key name or by value shape, anywhere in the receipt.
    const receipt = JSON.parse(emitted[0]);
    for (const key of everyKey(receipt)) {
      assert.ok(!/(time|date|clock|stamp|epoch|created|expires|when|at$|_at)/i.test(key),
        `no wall-clock key: ${key}`);
    }
    for (const [path, leaf] of Object.entries(flatten(receipt))) {
      if (typeof leaf !== 'string') continue;
      assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(leaf), `no ISO timestamp at ${path}`);
    }
  });

// ---------------------------------------------------------------------------------------
// NC-H5 — silent staleness
// ---------------------------------------------------------------------------------------

test('NC-H5: a tree that moves produces a named refusal, never a quietly different receipt', async () => {
  // Freshness here is decided by digest resolution, not by a clock: a receipt is fresh exactly
  // while both named roots still reproduce their recorded digests. Two windows have to close.
  // (a) the tree moves DURING emission — the module re-measures after the sealed write and
  // refuses; (b) the tree moves after emission — a holder re-derives and refuses.
  const predecessor = tree({ 'a.txt': 'one\n' }, 'nch5-p');
  const successor = tree({ 'a.txt': 'ONE\n' }, 'nch5-s');
  const decl = declaration({ successorRoot: successor, predecessorRoot: predecessor });

  // (a) the successor moves while the sealed manifest is being written
  const movingSuccessor = memorySink({
    beforeReturn: () => writeFileSync(join(successor, 'a.txt'), 'MOVED-DURING-EMISSION\n'),
  });
  await assert.rejects(
    () => buildLineageReceipt(decl, movingSuccessor),
    (err) => err instanceof LineageReceiptError
      && err.code === 'LineageReplayDivergence'
      && err.side === 'successor'
      && /^[0-9a-f]{64}$/.test(err.expected)
      && /^[0-9a-f]{64}$/.test(err.observed)
      && err.expected !== err.observed,
    'the successor divergence is named, with both of its own single-revision digests',
  );

  // (b) a byte moves after emission, and the holder re-derives
  writeFileSync(join(successor, 'a.txt'), 'ONE\n');
  const sink = memorySink();
  const receipt = await buildLineageReceipt(decl, sink);
  assert.equal(verifyLineageReceipt(receipt, { successorRoot: successor }).fresh, true,
    'an unmoved tree verifies fresh');

  writeFileSync(join(successor, 'a.txt'), 'ONE-MOVED\n');
  assert.throws(
    () => verifyLineageReceipt(receipt, { successorRoot: successor }),
    (err) => err instanceof LineageReceiptError
      && err.code === 'LineageReplayDivergence'
      && err.expected === receipt.successor.digest
      && err.observed !== receipt.successor.digest,
    'a moved byte is a refusal naming the mismatched digest, not a quietly different receipt',
  );
  writeFileSync(join(successor, 'a.txt'), 'ONE\n');

  // (c) the PREDECESSOR moves during emission. Same refusal, but in sealed mode it carries the
  // side only: publishing the predecessor's digest beside a lineage id would publish the pairing,
  // and the pairing is itself a cross-revision quantity.
  const movingPredecessor = memorySink({
    beforeReturn: () => writeFileSync(join(predecessor, 'a.txt'), 'MOVED-DURING-EMISSION\n'),
  });
  await assert.rejects(
    () => buildLineageReceipt(decl, movingPredecessor),
    (err) => err instanceof LineageReceiptError
      && err.code === 'LineageReplayDivergence'
      && err.side === 'predecessor'
      && err.expected === undefined && err.observed === undefined,
    'a predecessor divergence refuses without publishing which predecessor it was',
  );
});

// ---------------------------------------------------------------------------------------
// NC-H6 — the vector crosses the seam into the caller
// ---------------------------------------------------------------------------------------

test('NC-H6: the sealed document never appears in the return value, at any depth', async () => {
  // Two channels, not one filtered channel. The property being asserted is structural: there is
  // no code path that returns the sealed document, so no filter has to be trusted. The fixture
  // is built with distinctive cardinalities (7 changed, 6 unchanged, 3 added, 2 removed) that
  // appear nowhere else in the receipt, so a leaked count cannot hide behind a coincidence.
  const predecessorFiles = {};
  const successorFiles = {};
  for (let i = 0; i < 7; i += 1) {            // changed
    predecessorFiles[`chg/${i}.txt`] = `old-${i}\n`;
    successorFiles[`chg/${i}.txt`] = `new-${i}\n`;
  }
  for (let i = 0; i < 6; i += 1) {            // unchanged
    predecessorFiles[`same/${i}.txt`] = `same-${i}\n`;
    successorFiles[`same/${i}.txt`] = `same-${i}\n`;
  }
  for (let i = 0; i < 3; i += 1) successorFiles[`add/${i}.txt`] = `added-${i}\n`;
  for (let i = 0; i < 2; i += 1) predecessorFiles[`gone/${i}.txt`] = `removed-${i}\n`;

  const predecessor = tree(predecessorFiles, 'nch6-p');
  const successor = tree(successorFiles, 'nch6-s');
  const sink = memorySink();
  const receipt = await buildLineageReceipt(
    declaration({ successorRoot: successor, predecessorRoot: predecessor }), sink,
  );

  assert.equal(sink.written.length, 1, 'the sink received the sealed document exactly once');
  const sealedJson = canonicalLineageJson(sink.written[0]);
  assert.equal(sink.written[0].cardinalities.changed, 7);
  assert.equal(sink.written[0].cardinalities.unchanged, 6);
  assert.equal(sink.written[0].cardinalities.added, 3);
  assert.equal(sink.written[0].cardinalities.removed, 2);

  const receiptJson = canonicalLineageJson(receipt);

  // No path from either root, in recipe spelling or native spelling.
  for (const root of [predecessor, successor]) {
    for (const row of inventoryRows(root)) {
      assert.ok(!receiptJson.includes(row.path), `no path in the receipt: ${row.path}`);
      assert.ok(!receiptJson.includes(row.sha256), `no per-file digest in the receipt: ${row.path}`);
      assert.ok(sealedJson.includes(row.path),
        `the sealed document really does carry the rows: ${row.path}`);
    }
  }
  assert.ok(!receiptJson.includes(predecessor.split(sep).join('/')), 'nor the predecessor root itself');

  // No cardinality, as a value at any depth. `renamed` is excluded: this recipe classifies by
  // path identity only, so it is always 0 and 0 is not distinctive.
  const leaves = Object.entries(flatten(receipt));
  for (const cardinality of [7, 6, 3, 2]) {
    const hit = leaves.find(([, leaf]) => leaf === cardinality);
    assert.equal(hit, undefined, `no cardinality ${cardinality} in the receipt (found at ${hit?.[0]})`);
  }

  // Exhaustive, including non-enumerables and the prototype chain.
  const seen = new Set();
  const walk = (value, path) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype,
      `${path} has an ordinary prototype`);
    assert.ok(Object.isFrozen(value), `${path} is frozen`);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      assert.equal(typeof key, 'string', `${path} carries no symbol-keyed field`);
      walk(value[key], `${path}.${String(key)}`);
    }
  };
  walk(receipt, 'receipt');
});

// ---------------------------------------------------------------------------------------
// NC-H7 — the exposure register loses its meaning
// ---------------------------------------------------------------------------------------

test('NC-H7: the exposure register is append-only, idempotent, and a list of names not of labels', () => {
  // Reading the register tells you WHO chose to look, never WHAT they saw. That is the whole
  // reason it can itself be open. A register that grew a cardinality column would stop being
  // open without anything else in the design changing.
  const release = { lineageId: 'lineage-alpha', readerRef: 'reviewer-1', releasedDigest: DIGEST_C };

  const once = appendExposureRelease([], release);
  assert.equal(once.length, 1);
  assert.deepEqual(sorted(Object.keys(once[0])), ['lineage_id', 'reader_ref', 'released_digest', 'schema']);
  assert.equal(once[0].schema, LINEAGE_EXPOSURE_REGISTER_SCHEMA);
  assert.equal(once[0].lineage_id, 'lineage-alpha');
  assert.equal(once[0].reader_ref, 'reviewer-1');
  assert.equal(once[0].released_digest, DIGEST_C);
  assert.ok(Object.isFrozen(once) && Object.isFrozen(once[0]));

  const twice = appendExposureRelease(once, { ...release });
  assert.deepEqual(twice, once, 'a second identical release is a no-op on the whole triple');

  const otherReader = appendExposureRelease(twice, { ...release, readerRef: 'reviewer-2' });
  assert.equal(otherReader.length, 2, 'a different reader is a new record');
  const otherDigest = appendExposureRelease(otherReader, { ...release, releasedDigest: DIGEST_A });
  assert.equal(otherDigest.length, 3, 'a different released digest is a new record');
  assert.deepEqual(otherDigest.slice(0, 2), otherReader, 'and the register never shrinks or reorders');

  // No rows and no cardinality can be smuggled in.
  for (const key of everyKey(otherDigest)) {
    assert.ok(!/(count|changed|unchanged|added|removed|renamed|rows|paths|bytes)/i.test(key),
      `the register carries no row or cardinality column: ${key}`);
  }
  assert.throws(
    () => appendExposureRelease([], { ...release, changedCount: 12 }),
    (err) => err instanceof LineageReceiptError && err.code === 'FieldSetViolation',
    'an extra column on a release is refused rather than carried',
  );
  assert.throws(
    () => appendExposureRelease([], { ...release, lineageId: '../elsewhere' }),
    (err) => err instanceof LineageReceiptError && err.code === 'IdentifierRefused',
    'a traversal-shaped lineage id is refused',
  );
});

// ---------------------------------------------------------------------------------------
// NC-H9 — sealed mode silently changes unsealed behaviour
// ---------------------------------------------------------------------------------------

test('NC-H9: unsealed mode reproduces today\'s information content, and refuses a sink rather than ignoring it',
  { timeout: 60_000 }, async () => {
    // The seam is opt-in per lineage. A lineage nobody sealed must behave exactly as it does
    // today — both revisions' own fixed points, openly — and a sink handed to unsealed mode is
    // a category error that has to be refused, never quietly dropped.
    const predecessor = tree({ 'a.txt': 'one\n', 'b.txt': 'two\n' }, 'nch9-p');
    const successor = tree({ 'a.txt': 'ONE\n', 'b.txt': 'two\n', 'c.txt': 'three\n' }, 'nch9-s');
    const decl = declaration({ sealed: false, successorRoot: successor, predecessorRoot: predecessor });

    const receipt = await buildLineageReceipt(decl, undefined);
    assert.deepEqual(sorted(Object.keys(receipt)), sorted(UNSEALED_RECEIPT_KEYS));
    assert.equal(receipt.sealed, false);
    assert.ok(!('sealed_manifest' in receipt), 'an unsealed lineage has no sealed manifest to point at');

    for (const [limb, root] of [['successor', successor], ['predecessor', predecessor]]) {
      const today = inventoryDigest(root);
      assert.deepEqual(receipt[limb], { bytes: today.bytes, count: today.count, digest: today.digest },
        `${limb} reproduces today's inventory-digest/1 triple exactly`);
      const cli = await run(INVENTORY_CLI, ['--root', root, '--json']);
      assert.equal(cli.code, 0, cli.stderr);
      const parsed = JSON.parse(cli.stdout);
      assert.equal(parsed.recipe, INVENTORY_RECIPE);
      assert.deepEqual(receipt[limb], { bytes: parsed.bytes, count: parsed.count, digest: parsed.digest },
        `${limb} agrees with today's shipped CLI, not merely with today's library`);
    }
    assert.equal(receipt.recipe, INVENTORY_RECIPE, 'and the recipe is unchanged');

    const sink = memorySink();
    await assert.rejects(
      () => buildLineageReceipt(decl, sink),
      (err) => err instanceof LineageReceiptError && err.code === 'SealedSinkForbidden',
      'a sink in unsealed mode is refused, not ignored',
    );
    assert.equal(sink.written.length, 0, 'and nothing was handed to it on the way to the refusal');

    await assert.rejects(
      () => buildLineageReceipt(declaration({ successorRoot: successor, predecessorRoot: predecessor }), undefined),
      (err) => err instanceof LineageReceiptError && err.code === 'SealedSinkRequired',
      'and sealed mode without a sink refuses rather than emitting a receipt with nowhere to put the rows',
    );
  });

// ---------------------------------------------------------------------------------------
// NC-H10 — refusals leak
// ---------------------------------------------------------------------------------------

test('NC-H10: every typed refusal is leak-free, with a sealed lineage loaded', async () => {
  // Error text is an open document too. A refusal that names the offending path publishes a
  // changed path just as effectively as a table would, and it does it on the one code path
  // nobody reads carefully.
  const predecessor = tree({ 'secret-predecessor-path.txt': 'p\n' }, 'nch10-p');
  const successor = tree({ 'secret-successor-path.txt': 's\n', 'sub/inner.txt': 'i\n' }, 'nch10-s');
  const decl = declaration({ successorRoot: successor, predecessorRoot: predecessor });

  const forbiddenText = [
    ...inventoryRows(predecessor).flatMap((r) => [r.path, r.sha256]),
    ...inventoryRows(successor).flatMap((r) => [r.path, r.sha256]),
    predecessor, successor, predecessor.split(sep).join('/'), successor.split(sep).join('/'),
    'SECRET-ADAPTER-DIAGNOSTIC',
  ];

  const capture = async (label, thunk) => {
    let error = null;
    try { await thunk(); } catch (err) { error = err; }
    assert.ok(error instanceof LineageReceiptError, `${label} refuses with the module's own typed error`);
    assert.equal(error.schema, LINEAGE_ERROR_SCHEMA);
    assert.equal(error.failClosed, true);
    assert.equal(error.authorityEffect, 'none');
    assert.ok(LINEAGE_REFUSALS.includes(error.code), `${label} uses a declared refusal code: ${error.code}`);

    const surface = [error.message, String(error), error.code,
      JSON.stringify(Object.fromEntries(Object.entries(error)))].join('\n');
    for (const secret of forbiddenText) {
      assert.ok(!surface.includes(secret), `${label} leaks "${secret}" in ${JSON.stringify(surface)}`);
    }
    for (const cardinality of ['1 changed', 'changed=', 'changed count']) {
      assert.ok(!surface.includes(cardinality), `${label} leaks a cardinality`);
    }
    return error.code;
  };

  const codes = [];
  codes.push(await capture('SealedSinkRequired', () => buildLineageReceipt(decl, undefined)));
  codes.push(await capture('SealedSinkForbidden',
    () => buildLineageReceipt(declaration({ sealed: false, successorRoot: successor, predecessorRoot: predecessor }), memorySink())));
  codes.push(await capture('SealedStoreContainment',
    () => assertSealedStoreContainment(join(successor, 'manifest.json'), [successor, predecessor])));
  codes.push(await capture('LineageReplayDivergence', () => buildLineageReceipt(decl, memorySink({
    beforeReturn: () => writeFileSync(join(successor, 'secret-successor-path.txt'), 'moved\n'),
  }))));
  writeFileSync(join(successor, 'secret-successor-path.txt'), 's\n');
  codes.push(await capture('RootUnreadable',
    () => buildLineageReceipt(declaration({ successorRoot: join(SCRATCH, 'no-such-tree'), predecessorRoot: predecessor }), memorySink())));
  codes.push(await capture('FieldSetViolation',
    () => buildLineageReceipt(Object.freeze({ ...decl, changedCount: 1 }), memorySink())));
  codes.push(await capture('IdentifierRefused',
    () => buildLineageReceipt(declaration({ lineageId: '../secret/lineage', successorRoot: successor, predecessorRoot: predecessor }), memorySink())));
  codes.push(await capture('ArtifactConflict — a sink reporting a digest that is not the document\'s',
    () => buildLineageReceipt(decl, memorySink({ digest: DIGEST_C }))));
  codes.push(await capture('ArtifactConflict — a sink that throws its own diagnostic',
    () => buildLineageReceipt(decl, memorySink({
      throws: new Error(`SECRET-ADAPTER-DIAGNOSTIC at ${join(successor, 'secret-successor-path.txt')}`),
    }))));

  // NonRegularEntry needs a fixture this host will actually build. A file or directory SYMLINK
  // needs elevation on Windows, so a directory JUNCTION is tried first; if neither can be made
  // the gate goes RED rather than green-without-exercising.
  const nonRegularRoot = tree({ 'real.txt': 'r\n', 'sub/inner.txt': 'i\n' }, 'nch10-nonregular');
  let made = null;
  const attempts = process.platform === 'win32'
    ? [['junction', join(nonRegularRoot, 'sub'), 'link'], ['file', join(nonRegularRoot, 'real.txt'), 'link']]
    : [['file', join(nonRegularRoot, 'real.txt'), 'link'], ['dir', join(nonRegularRoot, 'sub'), 'link']];
  for (const [kind, target, name] of attempts) {
    try { symlinkSync(target, join(nonRegularRoot, name), kind); made = kind; break; } catch { /* next */ }
  }
  assert.ok(made, 'this host must allow a non-regular entry so NonRegularEntry can be driven');
  codes.push(await capture('NonRegularEntry',
    () => buildLineageReceipt(declaration({ successorRoot: nonRegularRoot, predecessorRoot: predecessor }), memorySink())));

  assert.deepEqual(sorted(new Set(codes)), sorted(LINEAGE_REFUSALS),
    'every declared refusal variant was driven, and no undeclared one appeared');
});

// ---------------------------------------------------------------------------------------
// The containment guard generalisation in src/inventory.mjs
// ---------------------------------------------------------------------------------------

test('assertPathOutsideRoots generalises the guard while assertManifestOutsideRoot keeps its exact behaviour', () => {
  // The existing guard already refuses a manifest inside the tree it measures, on identity.
  // The lineage seam needs the same decision against a SET of roots — two measured trees plus
  // the declared open stores — so the guard is generalised and the old name kept as a caller.
  const one = tree({ 'a.txt': 'a\n' }, 'guard-one');
  const two = tree({ 'b.txt': 'b\n' }, 'guard-two');
  const outside = scratchPath('guard-outside');
  mkdirSync(outside, { recursive: true });

  assert.throws(() => assertPathOutsideRoots([one, two], join(one, 'm.txt')), InventoryError);
  assert.throws(() => assertPathOutsideRoots([one, two], join(two, 'deep', 'm.txt')), InventoryError);
  assert.doesNotThrow(() => assertPathOutsideRoots([one, two], join(outside, 'm.txt')));
  assert.doesNotThrow(() => assertPathOutsideRoots([], join(one, 'm.txt')),
    'an empty forbidden set forbids nothing, so callers need no special case');

  // Termination is structural: `dirname` reaches a fixed point for any string, so the walk
  // needs no depth bound in order to stop. The bound that remains is a runaway guard, and
  // exhausting it REFUSES. A bound that instead falls out of the loop and returns is a
  // security decision being made by a performance guard, and its answer is indistinguishable
  // from "outside every root".
  assert.ok(Number.isInteger(ANCESTOR_WALK_BOUND) && ANCESTOR_WALK_BOUND > 64,
    'the runaway guard sits far past any depth a real tree reaches, and past the old bound');
  const beyond = join(outside, ...Array.from({ length: ANCESTOR_WALK_BOUND + 8 }, () => 'a'), 'm.txt');
  assert.throws(() => assertPathOutsideRoots([one, two], beyond), InventoryError,
    'a chain longer than the runaway guard is REFUSED, never permitted: exhaustion fails '
    + 'closed, even though this particular target is genuinely outside both roots');
  assert.throws(() => assertManifestOutsideRoot(one, beyond), InventoryError,
    'and the one-root spelling fails closed identically');

  // The one-root spelling still behaves exactly as it did, including on an alias.
  assert.throws(() => assertManifestOutsideRoot(one, join(one, 'm.txt')), InventoryError);
  assert.throws(() => assertManifestOutsideRoot(one, join(one.toUpperCase(), 'm.txt')), InventoryError);
  assert.doesNotThrow(() => assertManifestOutsideRoot(one, join(outside, 'm.txt')));
  assert.doesNotThrow(() => assertManifestOutsideRoot(one, join(two, 'm.txt')),
    'and it still forbids only the root it was given');
});

// ---------------------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------------------

test('the CLI writes the sealed manifest through its sink, emits only the open receipt, and uses 0/2/3',
  { timeout: 120_000 }, async () => {
    const predecessor = tree({ 'a.txt': 'one\n', 'b.txt': 'two\n' }, 'cli-p');
    const successor = tree({ 'a.txt': 'ONE\n', 'b.txt': 'two\n', 'c.txt': 'three\n' }, 'cli-s');
    const declFile = scratchPath('cli-decl.json');
    writeFileSync(declFile, JSON.stringify({
      cleanliness: LIMBS.cleanliness,
      tests: LIMBS.tests,
      evidence: LIMBS.evidence,
      verdict: LIMBS.verdict,
      notesDigest: LIMBS.notesDigest,
    }), 'utf8');

    const store = scratchPath('cli-store');
    const manifestPath = join(store, 'manifest.json');
    const receiptPath = join(scratchPath('cli-open'), 'receipt.json');

    const ok = await run(CLI, [
      '--successor', successor, '--predecessor', predecessor, '--lineage', 'lineage-alpha',
      '--declaration', declFile, '--sealed', '--sealed-manifest', manifestPath,
      '--t-seal', 'sealed before the successor existed', '--receipt', receiptPath, '--json',
    ]);
    assert.equal(ok.code, 0, `${ok.stdout}${ok.stderr}`);

    const receipt = JSON.parse(ok.stdout);
    assert.deepEqual(sorted(Object.keys(receipt)), sorted(SEALED_RECEIPT_KEYS));
    assert.equal(readFileSync(receiptPath, 'utf8'), canonicalLineageJson(receipt) + '\n',
      'the written receipt is the canonical bytes the digest would be taken over');

    const sealed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(sealed.schema, LINEAGE_SEALED_MANIFEST_SCHEMA);
    assert.equal(lineageDocumentDigest(sealed), receipt.sealed_manifest.digest,
      'the receipt points at the bytes the sink actually wrote');
    assert.ok(Array.isArray(sealed.changes) && sealed.changes.length > 0, 'the rows live in the sealed document');

    // Nothing about the sealed side reached stdout or stderr.
    for (const row of [...inventoryRows(predecessor), ...inventoryRows(successor)]) {
      assert.ok(!ok.stdout.includes(row.path) && !ok.stderr.includes(row.path),
        `the CLI printed no path: ${row.path}`);
    }

    // Re-running is a byte-identical no-op: both documents are content-addressed.
    const again = await run(CLI, [
      '--successor', successor, '--predecessor', predecessor, '--lineage', 'lineage-alpha',
      '--declaration', declFile, '--sealed', '--sealed-manifest', manifestPath,
      '--t-seal', 'sealed before the successor existed', '--json',
    ]);
    assert.equal(again.code, 0, `${again.stdout}${again.stderr}`);
    assert.equal(again.stdout, ok.stdout, 'replay reproduces the receipt byte-for-byte');
    assert.equal(lineageDocumentDigest(JSON.parse(readFileSync(manifestPath, 'utf8'))),
      receipt.sealed_manifest.digest, 'and rewrites the sealed manifest identically');

    // Usage errors are 2.
    for (const [label, args] of [
      ['an unknown flag', ['--successor', successor, '--nope']],
      ['a missing successor', ['--predecessor', predecessor, '--lineage', 'l', '--declaration', declFile]],
      ['a sink with no --sealed', ['--successor', successor, '--predecessor', predecessor, '--lineage', 'l',
        '--declaration', declFile, '--sealed-manifest', join(store, 'x.json')]],
      ['--sealed with no manifest path', ['--successor', successor, '--predecessor', predecessor,
        '--lineage', 'l', '--declaration', declFile, '--sealed', '--t-seal', 'x']],
      ['--sealed with no --t-seal', ['--successor', successor, '--predecessor', predecessor,
        '--lineage', 'l', '--declaration', declFile, '--sealed', '--sealed-manifest', join(store, 'y.json')]],
    ]) {
      const bad = await run(CLI, args);
      assert.equal(bad.code, 2, `${label} is a usage error: ${bad.stdout}${bad.stderr}`);
    }

    // Fail-closed refusals are 3, and nothing is written.
    const before = everyFile(successor).concat(everyFile(predecessor));
    const refused = await run(CLI, [
      '--successor', successor, '--predecessor', predecessor, '--lineage', '../escape',
      '--declaration', declFile, '--sealed', '--sealed-manifest', join(store, 'refused.json'),
      '--t-seal', 'x',
    ]);
    assert.equal(refused.code, 3, `a refused identifier is fail-closed: ${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /REFUSED: IdentifierRefused/);
    assert.ok(!existsSync(join(store, 'refused.json')), 'and no sealed manifest was written');
    assert.deepEqual(everyFile(successor).concat(everyFile(predecessor)), before,
      'and nothing was written inside either measured root');
  });

test('the CLI refuses a sealed manifest sited inside a measured root or a declared open store at any depth, naming containment and writing nothing',
  { timeout: 180_000 }, async () => {
    const predecessor = tree({ 'a.txt': 'one\n' }, 'cli-c-p');
    const successor = tree({ 'a.txt': 'ONE\n' }, 'cli-c-s');
    const openStore = tree({ 'reviews/r.md': '# r\n' }, 'cli-c-open');
    const declFile = scratchPath('cli-c-decl.json');
    writeFileSync(declFile, JSON.stringify({
      cleanliness: LIMBS.cleanliness, tests: LIMBS.tests, evidence: LIMBS.evidence,
      verdict: LIMBS.verdict, notesDigest: LIMBS.notesDigest,
    }), 'utf8');

    const before = [successor, predecessor, openStore].flatMap((r) => everyFile(r));
    for (const [label, destination] of [
      ['inside the successor root', join(successor, 'manifest.json')],
      ['inside the predecessor root', join(predecessor, 'deep', 'manifest.json')],
      ['inside a declared open store', join(openStore, 'reviews', 'manifest.json')],
      ['inside the successor root, spelled in upper case', join(successor.toUpperCase(), 'manifest.json')],
    ]) {
      const result = await run(CLI, [
        '--successor', successor, '--predecessor', predecessor, '--lineage', 'lineage-alpha',
        '--declaration', declFile, '--sealed', '--sealed-manifest', destination,
        '--open-store', openStore, '--t-seal', 'x', '--json',
      ]);
      assert.equal(result.code, 3, `${label} is fail-closed: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /REFUSED: SealedStoreContainment/);
      assert.equal(result.stdout, '', 'and no receipt is emitted on the refusing path');
    }
    assert.deepEqual([successor, predecessor, openStore].flatMap((r) => everyFile(r)), before,
      'no refusal wrote anything anywhere');

    // The receipt itself may not land inside a measured root either: a tool that writes into a
    // tree it measures reports a digest that is not that tree's digest.
    const result = await run(CLI, [
      '--successor', successor, '--predecessor', predecessor, '--lineage', 'lineage-alpha',
      '--declaration', declFile, '--receipt', join(successor, 'receipt.json'),
    ]);
    assert.equal(result.code, 3, `${result.stdout}${result.stderr}`);
    assert.deepEqual([successor, predecessor, openStore].flatMap((r) => everyFile(r)), before);

    // ------------------------------------------------------------------------------------
    // The target-IS-the-root axis. Every case above names a destination strictly INSIDE a
    // root, so a guard that begins its ancestor walk at the target's PARENT decides all of
    // them correctly and the one axis that distinguishes the two starting points is never
    // driven. When the walk started at `dirname(target)`, the target itself was compared
    // against no root at all: naming a not-yet-existing path as BOTH `--sealed-manifest X`
    // and `--open-store X` was permitted, and the whole cross-revision label vector —
    // predecessor rows, per-file digests, cardinalities and the change list — was written in
    // the clear at X, the very path declared to be an open document store. Containment is a
    // property of the chain from the target INCLUSIVE, not from its parent.
    // ------------------------------------------------------------------------------------
    const ghostStore = scratchPath('cli-c-ghost-store');
    assert.ok(!existsSync(ghostStore),
      'the declared open store must not exist yet, or this is the ordinary inside-a-root case '
      + 'and the target-is-the-root axis is not being driven');

    for (const [label, destination, declaredStore] of [
      ['a declared open store that does not exist yet', ghostStore, ghostStore],
      ['a declared open store that does exist', openStore, openStore],
      ['the successor root itself', successor, openStore],
      ['the predecessor root itself', predecessor, openStore],
    ]) {
      const atRoot = await run(CLI, [
        '--successor', successor, '--predecessor', predecessor, '--lineage', 'lineage-alpha',
        '--declaration', declFile, '--sealed', '--sealed-manifest', destination,
        '--open-store', declaredStore, '--t-seal', 'x', '--json',
      ]);
      assert.equal(atRoot.code, 3,
        `naming ${label} as the sealed store is fail-closed: ${atRoot.stdout}${atRoot.stderr}`);
      assert.match(atRoot.stderr, /REFUSED: SealedStoreContainment/,
        `naming ${label} is reported as the containment fault it is, not as a downstream `
        + 'write error that an operator would retry rather than investigate');
      assert.equal(atRoot.stdout, '', 'and no receipt is emitted on that refusing path');
    }

    assert.ok(!existsSync(ghostStore),
      'and nothing exists at the declared open store: not the sealed vector, and not a '
      + 'directory created on the way to it. Containment is decided before any parent is made.');
    assert.deepEqual([successor, predecessor, openStore].flatMap((r) => everyFile(r)), before,
      'and naming a root itself wrote nothing inside any measured root or declared open store');

    // The neighbouring positive control. A sibling whose spelling has the ghost store's whole
    // path as a string prefix is NOT inside it, and must still emit — so the repair is a
    // containment guard and not a prefix-of-a-forbidden-path refusal wearing containment's
    // name, which would refuse this permitted destination too.
    const sidecar = join(`${ghostStore}-sidecar`, 'manifest.json');
    const beside = await run(CLI, [
      '--successor', successor, '--predecessor', predecessor, '--lineage', 'lineage-alpha',
      '--declaration', declFile, '--sealed', '--sealed-manifest', sidecar,
      '--open-store', ghostStore, '--t-seal', 'x', '--json',
    ]);
    assert.equal(beside.code, 0,
      `a target beside the declared open store is still permitted: ${beside.stdout}${beside.stderr}`);
    assert.ok(existsSync(sidecar), 'and its sealed manifest is written where it was asked for');
    assert.ok(!existsSync(ghostStore),
      'while the declared open store itself is still never touched');
    assert.deepEqual([successor, predecessor, openStore].flatMap((r) => everyFile(r)), before,
      'and that permitted run still wrote nothing inside any protected root');

    // ------------------------------------------------------------------------------------
    // The depth axis, end to end, and the case that shows why it matters. When the guard
    // walked a fixed number of ancestors and then fell out of its loop, a destination nested
    // past that number read as "outside every root": the sealed manifest — the whole
    // cross-revision label vector, in the clear — was written INSIDE the tree being measured,
    // and the run then failed on the perturbation it had itself caused, reporting
    // `LineageReplayDivergence`. That is a downstream symptom of a containment fault, and an
    // operator reading it retries rather than investigating a leak. Both halves are asserted:
    // the code that is reported, and the absence of any artifact at the requested path.
    // ------------------------------------------------------------------------------------
    const DEEP = 70;
    const deepTail = Array.from({ length: DEEP }, () => 'a');

    for (const [label, root] of [
      ['the successor root', successor],
      ['the predecessor root', predecessor],
      ['a declared open store', openStore],
    ]) {
      // Materialised, so containment is decided on filesystem identity at depth as well.
      // Directories hold no files, so the roots' measured contents are untouched by the
      // fixture itself and `before` stays the honest baseline.
      const parent = join(root, ...deepTail);
      mkdirSync(parent, { recursive: true });
      const destination = join(parent, 'manifest.json');

      const deep = await run(CLI, [
        '--successor', successor, '--predecessor', predecessor, '--lineage', 'lineage-alpha',
        '--declaration', declFile, '--sealed', '--sealed-manifest', destination,
        '--open-store', openStore, '--t-seal', 'x', '--json',
      ]);

      assert.equal(deep.code, 3,
        `${DEEP} levels inside ${label} is fail-closed: ${deep.stdout}${deep.stderr}`);
      assert.match(deep.stderr, /REFUSED: SealedStoreContainment/,
        `${DEEP} levels inside ${label} is reported as the containment fault it is`);
      assert.doesNotMatch(deep.stderr, /LineageReplayDivergence/,
        'and never as a replay divergence, which is what a containment failure looks like only '
        + 'after the write has already perturbed the tree it was measuring');
      assert.equal(deep.stdout, '', 'no receipt is emitted on the deep refusing path');
      assert.ok(!existsSync(destination),
        'and no artifact exists at the requested path: containment is decided before the sink '
        + 'is built, so the refusing path never had a file to leave behind');
    }

    assert.deepEqual([successor, predecessor, openStore].flatMap((r) => everyFile(r)), before,
      'no deep refusal wrote a file anywhere under any measured root or declared open store');

    // Depth is not itself a refusal reason: the same nesting outside every root still emits,
    // so the repair is a guard and not a blanket deep-path refusal wearing a containment name.
    const permitted = join(scratchPath('cli-deep-store'), ...deepTail, 'manifest.json');
    const emitted = await run(CLI, [
      '--successor', successor, '--predecessor', predecessor, '--lineage', 'lineage-alpha',
      '--declaration', declFile, '--sealed', '--sealed-manifest', permitted,
      '--open-store', openStore, '--t-seal', 'x', '--json',
    ]);
    assert.equal(emitted.code, 0,
      `a deep destination outside every root still emits: ${emitted.stdout}${emitted.stderr}`);
    assert.ok(existsSync(permitted), 'and the sealed manifest is written where it was asked for');
    assert.deepEqual([successor, predecessor, openStore].flatMap((r) => everyFile(r)), before,
      'and that permitted run still wrote nothing inside any protected root');
  });

test('the CLI registers an exposure append-only and verifies a receipt against the tree a reviewer holds',
  { timeout: 60_000 }, async () => {
    const predecessor = tree({ 'a.txt': 'one\n' }, 'cli-x-p');
    const successor = tree({ 'a.txt': 'ONE\n' }, 'cli-x-s');
    const declFile = scratchPath('cli-x-decl.json');
    writeFileSync(declFile, JSON.stringify({
      cleanliness: LIMBS.cleanliness, tests: LIMBS.tests, evidence: LIMBS.evidence,
      verdict: LIMBS.verdict, notesDigest: LIMBS.notesDigest,
    }), 'utf8');
    const receiptPath = join(scratchPath('cli-x-open'), 'receipt.json');
    const manifestPath = join(scratchPath('cli-x-store'), 'manifest.json');

    const emitted = await run(CLI, [
      '--successor', successor, '--predecessor', predecessor, '--lineage', 'lineage-alpha',
      '--declaration', declFile, '--sealed', '--sealed-manifest', manifestPath,
      '--t-seal', 'x', '--receipt', receiptPath,
    ]);
    assert.equal(emitted.code, 0, `${emitted.stdout}${emitted.stderr}`);
    assert.match(emitted.stdout, new RegExp(`successor=${LINEAGE_TREE_RECIPE} [0-9a-f]{64}`),
      'the plain output never prints a digest without its recipe');

    // A reviewer holding only S checks freshness.
    const fresh = await run(CLI, ['--verify', receiptPath, '--successor', successor]);
    assert.equal(fresh.code, 0, `${fresh.stdout}${fresh.stderr}`);

    writeFileSync(join(successor, 'a.txt'), 'MOVED\n');
    const stale = await run(CLI, ['--verify', receiptPath, '--successor', successor]);
    assert.equal(stale.code, 3, 'a stale receipt refuses; stale means re-derive, never use anyway');
    assert.match(stale.stderr, /REFUSED: LineageReplayDivergence/);

    // The exposure register.
    const registerPath = join(scratchPath('cli-x-register'), 'register.jsonl');
    const args = ['--register-exposure', '--lineage', 'lineage-alpha', '--reader', 'reviewer-1',
      '--released', DIGEST_C, '--register', registerPath];
    assert.equal((await run(CLI, args)).code, 0);
    const afterOne = readFileSync(registerPath, 'utf8');
    assert.equal((await run(CLI, args)).code, 0, 'a repeated identical release is accepted');
    assert.equal(readFileSync(registerPath, 'utf8'), afterOne, 'and is a byte-identical no-op');

    assert.equal((await run(CLI, [...args.slice(0, 4), 'reviewer-2', ...args.slice(5)])).code, 0);
    const lines = readFileSync(registerPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'a different reader appends; the register never shrinks');
    for (const line of lines) {
      assert.deepEqual(sorted(Object.keys(JSON.parse(line))),
        ['lineage_id', 'reader_ref', 'released_digest', 'schema']);
    }
  });

// ---------------------------------------------------------------------------------------
// The module's declared surface, and the documents that have to stay truthful
// ---------------------------------------------------------------------------------------

test('the module declares exactly four schemas, reuses the existing recipe, and introduces no new one', () => {
  assert.equal(LINEAGE_RECEIPT_SCHEMA, 'gaia-lineage-receipt/1');
  assert.equal(LINEAGE_SEALED_MANIFEST_SCHEMA, 'gaia-lineage-sealed-manifest/1');
  assert.equal(LINEAGE_EXPOSURE_REGISTER_SCHEMA, 'gaia-lineage-exposure-register/1');
  assert.equal(LINEAGE_ERROR_SCHEMA, 'gaia-lineage-error/1');

  assert.equal(LINEAGE_TREE_RECIPE, INVENTORY_RECIPE,
    'the tree recipe is the one already shipped and already independently reimplemented');

  const source = readFileSync(join(ROOT, 'src', 'lineage-receipt.mjs'), 'utf8');
  const recipeLiterals = source.match(/'[a-z0-9-]+\/[0-9]+'/g) ?? [];
  for (const literal of recipeLiterals) {
    assert.ok(['\'gaia-lineage-receipt/1\'', '\'gaia-lineage-sealed-manifest/1\'',
      '\'gaia-lineage-exposure-register/1\'', '\'gaia-lineage-error/1\'',
      '\'ordinal-path-bytes-sha256/1\'', '\'inventory-digest/1\''].includes(literal),
    `no undeclared recipe or schema literal: ${literal}`);
  }
  assert.equal(source.includes('Date.now'), false, 'the module reads no clock');
  assert.equal(/new Date\b/.test(source), false, 'and constructs none');

  assert.deepEqual(sorted(LINEAGE_REFUSALS), sorted([
    'ArtifactConflict', 'FieldSetViolation', 'IdentifierRefused', 'LineageReplayDivergence',
    'NonRegularEntry', 'RootUnreadable', 'SealedSinkForbidden', 'SealedSinkRequired',
    'SealedStoreContainment',
  ]), 'the refusal set is exactly the one the contract declares');

  // A document digest is a plain lowercase sha256 over the canonical UTF-8 JSON, and nothing else.
  const value = { b: 1, a: [3, { d: 4, c: 5 }] };
  assert.equal(canonicalLineageJson(value), '{"a":[3,{"c":5,"d":4}],"b":1}');
  assert.equal(lineageDocumentDigest(value),
    createHash('sha256').update(canonicalLineageJson(value), 'utf8').digest('hex'));
});

test('the README and the Decision Receipt state the lineage seam truthfully', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  for (const claim of ['src/lineage-receipt.mjs', 'scripts/lineage-receipt.mjs',
    'gaia-lineage-receipt/1', 'docs/holdout-safe-reporting-design.md']) {
    assert.ok(readme.includes(claim), `the README names ${claim}`);
  }
  // Matched against whitespace-normalised prose: the claim is what the README says, not where
  // its lines happen to wrap.
  const prose = readme.replace(/\s+/g, ' ');
  assert.match(prose, /sealed manifest[^.]{0,400}never returned/i,
    'and states the two-channel property rather than implying one filtered channel');
  assert.match(prose, /no wall clock|no wall-clock/i, 'and that there is no clock in the receipt');
  assert.match(prose, /forward-only/i, 'and that sealing is forward-only');

  const receiptDoc = readFileSync(join(ROOT, 'docs', 'holdout-safe-reporting-design.md'), 'utf8');
  for (const claim of ['gaia-lineage-receipt/1', 'gaia-lineage-sealed-manifest/1',
    'gaia-lineage-exposure-register/1', 'gaia-lineage-error/1',
    'ordinal-path-bytes-sha256/1', 'docs/holdout-safe-reporting.md']) {
    assert.ok(receiptDoc.includes(claim), `the Decision Receipt binds ${claim}`);
  }
  assert.match(receiptDoc, /0cc24d45e08f5e1aac3b824a819e778ebde3169b3871e3c88b2a4e46c3d3fe37/,
    'the Decision Receipt is digest-bound to the design report it implements');
  assert.match(receiptDoc, /freely reversible/i, 'it records the reversibility class');
  assert.match(receiptDoc, /first seal/i, 'and the trigger that qualifies it');
  for (const design of ['Design 1', 'Design 2', 'Design 3']) {
    assert.ok(receiptDoc.includes(design), `it records the alternative considered: ${design}`);
  }
});
