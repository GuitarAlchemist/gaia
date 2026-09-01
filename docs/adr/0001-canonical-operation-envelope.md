# Own delivery identity and effects behind a canonical operation envelope

PRs #45 and #58 failed because callers, storage, provider adapters, and projections could independently reinterpret mutable work identity, generation, revisions, and effect results. Gaia therefore places each privileged delivery operation behind one closed immutable Operation Envelope and one boundary owner; stable Work Identity is distinct from Generation Identity, and adapters receive only derived capabilities rather than caller-authored authority. This costs a stricter collector and explicit refusal states, but it prevents retries, provider behavior, or changing observations from manufacturing a second effect or a false terminal result.

## Consequences

Failed implementations remain immutable Failure Evidence. If fresh review reproduces the same invariant failure after a repair, the Redesign Circuit Breaker blocks another local patch until a replacement seam makes the counterexample RED, assigns one owner, and passes the same contract across production-shaped and deterministic adapters.
