# Decision Receipt — holdout-safe lineage receipt

**Status: a record, not an authorisation.** This document says what was decided, what it was
decided against, and what would reverse it. It approves nothing, unblocks nothing, and confers
no authority on anyone. It is the Decision Receipt clause 6 of
[`docs/engineering-and-research-principles.md`](engineering-and-research-principles.md)
requires, and it mirrors [`docs/context-capsule-design.md`](context-capsule-design.md) in shape.

## 1. What was bound

| Input | Identity |
|---|---|
| Design report | `gaia-holdout-safe-reporting-design-r1.md`, 90,789 bytes, SHA-256 `0cc24d45e08f5e1aac3b824a819e778ebde3169b3871e3c88b2a4e46c3d3fe37` |
| Doctrine (shipped) | [`docs/holdout-safe-reporting.md`](holdout-safe-reporting.md) |
| Review-sufficiency Standards report | `gaia-fh1-context-capsule-standards-review.md`, SHA-256 `b501fa496e0de8b9404f23cabdba4a56738919525bef85ca0cfd20218c30f9c5`, verdict APPROVE |
| Review-sufficiency Spec report | `gaia-fh1-context-capsule-spec-review.md`, SHA-256 `c0794f9453771c1b28804520eda766fdc26d848d27a28c1f4f08c7a0b832f3c7`, verdict APPROVE |

The two review reports are the `F-H1` experiment the doctrine's §13 stop gate requires: two
independent reviewers, working from an already-approved revision and a single-revision receipt,
each rendered a verdict. Both rendered one. The gate is therefore passed on evidence rather
than on assertion, and the module was built only after it was.

Digest recipe throughout: `ordinal-path-bytes-sha256/1` for trees, plain lowercase SHA-256 over
canonical UTF-8 JSON for documents. **No new recipe was introduced.**

## 2. The problem

A quantity leaks if it is a function of **both** revisions. For a per-file holdout population
over a revision pair, the label vector *is* the changed/unchanged split. Under ordinary review
practice, the procedure that entitles a population to be evaluated — an independent Standards
review and an independent Spec review, each showing it measured something — is the same
procedure that publishes that split. Entitlement and unexposedness become mutually exclusive,
and the population is burned by the act that entitles it. There is no repair.

## 3. The three designs considered

**Design 1 — a progressive-disclosure reference document linked from the shipped skill.**
Doctrine only: state the rule, point the skill at it, rely on people following it. Cheapest, and
it covers the one channel no machine covers — a human writing a sentence. It has no control: its
failure mode is silence, and a control whose failure mode is "nothing happens" is not a control.

**Design 2 — a structured public receipt paired with a sealed curator manifest.** One deep
module producing two documents on two separate channels: an open receipt with a closed,
exhaustively enumerated field set returned to the caller, and a sealed manifest carrying every
cross-revision row handed to a write-only sink and never returned. Enforcement where enforcement
is possible; honesty where it is not.

**Design 3 — an explicit holdout mode with machine-enforced field restrictions**, including a
validator that scans candidate open prose and refuses forbidden shapes. Maximum apparent
enforcement. It fails complete mediation structurally — the documents that leak are not in this
repository — and it fails honesty, because it advertises an invariant it cannot hold. Building a
scanner does not convert an evidentiary property into a cryptographic one; it only hides which
kind it is.

## 4. The selection

**Design 2, grafted with exactly one element from Design 1 and exactly one from Design 3.**

1. **From Design 2 — everything.** The module, the closed field set, the sealed manifest on a
   separate channel, the exposure register, the content addressing, the refusal contract, the
   negative controls.
2. **From Design 1 — the reference document and the skill link, and nothing else.**
   [`docs/holdout-safe-reporting.md`](holdout-safe-reporting.md) states the one rule and the
   forward-scope-statement rule across every open document class, and the shipped skill points
   at it. This covers the freehand-prose channel, and it is **deliberately labelled doctrine
   rather than control**.
3. **From Design 3 — the mode selector only, never the scanner.** A lineage is *declared*
   sealed, and the declaration changes what the tooling emits and refuses the combinations that
   make no sense: a sink in unsealed mode, no sink in sealed mode, a sealed manifest path inside
   any measured or declared open root. No prose validator, no rule set, no template subsystem.

## 5. What was built

