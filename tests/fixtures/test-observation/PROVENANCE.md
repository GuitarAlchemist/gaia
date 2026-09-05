# Fixture provenance — test observation intake R0

`sanitized-issue-73-comment.json` is **synthetic**. Its source identity triple (repository,
issue number, comment id) and its source URL are the real public coordinates recorded in
`docs/test-observation-intake-r0.md`; its **body is written for this test suite** and is not the
byte content of the live comment. Its digest therefore does not equal the digest that document
records for the live body, and no test here may be read as live-integration evidence.

Reading the live comment is an adapter concern (`src/gh-test-observation-source.mjs`) and is not
exercised by `node --test`.
