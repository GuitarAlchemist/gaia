# GitHub portfolio factory R1/R2

## Decision

Gaia owns one deep portfolio module with two operations:

- `survey(request)` reads a complete organization snapshot, normalizes it, classifies
  explicit evidence, and emits a content-addressed `PortfolioRevision` plus a
  deterministic advisory schedule.
- `advance(request)` re-reads the complete GitHub snapshot, rebuilds the portfolio,
  requires the fresh revision to equal the caller's pinned revision, and emits at most
  one transition intent. Without a grant it stops at `AWAITING_AUTHORITY`.

R2 may consume one exact, expiring Ed25519-signed `FACTORY_RUN` grant and execute the
existing local agent factory for that intent. The grant is atomically claimed in a
caller-owned ledger before execution, so replay fails closed. The resulting transition
is `CANDIDATE_READY`, `CANDIDATE_REJECTED`, or `EXECUTION_FAILED`; the last form retains
the authority and idempotency identities but exposes no provider message.

R2 still cannot create, edit, publish, or merge a GitHub pull request. It produces only
a reviewed candidate in an already-created linked worktree plus content-addressed local
evidence. GitHub mutation is a later vertical slice with separate authority.

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
7. R1 and R2 perform no create, update, comment, close, publish, merge, or push operation.
8. The Gaia bus remains exactly `register/send/inbox/ack/heartbeat/handoff`; bus text is
   not authority.
9. A grant binds the exact intent, repository, item, snapshot, action, and expiry. Its
   signature covers only canonical data-property fields; hidden, symbolic, accessor, or
   extra properties are refused.
10. Grant consumption is one-use and precedes execution. A failed run does not silently
    make the grant reusable; an operator must survey again and issue a new grant.
11. The execution adapter is bound to one repository, one linked worktree, and one
    external evidence root. Its idempotency directory is derived from the grant and
    intent revisions.

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
- Change any signed grant field or use a different intent: verification must refuse and
  execution must remain at zero calls.
- Replay a consumed grant: the atomic ledger claim must return `GrantConsumed`.
- Hide an unsigned property or getter on a grant: validation must refuse without
  evaluating the getter.
- Throw a provider error after grant consumption: the transition must be
  `EXECUTION_FAILED`, bind the idempotency key, and omit the provider message.
- Return a receipt for a different task or unsupported schema: the factory must refuse
  it as `ExecutionProtocol`.

## Usage

```powershell
npm run portfolio:survey -- survey `
  --organization GuitarAlchemist `
  --policy-revision sha256:portfolio-policy-v1 `
  --out .\gaia-portfolio.json
```

The output is advisory evidence, not authorization to execute or publish work. An R2
composition supplies `createFileEd25519AuthorityAdapter` and
`createAgentFactoryExecutionAdapter` to the same `createPortfolioFactory` seam, then
passes the pinned portfolio and signed grant to `advance`. Gaia deliberately does not
load a private signing key or infer authority from a prompt, label, bus message, or
environment variable.
