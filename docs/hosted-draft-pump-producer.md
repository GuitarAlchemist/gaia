# Hosted Draft pump producer R1

Status: repair design for issue #70, on top of `bc8239a4cd2f30669a82f26875503713cf6c8fd1`.
Base `cb318d222ebe94a25afda43fba9029e984a60540`.

This note closes exactly the two merge blockers the fresh independent Spec review reproduced
against `bc8239a`. It adds no mechanism and redesigns nothing that has landed.

## The two defects

**B1 — the observation seam has no producer.** `sealHostedDraftPumpObservation`
(`src/hosted-draft-pump-observation.mjs`) has zero non-test callers, and no shipped workflow,
script or module ever writes a `gaia-hosted-draft-pump/1` document. The hosted intake run emits a
*different* schema — `GaiaHostedDraftPumpCliReceiptV0` — and nothing converts it. So required
tracer item 7, *"make the latest verified pump transition visible in the Control Room"*, is
reachable only if a human hand-authors JSON and seals it with a correct content digest, which is
the exact labour issue #70 exists to remove.

**B2 — the schedule trigger has no proven path into the CLI.**
`.github/workflows/hosted-draft-intake.yml` binds `GAIA_ISSUE_NUMBER` to the labelled issue's
number. On a `schedule` event that expression interpolates to the empty string, and `envValue`
(`scripts/hosted-draft-pump.mjs`) returns a present-but-empty value, which `configuredText` then
rejects: the scheduled tick dies at argument parsing with `InvalidArguments`, before
`listUnsettledDrafts` is ever called. Worse than the bug: deleting that line from the workflow
entirely leaves the whole suite green, because no gate asserts what arguments the workflow actually
hands the CLI.

## B2 — empty is absent, for an environment and only for an environment

`envValue` returns `undefined` when the named key exists with the value `''`.

The rule is narrow on purpose, and it is a rule about *environments*, not about arguments. GitHub
Actions interpolates a null event field to the empty string, so on the `schedule` path
`GAIA_ISSUE_NUMBER` arrives present and empty; "present and empty" from an environment carries no
value, and the honest reading is *absent*. A flag is different: an explicitly typed empty flag
value is a caller who typed an argument and got it wrong, and that stays a terminal
`InvalidArguments`. So the change lives in `envValue` alone and `configuredText` is untouched.

Nothing that is required changes behaviour. `flagOrEnv` on an empty required value failed before
(`configuredText('')`) and fails after (`configuredText(undefined)`) — the same exit 2, by a
different line. Only optional reads move, and they move from "terminal refusal" to "absent", which
is what an unset variable already meant.

### The gate that was missing

`tests/hosted-draft-intake-cli-seam.test.mjs` reads `.github/workflows/hosted-draft-intake.yml`,
finds the intake step, and reconstructs — from the workflow text itself, never from a copy — the
exact environment and argv the runner would hand `scripts/hosted-draft-pump.mjs` on each of the two
reachable event paths:

- `schedule` — the issue-number expression resolves to the empty string;
- `issues: labeled` — the same expression resolves to the issue number.

It then drives the real `main()` with a stub runtime and asserts the CLI parses, that the schedule
path reaches the runtime as `trigger: SCHEDULE` carrying no issue, and that the labelled path
carries **exactly** that issue number. Because the argv is derived from the workflow, deleting the
issue-number binding, mis-spelling a flag, dropping a flag value, or renaming the script all fail
the gate rather than passing silently. Two in-file revert controls mutate the workflow text in
memory and assert the gate stops holding.

Runner-provided variables are modelled explicitly and separately from the step's own environment
block, because the run body already reads `GITHUB_REPOSITORY` without declaring it.

## B1 — the producer

### Shape: a pure function plus the process boundary that already exists

`src/hosted-draft-pump-producer.mjs` is a pure function. It holds no clock, opens no file, spawns
nothing, reaches no ledger and performs no effect; it imports the observation module and nothing
else. The process boundary is `scripts/hosted-draft-pump.mjs`, which already runs the intake and
already holds the repository identity, the ledger root, and the run identity. This mirrors
`src/local-lane-sensor.mjs` / `scripts/local-lane-sensor.mjs`, which is the house pattern for
"sealed observation from evidence someone else read".

```
produceHostedDraftPumpObservation({
  receipt,               // the intake receipt this run just produced
  repository, repositoryNodeId, ledgerRootOid, ledgerRootRevision,
  sequence,              // the Actions run id
  windowStartedAt, tickAt, observedAt,
  priorObservation,      // optional; the previously published reading
}) -> sealed gaia-hosted-draft-pump/1 document
```

Every instant and the sequence are **inputs**, never reads. That is what makes replay deterministic:
the same receipt with the same identity produces the same bytes and therefore the same `revision`.

### Design it twice

