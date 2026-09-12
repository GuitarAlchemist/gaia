# Recover a confirmed ledger append after a lost acknowledgement

Related: GuitarAlchemist/gaia#143

This Draft starts with a bounded repair contract, not an implemented fix.
The real GitData adapter can return STALE for its own successful ref update
when the transport acknowledgement is lost. The original live transport
failure remains unproven; a deterministic adapter reproduction exists.

## Acceptance criteria

- A failed PATCH or initial POST whose fresh readback equals the exact newly
  created commit returns APPENDED, including the original receipt metadata.
- A foreign winner remains STALE; unchanged head and failed readback fail closed.
- Protection checks and non-force updates remain intact; no blind retry is added.
- Deterministic adapter tests fail before the fix and pass after it.
- Full tests pass; independent review checks the exact candidate.
- Live recovery is a separate gate: reconcile and resume the same operation,
  without resetting a ledger or touching quarantined work.

Architecture impact: none. The existing GitData adapter implements its existing
append contract; no authority, domain state, policy or schema change is proposed.
