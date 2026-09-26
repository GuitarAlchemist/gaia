# Terminate a no-candidate run without inventing approval

Origin: operator request to repair the pump after Gaia #108's worker returned no
edits, leaving local job `6bb312a4b221ca8fa41cd5b8d33d28eb4dda571643811ca9441359f21d3b12e6`
STARTED. The empty Draft #156 is closed. This is NOT the hosted operation #127
tracked by #161. No hosted ledger change or worker retry is authorized here.

Consumer: the local autonomous operator and the next eligible item in its queue.
Goal: preserve truthful terminal evidence and free the local slot without
approving an empty candidate, refunding budget, or executing a job twice.

## Reproduction

`node --test tests/autonomous-factory-no-change.test.mjs` drives real linked Git
worktrees, the execution adapter, SQLite and the production tick with offline
provider fixtures. Before repair: expected NO_CANDIDATE, got
RECONCILIATION_REQUIRED. The worker's output exists but no receipt is published.

Ranked hypotheses: (1) NoCandidateChange throws before receipt publication;
(2) the receipt validator rejects a terminal no-change outcome; (3) SQLite
cannot finish an otherwise valid receipt. Direct execution and persistence
assertions discriminate these, without live provider calls.

## Design alternatives (ENG-02)

Constraints: preserve exact intent/head/key binding; no approval without review;
one local SQLite serialization boundary; no automatic recovery from missing
receipts; unchanged six bus verbs and finite policy; no hosted effects.

Usage: a fresh no-edit run returns a non-candidate terminal; an operator can
retire one old blocked job only by its exact identity after both its issue and
unmerged Draft are closed. Normal watch never invokes retirement.

A. Reuse CANDIDATE_READY or CANDIDATE_REJECTED and fabricate review for an empty
diff. Minimal code, but collapses measured absence into semantic approval or
review rejection. Rejected: breaks the evidence contract.

B. Keep exceptions and add automatic stale-job eviction/retry. Hides missing
evidence, races live work, refunds/repeats effects. Rejected: activity and age
cannot prove terminal truth.

C. Add two disjoint outcomes at the existing seams. The factory publishes a
measured `no-change` receipt (zero diff/status, empty file set, worker evidence)
and the autonomous owner records NO_CANDIDATE, never a reviewed candidate.
Historical missing receipts remain unknown. A separate explicit operator
`retire-closed` command records ABANDONED with bound closed-issue/closed-Draft
observations; it does not reconstruct past execution or claim task success.
Default is preview; `--apply true` spends operator authority once. Selected.

## Decision receipt

Selected C. Inputs: base `680baa9` (full base recorded in PR), the reproduction,
the existing autonomous contract/store/execution seams, and the operator's
repair instruction. This document's SHA-256 is recorded in the PR before review.
No new dependency, language, provider or bus verb. State remains in the existing
job record, not a second ledger. The store transaction is the linearization
point: STARTED -> COMPLETED with an immutable terminal receipt. COMPLETED means
job terminal, not issue implemented. Budget and identity remain consumed.
Conflicting late completion/retirement loses without overwriting the winner.

Reversibility: additive local reader contract, with a forward-compatible-host
requirement after the first new terminal receipt. Old readers fail closed. Keep
the original database and execution evidence; never roll back to erase consumed
authority. No automatic cancellation of already authorized processes is claimed.
Before manual retirement the operator must stop the old host/owned providers;
the closed Draft is not a process-kill signal or absence-of-effects proof.

## Acceptance and stop conditions

- Original tick repro passes; persisted NO_CANDIDATE replays without providers.
- Empty/mutated/fabricated ready receipts stay invalid; no candidate sidecar for
  NO_CANDIDATE or ABANDONED.
- Retirement defaults dry-run, checks exact issue id/number and Draft head/ref,
  refuses open/merged/moved/mismatched/unavailable observations, and never calls
  execution or a GitHub write. Replay returns the same receipt.
- Concurrent/late writers converge to one immutable terminal; usedRuns unchanged.
- Focused tests twice, full verification, architecture and independent review.
- Live repair backs up state, previews then retires only #108/#156, verifies
  activeJobKey=null and usedRuns unchanged, then restarts the visible operator
  under the existing repository and budget. New ambiguity stops progression.

Instruction coverage: this introduces one operator recovery command; usage,
authority and rollback are documented in docs/autonomous-factory.md. Existing
CLAUDE.md and gaia-delivery routing already cover this subsystem. No new skill.
