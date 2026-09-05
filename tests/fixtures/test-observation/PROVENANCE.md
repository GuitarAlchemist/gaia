# Fixture provenance — test observation intake R0

`sanitized-issue-73-comment.json` is **synthetic**. Its source identity triple (repository,
issue number, comment id) and its source URL are the real public coordinates recorded in
`docs/test-observation-intake-r0.md`; its **body is written for this test suite** and is not the
byte content of the live comment. Its digest therefore does not equal the digest that document
records for the live body, and no test here may be read as live-integration evidence.

Reading the live comment is an adapter concern (`src/gh-test-observation-source.mjs`) and is not
exercised by `node --test`.

## `captured-issue-73-comment-5548750957.json`

A **replay of real bytes**, not a synthetic body: the `body`, `id`, `created_at`, `updated_at` and
`html_url` are copied verbatim from a read-only capture the coordinator took of the live comment on
2026-09-05, and the file's digest is asserted by the suite to equal the
`59e82be5…2bc200e2` this repository recorded from that live read. Its `provenance` is
`CAPTURED_REPLAY` for exactly that reason: the bytes are genuine, the read is not happening here.
`observedAt` is the replay instant and is the only field this repository chose.

Replaying these bytes proves the seam consumes its own source. It does not prove the comment still
exists, still says this, or can be reached now; only a fresh live read proves that.
