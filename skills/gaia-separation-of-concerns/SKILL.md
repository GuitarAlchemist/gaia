---
name: gaia-separation-of-concerns
description: Design or review Gaia modules when domain decisions, orchestration, persistence, transport, observability, or privileged effects risk becoming coupled. Use for boundary leaks, oversized cores, adapters making policy, runners inventing identity or authority, and changes that must remain replaceable and failure-isolated. Skip trivial pure helpers and changes already confined to one obvious adapter.
---

# Gaia Separation of Concerns

Keep the trusted core small without creating ceremonial layers.

## The boundary model

- **Core:** owns canonical identity, invariants, deterministic transitions, typed refusals, and
  terminal truth. It does not read the environment, call a provider, schedule work, inspect a
  filesystem, or depend on a clock.
- **Collector:** turns external observations into one closed, validated input. It grants no
  authority and performs no privileged effect.
- **Persistence adapter:** gives the core durable compare-and-swap and replay semantics. Storage
  identifiers and layouts do not enter canonical domain identity.
- **Provider adapter:** translates one closed effect request into one concrete provider call and
  validates exact read-back. It does not choose whether the effect is allowed.
- **Admission adapter:** proves current effect capacity and authority. Caller claims are not proof.
- **Runner:** sequences collection, durable enqueue, dispatch, reconciliation, and restart. It
  invents neither identity nor policy.
- **Projection/telemetry:** reports committed evidence. Its failure cannot change the durable
  result and its freshness is not completion.

## Review a proposed boundary

1. Name the invariant and assign exactly one owner.
2. List what crosses the seam. Prefer a small closed value over a provider object, mutable caller
   record, local path, credential, or free-form status.
3. Ask whether the core still behaves byte-identically with an in-memory adapter and a
   production-shaped adapter.
4. Ask whether each adapter can fail or be replaced without changing domain truth.
5. Trace every privileged effect back to durable intent and trusted admission.
6. Trace every dashboard claim back to committed evidence; do not let telemetry close a gate.

## Boundary leaks worth reporting

- Core code reads `process.env`, time, filesystem state, HTTP, CLI output, or provider payloads.
- A runner derives identity, decides policy, or retries a possibly completed effect blindly.
- An adapter chooses business state, silently coerces missing capability, or returns unbounded
  provider diagnostics.
- Storage OIDs, paths, locks, or timestamps change canonical domain identity.
- Callers branch on adapter type or inspect transport details to understand a result.
- Observability failure blocks work, or liveness is presented as progress.
- Two modules can independently declare the same transition terminal.

For each finding, name the mixed responsibilities, the invariant owner, the concrete failure, and
the smallest seam that restores ownership. Prefer moving one decision over adding a framework.

## Proof

- Run one black-box contract against memory and production-shaped adapters.
- Include a positive equivalence case, typed refusal cases, and a mutation control that breaks the
  proposed mechanism.
- Test crash/replay at effect boundaries when an external effect exists.
- Verify the source object was not mutated and adapter-specific data did not escape.

## Avoid ceremonial separation

Reject an extraction that only moves code, increases the number of concepts callers must know, or
creates pass-through modules without hiding a decision. A useful boundary reduces shared knowledge,
contains failure, or makes an invariant independently testable. After the same invariant-bearing
failure survives a repair, stop adding conditions and redesign the ownership boundary.
