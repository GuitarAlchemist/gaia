/**
 * artifact-chain-files.mjs — the only part of the artifact chain that touches a filesystem.
 *
 * `src/artifact-chain.mjs` decides whether a chain is fresh and cannot read a file. This adapter
 * measures real bytes for it and persists a manifest, and holds no policy of its own beyond the
 * three things a filesystem forces someone to decide:
 *
 *   containment  a locator names a file INSIDE the root, decided on real path identity rather than
 *                on string shape, so `..`, an absolute spelling, and a symlinked component are all
 *                refused at any depth instead of being resolved helpfully;
 *   bounds       an artifact and a document have a byte ceiling, so an unbounded or wrong file
 *                cannot be read into memory in the name of hashing it;
 *   immutability a manifest is created if absent and otherwise compared. Identical bytes are
 *                UNCHANGED; different bytes are a refusal. Existing evidence is never overwritten.
 *
 * The create-if-absent write is done by writing a temporary sibling, making it durable, and then
 * hard-linking it into place — `link` fails with EEXIST rather than replacing, so a second writer
 * that arrives mid-write never observes a half-written manifest and never wins a race silently.
 * Where linking is unavailable the exclusive-create fallback is used instead. The temporary name
 * is removed and the available publication boundary is flushed before `WRITTEN`. This is atomic
 * creation of one file; it is not a lock, and observing a file is still not a claim about what
 * that file will contain a moment later.
 *
 * Refusals are typed and fail closed: the message is exactly the code, and a path is never
 * interpolated into a refusal. A refusal writes nothing *at the point it refuses*, but it is not
 * a rollback of the whole call: `emitCandidateArtifactChain` persists `intent.json` before it
 * measures `receipt.json`, so a refusal for absent or oversized later input leaves that stored
 * intent on disk. That is deliberate — the bytes are immutable evidence, and deleting them to
 * make a failure look tidy would destroy data a later run is required to match byte for byte.
 */

import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync,
  realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import {
  buildArtifactChain, canonicalArtifactChainJson, validateArtifactChain,
} from './artifact-chain.mjs';

export const ARTIFACT_BYTE_LIMIT = 4 * 1024 * 1024;
export const ARTIFACT_CHAIN_SIDECAR_NAME = 'artifact-chain.json';
export const ARTIFACT_CHAIN_INTENT_NAME = 'intent.json';
const CANDIDATE_STATUSES = Object.freeze(['CANDIDATE_READY', 'CANDIDATE_REJECTED']);

export class ArtifactChainFileError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ArtifactChainFileError';
    this.code = code;
  }
}

const fail = code => { throw new ArtifactChainFileError(code); };

/** A real existing directory, by filesystem identity rather than by spelling. */
function physicalRoot(root) {
  if (typeof root !== 'string' || root.length === 0) fail('InvalidRoot');
  let physical;
  try {
    const metadata = lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('InvalidRoot');
    physical = realpathSync.native(root);
  } catch (error) {
    if (error instanceof ArtifactChainFileError) throw error;
    return fail('InvalidRoot');
  }
  return physical;
}

/**
 * Resolve one locator under `root`, refusing escape before any byte is read and refusing a
 * symlinked component anywhere along the way. The walk covers every segment, so a link planted
 * in an intermediate directory is caught rather than followed.
 */
function resolveLocator(physical, locator) {
  if (typeof locator !== 'string' || locator.length === 0 || locator.includes('\0')
    || locator.includes('\\') || locator.split('/').some(segment => segment === '' || segment === '.'
      || segment === '..')) fail('InvalidLocator');
  const target = resolve(physical, locator);
  const containment = relative(physical, target);
  if (containment === '' || containment.startsWith('..') || containment.includes(`..${sep}`)
    || resolve(physical, containment) !== target) fail('InvalidLocator');
  let cursor = physical;
  for (const segment of locator.split('/')) {
    cursor = join(cursor, segment);
    let metadata;
    try { metadata = lstatSync(cursor); } catch { fail('ArtifactUnreadable'); }
    if (metadata.isSymbolicLink()) fail('SymlinkedLocator');
  }
  return target;
}

/**
 * Read at most `limit` bytes from an already-open descriptor, refusing anything larger.
 *
 * The ceiling is decided twice from the descriptor and never from the path: `fstat` measures the
 * file this descriptor actually holds, and the read then fills a `limit + 1` buffer at explicit
 * positions and refuses when it comes back full. Growth of the opened file beyond the limit is
 * refused. Replacing its pathname leaves the descriptor bound to the original inode, whose bytes
 * remain bounded. Exported so that property can be exercised against a real descriptor whose
 * file changes underneath it; production callers always pass `ARTIFACT_BYTE_LIMIT`.
 */
