# Actionable PR review threads become bounded repair claims

Status: R0 design decision for Gaia issue #43. Written and committed before any test or
implementation, as the house convention requires.

## Operator problem

Gaia read PR #39 as mergeable because CI was green. A `COMMENTED` Codex review on that pull
request carried two P1 inline findings. A `COMMENTED` review does not activate GitHub's
changes-requested gate, so `reviewDecision` never moved, no blocker opened, and the findings sat
unread until an operator pointed at them.

The defect is not a missing poll. It is a **conflation**: the pump read *GitHub's review state* as
if it were *the severity of what the review said*. Those are two different facts about two
different things, and one of them was never measured at all.

## Decision

Severity is measured from the review thread's own inline comments and is published on its own
axis, next to — never derived from — the GitHub review state. A thread whose comments carry a P0
or P1 marker is actionable and blocks merge, whatever `state` the enclosing review carries; a
thread whose comments carry only P2/P3, or no marker at all, is not actionable, whatever
`CHANGES_REQUESTED` says.

One actionable thread becomes exactly one bounded repair claim. That claim reaches GitHub twice
and no more: one evidence comment, and one resolution of that exact thread.

The lifecycle is the one issue #43 names, in that order:

`received -> classified -> claimed -> repaired -> verified -> commented -> resolved`

with `refused` as the only other terminal.

## The two facts, kept apart

| Fact | Where it comes from | Vocabulary |
| --- | --- | --- |
| `reviewState` | GitHub, verbatim | `PENDING`, `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED` |
| `severity` | the thread's own comment bodies, classified here | `P0`, `P1`, `P2`, `P3`, `UNCLASSIFIED` |

`blocksMerge` is a function of `severity`, `isResolved` and `disputed`. It is **not** a function
of `reviewState`. An `APPROVED` review carrying a P0 thread blocks; a `CHANGES_REQUESTED` review
carrying only a P3 thread does not. Both readings are gates.

An absent marker is `UNCLASSIFIED` with a named reason, not `P3` and not `NONE`. Absent evidence
does not print as a low severity, because "nobody wrote a severity" and "somebody wrote that this
is minor" are different states of the world and only one of them is a measurement.

### The marker grammar, and why it is closed

Two forms are accepted, both line-anchored:

- a severity token opening a line and followed by a separator: `P1:`, `[P1] `, `**P0** —`;
- an explicit label line: `Severity: P1`.

