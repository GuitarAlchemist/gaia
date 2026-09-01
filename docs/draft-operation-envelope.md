# Canonical Draft operation envelope R0

Status: design gate for issue #56 after PR #58 tripped `BLOCKED_REDESIGN`.

## Problem

The failed composition in PR #45 and the deep-module attempt in PR #58 both allowed distinctions
to cross the Draft provider boundary without one owner. PR #58 closed its original concurrency,
telemetry, and terminal-coherence failures, but fresh review then reproduced four boundary defects:

1. changing `readyItem` hid an older intent and permitted a second provider effect;
2. caller fields outside the contract reached the provider, which could mutate fields later used
   in the durable terminal record;
3. effect-free adoption could commit from a stale caller revision; and
4. provider transport diagnostics escaped the module verbatim.

The repeated failure is the seam, not one missing condition. This R0 therefore replaces the input
boundary before reusing any PR #58 implementation.

## Design it twice

### Alternative A — patch PR #58

Remove `readyItem` from one hash, clone one object, add one revision check, and catch provider
errors. Rejected. Each patch repairs one manifestation while leaving callers, storage, projection,
and the provider to interpret the same mutable object independently. That is the recurring failure
family which tripped the circuit breaker.

### Alternative B — provider idempotency as the abstraction

Treat GitHub create-PR behavior as an idempotent primitive and retry by head/base. Rejected.
GitHub documents a generic `422`, not duplicate head/base idempotency, and head/base alone cannot
distinguish operation generations or conflicting ownership.

### Alternative C — canonical envelope with one boundary owner — selected

One constructor validates, copies, canonicalizes, and deeply freezes the entire operation
envelope. The reconciliation module owns the stable work key, generation key, provider request,
expected-revision check, serialized effect, cancellation, terminal projection, and closed error
mapping. The provider receives a smaller derived request and can never observe the caller object.

The production effect adapter runs only inside a GitHub-hosted serialized executor. Multiple local
or remote dispatchers may enqueue work, but none may call the Draft provider directly. GitHub owns
process termination and the concurrency group. A dedicated append-only Git ref is the durable
ingress and receipt ledger; Actions is only an executor, never the queue or ledger. The memory
adapter exercises the same state-machine contract without claiming production authority.

## Closed envelope

The public constructor accepts exactly this shape and rejects missing, extra, inherited,
accessor, symbol, non-enumerable, or non-canonical values without evaluating accessors:

```js
{
  schema: 'GaiaDraftOperationEnvelopeV0',
  repository: { owner, name },
  workItem: { kind: 'ISSUE', number },
  readyItem: {
    schema: 'GaiaReadyItemIdentityV0',
    queueReceiptRevision,
    occurrence,
    id
  },
  observedSourceRevision,
  generation: {
    baseRef,
    headRef,
    headRevision,
    policyRevision,
    ordinal
  },
  requestedEffect: 'CREATE_DRAFT'
}
```

All strings are non-empty canonical text with no control characters. Revisions are exact lowercase
SHA-256 values, `headRevision` is an exact lowercase Git object id, `number` and `ordinal` are safe
positive integers, and every vocabulary is closed. Canonicalization never silently trims, folds,
or coerces caller data. Capacity and admission are deliberately absent: an untrusted dispatcher
cannot mint effect authority by writing `AVAILABLE` into its envelope.

The module recomputes `readyItem.id` as the SHA-256 of canonical JSON containing `workKey`,
`queueReceiptRevision`, `occurrence`, and `observedSourceRevision`; a mismatch is refused. A queue
may reuse a work item only by issuing a new receipt or occurrence, which necessarily moves this id.
No label, title, prompt, agent, or clock participates.

The constructor returns an internal null-prototype copy whose nested records are frozen. No raw
caller reference crosses validation. The module reads only that sealed copy after construction.

## Two identities, one lookup rule

The abstraction preserves the distinction PR #58 erased:

- `workKey` binds canonical repository + work item + requested effect. It deliberately excludes
  ready-item identity, branch generation, policy, clocks, agents, lanes, and prompts.
- `generationKey` binds `readyItem.id` and the complete `generation` record.
- `operationId` binds `workKey + generationKey`.

The durable store indexes the latest intent by `workKey`, never by `operationId` alone. Therefore a
new ready-item, policy, or head generation still finds an older intent for the same logical work.
An exact generation may reconcile it. A different generation returns a typed
`CrossGenerationIntent` refusal with zero provider effect; it never becomes unrelated work merely
because a queue revision changed.

## Concrete GitHub ledger and adapter contract

The hosted ledger is the ref family
`refs/heads/gaia-ledger/draft-operations-v0/<workKey>`, one append-only branch per logical work.
Workflow triggers must exclude `gaia-ledger/**`; moving these refs is storage, not a source change.
Each ref's head commit is that work's only authoritative revision. Each commit has exactly one parent
(except the bootstrap root), one
canonical JSON `receipt.json` blob, and no caller-authored commit metadata used by replay. The
receipt is a closed null-prototype record containing schema, prior head, record kind, work key,
generation key when known, operation id when known, executor epoch when known, and the minimum
closed payload for that kind. Raw prompts, provider prose, credentials, paths, and account data are
forbidden. `ENQUEUED` alone carries the complete sealed envelope; executors reload that copy and
never accept an envelope from workflow inputs.

