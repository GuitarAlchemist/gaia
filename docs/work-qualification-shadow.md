# Work qualification: isolated shadow experiment

Operator request,30October2026: qualify personal GuitarAlchemist work before
assignment, including value, coherence, currentness, duplicates, dependencies,
acceptance, scope, permissions, budget and an available owner. No live effects.
Base:3be8bffcf61ee8c1920b2cf2f8f13923d8c535e3. This exclusive clone/branch is owned
by the Codex task; native name/cwd metadata showed no active Gaia writer. This is
an observation, not a distributed ownership lease.

## ENG-02 decision before implementation

Option A: put qualification directly into createPortfolioFactory().advance()
before authority.consume(). Advantage: one eventual admission seam. Cost: changes
live dispatch behavior before the qualification contract has real evidence.

Option B: pure derivation over frozen references and explicit assessments, plus
a local-file-only shadow CLI. Advantage: independently falsifiable without any
GitHub write, claim, authority consumption or model. Cost: a caller must supply
observations; no semantic quality is inferred from an issue title or a label.

Choose B for this reversible experiment. Existing pump-candidates is grooming
and excludes ready-for-agent; it stays unchanged. The factory's own local CAS
ledger is not described as a distributed lease. No integration into advance yet.

Usage sketch: qualifyWork({issue:{ref,version},context:{ref,version},priority,
proposalKind,decisionMode,decisionEvidence:[{ref,version}],checks}). Each check is supported/contradicted/unknown,
with a bounded reason and versioned evidence. Supported/contradicted without
evidence fails closed. Unknown is not false, zero dependencies or permission.

Outputs separate RESEARCH/DECISION/SPLIT/READY/REJECTED_PROPOSAL from operational
WAITING_HUMAN/DEPENDENCY/ALREADY_OWNED/RECONCILE_REQUIRED barriers. No average
score can override a barrier. READY is a proposal classification: dispatch is
always unauthorized here. An explicit protected human decision retains its gate;
a delegated reversible technical choice does not acquire WAITING_HUMAN merely
because it is a design choice. This slice records no accepted product decision,
does not close an issue, and executes no experiment.

Falsifiers: missing/changed evidence produces READY; a parent is treated as a
dependency; an existing owner is displaced; a reversible delegated choice gains
an invented human gate; READY consumes authority; shadow CLI accepts --apply.
Tests cover these counterexamples and immutable generation-specific outputs.

Real public issue samples468,482,484,485 use their captured updated_at plus body
digest. Assessments explicitly retain unknowns for ownership, duplicate checks,
permissions and budget. No unchecked NONE assertion is manufactured. The snapshot
is not a fresh runtime feed. The operator's supplied sample kinds are research
for468 and protected decision for482/484/485; their eventual prototype work can
be delegated without accepting the protected final decision.

Rollback: remove the new pure module, shadow CLI, fixtures/tests and this note;
restore only the README gate count. No runtime or repository state needs undoing.

Review evidence: the independent contract review passed12focused tests; its usage
sketch omission was corrected above. Assessments remain caller assertions:
expectedVersions optionally compares top-level issue/context generations, not
the truth of every evidence reference. The independent standards review found
no code issue, but identified a promotion evidence gap: the preimplementation
design note has no digest-bound Decision Receipt. No earlier receipt is invented
or backdated. This local candidate is not promoted, pushed, or live integrated.
