# Test observation intake R0 — issue #53

**Status.** The R0 slice described below is implemented, and the sections up to
"Why admission was blocked" are retained as dated history of how it was admitted. They describe the
state on 2026-09-05 before implementation began and are not a description of the current code; the
current contract is "Implemented R0 slice" onward.

## Accepted first slice (historical, 2026-09-05)

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

## Verified source probe (historical, 2026-09-05)

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

## Why admission was blocked (historical, 2026-09-05)

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
`SOURCE_DECLARED`; facts, interpretations, recommendations and the source's own authority-boundary
statement project as four separate lists; and the source's argument list contains no mutating
token.

Not proven by these gates: any live read. The suite runs against fixtures — see
`tests/fixtures/test-observation/PROVENANCE.md` — so its digest is deliberately not the digest
this document records for the live body. `node --test` performs no network call, and nothing here
is evidence of live integration.

### Deliberate limits of this slice

- A not-found comment reads as `UNAVAILABLE`, never `DELETED`: deletion and invisibility are
  indistinguishable at that seam, and `DELETED` is reserved for a source that can prove it.
- Claim kinds come only from a source's own explicit field label, in either the bare `Label:` or
  the Markdown `- **Label:**` form. The accepted labels are listed in the source-acceptance repair
  below. No sentence is promoted into a kind by resembling one.
- The ledger is an in-process value. Durable storage, multi-comment intake, and any transition
  driven by an observation are later slices.

## Source-acceptance repair (2026-09-05)

The first implementation of this slice refused its own source. Run against the real comment, the
shipped public seam returned `AVAILABLE -> UNKNOWN SOURCE_MALFORMED` with no digest and zero
claims, because it read only bare `Label:` lines while an automated observation writes Markdown
list items (`- **Observation:** ...`). That was an acceptance failure of R0, not a missing R1
feature: the approved seam has to consume the actual source.

The repair is structural and minimal. It adds no dependency, no effect, no provider call, and no
inference of meaning:

- the labelled-field reader accepts the emphasised Markdown form as well as the bare form;
- `observation`, `recommended next action` and `authority boundary` join the `fact`,
  `interpretation`, `recommendation`, `severity` and `work` labels already read,
  because those are the labels the source documents actually declare;
- `AUTHORITY_ASSERTION` is a fourth claim kind: what a source says about its own limits is reported
  as a statement, and `authority` remains the constant `NONE`;
- every claim now carries `basis: SOURCE_ASSERTED`, and the projection row carries `claimBasis`, so
  a `FACT` claim can never be read as a fact this repository verified;
- `MAX_TEST_CLAIM_LENGTH` rises from 500 to 2,000 so the real 456-character observation field is
  accepted whole. An over-long claim is still refused, never truncated;
- a work identity is additionally read from the exact `owner/name issue #N` form of a subject line.
  A bare `#117` still names nothing.

Evidence: `tests/fixtures/test-observation/captured-issue-73-comment-5548750957.json` replays the
coordinator's read-only capture byte for byte, and the suite asserts its digest equals the
`59e82be5…2bc200e2` recorded in the source probe above. Its provenance is `CAPTURED_REPLAY`, a
third value beside `LIVE` and `SYNTHETIC_FIXTURE`. **A replay is not a live read.** It shows the
seam consumes these exact bytes; only a fresh live read shows the comment can be reached now, and
this repository performed none.

## Review repair (2026-09-05)

Two independent reviews of the integrated branch requested changes, each with a reproduced
counterexample. All four findings are addressed; each was reproduced red before it was fixed.

1. **Stale replay could resurrect old content.** The admission baseline was the last entry
   appended, so a regression diagnostic moved it backwards: replaying the same stale read a second
   time compared it against itself, admitted it as a revision, and published old content.
   Admission now compares against a monotonic frontier — the newest source instant actually placed
   in the timeline, ignoring regression diagnostics and readings that carry no instant — a repeated
   stale read is `ALREADY_HELD`, and the projection publishes the newest placed reading rather than
   a stale diagnostic. A fresh unavailable or deleted read is still published as current, because
   that is new information about the source. Gated over `T3, T1, T1, T2` and an unavailable
   interleaving through the public admission and projection seam.
2. **Only a not-found read was classified.** A forbidden read and a read that never reached GitHub
   escaped `read()` as raw errors. There is now one closed classification —
   `NOT_FOUND`, `FORBIDDEN`, `UNREACHABLE`, `RAISE` — and the first three produce an explicit
   `UNAVAILABLE` reading that carries nothing of the failure's text. A cancelled read and a
   programmer error are raised: neither is evidence about the source. No retry, no write, and no
   widened acceptance.
3. **Admission trusted the producer.** Any object carrying the right `schema` was stored verbatim,
   including one asserting `effect: WRITE` and `authority: MERGE`. `requireTestObservation` now
   verifies the whole published contract — the exact field list, the closed vocabularies, the
   constant `NONE` effect and authority, identity, digests, instants, claim shape and the rule that
   an unknown observation publishes no content — before anything is appended.
4. **Documentation drift.** The observation field is 456 characters, not 600; the historical
   sections above are now dated as history; the label list and the four projected claim lists are
   described as they ship.

### Recovery and admission-integrity follow-up

The next Spec review reproduced two further admission defects. The coordinator first added failing
public-seam tests, then repaired them without adding an effect or persistence mechanism:

- Deduplication compares against the current placed observation, not every historical revision.
  An unchanged valid source returning after an unavailable or malformed reading is a new recovery
  entry. Consecutive unchanged reads still return the same ledger. Stale-read diagnostics cannot
  move the source-time frontier backwards.
- Admission recomputes the revision content address, binding normalized claims, severity, source
  metadata and raw digest. A changed claim or forged digest cannot reuse a genuine revision ID.
  Predecessor links are derived from the ledger, including a null predecessor on first admission.

Revision IDs identify content, not unique event occurrences. Recovery may repeat a content ID;
ledger order and observed timestamps identify its occurrence. Previous-revision links describe
adjacent content and must not be traversed as a unique-event DAG. Observation time is excluded
from content identity so unchanged polling remains idempotent. The hash is an integrity check,
not a signature or authentication of a producer: source claims remain SOURCE_ASSERTED.

### Live witness (coordinator)

The coordinator read the live comment on 2026-09-05 at 16:31Z through the shipped adapter:
`AVAILABLE -> NORMALIZED`, four source-asserted claims, digest
`sha256:59e82be521246420208b65d8860a9bb161c6da7f2728b1d6160dd3672bc200e2`.

That read was performed by the coordinator, not by this repository's tests. `node --test` makes no
network call; its evidence is fixture replay, and it remains no proof that the comment is reachable
now.
