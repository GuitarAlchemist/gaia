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
- **It admits only closed observations.** There is no in-progress conclusion in the vocabulary
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
shape is the one `deriveCycleTime` and `deriveQueue` already use — `{ state, reasonCode, value }`
with `state` in `MEASURED | UNKNOWN` — rather than a second parallel enum, so this page and the
flow page cannot come to mean different things by "measured". Two hard rules:

```
state === 'UNKNOWN'  =>  value === null
state === 'MEASURED' =>  reasonCode === null
```

The closed reason vocabulary, and what an operator should do about each:

| Reason | Means | Operator action |
| --- | --- | --- |
| `NOT_EXPOSED` | The provider structurally does not report this quantity here. | Stop asking. |
| `INSUFFICIENT_HISTORY` | Fewer comparable samples than `CI_FLOW_MIN_SAMPLE`. | Collect more. |
| `STALE` | Evidence exists but is older than the freshness window. | Re-collect. |
| `CORRUPT` | Carried evidence contradicts itself in a bounded way. | Fix the producer. |
| `NOT_APPLICABLE` | The conclusion means the quantity does not exist at all. | Nothing; this is correct. |
| `ATTEMPT_QUEUE_BASIS_NOT_EXPOSED` | A re-run carries only the original run's enqueue instant. | Collect an attempt-scoped basis. |
| `ATTEMPT_HISTORY_NOT_COLLECTED` | Attempt *n* is held with no observation of attempts 1..*n*-1. | Collect the earlier attempts. |
| `NO_PROVEN_DEPENDENCY_GRAPH` | No dependency edge set was carried for this run. | Supply the graph. |
| `BILLING_NOT_EXPOSED` | No provider-reported billable figure for this exact run and attempt. | Collect the timing evidence. |
| `OBSERVATION_INCOMPLETE` | The producer marked this observation as a partial read. | Re-collect the window. |

These are distinct because their operator actions are distinct. Collapsing any of them into `0`
would report the most reassuring available reading — "queue latency: 0ms" — for evidence nobody
has. `NOT_APPLICABLE` earns its own entry because a `SKIPPED` check has no duration at all: zero
would be a lie of type, not merely a lie of degree.

`CORRUPT` is deliberately not a display state for a whole artifact: an artifact that fails
verification is *refused*, exactly as an incoherent flow artifact is. `CORRUPT` marks a single
quantity within an otherwise coherent observation whose own internal evidence contradicts itself
in a bounded, non-fatal way — a check claiming more setup than its own span, or a dependency chain
summing to more than the run it lies inside — which withholds that one quantity while the span
itself stays `MEASURED`.

## Identity, idempotency and the race

The immutable identity of a closed observation is the tuple

```
(provider, repositoryId, runId, attempt)
```

Each of the four is an identifier the provider never reassigns. `repositoryId` rather than
`owner/name` deliberately: repositories are renamed and transferred, and keying on the name would
split one run series in two at the rename — silently halving every rate and resetting any pinned
baseline mid-comparison. The human-readable `repository` is carried as a **label** that
participates in no key and no join, so renaming it changes no derived number.

This is the whole idempotency key.

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
`attemptCount - 1` over a run, not the number of records held.

