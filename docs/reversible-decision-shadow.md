# Bounded reversible decision proposal

This is a pure shadow experiment under the operator's30October2026 delegation
of reversible technical research. It is not a scheduler, policy issuer, runtime
lease or execution capability. Existing protected human decisions remain open.

Design A: choose an option and invoke a worker in the same module. Rejected:
selection would obtain effects before its identity and revocation seam is tested.
Design B: a pure selector produces an immutable digest-bound Decision Receipt;
verification re-derives it against current explicit inputs. Chosen: no effect port,
no model call, no hidden authority. Cost: facts and counters remain caller inputs.

Before code, docs/decisions/reversible-decision-shadow-v0.json binds this choice,
exact source/policy references and parameters. It records the current time, never
backdates the preceding qualification implementation's promotion evidence gap.

proposeReversibleDecision({qualification,policy,owner,candidates,iteration,attempt})
selects the least scoped candidate, then stable identifier, only inside an explicit
delegated-reversible independent-research policy. At most8candidates,3iterations,
2attempts, no model calls or external effects. No retries execute here. Paths are
canonical repository-relative file names inside declared policy prefixes.

The receipt retains exact qualification/evidence generations, policy, owner,
action parameters, alternatives, reason, uncertainty, test and rollback, plus
NOT_EXECUTED and dispatchAuthorized:false. SHA256 of existing canonicalJson binds
the whole body. This is integrity binding, not a signature or authorization.

verifyReversibleDecision(receipt,currentInput) requires exact reconstruction;
changed candidates, policy/source generations, owner or counters refuse. Unknown
or protected policy, scope expansion, conflicting owner and exhausted bounds
refuse. A protected issue can have a separate independent research proposal, but
its WAITING_HUMAN barrier remains in the receipt; no final product choice is
accepted and no issue is closed. Rejected work or already-owned work is refused.

The first fixture uses a fake-clock lease experiment related to protected#482.
No lease or worker process is installed. Rollback is removal of these new pure
files/fixtures and restoring CLI documentation/test counts. A future executor
must independently establish actual authority, freshness and global budgets;
this stateless proposal cannot prove external facts or enforce global attempts.
