# Hosted Draft intake R0

Status: design gate for issue #70. Base `cb318d222ebe94a25afda43fba9029e984a60540`.

The original repository-wide concurrency policy below was superseded by issue #84. Current
label-triggered runs are partitioned by issue number while scheduled recovery remains serialized;
see [Hosted parallel intake lanes R0](hosted-parallel-intake-lanes.md). The rest of this design,
including the durable CAS and authority boundary, remains current.

## Problem

PR #69 proved the sealed effect executor, but a human still enqueues and dispatches every Draft
operation. The pump therefore never advances on its own, and the Control Room cannot distinguish a
healthy empty queue from a pump that was never triggered.

This design adds the missing trigger and the missing read-only view. It adds no mechanism: the
canonical envelope, the Git Data ledger CAS, the Draft provider, and the GitHub Actions admission
seam already exist and are tested. `runHostedDraftPump` and `runHostedDraftSupervisor`
(`src/hosted-draft-pump.mjs`) are tested and wired to nothing. Issue #70 is mostly wiring.

## Design it twice

### Alternative A — extend the sealed effect workflow

Add `issues` and `schedule` to `.github/workflows/hosted-draft-pump-effect.yml`. Rejected, and not
merely by taste: `tests/hosted-draft-pump-workflow.test.mjs` asserts that the workflow declares
neither `schedule`, `push`, `pull_request`, `issues`, `repository_dispatch`, nor `workflow_call`,
and that its concurrency group is exactly the single `format('gaia-draft-{0}', inputs['work-key'])`
expression, occurring once. That input is empty for `issues` and `schedule`, so every such run would
collapse into one group `gaia-draft-` — and no work key is known before selection anyway. A
per-work-key group also cannot express requirement 2, repository-wide serialization.

### Alternative B — a trigger workflow that dispatches the effect workflow

Rejected. Dispatching requires `actions: write` on a workflow that would then hold both selection
and effect-granting authority, and it introduces a lost-dispatch window with no durable record.

### Alternative C — one separate intake workflow running the same CLI in-process — selected

One new hosted workflow selects, enqueues, and reconciles in the same run, under a repository-wide
non-cancelling concurrency group. Effect authority comes from the existing
`createGitHubActionsDraftAdmission` seam, which already accepts `expectedWorkflowPath` as a
parameter; only the pinned constant at `scripts/hosted-draft-pump.mjs:27` currently ties admission
to one workflow file. Unpinning that constant into a sealed per-command map is the whole unlock.
**No `actions: write`, no new repository variable, and no new secret are required.**

### R2 — the observation denominator, designed twice

Alternative C shipped its concurrency group split in R1: labeled intake now runs under
`gaia-draft-intake-issue-<N>` and scheduled recovery under `gaia-draft-intake-recovery`. Those are
different group strings and therefore independent queues, so a labeled lane and the recovery lane
overlap freely. That is the point of issue #84 — and it invalidated an assumption the receipt was
still built on.

**The defect.** `unsettledCount` was never read after the run acted. It was *projected*: the
unsettled list snapshotted before selection, plus or minus one for the operation this run itself
settled or admitted. Under the single repository-wide group that projection was exactly right,
because nothing else could write to the ledger while the run held the queue. With the groups split,
a concurrent labeled lane can durably enqueue work during the recovery lane's own run, and the
projection then corresponds to no ledger state that ever existed at publication time. The recovery
lane publishes phase `EXPECTED_NONE` with `unsettledCount: 0`; `deriveState` reads a zero
denominator and renders `EXPECTED_NONE`, whose severity is `healthy`, while durable truth is one
unsettled operation. Since R1 the recovery lane is the *only* lane given an observation path, so
nothing publishes the contradicting reading any more.

Three shipped normative statements already describe the count this repair implements — the receipt
comment at `src/hosted-draft-pump.mjs`, `docs/hosted-draft-pump-producer.md`'s "at the end of this
run, not at its start", and the receipt section below. The code delivered a before-picture. This is
a correction of the code to the contract, not a change of contract.

