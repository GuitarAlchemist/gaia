# Gaia Architecture

This is the authoritative architecture index for Gaia. Detailed designs remain authoritative for their own bounded contracts; this file records the system-wide boundaries and points to those contracts without duplicating them.

## Kernel and authority

Gaia's coordination kernel has exactly six non-privileged verbs: `register`, `send`, `inbox`, `ack`, `heartbeat`, and `handoff`. Observation, delivery, acknowledgement, acceptance, and authority are separate transitions. Text, activity, and completion markers never grant commit, push, merge, deployment, spending, credential, or configuration authority.

The runtime inventory and adapter map are maintained in [README.md](README.md). Normative engineering constraints are maintained in [docs/engineering-and-research-principles.md](docs/engineering-and-research-principles.md).

## Durable delivery operations

A state-changing delivery operation has one boundary owner. That owner seals an Operation Envelope, derives stable Work Identity separately from Generation Identity, gates every mutation on durable revisions, projects provider results through a closed vocabulary, and leaves an immutable receipt chain. The canonical Draft operation contract is [docs/draft-operation-envelope.md](docs/draft-operation-envelope.md).

Adapters may implement persistence or provider effects, but they cannot reinterpret identity, freshness, authority, or terminal state. Ambiguous remote effects remain explicitly nonterminal until exact reconciliation; elapsed time and retry count cannot manufacture certainty.

## Boundary redesign circuit breaker

Repeated counterexamples at the same seam are architectural evidence, not a request for another local condition. Gaia stops implementation when independently reproduced failures show that the current boundary has multiple owners, erases an invariant-bearing distinction, or requires caller-specific knowledge to remain correct.

Recovery requires all of the following:

1. preserve failed attempts as immutable Failure Evidence;
2. name the repeated failure family and the owner that was missing;
3. compare genuinely different boundary designs;
4. select one owner for identity, provenance, revisions, effect ordering, and terminal projection;
5. encode every reproduced counterexample as RED contract behavior plus a mechanism-revert control; and
6. obtain fresh independent review against the exact replacement snapshot.

A revision increment, more lanes, or a larger test count does not reset the circuit breaker. Only a changed seam with evidence that closes the failure family does.

The decision to use a canonical operation boundary is recorded in [ADR 0001](docs/adr/0001-canonical-operation-envelope.md).
