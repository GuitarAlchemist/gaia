/**
 * lineage-receipt.mjs — one open receipt and one sealed manifest, on two separate channels.
 *
 * WHAT THIS IS FOR
 * ----------------
 * For a lineage declared **sealed**, a quantity leaks if it is a function of BOTH revisions.
 * The changed/unchanged split of a revision pair is the label vector of a per-file holdout
 * population, and once it is published no procedure recovers that population's unseen status.
 * Under ordinary review practice the procedure that ENTITLES a population to be evaluated —
 * an independent Standards review and an independent Spec review, each showing it measured
 * something — is the same procedure that PUBLISHES the split. This module exists to separate
 * those two, so a review can show its work without spending the population.
 *
 * `docs/holdout-safe-reporting.md` states the doctrine and is explicit that it is doctrine:
 * a human writing a sentence has no machine-checkable observable. This module is the part
 * that *is* checkable. It does not close the freehand-prose channel and must not be read as
 * closing it.
 *
 * THE SEAM
 * --------
 *   buildLineageReceipt(declaration, sealedSink) -> the open receipt, and nothing else
 *
 * Two arguments, one return value. Behind them sit two tree walks, ordinal sorting, canonical
 * JSON, cross-revision derivation, field-set closure, digest computation and typed refusal.
 * `sealedSink` is the same shape as `openContextCapsule`'s revision adapter: the trusted
 * composition root supplies the privileged capability — the ability to write outside every
 * open store — and this module holds none itself. It cannot write anywhere.
 *
 * TWO CHANNELS, NOT ONE FILTERED CHANNEL
 * --------------------------------------
 * The sealed manifest is handed to `sealedSink.writeSealed(document)` and there is no code
 * path that returns it, prints it, logs it, or interpolates any part of it into an error.
 * That is a structural property a test can assert, rather than a filter a test must trust.
 * The open receipt carries the manifest's digest and nothing else about it — in particular
 * **not its byte length**, which is close to linear in the number of changed rows and would
 * therefore publish the cardinality while naming no path.
 *
 * WHAT IS OPEN, AND WHY EACH FIELD IS SAFE
 * ----------------------------------------
 * The open field set is CLOSED and exhaustive: a field that is not on the list is a schema
 * violation, not an extension. Every open field is a function of the successor alone, of
 * neither revision, or is a digest whose preimage lives in the sealed store. In sealed mode
 * the receipt does not name the predecessor at all — not its digest, not its path, not its
 * count — because the pairing is itself a cross-revision quantity.
 *
 * NO CLOCK
 * --------
 * There is no wall-clock field anywhere, and this module reads no clock. Freshness is decided
 * by digest resolution: a receipt is fresh exactly while the roots it names still reproduce
 * their recorded digests. When they do not, the receipt is stale, and stale means *refuse and
 * re-derive*, never *use anyway*. The `t_seal` statement is prose, and it lives in the sealed
 * document, which has its own digest — never as a receipt field.
 *
 * WHAT IT REFUSES, AND WHAT A REFUSAL MAY SAY
 * -------------------------------------------
 * Refusals are typed, named, and fail closed: no artifact on any path, no partial output, no
 * silent degradation. A refusal message is exactly its code. Error text is an open document
 * too, so no refusal carries a path from either root, a row, a cardinality, or a diagnostic
 * from the sink — a sink's own exception is caught and replaced, never re-thrown.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It adds no bus verb and widens none; the surface stays exactly `register`, `send`, `inbox`,
 * `ack`, `heartbeat`, `handoff`. It introduces no digest recipe: trees use the shipped
 * `ordinal-path-bytes-sha256/1`, documents use plain lowercase SHA-256 over canonical UTF-8
 * JSON. It grants no authority — a `verdict` records a decision someone made under their own
 * authority and confers nothing. It offers no retrospective sealing: sealing is forward-only,
 * burned lineages stay burned, and nothing here restores one.
 *
 * This module reads trees and computes. It creates nothing, writes nothing, and locks nothing.
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

import {
  inventoryRows, manifestDocument, INVENTORY_RECIPE, InventoryError, assertPathOutsideRoots,
} from './inventory.mjs';
import { canonicalJson } from './epistemic-research.mjs';

/** The open receipt: returned to the caller, safe to publish. */
export const LINEAGE_RECEIPT_SCHEMA = 'gaia-lineage-receipt/1';

/** The cross-revision document: handed to the sink, never returned. */
export const LINEAGE_SEALED_MANIFEST_SCHEMA = 'gaia-lineage-sealed-manifest/1';