| Path | New / modified |
|---|---|
| `src/lineage-receipt.mjs` | new — the deep module |
| `tests/lineage-receipt.test.mjs` | new — the controls, written first |
| `scripts/lineage-receipt.mjs` | new — the CLI, exit codes `0` ok / `2` usage / `3` fail-closed |
| `docs/holdout-safe-reporting-design.md` | new — this receipt |
| `src/inventory.mjs` | modified — containment guard generalised to a root set and its ancestor walk taken to the filesystem root, with exhaustion of the runaway guard refusing rather than permitting; `assertManifestOutsideRoot` kept as a thin caller |
| `README.md` | modified — module rows, one section, gate count |

Deliberately untouched: `src/bus-core.mjs`, `src/event-log.mjs`, `src/mcp-server.mjs`,
`src/mcp-client.mjs` (the six verbs and their transport), `src/verify.mjs`,
`src/context-capsule.mjs`, `src/templates.mjs`, `scripts/gaia-interagent.mjs`, every existing
test file, and the shipped doctrine, skill pointer and product-test gate from the doctrine phase.

## 6. The schemas

```
gaia-lineage-receipt/1            — the open receipt (returned; publishable)
gaia-lineage-sealed-manifest/1    — the cross-revision document (sink only; never returned)
gaia-lineage-exposure-register/1  — append-only release records (open; names, never labels)
gaia-lineage-error/1              — typed refusal (no path, no row, no cardinality, no adapter diagnostic)
```

The open receipt's field set is **closed**: `schema`, `recipe`, `lineage_id`, `sealed`,
`successor.{count,bytes,digest}`, `sealed_manifest.{schema,digest}`, `cleanliness`, `evidence`,
`tests`, `verdict`, `notes_digest`. In sealed mode there is **no predecessor field of any kind**,
and `sealed_manifest.bytes` is **forbidden** — the manifest's length is close to linear in the
number of changed rows, so publishing it would publish the cardinality while naming no path.

## 7. Invariants the seam holds

- **I-1.** For a sealed lineage, no open artifact contains a cross-revision derived quantity.
- **I-2.** The open artifact's field set and byte length are invariant to the size of the change.
- **I-3.** Every open claim is recomputable by a third party from a single revision they hold,
  or is a digest whose preimage lives in the sealed store.
- **I-4.** The sealed document never crosses the seam into the caller's return value. Two
  channels, not one filtered channel — and there is no code path that returns it.
- **I-5.** Same inputs, byte-identical outputs, on any host, locale, timezone and filesystem.
  No wall-clock field anywhere; the module reads no clock.
- **I-6.** Unsealed lineages behave exactly as today. The seam is opt-in per lineage.
- **I-7.** A sealed store sited inside a measured root or a declared open store is refused
  **before any write**, at **any nesting depth**. Containment is decided by walking the
  target's whole chain of ancestors to the filesystem root; there is no depth at which the
  check stops. The walk carries a runaway guard, and exhausting that guard **refuses** — an
  undecided containment is never reported as a permitted one.

### 7.1 What a refusal guarantees, stated exactly

A refusal is fail-closed, and the CLI reports it as exit 3. The guarantee is that **nothing
was published**. That is narrower than "nothing was written", and it is the sentence that is
actually true.

- **Before any write.** Containment is decided before any file *of either measured root* is
  read and before any parent directory is created. No refusal writes inside a measured root or
  a declared open store. (The `--declaration` file is read before this point. It is the
  caller's own file, nothing is measured from it, and its path is not constrained here — which
  is why the guarantee is stated about the measured trees and not about reads in general.)
  This is the guarantee that carries the leak-prevention property, and nothing below weakens
  it.
- **After the sealed write.** The write order is payload before pointer: the sealed manifest
  is made durable before the open receipt names its digest. A refusal raised after that
  point — a replay divergence, for instance — therefore leaves the sealed manifest
  **orphaned in the sealed store**. It publishes nothing: no open receipt points at it, no
  open artifact carries its digest, and the sealed store is by construction outside every
  measured root and every declared open store.

The two properties are in genuine tension and cannot both be had. Payload before pointer is
the right choice, because the failure it admits — an orphan in the sealed store, which
publishes nothing — is strictly better than the one it prevents: a receipt naming a digest
that never became durable, which is a refusal for every consumer of it. So the wording is
corrected to match the order, rather than the order changed to match the wording.

## 8. What it does not do

