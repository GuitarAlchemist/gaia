# Deep Draft reconciliation

Status: R0 design contract for Gaia issue #56. It replaces the failed recovery composition from
PR #45; that pull request remains evidence and is not an implementation base.

## Operator outcome

Given one claimed `ready-for-agent` work item and its first evidence-bearing commit, Gaia creates
or reuses exactly one matching Draft pull request. A crash may interrupt an attempt, but it cannot
lose accepted intent, duplicate the provider effect, let a stale owner act, or publish a projection
that disagrees with the committed result.

The pump remains deliberately small:

`collect -> claim -> first commit -> reconcile Draft -> checks/reviews -> merge -> collect`

One module owns identity, durable intent, fencing, provider reconciliation, and projection.
Callers provide observations and ports; they do not coordinate the steps themselves.

## Designs considered

1. Keep separate claim, delivery, correlation, and projection ledgers. Rejected: PR #45 showed that
   independently valid revisions can describe different generations of the same operation.
2. Coordinate those ledgers with a supervisor and recovery protocol. Rejected: this moves the
   cross-ledger race into more recovery code and leaves more than one authoritative revision.
3. One deep reconciliation module over one append-only state revision, with a provider port and
   two storage adapters. Selected: it removes the caller-visible ordering problem and makes one
   commit the source of both the next action and the published projection.

The deletion test is load-bearing: removing this module would force a caller to reimplement stable
identity, compare-and-set, intent-before-effect, fencing, ambiguous-response reconciliation, and
revision-bound projection. If callers must still know those rules, the interface is too shallow.

## Closed interface

```text
reconcileDraft(observation, expectedRevision, ports) -> ReconciliationReceipt
```

`observation` is immutable and contains the canonical organization/repository, work item, ready
item, base branch and OID, head branch and generation, evidence head OID, policy revision,
reconciliation generation, requested Draft effect, and exact provider observation. Those fields
form `operationIdentity`; lane names, process IDs, clocks, labels, prompts, and delivery order do
not.

`expectedRevision` is the state revision the caller actually read. `ports` contains:

- a state store offering one compare-and-set append operation;
- a provider offering exact lookup and create-Draft only;
- an append-only telemetry sink that is observational and never authoritative.

The result is one closed receipt:

- `SATISFIED`: the exact Draft already exists; no effect;
- `CREATED`: this operation created the exact Draft;
- `REFUSED`: invalid, stale, future, corrupt, mismatched, cancelled, or ambiguous input; no effect;
- `NEEDS_RECONCILIATION`: durable intent exists but the provider outcome is not yet proven;
- `BLOCKED`: required authority or provider capability is absent; no effect.

Provider payloads, lock layout, leases, retry policy, transport errors, and ownership tokens never
escape the module. The six bus verbs remain `register`, `send`, `inbox`, `ack`, `heartbeat`, and
`handoff`; observation grants no GitHub authority.

## One state and one effect boundary

The authoritative store is one append-only chain whose revision covers operation identity,
generation, durable intent, provider receipt, terminal outcome, and published projection.

The compare-and-set append of the durable intent is the only linearization point. A winner may
cross the provider boundary only after that append is durable.
A stale loser returns a typed refusal and performs no provider effect.

One serialized executor owns provider effects. The provider request carries the stable operation
identity as its idempotency/reconciliation key. If a response is lost or a process crashes after
the effect, a successor first queries the provider by the complete identity. It records `CREATED`
or `SATISFIED` only when the provider result is exact; it never retries creation from uncertainty.

Lease expiry is a liveness hint, not authority. A new owner must win a compare-and-set against the
current revision and fence the prior generation before it may reconcile. The resumed old owner is
therefore stale even if its process is still alive.

Projection is derived inside the same committed transition. Action, checklist, source revision,
and terminal outcome are returned from that committed record, never joined later from independent
ledgers.

## Adapters and shared contract

R0 ships two adapters behind the same store contract:

- deterministic in-memory store/provider adapters for forced interleavings;
- production-shaped append-only store and GitHub provider adapter.

Both run the same black-box contract suite. An adapter that cannot preserve the interface is
refused rather than approximated. No adapter-specific exception may appear in a caller.

The append-only adapter keeps `draft-reconciliation.jsonl` under an explicit data directory. Its
lock, full replay, compare-and-set, one-line append, and `fsync` happen behind the store port. A
torn, altered, non-contiguous, or future-schema record refuses the whole read; no partial replay or
automatic lock breaking is allowed.

The GitHub adapter embeds the complete operation identity as a closed HTML marker and accepts a
Draft only when repository, base, head branch, head OID, open/Draft state, and marker all agree. A
`422` create response is ambiguous rather than success: the adapter performs an exact lookup and
returns the Draft only if that complete identity is visible. GitHub documents `201`, `403`, and
generic validation-or-abuse `422` responses for Draft creation, but does not document duplicate
head/base serialization as an idempotency contract. Therefore R0 treats the adapter as
production-shaped, not as independent proof of provider serialization. Promotion requires either
a live concurrency probe demonstrating that property or a GitHub-hosted serialized executor. If a
probe can create two open Drafts for one head/base operation, this adapter is rejected unchanged.

## Mandatory deterministic fault matrix

Tests use explicit barriers and step functions, never wall-clock sleeps or probabilistic stress.

| Fault | Required outcome |
|---|---|
| Old-generation intent presented to a new ready-item, policy, or head generation | `REFUSED`; zero effect |
| Owner A stalls, B wins, then A resumes | B alone may reconcile; A is a stale loser |
| Provider effect succeeds and response is lost | exact lookup converges; zero blind retry |
| Restart after durable intent with stale process memory | durable revision wins; zero duplicate |
| Exact Draft already exists | `SATISFIED`; bypass capacity and effect |
| Existing Draft while provider, CI, or lane capacity is zero | `SATISFIED`; capacity is irrelevant |
| Two actors read the same prior revision | exactly one compare-and-set winner |
| Duplicate, delayed, reordered, or replayed delivery | same terminal receipt or typed refusal |
| Future, corrupt, stale, or mismatched evidence | `REFUSED`; zero effect |
| Cancellation races completion | one revision orders the terminal outcome |
| Projection revision differs from action/checklist revision | transition is refused before publish |

Mechanism-revert tests must fail when stable identity, fencing, durable intent, compare-and-set,
provider reconciliation, or projection revision binding is removed. Fixed inputs must replay to
byte-identical receipts.

## Recovery and stopping rules

Every non-terminal intent is discoverable by replaying the store; no process-local queue or wmux
pane is required for recovery. A reconciler may be restarted by Windows, Linux, GitHub Actions, or
an editor, but correctness never depends on which host starts it.

R0 covers the design, adapters, shared contract, full RED matrix, and the smallest GREEN tracer.
At most one evidence-backed R1 repair is allowed. A recurring same-family concurrency failure,
duplicate provider effect, or cross-generation acceptance returns `BLOCKED_REDESIGN`. There is no
R2 without an explicit human exception recorded in GitHub.

## Proof before promotion

Promotion requires the focused suite twice, the full suite, product gates, `npm run verify`,
byte-identical replay, exact scope inspection, and fresh independent Standards and Spec approval
over the same immutable head. The dashboard may display liveness, but only durable state, commit,
Draft, check, review, and merge transitions count as delivery progress.
