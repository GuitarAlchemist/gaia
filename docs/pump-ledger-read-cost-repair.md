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

## History prefetch (2026-09-29)

The cache removed repeated reads within one run, but every intake still paid three REST reads per
record once. By 2026-09-29 that was 579 calls per listing, most of the pump App's hourly REST quota
across a handful of runs.

`createGhGitDataApi({ historyPrefetch: true })`, which the pump CLI passes, changes how the
cache is filled:

- When a walk reaches a commit the cache does not hold, the adapter asks GraphQL for up to a hundred
  of that commit's ancestors, with each tree and receipt blob.
- It seeds the cache with the REST shapes those objects stand for, but only a tree or blob whose
  translated bytes hash back to the id Git stored for it. That check matters: gh rewrites control
  characters in the JSON it prints, so a receipt quoting a terminal escape would otherwise be read
  as different bytes, and a GraphQL tree listing carries no truncation flag.
- Anything that does not verify or translate exactly is left for a REST read: a parent count that
  disagrees with the parents listed, a binary or truncated blob, or a malformed entry. Commits cannot
  be rehashed without their raw header, so their tree and parents are taken as given, as REST takes
  them.
- Receipt validation, head reads, protection checks and writes are unchanged.
- The first GraphQL failure, or an answer without the commit asked for, turns the prefetch off for
  that adapter, so a broken GraphQL path costs one call, not one per step.
- Concurrent walks that reach the same unseen commit share one query.

A read-only live comparison of both paths returned identical records for all 34 ledger refs, and
every live tree and blob verified. The listing went from 81 ref reads plus 498 object reads (109 s)
to 81 ref reads plus 21 GraphQL queries (8 s). The query count follows the refs whose heads are not
cached, not the record count.