**Option (a) — a post-action authoritative recount.** Re-read the unsettled list after the run has
acted and publish what that read returned. This replaces arithmetic with a measurement, and it
closes both interleavings that reproduce the defect: the one where a concurrent lane enqueues while
this run works, and the one where this run's own enqueue loses the compare-and-set — in the second
case the winner's write is provably durable before this run's read, so the correction is not merely
likely but guaranteed. Its cost is one extra ledger read per run. Its honest limit is a residual
window: a lane that enqueues *after* this run's final read is still not reflected. That window
shrinks from the whole run — selection, admission, and a provider round trip — to the gap between
the last read and receipt emission, in which this run performs no effect. It does not reach zero,
because no observer can verify the absence of a write that happens after its last read.

**Option (b) — an explicit fail-closed scope rule.** Carry the provenance of the denominator on the
receipt — whether the run can vouch that its count is repository-global — and refuse to render
`healthy` from a count it cannot vouch for. Two objections, one of substance and one of size. Of
substance: after the group split no lane can ever vouch, so the rule would refuse `healthy` on every
reading, deleting issue #70's tracer item 7 — distinguishing a healthy empty queue from a pump that
never ticked — in the name of protecting it. A rule about a number cannot make the number
trustworthy; only reading it can. Of size: the flag would have to cross the receipt, the producer's
evidence fields, and the sealed observation body, touching three modules and the CLI, where (a)
touches one function. Note also that `deriveState` already fails closed on the denominator it is
given: `unsettledCount > 0` pre-empts `EXPECTED_NONE`, `ADVANCED` and `REPLAYED` alike. The rule is
not missing. Its input was wrong.

**Selected: (a), applied in (b)'s direction.** The post-action read is authoritative, and it is
combined with the published count in one direction only — it may raise the count, never lower it.
Concretely, the run publishes its projection plus the unsettled operations that appear in the
post-action read, were absent from the pre-action snapshot, and are not the operation this run
itself admitted. Those are exactly the durable writes of a concurrent lane.

Two properties follow, and both are asserted. First, the correction is monotone upward, so it can
only move a reading from `healthy` toward `UNSETTLED`/`warning` and never the reverse: a bug in the
delta cannot manufacture a false clear, which is the one direction this seam must never fail.
Second, with no concurrent lane the delta is empty and the published count is unchanged, so the
serial contract — a completed recovery reads as one fewer, an admission that did not settle reads as
one more — is preserved exactly rather than restated.

**What this does not claim.** The residual window above is real and is not closed by this repair. A
published reading is a past-tense fact about the last ledger state its run read; the seam's existing
freshness machinery, not the denominator, is what carries how old that fact is. What is fixed here
is narrower and worse than staleness: a run publishing a number contradicted by durable truth it
could have read and did not, while it was still executing.

## The intake workflow

`.github/workflows/hosted-draft-intake.yml`, new, structurally mirroring the effect workflow:

- `on: issues: types: [labeled]` and `on: schedule` with one bounded cron, four runs per day.
- `permissions: actions: read` and `contents: read`, nothing more.
- a composite non-cancelling concurrency group: per issue number for label triggers and one
  `gaia-draft-intake-recovery` group for scheduled recovery.

The job is gated by an `if:` that admits every non-`issues` event and, for `issues`, only the
`ready-for-agent` label. The gate is a filter, never authority. Steps mirror the effect workflow one
for one: require the dedicated pump identity (`vars.GAIA_PUMP_APP_ID`,
`secrets.GAIA_PUMP_APP_PRIVATE_KEY`, `vars.GAIA_PUMP_ACTOR_ID`, `vars.GAIA_REPOSITORY_NODE_ID`, all
already configured), mint the App installation token, check out with `persist-credentials: false`
and `ref: github.workflow_sha`, set up Node, run the CLI with stdout redirected to the receipt path
and stderr to the error path, and upload the receipt artifact with `if: always()`.

