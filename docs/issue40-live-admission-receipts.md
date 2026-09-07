# Restore normal pump admission before multi-repository drain

Status: diagnostic repair and normal producer merged in PR125; workflow connection
is a separate opt-in follow-up, not yet live activated.
Base: main `987e500273853b68a965834d870a0d2b480eac9a`.

## Evidence

Current-main normal intake run 34047789984 refused `InvalidArguments` before creating a Draft.
Parser-only reproduction with actual non-secret repository variables reached no runtime effect.
`GAIA_MANAGED_ROUND_JSON` is valid JSON but its effectClaim has only a schema field.
`validateManagedDraftConfiguration` reports `InvalidEffectClaim`; the CLI hides this distinction.
The canary path derives managed-round evidence from an explicit policy plus live operation/Actions
observations. Normal intake instead expects static externally supplied managed-round evidence.

## Verified diagnostic repair

The CLI now distinguishes the closed `InvalidEffectClaim` preflight refusal from
`InvalidArguments`. It exports neither the input value nor an exception message/stack.
The existing validator and refusal-before-runtime behavior are unchanged. A schema-only
claim, an excessive lease, or an unknown claim field remains refused; this change does
not create a claim or authorize an effect.

Focused verification: `node --test tests/hosted-draft-pump-cli.test.mjs
tests/hosted-draft-intake-cli-seam.test.mjs` passed 30 tests. The discriminating tests
first failed against the old generic diagnostic. Read-only preflight against the actual
repository configuration also returned `InvalidEffectClaim`, with zero runtime effects.
This is diagnostic progress only, not successful normal intake.

## Producer decision frontier

Existing Actions admission verifies the sealed workflow/run; the collector independently
checks the authorized ready-label event and evidence branch. These are reusable gates,
not missing runtime implementations. The missing normal seam is production of the
managed-round responsibility/command/claim from those gates and the current durable
operation. A static repository variable cannot remain a fresh per-operation lease.

The current canary producer is bounded to an explicit issue/generation and one-hour
policy. Do not replay or rename that policy as a normal authorization. The next bounded
change must separate repository-scoped ownership policy from derived operation evidence,
preserve independent reviewer identities required by the managed-round contract, and
leave agent execution and merge authorization separate. The portfolio already has
multi-repository survey/advance contracts; do not rebuild a scheduler to fix this seam.

## Bounded outcome and acceptance

- Identify and reuse the legitimate operation-bound evidence producer for normal admission.
- Preserve exact repository, operation, generation, lease and verified Actions execution bindings.
- Never fill placeholder claim fields, replay a consumed canary policy, or fabricate authorization.
- Missing/malformed configuration produces a precise non-secret diagnostic before any effect.
- Preflight refusal starts no runtime; stale CAS losers cannot rewrite a winning revision.
- Refusal after durable EFFECT_STARTED preserves the existing lookup-only ambiguity rule;
  zero provider creation is not permission to erase intent or retry an uncertain effect.
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

## Repository-scoped normal-admission producer (implementation slice, unactivated)

`src/normal-admission-policy.mjs` adds a normal-admission analogue of the canary producer named
in the frontier above: `validateNormalAdmissionPolicy`, `bindNormalAdmissionPolicy`,
`prepareNormalManagedRound`, and `createNormalDraftAdmission`. It uses deterministic
canonical/digest helpers and the unchanged `GaiaRoundReceiptV0`/`GaiaRoundReceiptV1` shapes, the unchanged
`GaiaManagedRoundEffectClaimV0` shape, and `validateManagedDraftConfiguration` without
modification. It also reuses the existing effect-agnostic gates unchanged: the collector's
authorized ready-label event, `createGitHubActionsDraftAdmission`'s sealed-workflow/run
verification, and the durable operation store's live `EFFECT_STARTED` snapshot.

