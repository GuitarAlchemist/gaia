# One-operation canary admission policy

## V1 AI reviewer assignments — approved scope, 2026-09-05

The user authorized representing real AI reviewers without invented GitHub accounts.
Three options were compared before code: loosen the V0 GitHub regex (rejected:
silently changes a closed contract); map AI sessions to fake GitHub users (rejected:
false provenance); add an explicit V1 policy/receipt (selected: opt-in and reversible).

V0 remains unchanged. V1 adds a writer identity and two independent AI reviewer
assignments. Identity grammar is `gaia:agent:v1:PROVIDER:SESSION_UUID:AGENT_ID`;
the session and agent IDs must come from the actual harness, not a model name or
an invented account. The same session/agent under another provider spelling is
the same actor for conflict checks. Distinct child agents within one coordinator
session are permitted; independence refers to separate agent contexts, not paid
subscriptions or provider diversity. Assignment provenance is checked by the
operator when admitting the exact policy; parsing a string is not authentication.

The managed round carries the writer/reviewer identities and the exact source
generation, including through its rendered GitHub readback. OPEN retains
`UNKNOWN(NOT_REACHED)` review verdicts. It neither manufactures an APPROVE nor
imports reviews of the pump implementation as reviews of the future canary task.
Actual acceptance still requires independent source evidence and a verdict bound
to the candidate, as enforced by the existing factory/publish path. This change
does not implement new identity authentication or widen that acceptance path.

Public seams remain the agreed policy producer and hosted intake CLI through its
real reconciler/managed receipt consumer. Tests must prove V1 round-trip creation,
deterministic identity preservation, same-reviewer and writer-reviewer refusal,
wrong-head refusal, unchanged V0 rejection, and no provider effect on refusal.
No new concurrent effect or linearization point: the existing ledger and managed
claim CAS retain exclusive ownership. Missing/live unverified assignments must
not be activated. Rollback deselects V1; retain its durable receipts for readback.

Related: #40, PR #121. Decision recorded before implementation, 2026-09-05.
User authorization: one versioned admission policy for one canary; no merge,
deployment, new credentials or replacement of the human execution grant.

## Problem and alternatives

The hosted CLI currently validates a static OPEN receipt and short-lived claim
before reading its operation. The configured placeholder fails InvalidEffectClaim.
An authority document and live evidence are different inputs.

1. Fill the existing repository variable: rejected. A fixed claim cannot describe
   a fresh executor, and fabricated ownership/revisions are not evidence.
2. Produce everything before enqueue: rejected. There is no durable claim yet;
   receipt construction would precede its supposed source.
3. Select a versioned one-operation policy at the composition root, then derive
   managed input at actual provider creation: selected. Reuse the ledger, Actions
   admission, managed INTENT/CLAIM CAS and exact readback. No new scheduler.

Three independent read-only design comparisons favored runtime production.
They identified two limits: real distinct review principals are not yet supplied,
and production expiry/positive-absence ports return UNKNOWN. Neither is bypassed.

## Contract and enforcing responsibility

The policy pins repository identity, issue, operationId, generationKey, source
head, accountability/effect/review assignments, one validity window and one round.
Only CREATE_DRAFT is permitted. No successor generation, merge or deployment.
Policy selection is explicit; legacy callers retain their current validation.
The hosted checkout is the policy source; a policy hash identifies its contents,
not an independent authorization grant.

At create time, read back EFFECT_STARTED for the exact operation/epoch, validate
policy scope/time, and recheck exact live Actions admission. Only then derive
the OPEN receipt and proposed managed claim. The managed evidence CAS, not the
hash or timestamp, acquires the actual claim. A stale loser performs no create.
OPEN content is stable across attempts; live lease observations occur only in
the claim. Missing implementation/review evidence remains UNKNOWN.

Replay preserves the existing terminal and lookup-only ambiguous recovery. Never
renew a claim to retry uncertain creation. Policy expiry stops new creation;
already completed external effects may still be reconciled without new authority.
The last read-to-effect interval remains a residual race; this slice does not
claim cross-system atomic revocation or automatic takeover.

## Tests and activation

Public seams: policy producer and hosted intake CLI composition through the real
reconciler; replace only external GitHub/store transport and clock. Prove one
valid bound result, deterministic OPEN replay, wrong generation/epoch/actor,
expired or absent policy refusal, no provider effect on refused admission, and
unchanged legacy rejection. Run targeted tests twice and full verification;
fresh independent Standards and Spec approval must cover the new candidate.

Do not install a policy with guessed reviewer principals. Code availability is
not policy activation, a successful Draft is not agent authorization, and a
single supervised canary is not continuous autonomy. Rollback removes explicit
policy selection; it does not erase durable operation/effect evidence.

## Independent review repair and abstraction evidence

The operation seam `createCanaryDraftAdmission` owns the ordering of policy,
clock, durable-state and Actions observations. The CLI only supplies external
ports and constructs the existing provider. Deleting this module forces that
load-bearing ordering and its refusal conditions back into the caller; it is
not a pass-through wrapper. Pure derivation remains independently testable.

The hosted CLI contract covers normal creation, terminal replay, policy expiry,
wrong generation, stopped Actions, unrelated queue work, policy replacement and
ledger movement during admission, expiry during the external read, and ambiguous
lookup-only recovery. Refusals leave managed evidence UNSEEN and create no Draft.
The ledger-movement case injects a changed external storage observation; it is
not evidence of cross-host locking or production crash recovery.

Mutation experiment: remove the policy-revision guard, run the public test named
`changes during admission`, and the policy case fails (one create instead of
zero). Removing the committed-revision guard instead fails the ledger case in
the same way. Both guards were restored and the controls pass again. Removing
only the explicit producer expiry guard does not escape the downstream lease
validator; that mutant survived the effect assertion and is not reported killed.
These observations establish only the named invariants, not complete mutation
coverage or live autonomy. The existing reconciler conservatively classifies an
exception after EFFECT_STARTED as ambiguous, even when this admission seam refused
before calling the provider; this slice does not widen retry authority.
