# Ecosystem adapters: GA, Hari, TARS, IX

These verdicts come from the read-only ecosystem adapter analysis (2026-08-09). They
are enforced in `src/ecosystem.mjs`, not merely documented: `assertIntegrationAllowed`
throws for the rejected and deferred targets, and the shipped scripts call it before
doing anything.

| Repo | Verdict | What ships | What does not |
| --- | --- | --- | --- |
| **GA** | `ADAPTER_ONLY` | `scripts/ga-watch.mjs` — read-only JSONL tailer to bus `send` with `requestedAuthority: ["report"]`. | No GA repo change. No write to any GA path, ever. |
| **TARS** | `ADAPTER_ONLY` | `scripts/tars-mount.mjs` — a runtime `configure_mcp_server` payload plus a local, uncommitted config fragment. | No TARS repo change. Nothing written to the tracked `mcp_config.json`. |
| **Hari** | `REJECT` | Nothing. | No integration at all. `assertIntegrationAllowed('hari')` throws. |
| **IX** | `DEFER` | Nothing. | No integration. `assertIntegrationAllowed('ix')` throws. |

## GA — why a tailer and nothing more

GA is the ecosystem's largest producer and has **no MCP client**, so "GA consumes the
bus" would mean writing new .NET MCP-client infrastructure for a coordination channel.
Everything GA would publish is already on disk under a versioned schema, so the bus
adds exactly one thing: **push and a return address**. Not durability, not ordering,
not schema — those are already better on GA's side.

The adapter therefore:

- opens the GA file with mode `'r'` only;
- stores its byte offset in **this product's** data directory, never beside GA;
- reports and skips an unparseable record rather than rewriting it;
- publishes with `requestedAuthority: ["report"]`, the most advisory grant there is;
- is dry-run by default.

A GA governance denial arriving on the bus is a *report about a denial*. It is not
authority to act on it.

## TARS — why runtime only

TARS is the only sibling repo that is already an MCP client and host, so it can mount
this bus at runtime through its own `configure_mcp_server` tool with zero repo code.
That is the cheapest and most reversible integration in the ecosystem.

It stays out of the repo because `mcp_config.json` is **tracked and shared with CI**.
Putting an absolute machine path there breaks every other machine. The generator says
so in the artifact it writes, and the artifact is emitted into a directory you name —
never into a checkout.

The genuine gap this closes: TARS's `delegate_task` is an in-process registry lookup.
It has delegation vocabulary but no cross-process reach. The bus gives it a live
counterparty with `correlationId` and `replyTo` intact.

## Hari — why rejected, not deferred

Hari **already has this**, and better-typed:

- `hari-core serve` is a documented stdio-JSONL streaming protocol;
- it has deterministic replay parity;
- it ships a reference client for its only counterparty;
- it keeps a durable ledger under a session-memoryless discipline.

And Hari **removed its MCP crate from `main`**. Adding a second stdio protocol to a
repo that deleted its first one is a proposal to reverse a decision the owner already
made. That is a conversation with the owner, not a tracer bullet — so nothing ships.

Revisit only if Hari re-introduces an MCP surface for its own reasons. The bus is not
one of those reasons.

## IX — why deferred, not rejected

IX already ships this architecture internally and more rigorously: an append-only
session event log as source of truth, replay as a pure projection with cross-process
bit-identical output, and deterministic approval middleware that emits a verdict on
every action. The load-bearing insight here — separate coordination from authority by
construction — is not new information for IX.

IX also has a **written policy against runtime cross-repo coupling**, and its MCP
surface is gated by an exact tool-count assertion whose whole job is to make a surface
change stop and think.

Two conditions must both hold before this becomes `ADAPTER_ONLY`:

1. the bus gains **actor identity** better than positional trust (write serialisation
   it now has; authentication it does not); **and**
2. an explicit owner decision to amend the no-runtime-coupling invariant, with a
   written answer to why this does not repeat the deprecated A2A protocol.

Neither has happened, so `assertIntegrationAllowed('ix')` throws.

## Claude `SendMessage` is not a transport here

`SendMessage` addresses Claude Code sessions — an agent-team teammate, a subagent, or
another of your own sessions — in plain text, on macOS and Linux. It is **not
available on native Windows**, and no non-Claude client can speak it under any
configuration. It carries no correlation id, no authority metadata, and no durable log
of its own; its per-agent mailbox is transient, session-scoped, and self-repairing —
it drops records that fail validation.

That is the sharpest available contrast with this bus, which refuses a record it
cannot parse rather than dropping it. If a native fast path is ever used, it must be a
transport optimisation that writes the same events to the same log, never a second
source of truth.

Anthropic's own guidance agrees on the boundary: a receiver never treats a message
from another agent as the user's consent or approval.
