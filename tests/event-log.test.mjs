/**
 * event-log.test.mjs — the commit protocol: lock, fail-closed reads, atomic append.
 *
 * These tests own the commit-protocol properties. Several are deliberately
 * discriminating: they fail against the Phase 1 log and against the tempting-but-
 * wrong fixes (stale-lock breaking, truncate-and-continue).
 *
 * Each test gets its own data directory under a per-run scratch root, because
 * `dataDir()` reads GAIA_INTERAGENT_DATA_DIR at call time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  withLock, commitEvents, appendEvents, readEvents, readEventsConsistent, parseEventLog,
  resetLog, logPath, lockPath, dataDir,
  LockTimeoutError, CorruptLogError, LOCK_TIMEOUT_MS,
} from '../src/event-log.mjs';
import { replay, snapshot, commit, EMPTY_STATE } from '../src/bus-core.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'gaia-interagent-log-test-'));
let counter = 0;

/** Point the module at a fresh directory and return it. */
function freshDir(name) {
  const dir = join(ROOT, `${name}-${counter += 1}`);
  mkdirSync(dir, { recursive: true });
  process.env.GAIA_INTERAGENT_DATA_DIR = dir;
  return dir;
}

const EVENT = (n) => ({ type: 'actor.registered', at: `2026-08-09T12:00:0${n}.000Z`, ref: `act-000${n}`, name: `a${n}`, isNew: true, kind: 'test', declaredCapabilities: [], busAuthority: ['send'] });

/** assert.throws returns undefined, and these tests need the error itself. */
function throwsWith(fn, Expected) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Expected, `expected ${Expected.name}, got ${err.name}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${Expected.name} to be thrown, but nothing was`);
}

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// append / read
// ---------------------------------------------------------------------------

test('append writes one complete record per line, terminated by a newline', () => {
  freshDir('append');
  appendEvents([EVENT(1), EVENT(2)]);
  appendEvents([EVENT(3)]);

  const raw = readFileSync(logPath(), 'utf8');
  assert.ok(raw.endsWith('\n'), 'the log always ends with a newline');
  assert.equal(raw.split('\n').length - 1, 3, 'three lines for three events');
  assert.equal(readEvents().length, 3);
  assert.equal(
    readEvents().map((e) => JSON.stringify(e)).join('\n') + '\n', raw,
    'records round-trip to exactly the bytes on disk',
  );
});

test('appending nothing writes nothing', () => {
  freshDir('empty-append');
  appendEvents([]);
  assert.equal(existsSync(logPath()), false);
  assert.deepEqual(readEvents(), []);
});

test('a text body containing newlines stays on one line', () => {
  freshDir('multiline');
  appendEvents([{ type: 'message.sent', at: '2026-08-09T12:00:00.000Z', message: { text: 'line one\nline two\r\nline three' } }]);
  assert.equal(readFileSync(logPath(), 'utf8').split('\n').length - 1, 1, 'still exactly one line');
  assert.equal(readEvents()[0].message.text, 'line one\nline two\r\nline three', 'and the text survives verbatim');
});

// ---------------------------------------------------------------------------
// fail-closed reads
// ---------------------------------------------------------------------------

test('a malformed record fails closed and names the line — no truncation, no reset', () => {
  const dir = freshDir('malformed');
  appendEvents([EVENT(1), EVENT(2)]);
  const before = readFileSync(logPath(), 'utf8');

  writeFileSync(logPath(), before + '{"type":"actor.registered", THIS IS NOT JSON}\n', 'utf8');

  const err = throwsWith(() => readEvents(), CorruptLogError);
  assert.equal(err.code, 'GAIA_LOG_CORRUPT');
  assert.equal(err.line, 3, 'the failing line number is reported');
  assert.match(err.message, /not valid JSON/);

  // The critical property: failing did not repair, truncate, or reset anything.
  const after = readFileSync(logPath(), 'utf8');
  assert.ok(after.startsWith(before), 'the good prefix is intact');
  assert.ok(after.length > before.length, 'the bad line is still there — nothing was truncated away');
  assert.ok(existsSync(join(dir, 'events.jsonl')));

  // And a second read gives the same failure: no state was mutated by failing.
  assert.equal(throwsWith(() => readEvents(), CorruptLogError).line, 3);
});

