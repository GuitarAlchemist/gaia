# Pull-request conflict reconciler

Status: design only — issue #82, slice 1.

## Operator outcome

Gaia observes a pull request that GitHub proves is conflicting, binds the observation to one exact
`(repository, pullRequest, baseOid, headOid)` generation, and either names a registered mechanical
repair or publishes a bounded escalation. A running process, an occupied lane, and
`mergeable=UNKNOWN` are not conflict evidence.

## State model

```text
OBSERVED -> CLAIMED -> REPRODUCED -> AUTO_RESOLVABLE -> PATCHED -> VERIFIED -> PUSHED -> RECONCILED
                                  \-> ESCALATION_REQUIRED -> ESCALATED
```

`SUPERSEDED` and `FAILED_WITH_EVIDENCE` are also terminal. The idempotency key is
`repo#pr:baseOid:headOid`; one generation permits one active writer. A base or head change makes the
old actor lose before any push.

## Slice 1 boundary

The first implementation slice is read-only. It will:

1. distinguish `UNKNOWN`, `CLEAN`, and authoritatively `CONFLICTING` GitHub observations;
2. capture the exact base OID, head OID, merge base, and conflicting paths;
3. classify only against a closed, versioned strategy registry;
4. emit either `AUTO_RESOLVABLE` or `ESCALATION_REQUIRED` without editing a branch;
5. persist a GitHub-backed receipt that DuckDB may project but never own.

No automatic merge, commit, push, force push, `ours`/`theirs` selection, `rerere`, workflow edit,
credential change, or authority widening belongs to this slice.

## Registered strategy envelope

An automatic strategy must be deterministic and independently testable. Initial candidates are
byte-identical add/add content, authoritative generated output whose inputs are conflict-free, and a
lockfile regenerated from conflict-free manifests under the pinned toolchain. Arbitrary source
overlap, modify/delete, rename ambiguity, binaries, workflows, permissions, security policy,
schemas, and architecture contracts always escalate.

## Concurrency contract

The durable claim compares the observed base and head OIDs at admission and again immediately before
any future effect. Duplicate delivery converges on one claim and one receipt. A stale claimant ends
as `SUPERSEDED`; it cannot retry against a new generation under the old key.

## Evidence and metrics

The receipt records owner, generation, observation time, conflict paths, classification, strategy
refusals, attempt, deadline, and evidence links. DuckDB derives detection latency, reconciliation
time, strategy success rate, retries, CI duration, token/provider cost, and initial-estimate error.
Deleting and rebuilding DuckDB from GitHub evidence must reproduce the same metrics.

## Slice 1 acceptance

- `mergeable=UNKNOWN` never becomes a conflict.
- Concurrent duplicate observations yield one logical claim.
- A byte-identical fixture is classified as mechanically resolvable without mutation.
- A semantic source fixture is refused with owner, deadline, and exact paths.
- A changed base or head supersedes the prior generation.
- Tests prove the classifier is deterministic and the receipt vocabulary is closed.