Everything else is `UNCLASSIFIED`. In particular the bare substring `P1` inside prose ("this is
not a P1 concern") is deliberately not a marker: a loose classifier that reads prose would let a
sentence *about* severity open a blocker, and the whole point of this slice is that a blocker is
opened by evidence rather than by a word.

The thread's severity is the most severe marker across its comments. Comment **bodies never
become durable**: only the derived token and the comment ids reach the ledger, so untrusted review
prose cannot leak into a receipt, a projection or a published checklist.

## Identity, and what deduplication is atomic over

```
threadIdentity = sha256({
  schema, repository (lower-cased), pullRequestNumber, reviewThreadId, reviewedHeadOid
})
```

Four things, exactly the four issue #43 names. Deliberately **not** in the identity:

- the review id, and the comment ids — one `COMMENTED` review with two inline comments in one
  thread is one finding and must be one claim, not two;
- the run id, the lane generation, the clock and the author — a re-run, a restart or a second
  supervisor must land on the same identity, or the deduplication is decorative;
- the *current* head — see below.

The **reviewed** head SHA is in the identity, and that is load-bearing in both directions. A
redelivered webhook for the same thread at the same reviewed head is one claim. A genuine
re-review of the same thread against a *new* head is a *new* claim, which is correct: the second
finding has to be proven against the head it was made on, and a repair verified against the old
head must not silently discharge it.

Deduplication is atomic because the ledger's compare-and-swap append of the **first** transition
for an identity is the linearization point, and every record carries its author's closed ownership
token. Two supervisors that read the same durable head produce two different records rather than
one replay; the loser is a lost update, fails closed, performs no effect and writes nothing at all.
A process-local mutex or promise cannot carry this, because the two supervisors are two operating-
system processes and the only thing they share is the file.

## Applicability: does the finding still apply to the current head?

A claim is opened, and a resolution performed, only from `APPLIES`. The verdict is derived from
facts GitHub and git already publish; nothing is inferred from silence.

| Condition | Verdict |
| --- | --- |
| `currentHeadOid === reviewedHeadOid` and the thread is not outdated | `APPLIES` |
| GitHub reports the thread outdated | `STALE` |
| head moved, and the anchor blob digest at the current head equals the digest at review | `APPLIES` |
| head moved, and the two anchor digests differ | `STALE` |
| either anchor digest is `UNKNOWN` | `UNKNOWN` |

`STALE` and `UNKNOWN` both refuse. An unmeasured anchor is not an applicable finding; it is an
unanswered question, and a pump that treats an unanswered question as a yes is the same defect as
the one being repaired, pointing the other way.

Applicability is re-derived at resolve time from a fresh observation. It is never read back out of
the ledger, because the whole failure mode is a world that moved after the claim was written.

## What must be true before each of the two effects

**Before the comment.** A durable leased claim held by this owner, an `APPLIES` applicability, a
repair head that (a) descends from the reviewed head, (b) touches the thread's anchored path, and
(c) whose addressed comment ids **cover** every actionable comment id in the thread, and required
checks that all report `SUCCESS` **at exactly that repair head**.

A check run at any other head is not evidence about this one. Coverage is a superset test, not a
count: addressing one of two P1 comments in a thread is a partial repair, and a partial repair may
never resolve.

**Before the resolution.** Everything above, re-derived, plus a durable `COMMENTED` transition, so
the operator's evidence is on the pull request *before* the thread that would have shown it is
closed. A resolution that precedes its evidence deletes the reason it happened.

The four refusals issue #43 names are each their own token and each their own gate:
`FINDING_STALE`, `THREAD_DISPUTED`, `REPAIR_UNVERIFIED`, `PARTIALLY_ADDRESSED`.

## Failure modes, and what each one does

| Failure | Behaviour |
| --- | --- |
| Two supervisors read the same ledger head | one wins the CAS; the loser is `RepairRaceLost`, no effect, no record |
| A supervisor holds an unexpired lease | a second is `RepairInFlight`, fails closed, does not race it |
| A supervisor is killed holding a claim | its lease runs out; the claim becomes an orphan and is reconciled against GitHub, never wedged and never re-driven blind |
| The comment request is sent and its response is lost | reconciliation finds the comment by the identity marker embedded in its body and adopts it; nothing is posted twice |
| The resolve request is sent and its response is lost | reconciliation reads `isResolved` and adopts it |
| Two comments carry the identity marker | `ReconciliationAmbiguous`; fails closed rather than guessing which one is ours |
| A webhook or SSE event is missed entirely | the later polled observation mints the identical identity, so the missed delivery produces one lane, one comment and one resolution — not a second set |
| The head moves between claim and resolve | applicability is re-derived, becomes `STALE`, and the resolution is refused |
| A human resolved the thread first | reconciliation records `RESOLVED` from what is there; no effect is performed |
| Required contexts are unknown, or a required context is absent from the reported conclusions | `REPAIR_UNVERIFIED`; a missing check is not a passing check |
| A transition arrives out of order | refused; the lifecycle is monotonic, and `VERIFIED` without `REPAIRED` is a corrupt claim |

## Rejected simpler alternatives

1. **Gate on `reviewDecision` / `CHANGES_REQUESTED`.** This is the PR #39 defect stated as a
   design. A `COMMENTED` review never moves it.
2. **Deduplicate on the inline comment id.** One review with two comments in one thread would open
   two lanes, two checklists and two resolutions of one finding.
3. **Deduplicate on repository + PR + thread, without the reviewed head.** A re-review of the same
   thread against a new head could then never open a re-proven claim, and a repair verified against
   a head from last week would look sufficient forever.
4. **Extend `FACTORY_TELEMETRY_MACHINE` with the seven new transitions.** Adding a state changes
   that machine's `rulesRevision`, which makes every receipt already on disk unreadable. This slice
   owns a separate ledger with its own machine, exactly as the first-evidence delivery does, and
   the two pre-existing `rulesRevision` values stay pinned by literal.
5. **Resolve at repair time and let CI catch a regression.** Resolution destroys the operator's
   only durable view of the finding, and CI at repair time says nothing about the repair head.
6. **A process-local mutex, promise or in-memory claim set.** Two supervisors are two processes.
7. **A new bus verb, a webhook receiver or a socket.** Reconciliation over a polled observation
   already repairs a missed delivery, and it does it without a listener, a port or a seventh verb.
8. **Two comments — an early progress checklist and a later evidence comment.** Two effects, two
   grants and two ways to double-post, to publish the same three facts. R0 posts one comment,
   which carries origin, the checklist, the current step and the ETA together with the commit and
   test evidence, at the point issue #43 puts `commented`: after `verified`, before `resolved`.

## The evidence-based ETA

The published ETA is derived from this ledger's own completed lanes — the observed durations from
`CLAIMED` to `RESOLVED`. Below a declared minimum sample it publishes `UNKNOWN` with the reason
`INSUFFICIENT_HISTORY` rather than a number. A fabricated ETA is worse than no ETA, because an
operator plans against it.

## Authority

The effect port is injected and closed, and has exactly three methods: one read, one comment, one
resolution. There is no method here that could merge, approve, dismiss a review, promote a draft,
push a branch or close a pull request, so a resolved thread cannot become an approval by accident.

Each effect consumes its own single-use grant through the existing authority adapter, unchanged.
Commenting and resolving are separately privileged: a grant for one cannot perform the other.

Gaia preserves exactly `register`, `send`, `inbox`, `ack`, `heartbeat` and `handoff`. No bus verb
is added or widened. No credential, configuration, network authority, schema, clock, retry or
transport protocol is widened by this slice.

## Observability

Every accepted and refused transition is appended to one append-only JSONL ledger under the
directory-scoped lock protocol the telemetry log and the drain ledger already run, and is replayed
into a deterministic flat projection: one row per transition, sorted by identity then ordinal.

That projection is the DuckDB path. DuckDB itself is **not** added as a dependency and this slice
has no analytical-store call site at all, which is a stronger property than a degradation path
around one: the projection is newline-delimited JSON that DuckDB reads directly, and its
unavailability cannot stop the pump because the pump never speaks to it. Persisting the seven
transitions inside the existing telemetry machine would have required widening that machine's
rules; that is the widening this slice declines.

## Required evidence

RED tests, committed first, must force: severity classified independently of every review state in
both directions; the closed marker grammar including its negative case; each applicability verdict;
each of the four resolution refusals; the ordering of the lifecycle; compare-and-swap; a lost
update; a live lease; an orphaned claim; a lost comment response; a lost resolve response; an
ambiguous reconciliation; a missed delivery reconciled to one lane; deterministic replay; the
closed three-method port; and the absence of any merge, approval or push verb in the source.

At least one interleaving runs across two real operating-system processes held at a barrier until
both have read the same durable ledger head, because a single-process barrier cannot reach the
read-read-write-write ordering that duplicates an effect.

Mechanism-revert controls must fail when the compare-and-swap, the marker-based reconciliation, the
applicability gate or the coverage check is removed. Each control writes its mutant to disk,
imports it, runs it and asserts a behavioural divergence; reading the source as a string cannot
discharge a control.

Focused and full tests run twice, followed by `npm run verify`, exact source-scope inspection and
a clean tree.

## Rollback

Disable the composition. The ledger is append-only and its receipts remain valid observations;
rollback deletes and rewrites nothing. Comments already posted and threads already resolved stay
as they are — they were each gated on verified evidence at the time they happened.

## Decision receipt

- **Effect delta:** two, both on one review thread: one comment, one resolution. Both single-use
  authorized, both idempotency-keyed, both reconcilable.
- **Authority delta:** none. The existing grant adapter is used unchanged; no scope is widened.
- **Bus delta:** none. Six verbs, unchanged.
- **Dependency delta:** none.
- **Falsifier:** a `COMMENTED` P1 thread that does not block merge; two lanes, two comments or two
  resolutions for one thread under any interleaving; a resolution of a stale, disputed, unverified
  or partially addressed thread; a review body reaching a durable record.
