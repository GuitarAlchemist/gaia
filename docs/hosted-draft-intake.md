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
       for each deterministic record, capped at N = 5:
         reconcile it at its committed revision
         scheduled run + unchanged EFFECT_AMBIGUOUS at that exact revision -> record a quarantine
           skip for this tick and continue
         otherwise emit receipt phase RESUME and stop
4. candidates:
       issues-labeled run -> [ the event issue number ]
       scheduled run      -> open ready-for-agent issues, number ascending, capped at N = 5
5. for each candidate, at most N probes:
       enqueue; on a typed collector error or any non-Enqueued result, record a skip and continue
       reconcile the enqueued operation at its committed revision
       emit receipt phase ADMIT; stop
5. emit receipt phase EXPECTED_NONE
```

Step 3 remains fail-closed for issue-triggered intake: the lane resumes only the operation for its
own issue and returns its result, so unrelated recovery cannot steal the lane. Scheduled recovery
may probe forward only after an exact replay returned `Pending / EFFECT_AMBIGUOUS / UNKNOWN /
ProviderAmbiguous` at the unchanged committed revision. That predicate proves this retry performed
no new effect. The record is preserved durably and named in `skipped`; quarantine applies only to
this tick. Any revision change or different result stops immediately. If every bounded recovery
probe is quarantined, the scheduled run may continue to candidate admission. Step 5 still admits at
most one candidate per run, satisfying requirement 4. Both the
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

### Evidence head seeding

`collect()` requires exactly one branch whose tip carries `Gaia-Issue: N` and
`Gaia-Ready-Receipt: <queueReceiptRevision>`. Because that revision hashes the ready-label event,
the branch cannot exist before the label, and nothing in the pump produced it: a labelled issue
without a hand-made branch refused as `HeadIdentityAmbiguous` with zero heads.

```bash
npm run draft:seed-evidence -- --issue N            # dry run: branch, message, receipt
npm run draft:seed-evidence -- --issue N --apply    # create it, then read it back
```

`src/evidence-head-seeder.mjs` derives the receipt through the collector's own
`observeReadyReceipt` and matches heads through its own `findEvidenceHeads`, so the producer cannot
drift from the consumer. It creates `gaia/issue-N-ready-K` (K is the ready occurrence) as one
commit that reuses the default branch's tree: no file changes, and the factory candidate lands on
top. It never applies `ready-for-agent`: an unlabelled issue, a closed one, or a label applied by
an actor below `triage` refuses before any write. One matching head reports `PRESENT` and writes
nothing; several refuse. After writing, the read-back decides the result: `CREATED`, `FAILED`
(no ref; at most an unreferenced commit object), or `AMBIGUOUS`, which is never retried
automatically. Exit codes: `0` planned, present, or created · `1` refused, failed, or ambiguous ·
`2` usage · `3` fail-closed.

Proving "exactly one" means reading the tip of every branch. The `gh` adapter lists all branches
with their tip commit messages in one paginated GraphQL query, a hundred per page, and
`readCommit` answers a listed tip from that listing: a commit is immutable, so the message cannot
differ. It used to read each tip over REST, one call per branch per issue. On 2026-09-29, with 115
branches, eleven intake runs in half an hour were followed by two that failed as
`GitHubGitDataUnavailable`, most likely on the pump App's hourly quota; the redacted error could not
say, which is why a rate limit now has its own cause. A collection lists twice, to select and then
to read back, at one GraphQL call per hundred branches: four calls today instead of about 119.

### Choosing what to feed

`ready-for-agent` is an act of authority: the collector binds the receipt to the label event and
refuses an actor below `triage`. So nothing in Gaia applies it on its own, and a feeder that picked
and labelled its own work would be self-authorization. `scripts/pump-candidates.mjs` does the part
that can be automated without that: it ranks, and the operator labels.

```bash
npm run pump:candidates                       # top 3, with a tally of refusal reasons
npm run pump:candidates -- --format json      # every issue and every reason
```

An open issue is a candidate when it carries none of `needs-triage`, `blocked`, `ready-for-agent`,
`retrospective`, `wontfix`, `duplicate` or `blocker:*` (plus any `--exclude-label`); declares no
`Depends-On`/`Blocked-By` or `Duplicate-Of` (asserted `NONE` is fine; a malformed block refuses);
is not named as a parent by another open issue; has a completion section (`Done when`,
`Acceptance criteria`, and their variants); and has neither a `deliver issue #N` Draft nor a
`gaia/issue-N-*` branch. Candidates are listed lowest number first. The module exports no effect.

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

