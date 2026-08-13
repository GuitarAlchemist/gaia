/**
 * event-log.mjs — append-only JSONL event log. The only I/O in the bus.
 *
 * Multiple local server processes may share one data directory, so the log needs a
 * commit protocol. The smallest one that is actually atomic on Windows is a lock
 * *directory*: `mkdir` either creates it or fails, with no read-modify-write window.
 * No dependency, no fcntl, no named mutex. (On Windows the "already held" failure is
 * EEXIST *or* EPERM/EACCES — see `withLock`.)
 *
 * The protocol, in full:
 *
 *   1. acquire  — mkdir(events.lock) in a retry loop until a deadline.
 *   2. re-read  — read and validate the whole log *inside* the lock.
 *   3. replay   — rebuild state from those records, so id counters reflect
 *                 everything every other process has already committed.
 *   4. decide   — derive new events from that fresh state.
 *   5. commit   — one appendFileSync of complete newline-terminated lines,
 *                 then fsync, so a reader never sees a half record.
 *   6. release  — rmdir(events.lock), with Windows retries.
 *
 * Steps 2–4 are what make ids unique across processes: nothing is assigned from
 * stale state. Step 5 is what keeps the file one-record-per-line.
 *
 * Everything here fails closed. A lock that cannot be acquired, a line that is not
 * valid JSON, a record missing its `type`, or a file whose last line is torn all
 * raise rather than truncating, skipping, or resetting the log. A corrupt log is a
 * condition to report, never one to silently repair.
 */

import {
  appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync,
  openSync, closeSync, fsyncSync, statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/** How long a caller will wait for the lock before failing closed. */
export const LOCK_TIMEOUT_MS = Number(process.env.GAIA_INTERAGENT_LOCK_TIMEOUT_MS ?? 10_000);

/**
 * A lock older than this is *reported* as probably abandoned. It is never broken.
 *
 * Automatic stale-lock breaking is a TOCTOU by construction: a waiter stats an old
 * lock, the owner releases it, a third process acquires a fresh one, and then the
 * waiter's rmSync deletes that fresh lock — producing exactly the two-writer state
 * the lock exists to prevent. Ownership/generation re-checks narrow the window but
 * cannot close it without an atomic compare-and-delete, which the filesystem does
 * not offer. So this product fails closed and asks a human to look.
 */
export const LOCK_STALE_MS = Number(process.env.GAIA_INTERAGENT_LOCK_STALE_MS ?? 60_000);

/**
 * Release-side retry budget for Windows.
 *
 * Releasing is `rmSync` on a directory this process created and still owns. On
 * Windows that can fail transiently with EBUSY/EPERM/ENOTEMPTY when an antivirus
 * scanner, an indexer, or a just-closed handle is still holding the directory open
 * for a few milliseconds. Without retries the release throws out of the `finally`,
 * the lock survives, and every peer then fails closed on a lock whose owner has
 * already finished — a wedged bus with no automatic recovery.
 *
 * These retries change WHEN the owner's own release gives up. They do not change
 * WHICH lock is removed, and no code path anywhere removes a lock it does not own.
 * Ownership is exactly as strong as before.
 */
export const LOCK_RELEASE_MAX_RETRIES = Number(process.env.GAIA_INTERAGENT_LOCK_RELEASE_RETRIES ?? 12);
export const LOCK_RELEASE_RETRY_DELAY_MS = Number(process.env.GAIA_INTERAGENT_LOCK_RELEASE_RETRY_DELAY_MS ?? 25);

/** The rm options used for every removal this module performs. */
export const LOCK_RM_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: LOCK_RELEASE_MAX_RETRIES,
  retryDelay: LOCK_RELEASE_RETRY_DELAY_MS,
});

/** Failure modes are named so callers and tests can distinguish them. */
export class LockTimeoutError extends Error {
  constructor(message) { super(message); this.name = 'LockTimeoutError'; this.code = 'GAIA_LOCK_TIMEOUT'; }
}

export class CorruptLogError extends Error {
  constructor(message, { line } = {}) {
    super(message);
    this.name = 'CorruptLogError';
    this.code = 'GAIA_LOG_CORRUPT';
    this.line = line ?? null;
  }
}

/**
 * Where the bus keeps its data when the caller does not say.
 *
 * Never inside the plugin archive: an installed plugin directory may be read-only,
 * may be replaced wholesale on update, and must not accumulate user data. The
 * default is a per-user local application-data path, and `GAIA_INTERAGENT_DATA_DIR`
 * (or `--data-dir` on the CLIs) overrides it for every command.
 */
export function defaultDataDir() {
  const base = process.env.LOCALAPPDATA
    ?? process.env.XDG_DATA_HOME
    ?? (homedir() ? join(homedir(), '.local', 'share') : null)
    ?? tmpdir();
  return resolve(join(base, 'gaia-interagent', 'data'));
}

