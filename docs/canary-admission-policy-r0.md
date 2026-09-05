# One-operation canary admission policy

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
