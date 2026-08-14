# Gaia Engineering and Research Principles

Status: normative process doctrine. These principles constrain how Gaia work is proposed, executed, reviewed, and promoted. They do not grant runtime authority, approve an artifact, or advance a milestone.

## Purpose

Gaia is an evidence-bearing software factory, not a prompt-to-code shortcut. It should make the cheapest safe decision at each seam, preserve uncertainty rather than hide it, and leave enough evidence for another actor to replay or reject the result.

The doctrine has two layers:

- engineering principles govern module boundaries, change execution, authority, and reversibility;
- scientific principles govern questions, experiments, evidence, uncertainty, and claims.

Freshness, quality, acceptance, and authority remain independent axes. A fresh artifact may be wrong; a high-quality artifact may be stale; an accepted artifact may grant no authority.

## Engineering principles

### ENG-01 — Frame the problem before proposing a solution

Name the affected actor, observed failure or opportunity, constraints, prior art, success criteria, and falsifiable non-goals. A proposal without a concrete caller or consumer is not ready for design.

### ENG-02 — Design It Twice at load-bearing seams

Apply Matt Pocock's **Design It Twice** procedure when work creates or changes a public interface, module seam, persistent schema, authority boundary, orchestration protocol, cross-repository contract, or other expensive-to-reverse decision. It is not required for trivial, local, behavior-preserving changes.

Before implementation:

1. record constraints, dependencies, invariants, and a non-proposal usage sketch;
2. produce at least two genuinely different designs, and normally three for a one-way door;
3. vary the optimization target deliberately: minimal surface, maximum adaptability, common-caller simplicity, or ports-and-adapters isolation;
4. describe each interface, hidden complexity, failure modes, dependencies, and trade-offs;
5. compare alternatives on module depth, locality of change, seam placement, reversibility, operational risk, and testability;
6. select one design or an explicit hybrid in a digest-bound Decision Receipt.

Alternative generation is advisory. Multiple variants from one context are not independent approval, and majority vote does not establish correctness.

### ENG-03 — Prefer deep modules and information-hiding seams

A module should expose a small, coherent interface while hiding substantial policy or mechanism. Decompose around information likely to change, not merely around execution steps. A seam is justified when it localizes change, enables independent verification, or contains authority; speculative layers and pass-through wrappers are rejected.

### ENG-04 — Separate concerns and authority

Keep domain decisions, transport, persistence, policy, observation, and privileged effects distinct. Use least privilege, fail-safe defaults, complete mediation at authority boundaries, and explicit separation of privilege for irreversible actions. The six non-privileged bus verbs carry references and requests; they do not become hidden deployment, spending, routing, or approval verbs.

### ENG-05 — Use the smallest end-to-end tracer bullet

For non-trivial behavior, first build the smallest vertical slice that crosses every required seam and can fail honestly. A green unit test, isolated layer, generated document, or local prototype alone is not integration.

### ENG-06 — Make transitions deterministic, idempotent, and replayable

Every state-changing transition needs stable identity, explicit inputs, preconditions, outputs, and a Transition Receipt. Repeating the same accepted request must either produce the same result or return the prior result without duplicating effects. Replay from immutable evidence must reconstruct the material decision state.

### ENG-07 — Treat reversibility as a typed design property

Classify changes as freely reversible, compensatable, migratable, or one-way. State the rollback or compensation path and the evidence that triggers it. One-way doors require explicit human authority and a stricter independent review than ordinary changes.

### ENG-08 — Independent verification is a separate transition

The author of a change cannot approve it. Verification binds to exact inputs, digests, tests, controls, and scope. A marker is evidence that work stopped, not evidence that its claims are true.

## Scientific principles

### SCI-01 — State a question, hypotheses, and falsifiers first

An experiment begins with a bounded question, at least one testable hypothesis, plausible alternatives, and observations that would disconfirm each claim. Post-hoc hypotheses must be labelled exploratory.

### SCI-02 — Prefer discriminating tests over confirmatory demonstrations

Choose the cheapest test likely to distinguish the leading alternatives. Record positive controls, negative controls, boundary cases, and known failure cases before examining the result. A demonstration that can only succeed is not an experiment.

### SCI-03 — Bind claims to immutable evidence and provenance

Evidence records stable identifiers, content digests, producer, method or code revision, parameters, units, timestamps as observations rather than authority, and derivation links. Missing or unverifiable provenance produces `UNKNOWN`, not an inferred success.

### SCI-04 — Separate reproducibility from replication