test('a torn final line fails closed rather than silently dropping the record', () => {
  freshDir('torn');
  appendEvents([EVENT(1), EVENT(2)]);
  const partial = JSON.stringify(EVENT(3)).slice(0, 40);
  writeFileSync(logPath(), readFileSync(logPath(), 'utf8') + partial, 'utf8'); // no newline

  const err = throwsWith(() => readEvents(), CorruptLogError);
  assert.match(err.message, /torn/);
  assert.ok(readFileSync(logPath(), 'utf8').endsWith(partial), 'the damaged log is left exactly as found');
});

test('a record that is not an object, or has no type, fails closed', () => {
  freshDir('shape');
  writeFileSync(logPath(), '"just a string"\n', 'utf8');
  assert.match(throwsWith(() => readEvents(), CorruptLogError).message, /not a JSON object/);

  writeFileSync(logPath(), '[1,2,3]\n', 'utf8');
  assert.match(throwsWith(() => readEvents(), CorruptLogError).message, /not a JSON object/);

  writeFileSync(logPath(), '{"at":"2026-08-09T12:00:00.000Z"}\n', 'utf8');
  assert.match(throwsWith(() => readEvents(), CorruptLogError).message, /no event type/);
});

test('a blank line inside the log fails closed', () => {
  freshDir('blank');
  appendEvents([EVENT(1)]);
  writeFileSync(logPath(), readFileSync(logPath(), 'utf8') + '\n' + JSON.stringify(EVENT(2)) + '\n', 'utf8');
  assert.match(throwsWith(() => readEvents(), CorruptLogError).message, /blank line/);
});

test('parseEventLog accepts an empty body and a clean log', () => {
  assert.deepEqual(parseEventLog(''), []);
  assert.equal(parseEventLog(`${JSON.stringify(EVENT(1))}\n${JSON.stringify(EVENT(2))}\n`).length, 2);
});

test('commitEvents refuses to write on top of a corrupt log', () => {
  freshDir('commit-corrupt');
  appendEvents([EVENT(1)]);
  writeFileSync(logPath(), readFileSync(logPath(), 'utf8') + 'garbage\n', 'utf8');
  const before = readFileSync(logPath(), 'utf8');

  throwsWith(() => commitEvents(() => ({ events: [EVENT(2)] })), CorruptLogError);
  assert.equal(readFileSync(logPath(), 'utf8'), before, 'nothing was appended to a damaged log');
  assert.equal(existsSync(lockPath()), false, 'and the lock was released');
});

// ---------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------

test('the lock is held for the duration of the callback and released after', () => {
  freshDir('lock-lifecycle');
  assert.equal(existsSync(lockPath()), false);
  const seen = withLock(() => existsSync(lockPath()));
  assert.equal(seen, true, 'the lock directory exists while the callback runs');
  assert.equal(existsSync(lockPath()), false, 'and is gone afterwards');
});

test('the lock is released even when the callback throws', () => {
  freshDir('lock-throw');
  assert.throws(() => withLock(() => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lockPath()), false);
});

test('a lock held by someone else fails closed on timeout', () => {
  freshDir('lock-timeout');
  mkdirSync(lockPath(), { recursive: true }); // stand in for a peer mid-commit

  const started = Date.now();
  const err = throwsWith(() => withLock(() => 'never runs', { timeoutMs: 120 }), LockTimeoutError);
  assert.equal(err.code, 'GAIA_LOCK_TIMEOUT');
  assert.match(err.message, /refusing to write unlocked/);
  assert.ok(Date.now() - started >= 100, 'it actually waited rather than failing instantly');
  assert.ok(existsSync(lockPath()), "the other process's lock is left untouched");
});