export function dataDir() {
  const explicit = process.env.GAIA_INTERAGENT_DATA_DIR;
  return explicit && explicit.trim().length > 0 ? resolve(explicit) : defaultDataDir();
}

export function logPath() {
  return join(dataDir(), 'events.jsonl');
}

export function lockPath() {
  return join(dataDir(), 'events.lock');
}

// ---------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------

/** Block without a timer. The lock path is synchronous by construction. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockAgeMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0; // vanished between EEXIST and stat: someone released it, just retry
  }
}

/**
 * Run `fn` while holding the log lock. Returns whatever `fn` returns.
 *
 * `mkdir` is the atomic primitive: it either creates the directory or throws, so two
 * processes can never both believe they hold it. On POSIX the contended failure is
 * always EEXIST; on Windows it can also be EPERM or EACCES when the current holder is
 * mid-release, so all three mean "retry", never "give up" and never "proceed".
 *
 * A lock held by someone else is waited on and then reported. It is never removed
 * here — only its own holder removes it, in the `finally` below. That is the whole
 * reason this is safe: no code path deletes a lock it does not own.
 */
export function withLock(fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const dir = dataDir();
  const lock = lockPath();
  mkdirSync(dir, { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let held = false;
  let lastCode = null;

  while (!held) {
    try {
      mkdirSync(lock); // atomic: succeeds for exactly one caller
      held = true;
    } catch (err) {
      // EEXIST is the ordinary "someone else holds it". EPERM/EACCES are the Windows
      // faces of the same condition: when one process is inside rmSync releasing the
      // directory and another calls mkdir on it, Windows reports EPERM rather than
      // EEXIST. Measured at 16 concurrent client+server pairs on this host, where
      // treating EPERM as fatal aborted 2 of 16 workers. Retrying is still fail-closed
      // — the loop only ever exits by holding the lock or by timing out. A genuine
      // permission problem simply surfaces as a timeout carrying this code.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      lastCode = err.code;

      if (Date.now() >= deadline) {
        // Age is diagnostic only. Even a lock that looks abandoned is left in place:
        // between observing its age and deleting it, its owner may have released it
        // and a third process may have acquired a fresh one. Deleting then would
        // admit two writers. A human removes it, having checked no server is running.
        const ageMs = lockAgeMs(lock);
        const suspicion = ageMs > staleMs
          ? ` The lock is ${Math.round(ageMs / 1000)}s old (> ${Math.round(staleMs / 1000)}s), so it may have been abandoned by a process that died mid-commit. It is NOT removed automatically: breaking a lock you do not own is a race. Verify no bus server is running, then remove the directory by hand.`
          : '';
        throw new LockTimeoutError(
          `could not acquire ${lock} within ${timeoutMs}ms (last errno ${lastCode}); ` +
          `refusing to write unlocked (fail closed).${suspicion}`,
        );
      }
      sleepSync(15);
    }
  }

  try {
    // Owner marker is diagnostic only. The lock is the directory's existence.
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
    return fn();
  } finally {
    // Only the holder releases, and only the lock it just acquired. The retry budget
    // exists solely because Windows can transiently refuse to remove a directory this
    // process owns; it never widens what may be removed.
    rmSync(lock, LOCK_RM_OPTIONS);
  }
}

// ---------------------------------------------------------------------------
// read (validating) / append (atomic)
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL body, failing closed on anything that is not a complete,
 * well-formed record on its own line.
 */
export function parseEventLog(text, { source = logPath() } = {}) {
  if (text.length === 0) return [];

  // A body that does not end in a newline means the last append was torn. Reading
  // "as much as parses" would silently drop a committed event, so refuse instead.
  if (!text.endsWith('\n')) {
    const lastLine = text.slice(text.lastIndexOf('\n') + 1);
    throw new CorruptLogError(
      `${source}: log does not end with a newline — last record is torn: ${JSON.stringify(lastLine.slice(0, 120))}`,
      { line: text.split('\n').length },
    );
  }

  const lines = text.split('\n');
  lines.pop(); // trailing empty field after the final newline

  return lines.map((line, i) => {
    const lineNo = i + 1;
    if (line.trim().length === 0) {
      throw new CorruptLogError(`${source}:${lineNo}: blank line in an append-only log`, { line: lineNo });
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      throw new CorruptLogError(`${source}:${lineNo}: not valid JSON (${err.message})`, { line: lineNo });
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new CorruptLogError(`${source}:${lineNo}: record is not a JSON object`, { line: lineNo });
    }
    if (typeof record.type !== 'string' || record.type.length === 0) {
      throw new CorruptLogError(`${source}:${lineNo}: record has no event type`, { line: lineNo });
    }
    return record;
  });
}

/**
 * Read every committed event. Throws CorruptLogError rather than returning a partial log.
 *
 * UNLOCKED. Safe only when the caller already holds the lock (as `commitEvents` does)
 * or when no other process can be writing. Concurrently with another process's append
 * this can observe a torn tail and throw — which is correct as a *safety* property but
 * is a false alarm as a *liveness* one, because the write completes microseconds later.
 * Anything user-facing should call `readEventsConsistent` instead.
 */
export function readEvents() {
  const path = logPath();
  if (!existsSync(path)) return [];
  return parseEventLog(readFileSync(path, 'utf8'), { source: path });
}

/**
 * Read every committed event with the lock held, so no append can be in flight.
 *
 * This is the read every user-facing path uses: server startup, CLI snapshots, the
 * doctor. Taking the lock costs a few milliseconds and removes the transient torn-tail
 * failure entirely — a CorruptLogError from here means the log is genuinely damaged,
 * not that a writer happened to be mid-append. Lock contention still fails closed.
 */
export function readEventsConsistent(lockOptions) {
  // A pure read must not MATERIALISE the thing it is reading. `withLock` has to mkdir
  // the data directory before it can create the lock inside it, so routing every
  // user-facing read through it meant that merely configuring a client to spawn the
  // bundled server created a user-data directory with zero verb calls.
  //
  // Nothing is committed yet, so there is nothing to read. The race is benign and
  // bounded, and it is stated rather than hidden: a peer may create the directory and
  // append between this check and the return, in which case this read reports an empty
  // log a moment before the first record. No identifier is ever minted from this path
  // — every commit re-reads under the lock via `commitEvents` — so a stale empty read
  // can neither collide an id nor lose a record. Fail-closed reads are untouched: once
  // the directory exists, this is the locked read exactly as before.
  if (!existsSync(dataDir())) return [];
  return withLock(() => readEvents(), lockOptions);
}

/**
 * Read a log file that is NOT this bus's data directory, read-only and unlocked.
 *
 * Used by `verify` to inspect preserved evidence without adopting it, and by the
 * negative control to inspect a deliberately damaged copy. It opens the path for
 * reading only and never creates, locks, or writes anything beside it.
 */
export function readEventFile(path) {
  if (!existsSync(path)) throw new CorruptLogError(`${path}: no such event log`);
  return parseEventLog(readFileSync(path, 'utf8'), { source: path });
}

/**
 * Append complete records in one write, then fsync.
 *
 * Callers that mint ids MUST already hold the lock (see `commitEvents`). This
 * function does not take it itself, because taking it here would make the
 * read-decide-append sequence non-atomic — the exact bug the commit protocol removes.
 */
export function appendEvents(events) {
  if (events.length === 0) return;
  mkdirSync(dataDir(), { recursive: true });

  const lines = events.map((e) => JSON.stringify(e));
  // JSON.stringify escapes newlines, so this should be unreachable. Assert anyway:
  // one record per line is the property every reader depends on.
  if (lines.some((l) => l.includes('\n'))) {
    throw new CorruptLogError('refusing to append: a serialised record contains a raw newline');
  }
  const payload = lines.join('\n') + '\n';

  const path = logPath();
  appendFileSync(path, payload, 'utf8');
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * The full commit protocol in one call: lock → re-read → replay → decide → append.
 *
 * `decide(events)` receives every committed event and returns the new events to
 * append. It runs inside the lock, so any id it derives from replayed state is
 * unique across processes. If it throws, nothing is written and the lock is released.
 */
export function commitEvents(decide, lockOptions) {
  return withLock(() => {
    const existing = readEvents();
    const { events = [], value } = decide(existing) ?? {};
    appendEvents(events);
    return { events, value, priorCount: existing.length };
  }, lockOptions);
}

/**
 * Single-process convenience so a fresh workspace starts from a known-empty log.
 *
 * Precondition, not a protocol: the caller must know no peer is running. This is the
 * one operation that deletes the lock along with the log, so it is the one operation
 * that could hand two writers the same directory.
 *
 * The guard below is a courtesy check and is explicitly NOT a concurrency claim: a
 * peer can acquire the lock between the check and the rmSync. Closing that gap needs
 * an atomic compare-and-delete the filesystem does not offer. `resetLog` is not a bus
 * verb, not a lifecycle command, and not reachable from any MCP client.
 *
 * For a shared or live directory, do not reset. Use a new directory.
 */
export function resetLog() {
  const dir = dataDir();
  if (!existsSync(dir)) return;
  if (existsSync(lockPath())) {
    throw new LockTimeoutError(
      `refusing to reset ${dir}: ${lockPath()} exists, so another process may be committing. ` +
      'resetLog is single-process only; for a shared directory, use a new directory instead.',
    );
  }
  rmSync(dir, LOCK_RM_OPTIONS);
}
