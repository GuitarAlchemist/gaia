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
permissions, receipts, and observations are unchanged.

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
- Different issues: workflow runs may overlap and use distinct work keys, operation identities,
  receipt artifacts, and observation revisions.
- Lost response: exact Draft reconciliation precedes retry, unchanged from the shipped envelope.
- Recovery: scheduled runs remain serialized and resume repository-wide unsettled work before
  admitting new work.
- Lane alignment: an issue-triggered run may resume only an unsettled operation whose selector is
  that same issue. Unrelated unsettled work belongs to its own issue lane or to scheduled recovery;
  it cannot consume this lane and starve the triggering issue.
- Global observation: action selection is issue-scoped, but `unsettledCount` remains a projection of
  every validated unsettled operation the run observed. Settling one matching operation subtracts
  one from that global count; admitting a still-pending operation adds one. Unrelated residual work
  can never disappear from the receipt or its Control Room observation.

The workflow group is not the correctness mechanism. Removing it must increase redundant runner
activity but cannot permit a duplicate Draft effect; removing the CAS must fail existing mutation
and concurrency tests.

## Public seams

R0 changes no JavaScript public interface. Tests observe:

1. the workflow scheduling contract in `.github/workflows/hosted-draft-intake.yml`;
2. the existing `runHostedDraftIntake` receipt seam for same-key convergence and distinct-key
   independence;
3. the unchanged workflow authority surface.

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

## Verification

- RED contract tests for the composite group and the removal of the global group.
- Existing same-selector concurrent enqueue and cross-process Draft delivery tests.
- Focused workflow/intake/envelope suites twice.
- Full suite and `npm run verify`.
- Fresh independent Standards and Spec review before push.
