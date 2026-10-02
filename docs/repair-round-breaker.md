# Repair-round circuit breaker

Status: one breaker family of #54, with a memory store (#184). It trips and records; it stops,
sends and retries nothing, and it grants no authority. A durable store, an authenticated reset
channel, the wiring into the live pump path and the other breaker classes stay on #54.

Two stops on repeated repair ship already, and neither is a breaker:

- **ENG-09** in the drain net (`T_BREAKER_TRIP` in `src/drain-petri-net.mjs`): two
  `REQUEST_CHANGES` reviews of one pull request, at distinct heads, carrying the same `Family:`
  token put a token in `P_BLOCKED_REDESIGN`. That place inhibits new reviews and repairs until an
  operator order (`T_REDESIGN_RESUMED`) lifts it. It lives in one pull request's replayed net.
- **`BUDGET_EXHAUSTED`**: `planManagedRoundUpdate` in `src/pr-delivery-round-history.mjs` refuses
  to propose a round past the R0 receipt's round budget. That refusal is stateless: it stops one
  advance, records nothing, and needs no reset.

`src/repair-round-breaker.mjs` gives the second one a record. It keeps one record per work identity
scope and trips before the effect. While the store keeps the record, only a reset receipt bound to
the trip clears it.

## The calls

```js
decideRepairRound({ state, scope, attempt, policy })      // pure
resetRepairRound({ state, receipt })                      // pure
runRepairRound({ store, scope, attempt, policy, effect }) // read, decide, compare-and-set, effect
applyRepairRoundReset({ store, scope, receipt })          // read, reset, compare-and-set
deliveryBoundary(plan)                                    // a delivery-round plan as a boundary
```

