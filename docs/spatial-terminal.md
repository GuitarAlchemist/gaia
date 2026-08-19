# Gaia spatial terminal

## Status

**Deferred design exploration.** This document grants no implementation, installation,
purchase, mutation, or integration authority.

## Decision

Treat spatial hardware such as Steam Frame as a replaceable Gaia terminal, never as an
authoritative control plane. Gaia remains the source of truth for WorkGraph state,
freshness, evidence, authority, and receipts. The terminal projects that state and emits
typed advisory intents for Gaia to validate.

```text
Gaia authoritative state
        -> read-only spatial projection
OpenXR terminal adapter
        -> selected node and typed advisory intent
Gaia validation and authority boundary
```

The same canonical projection model should support an ordinary web dashboard, an
ultrawide wearable display, and an OpenXR client. Device-specific rendering must not
become a second WorkGraph implementation.

## First falsifiable tracer bullet

Use one immutable fixture containing 20-50 artifact revisions and implement only:

1. deterministic projection of `fresh`, `stale`, `blocked`, and `unknown` nodes;
2. node selection;
3. provenance and stale-cascade inspection;
4. creation of one non-executing, typed advisory intent; and
5. parity checks proving that the web and OpenXR views derive from the same state.

The experiment succeeds only if users identify the actual blocking node faster or more
accurately than with the existing 2D dashboard. Measure task time, error rate, simulator
sickness or fatigue, and frame-time stability. A visually impressive 3D graph without a
measured decision-quality improvement is a negative result, not a reason to integrate.

## Invariants

- The terminal owns no lock, lease, approval, routing, budget, or durable WorkGraph state.
- Losing the terminal cannot leave a mutation in an ambiguous state.
- Interaction produces advisory data; it never transfers authority.
- Projection coordinates and visual depth are derived views, not evidence or semantics.
- No new Gaia bus verb is introduced.
- OpenXR is the preferred portability seam; a Steam Frame-specific API requires a
  separately justified capability that OpenXR cannot express.

## Revisit gate

Revisit after Gaia emits deterministic, provenance-bound artifacts suitable for spatial
projection. Before purchasing hardware or starting product work, run the tracer bullet
on an available OpenXR headset or simulator and independently review its usability and
authority-boundary evidence.