Reproducibility means an independent actor can obtain consistent results using the same inputs, code, methods, and conditions. Replication tests the claim with new evidence or independently collected conditions. Gaia should require reproducibility before promotion and replication or held-out evidence for claims intended to generalize.

### SCI-05 — Quantify uncertainty without collapsing its kinds

Report units, nullability, epistemic and aleatoric uncertainty where applicable, sample size, calibration or coverage, sensitivity to assumptions, and known model inadequacy. Do not compress conflict, ignorance, risk, freshness, and confidence into one scalar.

### SCI-06 — Compare against baselines out of sample

Predictive or advisory mechanisms require a declared baseline and evaluation on evidence not used to select or tune the method. Report negative and null results. A fitted exponent, attractive visualization, or better in-sample score grants no action authority.

### SCI-07 — Preserve the full experimental record

Retain the question, alternatives, plan, immutable inputs, code and environment identity, raw observations, exclusions, analyses, failures, and verdict. Corrections supersede prior revisions; they do not silently rewrite them.

## Required workgraph artifacts

The smallest applicable set is required; trivial work should not manufacture paperwork.

| Artifact | Required content | Gate it informs |
| --- | --- | --- |
| Mission Brief | problem, consumer, scope, non-goals, success and stop conditions | permission to design |
| Design Alternatives | competing interfaces and explicit trade-offs | seam selection |
| Decision Receipt | selected design, rejected alternatives, reversibility class, exact inputs | permission to implement |
| Experiment Plan | hypotheses, falsifiers, controls, baseline, evaluation set | permission to measure |
| Evidence Manifest | immutable inputs, provenance, units, environment and digests | reproducibility |
| Transition Receipt | preconditions, actions, outputs, idempotency key, compensation | state acceptance |
| Independent Review | exact-snapshot Standards and Spec verdicts, negative controls, residual risk | promotion |

These are Artifact Revisions in the workgraph. Edges state whether an input is required, advisory, or reference-only. A changed required input invalidates downstream freshness; it does not automatically revoke historical acceptance or grant replacement authority.

## Decision protocol

1. **Frame:** produce the Mission Brief and identify the smallest useful seam.
2. **Explore:** invoke ENG-02 only when its load-bearing trigger applies.
3. **Decide:** bind the selected design and reversibility class in a Decision Receipt.
4. **Experiment:** execute SCI-01 through SCI-06 over immutable evidence.
5. **Implement:** use a thin tracer bullet and emit replayable Transition Receipts.
6. **Verify:** a fresh actor replays the evidence and attempts declared falsifiers.
7. **Promote:** advance authority only when the named gate explicitly allows it.

## Rejected shortcuts

- treating design variants from one agent as independent review;
- equating activity, token use, elapsed time, or a completion marker with progress;
- accepting a report, prototype, green unit test, or GitHub publication as effective integration;
- adding a framework, database, abstraction, or agent role without a measured seam-level need;
- rewriting a hypothesis after seeing results without marking the change;
- suppressing nulls, failed mutations, adverse cases, or uncertainty;
- allowing a convenience path to bypass the same authority checks as the normal path.

## Sources and attribution

This document is an original Gaia synthesis. It references concepts rather than copying upstream implementations.

- Matt Pocock, [Design It Twice](https://github.com/mattpocock/skills/blob/c0d69015e0cc8b66715beb3f93f9e53256e20f30/skills/engineering/codebase-design/DESIGN-IT-TWICE.md), a procedure derived from John Ousterhout's module-design method.
- David L. Parnas, [On the Criteria To Be Used in Decomposing Systems into Modules](https://sunnyday.mit.edu/16.355/parnas-criteria.html).
- Jerome H. Saltzer and Michael D. Schroeder, [The Protection of Information in Computer Systems](https://www.mit.edu/~Saltzer/publications/protection/index.html).
- W3C, [PROV-DM: The PROV Data Model](https://www.w3.org/TR/prov-dm/).
- BIPM/JCGM, [Evaluation of measurement data — Guide to the expression of uncertainty in measurement](https://www.bipm.org/en/doi/10.59161/jcgm100-2008e).
- Mark D. Wilkinson et al., [The FAIR Guiding Principles for scientific data management and stewardship](https://doi.org/10.1038/sdata.2016.18).
- National Academies, [Reproducibility and Replicability in Science](https://nap.nationalacademies.org/catalog/25303/reproducibility-and-replicability-in-science).
- NIH, [Enhancing Reproducibility through Rigor and Transparency](https://grants.nih.gov/policy-and-compliance/policy-topics/reproducibility).
- John R. Platt, [Strong Inference](https://doi.org/10.1126/science.146.3642.347).
- NIST, [AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/).