export function readBoundedDescriptor(handle, limit, { unreadable, tooLarge }) {
  if (!Number.isSafeInteger(limit) || limit < 0) return fail(unreadable);
  let metadata;
  try { metadata = fstatSync(handle); } catch { return fail(unreadable); }
  if (!metadata.isFile()) fail(unreadable);
  if (metadata.size > limit) fail(tooLarge);
  const buffer = Buffer.alloc(limit + 1);
  let filled = 0;
  while (filled < buffer.length) {
    let read;
    try { read = readSync(handle, buffer, filled, buffer.length - filled, filled); }
    catch { return fail(unreadable); }
    if (read === 0) break;
    filled += read;
  }
  if (filled > limit) fail(tooLarge);
  return buffer.subarray(0, filled);
}

function readBounded(path, code) {
  const artifact = code === 'ArtifactUnreadable';
  let handle;
  try { handle = openSync(path, 'r'); } catch { return fail(code); }
  try {
    return readBoundedDescriptor(handle, ARTIFACT_BYTE_LIMIT, {
      unreadable: artifact ? code : 'DocumentUnreadable',
      tooLarge: artifact ? 'ArtifactTooLarge' : 'DocumentTooLarge',
    });
  } catch (error) {
    if (error instanceof ArtifactChainFileError) throw error;
    return fail(code);
  } finally {
    closeSync(handle);
  }
}

/** Bounded read plus JSON parse. Unreadable and unparsable are the same answer: refuse. */
export function readArtifactChainJson(path) {
  if (typeof path !== 'string' || path.length === 0) fail('DocumentUnreadable');
  const bytes = readBounded(path, 'DocumentUnreadable');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail('DocumentUnreadable');
  }
}

/**
 * Hash every node's artifact, returning the `{ nodeId: digest }` map the pure module consumes for
 * both `measured` (at build) and `observed` (at evaluation). A missing, oversize, escaping, or
 * symlinked artifact refuses; nothing defaults.
 */
export function measureArtifactChainFiles({ root, nodes }) {
  const physical = physicalRoot(root);
  if (!Array.isArray(nodes)) fail('InvalidMeasurementRequest');
  const measured = {};
  for (const node of nodes) {
    if (typeof node?.id !== 'string') fail('InvalidMeasurementRequest');
    const bytes = readBounded(resolveLocator(physical, node.locator), 'ArtifactUnreadable');
    measured[node.id] = createHash('sha256').update(bytes).digest('hex');
  }
  return measured;
}

/** Canonical bytes of a document, newline-terminated so the file is a well-formed text file. */
const documentBytes = value => Buffer.from(`${canonicalArtifactChainJson(value)}\n`, 'utf8');

/**
 * Create `path` with exactly `bytes`, or compare what is already there.
 *
 * WRITTEN   the file did not exist and now holds these bytes, durably.
 * UNCHANGED the file already held byte-identical content; nothing was rewritten.
 * refusal   the file exists with different bytes. It is left exactly as it was.
 */
function synchronizePublishedEntry(path, writeCode) {
  // Node does not expose a portable Windows directory-fsync handle. Reopening the published file
  // writable and flushing it is the strongest per-entry metadata barrier available there; POSIX
  // can and must flush the parent directory that owns the new name.
  const target = process.platform === 'win32' ? path : dirname(path);
  const flags = process.platform === 'win32' ? 'r+' : 'r';
  let handle;
  try {
    handle = openSync(target, flags);
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
  } catch {
    try { if (handle !== undefined) closeSync(handle); } catch { /* Keep the typed refusal. */ }
    fail(writeCode);
  }
}

function createImmutable(path, bytes, conflictCode, writeCode) {
  const close = handle => {
    if (handle === undefined) return;
    try { closeSync(handle); } catch { fail(writeCode); }
  };
  const existing = () => {
    let handle;
    try { handle = openSync(path, 'r'); }
    catch (error) { return fail(error?.code === 'ENOENT' ? writeCode : conflictCode); }
    let current;
    try {
      current = readBoundedDescriptor(handle, ARTIFACT_BYTE_LIMIT,
        { unreadable: conflictCode, tooLarge: conflictCode });
    } catch { return fail(conflictCode); }
    finally { close(handle); }
    if (!current.equals(bytes)) fail(conflictCode);
    // A prior publication may have returned a typed synchronization refusal after writing complete
    // bytes. Retry that boundary before reporting convergence.
    synchronizePublishedEntry(path, writeCode);
    return { status: 'UNCHANGED' };
  };
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let temporaryHandle;
  let temporaryCreated = false;
  let outcome;
  try {
    try {
      temporaryHandle = openSync(temporary, 'wx', 0o600);
      temporaryCreated = true;
    } catch { return existing(); }
    try {
      writeFileSync(temporaryHandle, bytes);
      fsyncSync(temporaryHandle);
      close(temporaryHandle);
      temporaryHandle = undefined;
    } catch { return fail(writeCode); }

    try {
      // Payload complete and durable before anything can observe it under its real name.
      linkSync(temporary, path);
      outcome = 'WRITTEN';
    } catch (error) {
      if (error?.code === 'EEXIST') outcome = 'EXISTING';
      else {
        // No hard links on this filesystem: fall back to exclusive create, which is still
        // create-if-absent and never replaces existing evidence. Any write failure removes the
        // file this call exclusively created before returning a typed, path-free refusal.
        let fallback;
        try { fallback = openSync(path, 'wx', 0o600); }
        catch (raced) {
          if (raced?.code === 'EEXIST') outcome = 'EXISTING';
          else fail(writeCode);
        }
        if (fallback !== undefined) {
          try {
            writeFileSync(fallback, bytes);
            fsyncSync(fallback);
            close(fallback);
            fallback = undefined;
            outcome = 'WRITTEN';
          } catch {
            try { if (fallback !== undefined) closeSync(fallback); } catch { /* Keep typed refusal. */ }
            try { unlinkSync(path); } catch { /* A later call will refuse partial evidence. */ }
            fail(writeCode);
          }
        }
      }
    }
  } finally {
    try { if (temporaryHandle !== undefined) closeSync(temporaryHandle); } catch { /* typed below */ }
    if (temporaryCreated) {
      try { unlinkSync(temporary); }
      catch (error) { if (error?.code !== 'ENOENT') fail(writeCode); }
    }
  }
  if (outcome === 'EXISTING') return existing();
  if (outcome !== 'WRITTEN') fail(writeCode);
  synchronizePublishedEntry(path, writeCode);
  return { status: 'WRITTEN' };
}