/** One append-only release record: a list of names, never a list of labels. */
export const LINEAGE_EXPOSURE_REGISTER_SCHEMA = 'gaia-lineage-exposure-register/1';

/** The typed refusal: no path, no row, no cardinality, no adapter diagnostic. */
export const LINEAGE_ERROR_SCHEMA = 'gaia-lineage-error/1';

/**
 * The tree recipe, re-exported rather than restated.
 *
 * It is the one `src/inventory.mjs` already ships and an independent review already
 * reimplemented. A seam that invented its own recipe would produce digests nobody else could
 * reproduce, which is the failure this repository's fixed point exists to end.
 */
export const LINEAGE_TREE_RECIPE = INVENTORY_RECIPE;

/** The closed open-receipt field set for a sealed lineage. Nothing may be added to it. */
export const SEALED_RECEIPT_KEYS = Object.freeze([
  'cleanliness', 'evidence', 'lineage_id', 'notes_digest', 'recipe', 'schema', 'sealed',
  'sealed_manifest', 'successor', 'tests', 'verdict',
]);

/**
 * The closed field set for an unsealed lineage.
 *
 * An unsealed lineage behaves exactly as this product behaves today: both revisions' own
 * fixed points are open, because nobody declared a holdout over the pair. The seam is opt-in
 * per lineage and imposes no cost on ordinary review work.
 */
export const UNSEALED_RECEIPT_KEYS = Object.freeze([
  'cleanliness', 'evidence', 'lineage_id', 'notes_digest', 'predecessor', 'recipe', 'schema',
  'sealed', 'successor', 'tests', 'verdict',
]);

/** Every refusal this module can raise. The set is closed; nothing else escapes. */
export const LINEAGE_REFUSALS = Object.freeze([
  'ArtifactConflict', 'FieldSetViolation', 'IdentifierRefused', 'LineageReplayDivergence',
  'NonRegularEntry', 'RootUnreadable', 'SealedSinkForbidden', 'SealedSinkRequired',
  'SealedStoreContainment',
]);

const SEALED_DECLARATION_KEYS = Object.freeze([
  'cleanliness', 'evidence', 'lineageId', 'notesDigest', 'predecessorRoot', 'sealed',
  'successorRoot', 'tSeal', 'tests', 'verdict',
]);

const UNSEALED_DECLARATION_KEYS = Object.freeze([
  'cleanliness', 'evidence', 'lineageId', 'notesDigest', 'predecessorRoot', 'sealed',
  'successorRoot', 'tests', 'verdict',
]);

const CLEANLINESS_KEYS = Object.freeze(['alternateStreams', 'porcelainLines', 'readOnlyAll', 'reparsePoints']);
const TESTS_KEYS = Object.freeze(['deterministicRepeats', 'failed', 'mutationsDiscriminating', 'mutationsTotal', 'passed']);
const REGISTER_RECORD_KEYS = Object.freeze(['lineage_id', 'reader_ref', 'released_digest', 'schema']);
const RELEASE_KEYS = Object.freeze(['lineageId', 'readerRef', 'releasedDigest']);
const VERDICTS = Object.freeze(['APPROVE', 'REQUEST_CHANGES']);

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * A bounded identifier: not a path, not a URI, not a query, not a glob.
 *
 * No separator, no colon (so no drive letter and no URI scheme), no wildcard and no percent.
 * A value containing `..` is refused outright rather than normalised, because normalising a
 * traversal-shaped identifier is how a traversal-shaped identifier gets accepted.
 */
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The longest `t_seal` prose this module will carry into the sealed document. */
export const MAX_T_SEAL_BYTES = 4096;

/**
 * A typed, fail-closed refusal.
 *
 * `message` is exactly the code. Nothing is interpolated into it, ever: a refusal that names
 * the offending path publishes a changed path just as effectively as a table would, and it
 * does it on the one code path nobody reads carefully.
 */
export class LineageReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LineageReceiptError';
    this.code = code;
    this.schema = LINEAGE_ERROR_SCHEMA;
    this.failClosed = true;
    this.authorityEffect = 'none';
  }
}

const refuse = (code) => new LineageReceiptError(code);

/** Ordinal comparison, matching the tree recipe. Never `localeCompare`, never case-folded. */
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The canonical JSON a lineage document's digest is taken over.
 *
 * The same `canonicalJson` the epistemic proposal builder already uses: object names sorted
 * recursively, array order preserved. Two hosts that agree on the value agree on the bytes.
 */
