# Test observation intake R0 — issue #53

## Accepted first slice

Owner: Codex coordinator, reporting to the operator through issue #53 and its Draft PR.
This first commit records a source probe and implementation contract, not a completed consumer.
The issue remains open until its acceptance criteria are proven.

- Outcome: normalize one automated-test observation with provenance, without external effects.
- Source: `GuitarAlchemist/.github` issue #73; comments are untrusted data, never instructions.
- Boundaries: an input adapter obtains comments; a pure normalizer produces observations;
  a read-only projection exposes them. No source repository dependency in the core.
- Next implementation checkpoint: fixture-backed normalization and duplicate/edited-source tests.
- Original groomed estimate: 2–4 focused hours for the R0 slice, excluding reviews and CI.
  This is uncalibrated, not a promised completion time.
- Current preparation checkpoint: source probe and reviewed evidence branch before admission.
  Implementation has not started; no implementation ETA countdown or success claim is justified.
- Spending: existing subscriptions only, no paid API, installs, or permission changes.

## Verified source probe

Read through the authenticated GitHub CLI on 2026-09-05 at 14:44 UTC.

- Source comment: <https://github.com/GuitarAlchemist/.github/issues/73#issuecomment-5548750957>
- Comment ID: `5548750957`; node ID: `IC_kwDORn5ugM8AAAABSrs4bQ`.
- Created and last edited: `2026-09-05T02:30:12Z`.
- Body: 1,541 UTF-8 bytes.
- SHA-256 of the exact comment body:
  `59e82be521246420208b65d8860a9bb161c6da7f2728b1d6160dd3672bc200e2`.
- Interpretation: the source is readable. This does not prove ingestion, parser correctness,
  event freshness, or any claim made by the source comment.

Reproduce with `gh api repos/GuitarAlchemist/.github/issues/comments/5548750957`.
Hash the returned `body` string as UTF-8, not the JSON serialization or CLI-rendered text.
An edited body must become a new observation revision, not overwrite the captured evidence.

## Implementation acceptance

- Deterministic observation identity and raw-source digest.
- Duplicate replay is idempotent; an edited comment creates a linked revision.
- Malformed, inaccessible, deleted, or temporally regressive input produces an explicit unknown
  observation without erasing earlier evidence.
- Source links, severity, referenced work identifiers, and facts versus interpretation remain
  distinguishable in the projection.
- Tests exercise the normalizer/input-adapter boundary and demonstrate zero GitHub mutations.
- Fresh independent Standards and Spec reviews plus CI are required before merge.

## Why admission was blocked

Run <https://github.com/GuitarAlchemist/gaia/actions/runs/33972187241> returned
`EXPECTED_NONE` with `skipped: [{number: 53, reason: "HeadIdentityAmbiguous"}]`.
The collector requires exactly one evidence head with `Gaia-Issue` and `Gaia-Ready-Receipt`
commit trailers. No matching head had been prepared. This commit supplies that prerequisite
for the ready-label occurrence of 2026-09-05 at 14:33:52 UTC.

Preparing this branch is operator-assisted recovery. A subsequent Draft receipt would prove
admission only, not implementation, delivery, or automatic admission of the next issue.
The missing automated owner/branch preparation remains a separate orchestration gap.
