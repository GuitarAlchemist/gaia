# Portfolio drain pump R0

## Problem

`github-portfolio.mjs` materializes one exact GitHub observation and an advisory schedule.
That is not a durable queue. A later organization snapshot can have a different revision even
when the selected issue did not change, and the GitHub adapter deliberately lists only open
items. Treating either fact as lifecycle state would lose work or falsely declare it closed.

The drain pump separates three responsibilities:

1. the GitHub portfolio is the current external observation;
2. content-addressed drain receipts are Gaia's replayable lifecycle evidence;
3. an evidence-bound hold may restrict scheduling but can never promote or authorize work.

## Design It Twice

Three interfaces were considered.

1. **Generic workflow engine.** Steps, retries and state-machine configuration. Rejected: the
   caller would have to restate every authority and ordering invariant, making the interface as
   complex as the implementation.
2. **Mutable database queue.** A row per issue with an updatable status. Rejected for R0: it
   creates a second mutable truth beside GitHub and makes crash recovery depend on undocumented
   update ordering.
3. **Pure reducer over exact observation + append-only receipts — selected.** Two entry points:
   `buildPortfolioDrainReceipt` binds one observed transition, and `reconcilePortfolioDrain`
   replays all receipts and returns one frozen projection plus bounded, authority-free next
   decisions. Persistence and execution remain later adapters at separate seams.

The selected module has no I/O, clock, randomness, provider, GitHub effect, signing key or bus
verb. Its deletion would force every caller to reimplement chain validation, drift handling,
capacity accounting, one-repository writer exclusion and conservative source-state mapping.

## States

The initial state is derived from the portfolio's explicit source state. `READY` issues become
`QUEUED`; `READY` pull requests become `AWAITING_MERGE_AUTHORITY`. Unknown evidence, human gates,
drafts, dependencies, duplicates and archives remain distinct blocked or terminal states.

Receipts advance only this closed chain:

```text
QUEUED -> CLAIMED -> RUNNING
RUNNING -> CANDIDATE_READY -> PUBLISHED -> TERMINAL_MERGED | TERMINAL_CLOSED
RUNNING -> TERMINAL_REJECTED
RUNNING -> FAILED_AUTHORITY_CONSUMED
```

`EXECUTION_FAILED` is deliberately not retryable. Existing Gaia authority is one-use; silently
restarting after it was consumed would execute a provider twice under one grant.

If an active item's exact observation changes, or an active item disappears from the open-only
GitHub snapshot, the state becomes `RECONCILE_REQUIRED`. Absence is never interpreted as closure.
An unrelated repository changing the global portfolio revision does not erase an unchanged
item's receipt chain.

## Pump decision

R0 proposes only two decisions, both with `effect: NONE`:

- `CLAIM_FACTORY_RUN` for a `QUEUED` issue, carrying `requiredAuthority: FACTORY_RUN`;
- `PREPARE_PUBLICATION_INTENT` for a settled candidate, carrying no authority.

The projection subtracts `CLAIMED` and `RUNNING` items from the four-lane capacity and excludes a
repository that already owns an active lane. A hold is `{itemId, reason, evidenceRevision}` with a
closed reason token and exact SHA-256 evidence identity. Holds only restrict: they cannot turn a
blocked item into runnable work.

## What R0 does not claim

R0 is the state truth and decision mechanism, not yet an actuator. It does not persist receipts,
claim a lease, start a worker, request review, publish, merge, close, assign or label anything.
It does not infer structured dependencies or portfolio holds from issue prose or model output.

The next tracer bullet is one append-only local ledger adapter with compare-and-swap append and a
single `tick` composition root. Only after crash/replay and concurrent-writer tests pass may an
execution adapter consume a `CLAIM_FACTORY_RUN` decision. Merge remains behind a separate,
explicit authority seam.
