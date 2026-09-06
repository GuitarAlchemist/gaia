# Default-branch source rejection canary

Related: #122, #40, #121.

This inert source seed is manually prepared by the Codex coordinator. It is not
an implementation, pump-created Draft, execution grant or autonomy receipt.

The admitted worker must reproduce and fix the hosted collector selecting the
repository default branch as a new Draft source. Test through its public collect
interface: a matching default branch must be refused, a unique distinct matching
branch must remain accepted, and stale/ambiguous/unauthorized inputs remain refused.
Limit implementation to the collector and its existing tests. No new privileges,
dependencies, scheduler or unrelated refactor. Do not implement until the pump
produces a Draft receipt and the operator grants bounded execution.

Completion requires a real operation-linked worker result and regression evidence.
Supervised execution alone does not establish continuous autonomous draining.
