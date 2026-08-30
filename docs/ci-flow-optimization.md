# CI flow optimization R0 — design decision and contract

Status: design decision plus the shipped contract. This document grants no authority, starts no
lane, opens no network connection, edits no workflow file and approves nothing. It records what
was decided before implementation, which seams were rejected and why, and the falsifiers the
tests attempt.

## Operator problem

`docs/engineering-flow-throughput.md` gave the control room its first honest answer to *did the
engineering queue move*. It counts issues, pull requests, commits, factory runs and evidence
reviews over closed windows, and prints `UNKNOWN` wherever the window was not observed.

It deliberately says nothing about the machine that stands between a commit and a merge. The
operator's next question is therefore still unanswered:

> The queue is moving. What is CI doing to the time it takes, and which single change would
> shorten it?

Today that question is answered by memory and by watching a spinner. The portfolio adapter
reports `checks: 'UNKNOWN'` for every pull request (`src/github-read-adapter.mjs`), which is the
truthful reading of evidence it never collected — it carries no run identity, no attempt, no
queue time, no job decomposition and no conclusion. There is nothing in this product that can
distinguish *CI is slow because runners are never available* from *CI is slow because one job
serialises behind another* from *CI is slow because we run the same work four times per push*.

Those three have different fixes. Guessing between them is how a team spends a week on caching
and finds the queue was the whole cost.

### Affected actor and consumer

The operator reading `gaia-control-room.html` and deciding what to change about CI this week. The
consumer of the new evidence is `buildControlRoomSnapshot`, which already refuses evidence it
cannot verify and must keep refusing at exactly that standard.

### Success criteria

1. For a repository whose closed CI runs have been observed, the control room states the current
   gate, the slowest check, the critical path, how old the evidence is, and comparable p50/p95
   durations — and reads a named non-measured state, never `0`, wherever the evidence does not
   support the cell.
2. Every published number is re-derivable from evidence carried in the same artifact, so a
   reader can check the arithmetic without trusting the producer.
3. An optimization candidate appears only when the evidence that would support it is present,
   names that evidence, and carries no patch, no command and no authority.
4. A lever can be compared against a pinned baseline with a regression guard fixed *before* the
   comparison is read, producing `KEEP` or `REVERT` — and one observation can never be counted
   into two comparisons.
5. Ingesting the same closed run twice, or in a different order, or from two collectors racing,
   yields a byte-identical projection.

## What this does not do, as a construction rather than a promise

- **It never edits workflow configuration.** Not behind a flag, not with confirmation. There is
  no code path in this slice that writes a `.github/workflows` file, and the advisory artifact has
  no field that could carry a patch — a candidate carries a `lever`, a `rationale` and the
  `evidence` identifiers that support it, and nothing else. A producer cannot smuggle a diff
  through, because the field list, not a review habit, is what admits a field.
- **It never mutates GitHub.** No re-run, no cancel, no dispatch, no comment. This slice contains
  no writer at all; it consumes observations someone else already read.
- **It admits only closed observations.** There is no `IN_PROGRESS` conclusion in the vocabulary
  and no nullable completion instant, so a running job is unsayable rather than counted as fast.
- **It adds no scheduler, no provider runner, no bus verb, no database authority and no
  WebSocket.** The six bus verbs in `src/bus-core.mjs` are untouched. Nothing here polls, ticks,
  or holds a socket; every function is a pure derivation over evidence handed to it.
- **It does not conflate green CI with feature readiness.** The published block carries
  `readiness: 'NOT_CLAIMED'` as a field, so a consumer reads the disclaimer rather than inferring
  readiness from a green conclusion. A passing pipeline proves the checks that exist passed on
  the SHA they ran against. It proves nothing about whether the feature works.
- **DuckDB is not introduced as a dependency.** See the projection section below — the constraint
  "DuckDB unavailability cannot stop the pump" is satisfied by construction, because the pump
  never calls DuckDB.

## Design It Twice — where the CI flow evidence seam goes

### Seam 1 — derive CI flow from the portfolio snapshot's `checks` field

`src/github-read-adapter.mjs` already builds a per-pull-request record with a `checks` slot, and
the operator already runs `portfolio:survey`. Filling that slot in looks like the cheapest path.

**Rejected, and it is the most dangerous of the three.** The slot is a point-in-time rollup of a
pull request's *current* check state. It has no run identity and no attempt number, so the same
pull request re-checked four times is indistinguishable from one checked once — retries and
duplicate work, two of the four levers this section exists to see, are structurally invisible. It
has no timestamps at all, so any duration attributed to it would be manufactured from the
snapshot's own clock. And it is keyed by pull request, so a run triggered by a push to the
default branch — usually the *slowest* and most expensive class of run — is not represented at
all. It would answer the operator's question with a confident number derived from evidence that
cannot contain the answer.

