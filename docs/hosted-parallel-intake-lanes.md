# Hosted parallel intake lanes R0

Status: design gate for issue #84. Base `a77f9280bed8b26230c63cffaa7698d502f7fd43`.

## Problem

The hosted Draft intake is live, but `.github/workflows/hosted-draft-intake.yml` places every
trigger in the repository-wide `gaia-draft-intake` concurrency group. An unrelated issue can
therefore delay another issue before either reaches the Draft envelope's durable work-key claim.
The safety mechanism and the scheduling policy have become accidentally coupled.

R0 separates them. Label-triggered runs are partitioned by the canonical GitHub issue number;
scheduled recovery stays repository-wide because it selects from the repository-wide unsettled
set. The Draft envelope, Git Data compare-and-set, exact-Draft reconciliation, App identity,
permissions, and receipts are unchanged. The observation seam changes in exactly one way: the
ordered reading it publishes stays on the serialized recovery lane, because run-id order is a
property of one concurrency group and there is now more than one. See "Observation ordering".

## Design it twice

### A — remove `concurrency` entirely

Rejected. GitHub would overlap duplicate deliveries for one issue without a workflow-level
back-pressure key. The durable compare-and-set would still prevent a duplicate effect, but the
extra runner work and ambiguous pending-run behavior would be needless.

### B — batch and matrix every candidate in one scheduled run

Rejected for R0. A discovery job would have to publish a matrix of untrusted GitHub observations,
introduce a new batch receipt, and define partial-failure semantics before the smallest useful
parallel path is proven. Scheduled recovery also has a repository-wide ordering duty that labeled
intake does not.

### C — one composite concurrency key — selected

Use one closed expression:

```yaml
group: ${{ github.event_name == 'issues'
  && format('gaia-draft-intake-issue-{0}', github.event.issue.number)
  || 'gaia-draft-intake-recovery' }}
```

An `issues:labeled` event has a canonical positive issue number re-read by the collector before it
becomes authority. The expression uses that number only to partition runner scheduling. Scheduled
runs have no issue and collapse into the single recovery group. `cancel-in-progress: false` remains.

## Concurrency invariant

- Logical resource: one Draft operation for one issue-derived work key.
- Actors: duplicate issue events, independent issue events, scheduled recovery, retries, and the
  Draft provider.
- Durable state: the existing Git Data Draft operation store and its committed revision.
- Linearization point: the existing expected-revision compare-and-set in the Draft envelope.
- Idempotency: stable operation/work keys plus exact Draft lookup and terminal receipt replay.
- Same issue: workflow grouping bounds duplicate runner activity; CAS chooses one winner; the stale
  loser performs no effect.
- Different issues: workflow runs may overlap and use distinct work keys, operation identities, and
  receipt artifacts. They publish no observation revision: the ordered reading keeps one writer, the
  serialized recovery lane. See "Observation ordering" below.
- Lost response: exact Draft reconciliation precedes retry, unchanged from the shipped envelope.
- Recovery: scheduled runs remain serialized and resume repository-wide unsettled work before
  admitting new work.
- Lane alignment: an issue-triggered run may resume only an unsettled operation whose selector is
  that same issue. Unrelated unsettled work belongs to its own issue lane or to scheduled recovery;
  it cannot consume this lane and starve the triggering issue.
- Global observation: action selection is issue-scoped, but `unsettledCount` remains a projection of
  every validated unsettled operation the run observed. Settling one matching operation subtracts
  one from that global count; admitting a still-pending operation adds one. Unrelated residual work
  can never disappear from the receipt, nor from the Control Room observation the recovery lane
  publishes.

The workflow group is not the correctness mechanism. Removing it must increase redundant runner
activity but cannot permit a duplicate Draft effect; removing the CAS must fail existing mutation
and concurrency tests.

## Observation ordering

Removing the repository-wide group removed a property the observation seam was quietly relying on.
`src/hosted-draft-pump-producer.mjs` stamps every reading with `sequence`, the Actions run id, and
`requireMonotonic` refuses a reading whose `sequence` is lower than the one already published.
`docs/hosted-draft-pump-producer.md` justified that guard with the single non-cancelling group: one
queue executed in order, so completion order equalled run-id order, and a backwards `sequence` could
only mean a stale replay.

Two issue lanes are two queues. They can start in run-id order and finish in the opposite order, and
the later-finishing lane then carries the lower run id. Its reading is refused as
`IncoherentHostedDraftPump` even though `observedAt` moved forward and the pump made real progress.
A refused reading publishes nothing and ages into `STALE` — issue #70's motivating defect from the
opposite direction, which `docs/hosted-draft-pump-producer.md` already names as disqualifying.