A `GaiaNormalAdmissionPolicyV0` differs from the canary policy in exactly the way this
document's frontier required: it pins repository (`nodeId`/`owner`/`name`), `effectActorId`,
`accountableOwner`, `effectOwner`, `reviewOwners.{standards,spec}`, `allowedEffect`
(`CREATE_DRAFT` only) and `roundBudget` (fixed at `1`), but never an issue, `operationId`,
`generationKey` or `headRevision` — those are read from the live operation snapshot at bind
time, once per candidate, so one policy can admit any eligible operation in its declared
repository instead of being a renamed one-issue canary grant. `reviewOwners` are required and
validated exactly as `pr-delivery-round-history.mjs`'s existing `responsibility()` validator
requires for V0; omitting them, as an earlier read-only advisory pass floated, was
checked against that validator and would fail closed, not merely be unsafe in principle.
V1 adds a writer identity and the existing independent-agent reviewer validation,
including provider-alias rejection. These are assignments, not approvals or authentication.

The CLI gained one new opt-in flag pair, `--normal-policy` / `GAIA_NORMAL_POLICY`, parallel to
`--canary-policy` / `GAIA_CANARY_POLICY` and mutually exclusive with it. Supplying it derives
`create.receipt` / `create.effectClaim` from {policy, live snapshot, verified Actions epoch}
instead of trusting an externally supplied static `GAIA_MANAGED_ROUND_JSON` blob for those
fields. The prior static-blob legacy path is completely unchanged for callers who do not pass
either flag, and gains no new privilege from this change. The original PR125 slice supplied
no workflow selection or policy file. The follow-up connection below exposes selection;
a policy file must still be supplied explicitly, and no such file is checked in here.

This is an implementation slice for review, not an authorization to run it against the
production repository, and not proof of an actual normal pump tick. Tests cover: missing/
malformed policy, bad owner/reviewer shapes, repository/operation/head/epoch mismatch,
stale/future/expired policy windows, a changed claim or policy between the two live rereads
(zero effects on refusal), a valid generation passing the unmodified managed validator, and no
extra effect on lookup/reuse. Per this document's acceptance bar, a current-main `intake` run
that presents a real policy plus a live operation snapshot and verified Actions epoch, and
reconciles its resulting Draft/receipt readback, remains the only accepted proof of normal
admission — a green test run alone is not that proof.

The architecture map now names this opt-in candidate and its residual boundaries.
Coordinator integration reproduced two defects before repair: V1 assignments were unsupported,
and a different valid operation returned by the ledger could replace the selected identity.
The seam now pins immutable identity and envelope across rereads, while permitting legitimate
state/revision transitions. Both discriminating tests failed before the corresponding fixes.
Focused verification passed 50 cases; runtime integration passed 21 including the unchanged
canary path, normal creation without a static claim, and zero effects after changed policy,
ledger, expiry or stopped Actions. These use injected provider fixtures and do not establish
live GitHub admission. The first full run passed 2008, failed one README count check and skipped
one platform case; the count was corrected and the full rerun is reported in the PR.

Independent Spec review found an overbroad original acceptance statement promising that
every negative case left the entire operation unchanged. The existing reconciler persists
EFFECT_STARTED before entering the provider; a later policy/Actions refusal records
EFFECT_AMBIGUOUS even when the fixture proves zero creation. Tests now assert that durable
disposition and lookup-only replay. This is a known liveness limit, not automatic recovery:
scheduled quarantine can skip the unchanged ambiguous item but does not settle it. Resolving
positive evidence of no attempt needs a separately reviewed durable protocol; this slice
does not weaken ambiguity protection or manufacture a safe-to-retry grant.

## Opt-in workflow connection follow-up

The manual `normal_policy` input defaults to false. Scheduled/labeled runs can select
normal admission through `GAIA_NORMAL_POLICY_ENABLED`; manual runs use their own input.
The identity step computes one selection, rejects canary/preparation conflicts, retains
all four required identity credentials, and only requires the old managed-round blob
for legacy effect intake. Its output binds the canonical sealed-checkout policy path
to `GAIA_NORMAL_POLICY`. The CLI keeps enforcing schema, scope and runtime expiry.

No policy file, credential change, variable enablement or live dispatch is included.
Positive parser fixtures are not authorization or evidence of a successful normal tick.
The existing Actions, ledger and external-effect reconciliation boundaries are unchanged.

Acceptance: execute the actual identity PowerShell body under synthetic resolved inputs;
prove normal/legacy selection and conflict refusal; reconstruct the real workflow-to-CLI
environment; prove missing policy starts no runtime despite valid legacy data; prove a
normal policy reaches configuration despite a stale blob; and show removing its binding
breaks that proof. Keep canary, preparation and single-writer observation behavior intact.