| Input | Fields |
| --- | --- |
| `scope` | the work identity's 64-hex key, the `workKey` the delivery-round history is keyed by |
| `policy` | `schema` `gaia-repair-round-policy/1`, `revision` (64 hex), `roundBudget` (a positive integer) |
| `attempt` | `attemptKey` (64 hex, the caller's idempotency key for this round), `fingerprint` (64 hex, the failure being repaired), `boundary` |
| `state` | the scope's record, or `null` before its first attempt |

`boundary` is what the delivery-round advance said: `ROUND_PROPOSED` or `BUDGET_EXHAUSTED`.
`deliveryBoundary(plan)` reads it from a `planManagedRoundUpdate` result. Any other plan, such as
`ALREADY_APPLIED` or another refusal, is refused as `UnmodelledBoundary`: the breaker is not asked.

For `attemptKey`, use the revision of the advance receipt the plan was made from. A `PROPOSED`
plan also carries an `advanceKey`, but a `BUDGET_EXHAUSTED` refusal carries no key of its own.

## Deciding

The rows are checked in order:

| Record | Attempt | Decision | Written |
| --- | --- | --- | --- |
| `TRIPPED` | any | `TRIPPED` | nothing |
| none or `ARMED` | `BUDGET_EXHAUSTED`, whatever its key | `TRIPPED`, reason `BUDGET_EXHAUSTED` | the trip |
| `ARMED`, `lastAttemptKey` equal to the attempt's key | `ROUND_PROPOSED` | `DUPLICATE` | nothing |
| none or `ARMED`, `rounds` at `roundBudget` | `ROUND_PROPOSED` | `TRIPPED`, reason `ROUND_BUDGET` | the trip |
| none or `ARMED`, `rounds` below `roundBudget` | `ROUND_PROPOSED` | `ALLOW` | `rounds + 1` |

- **Trip before effect.** `runRepairRound` compare-and-sets the decided record before it calls
  `effect`. Only an `ALLOW` that won its compare-and-set calls
  `effect({ scope, attemptKey, round })`, so the attempt past the budget never runs its effect.
- **One outcome.** Two calls that read the same version race on one compare-and-set. The loser gets
  `REVISION_CONFLICT` and runs nothing: two attempts for the last round run one effect, and two
  concurrent trips write one trip. Asked again, a tripped scope answers with the same trip and
  writes nothing.
- **A loser asks again.** `REVISION_CONFLICT` says nothing about the loser's own attempt. Asked
  again, it is decided on the record that won, so a `BUDGET_EXHAUSTED` attempt that lost to an
  `ALLOW` still trips the scope.
- **Scopes are separate.** A trip in one scope leaves sibling scopes armed.
- **Only a reset lifts a recorded trip.** No call reads a clock, and a larger `roundBudget` or a
  new policy revision does not lift a trip: a changed policy is a reset basis.
- **The record lasts as long as the store keeps it.** The memory store keeps nothing across a
  restart, and a scope without a record is a fresh, armed one. So a restart, or deleting the record,
  arms the scope again. Making a trip survive both needs a durable, append-only store (#54).
- **The policy is the caller's.** An armed record does not pin the policy: the caller passes the
  policy it runs under on every call, and a larger budget admits more rounds.
- **An admitted round is consumed.** The count rises before the effect runs, so an effect that fails
  still used its round. Only the last admitted `attemptKey` is recognised as a `DUPLICATE`, which
  runs no effect. An earlier key asked again is a new round and uses another unit of the budget.
  Recovering an effect is the job of its own idempotency key.
- **A reset keeps the last admitted key.** After a reset, the round admitted last before the trip
  is still a `DUPLICATE`, so a reset never runs that round's effect twice. Re-running the same
  advance needs a new advance receipt, and so a new key.

## The record

`gaia-repair-round-breaker/1`, one per scope:

| Field | Meaning |
| --- | --- |
| `scope`, `generation` | the scope, and a count that rises with every write |
| `status` | `ARMED` or `TRIPPED`; `TRIPPED` exactly when `trip` is set |
| `rounds` | repair rounds admitted since the scope was armed |
| `lastAttemptKey`, `fingerprint` | the last admitted round and the failure it repaired |
| `trip` | `tripKey`, `reason`, the `attemptKey` and `fingerprint` that tripped it, `rounds`, and the `roundBudget` and `policyRevision` it tripped under |
| `lastReset` | the receipt fields of the reset that last armed the scope |

`tripKey` is a SHA-256 over the scope, the generation, the reason and the tripping attempt, so each
trip has its own key.

## Resetting

| Field | Meaning |
| --- | --- |
| `schema` | `gaia-repair-round-reset/1` |
| `scope`, `tripKey` | the scope and the exact trip the receipt lifts |
| `operator` | `github:user:<login>`, as the receipt states it |
| `basis` | `NEW_DESIGN`, `FIXED_POINT` or `CHANGED_POLICY` (#54: a new design or fixed point, or a changed policy) |
| `evidenceRevision` | 64 hex naming the design, fix or policy the reset rests on; for `CHANGED_POLICY`, not the policy revision the scope tripped under |

A reset arms the scope again with `rounds` at 0. A receipt names one trip, so it cannot lift a
later one. Applied again, the same receipt answers `ALREADY_RESET` and writes nothing; any other
receipt finds no trip. Two concurrent resets have one outcome, as trips do.

**A receipt is checked for binding, not for authenticity.** The module never builds a receipt, but
it cannot tell who built one. Every field is either free to choose or already in the caller's
hands: the `tripKey` comes back in every `TRIPPED` decision. So any caller can lift a trip it can
see. Until #54 supplies an authenticated reset channel, the reset must not be reachable by a
caller the operator does not control, and the breaker is not wired into the live pump.

## Refusals

Input the breaker cannot judge throws `RepairRoundError`. A call, policy, attempt, record or
receipt must be a plain object whose fields are exactly its own enumerable data properties: no
accessor, prototype or extra key.

| Code | When |
| --- | --- |
| `InvalidCall` | the call is not an object with exactly its keys |
| `InvalidScope` | the scope is not 64 lowercase hex |
| `InvalidPolicy` | the policy has the wrong schema, revision or round budget |
| `InvalidAttempt` | the attempt has a malformed key or fingerprint, or an unknown boundary |
| `InvalidRecord` | the record is malformed, or its status and trip disagree |
| `ScopeMismatch` | the record belongs to another scope |
| `UnmodelledBoundary` | the delivery-round plan is not one the breaker models |
| `ResetReceiptRequired` | a reset has no receipt |
| `InvalidResetReceipt` | the receipt is malformed |
| `ResetScopeMismatch` | the receipt names another scope |
| `ResetTripMismatch` | the receipt names another trip |
| `ResetEvidenceUnchanged` | a `CHANGED_POLICY` receipt names the policy the scope tripped under |
| `NotTripped` | there is no trip to lift |
| `InvalidStore` | the store is not a compare-and-set port, or answered outside its protocol |
| `InvalidEffect` | the effect is not a function |

## The store port

```js
read(scope)
// { state: 'UNSEEN' } or { state: 'PRESENT', version, record }
compareAndSet(scope, expectedVersion, record)
// { kind: 'SET', version } or { kind: 'STALE', currentVersion }
```

`expectedVersion` is `NONE` for a scope with no record. Each method is read once and called on the
store itself, and each answer's fields are read once. `createMemoryRepairRoundStore()` is the one
adapter in this slice. Its version is a SHA-256 of the record, which the rising `generation` keeps
unique, and it shares no record with its callers.

## How it relates to ENG-09

The two breakers watch different signals. ENG-09 trips on the same failure family repeated
across reviews of one pull request. This breaker trips on the number of repair rounds for one
work identity, whichever failure each round repaired. ENG-09's lift has no channel in R0, so only
an operator can lift it; this breaker's reset is data, and authenticating it is still to come. The
record already keeps the failure fingerprint of the last admitted round and of the trip, so a
recurrence rule over fingerprints (#54's "repeated same-family blocker") can compare against them.
