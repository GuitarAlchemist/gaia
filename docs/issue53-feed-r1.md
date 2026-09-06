# Issue #53: bounded multi-comment observation intake

Status: admitted design seed, implementation pending.
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