test('commitEvents fails closed under contention and writes nothing', () => {
  freshDir('commit-contention');
  appendEvents([EVENT(1)]);
  const before = readFileSync(logPath(), 'utf8');
  mkdirSync(lockPath(), { recursive: true });

  throwsWith(() => commitEvents(() => ({ events: [EVENT(2)] }), { timeoutMs: 80 }), LockTimeoutError);
  assert.equal(readFileSync(logPath(), 'utf8'), before, 'a lock timeout never produces a partial write');
});

test('an old-looking lock is REPORTED as possibly abandoned but never broken', () => {
  freshDir('lock-stale');
  mkdirSync(lockPath(), { recursive: true });

  // Age the lock well past the stale threshold.
  const longAgo = new Date(Date.now() - 3_600_000);
  utimesSync(lockPath(), longAgo, longAgo);

  const err = throwsWith(() => withLock(() => 'must not run', { timeoutMs: 80, staleMs: 1_000 }), LockTimeoutError);
  assert.match(err.message, /may have been abandoned/);
  assert.match(err.message, /NOT removed automatically/);

  // The discriminating assertion. An implementation that breaks stale locks would
  // have deleted this directory and run the callback — admitting a second writer in
  // the window between observing the age and deleting. Fail closed instead.
  assert.ok(existsSync(lockPath()), 'a lock this process does not own is never deleted');
});

test('a stale-looking lock released by its owner is acquired normally on the next attempt', () => {
  freshDir('lock-stale-release');
  mkdirSync(lockPath(), { recursive: true });
  const longAgo = new Date(Date.now() - 3_600_000);
  utimesSync(lockPath(), longAgo, longAgo);

  throwsWith(() => withLock(() => 1, { timeoutMs: 60, staleMs: 1_000 }), LockTimeoutError);

  rmSync(lockPath(), { recursive: true, force: true }); // the real owner releases
  assert.equal(withLock(() => 'acquired', { timeoutMs: 500, staleMs: 1_000 }), 'acquired');
  assert.equal(existsSync(lockPath()), false);
});

test('LOCK_TIMEOUT_MS is a finite positive default', () => {
  assert.ok(Number.isFinite(LOCK_TIMEOUT_MS) && LOCK_TIMEOUT_MS > 0);
});

// ---------------------------------------------------------------------------
// consistent reads
// ---------------------------------------------------------------------------

test('readEventsConsistent reads under the lock and matches the unlocked read', () => {
  freshDir('consistent');
  appendEvents([EVENT(1), EVENT(2)]);
  assert.deepEqual(readEventsConsistent(), readEvents());
  assert.equal(existsSync(lockPath()), false, 'the lock is released after reading');
});

test('readEventsConsistent fails closed while a peer holds the lock', () => {
  freshDir('consistent-contended');
  appendEvents([EVENT(1)]);
  mkdirSync(lockPath(), { recursive: true });

  // A user-facing read waits, then reports contention. It never reads a possibly
  // half-written log just to stay available.
  throwsWith(() => readEventsConsistent({ timeoutMs: 80 }), LockTimeoutError);
});

// ---------------------------------------------------------------------------
// commit protocol end to end
// ---------------------------------------------------------------------------

test('commitEvents sees every prior event before deciding', () => {
  freshDir('commit-sees-prior');
  appendEvents([EVENT(1), EVENT(2)]);

  const { priorCount, value } = commitEvents((existing) => {
    assert.equal(existing.length, 2, 'the decide callback is handed the full committed log');
    return { events: [EVENT(3)], value: existing.length };
  });
  assert.equal(priorCount, 2);
  assert.equal(value, 2);
  assert.equal(readEvents().length, 3);
});

test('sequential commits through the protocol never reuse an id', () => {
  freshDir('commit-ids');
  const minted = [];

  for (let i = 0; i < 25; i += 1) {
    commitEvents((existing) => {
      const state = replay(existing);
      const cmd = i === 0
        ? { type: 'register', at: `2026-08-09T12:00:00.${String(i).padStart(3, '0')}Z`, actorId: 'peer' }
        : { type: 'send', at: `2026-08-09T12:00:00.${String(i).padStart(3, '0')}Z`, from: 'act-0001', to: 'act-0001', text: `n${i}` };
      const out = commit(state, cmd);
      if (out.result?.messageId) minted.push(out.result.messageId);
      return { events: out.events };
    });
  }

  assert.equal(minted.length, 24);
  assert.equal(new Set(minted).size, 24, 'no id was reused');
  assert.deepEqual(
    minted.map((m) => Number(m.split('-')[1])),
    Array.from({ length: 24 }, (_, i) => i + 1),
    'ids are dense and monotonic',
  );
  assert.equal(
    JSON.stringify(snapshot(replay(readEvents()))),
    JSON.stringify(snapshot(replay(readEvents()))),
    'and the resulting log replays deterministically',
  );
});