**Admissibility is checked before de-duplication, and that ordering is a gate.** A run whose
status is terminal may still contain a check that has not finalised; reading it in that instant
produces a truncated duration. Because the first write under an identity is final — that is what
de-duplication *means* — a bad first read would be cemented, and the very mechanism that protects
against redelivery would protect the wrong bytes. An observation is therefore admissible only if
its own conclusion is terminal **and every check it carries is terminal**, checked at seal time,
before the identity is ever consulted.

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
| Queue latency | An **attempt-scoped** enqueue instant and a start instant are both carried. | `ATTEMPT_QUEUE_BASIS_NOT_EXPOSED` / `NOT_EXPOSED` |
| Runner startup | A runner-acquired instant is carried between enqueue and start. | `NOT_EXPOSED` |
| Setup duration | A phase decomposition is carried and **each check's** setup fits inside **that check's own** span. | `NOT_EXPOSED` / `CORRUPT` |
| Execution duration | Start and completion instants are both carried and coherent. | `CORRUPT` |
| Critical path | A dependency edge set is carried, and the longest chain through it fits inside the run's span. | `NO_PROVEN_DEPENDENCY_GRAPH` / `CORRUPT` |
| Retries | Every attempt from 1 to the highest held has been observed. | `ATTEMPT_HISTORY_NOT_COLLECTED` |
| Cancellations | Always derivable from `conclusion`. | — |
| Conclusion | Always carried; it is what makes the observation closed. | — |
| Consumed runner time | A provider-reported billable figure exists for **every** observation held, whatever its conclusion, and none of them is a partial read. | `BILLING_NOT_EXPOSED` / `OBSERVATION_INCOMPLETE` |
| p50 / p95 | At least `CI_FLOW_MIN_SAMPLE` **comparable** closed observations exist. | `INSUFFICIENT_HISTORY` |
| Gate, phases, slowest check, critical path | The most recently closed run is fresh **and** the producer marked it a complete read. | `NO_OBSERVATIONS` / `STALE` / `OBSERVATION_INCOMPLETE` |

Six of these have an available shortcut that would look right and be wrong, so the reasoning is
written down rather than left to review.

**Queue latency is computed only within one attempt.** A provider re-running a workflow keeps the
*original* run creation instant and moves only the attempt's start instant. Subtracting one from
the other on attempt 3 yields the wall-clock gap since attempt 1 — potentially days — and
publishes it as queue latency. That number is large, plausible, and points the operator at runner
scarcity when the real cause was a human clicking re-run on Monday. The observation therefore
carries an explicit `enqueueBasis` of `ATTEMPT` or `RUN_CREATION`, and a `RUN_CREATION` basis on
an attempt above 1 reads `ATTEMPT_QUEUE_BASIS_NOT_EXPOSED`. This is the highest-value refusal in
the contract: the shortcut is invisible in review because the arithmetic is correct.

**Retries are `attemptCount - 1`, and three durations are named separately.** Holding attempt 3
proves nothing about attempts 1 and 2 — a collector reading only the latest attempt sees a healthy
workflow that in fact fails twice per run. So `retries` is `MEASURED` only when the full attempt
chain is held. And the run carries three quantities that must never substitute for one another:
`terminalDurationMs` (the attempt that reached a terminal conclusion), `totalConsumedMs` (summed
over every observed attempt), and `attemptCount`. Summing durations across attempts and calling
it "how long CI takes" inflates the answer by the retry rate.

**The comparable set is exactly `SUCCESS` and `FAILURE`, named rather than filtered.** This is the
false-win generator and it deserves the most care. A `CANCELLED` run has a real but truncated
duration; a `SKIPPED` check never ran and has no duration at all; a `TIMED_OUT` run's duration is
the timeout ceiling, which is a censored observation, not a measurement of the work. Admitting any
of them into a duration distribution means a lever that *increases cancellation* — turning on
concurrency-group cancel-in-progress, say — appears to halve CI duration, because it adds a
population of twenty-second runs to the median. The comparison would then report a large
improvement for a change that made nothing faster. `CI_FLOW_COMPARABLE_CONCLUSIONS` is therefore a
named closed set, not a predicate, so widening it is a visible edit to a constant; MR5 reverts it.
A `SKIPPED` check's duration is `NOT_APPLICABLE`, never `0`.

**Consumed runner time is never derived from wall-clock duration.** A provider bills by rounding
each job up to the whole minute and multiplying by an OS-dependent rate, and parallel jobs bill
concurrently — so twenty ten-second jobs bill twenty minutes against two hundred seconds of wall
clock, and a five-minute run with eight parallel macOS jobs bills over an hour. Computing cost
from duration would produce a number that is always wrong, always plausible, and biased toward
whichever direction makes the report look good. There is no OS multiplier table in this source,
and a gate asserts its absence. Wall-clock span and provider-reported billable time are published
under two distinct names and are never summed, reconciled, or asserted equal.