The issue number reaches the CLI only through an `env:` binding of `github.event.issue.number`, never
interpolated into a `run:` body. It is re-validated as a positive integer and then fully re-derived
from the API by `createHostedDraftCollector`. Nothing from the webhook payload becomes authority.

Label-triggered intake runs for distinct issues may overlap. Duplicate events for one issue share
one workflow group, while the existing ledger CAS remains the correctness mechanism and chooses the
one effect winner. Scheduled recovery stays repository-wide because it selects from the shared
unsettled set.

`GITHUB_TOKEN` is never referenced; every mutating call runs under the App installation token. The
`permissions:` block is a minimality declaration over an unused token, not the grant. Not required:
`actions: write`, `issues: write`, `pull-requests: write`, `id-token`.

## The `intake` command

One new command in `scripts/hosted-draft-pump.mjs`, added to `COMMANDS` and `COMMAND_FLAGS`
(`COMMON_FLAGS` plus `issue`, `repository-node-id`, `owner`, `gate`, `check`, `eta-minutes`,
`observation-out`, `run-id`, with `issue` optional). Control flow, composed entirely from existing
runtime methods:

```
1. unsettled = listUnsettledDrafts(ports)
2. if this is an issue-triggered run, retain only unsettled work for that explicit issue candidate
3. if the applicable unsettled set is non-empty:
       reconcile unsettled[0] at its committed revision
       emit receipt phase RESUME; stop, admitting no new work this run
4. candidates:
       issues-labeled run -> [ the event issue number ]
       scheduled run      -> open ready-for-agent issues, number ascending, capped at N = 5
5. for each candidate, at most N probes:
       enqueue; on a typed collector error or any non-Enqueued result, record a skip and continue
       reconcile the enqueued operation at its committed revision
       emit receipt phase ADMIT; stop
5. emit receipt phase EXPECTED_NONE
```

Step 3 is requirement 3 verbatim for scheduled recovery: exactly one unsettled operation is resumed,
and a resuming run admits nothing. An issue-triggered lane resumes only the operation for its own
issue, so unrelated recovery cannot steal the lane. Step 5 admits at most one candidate per run,
satisfying requirement 4. Both the
unsettled list and the candidate list are deterministically ordered; the chosen order is asserted in
tests and recorded in the receipt. Note that `listUnsettledDrafts` sorts by `workKey` while
`runHostedDraftSupervisor` re-sorts by `operationId` — two different deterministic orders over the
same list. Intake picks one and states it.

The action selector and the observation denominator are deliberately separate. An issue-triggered
run filters the records it may reconcile, but its receipt counts the full validated unsettled list,
not the filtered one. That count is the projection over the pre-action snapshot — adjusted for the
matching operation this run settled or the new operation it admitted — **raised by** the unsettled
operations a second, post-action read of the ledger returns that were absent from the pre-action
snapshot and were not admitted by this run. Those are the durable writes of a concurrent lane.

The two reads are both required, and the combination is deliberately one-directional. The
projection carries what this run did to its own operation, which a bare recount cannot attribute;
the post-action read carries what other lanes did, which no projection can see. Because the second
term is only ever added, the published count can be raised toward `UNSETTLED` and never lowered
toward `healthy` — the direction this seam must never fail in.

This does not make the count instantaneously true, and no mechanism available here would. A lane
that enqueues after this run's final read is not reflected; that residual window spans receipt
emission only, during which this run performs no effect, and it is the ordinary staleness of any
read model rather than a contradiction of durable truth the run had already observed. What it does
close is the case where a lane rendered the repository healthy while work it could have read was
durably unsettled. See *R2 — the observation denominator, designed twice* above.

The orchestration itself belongs in `src/hosted-draft-pump.mjs` as a third pure, dependency-injected
export, `runHostedDraftIntake`, alongside the existing two. The CLI calls it. Reconciliation reuses
the existing runtime method unchanged, including its refusal of a mismatched operation-to-work-key
binding before the provider, admission, or ledger is touched.

