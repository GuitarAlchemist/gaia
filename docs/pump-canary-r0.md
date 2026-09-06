# Pump canary R0: admission and evidence contract

## Receipt-bound worker selection (2026-09-06, local candidate)

Live evidence: intake run 34000957531 created Draft #123 for issue #122. The
fresh portfolio instead schedules Demerzel #401 first, and Gaia #53 for its Gaia
lane. Passing the Draft receipt to the operator therefore cannot select its task.

Bounded repair: the existing Draft admission port may expose a read-only
`target()` returning repository, item kind and number from its validated receipt.
The factory selects that exact item from the full fresh portfolio, only if it
is READY or READY_WITH_UNKNOWN. Missing, blocked or malformed targets refuse;
there is no fallback to unrelated work. Without this optional method the existing
schedule remains unchanged. No labels or global priorities are rewritten.

The receipt selects work but grants nothing. Fresh Draft readback, snapshot
comparison, typed intent, encrypted-key unlock and atomic grant consumption
remain required. The same selection runs before preview and execution; a changed
snapshot refuses before consuming authority. Public proof seams: factory
`advance()` and the shipped operator composition. Cover a different repository
and earlier issue ahead of the target, non-ready/missing targets and malformed
selection. No new executor, grant, bus verb, or cross-host guarantee is introduced.

Related: #40

Status: work admitted for design; implementation and autonomous execution are not proven.
Accountable owner: Codex coordinator. Independent reviewers are not writers.

## Captured correction: Draft before code

When an agent takes ownership of implementation work, create or reuse a linked
Draft PR before production-code edits. An incomplete design is not a reason to
delay the Draft. Seed it with the bounded outcome, owner, open questions,
acceptance checklist and next expected proof.

Verify the returned PR against GitHub: repository, issue link, head branch,
OPEN state and isDraft=true. An attempted command or local branch is not proof.
If creation fails or the response is ambiguous, reconcile existing PRs before
retrying and record an admission blocker; do not claim an active code lane.
One work item has one accountable writer and one reconciled Draft, not a new
Draft per retry. This document records the rule; runtime enforcement is pending.

## Smallest outcome

One explicitly admitted issue reaches one Draft, one real subscription-backed
agent execution and one independently verified result through the pump.
Every transition carries a common operation identity and timestamped evidence.
A manually launched helper or a green scheduled observation is not this outcome.

## Acceptance checklist

- [ ] A real issue, owner, scope and valid execution authority are bound to the operation.
- [ ] The pump creates or reconciles one Draft and reads back its identity before code starts.
- [ ] The pump invokes a real agent within the admitted scope and records its result.
- [ ] Duplicate delivery and interrupted execution reconcile without concurrent writers or duplicate effects.
- [ ] Expired, revoked, malformed or absent authority prevents new execution; interruption behavior is specified and tested.
- [ ] The result has targeted tests and fresh separate Standards and Spec reviews on the exact candidate.
- [ ] GitHub evidence and the DuckDB projection distinguish planned, running, blocked and proven work.

Passing this one-task canary does not prove continuous autonomous draining.
Automatic admission of a subsequent task requires a separate valid mandate and
a separate observed result. Do not close the parent outcome after this slice.

## Known gaps and next proof

The prior preflight reproduced InvalidEffectClaim in the hosted intake
configuration. That path expects existing branch/evidence; it does not itself
start the coding agent. An executor already exists in src/factory-agent.mjs and
src/github-portfolio-execution.mjs. The examined portfolio operator deliberately
requires human confirmation and signing-key unlock.

Next: settle the smallest integration and legitimate bounded-authorization
contract, then add a failing end-to-end contract test before implementation.
Reuse existing execution seams. Do not simulate human confirmation, fabricate
grants, or treat this document as execution permission.

No automatic merge/deployment, paid API, new credentials, or permission widening
is activated by this Draft. Preserve the six bus verbs and hexagonal boundaries;
DuckDB remains a rebuildable projection, not an authority source.

## Reporting and estimates

Report every five minutes while work is active: new proof, owner, blocker and
recoverability, next expected proof, and conditional ETA in local time and UTC.
No new evidence must be stated explicitly. A missed estimate retains its original
deadline and an explanation; it is not silently reset.

End-to-end delivery is not yet estimable: the execution-authority integration
still needs design and negative-case validation. A reporting checkpoint is not
a delivery ETA. Documentation admission is not pump repair.

## Validation of this initial commit

Documentation only. No production code, runtime policy, grants, configuration or
test behavior changes. No new runtime test success or autonomy is claimed.

## Decision C: Draft admission as a restrictive precondition (2026-09-05)

Hypothesis C was challenged by two bounded read-only reviews on 2026-09-05 and
survived with one placement change. Decision:

- The issue-bound Ed25519 grant schema and the human operator signing boundary
  are unchanged. A Draft receipt never grants execution.
- `createPortfolioFactory` accepts one optional `draftAdmission` read port.
  When absent, every existing caller keeps its exact current behavior.