export function canonicalLineageJson(value) {
  return canonicalJson(value);
}

/** A document digest: plain lowercase SHA-256 over the canonical UTF-8 JSON. No new recipe. */
export function lineageDocumentDigest(value) {
  return createHash('sha256').update(canonicalLineageJson(value), 'utf8').digest('hex');
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertExactKeys(value, expected, code) {
  if (!isPlainObject(value)) throw refuse(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw refuse(code);
  }
}

const isCount = (value) => Number.isInteger(value) && value >= 0;

function boundedIdentifier(value) {
  if (typeof value !== 'string' || !BOUNDED_ID.test(value) || value.includes('..')) {
    throw refuse('IdentifierRefused');
  }
  return value;
}

function documentDigestField(value) {
  if (typeof value !== 'string' || !HEX_64.test(value)) throw refuse('IdentifierRefused');
  return value;
}

/**
 * Validate a declaration before any tree is read.
 *
 * Order matters and is deliberate: the field set first, then the identifiers, then everything
 * that costs I/O. A traversal-shaped lineage id is refused before a single file is opened.
 */
function validateDeclaration(declaration) {
  if (!isPlainObject(declaration)) throw refuse('FieldSetViolation');
  if (typeof declaration.sealed !== 'boolean') throw refuse('FieldSetViolation');
  const sealed = declaration.sealed;
  assertExactKeys(declaration, sealed ? SEALED_DECLARATION_KEYS : UNSEALED_DECLARATION_KEYS, 'FieldSetViolation');

  const lineageId = boundedIdentifier(declaration.lineageId);

  for (const root of [declaration.successorRoot, declaration.predecessorRoot]) {
    if (typeof root !== 'string' || root.length === 0) throw refuse('FieldSetViolation');
  }

  assertExactKeys(declaration.cleanliness, CLEANLINESS_KEYS, 'FieldSetViolation');
  if (typeof declaration.cleanliness.readOnlyAll !== 'boolean') throw refuse('FieldSetViolation');
  for (const key of ['alternateStreams', 'porcelainLines', 'reparsePoints']) {
    if (!isCount(declaration.cleanliness[key])) throw refuse('FieldSetViolation');
  }

  assertExactKeys(declaration.tests, TESTS_KEYS, 'FieldSetViolation');
  for (const key of TESTS_KEYS) if (!isCount(declaration.tests[key])) throw refuse('FieldSetViolation');

  if (!Array.isArray(declaration.evidence)) throw refuse('FieldSetViolation');
  const labels = new Set();
  const evidence = declaration.evidence.map((item) => {
    assertExactKeys(item, ['digest', 'label'], 'FieldSetViolation');
    const label = boundedIdentifier(item.label);
    if (labels.has(label)) throw refuse('FieldSetViolation');
    labels.add(label);
    return { digest: documentDigestField(item.digest), label };
  });

  if (declaration.verdict !== null && !VERDICTS.includes(declaration.verdict)) {
    throw refuse('FieldSetViolation');
  }
  const notesDigest = documentDigestField(declaration.notesDigest);

  let tSeal = null;
  if (sealed) {
    tSeal = declaration.tSeal;
    if (typeof tSeal !== 'string' || tSeal.length === 0
        || Buffer.byteLength(tSeal, 'utf8') > MAX_T_SEAL_BYTES) {
      throw refuse('FieldSetViolation');
    }
  }

  return {
    lineageId,
    sealed,
    successorRoot: declaration.successorRoot,
    predecessorRoot: declaration.predecessorRoot,
    cleanliness: {
      alternate_streams: declaration.cleanliness.alternateStreams,
      porcelain_lines: declaration.cleanliness.porcelainLines,
      read_only_all: declaration.cleanliness.readOnlyAll,
      reparse_points: declaration.cleanliness.reparsePoints,
    },
    tests: {
      deterministic_repeats: declaration.tests.deterministicRepeats,
      failed: declaration.tests.failed,
      mutations_discriminating: declaration.tests.mutationsDiscriminating,
      mutations_total: declaration.tests.mutationsTotal,
      passed: declaration.tests.passed,
    },
    evidence,
    verdict: declaration.verdict,
    notesDigest,
    tSeal,
  };
}

/**
 * One revision's rows and its `inventory-digest/1` triple.
 *
 * `InventoryError` from the walk is replaced, never re-thrown: its message names the offending
 * entry, which is exactly the kind of sentence this seam exists to keep out of open documents.
 */
function measure(root) {
  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw refuse('RootUnreadable');
  }
  if (!stat.isDirectory()) throw refuse('RootUnreadable');

  let rows;
  try {
    rows = inventoryRows(root);
  } catch (error) {
    throw refuse(error instanceof InventoryError ? 'NonRegularEntry' : 'RootUnreadable');
  }
  return {
    rows,
    count: rows.length,
    bytes: rows.reduce((total, row) => total + row.bytes, 0),
    digest: createHash('sha256').update(manifestDocument(rows), 'utf8').digest('hex'),
  };
}

