# Pump canary R0: admission and evidence contract

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
