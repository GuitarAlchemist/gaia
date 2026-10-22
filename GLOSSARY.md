# Gaia Delivery Context

Gaia coordinates evidence-bearing software delivery while keeping observation, acceptance, and authority distinct.

## Language

**Operation Envelope**:
The closed, immutable statement of one requested delivery effect, its authoritative provenance, and the exact generation against which it may be reconciled.
_Avoid_: Task payload, request object

**Work Identity**:
The stable identity of logical work across retries, observations, and generations.
_Avoid_: Run id, lane id, prompt id

**Generation Identity**:
The identity of one exact source, policy, and readiness generation of a Work Identity.
_Avoid_: Version, attempt

**Redesign Circuit Breaker**:
A delivery gate that stops local patching after independently reproduced failures show that a boundary cannot enforce its declared invariants.
_Avoid_: Retry limit, failure counter

**Failure Evidence**:
An immutable failed attempt retained with its exact inputs, observations, and verdict so a replacement design can be tested against the same counterexamples.
_Avoid_: Dead work, discarded draft