const triple = (measurement) => ({
  bytes: measurement.bytes, count: measurement.count, digest: measurement.digest,
});

/**
 * A replay divergence.
 *
 * The successor's own digest is a single-revision quantity and travels with the refusal, so a
 * holder can see exactly which fixed point stopped resolving. The predecessor's does not, in
 * sealed mode: a predecessor digest reported beside a lineage id publishes the pairing, and
 * the pairing is a cross-revision quantity like any other.
 */
function divergence(side, expected, observed, disclose) {
  const error = refuse('LineageReplayDivergence');
  error.side = side;
  if (disclose) {
    error.expected = expected;
    error.observed = observed;
  }
  return error;
}

/**
 * The cross-revision rows and cardinalities. Sealed-side only; never reachable from a receipt.
 *
 * Classification is by path identity, so a file that moved is one `removed` plus one `added`.
 * `renamed` is therefore always 0 under this recipe. It is emitted rather than omitted because
 * a reader of the sealed document should see that the question was asked and answered, not be
 * left to guess whether rename detection ran.
 */
function deriveCrossRevision(predecessorRows, successorRows) {
  const before = new Map(predecessorRows.map((row) => [row.path, row]));
  const after = new Map(successorRows.map((row) => [row.path, row]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(ordinal);

  const cardinalities = { added: 0, changed: 0, removed: 0, renamed: 0, unchanged: 0 };
  const changes = paths.map((path) => {
    const from = before.get(path);
    const to = after.get(path);
    const status = from && to
      ? (from.sha256 === to.sha256 ? 'unchanged' : 'changed')
      : (to ? 'added' : 'removed');
    cardinalities[status] += 1;
    return {
      path,
      predecessor_bytes: from ? from.bytes : null,
      status,
      successor_bytes: to ? to.bytes : null,
    };
  });
  return { cardinalities, changes };
}

function buildSealedManifest(spec, predecessor, successor) {
  const { cardinalities, changes } = deriveCrossRevision(predecessor.rows, successor.rows);
  return deepFreeze({
    cardinalities,
    changes,
    lineage_id: spec.lineageId,
    pairing: {
      predecessor: triple(predecessor),
      statement: `lineage ${spec.lineageId} pairs the predecessor and successor identities `
        + 'recorded in this document; continuity is attested by the curator, not by a reviewer',
      successor: triple(successor),
    },
    predecessor: { ...triple(predecessor), rows: predecessor.rows.map((row) => ({ ...row })) },
    recipe: LINEAGE_TREE_RECIPE,
    schema: LINEAGE_SEALED_MANIFEST_SCHEMA,
    successor: { ...triple(successor), rows: successor.rows.map((row) => ({ ...row })) },
    t_seal: spec.tSeal,
  });
}

/**
 * The open receipt's shape, checked against the closed allow-list before it is handed back.
 *
 * The allow-list is asserted by the tests too. It is asserted here as well because a module
 * that can emit a receipt violating its own schema has no schema — the guard is what makes
 * "closed" a property of the code rather than of the test suite.
 */
function assertClosedReceipt(receipt, sealed) {
  assertExactKeys(receipt, sealed ? SEALED_RECEIPT_KEYS : UNSEALED_RECEIPT_KEYS, 'FieldSetViolation');
  assertExactKeys(receipt.successor, ['bytes', 'count', 'digest'], 'FieldSetViolation');
  assertExactKeys(receipt.cleanliness, ['alternate_streams', 'porcelain_lines', 'read_only_all', 'reparse_points'], 'FieldSetViolation');
  assertExactKeys(receipt.tests, ['deterministic_repeats', 'failed', 'mutations_discriminating', 'mutations_total', 'passed'], 'FieldSetViolation');
  if (sealed) assertExactKeys(receipt.sealed_manifest, ['digest', 'schema'], 'FieldSetViolation');
  else assertExactKeys(receipt.predecessor, ['bytes', 'count', 'digest'], 'FieldSetViolation');
  if (!Array.isArray(receipt.evidence)) throw refuse('FieldSetViolation');
  for (const item of receipt.evidence) assertExactKeys(item, ['digest', 'label'], 'FieldSetViolation');
  return receipt;
}

const isSink = (candidate) => candidate !== null && typeof candidate === 'object'
  && typeof candidate.writeSealed === 'function';

/**
 * Build one open receipt, and — in sealed mode — hand one sealed manifest to the sink.
 *
 * The sealed document is written and made durable BEFORE the receipt that points at it exists:
 * payload before pointer. A crash can therefore leave an orphaned sealed manifest, which
 * publishes nothing, or a receipt naming a digest that does not resolve, which is a refusal
 * for its consumer. No crash window can publish a vector.
 *
 * Both roots are measured again after the sealed write and before the receipt is built. A
 * receipt may not name a fixed point that stopped being the tree's fixed point while it was
 * being produced; that is a refusal, not a quietly different receipt.
 *
 * @param {object} declaration frozen: `{lineageId, sealed, successorRoot, predecessorRoot,
 *   cleanliness, tests, evidence, verdict, notesDigest, tSeal?}`. `tSeal` is required in
 *   sealed mode and refused otherwise.
 * @param {{writeSealed(document: object): Promise<{digest: string}>}} [sealedSink]
 *   required in sealed mode, refused in unsealed mode.
 * @returns {Promise<object>} the open receipt, and nothing else.
 */
export async function buildLineageReceipt(declaration, sealedSink) {
  const spec = validateDeclaration(declaration);

  // Checked before anything is read, and before the sink is touched: a sink handed to unsealed
  // mode is a category error, and quietly ignoring it would let a caller believe rows were
  // routed somewhere when nothing computed them.
  if (spec.sealed) {
    if (!isSink(sealedSink)) throw refuse('SealedSinkRequired');
  } else if (sealedSink !== undefined && sealedSink !== null) {
    throw refuse('SealedSinkForbidden');
  }

  const successorBefore = measure(spec.successorRoot);
  const predecessorBefore = measure(spec.predecessorRoot);

  let sealedManifestDigest = null;
  if (spec.sealed) {
    const manifest = buildSealedManifest(spec, predecessorBefore, successorBefore);
    const expected = lineageDocumentDigest(manifest);
    let reported;
    try {
      reported = await sealedSink.writeSealed(manifest);
    } catch {
      // The sink's own diagnostic is discarded rather than wrapped: an adapter is free to put
      // a path in its exception, and this module is not free to pass one on.
      throw refuse('ArtifactConflict');
    }
    if (!isPlainObject(reported) || reported.digest !== expected) throw refuse('ArtifactConflict');
    sealedManifestDigest = expected;
  }

  const successorAfter = measure(spec.successorRoot);
  if (successorAfter.digest !== successorBefore.digest) {
    throw divergence('successor', successorBefore.digest, successorAfter.digest, true);
  }
  const predecessorAfter = measure(spec.predecessorRoot);
  if (predecessorAfter.digest !== predecessorBefore.digest) {
    throw divergence('predecessor', predecessorBefore.digest, predecessorAfter.digest, !spec.sealed);
  }

  const receipt = {
    cleanliness: { ...spec.cleanliness },
    evidence: spec.evidence.map((item) => ({ ...item })),
    lineage_id: spec.lineageId,
    notes_digest: spec.notesDigest,
    recipe: LINEAGE_TREE_RECIPE,
    schema: LINEAGE_RECEIPT_SCHEMA,
    sealed: spec.sealed,
    successor: triple(successorBefore),
    tests: { ...spec.tests },
    verdict: spec.verdict,
  };
  if (spec.sealed) {
    // `bytes` is deliberately absent: the manifest's length is close to linear in the number
    // of changed rows, so publishing it would publish the cardinality while naming no path.
    receipt.sealed_manifest = { digest: sealedManifestDigest, schema: LINEAGE_SEALED_MANIFEST_SCHEMA };
  } else {
    receipt.predecessor = triple(predecessorBefore);
  }

  return deepFreeze(assertClosedReceipt(receipt, spec.sealed));
}

/**
 * Is a receipt still fresh — do the roots it names still reproduce their recorded digests?
 *
 * This is the whole of freshness in this design. There is no TTL, no expiry and no clock to
 * get wrong. A receipt is fresh while its digests resolve and stale the moment one does not,
 * and stale means re-derive.
 *
 * A sealed receipt names no predecessor, so there is nothing to check one against and passing
 * a predecessor root is refused rather than silently ignored.
 */
export function verifyLineageReceipt(receipt, roots) {
  if (!isPlainObject(receipt) || typeof receipt.sealed !== 'boolean') throw refuse('FieldSetViolation');
  assertClosedReceipt(receipt, receipt.sealed);
  if (receipt.schema !== LINEAGE_RECEIPT_SCHEMA || receipt.recipe !== LINEAGE_TREE_RECIPE) {
    throw refuse('FieldSetViolation');
  }
  assertExactKeys(roots, receipt.sealed ? ['successorRoot'] : ['predecessorRoot', 'successorRoot'], 'FieldSetViolation');

  const successor = measure(roots.successorRoot);
  if (successor.digest !== receipt.successor.digest
      || successor.count !== receipt.successor.count
      || successor.bytes !== receipt.successor.bytes) {
    throw divergence('successor', receipt.successor.digest, successor.digest, true);
  }

  if (!receipt.sealed) {
    const predecessor = measure(roots.predecessorRoot);
    if (predecessor.digest !== receipt.predecessor.digest
        || predecessor.count !== receipt.predecessor.count
        || predecessor.bytes !== receipt.predecessor.bytes) {
      throw divergence('predecessor', receipt.predecessor.digest, predecessor.digest, true);
    }
  }
  return deepFreeze({ fresh: true, sealed: receipt.sealed, successor: triple(successor) });
}

function validateRegisterRecord(record) {
  assertExactKeys(record, REGISTER_RECORD_KEYS, 'FieldSetViolation');
  if (record.schema !== LINEAGE_EXPOSURE_REGISTER_SCHEMA) throw refuse('FieldSetViolation');
  return {
    lineage_id: boundedIdentifier(record.lineage_id),
    reader_ref: boundedIdentifier(record.reader_ref),
    released_digest: documentDigestField(record.released_digest),
    schema: LINEAGE_EXPOSURE_REGISTER_SCHEMA,
  };
}

/**
 * Append one release to the exposure register.
 *
 * The register records **who chose to look**, never what they saw. That is the only reason a
 * register can itself be open: it contains no row and no cardinality, so it is a list of names
 * rather than a list of labels. Reading a seal is an exposure event, not a privilege
 * escalation — it grants nothing, and its only effect is to move the reader permanently out of
 * the evaluator pool. Appending is idempotent on the whole triple, and the register never
 * shrinks and never reorders.
 */
export function appendExposureRelease(records, release) {
  if (!Array.isArray(records)) throw refuse('FieldSetViolation');
  const existing = records.map(validateRegisterRecord);

  assertExactKeys(release, RELEASE_KEYS, 'FieldSetViolation');
  const record = {
    lineage_id: boundedIdentifier(release.lineageId),
    reader_ref: boundedIdentifier(release.readerRef),
    released_digest: documentDigestField(release.releasedDigest),
    schema: LINEAGE_EXPOSURE_REGISTER_SCHEMA,
  };

  const already = existing.some((candidate) => candidate.lineage_id === record.lineage_id
    && candidate.reader_ref === record.reader_ref
    && candidate.released_digest === record.released_digest);

  return deepFreeze(already ? existing : [...existing, record]);
}

/**
 * Refuse a sealed store sited inside any measured root or any declared open document store.
 *
 * This is the design's one machine-enforced property, and it has to hold on filesystem
 * identity rather than on spelling: a case variant, a trailing or doubled separator, a dot
 * segment, an 8.3 alias, a `\\?\` spelling, an admin-share UNC path and a junction all name
 * the same directory, and a string comparison lets every one of them but the first through.
 *
 * The underlying guard's message names both paths, which is right for a tool reporting on one
 * tree and wrong here. It is caught and replaced with the bare code.
 */
export function assertSealedStoreContainment(sealedManifestPath, forbiddenRoots) {
  if (typeof sealedManifestPath !== 'string' || sealedManifestPath.length === 0) {
    throw refuse('FieldSetViolation');
  }
  if (!Array.isArray(forbiddenRoots) || forbiddenRoots.some((root) => typeof root !== 'string')) {
    throw refuse('FieldSetViolation');
  }
  try {
    assertPathOutsideRoots(forbiddenRoots, sealedManifestPath);
  } catch {
    throw refuse('SealedStoreContainment');
  }
}