**The bill is summed over every conclusion, and the comparable set does not govern it.** The
reasoning above for `CI_FLOW_COMPARABLE_CONCLUSIONS` is about *durations*: a cancelled run's is
truncated, a timed-out run's is a censored ceiling. None of it transfers to a sum of
provider-reported billable minutes, where a cancelled run's billing is complete and already
final — the runner ran and the account was charged. Restricting the sum to `SUCCESS` and `FAILURE`
would mean `CANCEL_SUPERSEDED_RUNS`, whose entire effect is to create more cancellations, appeared
to *reduce* measured cost by removing runs from the sum while real spend rose. That is the same
false-win generator MR5 guards on the duration axis, arrived at from the other direction, and
MR10 reverts it. The cost sample is therefore the whole window: `sampleSize` equals
`observationCount`, so nothing can leave the sum unannounced, and one figure the provider has not
reported withholds the cell by name rather than shrinking it quietly.

**A decomposition is read against what it decomposes, never against one wall clock.** Two cells
carry a decomposition of a run, and both have a shortcut that inflates by the fan-out factor. The
setup cell sums each check's setup; the critical path sums the spans along a dependency chain.
Comparing either sum against the run's single wall-clock span makes the numerator a sum and the
denominator a maximum, which is wrong in both directions at once. Reading it as a *ratio* raises
`INTRODUCE_CACHING` on four one-minute jobs that each spend ten seconds on setup — a true share of
one sixth, published as two thirds — and sends a team to spend a week on caching. Reading it as a
*bound* calls a perfectly coherent producer `CORRUPT`, whose operator action is "fix the producer",
and silently removes the caching lever from exactly the heavily parallel workflows where caching is
most likely to pay. So each check's setup is bounded by that check's own span, the caching share is
evaluated per check and names the check that earns it, and the same argument the contract already
makes for cost — *parallel jobs bill concurrently, so a duration converted against one wall clock
is always wrong and always plausible* — is applied here rather than stated one section earlier and
forgotten. MR9 reverts it.

**A dependency chain may not outlast the run it lies inside.** An edge set is verified as a DAG
over the carried checks and nothing more: no rule requires an edge to imply temporal order, so two
checks that in fact ran at the same time can be chained and both spans summed, publishing a
ten-minute critical path for a five-minute run. This is not an adversarial shape. The collector
that will eventually supply edges reads them from the workflow definition while the timings come
from the provider's API, and those two sources routinely disagree — reporting granularity,
reusable-workflow nesting, matrix legs. A path longer than its run is therefore the existing
bounded contradiction, `CORRUPT`, with the run's span left `MEASURED` exactly as the setup cell
already does it. MR8 reverts it.

**The critical path is not the slowest check.** The critical path is the longest chain through the
dependency graph; the slowest check is a vertex. They coincide only when the graph is a single
chain — so a five-minute job running fully in parallel can be the slowest check while contributing
nothing to the path, and shortening it saves exactly zero. This advisory failure survives review
precisely because "the longest job" sounds like the answer. This contract publishes them as two
separate cells — `slowestCheck` is always derivable and `criticalPath` requires a carried edge set
— so the easy number is never allowed to wear the important number's name. MR3 reverts it.

**An incomplete observation is journalled but contributes to no aggregate, and speaks in no
present tense.** A truncated job list, an absent phase array, an absent runner field and a
not-yet-ready timing response are four different partial reads, and each contributes its named
reason to the affected cell and nothing at all to any total. The count of contributors plus the
count of withheld observations equals the count held, so no observation silently vanishes from a
denominator.

This binds the present-tense cells specifically, because they are all derived from one
observation — the most recently closed run — which is the single observation a collector is most
likely to have caught mid-finalisation. When the producer marks that observation a partial read,
the gate, the four phases, the slowest check and the critical path all read
`OBSERVATION_INCOMPLETE`. Publishing them as `MEASURED` would have the block contradict itself in
its own fields: `withheldCount` records that same observation as withheld from the distribution as
untrustworthy, while every cell on the card is read off it. `OBSERVATION_INCOMPLETE` is a reason a
derivation actually reaches, not a vocabulary entry with no emitter; MR7 reverts the guard.

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
| `INTRODUCE_CACHING` | A check's own setup is a published fraction of **that check's own span** or more; the evidence names the run and the check inside it. |

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
Unit gates `K1..Kn` live in `tests/ci-flow.test.mjs`, journal gates in
`tests/ci-flow-journal.test.mjs`, optimization gates in `tests/ci-flow-optimization.test.mjs`, and
control-room integration gates `C1..Cn` plus the mechanism reverts in
`tests/control-room-ci-flow.test.mjs`.

