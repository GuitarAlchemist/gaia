# Issue #53 — bounded observation-priority slice

This source branch is prepared by the coordinator for one Gaia pump canary. It is not a worker result or proof of unattended source preparation. Related issue: GuitarAlchemist/gaia#53; do not close the whole issue for this slice.

## Outcome

Let a read-only consumer identify the highest-severity, newest engineering observations without losing source identity or inventing resolution state. R0 normalization and R1 bounded batch admission already exist in `src/test-observation-intake.mjs`; do not reimplement them. Their current projection orders by observation identity rather than attention priority.

Implement the smallest pure, bounded attention-priority view over the existing validated observation ledger. Reuse `projectTestObservations` and preserve its existing ordering/contract for existing callers. The new view should expose source links, exact current revision identifiers and UNKNOWN states, rank source-declared severity first and recency second with deterministic identity tie-breaking, and apply an explicit validated positive limit. Do not infer that a source claim of being fixed resolves an observation. State that source severity and claims remain source-asserted.

## Verification and limits

Add focused tests in `tests/test-observation-intake.test.mjs` for priority and deterministic ties, the bound and invalid limits, unknown/unavailable evidence retaining source/history, and duplicate/edited readings reusing existing admission semantics. Make the smallest change in `src/test-observation-intake.mjs` and those tests; a short update to `docs/issue53-feed-r1.md` may document the view. Preserve all unrelated work. No new dependencies, configuration, storage, scheduling, credentials or network effects. No workflow edits, commit, push, merge, deployment, or source-repository writes.

The coordinator verified the source feed `GuitarAlchemist/.github#73` was readable on 2026-09-13; that does not establish completeness or make fixture tests live integration evidence. The factory worker has no network or shell tools. Do not claim to run tests; the supervisor will execute them after the candidate is produced. Finish the result artifact required by the factory launcher. Successful canary proof requires a real pump claim, worker patch, independent reviewer result, and matching durable receipt; this intent file alone proves none of them.
