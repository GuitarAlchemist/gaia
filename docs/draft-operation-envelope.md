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
process termination and the concurrency group, while content-addressed receipts persist in GitHub.
The memory adapter exercises the same state-machine contract without claiming production authority.

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
  admission: { state: 'AVAILABLE', revision },
  requestedEffect: 'CREATE_DRAFT'
}
```

All strings are non-empty canonical text with no control characters. Revisions are exact lowercase
SHA-256 values, `headRevision` is an exact lowercase Git object id, `number` and `ordinal` are safe
positive integers, and every vocabulary is closed. `admission.state` is exactly `AVAILABLE` or
`ZERO`. Canonicalization never silently trims, folds, or coerces caller data.

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

## One ordered reconciliation transaction

`reconcileDraft(envelope, expectedRevision, ports)` performs these steps under one module owner:

1. seal the envelope and derive its three identities;
2. dispatch or enter the executor serialized by `workKey`;
3. compare `expectedRevision` with the current durable revision before lookup, adoption, capacity,
   intent, or effect;
4. find terminal state and latest intent by `workKey`;
5. query the provider through the closed provider request;
6. adopt an exact Draft before reading `admission`; an exact Draft therefore succeeds even when
   admission is `ZERO`;
7. refuse a new effect when admission is `ZERO`, otherwise append durable intent and
   `EFFECT_STARTED` under the current executor epoch;
8. perform at most one provider effect while the executor still owns that epoch;
9. reconcile ambiguous responses by exact operation marker; and
10. append one coherent terminal record derived only from the sealed envelope and provider result.

Every path which appends state, including effect-free adoption, is revision-gated. A stale caller
returns `StaleRevision` and writes nothing. A stale or cross-generation owner performs no effect.

`cancelDraft(envelope, expectedRevision, store)` is the only cancellation seam. It uses the same
`workKey` executor and durable revision as reconciliation. If cancellation commits before
`EFFECT_STARTED`, reconciliation returns `Cancelled` with zero effect. If reconciliation already
owns the executor, cancellation observes its terminal result and cannot publish a false cancelled
state. Cancellation carries no provider or merge authority.

The production adapter uses one GitHub Actions concurrency group derived from `workKey`, with
`cancel-in-progress: false`. Its receipt chain records executor run id and attempt. A successor
starts only after the predecessor is terminal, replays GitHub-persisted receipts, and fences every
command by the current executor epoch. An orphan before `EFFECT_STARTED` is safe to resume. An
orphan after `EFFECT_STARTED` is reconciled by exact marker: an exact Draft is adopted; absence or
ambiguity returns `ProviderAmbiguous`, emits an alert, and performs no blind retry. This sacrifices
automatic liveness in the irreducibly ambiguous window rather than duplicate a provider effect.

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
ordering and exact-Draft adoption with `admission: ZERO`. It runs one black-box lifecycle contract
against the memory adapter and the GitHub-hosted executor/receipt adapter. Behavioral
mechanism-revert mutants cover stable work lookup, ready-item derivation, envelope sealing,
revision gating, executor epochs, cancellation ordering, intent-before-effect, reconciliation,
error closure, and terminal binding.

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
