# Preserve refusals before Draft creation

## Outcome and acceptance

A rejected admission that never invokes the provider must terminate as REFUSED,
not EFFECT_AMBIGUOUS. Provider timeouts, lost responses, malformed responses and
failures after invocation must remain ambiguous and must never trigger a blind retry.

- Bind a no-invocation witness to the exact in-process request, not an error code.
- Persist the distinction with the existing expected-revision ledger append.
- Refuse replay of that witness for another request or operation.
- Verify expiry during admission, provider error impersonation, concurrent replay,
  successful creation, and unchanged handling of old ambiguous records.
- Do not widen an admission policy or change GitHub permissions.

## Legacy operation

Related: GuitarAlchemist/gaia#127, GuitarAlchemist/gaia#128.

Operation e700fd9b5c20e1e3a252da8f0d14e1e2b0f6290911c34e03b3b3e00639003ffc
has no durable evidence of non-invocation. Its expired policy, completed executor,
and empty exact PR lookup cannot manufacture that evidence. It remains quarantined.
This repair prevents recurrence; it does not claim to settle that old operation.

## Boundary and rollback

The application owns the invocation boundary. The normal admission adapter supplies
preparation and the separately invoked effect. The domain accepts only a request-bound
local witness and records it through the existing ledger CAS. No UI state grants authority.

Old executors cannot read the new terminal shape; deploy executors from one reviewed
revision. Reverting the reader after new receipts exist is not a supported rollback.
Disable new admission and retain the compatible reader if the new path must be stopped.
