# Restore normal pump admission before multi-repository drain

Status: admitted investigation/repair seed; no fix or autonomy claimed.
Base: main `987e500273853b68a965834d870a0d2b480eac9a`.

## Evidence

Current-main normal intake run 34047789984 refused `InvalidArguments` before creating a Draft.
Parser-only reproduction with actual non-secret repository variables reached no runtime effect.
`GAIA_MANAGED_ROUND_JSON` is valid JSON but its effectClaim has only a schema field.
`validateManagedDraftConfiguration` reports `InvalidEffectClaim`; the CLI hides this distinction.
The canary path derives managed-round evidence from an explicit policy plus live operation/Actions
observations. Normal intake instead expects static externally supplied managed-round evidence.

## Bounded outcome and acceptance

- Identify and reuse the legitimate operation-bound evidence producer for normal admission.
- Preserve exact repository, operation, generation, lease and verified Actions execution bindings.
- Never fill placeholder claim fields, replay a consumed canary policy, or fabricate authorization.
- Missing/malformed configuration produces a precise non-secret diagnostic before any effect.
- Negative tests reject stale/mismatched evidence and leave the durable operation unchanged.
- A current-main run must reconcile its exact receipt and resulting Draft before success is claimed.
- Existing human-only execution, merge, credentials and billing boundaries remain unchanged.

If the normal producer needs an authority contract not yet supported, name that gap and separate
its design from diagnostic repair; a green parser test is not autonomous admission proof.

## Multi-repository destination

The user requested multi-repository drainage on September 6. A global prioritized work queue
should coordinate eligible work across declared repositories, with per-repository claims,
permissions, policy, capacity and independent delivery receipts. Shared token/CI budgets and
fairness must prevent one repository starving others or congesting integration. Repository names
must not leak into the pure admission rules. Start with a read-only inventory; do not broaden
credentials or activate effects on additional repositories merely because they are discoverable.
This destination does not expand this repair slice into a multi-repository scheduler rewrite.

## Ownership and verification

Codex owns integration in `codex/issue40-live-admission-receipts`. One writer per target;
independent review before delivery. Subscription agents only; no paid API, installation or
credential change. Report every five minutes while active, with readback and a compact sourced
mini-Gantt. Local/runtime/remote delivery and unattended continuation remain distinct claims.
