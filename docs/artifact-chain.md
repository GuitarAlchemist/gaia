# Artifact chain: accepted intent to publication evidence

Parent intent: [INTENT.md](../INTENT.md). Doctrine:
[engineering principles](engineering-and-research-principles.md). Boundary owner:
[ARCHITECTURE.md](../ARCHITECTURE.md). Prior decision this implements:
the [artifact chain decision](ai-native-sdlc.md#artifact-chain-decision), which named
the handoff shape and explicitly left dependency invalidation unimplemented.

This document is a design and usage record. It is not an activation receipt, not a
review, and not evidence that any stage it can describe actually succeeded.

## Mission brief (ENG-01)

**Actor.** A fresh agent or human reviewer who receives a partially completed Gaia
delivery and must decide whether the earlier artifacts still apply to the current
subject and code revision.

**Observed gap.** Gaia already produces the artifacts — an accepted intent file, a
factory candidate receipt, test output, an independent review artifact, a PR/publication
receipt — and doctrine already names required, advisory, and reference edges. Nothing
machine-checks that a given chain of those artifacts is internally consistent and still
fresh for the revision in front of the caller. Staleness is decided by prose today, so
an old review of an older head can be reused by accident.

**Constraints.** No dependency, no database, no scheduler, no general graph engine, no
GitHub effect, no credential. Freshness, quality, historical acceptance, and effect
authority stay separate axes (doctrine, Purpose section). Missing later stages must stay
missing. Artifact payload claims are unauthenticated text, so nothing here may report
that tests really passed.

**Success criteria.** A caller can (1) build a manifest from real files by digest,
(2) ask whether the chain is fresh *for an expected subject and expected root
revisions supplied by the caller*, and (3) get a typed refusal instead of a reassuring
answer when the input is malformed, escaping, unreadable, or self-contradictory.

**Falsifiable non-goals.** No automatic transition, no Markdown-triggered execution, no
authority grant, no cross-process atomicity claim, no verification of payload claims, no
new mandatory prerequisite file for any other repository.

## Design alternatives (ENG-02)

The seam is load-bearing: it creates a public module interface, a persisted document
schema, and a claim vocabulary that other stages would read. Two genuinely different
designs were carried far enough to compare, with a third recorded as rejected.

### A — Persistent workgraph store

A SQLite artifact/edge ledger, written by every stage, with invalidation propagated on
write and a query interface for downstream freshness.

- *Interface:* `openWorkgraph(path)` with `addArtifact`, `addEdge`, `invalidate`,
  `projectFreshness`.
- *Optimization target:* maximum adaptability; arbitrary graph shapes and history.
- *Hidden complexity:* schema migration, concurrent writers, a second authority-shaped
  store next to the existing autonomous-factory ledger, and a new corruption surface.
- *Failure modes:* the ledger becomes a second source of terminal truth that can
  disagree with Git and the existing receipts; an erased or replaced store silently
  looks like a fresh graph.
- *Reversibility:* migratable at best. Removing it later means removing writes from
  every stage that learned to write to it. Effectively a one-way door on stage code.
- *Testability:* needs a store fixture for every test; freshness logic and storage are
  entangled, so a pure replay test is not available.

### B — Pure validator over a digest-pinned manifest, plus a thin file adapter

One deterministic function family that takes an explicit descriptor or manifest and a
caller-supplied expectation and returns a report. A separate, small filesystem adapter
measures real files and performs immutable persistence. A CLI composes the two.

- *Interface:* `buildArtifactChain(descriptor) -> manifest`,
  `evaluateArtifactChain({ manifest, observed, expectation }) -> report`, plus
  `measureArtifactChainFiles` / `persistArtifactChainManifest` in the adapter.
- *Optimization target:* minimal surface and ports-and-adapters isolation; the policy
  module touches no filesystem, no clock, and no network.
- *Hidden complexity:* canonical encoding, stage ordering, transitive required-input
  staleness, digest pinning on each edge, path containment, and bounded reads — all
  hidden behind two calls.
- *Failure modes:* a manifest can describe artifacts that no longer exist (refused on
  observation, fails closed); a caller can pass the wrong expectation (reported as
  subject or root-revision mismatch, never silently accepted).
- *Reversibility:* freely reversible. The manifests are inert sidecar JSON; deleting the
  module and its sidecars removes a check and changes no existing receipt or behavior.
- *Testability:* the validator is a pure function, so replay, mutation, and negative
  controls need no fixture; only the adapter needs a temporary directory.

### C — Rejected: derive the chain implicitly from Git history

Infer stages from commit messages, file paths, and pull-request metadata.

Rejected: it invents structure from unstructured text, cannot express advisory versus
required edges, silently guesses when a convention is not followed, and would need the
GitHub provider to answer a local freshness question.

## Decision receipt

**Selected: design B**, with no hybrid. Design A is deferred until a measured need
exists for cross-stage queries that the manifest cannot answer; the doctrine's own
instruction in the artifact-chain decision was to measure before adding a graph engine.

- Reversibility class (ENG-07): **freely reversible**. Rollback path: delete
  `src/artifact-chain.mjs`, `src/artifact-chain-files.mjs`,
  `scripts/artifact-chain.mjs`, their tests, the sidecar emission in
  `scripts/github-portfolio-autonomous.mjs`, and any emitted `artifact-chain.json`
  sidecars. No existing receipt, schema, store, or transition changes, so no
  compensation is required. Trigger for rollback: the report's verdicts are found to be
  read as verification of payload claims, or the sidecar interferes with reconciliation.
- Deletion test (ENG-03): removing the module pushes canonical encoding, stage ordering,
  transitive required-input staleness, edge digest pinning, path containment, bounded
  reads, and immutable-write conflict detection back into every caller that wants a
  freshness answer. It does not make that work disappear.
- Authority (ENG-04): the module performs no effect, holds no capability, and reads no
  credential. The adapter is the only part that touches the filesystem, and the CLI is
  the only composition root that supplies it a path.
- No clock: freshness is decided by digest resolution, as in
  [`src/lineage-receipt.mjs`](../src/lineage-receipt.mjs). A stale chain means *refuse
  and re-derive*, never *use anyway*.
- Digest recipe: no new recipe. Documents use lowercase SHA-256 over the canonical
  UTF-8 JSON encoder already shipped in
  [`src/autonomous-factory-contract.mjs`](../src/autonomous-factory-contract.mjs);
  file artifacts use lowercase SHA-256 over their exact bytes.

### Decision: historical pins are producer evidence (ENG-02)

Independent review of head `2d6cb73006185ea1317cafb93a879214ab73f49e`
([thread](https://github.com/GuitarAlchemist/gaia/pull/146#discussion_r4057322217))
showed that deriving every dependency pin from the predecessor's current measurement can rebind an
old downstream artifact to newer evidence. Two repairs were compared before implementation.

- **Rejected: keep implicit current-measurement pins and rely on later observation.** This keeps the
  smaller descriptor, but creation erases the historical question: the resulting manifest records
  what the predecessor contains now, not what the dependent consumed when it was produced. A stale
  review can therefore become internally fresh merely by rebuilding its manifest.
- **Selected: require each descriptor dependency to carry its producer-recorded `pinnedDigest`.**
  `buildArtifactChain` validates and preserves that pin; it never synthesizes or replaces it from
  current measurements. Current measurements still supply each node's own `contentDigest`, and
  evaluation compares the preserved pin to that digest. A missing pin is a typed descriptor
  refusal. The descriptor remains unauthenticated evidence, so a malicious writer can still lie;
  this change prevents accidental rebinding and does not claim authenticity.

Reversibility class: **freely reversible**, but rolling back reintroduces the demonstrated stale-
evidence acceptance and is therefore permitted only with a replacement historical-binding seam.
The alternative of incrementally extending a prior manifest was deferred: it preserves pins but
adds lifecycle and previous-manifest ownership to a pure one-shot builder. The selected repair
changes no persisted manifest schema; it makes the creation descriptor honest about evidence only
the producer can know. The exact pre-repair inputs were `docs/artifact-chain.md`
`971aa8da5ed91a4d6c78d69ea7db84423890a5a58729afe6e270eeeed4c42679`,
`src/artifact-chain.mjs` `c91af5340654ade3f80e14bee8385438fb9552198aa4f859c4c08a94620c53de`,
`src/artifact-chain-files.mjs` `efca72e43b3f63c38644433eea96dc5bbd78efc24e3fcbb3b282fb229e1fc2db`,
and the independent finding linked above.

### Decision: where the byte ceiling is enforced (ENG-02)

The first adapter opened a descriptor, then called `statSync` on the *path* and
`readFileSync` on the descriptor. The size it checked and the bytes it read were two
different observations of a file an owning process may change in between, so the
promised ceiling was advisory: a file that grew after the check was read in full.
Two genuinely different repairs were considered.

- **Rejected: keep the path-based check and re-verify the size afterwards.** It is a
  smaller edit, but it keeps the window and only narrows it — the oversized bytes are
  already resident in memory by the time the second check runs, which is the cost the
  ceiling exists to avoid. It also leaves the path/descriptor mismatch in place.
- **Selected: decide the ceiling entirely from the open descriptor.** `fstatSync`
  measures the file the descriptor actually holds, and the read fills a `limit + 1`
  buffer at explicit positions and refuses when it comes back full. Growth of that
  opened file beyond the limit is refused. Replacing its pathname does not change the
  descriptor's inode: the bounded read returns the original opened bytes, not the
  replacement. Reversibility class: **freely reversible**;
  no format, receipt or manifest changes. The same primitive is used by the immutable
  comparison in `createImmutable`, which previously read an existing file unbounded.

`readBoundedDescriptor` is exported because the promised property belongs to the
descriptor, not to a path: exercising it needs a real open descriptor whose file
changes underneath, and an explicit `limit` argument lets a test demonstrate the
ceiling without writing four megabytes. Production callers always pass
`ARTIFACT_BYTE_LIMIT`. The alternative — a mutable module-level hook injected into the
measure-then-read window — was rejected for adding test-only mutable state to a module
whose whole point is that it holds no policy of its own.

### Exact inputs read for this decision

Lowercase SHA-256 over the file bytes at repository revision
`4da4112d1dd69e38782b1ca1ecd36e44c888cf66`:

| Input | Digest |
| --- | --- |
| `INTENT.md` | `2f02a3b57ada3f81acc169a6b06059df80990a01e6536477e0d303c546b7d803` |
| `CLAUDE.md` | `52eee081ce37c1db12bb2b76196ed63437752f1d124d8a12182456467107c024` |
| `ARCHITECTURE.md` | `82a1b55cc0fc6c7754dbf54ce470c3167ed28147e35e00721e24a8fb3ea64314` |
| `REVIEW.md` | `c55111522b573e7064c95300f898014a8e8d1248251eafb4fda5b5d18b37ae39` |
| `docs/engineering-and-research-principles.md` | `87db8bb227c6dc47ad3cae75d515652807b6c4e30fa6beb23bf4f2e92d33243a` |
| `docs/ai-native-sdlc.md` | `ba42109fe0f39251a99298954db5d9e1fad586564b86cb4cee96e321c306b9c4` |
| `src/github-portfolio-execution.mjs` | `4aa5fce1e12eb29b4fe22696d9832493f584d14b2753475196a107be5e6583b3` |
| `src/factory-agent.mjs` | `932e54b7c3eb049c7c514ad225be874e732deea445672c4d299a3862aec738d6` |
| `src/autonomous-factory.mjs` | `9ee434e439da6dfbc83e91df0d637f40e379c4e6a034c0fe5d62ac26ec6942de` |
| `src/autonomous-factory-contract.mjs` | `17a7c37224dd5bfa4b8f35b75e5a783da61de2b9ce7adc5f32eaff651a6dfa7f` |
| `src/autonomous-factory-store.mjs` | `38ac960b329b992ed52c2da46644d9583c0f025e74ba0bf8d6bd7a6d32d638cd` |
| `scripts/github-portfolio-autonomous.mjs` | `ab3e0a2b55102daddc2ce7d6ee784daded1487015db01090c2d167bdf66c9f5f` |
| `tests/autonomous-factory-host.test.mjs` | `76728a8127e1480a740e715745779982fa897a926b1756e98a5e3064be08700b` |

Semantic search was unavailable for this work; the inputs above were read exactly.

## The chain

Five stages in exactly this order:

```text
INTENT -> CANDIDATE -> TEST_EVIDENCE -> INDEPENDENT_REVIEW -> PUBLICATION_EVIDENCE
```

A manifest holds nodes. Each node names one artifact: its `stage`, a `subject` shared by
the whole manifest, a `rootRevision` (the 40-hex Git revision the artifact was produced
against, or `null` for an artifact that is not bound to one), a `producer`, a `locator`
relative to the manifest's root, the artifact's `contentDigest`, an optional `claim`, and
its `dependencies`.

Each dependency names the predecessor `nodeId`, a `relation` of `required`, `advisory`,
or `reference`, and `pinnedDigest` — the predecessor's content digest **as it was when
this node was produced**. The pin is what makes staleness detectable rather than
narrated.

Structural rules, enforced when a manifest is built and again when one is read:

- a node's dependencies must point to a strictly earlier stage, so a cyclic or
  self-referential input is refused rather than traversed;
- every non-`INTENT` node must carry at least one `required` dependency on a node of the
  *immediately preceding* stage, and an `INTENT` node must carry none, so a publication
  node cannot exist without a review predecessor and a stage cannot be skipped over;
- node identifiers are unique, dependencies within a node are unique, and a dependency
  must name a node present in the same manifest;
- `pendingStages` is computed, not supplied: it lists exactly the stages with no node.
  A manifest cannot claim a stage it does not carry, and cannot hide one it does.

## What a report says, and what it refuses to say

`evaluateArtifactChain` needs the caller's own `expectation`: the `subject` the caller
is actually asking about and the non-empty set of `requiredRootRevisions` the caller
considers current. A manifest for another subject is refused. A node pinned to a
revision outside that set is `STALE_ROOT_REVISION`. This is the mechanism by which a
self-consistent old chain cannot bless itself as current: its own bytes never supply the
expectation.

Per-node `freshness` is one of:

| Value | Meaning |
| --- | --- |
| `FRESH` | observed bytes match the recorded digest, the root revision is expected, and every `required` predecessor is itself `FRESH` |
| `CONTENT_CHANGED` | the observed bytes do not hash to the recorded digest |
| `PIN_MISMATCH` | a `required` predecessor's recorded digest differs from the digest this node pinned |
| `STALE_REQUIRED_INPUT` | a `required` predecessor is not `FRESH`, transitively |
| `STALE_ROOT_REVISION` | the node's root revision is not in the caller's expected set |

An `advisory` or `reference` predecessor that has moved — either its bytes changed or this
node pinned a different version of it — is reported in the node's
`changedAdvisoryInputs` and never affects `required` freshness. A node bound to a
revision outside the caller's set reports `STALE_ROOT_REVISION` for itself rather than
inheriting a reason from a predecessor.

The report also carries `rootRevisionBinding`. A node whose `rootRevision` is `null` is
bound to no revision at all — correct for an accepted intent, which precedes any
revision — but a chain in which *every* node is like that never consults the caller's
expectation and would answer `CHAIN_FRESH` for any revision whatsoever. That is exactly
the self-blessing the expectation exists to prevent, so such a chain is reported
`rootRevisionBinding: 'UNBOUND'` and is never `CHAIN_FRESH`, even when every one of its
nodes resolves. `BOUND` means at least one node pins a root revision the caller listed.

The report's `verdict` is `CHAIN_FRESH` only when `rootRevisionBinding` is `BOUND` and
every present node is `FRESH`, and `CHAIN_STALE` otherwise. `CHAIN_FRESH` is a statement about digests and edges. It is
**not** a statement that tests passed, that a review approved anything, or that a
publication happened. Every node's `claim`, if present, is reported under
`claimStatus: 'ASSERTED_NOT_VERIFIED'`, and the report carries no field whose name or
value asserts verification. Every occurrence of `VERIF` in a report is part of
`ASSERTED_NOT_VERIFIED`, and a test asserts exactly that.
`pendingStages` is echoed as absence: a stage with no node is reported
`NOT_PROVIDED`, never `PASSED` and never `FRESH`.

Every identifier, revision, and digest is required to *be* a string before its pattern
is applied. `RegExp.prototype.test` stringifies its argument, so an unguarded check
accepts `1234` as a node identifier and `['<40 hex>']` as a root revision; the resulting
non-string then compares unequal to every string it is matched against, producing
refusals and staleness for a reason no reader could find. Shape is checked first.

## Usage

```text
node scripts/artifact-chain.mjs create --root <dir> --descriptor <file.json> [--manifest <out.json>] [--json]
node scripts/artifact-chain.mjs validate --root <dir> --manifest <file.json> --subject <text> --root-revision <40-hex> [--root-revision <40-hex>]... [--json]
```

`create` reads a bounded JSON descriptor, hashes each named artifact file through the
adapter — the descriptor never supplies a digest — and prints or writes the canonical
manifest. Writing is immutable: a create-if-absent open, and if the file already exists
its bytes are compared. Identical bytes are `UNCHANGED`; different bytes are refused as
`ManifestConflict` rather than overwritten, so two concurrent writers cannot silently
disagree. Re-running `create` against unmoved files rewrites byte-identical bytes.

`validate` re-measures every locator and evaluates the chain against the expectation
supplied on the command line. Exit codes: `0` created/unchanged or `CHAIN_FRESH`, `1`
`CHAIN_STALE`, `2` usage error, `3` typed refusal with nothing written.

A descriptor is a JSON object with `subject` and `nodes`; each node supplies `id`,
`stage`, `rootRevision`, `producer`, `locator`, optional `claim`, and `dependencies`
with `nodeId`, `relation`, and the producer-recorded `pinnedDigest`. The builder
preserves those historical pins and never replaces them with current measurements.
Descriptors are unauthenticated evidence and can lie; requiring the field prevents
creation from silently rebinding an old dependent to a newly measured predecessor.

### Worked example

`tests/artifact-chain-cli.test.mjs` builds a temporary five-file fixture — an intent, a
candidate receipt, a test log, a review artifact, and a publication receipt — creates
the manifest through the real CLI in a subprocess, validates it `CHAIN_FRESH`, then
edits one byte of the intent file and shows the whole downstream chain reported
`CHAIN_STALE` with the candidate `STALE_REQUIRED_INPUT` and the intent
`CONTENT_CHANGED`, exit code `1`.

## Candidate-stage sidecar from the autonomous CLI

When a tick of `scripts/github-portfolio-autonomous.mjs` reaches a terminal autonomous
receipt, the CLI writes `artifact-chain.json` beside that job's existing
`receipt.json`, from the job intent already stored in the authority ledger and the
receipt bytes already on disk. The sidecar carries exactly two nodes — the accepted job
intent and the candidate — and therefore reports `TEST_EVIDENCE`,
`INDEPENDENT_REVIEW`, and `PUBLICATION_EVIDENCE` as `NOT_PROVIDED`. A
`CANDIDATE_REJECTED` receipt is recorded just as honestly as an accepted one; the
sidecar states which.

What the candidate node hashes is the historical `receipt.json` that the completed run
already wrote, bound to `intent.draft.headRevision` — the input base the job was
admitted against. It is **not** a hash of the current candidate tree, of an uncommitted
working copy, or of whatever that worktree contains now. Re-evaluating the sidecar
therefore answers "does the evidence this run produced still describe the base it was
produced from", not "is the code in front of me the code that was tested". Reading it
as the latter would be reading a receipt as a build.

This changes no existing schema and preserves the original receipt and the
reconciliation path. Sidecar emission is strictly after the store's terminal
transition, cannot throw into it, and reports itself in a separate `artifactChain`
field of the tick result (`WRITTEN`, `UNCHANGED`, or `FAILED` with a code). Before each
later host tick schedules work or applies policy and budget gates, it replays every
COMPLETED receipt through the same idempotent emitter. Non-`UNCHANGED` outcomes are
reported in `artifactChainRecovery`; one failure neither stops another replay nor
prevents unrelated eligible work. A sidecar failure therefore never reruns a completed
worker, never consumes authority or a run, and never frees or occupies the host slot.

### Decision: `WRITTEN` follows namespace synchronization (ENG-02)

Independent review of head `7a458e479aacc6417fd56236634e0293a41a8d84`
([thread](https://github.com/GuitarAlchemist/gaia/pull/146#discussion_r4057534493))
showed that flushing file contents before publication did not flush the new directory entry before
returning `WRITTEN`. Two perspectives and three placements were compared before implementation.

- **Caller perspective — rejected: synchronize in the autonomous host.** That misses the standalone
  manifest writer, stored-intent writes, and future callers of the immutable primitive.
- **Contract perspective — rejected: redefine `WRITTEN` as merely visible.** This would weaken the
  existing durability claim and give callers no closed result for a file whose bytes are stable but
  whose published name has not crossed the available synchronization boundary.
- **Filesystem perspective — selected: synchronize the publication inside `createImmutable`.** The
  temporary bytes are flushed, the final name is created without replacement, the temporary name is
  removed, and then the publication boundary is flushed before `WRITTEN`. A complete destination is
  preserved after a synchronization refusal; byte-identical retry repeats the boundary flush before
  returning `UNCHANGED`. No conflicting destination is ever replaced.

On POSIX, Node exposes the required parent-directory descriptor and the implementation fsyncs it.
On Windows, Node exposes no portable directory-fsync primitive; the implementation reopens the
published file writable and flushes that handle, the strongest per-entry metadata flush available
through the supported runtime. The immutable replay path remains the restart repair on either
platform. Reversibility class: **freely reversible in code but unsafe for crash durability**. The
exact pre-repair inputs were `src/artifact-chain-files.mjs`
`ef0d6f6fe4e96f4e0381863ed903faa4507098b488779e66d828ed1c54af882e`,
`tests/artifact-chain-bounds.test.mjs`
`99086790ec9b3b46a5ef933af7281799b08421bfb648a13d95d2fc3a73696b12`,
`docs/artifact-chain.md` `13429f4e0543cfa9f16d4556d8803453d53cb1fce2c23997661cd0902a97578f`,
and the independent finding linked above.

## Boundaries and residual risk

- The evaluation is a local read of local bytes at one instant. It is **not** a
  cross-process atomicity claim: a file may change between measurement and use, and
  concurrent writers are detected only by byte comparison on create.
- Path containment rejects escaping locators, absolute locators, and symlinked
  components, and bounds artifact size. This is a boundary against mistakes and
  malformed input within one trusted OS user, not an OS sandbox.
- Manifests are unauthenticated. Anyone who can write the file can write any claim into
  it. That is precisely why claims are reported as asserted and why the caller, not the
  manifest, supplies the expectation.
- Historical acceptance is untouched. A stale chain does not revoke a past review or
  grant replacement authority; it only says the old evidence no longer applies to the
  revision in front of the caller.
- No stage transition, scheduler, or publication is automated here. Emitting a sidecar
  is not a claim that the later stages exist.
