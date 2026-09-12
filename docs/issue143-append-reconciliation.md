# Recover a confirmed ledger append after a lost acknowledgement

Related: GuitarAlchemist/gaia#143

The repair is implemented and verified deterministically. The real GitData
adapter returned STALE for its own successful ref update when the transport
acknowledgement was lost; it now reports that durable append as APPENDED. The
original live transport failure remains unproven and unreproduced against
GitHub: only the deterministic adapter reproduction is evidence here.

## Acceptance criteria

- A failed PATCH or initial POST whose fresh readback equals the exact newly
  created commit returns APPENDED, including the original receipt metadata.
- A foreign winner remains STALE; unchanged head and failed readback fail closed.
- Protection checks and non-force updates remain intact; no blind retry is added.
- Deterministic adapter tests fail before the fix and pass after it.
- Full tests pass; independent review checks the exact candidate.
- Live recovery is a separate gate: reconcile and resume the same operation,
  without resetting a ledger or touching quarantined work.

## Verification

Against `createGhGitDataApi` with a scripted transport, in
`tests/gh-git-data-adapter.test.mjs` (Node v26.8.2, `node --test`):

- Before the source change, 4 of the 7 new `R6` gates failed; the three
  negative ones (unchanged head, foreign winner, unreadable readback) already
  passed and still pass, so the change moved only the own-commit case.
- After the change the focused file is 25/25 twice, and the full suite is
  2073 passing, 1 skipped, 0 failing.
- The reconciliation is one extra head read: one PATCH with `force: false`
  or one initial POST without a force option, no reissued object write and no retry.
- No live GitHub call was made; the live cause is still unverified.

Architecture impact: none. The existing GitData adapter implements its existing
append contract; no authority, domain state, policy or schema change is proposed.
