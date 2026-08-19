# Discrete Coordination Mechanics

Status: advisory design doctrine and experiment candidate. This document does not add a bus verb, grant routing authority, or claim that Gaia implements a mechanical continuum model.

## Provenance

This integration decision is derived from the concluded GA research artifact `docs/research/2026-08-09-mechanical-tensors-agentic-systems.md`:

- source repository: `GuitarAlchemist/ga`;
- source revision: `e430c7c19121f50f8d1bbb818c77c5c1e1923c9d`;
- immutable source: <https://github.com/GuitarAlchemist/ga/blob/e430c7c19121f50f8d1bbb818c77c5c1e1923c9d/docs/research/2026-08-09-mechanical-tensors-agentic-systems.md>;
- source bytes: `31668`;
- source SHA-256: `9df446ffa6b5ea2fc06d51eb29a5dbbe1bcc8732a73b45854bd57db6510183a9`;
- source status: `concluded`;
- source confidence: `medium`.

The source remains authoritative for its research record. This document records only the subset adopted by Gaia so that later changes do not silently reinterpret the original evidence.

## Adopted model

Gaia treats coordination as a typed discrete event graph before considering any continuum analogy.

For each resource kind, an analysis window may derive:

- inventory change, inflow, outflow, explicit sources, sinks, and reconciliation residuals;
- backlog, arrival rate, service rate, utilization, and tail latency;
- edge gradients and graph-Laplacian disagreement energy;
- source-to-sink progress, retry or handoff circulation, and cyclic churn;
- Petri-net boundedness, liveness, deadlock freedom, and conserved-resource invariants when places and transitions have formal semantics;
- stability, hysteresis, recovery, and cumulative damage under repeated faults.

Every resource retains its own unit. Messages, work items, bytes, tokens, time, currency, and failures must not be collapsed into one synthetic "stress" scalar without an explicit dimensionless normalization, calibrated metric, and held-out validation.

The preferred vocabulary is `balance residual`, `edge-flow field`, `queue pressure`, `interface gradient`, `cycle exposure`, and `response Jacobian`. `Stress tensor`, `strain`, `shear`, `buckling`, and `fatigue` may be used only when the corresponding mathematical structure and falsifier are declared.

## Deferred or rejected claims

Gaia does not currently claim:

- a Cauchy stress tensor over agents;
- a stable geometric task continuum;
- a torseur or wrench in an SE(3) frame;
- a von-Mises-like equivalent coordination stress;
- a mechanics-derived automatic router or authority policy.

A tensor candidate becomes admissible only when a versioned task geometry, coordinate transformations, commensurate units, sufficient directional rank, acceptable conditioning, covariance tests, and held-out gain over queue and graph baselines all exist. Until then the object must be named for the observable it actually computes.

## First tracer bullet

The permitted first experiment is read-only and advisory:

1. consume an immutable copy of a Gaia event log;
2. derive typed actor-window and edge-window relations with DuckDB or an equivalent analyst bench;
3. compute balance residuals, backlog, tail latency, graph gradients, Laplacian energy, and cycle exposure;
4. compare them with preregistered lane-count-plus-event-count, queue-only, and centrality-plus-queue baselines;
5. execute a deterministic accelerated load-and-fault fixture with slow acknowledgements, lane loss, version drift, lock contention, hysteresis, and recovery observations;
6. evaluate held-out stall, forced-handoff, latency-breach, fail-closed, and unresolved-backlog outcomes using time splits separated by runtime version and workload family;
7. emit one content-addressed `coordination-shape` advisory artifact with units, nulls, provenance, uncertainty, and no authority;
8. keep automatic routing disabled until an independent review accepts predictive gain, invariance controls, and transfer across the preregistered versions and workload families.

Required negative controls include actor relabeling, harmless unit conversion, timestamp permutation, degree-preserving edge rewiring, workload-label permutation, and explicit missing-telemetry cases. A non-zero unexplained conservation residual is evidence of missing or inconsistent telemetry, not a value to smooth away.

Reject the mechanics extension if it does not improve held-out calibration or prediction over the centrality-plus-queue baseline, if its conclusion changes under harmless unit or basis changes, or if its thresholds fail to transfer across preregistered runtime versions and workload families. A failed transfer remains a recorded negative result; it must not be repaired by retuning the locked holdout.

## Relationship to IX

IX may provide deterministic graph, queue, signal, optimization, and analyst-bench computations for this tracer. DuckDB and executable IX modules perform the current read-only analysis. IXQL is still a non-executable, spec-only planning and verification language joined to those implementations by content-addressed artifacts. Neither surface becomes the authoritative bus, scheduler, lock manager, safety controller, or hard-real-time loop.

Promotion from an advisory view requires immutable evidence, a declared public seam, Design It Twice, strict TDD, independent Standards and Spec review, and a separate authority decision.