It does not close the freehand-prose channel — doctrine covers that, and doctrine is not a
control. It does not make the vector unknowable: anyone holding both revisions computes it in
one command, and no module prevents that. What sealing changes is the *character* of exposure,
from obligatory and unenumerable to voluntary and partly enumerable. The property obtained is
**evidentiary, not cryptographic**. It adds no bus verb and widens none — the surface stays
exactly `register`, `send`, `inbox`, `ack`, `heartbeat`, `handoff`. It changes no digest recipe.
It constitutes no curator, mints no seal, and grants no authority: a `verdict` records a decision
someone made under their own authority.

## 9. Reversibility

**Reversibility class: freely reversible** until the first seal — while the module has no bus
export, no MCP export, no persistent schema consumer and no production adapter, deleting it, its
tests, its CLI and its documentation removes the behaviour with no data migration.

**The trigger that qualifies it:** the moment a sealed store contains a manifest that an external
proof cites. From then on the class is *migratable*, because deleting the module would leave a
digest whose preimage nothing can regenerate. The migration, if ever needed, is to publish the
derivation recipe so a third party can regenerate the manifest from the two roots.

**Migration:** none to perform. Sealing is forward-only. Burned lineages stay burned; this design
neither restores nor appears to restore them, and any future tool that appears to offer a
retrospective seal should be rejected on that ground alone.

## 10. Rejection criteria, preregistered

Reject this seam if any of the following becomes true:

1. Cardinality non-derivability cannot be made to pass because some open field reviewers insist
   on is unavoidably a function of the changed count.
2. Two independent reviewers state that the open receipt is insufficient for a verdict.
3. No sealed-store siting satisfies identity-based containment on the target filesystem.
4. The implementation requires a seventh bus verb, a change to the frozen external crate, or a
   new digest recipe. Any one of these means the design is wrong, not that the constraints are.
5. The open receipt acquires a wall-clock field.

## 11. Residual UNKNOWNs

- **`UNKNOWN{ExposureEnumerability}`** — whether exposure is enumerable in practice, given that
  any holder of both revisions can re-derive the vector without registering. The register is
  partial evidence, never an invariant.
- **`UNKNOWN{ReviewSufficiencyUnderSeal}`** — tested once, on one already-approved revision, by
  two independent reviewers who both rendered a verdict. One observation, not a distribution.
- **`UNKNOWN{ExposureProofCompleteness}`** — that no open document carries a label vector is an
  unprovable negative. Recorded as unknown, not asserted.
- **`UNKNOWN{OpenDocumentClassClosure}`** — whether the open document classes are enumerable at
  all. The doctrine states a rule rather than only a list for this reason.
- **`RESIDUAL{TSealDeclarationSource}`** — the design report requires a `t_seal` prose statement
  in the sealed manifest but does not say where it comes from, and its declaration field list
  omits it. It is carried on the declaration as `tSeal`, **required in sealed mode and refused in
  unsealed mode**. Generating it was rejected because that needs a clock, and a constant would be
  prose that says nothing about this seal. Flagged for independent review rather than settled
  here.