- When present, every `advance()` (preview and authorized) asks the port for the
  Draft bound to the scheduled repository and item, through a fresh trusted
  provider read. The hosted pump ledger, an intake receipt file, and the DuckDB
  projection are not admissible sources for this read.
- Admission is restrictive: a missing Draft, a Draft that is not OPEN and
  `isDraft`, malformed evidence, or an unavailable port refuses with a typed
  `PortfolioFactoryError` before `authority.consume`, so no grant is spent and
  no agent starts. Refusal codes: `DraftAdmissionMissing`, `DraftNotAdmitted`,
  `DraftEvidenceInvalid`, `DraftAdmissionUnavailable`.
- Admitted evidence `{ number, headRef, headRevision }` is placed inside the
  intent body before `intentRevision` is computed. The revision the operator
  types and the grant carries therefore binds the exact Draft and head
  revision. A Draft that moves between confirmation and authorized execution
  changes the revision and is refused by the existing authority scope check
  without a ledger write. No grant or execution-receipt schema changes.

Enforcing authority: the existing grant consumption (`GrantScopeMismatch`,
`GrantConsumed`) and the new pre-consume refusal. Residual gaps, stated not
closed: the window between the last Draft read and the worker process start;
any collaborator able to open a Draft naming the issue can satisfy the
precondition, which narrows but never widens the grant; production wiring of a
gh-backed `draftAdmission` port into the operator CLI is not part of this slice.
Sequential replay tests are not a concurrency proof.

## Decision C.1: shipped Draft admission adapter and CLI wiring (2026-09-05)

The optional port from Decision C becomes reachable from the shipped operator
CLI. Nothing about the grant, the key unlock, or the typed confirmation changes.

- Module `src/github-draft-admission.mjs` exports a read-only adapter built on
  the existing `createGhDraftOperationProvider` (`lookupExact`). It performs no
  effect and adds no bus verb.
- Expectation input: the hosted pump CLI receipt file
  (`GaiaHostedDraftPumpCliReceiptV0`, command `intake`) whose `result` is a
  `Terminal` `CREATED` or `REUSED` outcome with a non-null `pullRequest`. The
  file is untrusted input. It is validated to its closed shape, and its identity
  work and operation identities are recomputed locally using the envelope's canonical form:
  `workKey = contentRevision(GaiaDraftWorkKeyV0, repository nodeId, workItem)`
  and `operationMarker = operationId`. A receipt whose work key does not
  derive from the repository and issue it names is refused.
- Identity rule, all conjunctive, before any grant is consumed:
  1. the scheduled intent is an `ISSUE` in the pre-committed repository and its
     number equals the receipt's `workItem.number` (else `DraftExpectationForeign`);
  2. `gh repo view` node id and `nameWithOwner` equal the receipt's repository;
  3. exactly one pull request exists on the receipt's `headRef` and carries the
     exact operation marker line (none: `DraftAdmissionMissing`; several or an
     unmarked one: provider `ProviderAmbiguous` / `ProviderConflict`);
  4. that pull request has the exact number named by the receipt (otherwise
     `DraftExpectationMismatch`), is `OPEN`, `isDraft`, based on the receipt's `baseRef`,
     owned by the repository owner (not a fork), and its live `headRefOid`
     equals the receipt's `headRevision` (a moved head is refused as stale);
  5. a merged outcome is reported as not admitted, never as a Draft.
- The admitted `{ number, headRef, headRevision }` enters the intent body as in
  Decision C, so the operator confirms the exact Draft and head SHA by typing
  the intent revision.
- CLI: `run` requires `--draft-receipt FILE`. Omitting it is a usage error,
  not a silent fallback. Existing callers of the module seam remain unchanged;
  only the shipped CLI makes admission mandatory.
- The receipt's content is validated on the first admission read, inside the
  factory's refusal boundary, so a malformed or foreign receipt is refused at
  the `materialize` stage with an operator receipt on disk
  (`DraftAdmissionUnavailable`, carrying `DraftExpectationInvalid` or
  `DraftExpectationForeign`), never as a usage error that leaves no receipt.

Not claimed: cross-process at-most-once, closure of the window between the
last readback and the worker process start, or any proof that the pump as a
whole is autonomous. The adapter is a precondition and evidence binding only.

## Decision C.2: producer-compatible diagnostic annotation (2026-09-05)

Independent Spec review of candidate `91b7493` reproduced rejection of genuine
scheduled receipts: the hosted CLI adds `observation` after producing its receipt.
Keep the receipt contract closed, but admit that one optional diagnostic field in
the producer's two declared forms (`PRODUCED` with revision or `REFUSED` with reason).
It is never admission evidence or authority: the exact provider read and grant
checks still decide admission. Unknown fields and malformed annotations still refuse.
Regression proof must compose the real envelope/reconciler, hosted intake CLI,
observation producer, and admission adapter with only external ports replaced.
Do not copy a hypothetical CLI receipt as the compatibility oracle.
