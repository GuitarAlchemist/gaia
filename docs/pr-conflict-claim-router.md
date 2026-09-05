# Pull-request conflict claim router

Status: design for issue #117. This slice turns a proven conflict escalation into durable owned
work. It does not edit, merge, commit, or push a branch.

## Operator outcome

When the conflict classifier returns `ESCALATION_REQUIRED`, the global pump can claim that exact
pull-request generation and assign it to one bounded worker. A second supervisor, a retry, or a
stale generation cannot create a second live owner. The escalation therefore becomes executable
work instead of a warning that can remain stale indefinitely.

## Hexagonal boundary

The domain function accepts a closed conflict classification and asks one injected claim port to
atomically admit its generation. GitHub discovery, filesystem persistence, scheduling, clocks,
credentials, and worker launch remain adapters. The domain returns a receipt; it performs no
provider effect.

```text
conflict classification -> claim router -> claim port -> durable adapter / scheduler
```

The claim identity is the classifier's existing generation:
`repository#pullRequest:baseOid:headOid`. `workKey` remains stable for the life of the pull request.

## Transition contract

Only `ESCALATION_REQUIRED` is eligible.

```text
ESCALATION_REQUIRED -> CLAIMED
ESCALATION_REQUIRED -> ALREADY_CLAIMED
ESCALATION_REQUIRED -> SUPERSEDED
anything else        -> NOT_ELIGIBLE
```

`CLAIMED` names an owner, lease expiry, generation, work key, classification revision, and the
expected prior durable revision. The atomic append of that claim is the linearization point.

## Concurrency invariants

- Two supervisors racing for one generation produce exactly one `CLAIMED` receipt.
- The loser performs no dispatch and receives `ALREADY_CLAIMED` or `STALE_REVISION`.
- Replaying the same owner and generation converges to the same durable claim.
- A new base or head supersedes an old generation before dispatch.
- An ambiguous claim response is reconciled by generation and owner before any retry.
- Dispatch occurs only after the durable claim is observable from the claim port.
- No claim authorizes merge, force-push, conflict-content selection, or protected-path mutation.

## Acceptance evidence

The public seam is `claimPrConflict(classification, request, ports)`. Contract tests prove
eligibility, exact identity binding, the two-supervisor race, replay, stale-generation refusal,
ambiguous-response reconciliation, and no dispatch before a durable winner exists. Tests use an
in-memory adversarial adapter; the existing append-only CAS ledger pattern is the production
adapter reference.

## Deferred slices

Producing merge-tree evidence, selecting a safe strategy, editing a worktree, verification, push,
GitHub reconciliation, DuckDB projection, and Gaia Now presentation remain separate slices. This
slice deliberately closes only the missing ownership transition.