| Gate | Falsifier attempted |
| --- | --- |
| K1 | The closed vocabularies are exactly the published providers, conclusions, reasons, levers and field lists. |
| K2 | The field lists are closed; an unknown top-level, per-observation or per-check field is refused, never ignored. |
| K3 | An open or in-progress observation cannot be expressed; no conclusion admits it. |
| K4 | A terminal run carrying a non-terminal check is refused at seal, before any identity is consulted. |
| K5 | The seal is deterministic and independent of caller key order; the digest recipe is exported and single. |
| K6 | Ordering is by the identity key, not arrival; the verifier enforces the order the sealer produces. |
| K7 | Every measurement cell obeys `UNKNOWN => value === null` and `MEASURED => reasonCode === null`. |
| K8 | Queue latency on an attempt above 1 with a `RUN_CREATION` basis reads `ATTEMPT_QUEUE_BASIS_NOT_EXPOSED`. |
| K9 | Retries read `ATTEMPT_HISTORY_NOT_COLLECTED` when the attempt chain is incomplete, never `0`. |
| K10 | `terminalDurationMs`, `totalConsumedMs` and `attemptCount` are three separate quantities. |
| K11 | Cancelled, skipped and timed-out runs contribute no duration to p50/p95; a skipped check reads `NOT_APPLICABLE`. |
| K12 | A missing pull-request binding reads `PR_NOT_PROVEN`; no code path derives a binding from the branch. |
| K13 | A future instant, or a start after a completion, is refused or named — never clamped, and no `Math.max(0, …)` guards a duration. |
| K14 | A check claiming more setup than its own span withholds the split as `CORRUPT` while the span stays `MEASURED`; checks that ran at the same time may sum past the wall clock without contradicting it. |
| K15 | A partial observation missing runner or phase evidence reads `NOT_EXPOSED`, never `0`; a gate observation the producer marked incomplete withholds every present-tense cell as `OBSERVATION_INCOMPLETE`. |
| K16 | Fewer than `CI_FLOW_MIN_SAMPLE` comparable durations reads `INSUFFICIENT_HISTORY`, never a percentile. |
| K17 | No OS multiplier table exists in the source; billable time and wall-clock span are never reconciled; every billed conclusion is in the sum, so cancelling more runs cannot make measured cost fall. |
| K18 | `criticalPath` requires a carried edge set; the slowest check alone never populates it, and both may coexist; a chain longer than its run reads `CORRUPT`. |
| K19 | A repository rename changes the label and no derived number, because identity carries `repositoryId`. |
| K20 | A genuine measured zero is still published as `MEASURED`, so the lattice is not "everything is unknown". |
| J1 | Byte-identical redelivery of one identity changes no projected byte and reports the duplicate. |
| J2 | A conflicting record under one identity is refused and named; never merged, never last-write-wins. |
| J3 | Reordered arrival — attempt 2 before attempt 1 — yields a byte-identical projection. |
| J4 | Two concurrent appenders produce a projection identical to the serial one. |
| J5 | Deterministic replay reproduces a checked-in golden projection digest byte-for-byte. |
| J6 | The projection is identical under a hostile `TZ` and `LANG`; it holds no clock and reads nothing. |
| J7 | The projected relation is flat, column-ordered, integer-valued and newline-delimited. |
| O1 | An advisory candidate names its supporting evidence and carries no patch field. |
| O2 | Each lever is emitted only when its own evidence precondition holds, and withheld otherwise; the caching share is per check, so jobs that ran at the same time neither inflate it nor suppress it. |
| O3 | A comparison names exactly one lever. |
| O4 | A comparison refuses an observation identity already claimed by another comparison; claim sets are pairwise disjoint. |
| O5 | The regression guard is inside the comparison digest; loosening it changes the revision. |
| O6 | A comparison below the minimum sample answers `UNKNOWN` with a reason, never `KEEP`. |
| C1 | The control room publishes the block only when the artifact is supplied, and omits the key otherwise. |
| C2 | The control room refuses a snapshot whose published CI block does not match its own carried evidence. |
| C3 | Both language phrasebooks are complete for every new key. |
| C4 | No stylesheet residue remains when the artifact is absent. |
| C5 | Colour is never the meaning; every state carries a `data-` attribute and a text label. |
| C6 | The published block carries `readiness: 'NOT_CLAIMED'`. |
| C7 | Flipping every conclusion changes the CI block and leaves every other published block byte-identical. |
| MR1 | Mechanism revert: admitting an in-progress conclusion is what would let a running job be counted as fast. |
| MR2 | Mechanism revert: making an unmeasured quantity `0` instead of a named state is what would print a reassuring reading for absent evidence. |
| MR3 | Mechanism revert: letting the slowest check populate `criticalPath` is what would rename a vertex as a path. |
| MR4 | Mechanism revert: dropping the claimed-identity set is what would let one observation close two comparisons. |
| MR5 | Mechanism revert: widening the comparable conclusion set to admit `CANCELLED` is what would turn a cancellation lever into a false win. |
| MR6 | Mechanism revert: allowing a `RUN_CREATION` enqueue basis on a re-run is what would publish days of human latency as queue latency. |
| MR7 | Mechanism revert: dropping the completeness guard on the gate observation is what would publish a partial read as the current state of the pipeline. |
| MR8 | Mechanism revert: dropping the span bound on the dependency chain is what would publish a critical path outlasting the run it lies inside. |
| MR9 | Mechanism revert: reading the setup share against one wall clock is what would fire `INTRODUCE_CACHING` on parallel jobs whose evidence does not support it. |
| MR10 | Mechanism revert: excluding cancelled runs from the bill is what would make a cancellation lever look cheaper while real spend rose. |