### Sealed per-command expected workflow path

`EFFECT_WORKFLOW_PATH` becomes a frozen per-command map from command name to admission workflow path:
`reconcile` to `.github/workflows/hosted-draft-pump-effect.yml`, `intake` to
`.github/workflows/hosted-draft-intake.yml`. It is selected by the parsed command at the single
existing construction site. It is **never** a CLI flag and **never** environment-derived — otherwise
a caller could mint effect authority by naming a workflow it controls. The admission adapter still
requires `GITHUB_WORKFLOW_REF` to begin with `<repository>/<path>@`, re-reads the run attempt from
GitHub, and requires `full_name`, `id`, `run_attempt`, `status === 'in_progress'`, `path`, and
`head_sha` to match before returning `AVAILABLE`. A run under one workflow can never claim the
other's authority.

### Candidate listing

One method, `listReadyIssues({ repository })`, added to the object returned by
`createGhDraftCollectorApi`, reusing that module's existing call, failure, and positive-integer
machinery over the open issues of the repository filtered by the `ready-for-agent` label. Three
non-negotiable details:

1. It is **not** added to `REQUIRED_METHODS`. Doing so would break every existing collector fake;
   extra methods on the port object are already tolerated.
2. Pull requests are filtered out. The issues endpoint returns PRs as issues; omitting the filter
   admits PR numbers as work items.
3. It is a hint list only. Every value is re-derived and re-authorized by `collect()`: open state,
   current `ready-for-agent` label, label-event actor holding `TRIAGE` or above, a unique evidence
   branch with exact `Gaia-Issue` and `Gaia-Ready-Receipt` trailers, and two stable read-backs.

### No new configuration

