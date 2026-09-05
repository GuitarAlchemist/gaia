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

## Implemented R0 slice

Shipped modules and gates, added after the source probe above.

- `src/test-observation-intake.mjs` — the pure core. It imports `node:crypto` and nothing else:
  no provider, no sibling repository, no clock, no filesystem, no process. It owns the reading
  verifier, the normalizer, the append-only ledger and the read model.
- `src/gh-test-observation-source.mjs` — the injected read-only input adapter. Its published
  surface is one verb, its invocation is a plain read of one comment resource with no request body
  and no verb override, and the suite asserts the shipped file cannot spell a mutating flag.
- `tests/test-observation-intake.test.mjs` and
  `tests/fixtures/test-observation/sanitized-issue-73-comment.json`.

### What the gates prove, and what they do not

Proven: identity and raw-source digest are deterministic and exact; the digest is of the UTF-8
body string, not of the transporting document; a replayed unchanged comment is admitted once; an
edit appends a revision linked to the one it followed and leaves the earlier revision byte-equal;
a backwards-moving source is recorded as `SOURCE_TIME_REGRESSED` without content and cannot
replace the newer evidence; unavailable, deleted, malformed, unstructured and invalid-timestamp
sources each produce their own explicit unknown reason; `effect` and `authority` are the constant
`NONE` regardless of what the body asserts; a source-declared severity is marked
`SOURCE_DECLARED`; facts, interpretations and recommendations project as three separate lists;
and the source's argument list contains no mutating token.

Not proven: any live read. The fixture is synthetic — see
`tests/fixtures/test-observation/PROVENANCE.md` — so its digest is deliberately not the digest
this document records for the live body. `node --test` performs no network call, and nothing here
is evidence of live integration.

### Deliberate limits of this slice

- A not-found comment reads as `UNAVAILABLE`, never `DELETED`: deletion and invisibility are
  indistinguishable at that seam, and `DELETED` is reserved for a source that can prove it.
- Claim kinds come only from a source's own explicit `Fact:` / `Interpretation:` /
  `Recommendation:` line prefix. No sentence is promoted into a kind by resembling one.
- The ledger is an in-process value. Durable storage, multi-comment intake, and any transition
  driven by an observation are later slices.