- **`RESIDUAL{RefusalArtifactWordingElsewhere}`** — §7.1's correction is applied here and in
  the CLI's own header. Two documents outside this lane's write scope still carry the older
  absolute wording and need the same correction from whoever owns them: the module header of
  `src/lineage-receipt.mjs` ("no artifact on any path, no partial output") and the refusal
  bullet of [`docs/holdout-safe-reporting.md`](holdout-safe-reporting.md) ("A refusal
  produces no artifact on any path"). Neither is a defect in behaviour; both are sentences
  stronger than payload-before-pointer can deliver. Recorded rather than quietly edited,
  because those two files are protected in this lane.
- **Refusal disclosure, deliberately narrower than the report.** The report says a replay
  divergence is reported "with both digests". In sealed mode a predecessor digest reported beside
  a lineage id publishes the pairing, which is a cross-revision quantity. A sealed-mode
  predecessor divergence therefore names the side only; the successor's own digests, being
  single-revision, still travel. This is a tightening, not a narrowing of a control, and it is
  recorded here so a reviewer rules on it rather than discovering it.

## 12. Inventory-routing amendment before `t_seal`

The lineage receipt protects one structured output, but official handoffs and reviews could still
publish their own cross-revision prose beside it. Before a future `t_seal`, the reporting process
therefore needs one structural entry point that owns the split between private evidence and the
public commitment. This amendment records that seam; it authorises no seal or publication.

### 12.1 Design It Twice

Three materially different interfaces were considered:

| Interface | Depth and locality | Principal failure mode | Decision |
|---|---|---|---|
| Six class-specific Markdown templates | shallow; policy duplicated in every producer | one template drifts, a future class bypasses the others, and arbitrary prose remains | reject |
| A validator scanning completed prose | apparently central but semantically shallow | synonyms, encodings, and document length leak without matching a forbidden token | reject |
| One typed finalizer over `buildLineageReceipt` | deep; one call owns validation, channel order, public schema, and delegation | callers can bypass it with freehand prose, which remains an explicit doctrine residual | select |

A curator service or gateway was also considered. It would provide stronger process isolation but
would add persistence, deployment, and authentication before a second real adapter exists. Defer
it until two consumers demonstrate that the in-process seam is insufficient.

### 12.2 Selected interface

`finalizeInventoryRoutedReport(request, sealedWrite)` accepts an exact policy, one of six exact
artifact classes, producer and peer roles, input receipt digests, an existing lineage declaration,
and either open or private evidence. In sealed mode it writes canonical private evidence first,
then delegates to `buildLineageReceipt`, then returns a canonical closed-field public report. It
returns neither detailed evidence nor the sealed lineage manifest. In unsealed mode it preserves
ordinary open evidence and the existing unsealed receipt without a write capability.

Policy version 1 closes exactly these classes: `handoff`, `standards-review`, `spec-review`,
`reconciliation`, `preflight`, `readiness`. A new class cannot inherit the old policy by analogy;
it requires a new policy digest and activation receipt before sealing.

### 12.3 Invariants and refusals

- Private evidence is durable before the lineage manifest; no public report exists until both
  writes succeed. A later failure can leave a private orphan, never a partial public artifact.
- The returned JSON contains no arbitrary prose and is canonical, deeply frozen, and independent
  of input receipt ordering.
- Curator, Standards reviewer, and Spec reviewer refs are distinct. Each artifact class has one
  exact producer role. These refs are assertions, not authentication or delegated authority.
- Detailed Standards and Spec evidence may inspect both revisions privately. Review quality is not
  traded away; exposure disqualifies that reviewer from later evaluating the population.
- The six bus verbs remain exactly `register`, `send`, `inbox`, `ack`, `heartbeat`, `handoff`.
- Typed refusals are bare and leak-free: `RoutingPolicyRequired`, `RoutingPolicyDigestMismatch`,
  `RoutingPolicyOrderUnverifiable`, `ArtifactClassNotRouted`, `ReportFieldSetViolation`,
  `RoleSeparationViolation`, `SealedSinkRequired`, `SealedSinkForbidden`, `ArtifactConflict`.

### 12.4 Negative controls

The minimum test surface refuses a missing, duplicate, or extra routed class; unknown classes;
open prose in sealed mode; private evidence in unsealed mode; a missing write capability or a
readable Adapter passed in its place; policy or
activation mismatches; curator/reviewer collapse; wrong producer roles; non-canonical private data;
and sink diagnostics containing private paths. It also proves all six positive classes, private-
before-manifest ordering, deterministic input ordering, successor-safe public JSON, and unchanged
unsealed behaviour.

### 12.5 Store, migration, and reversibility

A curator-only sealed store is required for the claimed process boundary. Producers receive one
captured write function; curator access control is supplied outside this module. The finalizer
accepts no Adapter object, so prototype methods, getters, and readable surfaces do not cross the
seam. It also owns and freezes a descriptor-validated canonical copy of the request before its
first asynchronous write. This JavaScript capability is still not cryptographic isolation when
code shares one operating-system principal, and the design must not claim otherwise.

Open reports remain signable because the finalizer returns canonical UTF-8 JSON containing fixed
policy, activation, evidence, and lineage commitments without publishing changed-path vectors.
Signing is deliberately outside this module; a signature would attest those bytes under an
external identity system, not make the hidden evidence public.

The amendment is freely reversible until an external consumer cites an R1 report. Thereafter it is
migratable: retain the canonical report preimage, policy and activation receipts, and support the
old schema while a new policy version is activated. Never reinterpret an old digest in place.

Reject or redesign the seam if a meaningful independent verdict cannot be produced while detailed
evidence stays private; a deployed sink is readable by producers despite its declared boundary; an
unknown class reaches publication; or a seventh bus verb becomes necessary.