### Design it twice

#### D — restate the basis and keep publishing from every lane

Rejected. The truthful restatement is "run ids order readings only within a concurrency group", and
the guard compares repository-wide. Writing that down documents a live defect rather than closing
it, and the refusal against healthy forward progress stays reachable.

#### E — order publication globally before the scheduling change ships

Rejected for this repair. A repository-wide ordered reading needs a new linearization point for the
observation seam: a post-action global snapshot, or a serialized publisher the lanes hand readings
to. That is a new mechanism rather than a correction to this one, and it is the transition already
named as the next slice. It cannot be the smallest repair to a property this change removed.

#### F — exclude the observation seam from the parallel path — selected

The ordered reading keeps exactly one writer. Only runs in the single non-cancelling
`gaia-draft-intake-recovery` group are given an observation path, so every published `sequence`
comes from one queue executed in order and the monotonicity argument is true again as written.
Labeled issue lanes still run, still act, and still upload their receipt; they publish no ordered
reading, because a lane that cannot be ordered against the others must not claim to be.

The exclusion is one closed expression on the step's `env:` binding, in the same idiom as the
concurrency group:

```yaml
GAIA_OBSERVATION_PATH: ${{ github.event_name != 'issues'
  && format('{0}/gaia-hosted-draft-pump-observation.json', runner.temp) || '' }}
```

The truthy branch is first because Actions collapses `A && '' || B` to `B`: an empty string is
falsy, so the empty reading must be the fallback and never the selected branch. `--observation-out`
leaves the command line at the same time — a flag whose value can be empty is parsed as a flag
missing its value and refuses the whole invocation — and the binding moves to `env:`, where the seam
gate already requires the step's inputs to live. The CLI already reads an empty environment value as
an absent one, so no CLI change is needed and none is made.

What this costs, stated plainly: between scheduled ticks the Control Room's pump reading ages. That
is the honest reading of a repository whose only globally ordered observer runs on the recovery
cron, and it is `STALE` for the true reason instead of `STALE` because a healthy lane was refused.
Restoring per-lane freshness is alternative E, and it stays a separate slice.

## Public seams

R0 changes no JavaScript public interface. Tests observe:

1. the workflow scheduling contract in `.github/workflows/hosted-draft-intake.yml`;
2. the existing `runHostedDraftIntake` receipt seam for same-key convergence and distinct-key
   independence;
3. the unchanged workflow authority surface;
4. the observation binding on the intake step, which decides which runs publish an ordered reading.

The runtime already receives the event issue as the explicit `candidates` list. Explicit candidates
therefore scope unsettled selection to those same issue numbers. A null candidate list denotes
scheduled recovery and retains the repository-wide lowest-work-key resume rule. This closed
distinction aligns the workflow concurrency identity with the resource the run may process without
adding a new flag or trusting webhook data as authority.

## Provider boundary

This scheduling slice creates no fiction that a code-writing agent ran. On 2026-09-01 the
repository's GitHub GraphQL `suggestedActors(CAN_BE_ASSIGNED)` result did not include
`copilot-swe-agent`. GitHub's agent-tasks API also requires user-to-server authentication, which
the pump's bounded installation token intentionally is not. Enabling a GitHub agent app or an
isolated self-hosted runner is a separate credential, cost, and host-security decision.

## Falsifiers

- Two different issue numbers resolve to the same concurrency key.
- A scheduled run resolves to an issue group or several recovery groups.
- `cancel-in-progress` becomes true.
- The workflow gains a secret, write permission, Docker step, dispatch authority, or provider.
- The runtime accepts the event issue number as authority without collector re-observation.
- Any same-key interleaving can reach two Draft effects.
- A labeled issue run is given an observation path, or a scheduled recovery run is denied one.
- The observation binding reaches the CLI as a command-line flag that can carry an empty value.
- A published `sequence` originates outside the single recovery group.

## Verification

- RED contract tests for the composite group and the removal of the global group.
- A RED contract test that the ordered observation is bound to the recovery lane only, with a revert
  control that re-arms the cross-lane refusal.
- Existing same-selector concurrent enqueue and cross-process Draft delivery tests.
- Focused workflow/intake/envelope suites twice.
- Full suite and `npm run verify`.
- Fresh independent Standards and Spec review before push.