**Shared registry.** A first admission appends to the one registry ref before its own work ref
exists, so first admissions of *different* issues contend there. Labelling several issues at once
starts one intake per issue, and on 2026-09-29 two of four simultaneous first admissions lost that
CAS and admitted nothing. `enqueueDraft` therefore re-reads the admission line and retries, three
attempts in all. It pauses before each retry, 2–4 s and then 4–8 s, for a wait derived from the
work key, so issues labelled together spread out instead of re-racing in the same instant. A
contended issue costs its intake at most 12 s more. Whether the pause lowers contention on the live
registry has not been measured (#197). The re-read is what keeps it safe: a work key that landed
meanwhile answers `StaleRevision` as before and is never enqueued twice. An issue that loses all three attempts reads its
line once more. If its work key landed, the answer is still `StaleRevision`. Otherwise it answers
`AdmissionContended` with nothing admitted. That is a skip the observation does not explain, so the
tick is never published as a healthy empty queue while the issue waits for the next one.

**One work key, two bootstraps.** A labelled run and a recovery run sit in different concurrency
groups, so both can bootstrap the same issue, and the retry above makes the loser of such a race
resume the winner's bootstrap. Every bootstrap step therefore reads again what it acts on. A
confirmation that landed meanwhile is adopted rather than appended a second time: two `CONFIRMED`
records for one key make the registry unreadable, which would stop every intake until the ledger
was repaired by hand. A work ref found ahead of the registry just read gets one registry re-read
before it counts as corruption. Both windows predate the retry; gated tests pin each one.

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

**Poison-message isolation.** Scheduled recovery may skip an unchanged `EFFECT_AMBIGUOUS` record
only after reconciling it under the same operation identity and committed revision. The skip is not
a state transition and grants no effect authority; the durable record remains unsettled and visible.
Issue-triggered retries never quarantine, and any changed revision stops the scheduled tick. Thus a
bad message cannot block the whole queue without permitting a blind retry or hiding the blocker.

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

There is no re-enqueue path and no automatic new-generation path. The one way back for a work item
is an operator re-admission of a refusal that provably created nothing, and it opens a new chain
rather than reopening the refused one (see
[Re-admitting an effect-free refusal](#re-admitting-an-effect-free-refusal--decided-167)).

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

## Settling an ambiguous Draft — the decision only (#176)

Step 3 above leaves `EFFECT_AMBIGUOUS` one exit, `REUSED`, and `reconcileDraft` takes it only when its
lookup finds the marked Draft. When the lookup finds nothing, the operation stays pending for ever:
nothing tells "found nothing" apart from "searched badly". The #127 operation has sat there since at
least 2026-09-15 (#161). `src/draft-ambiguity-settlement.mjs` makes that call from a saved lookup, and
only that call. It reads no network, no clock and no ledger, and it never creates, retries or cancels
an effect.

**The operation** is the ledger's own record: `operationId`, `workKey`, `generationKey`,
`committedRevision`, `state` and the envelope. The module recomputes the identity from the envelope
exactly as `src/draft-operation-envelope.mjs` derives it. So an operation id cannot be paired with
another generation's head, and a successor cannot borrow a predecessor's id
(`OperationIdentityMismatch`). A test reproduces the fixture through `enqueueDraft` and a
`reconcileDraft` whose create response is lost.

**The lookup** is a `GaiaDraftMarkerLookupV0` record of the search the provider runs, in the
provider's order:

1. Read the operation at its ambiguous revision, and record that `committedRevision`.
2. Check the repository identity (`gh repo view --json id,nameWithOwner`), and record the answer.
3. List every pull request on the head branch, in every state, with the provider's limit of 100:

```bash
gh pr list --repo OWNER/NAME --state all --head HEAD_REF --limit 100 \
  --json number,url,isDraft,state,baseRefName,headRefName,headRefOid,headRepositoryOwner,body
```

The record adds when the search ran and whether it completed (`COMPLETE`, `PARTIAL` or
`ERRORED`). The lookup must name the revision the operation is decided at
(`LookupRevisionMismatch`). That revision was committed after the create attempt, so a search that
followed reading it followed the create. A search from before it proves nothing.

The module checks the record's shape and bindings, but not that the commands ran. The fields are the
producer's claims: whoever assembles the record answers for it, and #161's write must read the
operation again at that revision.

**Why an empty search proves absence.** The provider creates a Draft only with `--head` on the
operation's own head branch. A pull request's head branch never changes, and a pull request is never
deleted. So a complete search of that head, in every state, that returns no pull request at all
proves the Draft was never created. The proof rests on those two GitHub properties, and on nothing
the pump itself writes.

**The decision**, `decideAmbiguousSettlement({ operation, lookup })`:

| Lookup | Decision | Reason |
| --- | --- | --- |
| errored, partial, or 100 rows (a full page) | `STAY_UNSETTLED` | `LookupErrored`, `LookupPartial`, `LookupTruncated` |
| complete, no pull request on the head | `SETTLE_ABANDONED` | `MarkerProvablyAbsent` |
| more than one pull request on the head | `STAY_UNSETTLED` | `SeveralPullRequestsOnHead` |
| one pull request, marker absent or repeated | `STAY_UNSETTLED` | `UnmarkedPullRequestOnHead` |
| one marked pull request that is not an open Draft on the generation (merged, closed, ready, moved) | `STAY_UNSETTLED` | `MarkedPullRequestNotAdoptable` |
| one marked open Draft on the generation | `SETTLE_REUSED` | `MarkedDraftFound` |

**`SETTLE_REUSED` never goes beyond the existing adoption.**
- A test runs the real provider over the same rows with no merge evidence available. It adopts
  exactly the `SETTLE_REUSED` rows, and it finds nothing exactly where this module abandons.
- A merged Draft is different. `reconcileDraft` can adopt it with its own merge reads, but this
  module leaves it `STAY_UNSETTLED`.
- `SETTLE_REUSED` is therefore a subset of what `reconcileDraft` adopts.

**Refusals.** Each is named:
- an operation that is not `EFFECT_AMBIGUOUS`: `OperationNotAmbiguous`;
- an identity that does not follow from its envelope: `OperationIdentityMismatch`;
- a lookup of another marker: `LookupMarkerMismatch`;
- a lookup of another head or repository, or whose identity check saw another repository:
  `LookupScopeMismatch`;
- a lookup of another revision: `LookupRevisionMismatch`;
- a malformed input: `InvalidOperation` or `InvalidLookup`.

Inputs are read as plain data. Accessors, foreign prototypes, extra keys and array holes are refused,
and what is hashed is the validated copy.

**Evidence.** Every decision carries the record a settlement would write:
- the operation, its generation, and the ambiguous revision it was decided at;
- the lookup's own content revision, identity check and bounds;
- the pull request found, if any;
- its own content revision.

**Dry run.**

```bash
npm run draft:settle-ambiguous -- --operation operation.json --lookup lookup.json [--json]
```

- **Exit codes:** `0` a decision was made, whichever it is · `1` refused · `2` usage · `3`
  fail-closed, meaning a file could not be read.
- **No `--apply`.** The operator write, a new `ABANDONED` transition in the envelope, and what
  becomes of the evidence branch all stay on #161.
- **The #127 operation.** Dry run at 2026-09-30T22:54:15Z, in the format above, with nothing written:
  - The operation (`e700fd9b…`) was read from the hosted ledger at its ambiguous revision
    (`02bd6009…`). Its identity recomputes from its envelope.
  - The repository identity check and the search above then ran with the user's own `gh`.
  - They found no pull request on `codex/issue127-normal-admission-live`.
  - The decision was `SETTLE_ABANDONED` (`MarkerProvablyAbsent`).

## Re-admitting an effect-free refusal — decided (#167)

A refusal is terminal, and the base work key is the issue. So a transient, host-side refusal that
provably produced no GitHub effect removed its issue from the pump for good, with no operator path
back. Observed: #93 and #102 refused `BeforeProvider:NormalPolicyExpired` with
`effectBoundary: NOT_INVOKED` (run 36266028228 for #93) because the admission window expired, not
because of anything about the work. After #165/#166 fixed the cause, every later ready event for them
returns `StaleRevision`. #52 (`ProviderUnavailable`) is the same case.

**Designed twice.**

- *Automatic supersession by a new generation.* Rejected. It turns "terminal" into "terminal until the
  next ready event", so a refusal stops being an outcome and becomes a delay. It also has the pump
  widening its own admission from its own records, which ENG-04 forbids.
- *Terminal forever, re-file under a new issue number.* Not chosen as the path. It spends a human
  issue on every host incident and cuts the work off from its history. It needs no code and remains
  available.
- *Explicit operator re-admission.* **Selected.** The refusal stays terminal. A human decides, in
  writing, that one specific refused operation may be followed by another admission.

**A successor admission, never a reopened chain.** Nothing is ever appended after a terminal record.
Each chain is stored under an *admission key*. A first admission's key is its work key, so every
existing ref is unchanged. Re-admission opens a successor chain whose admission key derives from
the refused one:

```text
successorAdmissionKey = sha256(canonical({
  schema: 'GaiaDraftSuccessorAdmissionKeyV0',
  predecessorAdmissionKey, predecessorTerminalRevision
}))
```

The registry reserves each key once, so a refused terminal has at most one successor: admissions form
a line, never a fork. The successor's root is `GaiaDraftWorkRootV1`: the V0 root, plus
`admissionKey`, `predecessor { admissionKey, operationId, terminalCommittedRevision, refusal }`,
`spentGenerationKeys`, and `readmission { reason, runId, runAttempt, triggeringActor }`. The reason
and the dispatcher are durable ledger content, not workflow log text.

The admission key is storage only. Every record on every chain still carries the issue's work key.
`workKey`, `generationKey`, `operationId` and the Draft marker are derived exactly as before. So the
pump receipt, the Draft admission check that re-derives them (`src/github-draft-admission.mjs`) and
the effect-capacity claim need no change.

What keeps operation ids unique is the generation, not a new key. A successor accepts only a
generation that no chain on its line has used. The root carries those generation keys as
`spentGenerationKeys`, and an `ENQUEUED` that reuses one is ledger corruption. The refused generation
is spent for good: re-admission admits the **next** ready event, not the refused one. #93 already has
one (occurrence 3, `gaia/issue-93-ready-3`). For any other issue, re-applying `ready-for-agent`
creates one.

**Eligibility is structural.** Only a `REFUSED` terminal whose create call provably never ran is
re-admissible. That means refused from `ENQUEUED`, `CLAIMED` or `INTENT` (the create call is reachable
only after `EFFECT_STARTED`), or refused from `EFFECT_STARTED` with `effectBoundary: NOT_INVOKED`.
`CREATED`, `REUSED`, `CANCELLED`, `EFFECT_AMBIGUOUS` and every nonterminal state are refused with
`NotReadmissible`. Ambiguity is still never retried, and a work key that produced or may have produced
a Draft is never re-admitted. The ledger grammar already rejects a post-provider `REFUSED`; the check
states the rule again on its own, so a later grammar change cannot widen re-admission by accident.

**The dispatch is the authority, and the only one.** Only the pump App can write the ledger, so
re-admission runs in this sealed workflow on `workflow_dispatch`, with inputs `readmit_operation`,
`readmit_revision` (the expected terminal committed revision), `readmit_reason` (required, bounded)
and `readmit_apply` (default `false`). Without `readmit_apply` the run is a dry run: it checks
eligibility and reports the successor key it would open, and writes nothing. With it, the pump runs
the same resumable reservation, root and confirmation protocol as a first admission. A re-admission
run admits no work, calls no provider and publishes no observation. Scheduled and labelled runs never
reach it, and the pump has no code path that opens a successor on its own. Whoever may dispatch the
workflow may re-admit, and the ledger records who did.

The identity gate refuses a re-admission that is incomplete or combined with anything else, and it
also refuses `readmit_apply` ticked with no operation, so a mistaken dispatch never falls through to
an ordinary intake run. A green run means `ReadmissionPlanned`, `Readmitted` or `AlreadyReadmitted`.
Every other result (`NotReadmissible`, `StaleRevision`, `ReadmissionContended`) fails the run, and
the receipt that names it is still uploaded. `ReadmissionContended` means other admissions kept
moving the shared registry: opening is retried three times from whatever already landed, and the
next dispatch resumes it. Nothing is admitted in the meantime.

**What intake does with a successor.** `enqueueDraft` walks the admission line. It reads the base work
key, and while the current chain is a re-admissible terminal whose successor exists, it moves to the
successor. A root-only successor receives the new generation's `ENQUEUED` under the same `NONE`
contract as a first admission, unless that generation is spent, in which case the result is
`StaleRevision`. A missing successor also leaves the result `StaleRevision`, exactly as before:
waiting never re-admits anything. `CrossGenerationIntent` is decided on the resolved chain. An intake
that reads a successor while an operator is opening it can see the work ref before the registry
entry that allows it. The store re-reads the registry once before calling that corruption, so the
intake sees the successor pending or open.

## Starvation: why the schedule must admit, and why probing is mandatory

Two facts make a recovery-only schedule and a lowest-numbered selector both wrong.

**Pending duplicate runs coalesce.** With `cancel-in-progress: false`, Actions bounds pending runs
inside one issue group. Independent issue labels no longer coalesce with each other. The schedule is
still the recovery path for work whose label event predated this policy or whose run never reached
durable enqueue, so it remains an **admission** path, not merely a recovery path.

**A refusal is terminal for its chain forever.** `enqueueDraft` returns `StaleRevision` for any work
key that already carries a record when the expected committed revision is `NONE`, unless an operator
has re-admitted an effect-free refusal on that key (see above). Verified live at
base: of the three open `ready-for-agent` issues, #51 is terminal `CREATED` and #52 is terminal
`REFUSED` with refusal `ProviderUnavailable`. A naive lowest-numbered selector picks #51, receives
`StaleRevision`, and admits nothing forever — starving #70 itself.

Candidate selection therefore **probes forward** past settled work keys, recording each skip with its
typed reason in the receipt, up to a bounded `N = 5` probes per run. Probing is preferred over a
`readHead(workKey)` pre-filter specifically because the pre-filter would require a third work-key
derivation site; a few extra reads per skipped candidate is the cheaper price.

**An unchanged ambiguous recovery is nonterminal but inert for this tick.** A transport-ambiguous
record may remain at the front of the deterministic unsettled order indefinitely. Retrying the same
reconciliation can prove that no durable revision changed while still being unable to settle the
record. Scheduled recovery therefore probes past up to `N = 5` such records and records each as
`EFFECT_AMBIGUOUS` in `skipped`. This is message-pump quarantine, not acknowledgement: the record
remains in the unsettled denominator and will be retried on a later tick. A non-ambiguous result or a
revision change ends the tick before any later work is touched.

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
| Unchanged ambiguous record heads the scheduled queue | same operation and committed revision after reconcile | record remains unsettled; quarantined for this tick; bounded probe continues |
| Ambiguous retry changes durable revision | committed revision differs from the listed record | stop the tick and publish the new observation; no later message is touched |
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
| First admissions of distinct issues race on the registry | registry CAS, line re-read | retried after a 2–4 s, then a 4–8 s pause, three attempts in all; then `AdmissionContended`, or `StaleRevision` if the work key landed |
| GitHub rate limit, primary or secondary | `gh` stderr classified, then discarded | cause `GitHubRateLimited`; the tick ends, never retried into the same quota |
| `gh` absent or GitHub unreachable | typed collector and transport errors | redacted CLI error, exit 1, receipt still uploaded |

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
| T1 | `runHostedDraftIntake` | one non-ambiguous unsettled record present | reconciles it; `enqueueDraft` never called; phase `RESUME` |
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
| T17 | `runHostedDraftIntake` -> producer -> read model | a lane commits durably while a recovery run selects | receipt and block count 1; state `UNSETTLED`; severity is not `healthy` |
| T18 | `runHostedDraftIntake` -> producer -> read model | the recovery run lists the same issue and loses the compare-and-set | receipt and block count 1 alongside the `StaleRevision` skip; not `healthy` |
| T19 | `runHostedDraftIntake` -> producer -> read model | genuinely empty ledger, no candidate | `EXPECTED_NONE` / `healthy` / 0 — the positive control the repair must not break |
| T20 | `runHostedDraftIntake` | post-action read returns less than the run projected | the count is not lowered; the operation left open is still counted |
| T21 | `runHostedDraftIntake` | post-action read contains the operation this run admitted | counted once, not twice |
| T22 | `runHostedDraftIntake` | scheduled queue head remains ambiguous at the unchanged revision; next record settles | first record is quarantined for the tick; second record is reconciled; phase `RESUME` |
| T23 | `runHostedDraftIntake` | issue-scoped retry remains ambiguous at the unchanged revision | returns that pending result; no quarantine or unrelated work |
| T24 | `runHostedDraftIntake` | scheduled ambiguous retry returns a changed revision | stops at that record; no later recovery or admission |
| T25 | `runHostedDraftIntake` | every bounded recovery probe is unchanged and ambiguous; eligible candidate exists | quarantines the old records and admits at most one candidate |
| T26 | `runHostedDraftIntake` | scheduled ambiguous retry carries no observed revision | stops at that record; fallback data cannot prove an unchanged revision |

Beyond the suite: focused tests twice, full suite twice, `npm run verify`, deterministic replay, and
a live proof that one labelled issue and one recovery replay create no duplicate Draft.

## Residual risks

1. **Admission under the new event types** — proven on 2026-09-29. The adapter requires `head_sha`
   to equal `GITHUB_WORKFLOW_SHA` and the run status to be `in_progress`; both hold for `issues`
   and `schedule`. `issues` run 36517680576 admitted #183 (Draft #188), and `schedule` runs
   36527648771 and 36571339460 admitted #93 (Draft #189) and #102 (Draft #190).
2. **A terminal refusal settles its line.** A `ProviderUnavailable` or `NoEffectCapacity` refusal
   settles a work key's current line, as observed live on issue #52. Since #167 an operator can
   re-admit an effect-free refusal by dispatch (above); a refusal after an invoked effect is never
   re-admitted.
3. **Scheduled triggers are disabled after 60 days of repository inactivity**, and cron is
   best-effort and can be delayed under load. The pump would go quiet with no error surface. The
   design must not assume punctuality; the Control Room's transition age is the detector.
4. **Pending-run coalescing semantics are assumed, not measured.** The claim that at most one pending
   run survives per group under `cancel-in-progress: false` should be observed once rather than
   trusted.
5. **The cross-workflow concurrency invariant is weakened**, as stated above. Duplicate-freedom now
   rests on the ledger CAS alone. Any future change that adds a re-enqueue path, or that lets
   `EFFECT_AMBIGUOUS` reach `createDraft`, breaks it.
6. **The observation denominator is narrowed, not exact.** The post-action read closes the window in
   which a concurrent lane commits while a run is selecting or admitting, but not the window between
   that read and receipt emission. A lane committing there is unobserved until the next tick. The
   correction term is one-directional - it can only raise the projection, never lower it - so a lane
   that committed *before* the read can never be dropped; a lane that commits *after* it is the
   under-count described above, and it can render `healthy` until the next tick. Closing the remainder
   requires a denominator the lane can serialize against, which the per-issue groups deliberately gave
   up.
7. **Every intake re-reads the whole ledger.** Listing unsettled work re-reads every registered
   admission, terminal ones included. Over REST, each record costs a commit, a tree and a blob read.
   Measured read-only on 2026-09-29, one listing made 551 GitHub calls in 86 seconds (158 records plus
   77 ref reads). A few hours later the same listing made 579 calls in 109 seconds. At that rate an
   hourly installation quota of 5,000 held roughly five to seven intake runs.

   The pump now reads each chain's history through GraphQL, which has its own hourly quota. It sends
   one query per ref whose head it has not yet cached, and one more per further hundred records. A
   tree or blob enters the cache only when its bytes hash back to the id Git stored for it, so nothing
   the transport altered is read. Every record still passes the same receipt validation. The same
   live listing then made 81 REST ref reads and 21 GraphQL queries in 8 seconds. The records read from
   all 34 ledger refs were identical under both paths, and every tree and blob verified. Three costs
   remain:
   - Ref heads are still read over REST on every read, so the REST cost still grows with admissions,
     at about a seventh of the former rate.
   - If GraphQL fails, or answers without the commit asked for, the adapter falls back to REST for the
     rest of the run, at the former cost. An object that does not verify costs its own REST read.
   - The prefetch runs before the head's receipt is checked. A ledger ref pointing at an ordinary
     branch costs one large query (13.6 MB and 8.4 s, measured against `main`) before its head receipt
     is refused, and the listing then fails closed as it did before.
