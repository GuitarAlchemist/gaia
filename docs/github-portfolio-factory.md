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

The local factory may use the same execution once for a bounded correction: initial
`REQUEST_CHANGES` -> one repair -> one fresh final review. This is internal to the one
execution. It consumes neither a second grant nor a second idempotency key, and a final
`REQUEST_CHANGES` is terminal rather than a loop. The final reviewer remains
authoritative; repair and both review observations are optional receipt fields so an
initial approval preserves the original receipt shape.

Both untrusted inputs are taken into Gaia's own structures before they are used. The
caller's grant is copied from its property descriptors before it is handed to the
authority, and the provider's receipt is projected the same way after the grant is
spent. Neither projection evaluates an accessor, and both define each projected field
rather than assigning it, so a field named `__proto__` becomes an ordinary own property
of Gaia's copy instead of that copy's prototype.

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
   extra properties are refused. This holds at both seams an operator can reach: the
   authority adapter called directly, and `advance`, which owns the grant from its
   property descriptors before consumption rather than structure-cloning it. `advance`
   owns the grant faithfully rather than judging it: every field the caller sent,
   `__proto__` included, reaches the authority as an own data property, so deciding
   which fields are extra stays the authority's judgement.
10. Grant consumption is one-use and precedes execution. A failed run does not silently
    make the grant reusable; an operator must survey again and issue a new grant.
    A bounded repair is part of that same consumed execution and never receives new
    authority. Missing or invalid repair capability, Git control mutation, and no-change
    repair are typed `EXECUTION_FAILED` outcomes.
11. The execution adapter is bound to one repository, one linked worktree, and one
    external evidence root. Its idempotency directory is derived from the grant and
    intent revisions. At construction it measures the worktree's own Git origin remote
    and refuses unless that normalized `owner/name` equals the bound repository, so a
    mis-wired composition cannot be built rather than failing during a run. Both roots
    are canonicalized with the physical path, so a Windows 8.3 short path and its long
    form bind the same directory.
12. A GitHub-supplied title is untrusted text. It is constrained where it enters the
    portfolio to one line of at most 256 Unicode code points — the unit GitHub states its
    own title bound in, not UTF-16 code units — with no control character, line or
    paragraph separator, or bidirectional formatting, and the task string that carries
    it names it as data. That is a structural bound on prompt line shape and length. It
    is not escaping, not sanitization, and not a claim that the text is safe to obey:
    a title that is signed into an intent revision is still untrusted text.
13. After a grant is consumed, every step that touches the provider's reply is inside one
    failure boundary. A receipt with an accessor, a function, a bigint, a symbol key, a
    hidden property, a cycle, or excessive depth yields `EXECUTION_FAILED` with the
    typed identity `PortfolioFactoryError` / `ExecutionProtocol`, never a raw throw and
    never a provider message. A receipt field named `__proto__` is none of those things —
    it is an ordinary own data property — so it is projected as one and committed by
    `receiptRevision`, never turned into a provider-owned prototype whose contents read
    back off the receipt but sit outside the hash that binds it.

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
  evaluating the getter, at the adapter and at `advance` alike, before consumption.
- Throw a provider error after grant consumption: the transition must be
  `EXECUTION_FAILED`, bind the idempotency key, and omit the provider message.
- Return a receipt for a different task or unsupported schema: the factory must refuse
  it as `ExecutionProtocol`.
- Return a hostile but schema-shaped receipt after consumption (a throwing getter, a
  function, a bigint, a cycle, a symbol key, a hidden property): the transition must
  still be `EXECUTION_FAILED` and must not carry the provider's message.
- Carry an own enumerable `__proto__` data property on a receipt or on a grant: the
  projection must keep it as an own field of Gaia's copy — changing its value must change
  `receiptRevision` at the receipt seam, and the authority must see it and refuse it at
  the grant seam — never as the copy's prototype and never silently dropped.
- Give an item a multi-line, control-bearing, or over-long title: the survey must refuse
  the snapshot rather than compose that text into a task. An ordinary astral-plane title
  at the bound — 256 code points, 512 UTF-16 code units — must still be accepted, so the
  bound cannot silently be the tighter code-unit one.
- Point the execution adapter at a linked worktree for a different repository:
  construction must refuse with `RepositoryIdentityMismatch` and run nothing.
- Run the authorized branch to `CANDIDATE_READY`: no GitHub effect surface may be read
  or called, and the linked worktree's `HEAD` must be unchanged.

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