## Reversibility

**Class: freely reversible.** No persistent store is created that another actor already depends
on, no migration, no bus verb, no privileged effect, no new dependency, and no change to any
existing schema or digest recipe. The three new modules are pure derivations; the control-room
change is one conditional key that is *omitted* rather than published as `null`, so every
previously published snapshot revision is unchanged. Deleting the four new files and reverting one
integration point restores the entry state exactly.

## Falsifiers

The design is wrong if any of these turns out to be true:

- A number this contract publishes as `MEASURED` cannot be re-derived from the evidence carried
  alongside it. Then the artifact is a claim, not evidence, and gate C2 is the check that fails.
- A cancellation-increasing lever produces a `KEEP` verdict. Then the comparable set leaked and
  MR5 did not bite.
- A cancellation-increasing lever makes `consumedRunner` fall while the provider's invoice rises.
  Then the bill is being read through the comparable set again and MR10 did not bite.
- Two comparisons report effects supported by the same run. Then claim exclusivity leaked and MR4
  did not bite.
- A projection digest differs between two hosts reading the same journal. Then determinism is a
  promise rather than a construction, and J5/J6 did not cover the source of drift.
- An operator reads the CI block as a statement about whether a feature is ready. Then `readiness:
  'NOT_CLAIMED'` is insufficient and the separation must become structural rather than published.

## Rejection criterion

This slice should be rejected if it acquires a code path that writes workflow configuration,
mutates GitHub, opens a socket, adds a dependency, adds a seventh bus verb, or lets a CI run
contribute to any block that speaks about delivery. Each of those is checked by a gate rather than
by review: `npm run verify`'s forbidden-transport scan covers the socket, `tests/product.test.mjs`
covers the verb surface, and C7 covers the delivery separation.

## Decision Receipt

Decision: a sibling closed artifact `gaia-ci-flow/1` with its own journal and projection, joined
to the control room at the same optional-input seam `engineeringFlow` uses.

Alternatives rejected: filling the portfolio snapshot's `checks` slot (carries no run identity, no
attempt and no timestamps, so retries and duplicate work are structurally invisible); extending
`gaia-engineering-flow/1` with a CI family (would widen the closed field list that makes that
artifact safe, and would let CI runs be summed into engineering queue throughput).

Authority delta: none. `effect: NONE`, `authority: NONE`, six bus verbs unchanged, no network, no
new dependency, no new command, no workflow mutation.

Reversibility: freely reversible, as above.

This receipt selects an implementation candidate. It grants no runtime, publication, merge or
model-training authority, and it is not independent review.

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
