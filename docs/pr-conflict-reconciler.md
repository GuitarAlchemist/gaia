# Pull-request conflict reconciler

Status: issue #82 slice 1 is implemented as a pure, read-only classifier. Everything after the
classification boundary remains lifecycle design only.

## Operator outcome

Given a structured observation, the shipped module validates whether mergeability was independently
bound to one exact `(repository, pullRequest, baseOid, headOid)` generation. It returns a frozen,
content-addressed reading. A running process, an occupied lane, and `mergeable=UNKNOWN` are not
conflict evidence.

## Lifecycle design (not shipped in slice 1)

```text
OBSERVED -> CLAIMED -> REPRODUCED -> AUTO_RESOLVABLE -> PATCHED -> VERIFIED -> PUSHED -> RECONCILED
                                  \-> ESCALATION_REQUIRED -> ESCALATED
```

`SUPERSEDED` and `FAILED_WITH_EVIDENCE` are also intended terminal states. The intended idempotency
key is `repo#pr:baseOid:headOid`; later slices must enforce writer ownership and make an old actor
lose before any push when the base or head changes.

This diagram is the intended later lifecycle, not behavior supplied by the current module. Slice 1
has no producer, durable claim, claim owner, lane, persistence layer, escalation receipt, executor,
branch mutation, commit, push, reconciliation loop, DuckDB projection, or UI. Consequently, slice 1
does not establish a single-writer guarantee and cannot perform any transition after classification.

## Slice 1 boundary

The implemented first slice is read-only. It does exactly the following:

1. validate the closed `gaia-pr-conflict-observation/2` shape;
2. require `EXACT_OIDS` to carry independent binding base/head OIDs equal to the observation OIDs,
   while `UNBOUND` carries null binding OIDs, no conflict evidence, and reads as `UNKNOWN`;
3. parse a supplied claim generation and require the same normalized repository and pull request
   before a valid stale generation can return `SUPERSEDED`;
4. classify against `gaia-pr-conflict-strategies/2`, whose registry is currently empty, so a proven
   conflict returns `ESCALATION_REQUIRED`;
5. return one deterministic in-memory reading with `effect: NONE` and `authority: NONE`.

The other non-conflicting outcomes are `UNKNOWN` for incomplete or unbound evidence and `CLEAN` for
an exactly bound clean observation. Only an exactly bound `CONFLICTING` observation can enter the
conflict-classification path.

`AUTO_RESOLVABLE` remains a reserved classification token for a future registry version with a
mechanically reachable authoritative strategy. Slice 1 cannot emit it.

No automatic merge, commit, push, force push, `ours`/`theirs` selection, `rerere`, workflow edit,
credential change, or authority widening belongs to this slice.

## Registered strategy envelope

An automatic strategy must be deterministic, independently testable, and reachable from
authoritative production evidence. Registry version 2 contains no strategies. In particular,
byte-identical add/add exists only as injected fixture evidence because `ort` resolves that shape
without reporting a conflict. A fixture cannot authorize automation.

The protected-path policy is closed and explicit: `.env`, `SECURITY.md`, `ARCHITECTURE.md`, `.git/`,
`.github/`, and `docs/contracts/` always receive `PROTECTED_PATH`. Binaries, permission changes,
semantic source overlap, modify/delete, rename ambiguity, incomplete evidence, and every other
unregistered shape also escalate.

## Identity semantics in slice 1

`workKey` is stable for one normalized repository and pull request. `generation` is
`repo#pr:baseOid:headOid`, with each OID exactly 40 or 64 lowercase hexadecimal characters. A claim
with a foreign repository or pull request, a malformed OID, or a mismatched work key is refused. A
well-formed claim for a stale generation of the same pull request reads as `SUPERSEDED` before the
current observation's mergeability or paths are exposed.

These are pure classification semantics, not a durable concurrency protocol. Claim persistence,
compare-and-swap, ownership, retries, deadlines, and pre-effect revalidation belong to a later slice.

## Evidence boundary

The function returns a content-addressed reading containing the observation identity, generation,
mergeability, evidence source, conflict paths, classification, and refusal set. It does not persist
that reading or add owner, attempt, deadline, evidence links, or metrics. A future producer and
durable ledger must define those contracts before DuckDB or UI projections can exist.

## Slice 1 acceptance

- `mergeable=UNKNOWN` never becomes a conflict.
- Duplicate inputs replay to a byte-identical in-memory reading; no durable claim is implied.
- A byte-identical fixture escalates because no authoritative strategy is registered.
- A semantic source fixture is refused with exact paths and no invented owner or deadline.
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
separately. `EXACT_OIDS` therefore carries `bindingBaseOid` and `bindingHeadOid`, and both must equal
the observation OIDs. `UNBOUND` carries null binding OIDs, decides `UNKNOWN` whatever the provider
said, and may carry no conflict evidence.

**Byte-identical add/add is not reachable from a real merge.** The `ort` driver resolves an add/add
whose two blobs *and* file modes agree without reporting it, so it can never appear in
`MERGE_TREE` evidence, and evidence claiming it did is refused as not having come from a merge. The
add/add a merge does report is identical content under a differing file mode — a permission change,
which this design already escalates. Registry version 2 removes the fixture-only strategy;
`AUTO_RESOLVABLE` is reserved but unreachable until authoritative production evidence supports a
registered strategy. Modes are read from tree entries, never from a checkout:
`core.filemode=false` reports every file as `100644` and would hide exactly this conflict.

**Work identity is separate from generation identity.** The single key `repo#pr:baseOid:headOid`
names a generation and cannot detect two live generations of one pull request. `workKey` is
`sha256(lowercased repository + "#" + number)` and is stable for the life of the pull request;
`generation` is the key above. Generations compare by equality only — an object name has no
temporal order, and comparing two with `<` is how a stale replay comes to look newer than a live
one. The generation is parsed back to the same normalized repository and pull request, and each OID
must be exactly SHA-1 or SHA-256 length. A foreign or malformed generation and a foreign `workKey`
are refused as mis-deliveries, not answered as `SUPERSEDED`.

### Not in slice 1, and why

The remaining registry candidates — regenerated authoritative output, and a lockfile rebuilt from
conflict-free manifests — both require running a generator, which is an effect. They belong to the
registry version that ships with the executor. `src/github-read-adapter.mjs` cannot feed the
generation key either: it reports a literal `headOid: 'UNKNOWN'` and a `baseOid` taken from the
default branch tip rather than the pull request's base, so slice 2 must read `baseRefOid` and
`headRefOid` from the pull request itself.
