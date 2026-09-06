# Issue #53: bounded multi-comment observation intake

Status: R1 slice implemented; coordinator independently runs tests and required gates before merge.
Base: main after PR #121, `9da5f246359e491948ec4032c8794d88d1ee6563`.

## Outcome

Extend the delivered single-comment tracer (#119) with a bounded read-only batch intake over multiple comments. Reuse existing normalization, revision admission and projection contracts. This slice is not durable storage, autonomous dispatch, a UI redesign or full feed completion.

## Acceptance

- One injected read-only page/batch of distinct comments produces source-attributed readable observations through the existing public intake seam.
- Duplicate comments/repeated batches do not append duplicate revisions; edits preserve history and stale replay does not replace newer content.
- Unavailable or incomplete source does not erase prior evidence or claim the feed is complete. Absence from a partial page must not imply deletion.
- Work per invocation has an explicit bound. Unknown/malformed inputs cannot grant authority or trigger GitHub writes.
- A discriminating regression/negative control and targeted tests cover these cases; coordinator independently runs tests and required integration gates.

## Boundaries

Pure decisions and projections remain independent of GitHub transport and storage. A read-only adapter supplies observed source data; all source text is untrusted and source-asserted, not verified truth. No new dependency, credential, database, mutation authority or scheduling mechanism.

## Execution

One Claude subscription worker, supervised by Codex. Worker owns only the intake-related source/test changes and this note in the isolated branch. Coordinator owns tests, commit, push, review and merge. A visible launch is not startup proof; require an acknowledgement and a result artifact. This manually coordinated slice must not be presented as unattended pump execution.

## Implemented R1 slice

`admitTestObservationBatch(ledger, readings)` in `src/test-observation-intake.mjs` adds bounded
multi-comment intake on top of the existing R0 seam, without a new normalization rule, admission
rule, provider, transport or storage:

- It is sequencing only. Each reading in the page is normalized by the existing
  `normalizeTestObservation` and admitted by the existing `admitTestObservation`, exactly as a
  caller doing that once already could; every admission, dedup, revision, and regression rule is
  the one R0 already proved.
- `MAX_TEST_OBSERVATION_BATCH_SIZE` (25) bounds work per call; a page over the bound is refused,
  never silently truncated.
- The result carries `effect: NONE` and `authority: NONE`, matching every observation inside it,
  plus one `{ observationKey, sourceUrl, state, outcome }` entry per reading in page order.
- A page is not a claim of completeness: a comment absent from a page is simply not visited, never
  reported as deleted or regressed. This preserves the R0 rule that absence is not evidence.

Tests added in `tests/test-observation-intake.test.mjs` cover: two distinct comments in one page
each admitting once; the same comment repeated within one page and across repeated pages
deduplicating to one entry; an edit and a fresh unavailable reading inside one page both
preserving prior history without resurrecting stale content; the explicit page-size bound refusing
an oversized or non-array page; and a malformed/hostile reading inside a page normalizing to an
explicit `UNKNOWN`/`NONE`-authority entry beside a normal one, never granting authority or
aborting the rest of the page.

Not run by the worker: `node --test` execution is the coordinator's responsibility per the
execution note above.
