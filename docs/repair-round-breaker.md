# Repair-round circuit breaker

Status: one breaker family of #54, with a memory store (#184). It trips and records; it stops,
sends and retries nothing, and it grants no authority. The file-backed store, the wiring into the
live pump path and the other breaker classes stay on #54.

Two stops on repeated repair ship already, and neither is a breaker:

- **ENG-09** in the drain net (`T_BREAKER_TRIP` in `src/drain-petri-net.mjs`): two
  `REQUEST_CHANGES` reviews of one pull request, at distinct heads, carrying the same `Family:`
  token put a token in `P_BLOCKED_REDESIGN`. That place inhibits new reviews and repairs until an
  operator order (`T_REDESIGN_RESUMED`) lifts it. It lives in one pull request's replayed net.
- **`BUDGET_EXHAUSTED`**: `planManagedRoundUpdate` in `src/pr-delivery-round-history.mjs` refuses
  to propose a round past the R0 receipt's round budget. That refusal is stateless: it stops one
  advance, records nothing, and needs no reset.

`src/repair-round-breaker.mjs` makes the second one durable. It keeps one record per work
identity scope, trips before the effect, and only an operator reset receipt clears it.

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

## Deciding

| Record | Attempt | Decision | Written |
| --- | --- | --- | --- |
| `TRIPPED` | any | `TRIPPED` | nothing |
| `ARMED`, same `attemptKey` as the last admitted round | any | `ALREADY_ALLOWED` | nothing |
| none or `ARMED` | `BUDGET_EXHAUSTED` | `TRIPPED`, reason `BUDGET_EXHAUSTED` | the trip |
| none or `ARMED`, `rounds` at `roundBudget` | `ROUND_PROPOSED` | `TRIPPED`, reason `ROUND_BUDGET` | the trip |
| none or `ARMED`, `rounds` below `roundBudget` | `ROUND_PROPOSED` | `ALLOW` | `rounds + 1` |

- **Trip before effect.** `runRepairRound` compare-and-sets the decided record before it calls
  `effect`. Only an `ALLOW` that won its compare-and-set calls `effect({ scope, attemptKey, round })`,
  so the attempt past the budget is refused with its effect never run.
- **One outcome.** Two calls that read the same version race on one compare-and-set. The loser gets
  `REVISION_CONFLICT` and runs nothing: two attempts for the last round run one effect, and two
  concurrent trips write one trip. Asked again, a tripped scope answers with the same trip and
  writes nothing.
- **Scopes are separate.** A trip in one scope leaves sibling scopes armed.
- **Nothing but a reset lifts a trip.** The record is the whole state and no call reads a clock,
  so a restart or the passage of time changes nothing. A larger `roundBudget` or a new policy
  revision does not lift a trip either: a changed policy is a reset basis.
- **An admitted round is consumed.** The count rises before the effect runs, so an effect that fails
  still used its round. The same `attemptKey` asked again is `ALREADY_ALLOWED` and runs no effect;
  recovering that effect is the job of its own idempotency key.

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

A reset receipt is data the operator surface issues; this module never builds one.

| Field | Meaning |
| --- | --- |
| `schema` | `gaia-repair-round-reset/1` |
| `scope`, `tripKey` | the scope and the exact trip the receipt lifts |
| `operator` | `github:user:<login>` |
| `basis` | `NEW_DESIGN`, `FIXED_POINT` or `CHANGED_POLICY` (#54: a new design or fixed point, or a changed policy) |
| `evidenceRevision` | 64 hex naming the design, fix or policy the reset rests on |

A reset arms the scope again with `rounds` at 0. Applied twice, the same receipt answers
`ALREADY_RESET` and writes nothing. Two concurrent resets have one outcome, as trips do. A receipt
names one trip, so it cannot lift a later one. The module checks that a receipt is bound to the
scope and the trip; proving that the receipt is authentic is the operator surface's job.

## Refusals

Input the breaker cannot judge throws `RepairRoundError`:

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
| `NotTripped` | there is no trip to lift |
| `InvalidStore` | the store is not a compare-and-set port, or answered outside its protocol |
| `InvalidEffect` | the effect is not a function |

## The store port

```js
read(scope)                                  // { state: 'UNSEEN' } or { state: 'PRESENT', version, record }
compareAndSet(scope, expectedVersion, record) // { kind: 'SET', version } or { kind: 'STALE', currentVersion }
```

`expectedVersion` is `NONE` for a scope with no record. `createMemoryRepairRoundStore()` is the one
adapter in this slice; its version is a SHA-256 of the record, which the rising `generation` keeps
unique.

## How it relates to ENG-09

The two breakers watch different signals. ENG-09 trips on the same failure family repeated
across reviews of one pull request. This breaker trips on the number of repair rounds for one
work identity, whichever failure each round repaired. Both are lifted only by an operator. The
record already keeps the failure fingerprint of the last admitted round and of the trip, so a
recurrence rule over fingerprints (#54's "repeated same-family blocker") can compare against them.