**Alternative A — a second `observe` command that reads the receipt file back.** Rejected. A
separate step cannot know when the transition happened; its own clock would have to stand in for
the tick instant, which fabricates a transition age — the single number this section exists to
publish honestly.

**Alternative B — the producer reaches the ledger itself.** Rejected. It would be a second reader
of the durable ledger with its own view, and a read model that publishes `authority: 'NONE'` must
not acquire one. The ledger's answer for this run is already in the receipt.

**Alternative C — the intake command seals the observation in the same process, from the receipt it
just produced, using instants it captured — selected.** One run, one transition, one reading. The
producer stays pure and separately testable; the CLI stays the only thing with a clock.

### What each published field is derived from

`transition.observedSourceRevision` is the sha-256 over the canonical JSON of the **exact receipt
document this observation was derived from**. It is source provenance: an operator holding the
uploaded receipt can recompute it and prove the two artifacts describe the same run. It is defined
identically on every phase — including `EXPECTED_NONE`, where no envelope exists at all — so the
field means one thing rather than two.

The receipt gains two fields it already knows and did not publish, both required by the observation
body and neither derivable afterwards:

- `workItem` — the issue the transition is bound to. For `RESUME` it is the unsettled record's own
  selector; for `ADMIT` it is the canonical selector just enqueued. Without it, requirement 7's
  *"operation/issue/PR binding"* would publish nothing on every scheduled recovery.
- `unsettledCount` — operations known unsettled **at the end of this run**, not at its start. A
  `RESUME` that reconciled its record to a terminal outcome leaves zero, and publishing the
  starting count would read a completed recovery as a stuck queue.

### The transition map — closed, and refusing rather than guessing

| receipt phase | receipt result | outcome | effect | blocker |
|---|---|---|---|---|
| `EXPECTED_NONE` | `null` | `EXPECTED_NONE` | `NONE` | `NONE` |
| `RESUME` / `ADMIT` | `Terminal` · `CREATED` | `CREATED` | `CREATE_DRAFT` | `NONE` |
| `RESUME` / `ADMIT` | `Terminal` · `REUSED` | `REUSED` | `NONE` | `NONE` |
| `RESUME` / `ADMIT` | `Terminal` · `REFUSED` | `REFUSED` | `NONE` | from the refusal |
| `RESUME` / `ADMIT` | `Pending` | `PENDING` | `UNKNOWN` | `EFFECT_AMBIGUOUS` |
| anything else | | **typed refusal, no document** | | |

The refusal map is exact-equality and closed: `ProviderUnavailable` to `PROVIDER_UNAVAILABLE`,
`ProviderProtocolViolation` to `PROVIDER_PROTOCOL_VIOLATION`, `NoEffectCapacity` to
`NO_EFFECT_CAPACITY`. An unrecognised refusal string refuses the whole observation rather than
publishing `NONE`, because a blocker read as "no blocker" is the one direction this seam must never
fail.

**`Terminal` · `CANCELLED` refuses.** No shipped path calls `cancelDraft` — it has zero non-test
callers — so this outcome is unreachable in production today. It is refused rather than mapped
because the read model's `deriveState` fallthrough would publish it as `REPLAYED` / *healthy*
(review finding A1), and "a cancelled operation, healthy" is a false reading. Refusing at the
producer closes A1's only reachable consequence **without touching the read model**, which the
repair brief puts out of scope.

**`StaleRevision` refuses.** It is a compare-and-swap loser: this run performed no effect and does
not know what the pump did. Publishing anything would be a guess, and the winner's own run publishes
the truth. Refusing is `no effect + typed refusal`, which is the contract.

**Skips are read only where they are the whole story.** On `RESUME` / `ADMIT` the transition
describes the operation that actually moved and an incidental skip is not part of it. On
`EXPECTED_NONE` the skips *are* the run: a `StaleRevision` skip is the ordinary result of probing
forward past settled work keys and stays benign, a `CrossGenerationIntent` skip publishes blocker
`CROSS_GENERATION_INTENT` (so the reading is `BLOCKED`, not a reassuring healthy `EXPECTED_NONE`),
and any other skip reason refuses. An unexplained empty admission must not read as a healthy empty
queue — that is issue #70's motivating defect restated.

### Refusal codes

`HostedDraftPumpProducerError` carries `InvalidHostedDraftPumpReceipt` (malformed, mismatched
repository, or an unknown token) and `UnobservableHostedDraftPumpReceipt` (a well-formed receipt
that is not a verified terminal or reconciled outcome). Coherence and monotonicity refusals come
from the observation module unchanged, as `IncoherentHostedDraftPump`.

### Concurrency and idempotence

