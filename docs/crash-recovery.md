# Crash recovery and fail-closed behaviour

Everything here fails closed. The log is never truncated, repaired, or reset by any
code path a user can reach. This document is what to do when that stops you.

## The commit protocol

1. **acquire** — `mkdir(events.lock)`. Atomic: exactly one caller succeeds.
2. **re-read** — read and validate the whole log *inside* the lock.
3. **replay** — rebuild state, so counters reflect every peer's committed events.
4. **decide** — derive new events from that fresh state.
5. **commit** — one `appendFileSync` of complete newline-terminated lines, then
   `fsync`.
6. **release** — `rmSync(events.lock)` with a Windows retry budget.

Steps 2–4 are what make ids unique across processes. Step 5 is what keeps the file
one record per line.

## Windows specifics

**Contended `mkdir` reports `EPERM`/`EACCES` as well as `EEXIST`.** All three mean
"someone else holds it, retry". Treating `EPERM` as fatal aborted 2 of 16 workers in
the measurements this design comes from. A genuine permission problem still surfaces —
as a lock timeout carrying that errno.

**Release carries a retry budget.** `rmSync` on a directory this process owns can fail
transiently with `EBUSY`/`EPERM`/`ENOTEMPTY` when an antivirus scanner, the indexer, or
a just-closed handle still holds it. Without retries the release throws out of the
`finally`, the lock survives its owner, and every peer then fails closed on a lock
whose owner has already finished — a wedged bus with no automatic recovery.

Defaults: 12 retries, 25 ms apart (`GAIA_INTERAGENT_LOCK_RELEASE_RETRIES`,
`GAIA_INTERAGENT_LOCK_RELEASE_RETRY_DELAY_MS`).

**This does not weaken ownership.** There is exactly one `rmSync` of the lock in the
whole module, in the acquiring call's own `finally`, on the lock it just created. The
retry budget changes *when the owner gives up releasing*. It cannot make any code path
remove a lock it does not own, because no such code path exists. A test asserts both
facts statically.

## Symptom: exit code 3

`3` means **fail-closed I/O: nothing was written**. It is never a bad address.

```
node scripts/gaia-interagent.mjs doctor
```

`doctor` distinguishes the two causes.

### Cause A — a stuck lock

`doctor` reports `lockBusyOnEntry: true` and the command times out.

A lock that looks abandoned is **reported, never broken**. Auto-breaking is a TOCTOU
by construction: between observing the age and deleting it, the owner may release and
a third process may acquire a fresh one — and then you have deleted a live lock and
admitted two writers. Ownership re-checks narrow that window; nothing closes it
without an atomic compare-and-delete the filesystem does not offer.

**Recovery, in order:**

1. Confirm no bus server is running. Every server is a `node .../src/mcp-server.mjs`
   process; check by command line, not by name.
2. If any are running, stop the *client* that owns them (the Claude or Codex session).
   Do not kill by wildcard.
3. Only when none are running, remove the lock directory by hand:
   `events.lock` inside your data directory.
4. Re-run `doctor`. It should report `replayable: true` and the event count.

The lock directory contains `owner.json` with the pid and timestamp of the holder.
That is **diagnostic only** — the lock is the directory's existence, not the marker.

### Cause B — a damaged log

`doctor` reports `replayable: false`, an error naming the failure class, and
`corruptLine`.

Five conditions are refused, each naming the line:

| Condition | Why refusing is right |
| --- | --- |
| Line is not valid JSON | Skipping it would silently drop a committed event. |
| Record is not a JSON object | Same. |
| Record has no `type` | Replay cannot apply it; guessing is worse than stopping. |
| Blank line in an append-only log | A file that only ever grows by whole records cannot legitimately contain one. Something else wrote to it. |
| File does not end in a newline | The last append was **torn**. Reading "as much as parses" silently drops the record that was mid-write. |

**Recovery for a torn tail** (the only case with a safe manual repair):

1. Take a copy of the log first. Everything below assumes you can go back.
2. Confirm the file does not end with `\n` and that the final line is a partial JSON
   record. That, and only that, is a torn tail.
3. Confirm no bus server is running and no `events.lock` exists.
4. Remove the trailing partial line **only**, leaving the preceding newline. Do not
   touch any complete line.
5. `doctor` again. `replayable: true` means the surviving prefix is intact.

The removed record was never acknowledged to any caller: the append had not completed,
so no client received a success for it. Losing it is correct.

**Recovery for a corrupt line in the middle** is not a repair, because a complete
committed record that no longer parses means something outside this product wrote to
the file. Do not edit it. Preserve the file as evidence, start a new data directory,
and investigate what else has write access to that path.

## What crash recovery does *not* require

- **No repair step on ordinary restart.** Replay *is* the restart path. A server
  rebuilds its entire state from the log at startup, so a killed process leaves
  nothing to clean up but its lock — and only if it died between acquire and release.
- **No compaction.** The log never compacts, which is why the cost note below matters.
- **No schema migration.** There is no schema versioning; a future format change is an
  unsolved problem, stated rather than hidden.

## Cost, stated accurately

Per-call replay is **O(events × actors)**, not O(events): `apply` calls `ageActors` on
every event, so every event touches every actor. That runs under one global lock, on a
log that never compacts.

No projection, snapshot, or cached tail offset is implemented in this product, and no
smaller bound is claimed anywhere. This is the largest scaling limitation and it is
why the supported lane default is 4.

## Codex startup timeout

`startup_timeout_sec` must never equal the bus lock timeout.

The server takes the log lock during startup replay. If a peer holds it, the server
waits up to `LOCK_TIMEOUT_MS` and then fails closed with exit 3 — correct behaviour.
With `startup_timeout_sec` set to the same number of seconds, Codex kills the server at
exactly that moment, and the operator sees an ambiguous startup failure instead of the
documented code.

The generator therefore emits `lockSeconds × 2 + 5`. Doubling covers the wait plus the
replay and fsync that follow it; the fixed 5 s covers Windows process spawn and
antivirus interception. At the 10 s default that is **25 s**. Tests assert the two
values are never equal, across lock timeouts from 1 ms to 120 s.

## Secrets

The reducer has no access to `process.env` and no filesystem access at all — a test
asserts both statically. Nothing this product writes into the log is a secret it
obtained on its own.

A secret a **user types into a message body** is stored verbatim, because silently
altering an append-only record is worse than storing what you were given. Bodies
containing authority language are flagged (`authority-language-detected`) so an
operator can triage them. The flag is a hint, not a filter; safety comes from the bus
having no privileged verb.