The closed record kinds are `ENQUEUED`, `CLAIMED`, `INTENT`, `EFFECT_STARTED`,
`EFFECT_AMBIGUOUS`, `CREATED`, `SATISFIED`, `REFUSED`, and `CANCELLED`. The first five are
nonterminal. `EFFECT_AMBIGUOUS` means a create request may already have reached GitHub and only
exact observation can settle it; it is never projected as refusal or completion.

The Git Data adapter exposes only:

```text
readHead(workKey) -> { revision, records }
append(workKey, expectedRevision, closedRecord) -> { committedRevision }
listUnsettled(refPrefix) -> closed operation identities
```

`append` creates a blob, tree, and single-parent commit whose parent is `expectedRevision`, then
updates the ref with `force: false`. Two candidates from the same parent are siblings: after one
fast-forward succeeds, the other update is non-fast-forward and must fail as `StaleRevision` before
any Draft effect. The adapter rereads but never silently rebases an effect-bearing record. Bootstrap
creates one root record; concurrent bootstrap losers reread the winning ref. Missing, deleted,
force-rewritten, multi-parent, non-canonical, discontinuous, or corrupt history fails closed and
alerts. The branches and their commit chains are retained append-only: the pump never force-updates,
deletes, squashes, truncates, or garbage-collects them.

`enqueueDraft(envelope, expectedRevision, ledger)` seals the envelope, derives `workKey`, refuses a
different generation while that work has a nonterminal generation, then CAS-appends `ENQUEUED`.
Only after that accepted append may a dispatcher request a workflow. A failed,
cancelled, replaced, or queue-overflowed dispatch therefore leaves durable unsettled work. A
scheduled supervisor reads `listUnsettled` and redispatches it; duplicate dispatch is harmless
because every executor begins by loading the accepted `ENQUEUED` envelope and performing the same
ledger CAS and exact provider reconciliation. GitHub
Actions uses `concurrency.group = gaia-draft-<workKey>`, `cancel-in-progress: false`, and
`queue: max`. The queue bound improves throughput but is not a delivery guarantee; the ledger is.

An executor epoch is the closed pair `{ runId, runAttempt }` taken from the running GitHub Actions
context, never from the caller envelope. A job CAS-appends `CLAIMED` before it can append `INTENT`.
The hosted admission controller grants effect capacity only when the GitHub Actions API reports
that exact run/attempt `in_progress`, its concurrency group matches `workKey`, and the ledger head
names its current `CLAIMED` epoch. Otherwise it returns `ZERO`; no `INTENT`, `EFFECT_STARTED`, or
provider create call is legal. The memory
adapter supplies the same trusted `reserveEffect` seam for deterministic `AVAILABLE` and `ZERO`
tests. Thus capacity is an executor fact, not caller data. Exact-Draft lookup and `SATISFIED`
adoption happen before `reserveEffect`, so adoption remains legal at zero effect capacity.

The shared black-box contract runs against the memory adapter and a fake Git Data API implementing
the real ref/commit protocol. A separately gated live probe races two non-force ref updates from one
head, proves one winner and one conflict, and proves an `ENQUEUED` record survives a cancelled
workflow. No live probe grants Draft, merge, configuration, or branch-rewrite authority.

## One ordered reconciliation transaction

`reconcileDraft(operationId, expectedRevision, ports)` performs these steps under one module owner
after `enqueueDraft` has returned the accepted operation id and committed revision:

1. load and validate the sealed envelope from its accepted `ENQUEUED` receipt, then derive its three
   identities again and require the same `operationId`;
2. enter the executor serialized by `workKey`;
3. compare `expectedRevision` with the current durable revision before lookup, adoption, capacity,
   intent, or effect;
4. find terminal state and latest intent by `workKey`;
5. query the provider through the closed provider request;
6. adopt an exact Draft before reserving effect capacity; an exact Draft therefore succeeds even
   when the trusted executor admission controller returns `ZERO`;
7. CAS-append `CLAIMED` under the current executor epoch without effect authority;
8. ask trusted `reserveEffect`; append `REFUSED` when it returns `ZERO`, otherwise append `INTENT`
   and `EFFECT_STARTED` under that same current epoch;
9. perform at most one provider effect while the executor still owns that epoch;
10. reconcile ambiguous responses by exact operation marker; and
11. append one coherent terminal record derived only from the sealed envelope and provider result.

Every path which appends state, including effect-free adoption, is revision-gated. A stale caller
returns `StaleRevision` and writes nothing. A stale or cross-generation owner performs no effect.

