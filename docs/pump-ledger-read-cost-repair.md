# Pump ledger read-cost repair

Related: GuitarAlchemist/gaia#127

## Observed incident

Run 34145776069 started admission at 2026-09-07T17:01:02Z.
The ledger recorded ENQUEUED at 17:05:19Z, CLAIMED at 17:08:41Z,
INTENT at 17:10:00Z, EFFECT_STARTED at 17:11:20Z, and EFFECT_AMBIGUOUS
at 17:13:29Z. The admission policy expired at 17:10:00Z.
No PR was found for the exact source branch at the incident inspection.
Expiry is a probable cause, not an observed underlying provider error.

A deterministic three-work fixture measured 13 ref reads, including seven
registry reads, for one unsettled listing. The Git Data adapter reloads each
commit, tree and blob on each traversal. This is a measured amplification;
its contribution to live wall time still needs qualification.

## Bounded repair and acceptance

- Reuse immutable Git objects by exact object ID within one adapter instance.
- Never cache mutable refs, protection/ruleset checks, or write results.
- Revalidate receipts and return isolated values; failures must remain retryable.
- Prove repeated reads avoid duplicate object requests.
- Prove a moved ref and revoked protection are still observed.
- Preserve CAS, operation identity, authority and ambiguity semantics.
- Run focused tests and independent review before qualification.

## Implemented scope

The adapter now holds at most 256 immutable object responses per instance,
shares concurrent reads while their entry remains cached, and returns cloned values. Mutable refs and
rulesets are still fetched. Rejected reads and parser-invalid chains do not
remain pinned in the cache.

The repeated single-record fixture now performs five requests for two reads
instead of eight: two fresh ref queries and one request per immutable object.
This is a fixture request-count improvement, not a live latency claim.
The focused suite passes 18 tests, including ref movement, protection
revocation, concurrent reads, eviction, failed-read retry and value isolation.

The 256-entry bound takes precedence over request coalescing. Evicting an
in-flight entry may cause an additional read of the same immutable object.
This affects request count only, not state freshness or write authority;
there is no unbounded secondary map of in-flight requests.

This repair Draft is coordinator-created, not evidence of successful pump
admission. No policy renewal or new admission attempt is included.
