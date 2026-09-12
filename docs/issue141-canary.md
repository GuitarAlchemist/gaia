# Architecture body-edit canary

Related: GuitarAlchemist/gaia#141.

This is a coordinator-prepared seed for one pump-created Draft, not an
implementation or proof of autonomous delivery. No runtime change is included.

## Accepted bounded outcome

The pull-request CI workflow observes body edits as well as opened, synchronize
and reopened events. A body-edit event must run the existing architecture gate
against the same head SHA. Preserve the gate's decision logic and permissions.

## Required proof

1. A scoped pump operation for issue141 returns its real Draft URL and receipt.
2. A worker adds the missing edited event and a regression test.
3. Tests and independent reviews are bound to the candidate commit.
4. A harmless PR-body edit produces a new architecture-check run at that SHA.
5. Merge and issue closure are read back separately.

The optional architecture-document content heuristic is deferred; no security
gate is weakened. Issue127 remains quarantined and must not be reconciled.
The single Draft intake is not standing admission or blanket agent authority.
