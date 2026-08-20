# GitHub portfolio factory R1

## Decision

Gaia owns one deep portfolio module with two operations:

- `survey(request)` reads a complete organization snapshot, normalizes it, classifies
  explicit evidence, and emits a content-addressed `PortfolioRevision` plus a
  deterministic advisory schedule.
- `advance(request)` re-reads the complete GitHub snapshot, rebuilds the portfolio,
  requires the fresh revision to equal the caller's pinned revision, and emits at most
  one transition intent. R1 stops at `AWAITING_AUTHORITY`; it cannot call a GitHub
  mutation.

This is the minimum interface selected by Design It Twice. A generic workflow engine,
one method per GitHub action, and an autonomous `runEverything` loop were rejected: each
would expose mechanisms, widen authority, or make replay depend on hidden state.

## Invariants

1. Incomplete pagination is `PortfolioIncomplete`, never a partial ranking.
   GitHub Search is capped at 1,000 results per query, so R1 rejects larger configured
   limits and treats a response exactly at the cap as incomplete. It also compares the
   collected rows with a read-only Search metadata probe and refuses
   `incomplete_results` or a total-count mismatch.
2. Snapshot ordering cannot change the revision or schedule.
3. At most four lanes are proposed and at most one item per repository is scheduled.
4. Declared duplicates and dependencies block. Unavailable relationship evidence stays
   `UNKNOWN`; an explicitly agent-ready issue may be ranked only as
   `READY_WITH_UNKNOWN`, never silently promoted to proven-ready.
   Snapshot producers must therefore provide explicit booleans, label arrays,
   dependency evidence, and duplicate evidence; omitted fields are invalid rather than
   interpreted as negative facts.
5. Draft, archived, human-gated, unknown-check, and unknown-review work remains distinct.
6. Every transition binds the organization snapshot revision, repository, item identity,
   action, evidence state, and required external authority.
7. R1 performs no create, update, comment, close, publish, merge, or push operation.
8. The Gaia bus remains exactly `register/send/inbox/ack/heartbeat/handoff`; bus text is
   not authority.

## Relationship evidence

R1 recognizes only whole, anchored body lines in one of these forms:

```text
Depends-On: owner/repository#123
Blocked-By: owner/repository#123
Duplicate-Of: owner/repository#123
```

`#123` is also accepted and is qualified to the current repository. Matching is
case-insensitive, but no prose inference, fuzzy reference, cross-line continuation, or
LLM interpretation is allowed. Missing relationship evidence remains `UNKNOWN`.
Multiple distinct `Duplicate-Of` declarations are contradictory: they block the item
and leave its canonical duplicate target unknown.

## Falsifiers and negative controls

- Reorder repositories and items: the revision and schedule must stay byte-equivalent.
- Return exactly the adapter query limit: the survey must refuse as potentially capped.
- Tamper with any portfolio field after materialization: `advance` must refuse with
  `SnapshotMismatch`.
- Change GitHub after survey but before `advance`: the fresh observation must refuse
  with `SnapshotStale` and emit no intent.
- Provide an effect adapter during R1: survey and advance must still invoke it zero times.
- Mark relationship evidence unknown: it must remain visible in state and transition
  intent.

## Usage

```powershell
npm run portfolio:survey -- survey `
  --organization GuitarAlchemist `
  --policy-revision sha256:portfolio-policy-v1 `
  --out .\gaia-portfolio.json
```

The output is advisory evidence, not authorization to execute or publish work.