`cancelDraft(operationId, expectedRevision, store)` is the only cancellation seam. It reloads the
sealed envelope from `ENQUEUED` and uses the same `workKey` executor and durable revision as
reconciliation. If cancellation commits before
`EFFECT_STARTED`, reconciliation returns `Cancelled` with zero effect. If reconciliation already
owns the executor, cancellation observes its terminal result and cannot publish a false cancelled
state. Cancellation carries no provider or merge authority.

The production adapter uses the GitHub Actions group and ledger protocol above. Its receipt chain
records executor run id and attempt. A successor replays GitHub-persisted receipts and fences every
command by the current executor epoch. An orphan before `EFFECT_STARTED` is safe to resume. An
orphan after `EFFECT_STARTED` is reconciled by exact marker: an exact Draft is adopted; absence or
ambiguity appends `EFFECT_AMBIGUOUS`, emits an alert, and performs no blind retry. Each later
supervisor pass performs lookup only. The operation remains durably nonterminal until an exact
Draft is observed; neither elapsed time nor repeated absence can turn it into `REFUSED`. This
sacrifices automatic liveness in the irreducibly ambiguous window rather than publish a false
terminal or duplicate a provider effect.

The original lease-expiry fault row is represented by executor epochs: A records intent and stalls,
GitHub terminates A, B becomes the next serialized epoch, and any resumed A command is refused.
The acceptance suite includes both the safe pre-effect recovery and the ambiguous post-effect
refusal. No local lock directory or elapsed-time lock breaking is part of the production contract.

## Provider boundary

The provider receives exactly a new frozen null-prototype record containing repository, base ref,
head ref, head revision, and operation marker. It receives no ready-item data, policy payload,
requested authority, expected revision, storage token, caller object, or terminal projection.

Provider errors are caught at every lookup and creation call. The public result exposes only the
closed categories below and never provider messages, codes, payloads, paths, URLs, or credentials:

- `ProviderUnavailable`
- `ProviderRejected`
- `ProviderAmbiguous`
- `ProviderProtocolViolation`

Private diagnostics may be sent to an observational telemetry sink only after redaction. Telemetry
failure cannot change or conceal a durable reconciliation result.

## Terminal coherence

The terminal vocabulary is closed:

- `CREATED`: effect `CREATE_DRAFT`, exact pull request, no refusal;
- `SATISFIED`: effect `NONE`, exact pull request, no refusal; or
- `REFUSED`: effect `NONE`, no pull request, one closed refusal category.

`EFFECT_AMBIGUOUS` is explicitly nonterminal and projects effect `UNKNOWN`, no pull request, and
`ProviderAmbiguous`. It is excluded from completion, throughput-success, and refusal counts. A
definitive provider rejection before or as the create response may be `REFUSED`; a lost or
ambiguous response after `EFFECT_STARTED` may not.

Terminal generation, observed source revision, and operation identity are derived from the sealed
envelope, not reread from caller or provider objects. The store returns one `committedRevision`
from the terminal append. The projected `actionRevision`, `checklistRevision`, and `sourceRevision`
must each equal that exact `committedRevision`; `observedSourceRevision` remains separately named
provenance. The store validates the complete combination before append and again during replay.

## Mandatory RED gates

No production implementation is authorized until deterministic tests prove all four PR #58
counterexamples RED against the new public seam:

1. an old intent followed by the same work under a changed `readyItem.id` performs zero second
   effect and returns `CrossGenerationIntent`;
2. an unknown authority-like field is refused before the provider, and a malicious provider cannot
   mutate terminal generation or source;
3. exact-Draft adoption from a stale `expectedRevision` writes nothing; and
4. lookup and create transport failures return typed redacted results with no raw diagnostic.

The suite must also retain the original eleven-row fault matrix, including cancellation/completion
ordering and exact-Draft adoption when trusted `reserveEffect` returns `ZERO`. It runs one black-box lifecycle contract
against the memory adapter and the GitHub-hosted executor/receipt adapter. Behavioral
mechanism-revert mutants cover stable work lookup, ready-item derivation, envelope sealing,
revision gating, non-force ledger CAS, durable ingress, executor epochs, trusted capacity,
cancellation ordering, intent-before-effect, ambiguous nonterminal reconciliation, error closure,
and terminal binding.

## Success and rejection criteria

The design is accepted only if independent Standards and Spec reviewers agree that one owner can
enforce every promised observation without adapter-specific caller knowledge. It is rejected if a
reviewer can make identity, authority, revision, provider diagnostics, or terminal values depend on
data outside the sealed envelope and closed provider result.

Implementation remains a tracer bullet: constructor, memory store, one fake provider, cancellation,
and the four RED-to-GREEN counterexamples first. The GitHub-hosted adapter and one live concurrency
probe follow only after that seam is green.

## Authority and rollback

The design adds no bus verb, merge, approval, deployment, credential, retry, or configuration
authority. Rollback disables the new composition; PR #45 and PR #58 remain immutable failure
evidence, and existing GitHub Drafts are never deleted or rewritten.