/** Persist a manifest immutably. An existing conflicting manifest is refused, never overwritten. */
export function persistArtifactChainManifest({ path, manifest }) {
  if (typeof path !== 'string' || path.length === 0) fail('InvalidManifestPath');
  return createImmutable(path, documentBytes(validateArtifactChain(manifest)),
    'ManifestConflict', 'ManifestWriteFailed');
}

/**
 * Emit the candidate-stage sidecar for one autonomous factory job.
 *
 * Inputs are what the host already has: the accepted job intent from its authority ledger and the
 * `receipt.json` the factory already wrote. The stored intent is written next to the receipt as
 * evidence in its own right so that it, too, can be hashed and re-checked later; like the
 * manifest it is created if absent and compared otherwise.
 *
 * The sidecar carries exactly two nodes. `TEST_EVIDENCE`, `INDEPENDENT_REVIEW`, and
 * `PUBLICATION_EVIDENCE` are therefore reported `NOT_PROVIDED` by any evaluation of it. Nothing
 * here claims those stages happened, and a rejected candidate is recorded as rejected.
 *
 * The candidate node hashes the historical `receipt.json` the completed run already wrote, bound
 * to the job intent's `draft.headRevision` — the input base the job was admitted against. It does
 * not hash the current candidate tree or any uncommitted working copy. Re-evaluating it answers
 * whether this run's evidence still describes the base it came from, never whether the code in
 * front of the reader is the code that was tested.
 *
 * The stored intent is persisted before the receipt is measured, so a refusal for absent or
 * oversized later input leaves `intent.json` on disk. Those bytes are immutable evidence a later
 * run must match exactly; they are not cleaned up to make the failure look atomic.
 */
export function emitCandidateArtifactChain({ evidenceDir, intent, status }) {
  if (!CANDIDATE_STATUSES.includes(status)) fail('InvalidCandidateStatus');
  const physical = physicalRoot(evidenceDir);
  const headRevision = intent?.draft?.headRevision;
  if (typeof headRevision !== 'string' || !/^[a-f0-9]{40}$/u.test(headRevision)) fail('InvalidJobIntent');
  const subject = `${intent.repository}#${intent.itemNumber}/draft-${intent.draft.number}`;
  const intentBytes = documentBytes(intent);
  const stored = createImmutable(join(physical, ARTIFACT_CHAIN_INTENT_NAME), intentBytes,
    'StoredIntentConflict', 'StoredIntentWriteFailed');

  const descriptor = {
    subject,
    nodes: [
      { id: 'accepted-intent', stage: 'INTENT', rootRevision: null,
        producer: 'gaia-autonomous-factory-authority', locator: ARTIFACT_CHAIN_INTENT_NAME,
        claim: { kind: 'ACCEPTED_INTENT', statement: 'job intent as recorded in the authority ledger' },
        dependencies: [] },
      { id: 'candidate', stage: 'CANDIDATE', rootRevision: headRevision,
        producer: 'gaia-agent-factory', locator: 'receipt.json',
        claim: { kind: status, statement: 'asserted by the stored factory receipt' },
        dependencies: [] },
    ],
  };
  let manifest;
  try {
    const measured = measureArtifactChainFiles({ root: physical, nodes: descriptor.nodes });
    descriptor.nodes[1].dependencies.push({ nodeId: 'accepted-intent', relation: 'required',
      pinnedDigest: measured['accepted-intent'] });
    manifest = buildArtifactChain({ descriptor, measured });
  } catch (error) {
    if (error instanceof ArtifactChainFileError) throw error;
    fail(error.code === undefined ? 'InvalidJobIntent' : error.code);
  }
  const written = persistArtifactChainManifest({
    path: join(physical, ARTIFACT_CHAIN_SIDECAR_NAME), manifest,
  });
  return { status: written.status, storedIntent: stored.status, subject,
    pendingStages: manifest.pendingStages };
}