### Seam 2 — extend `gaia-engineering-flow/1` with a `CI_RUN` family

The flow artifact is already sealed, ordered, content-addressed, verified and rendered. Adding a
sixth family costs one entry in three lists.

**Rejected.** Two reasons, and the second is the disqualifying one.

The mechanical reason: that schema has exactly nine per-event fields and one instant pair
(`startedAt`, `occurredAt`). A CI run is not one duration; it is a decomposition — queued, then
runner startup, then setup, then execution — across an attempt axis, over a set of checks with an
ordering between them. Representing that would mean widening `ENGINEERING_FLOW_EVENT_FIELDS`
substantially. The closed field list is precisely the mechanism that makes that artifact safe
(`docs/engineering-flow-throughput.md`, MR1); widening it to fit a different shape is spending
the safety property to save a file.

The disqualifying reason: `deriveQueue` would then count CI runs as engineering queue inflow and
outflow. A pipeline that ran 200 times in a day would read as 200 units of queue movement. That
is the exact conflation — activity read as delivery — that this product has already removed
twice. Keeping CI in its own artifact is what makes it *impossible* to sum a CI run into a
throughput net, rather than merely discouraged.

### Seam 3 — a separate closed artifact, joined at the control room seam (chosen)

`gaia-ci-flow/1` is its own sealed, content-addressed artifact with its own closed vocabulary,
its own journal and its own derivation, joined to `buildControlRoomSnapshot` at exactly the seam
`engineeringFlow` uses: an optional input, projected through a verifier that refuses rather than
repairs, published as an optional block, and re-derived by the render seam so a snapshot whose
published block does not match its own carried evidence is refused.

Chosen because it is additive at one integration point, because the two artifacts cannot
contaminate each other's arithmetic, and because a second provider — Buildkite, GitLab CI — is
an entry in one closed provider list rather than a rewrite. The cost is a second artifact the
operator must supply; that cost is accepted, and it is the same cost the flow artifact already
carries.

## Provider neutrality, concretely

`CI_FLOW_PROVIDERS` is a closed list whose only member today is `GITHUB_ACTIONS`. Nothing else in
the module branches on it. Every field name in the observation vocabulary is stated in
provider-neutral terms — `runId`, `attempt`, `checkId`, `queuedMs`, `runnerStartupMs` — and the
mapping from a provider's wire format into this vocabulary is the *collector's* job, which is
separate work with its own authority question. That is what "provider-neutral" buys and all it
buys: this module cannot be made to depend on a GitHub response shape, because it never sees one.

## The measurement states, and why `0` is not among them

Every quantity in this contract is either measured or carries a named reason it is not. The
closed reason vocabulary is:

| State | Means |
| --- | --- |
| `MEASURED` | The upstream evidence supports this number. `0` here is a real zero. |
| `NOT_EXPOSED` | The provider does not report this quantity for this observation. Waiting will not help. |
| `INSUFFICIENT_HISTORY` | Fewer comparable samples than the published minimum. More observations will help. |
| `STALE` | Evidence exists but is older than the freshness window; the reading is about the past. |
| `CORRUPT` | Evidence exists and is internally incoherent. It is refused, never repaired. |
| `UNKNOWN` | None of the above applies and no measurement can be justified. |

These are distinct because their operator actions are distinct. `NOT_EXPOSED` means stop asking.
`INSUFFICIENT_HISTORY` means collect more. `STALE` means re-collect. `CORRUPT` means fix the
producer. Collapsing any of them into `0` would report the most reassuring available reading —
"queue latency: 0ms" — for evidence nobody has.

`CORRUPT` is deliberately not a display state for a whole artifact: an artifact that fails
verification is *refused*, exactly as an incoherent flow artifact is. `CORRUPT` marks a single
quantity within an otherwise coherent observation whose own internal evidence contradicts itself
in a bounded, non-fatal way.

## Identity, idempotency and the race

The immutable identity of a closed observation is the tuple

```
(provider, repository, runId, attempt)
```

`runId` and `attempt` are the provider's own immutable identifiers for a run and its re-run
attempt; neither is ever reassigned. This is the whole idempotency key.

Three properties follow, and each is a gate:

1. **Byte-identical redelivery is absorbed.** Appending the same record twice — webhook
   redelivery, two overlapping polls, two collectors — changes nothing about the projection.
2. **A conflicting record under the same key is refused, never merged.** If two records share an
   identity but differ in content, one of them is wrong, and picking a winner (last-write, or
   field-wise merge) would silently publish a fabricated run. The journal keeps both, because it
   is append-only and cannot do otherwise; the projection refuses the identity and names it.
3. **Order of arrival is irrelevant.** The projection sorts by a total ordering key before it
   derives anything, so attempt 2 arriving before attempt 1, or a later run before an earlier
   one, produces the same bytes.