`.github/gaia/pump-policy.json` already carries `ledgerRegistryRootOid` and
`ledgerRegistryRootRevision`. The effect workflow takes these as human-supplied dispatch inputs;
intake has no inputs, so it defaults them from the file it checked out at `github.workflow_sha` (an
explicit flag still wins, leaving the sealed effect workflow's behaviour unchanged). Trust is not
reduced: the Git Data store re-verifies the root oid **and** its content revision against the live
registry ref and throws `LedgerRegistryMismatch` otherwise. A tampered policy file fails closed.

### The issue number, and why an empty environment value is absent

`GAIA_ISSUE_NUMBER` binds `github.event.issue.number`, which Actions interpolates to the **empty
string** on a `schedule` event. `envValue` therefore treats a present-and-empty environment value as
absent, so a scheduled tick reaches the CLI as a schedule instead of dying at argument parsing. The
rule is about environments only: an explicitly typed empty flag value stays a terminal
`InvalidArguments`. `tests/hosted-draft-intake-cli-seam.test.mjs` reconstructs the exact environment
and argv this workflow hands the CLI, from the workflow text itself, and drives both event paths
through the real `main()`.

### Receipt

One closed JSON document on stdout, uploaded as an artifact, emitted on every path including refusal:

```json
{
  "schema": "GaiaHostedDraftIntakeReceiptV0",
  "command": "intake",
  "trigger": "ISSUES_LABELED | SCHEDULE",
  "phase": "RESUME | ADMIT | EXPECTED_NONE",
  "operationId": "<sha256>|null",
  "workKey": "<sha256>|null",
  "committedRevision": "<sha256>|null",
  "workItem": { "kind": "ISSUE", "number": 70 },
  "unsettledCount": 0,
  "result": { "existing Terminal / Pending / StaleRevision / CrossGenerationIntent shape": "..." },
  "skipped": [{ "number": 51, "reason": "StaleRevision" }],
  "telemetry": [],
  "observation": { "state": "PRODUCED | REFUSED", "revision": "<sha256>", "reason": "<code>" }
}
```

`EXPECTED_NONE` and typed refusals are first-class phases, satisfying requirement 6. Error paths keep
the existing closed redaction: no provider or transport diagnostic escapes.

`workItem` is the issue the transition is bound to, and `unsettledCount` is what remained unsettled
**after** this run acted — publishing the starting count would read a completed recovery as a stuck
queue. Both are facts this run knows and nothing downstream can recover, and both are required by
the observation body. `observation` appears only when one was requested, and carries either the
sealed document's revision or the typed reason it was refused.

## Concurrency contract

**Identity.** The work key is the content hash of the schema tag, the immutable repository node id,
the closed work item, and the requested effect — keyed on the node id so renames and alias variants
converge. One issue yields one work key yields one Draft operation for the life of the repository.
The operation id is the content hash of the work key and the generation key. The work key is derived
at exactly two places today; this design adds no third derivation site.

**Durable authority.** The committed revision is the content hash of the canonical record body, and
each body carries its prior committed revision, forming a hash chain re-validated end to end on every
read together with legal-transition and epoch-monotonicity checks.

**Linearization.** The ref update on `refs/heads/gaia-ledger/draft-operations-v0/<workKey>` with
`force: false`, against a commit created with the expected head as its sole parent, after a head
re-read. It is a genuine compare-and-swap; a lost race reports `STALE` and is never retried in place.
Everything else is downstream of that one call.

**Stale loser performs no effect.** A lost CAS is converted to a `StaleRevision` result carrying the
current committed revision, without any provider call. Two intake processes reading `ENQUEUED` at
revision `R` both attempt `CLAIMED` with `expected = R`; exactly one lands, the other exits having
touched nothing. Epoch demotion is refused separately: a non-successor executor epoch cannot steal a
`CLAIMED` or `INTENT` operation.

**External uniqueness.** The operation marker embedded as an exact whole line in the Draft body,
matched by an exact-line count of exactly one. Reconciliation performs that lookup before any effect
on every pass and adopts a found PR as `REUSED`.

**Convergence.** Two triggers reading the same prior state converge because the only writer path is
the CAS and the only effect path is gated behind a successful chain of CAS steps.

## Never a duplicate Draft

The dangerous window is `EFFECT_STARTED` committed, create issued, response lost, process dies.

1. The next run reconciles the same operation and looks up the marker first.
2. PR present: adopted as `REUSED`. No second create.
3. PR absent: the run commits `EFFECT_AMBIGUOUS`, from which the only legal successor is `REUSED`.
   The state machine can never re-enter `createDraft`. "Never blind-retry an ambiguous effect" is
   enforced structurally, not by convention.
4. A crash after enqueue and before reconcile leaves an unsettled operation that step 2 resumes.
5. Restart with no in-memory state is safe: the in-process executor lock is an optimisation, and
   every guard is a CAS on durable state.

There is no re-enqueue path and no new-generation path, and this design adds neither.

### The weakened cross-workflow invariant — stated, not inherited

`src/github-actions-draft-admission.mjs` documents that GitHub's workflow-run representation does not
expose the concurrency group, so the exact group is a **structural invariant of the sealed workflow**.
With two admission-granting workflows at different group scopes — per-work-key for the effect
workflow, per-issue for labeled intake, and repository-wide for recovery — Actions alone does not
guarantee "at most one in-progress effect per work key". A manually dispatched effect run and an
intake run can both hold `AVAILABLE` for the same work key.

The system remains duplicate-free, but for a different reason, and that reason must be stated in its
own words rather than inherited from the sealed-workflow argument: **the ledger CAS, not Actions,
serializes the effect.** Worst case, one run wins the `EFFECT_STARTED` CAS and creates the PR while
the other commits `EFFECT_AMBIGUOUS`; the winner's adoption then loses its CAS and reports `Pending`;
the next run finds the marker and adopts `REUSED`. Extra churn, one durable PR.

Mitigation: `hosted-draft-pump-effect.yml` becomes manual break-glass only, with intake recorded as
the normal path. This is a documentation and operational change; the effect workflow file and its
tests are not touched.

## Starvation: why the schedule must admit, and why probing is mandatory

Two facts make a recovery-only schedule and a lowest-numbered selector both wrong.

**Pending duplicate runs coalesce.** With `cancel-in-progress: false`, Actions bounds pending runs
inside one issue group. Independent issue labels no longer coalesce with each other. The schedule is
still the recovery path for work whose label event predated this policy or whose run never reached
durable enqueue, so it remains an **admission** path, not merely a recovery path.

**A refusal is terminal for a work key forever.** `enqueueDraft` returns `StaleRevision` for any work
key that already carries a record when the expected committed revision is `NONE`. Verified live at
base: of the three open `ready-for-agent` issues, #51 is terminal `CREATED` and #52 is terminal
`REFUSED` with refusal `ProviderUnavailable`. A naive lowest-numbered selector picks #51, receives
`StaleRevision`, and admits nothing forever — starving #70 itself.

Candidate selection therefore **probes forward** past settled work keys, recording each skip with its
typed reason in the receipt, up to a bounded `N = 5` probes per run. Probing is preferred over a
`readHead(workKey)` pre-filter specifically because the pre-filter would require a third work-key
derivation site; a few extra reads per skipped candidate is the cheaper price.

## Fail-closed behavior

Every failure mode denies rather than proceeds, and every denial is a typed, redacted receipt:

| Failure | Detection | Outcome |
|---|---|---|
| Two triggers for one issue race | per-issue group, `cancel-in-progress: false` | second run queues, then re-reads durable state |
| Two distinct issue triggers overlap | distinct issue groups plus per-work-key CAS | independent work may advance; same-key loser performs no effect |
| Two processes reconcile one operation | CAS on `CLAIMED` | one advances; loser `StaleRevision`, no provider call |
| Crash after enqueue | `listUnsettledDrafts` | next intake resumes at step 2 |
| Crash after `EFFECT_STARTED`, PR created | marker lookup | `REUSED` |
| Crash after `EFFECT_STARTED`, PR absent | `EFFECT_AMBIGUOUS` | only `REUSED` reachable; never a blind retry |
| More than one open PR on the head ref | provider ambiguity check | `EFFECT_AMBIGUOUS`; never a second create |
| Wrong workflow, run not `in_progress`, path or sha mismatch | admission returns `ZERO` | `REFUSED` / `NoEffectCapacity` |
| Ledger ruleset removed or bypass actor changed | protection re-verified before every write | `LedgerProtectionUnavailable`; nothing written |
| Ledger root tampered in the policy file | registry oid and revision check | `LedgerRegistryMismatch` |
| Corrupt or future-dated ledger record | chain, transition, epoch validation | `LedgerCorrupt`; nothing admitted |
| Issue unlabelled or actor demoted between trigger and collection | `collect()` re-derives everything | `IssueNotReady` / `ReadyActorUnauthorized`; skipped |
| Evidence branch missing or trailers ambiguous | head selection | `HeadIdentityAmbiguous`; skipped |
| Refs move mid-collection | double read-back | `SourceRevisionMoved`; skipped |
| Forged or mislabelled webhook payload | job gate plus full API re-derivation | payload carries no authority |
| Label events dropped by coalescing | — | schedule re-admits |
| Terminal work key re-selected | `enqueueDraft` returns `StaleRevision` | skipped; probe continues |
| `gh` absent or rate limited | typed collector and transport errors | redacted CLI error, exit 1, receipt still uploaded |

No path produces a duplicate Draft.

## Control Room: read-only verified observation

Requirement 7 is satisfied without a second source of truth. The Control Room reads the same
append-only ledger the pump writes and derives nothing of its own:

- Source: `store.readHead(workKey)` — production code today with zero production callers — plus the
  existing `list-unsettled` receipt. No new store, no new ref, no new schema owner.
- It displays the latest **verified** transition only: state, transition age computed from the record
  instant, the operation / issue / PR binding, and either the typed blocker or `EXPECTED_NONE`.
- It has **no local authority**: it never enqueues, reconciles, dispatches, writes to the ledger, or
  caches a mutable projection. A stale or unavailable read renders as `UNKNOWN`, never as an
  optimistic state.
- No local daemon, no Docker, no WebSocket, no new bus verb. Local and wmux artifacts remain
  advisory, exactly as the issue states.

The Control Room surface is a **separate change** from the trigger. It adds `src/control-room*.mjs`
to the file scope and needs its own RED pass; folding it into the intake change would blur two review
surfaces. This section fixes its contract so that the later change cannot drift.

The read model landed first and the producer landed after it, specified by
docs/hosted-draft-pump-producer.md. A run that is given an observation path seals its own
transition through `src/hosted-draft-pump-producer.mjs` and writes it there, and the workflow
uploads it as `gaia-hosted-draft-pump-observation`. No human hand-authors the document, and a run
that cannot honestly say what the pump did publishes nothing and names the refusal in its receipt.

Since issue #84, only the serialized recovery lane is given that path. The reading is sequenced by
the Actions run id, run ids are executed in order only within one concurrency group, and labeled
intake is now a group per issue; a lane reading could therefore arrive with a lower sequence than
the one already published and be refused on healthy forward progress. Keeping one writer for the
ordered reading is what makes `requireMonotonic` true as written. See
[Hosted parallel intake lanes R0](hosted-parallel-intake-lanes.md).

## Deliberately not built

No workflow dispatch, therefore no `actions: write`. No `workflow_call`, forbidden by the sealed
workflow's tests. No `repository_dispatch`. No new bus verb, no local daemon, no Docker, no
WebSocket, no paid API, no external repository dependency, no merge authority, no credential
widening. No new repository variable or secret. No change to `src/draft-operation-envelope.mjs`,
`src/gh-git-data-adapter.mjs`, `src/gh-draft-operation-provider.mjs`,
`src/github-actions-draft-admission.mjs`, `.github/workflows/hosted-draft-pump-effect.yml`,
`tests/hosted-draft-pump-workflow.test.mjs`, `.github/workflows/ci.yml`, or
`.github/gaia/pump-policy.json`. A diff reaching any of those means the design drifted; treat it as a
review stop.

## Minimal implementation scope

| File | Change |
|---|---|
| `.github/workflows/hosted-draft-intake.yml` | new — triggers, group, permissions, App token, CLI step, receipt artifact |
| `scripts/hosted-draft-pump.mjs` | add `intake`; sealed per-command admission-path map; policy-file default for the ledger root |
| `src/hosted-draft-pump.mjs` | add `runHostedDraftIntake`, pure and dependency-injected |
| `src/hosted-draft-collector.mjs` | add `listReadyIssues` to `createGhDraftCollectorApi` only |
| `tests/hosted-draft-intake.test.mjs` | new — orchestration seams |
| `tests/hosted-draft-intake-workflow.test.mjs` | new — static workflow assertions |
| `tests/hosted-draft-pump-cli.test.mjs` | extend — `intake` argv and configuration |
| `tests/hosted-draft-collector.test.mjs` | extend — `listReadyIssues` |
| `tests/draft-operation-envelope.test.mjs` | extend — concurrency and recovery seams |
| `tests/github-actions-draft-admission.test.mjs` | extend — per-workflow admission binding |
| `docs/draft-operation-envelope.md` | append a short hosted-intake pointer |

## Acceptance evidence

RED before GREEN, all at public seams; no private state is reached.

| # | Seam | Scenario | Expected |
|---|---|---|---|
| T1 | `runHostedDraftIntake` | one unsettled record present | reconciles it; `enqueueDraft` never called; phase `RESUME` |
| T2 | `runHostedDraftIntake` | no unsettled, no candidates | phase `EXPECTED_NONE`; no provider call |
| T3 | `runHostedDraftIntake` | first two candidates `StaleRevision`, third `Enqueued` | third admitted; `skipped` names the first two — the starvation regression |
| T4 | `runHostedDraftIntake` | candidate throws `IssueNotReady` / `HeadIdentityAmbiguous` | skipped with typed code; probing continues |
| T5 | `runHostedDraftIntake` | probe cap reached | stops at `N`; phase `EXPECTED_NONE` |
| T6 | `enqueueDraft` with memory ports | two concurrent enqueues, same selector | exactly one `Enqueued`, one `StaleRevision`, one work ref |
| T7 | `reconcileDraft` twice, distinct executor epochs | same operation at the same revision | one advances; loser `StaleRevision`; `createDraft` invoked at most once |
| T8 | `reconcileDraft` | provider throws after `EFFECT_STARTED`, second pass finds the marked PR | `EFFECT_AMBIGUOUS` then `REUSED`; `createDraft` called exactly once |
| T9 | `reconcileDraft` | restart at `ENQUEUED` with a PR already carrying the marker | `REUSED`, no create |
| T10 | `createGitHubActionsDraftAdmission` | effect-workflow environment, intake expected path | `reserveEffect` returns `ZERO` |
| T11 | `createGitHubActionsDraftAdmission` | intake environment, intake path, run `in_progress` | `AVAILABLE` |
| T12 | CLI `main` with injected argv, env, streams, runtime factory | intake argv with issues-shaped environment | parses; factory receives command `intake` and the policy-sourced ledger root |
| T13 | `tests/hosted-draft-intake-workflow.test.mjs` | the new YAML | `issues: [labeled]` and `schedule`; one `concurrency.group`, the per-event expression selecting `gaia-draft-intake-issue-<number>` for `issues` and `gaia-draft-intake-recovery` otherwise, with the flat `gaia-draft-intake` group asserted **absent**; `cancel-in-progress: false`; permissions exactly `actions: read` and `contents: read`; App token; `persist-credentials: false`; `ref: github.workflow_sha`; no `GITHUB_TOKEN` reference; no `actions: write`; no `docker` |
| T14 | `tests/hosted-draft-pump-workflow.test.mjs`, unchanged | regression | the sealed effect workflow still passes byte for byte |
| T15 | `listReadyIssues` | fake transport returns a PR row and an issue row | PR dropped; issues ascending by number |
| T16 | `listUnsettledDrafts` on a corrupt chain | — | `LedgerCorrupt`; nothing admitted |

Beyond the suite: focused tests twice, full suite twice, `npm run verify`, deterministic replay, and
a live proof that one labelled issue and one recovery replay create no duplicate Draft.

## Residual risks

1. **Admission under the new event types is unproven in production.** The adapter requires
   `head_sha` to equal `GITHUB_WORKFLOW_SHA` and the run status to be `in_progress`. Both `issues`
   and `schedule` run the workflow from default-branch HEAD, so these should coincide, but the
   mechanism has only been exercised for `workflow_dispatch`. If it does not hold, admission returns
   `ZERO` and the operation is terminally `REFUSED` — unrecoverable for that issue. **Prove it with
   one throwaway run on a scratch issue before relying on it, never on live work.**
2. **Terminal refusal is unrecoverable per issue.** A `ProviderUnavailable` or `NoEffectCapacity`
   refusal permanently settles a work key, exactly as observed live on issue #52. There is
   deliberately no re-enqueue path; recovering such an issue is a human decision outside this design.
3. **Scheduled triggers are disabled after 60 days of repository inactivity**, and cron is
   best-effort and can be delayed under load. The pump would go quiet with no error surface. The
   design must not assume punctuality; the Control Room's transition age is the detector.
4. **Pending-run coalescing semantics are assumed, not measured.** The claim that at most one pending
   run survives per group under `cancel-in-progress: false` should be observed once rather than
   trusted.
5. **The cross-workflow concurrency invariant is weakened**, as stated above. Duplicate-freedom now
   rests on the ledger CAS alone. Any future change that adds a re-enqueue path, or that lets
   `EFFECT_AMBIGUOUS` reach `createDraft`, breaks it.
