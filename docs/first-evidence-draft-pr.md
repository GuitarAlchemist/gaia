# First-evidence Draft PR contract

Status: R0 design decision for Gaia issue #35.

## Operator problem

Useful agent work can remain invisible on GitHub until coding, testing, and review finish. Local lane liveness does not prove repository movement, so the control room cannot distinguish productive work from a stalled wrapper.

## Decision

The delivery pump creates or reuses a Draft PR immediately after the first evidence-bearing commit is durably available on its task branch. A wrapper start, heartbeat, prompt acceptance, empty branch, or uncommitted diff creates nothing.

The simple delivery loop remains:

`collect -> claim -> first commit -> Draft PR -> review and CI -> ready -> merge -> collect next`

Nested pumps may use the same protocol, but may not invent new authority, state vocabularies, or effect executors. A child pump returns an evidence-bound terminal receipt to its parent funnel.

## Identity and concurrency

The operation identity binds canonical repository identity, task identity, base branch, head branch generation, and evidence-bearing head SHA. Agent names, labels, clocks, prompts, and delivery order are not identity.

One existing GitHub-effect executor owns the effect. It acquires a compare-and-swap claim over the expected durable ledger head, records `INTENT` before the request, and records one terminal `CREATED`, `REUSED`, or `REFUSED` receipt after exact reconciliation.

Two callers from the same prior revision cannot both win. A stale loser performs no GitHub effect. After a timeout, disconnect, crash, or lost response, the executor queries GitHub by exact repository, base, head, and embedded operation identity before deciding; it never blindly retries creation.

A matching open Draft PR is reused. Multiple matches, conflicting identity, changed branch generation, stale/future/corrupt evidence, or insufficient authority fail closed.

## Authority

Draft visibility grants no approval, merge, deployment, credential, retry, or provider authority. Moving a Draft PR to ready and merging it remain separate transitions gated by their configured evidence.

Gaia preserves exactly `register`, `send`, `inbox`, `ack`, `heartbeat`, and `handoff`. No new bus verb is introduced.

## Observability

Each accepted or refused transition is appended to the existing telemetry journal with repository, task, run, branch generation, PR, source revision, and closed outcome identities. DuckDB receives a deterministic analytical projection for throughput, age, bottlenecks, and push-versus-reconciliation disagreement. DuckDB is never the live bus, claim owner, scheduler, or effect source; its unavailability cannot stop the pump.

The dashboard shows Draft age, last commit age, CI state, review gate, and obstruction separately from local lane liveness. It exposes no prompts, reasoning, commands, paths, credentials, account identifiers, or provider prose.

## Required evidence

RED tests force creation, reuse, duplicate delivery, concurrent claimants, branch reuse, changed base, response loss after remote success, crash after `INTENT`, replay after restart, stale/future/corrupt evidence, GitHub refusal, and deterministic serialization. Barrier-controlled interleavings replace timing or `sleep` tests.

Mechanism-revert controls must fail when CAS, durable intent, stable operation identity, or reconciliation is removed. Focused and full tests run twice, followed by `npm run verify`, exact source-scope inspection, and a clean tree.

## Rollback

Disable only the first-evidence composition. Existing Draft PRs and append-only receipts remain valid observations and are never deleted or rewritten by rollback.
