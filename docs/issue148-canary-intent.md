# Issue #148 — bounded observation-priority canary

Historical source-branch intent for the #148 candidate. This is not a runtime grant, a worker result, or proof of unattended source preparation. Work item: GuitarAlchemist/gaia#148, related to GuitarAlchemist/gaia#53. The parent issue remains open; do not close it for this slice.

## Outcome

Let a read-only consumer identify the highest-severity, newest engineering observations without losing source identity or inventing resolution state. R0 normalization and R1 bounded batch admission already exist in `src/test-observation-intake.mjs`; do not reimplement them. Their projection orders by observation identity rather than attention priority.

Implement the smallest pure, bounded attention-priority view over the existing validated observation ledger. Reuse `projectTestObservations` and preserve its existing ordering/contract for existing callers. The new view should expose source links, exact current revision identifiers and UNKNOWN states, rank source-declared severity first and recency second with deterministic identity tie-breaking, and apply an explicit validated positive limit. Do not infer that a source claim of being fixed resolves an observation. State that source severity and claims remain source-asserted.

## Verification and limits

The original canary asked for focused tests in `tests/test-observation-intake.test.mjs` covering priority and deterministic ties, bounds and invalid limits, unknown/unavailable evidence retaining source/history, and duplicate/edited readings reusing existing admission semantics. Its implementation scope was `src/test-observation-intake.mjs`, those tests, and optionally `docs/issue53-feed-r1.md`; it excluded new dependencies, configuration, storage, scheduling, credentials, network effects, and worker-side publication or deployment.

The coordinator verified the source feed `GuitarAlchemist/.github#73` was readable on 2026-09-13; that does not establish completeness or make fixture tests live integration evidence. Successful canary proof requires a real pump claim, worker patch, independent reviewer result, and matching durable receipt; this intent file alone proves none of them. Repository integration remains subject to the current review and publication gates.
