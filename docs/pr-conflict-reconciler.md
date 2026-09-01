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


## Slice 1 corrections, from reading the tooling

The design above was written before the tooling was read. Three of its claims did not survive that
read. `src/pr-conflict-reconciler.mjs` implements the corrections structurally rather than as
advice, and `tests/pr-conflict-reconciler.test.mjs` holds each one.

**Conflicting paths are injected evidence, not a field.** No provider mergeability response carries
the conflicting paths: `mergeable`, `mergeStateStatus`, `baseRefOid`, `headRefOid` and
`potentialMergeCommit` are all it returns. Point 2 of the slice boundary — "capture the exact base
OID, head OID, merge base, and conflicting paths" — is therefore unsatisfiable from a mergeability
read alone. Every observation names the source of its paths (`MERGE_TREE` from a merge performed
elsewhere, or `INJECTED_FIXTURE`), and a reading with no named source may carry no paths at all.

**Mergeability is bound to the exact generation or it is `UNKNOWN`.** A provider computes
mergeability asynchronously against whatever the base was at the time, and the OIDs are read
separately. An observation records whether the two agree; an `UNBOUND` reading decides `UNKNOWN`
whatever the provider said, and may carry no conflict evidence.

**Byte-identical add/add is not reachable from a real merge.** The `ort` driver resolves an add/add
whose two blobs *and* file modes agree without reporting it, so it can never appear in
`MERGE_TREE` evidence, and evidence claiming it did is refused as not having come from a merge. The
add/add a merge does report is identical content under a differing file mode — a permission change,
which this design already escalates. `IDENTICAL_ADD_ADD/1` stays registered and stays reachable
from a fixture source, so `AUTO_RESOLVABLE` is exercised code rather than a promise no test can
hold. Modes are read from tree entries, never from a checkout: `core.filemode=false` reports every
file as `100644` and would hide exactly this conflict.

**Work identity is separate from generation identity.** The single key `repo#pr:baseOid:headOid`
names a generation and cannot detect two live generations of one pull request. `workKey` is
`sha256(lowercased repository + "#" + number)` and is stable for the life of the pull request;
`generation` is the key above. Generations compare by equality only — an object name has no
temporal order, and comparing two with `<` is how a stale replay comes to look newer than a live
one. A claim carrying a foreign `workKey` is refused as a mis-delivery, not answered as
`SUPERSEDED`.

### Not in slice 1, and why

The remaining registry candidates — regenerated authoritative output, and a lockfile rebuilt from
conflict-free manifests — both require running a generator, which is an effect. They belong to the
registry version that ships with the executor. `src/github-read-adapter.mjs` cannot feed the
generation key either: it reports a literal `headOid: 'UNKNOWN'` and a `baseOid` taken from the
default branch tip rather than the pull request's base, so slice 2 must read `baseRefOid` and
`headRefOid` from the pull request itself.
