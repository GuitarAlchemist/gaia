# Reconcile a delivered Draft operation

Parent: #40. Observed failure: hosted intake run `33942991011` retains operation
`12cacc5b9a32bfd91a6cec5c43f373065b...` as ambiguous (use the full ID in its receipt).
PR #83 carries the exact full marker and was merged on 2026-09-01. Lookup currently
searches only open Drafts, so a lost receipt cannot recover after delivery advances.

## Decision before code

Keep `lookupExact` and `reconcileDraft` as the public seams. Permit a `REUSED`
receipt for a uniquely marked MERGED PR only after repository, base/head branch,
operation marker, original generation inclusion, current head and merge metadata
are verified. Preserve current `state: MERGED`, `isDraft: false` and current head;
never fabricate a currently open Draft. An explicit `mergedEvidence` carries the
original generation head, current head, merge commit/time and comparison status.
The GitHub adapter proves inclusion with the exact commit comparison endpoint;
the core validates its closed evidence shape and bindings and persists it under
the existing operation CAS. No create call, new effect grant or bus verb occurs.
Only lookup/REUSED may accept this evidence; CREATE acknowledgements remain exact
open Drafts. Existing receipts remain readable without schema migration.

Rejected: reopen the merged PR; cancel an ambiguous effect without reconciliation;
trust a marker alone or issue closure; call MERGED an OPEN Draft; accept an
unmerged CLOSED PR; accept ancestry inferred from a branch name. A merged PR with
a changed base/head/marker or a missing original commit remains unresolved.

Proof: lost response -> ambiguous -> exact merged observation -> durable REUSED,
zero extra creates, replay identical. Negative cases: wrong marker/repository,
unrelated or diverged head, malformed comparison/merge metadata, duplicate marked
PRs, and moved current evidence. Query all PR states, retaining fail-closed uniqueness.
The change does not claim fresh work execution, a worker dispatcher, live DuckDB
ingestion, or whole-pump autonomy. Live acceptance requires a new main-branch intake
receipt settling the old operation, not merely green CI.