`attempt` being part of the key is what makes retries countable without double-counting: attempt
1 and attempt 2 of the same run are two observations with two durations, and the retry count is
`max(attempt) - 1` over a run, not the number of records held.

## The evidence journal and the projection

**The journal** is append-only JSONL. One line per sealed observation, written with an append and
never rewritten in place. It is the durable evidence boundary, exactly as
`docs/factory-telemetry-spine.md` established for the telemetry spine. Replaying it reproduces
the projection exactly; that is a gate, not an aspiration.

**The projection** is a pure, deterministic function from the journal's records to a flat,
typed, column-ordered relation. It is analytical read state only: nothing in this product reads
the projection to make a decision, hold a state, or grant an authority. It exists to be read.

**On DuckDB.** The constraint is that DuckDB is analytical read state only and that its
unavailability cannot stop the pump. R0 satisfies both by construction rather than by a
degradation path: **DuckDB is not a dependency of this repository and this slice does not add
one.** The pump — seal, append, project — never calls DuckDB, so there is no code path along
which DuckDB being absent, broken, or mid-upgrade can affect it. What the projection provides is
a *DuckDB-readable* shape: newline-delimited flat rows with no nested objects, no
implementation-dependent key order and no floating-point arithmetic, which `read_ndjson` ingests
directly. An analyst bench may point DuckDB at the file without this product knowing, which is
the same interface discipline the flow artifact chose.

A degradation path with a try/catch around a DuckDB import would be *weaker*: it would be a
promise, testable only by simulating a failure. Having no call site is not a promise.

Determinism is enforced against the five things that actually break it: ordinal string
comparison rather than `localeCompare` (host- and ICU-dependent); explicit key order in the
projected row rather than object insertion order; integer milliseconds throughout with no
floating-point division retained in output; instants stored as exact ISO strings with no
locale or timezone rendering; and a canonical JSON recipe with sorted keys for every digest.

## What is measured, and only when the evidence supports it

| Quantity | Measured when | Otherwise |
| --- | --- | --- |
| Queue latency | The observation carries both an enqueue instant and a start instant. | `NOT_EXPOSED` |
| Runner startup | The observation carries a runner-acquired instant between enqueue and start. | `NOT_EXPOSED` |
| Setup duration | A phase decomposition is carried and names a setup phase. | `NOT_EXPOSED` |
| Execution duration | Start and completion instants are both carried and coherent. | refused if incoherent |
| Critical path | A dependency edge set is carried for the observation's checks. | `NOT_EXPOSED` |
| Retries | Always derivable from `attempt`. | — |
| Cancellations | Always derivable from `conclusion`. | — |
| Conclusion | Always carried; it is what makes the observation closed. | — |
| Consumed runner minutes | The observation carries a billable-minutes figure from the provider. | `NOT_EXPOSED` |
| p50 / p95 | At least `CI_FLOW_MIN_SAMPLE` comparable closed observations exist. | `INSUFFICIENT_HISTORY` |

Two of these deserve their reasoning written down, because both have an available shortcut that
would look right.

**Consumed runner minutes are never derived from wall-clock duration.** A provider bills by
rounding each job up to the minute and multiplying by an OS-dependent rate; a 12-second job on a
Windows runner and a 12-second job on a Linux runner cost different amounts, and neither costs
0.2 minutes. Computing minutes from duration would produce a number that is always wrong and
always plausible. If the provider did not report billable minutes, this cell reads `NOT_EXPOSED`.

**The critical path is not the slowest check.** The critical path is the longest chain through the
dependency graph; the slowest check is a vertex. They coincide only when the graph is a single
chain. This contract publishes them as two separate cells — `slowestCheck` is always derivable
and `criticalPath` requires a carried edge set — precisely so that the easy number is never
allowed to wear the important number's name. Making the slowest check the critical path is the
mechanism this design exists to forbid; MR3 below reverts it to prove the gate bites.

## Binding, proven only

`repository`, `workflow`, `runId`, `attempt`, `checkId`, `sha`, `branch` and `pullRequest` are
carried on the observation. All but `pullRequest` are required. `pullRequest` is nullable, and
`null` means **not proven**, published as a named binding state rather than as an absence.

This matters because the provider legitimately omits it: a run triggered by a push, and a run for
a pull request from a fork, both arrive with no pull-request association even though a human can
see which pull request they belong to. Inferring the binding from the branch name would be a
guess, and a guessed binding is how a comparison ends up attributing a run to the wrong lever.
The block reads `PR_NOT_PROVEN` and the operator supplies the binding or does without it.

## Advisory optimization candidates

Four levers are in the closed vocabulary, chosen because each has a distinct evidence
precondition that the observations can actually satisfy:

| Lever | Emitted only when |
| --- | --- |
| `CANCEL_SUPERSEDED_RUNS` | Two or more closed runs exist for the same branch with overlapping intervals, so a later push did not cancel an earlier run. |
| `SAFE_JOB_PARALLELISM` | A carried dependency edge set contains checks with no path between them that nonetheless ran sequentially. |
| `DEDUPLICATE_WORK` | Two or more checks in one run share an identical work digest. |
| `INTRODUCE_CACHING` | Setup duration is `MEASURED` and is a published fraction of execution duration or more. |

A candidate is advisory: it carries `effect: 'NONE'`, `authority: 'NONE'`, the lever, the
evidence identifiers that support it, and no patch. Absence of a candidate is never an assertion
that the lever would not help — only that the evidence to support it is not present.

## Comparison against a pinned baseline

A comparison names one lever, pins a baseline by artifact revision, fixes a regression guard, and
then reads observations into a candidate arm. It answers `KEEP` or `REVERT` — or `UNKNOWN` with a
reason, which is the common case early.

Three rules make it honest:

- **The guard is fixed before the reading.** It is part of the pinned comparison and enters its
  digest, so a guard loosened after seeing the result changes the revision and is visible.
- **One lever at a time.** A comparison names exactly one lever. Two levers moved together
  produce a result that cannot attribute the change, which is a result that cannot be acted on.
- **One observation cannot close two comparisons.** Each comparison holds the set of observation
  identities it consumed. An identity already claimed by another comparison is refused. Without
  this, the same fast week could be spent twice to justify two unrelated changes.

A `REVERT` is the operator's instruction to themselves. Nothing in this slice performs it.

## The gates

| Gate | Falsifier attempted |
| --- | --- |
| C1 | The observation field lists are closed; an unknown top-level or per-check field is refused, never ignored. |
| C2 | An open/in-progress observation cannot be expressed; no conclusion admits it. |
| C3 | The seal is deterministic and independent of caller key order; the digest recipe is exported and single. |
| C4 | Byte-identical redelivery of the same `(provider, repository, runId, attempt)` changes no projected byte. |
| C5 | A conflicting record under one identity is refused and named; it is never merged or last-write-wins. |
| C6 | Reordered arrival — attempt 2 before attempt 1 — yields a byte-identical projection. |
| C7 | Retries are `max(attempt) - 1`, and duration and minutes are not double-counted across attempts. |
| C8 | A cancelled, skipped or timed-out run does not contribute a duration to p50/p95. |
| C9 | A missing pull-request binding reads `PR_NOT_PROVEN`, never an inferred binding. |
| C10 | A future instant, a start after a completion, or a stale observation is refused or named — never clamped. |
| C11 | A partial observation missing runner or phase evidence reads `NOT_EXPOSED`, never `0`. |
| C12 | Fewer than `CI_FLOW_MIN_SAMPLE` comparable durations reads `INSUFFICIENT_HISTORY`, never a percentile. |
| C13 | Consumed runner minutes are never derived from wall-clock duration. |
| C14 | `criticalPath` requires a carried edge set; the slowest check alone never populates it. |
| C15 | An advisory candidate names its supporting evidence and carries no patch field. |
| C16 | A comparison refuses an observation identity already claimed by another comparison. |
| C17 | The regression guard is inside the comparison digest; loosening it changes the revision. |
| C18 | Deterministic replay: replaying the journal reproduces the projection byte-for-byte. |
| C19 | Two concurrent appenders produce a projection identical to the serial one. |
| C20 | The control room refuses a snapshot whose published CI block does not match its own carried evidence. |
| C21 | The published block carries `readiness: 'NOT_CLAIMED'`; green CI is never published as feature readiness. |
| MR1 | Mechanism revert: admitting an `IN_PROGRESS` conclusion is what would let a running job be counted as fast. |
| MR2 | Mechanism revert: making an unmeasured quantity `0` instead of a named state is what would print a reassuring reading for absent evidence. |
| MR3 | Mechanism revert: letting the slowest check populate `criticalPath` is what would rename a vertex as a path. |
| MR4 | Mechanism revert: dropping the claimed-identity set is what would let one observation close two comparisons. |

## What R0 does not claim

R0 does not claim to *produce* observations from any live source. It defines and consumes the
seam; a collector that calls a provider is separate work with its own authority question, and
this slice deliberately ships without one so that no credential, no network call and no rate
limit enters with it.

It does not claim that a complete observation set is an accurate one — completeness is the
producer's assertion, verified for internal coherence and refused when incoherent, and no
verifier here can prove a run the producer never wrote down.

It does not claim a cause. A candidate is a hypothesis with named supporting evidence, and the
comparison is the only thing in this slice that can promote a hypothesis to a result — for one
lever, against one pinned baseline, with a guard fixed in advance.

It does not claim that CI being green means anything is ready to ship.