The producer introduces no lock, no time-based uniqueness, no retry and no second effect executor.
It is downstream of the durable ledger CAS, which remains the sole linearization point. Replaying
the same run — same receipt, same identity, same instants — produces byte-identical output, and
re-ingesting that output against itself as the prior observation passes, because `requireMonotonic`
refuses only a strictly backwards reading. A duplicate or reordered producer output is refused at
the snapshot seam by the already-shipped `priorHostedDraftPumpOf` carrier.

`sequence` is the Actions run id. Run ids increase with queue time, and the intake workflow's
repository-wide non-cancelling concurrency group executes the queue in order, so the sequence is
monotonic in practice. Where it is not, `requireMonotonic` refuses the reading rather than
publishing a reordered one — fail closed, never a fabricated advance.

### What carries monotonic evidence, and what cannot

Only two fields on this observation carry order: `observedAt`, the instant the ledger was read, and
`sequence`, the Actions run id. Those are the whole of the monotonic evidence, and `requireMonotonic`
compares them and nothing else.

`committedRevision` is a SHA-256 content address. A content address is an opaque identity: it is
derived from the bytes of a record, not from when that record was written, so two committed
revisions have no temporal relation to each other at all. Comparing two such digests with `<` or `>`
orders them lexicographically, and lexicographic order over a hash is indistinguishable from a coin
flip — a legitimate forward append whose new digest happens to sort lower than the previous one
would be refused, while a genuinely stale replay whose digest happens to sort higher would pass. A
guard that is right half the time on random input is not a guard; it manufactures
`IncoherentHostedDraftPump` refusals against real forward progress, which is a release blocker
because a refused observation ages into `STALE` and re-creates issue #70's motivating defect from
the opposite direction.

Being append-only under compare-and-swap does not confer order on the digests either. CAS gives the
ledger a linearization *of records*; it says a record's stored prior pointer must match what the
writer read. That chain is walked by following `committedRevision` links, never by sorting them.

`committedRevision` may therefore be validated for shape (a 64-character lowercase SHA-256, or
`null`), compared for equality (to recognise the same record, or a replay of it), and checked for
binding (that it belongs to the work key and operation identity carried alongside it). It must never
be ordered relatively. Where a real backwards-ledger guard is wanted, the evidence for it is the
prior-pointer chain the ledger already stores, not the digests' byte values; this observation does
not carry that chain and so does not attempt the check.

### Honest no-authority semantics

The document declares `effect: 'NONE'` and `authority: 'NONE'` in its body, and the derived block
publishes `binding: 'NONE'` and `readiness: 'NOT_CLAIMED'` as named cells. The producer adds no
liveness, no progress, no pace, no ETA, no forecast, no GitHub binding it did not read, and closes
no obstruction. It writes one file and returns.

## Wiring

`intake` gains `--observation-out` (env `GAIA_OBSERVATION_PATH`) and `--run-id` (env
`GITHUB_RUN_ID`). Both absent, the command behaves exactly as it does today. `--observation-out`
without `--run-id` is `InvalidArguments`: an observation cannot be sequenced without the run
identity that sequences it.

The CLI receipt gains a closed `observation` field when one was requested:
`{ state: 'PRODUCED', revision }` or `{ state: 'REFUSED', reason }`. A refusal does **not** fail the
run — the intake itself succeeded — and it is named in the receipt rather than swallowed. An absent
observation ages into `STALE` in the Control Room, which is the honest reading of "this run could
not say what the pump did".

The workflow adds the observation path to the intake step's environment and uploads it as
`gaia-hosted-draft-pump-observation`, with `if-no-files-found: warn` because a typed refusal is a
legitimate outcome already recorded in the receipt artifact, which keeps `error`.

## Deliberately not built

No change to `src/hosted-draft-pump-observation.mjs`, `src/control-room.mjs`,
`src/draft-operation-envelope.mjs`, `src/gh-git-data-adapter.mjs`,
`src/gh-draft-operation-provider.mjs`, `src/github-actions-draft-admission.mjs`,
`.github/workflows/hosted-draft-pump-effect.yml`, or `.github/gaia/pump-policy.json`. No new bus
verb, no new secret, no new repository variable, no new permission, no dispatch capability, no paid
API and no dependency. Review findings A1 (beyond the one reachable consequence closed above), A2,
A3 and A4 stay advisory and untouched. The Node 20 `mcp-client` EPIPE test is outside this diff and
is not touched.

## Acceptance evidence

1. RED at both public seams, committed before the implementation: the producer seam
   (`tests/hosted-draft-pump-producer.test.mjs`) and the workflow-to-CLI seam
   (`tests/hosted-draft-intake-cli-seam.test.mjs`).
2. GREEN with the minimum code, committed separately.
3. Mechanism-revert controls: removing the receipt-to-observation conversion, and removing
   empty-as-absent, each fail a named gate.
4. Focused runs twice, `node --test` twice, `npm run verify`, and the six bus verbs unchanged.