test('an empty log replays to the empty state', () => {
  freshDir('empty-replay');
  assert.equal(JSON.stringify(replay(readEvents())), JSON.stringify(EMPTY_STATE));
});

// ---------------------------------------------------------------------------
// resetLog
// ---------------------------------------------------------------------------

test('resetLog refuses to delete a data directory while a lock exists', () => {
  const dir = freshDir('reset-locked');
  appendEvents([EVENT(1)]);
  mkdirSync(lockPath(), { recursive: true });

  const err = throwsWith(() => resetLog(), LockTimeoutError);
  assert.match(err.message, /single-process only/);
  assert.ok(existsSync(join(dir, 'events.jsonl')), 'the log another process may be committing to is untouched');
});

test('resetLog clears an unlocked directory', () => {
  const dir = freshDir('reset-clean');
  appendEvents([EVENT(1)]);
  resetLog();
  assert.equal(existsSync(dir), false);
  assert.deepEqual(readEvents(), [], 'and a missing log reads as empty, not as an error');
});

test('dataDir and logPath follow GAIA_INTERAGENT_DATA_DIR', () => {
  const dir = freshDir('paths');
  assert.equal(dataDir(), dir);
  assert.equal(logPath(), join(dir, 'events.jsonl'));
  assert.equal(lockPath(), join(dir, 'events.lock'));
});

// ---------------------------------------------------------------------------
// Windows lock-cleanup truth
// ---------------------------------------------------------------------------

test('release actually removes the lock directory and its owner marker, every cycle', () => {
  const dir = freshDir('lock-cleanup');
  // On Windows a directory rm can fail transiently (EBUSY/EPERM) if a handle is
  // still open. The owner marker is written *inside* the lock, so if that were the
  // case it would show up here as a leaked lock rather than as a passing test.
  for (let i = 0; i < 200; i += 1) {
    withLock(() => appendEvents([EVENT(1)]));
    assert.equal(existsSync(lockPath()), false, `lock released on cycle ${i}`);
    assert.equal(existsSync(join(lockPath(), 'owner.json')), false, `owner marker gone on cycle ${i}`);
  }
  assert.equal(readEvents().length, 200, 'and every cycle committed exactly one record');
  assert.equal(existsSync(dir), true);
});

test('a failed release is not swallowed — the caller learns the lock may be stuck', () => {
  freshDir('lock-release-failure');
  // Replace the lock with a file after acquiring it, so rmSync's recursive directory
  // removal hits a shape it did not create. Whatever the platform does, the contract
  // is that the error propagates rather than being hidden behind a successful return.
  let released = null;
  try {
    withLock(() => {
      rmSync(lockPath(), { recursive: true, force: true });
      writeFileSync(lockPath(), 'not a directory', 'utf8');
      return 'body ran';
    });
    released = 'no error';
  } catch (err) {
    released = err.name;
  }
  // Either the platform removed the file cleanly, or it threw. Both are acceptable;
  // silently reporting success while leaving a lock behind is not.
  const leftBehind = existsSync(lockPath());
  assert.ok(released === 'no error' ? !leftBehind : true, 'a clean return implies no lock was left behind');
});

test('the owner marker records the pid that holds the lock', () => {
  freshDir('lock-owner');
  const owner = withLock(() => JSON.parse(readFileSync(join(lockPath(), 'owner.json'), 'utf8')));
  assert.equal(owner.pid, process.pid);
  assert.match(owner.at, /^\d{4}-\d{2}-\d{2}T/);
});
