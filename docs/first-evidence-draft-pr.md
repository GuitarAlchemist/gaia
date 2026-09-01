# First-evidence Draft PR contract

Status: R0 design decision for Gaia issue #35.

Boundary correction: issue #56 and `docs/draft-operation-envelope.md` supersede this document's
input-boundary and crash-recovery details after PR #58 demonstrated that stable work identity,
mutable generation evidence, provider projection, and terminal projection require one canonical
envelope owner. The delivery-loop outcome and authority limits below remain unchanged. In the
irreducibly ambiguous window after `EFFECT_STARTED`, safety wins: Gaia records a durable
nonterminal `EFFECT_AMBIGUOUS`, alerts, and refuses a blind retry rather than claiming a false
terminal or that every provider crash can recover automatically.

## Operator problem

Useful agent work can remain invisible on GitHub until coding, testing, and review finish. Local lane liveness does not prove repository movement, so the control room cannot distinguish productive work from a stalled wrapper.

## Decision

The delivery pump creates or reuses a Draft PR immediately after the first evidence-bearing commit is durably available on its task branch. A wrapper start, heartbeat, prompt acceptance, empty branch, or uncommitted diff creates nothing.

The simple delivery loop remains:

`collect -> claim -> first commit -> Draft PR -> review and CI -> ready -> merge -> collect next`

Nested pumps may use the same protocol, but may not invent new authority, state vocabularies, or effect executors. A child pump returns an evidence-bound terminal receipt to its parent funnel.

## Identity and concurrency

`docs/draft-operation-envelope.md` is authoritative for identity, provenance, ledger storage,
serialization, hosted execution, cancellation, and crash recovery. In summary, stable `workKey` is
separate from generation identity; exact canonical SHA-256 functions are shared product code; and
agent names, clocks, prompts, and delivery order are never identity.

A hosted collector derives the sealed envelope from authoritative GitHub issue events, refs, and
policy. Durable `ENQUEUED` ingress precedes Actions dispatch. Per-work Git refs use non-force
fast-forward CAS and separate hidden Git OIDs from public content revisions. One hosted executor
epoch may append `INTENT` then `EFFECT_STARTED` before calling the provider. A stale loser performs
no effect.

An exact matching Draft yields terminal `REUSED`; a confirmed create yields `CREATED`; a definitive
pre-effect or provider refusal yields `REFUSED`; and a pre-effect cancellation yields `CANCELLED`.
A lost response after `EFFECT_STARTED` yields
nonterminal `EFFECT_AMBIGUOUS` and lookup-only reconciliation, never a blind retry or false
terminal. Multiple matches, conflicting identity, changed generation, stale/future/corrupt
evidence, or insufficient authority fail closed.

## Authority

Draft visibility grants no approval, merge, deployment, credential, retry, or provider authority. Moving a Draft PR to ready and merging it remain separate transitions gated by their configured evidence.

Gaia preserves exactly `register`, `send`, `inbox`, `ack`, `heartbeat`, and `handoff`. No new bus verb is introduced.

## Observability

Each accepted or refused transition is appended to the existing telemetry journal with repository, task, run, branch generation, PR, source revision, and closed outcome identities. DuckDB receives a deterministic analytical projection for throughput, age, bottlenecks, and push-versus-reconciliation disagreement. DuckDB is never the live bus, claim owner, scheduler, or effect source; its unavailability cannot stop the pump.

The dashboard shows Draft age, last commit age, CI state, review gate, and obstruction separately from local lane liveness. It exposes no prompts, reasoning, commands, paths, credentials, account identifiers, or provider prose.

Draft absence is itself a closed observation with a denominator:

- `EXPECTED_NONE`: no claimed item and no evidence-bearing commit;
- `AWAITING_FIRST_COMMIT`: one claimed item exists but no qualifying commit exists yet;
- `MISSING_DRAFT`: a qualifying commit exists but no exactly bound open Draft PR exists;
- `DRAFT_OPEN`: exactly one bound Draft PR exists.

Only `MISSING_DRAFT` triggers create-or-reuse. `EXPECTED_NONE` is healthy idle state, while `AWAITING_FIRST_COMMIT` measures the pre-commit gate without fabricating repository movement. Multiple or ambiguous matches are a refusal, not `DRAFT_OPEN`. Every state and its age are projected into DuckDB so the operator can query time spent before the first commit and between the first commit and Draft visibility.

## Required evidence

RED tests force creation, reuse, duplicate delivery, concurrent claimants, branch reuse, changed base, response loss after remote success, crash after `INTENT`, replay after restart, stale/future/corrupt evidence, GitHub refusal, and deterministic serialization. Barrier-controlled interleavings replace timing or `sleep` tests.

At least one interleaving runs across two real operating-system processes, held at a barrier until both have read the same durable ledger head and then released to race for it; a single-process barrier cannot reach the read-read-write-write ordering that duplicates a Draft PR. At least one restart case begins from a ledger holding only an orphaned `INTENT` and asserts that GitHub is asked exactly once and nothing is created blind.

Mechanism-revert controls must fail when CAS, intent-before-effect ordering, stable operation identity, or reconciliation is removed. A control that reads the source as a string cannot discharge that: each control writes its mutant, imports it, runs it, and asserts a behavioural divergence. Focused and full tests run twice, followed by `npm run verify`, exact source-scope inspection, and a clean tree.

## Rollback

Disable only the first-evidence composition. Existing Draft PRs and append-only receipts remain valid observations and are never deleted or rewritten by rollback.
