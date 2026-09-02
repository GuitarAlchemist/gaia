# Self-hosted runner provider capability probe

Status: issue #91 slice R1 ships one pure, read-only capability probe and the closed runner/provider
contracts it decides against. Bootstrap, registration, mandate execution, drain, removal, and the
DuckDB projection remain design only. Nothing in this slice installs, downloads, launches, or bills a
provider.

## Operator outcome

A Gaia runner is asked one question and answers it in one content-addressed receipt: *at this exact
runner generation, holding this exact lease, may this provider be asked about this exact capability,
and what did a read-only synthetic-fixture observation truthfully say about it?*

The receipt never grants anything. `effect` is `NONE` and `authority` is `NONE` on every path,
including the successful one. A probe cannot register a runner, accept a mandate, push, merge,
approve, read a credential, change configuration, or spend money, and no later slice may reach those
effects by widening this receipt.

## What provider-neutral means here

The module contains no provider branch. It contains one closed admission table whose only power is
to *narrow* what a provider may be asked about:

| Provider | Admitted probe capabilities at this revision |
| --- | --- |
| `claude-code` | `READ_ONLY_REVIEW` |
| `agy-gemini` | `READ_ONLY_REVIEW` |
| `auggie` | `READ_ONLY_REVIEW` |
| `junie` | `READ_ONLY_REVIEW` |
| `notebooklm` | `RESEARCH_CITATION` |
| `qwen-local` | none |

`CODE_WRITE` and `MERGE_APPROVAL` exist in the capability vocabulary so that asking for them is
representable and refusable. No row admits either, so every provider is refused writer and merge
authority by the same mechanism rather than by a special case. NotebookLM is refused writer and
reviewer authority because its row admits only `RESEARCH_CITATION`, not because the code knows what
NotebookLM is. `qwen-local` admits nothing until the four security gates of
[the local Chinese agent stack note](research/2026-09-01-local-chinese-agent-stack.md) pass; an empty
row is the honest encoding of not admitted yet.

A row grants nothing. Admission means the question may be asked; the answer is still an observation
with `NONE` authority.

## The four contracts

All four are closed: an unknown field, a missing field, a value outside a closed set, or an
out-of-range integer is refused rather than ignored or repaired.

### Runner identity

`runnerId`, `os`, `arch`, `generation`, `acceptingWork`, `providers`, `capabilities`.

- `runnerWorkKey(identity)` is the SHA-256 of the runner id, OS and architecture and is stable for
  the life of the host installation.
- `runnerGenerationKey(identity)` is the work key and the generation, joined.
- `runnerLabels(identity)` derives the closed registration label set — `gaia`, `os:*`, `arch:*`,
  `provider:*`, `capability:*`, `generation:*` — sorted and deduplicated. Labels are derived, never
  supplied, so a label can never claim a provider or capability the identity does not declare.

Work identity is not generation identity, for the same reason it is not in
[the pull-request conflict reconciler](pr-conflict-reconciler.md): one key cannot both name the host
and name the registration epoch, and a key that does both cannot detect two live generations of one
host.

### Probe mandate

`mandateId`, `runnerWorkKey`, `runnerGeneration`, `provider`, `capability`, `deadline`, `budget`,
`declaredMcpServers`, `corpus`.

The corpus is a synthetic prompt-corpus descriptor: `corpusId`, `promptCount`, and a
`containsRepositorySource` flag that must be the literal `false`. There is no repository path, ref,
worktree, credential, or prompt body anywhere in the mandate, so a probe has nothing to leak.

`declaredMcpServers` is the whole MCP surface. It may be empty; nothing outside it may appear in the
observation.

### Runner lease

`leaseId`, `holder`, `workKey`, `generation`, `provider`, `capability`, `target`, `expiresAt`.

The target carries `kind`, `id`, and `mutable`. A read-only probe may hold only an immutable target,
and the target id must equal the mandate corpus id. A mutable target is refused outright at this
revision: this slice has no single-writer protocol, and pretending otherwise is how one lease comes
to authorize two writers.

### Capability receipt

`outcome` is `CAPABILITY_OBSERVED` or `BLOCKED`; `blocker` is `null` or one closed code. The receipt
republishes the idempotency key, the mandate digest, the runner work key and generation, the
provider, the capability, the observed instant, the availability, quota, usage, MCP servers,
provider-reported blockers, `effect: NONE`, `authority: NONE`, and a `revision` that is the SHA-256
of exactly the receipt it is published on.

The idempotency key is derived from the work key, the generation, the provider, the capability and
the mandate id. It binds a receipt to one generation, so a receipt minted by an older generation can
never be replayed into a newer one.

## Decision order, and why it is the order

Every gate below fails closed to a `BLOCKED` receipt with a typed blocker. The order is the
linearization point of this slice: **authority, then admission, then reconciliation, then the
adapter.** The provider adapter is the last thing consulted and is never consulted at all if any
earlier gate refuses.

1. `RUNNER_MISDELIVERY` — the mandate names another runner's work key.
2. `STALE_GENERATION` — the mandate generation is not the observed generation. Generations are
   compared by equality only, in both directions: a future number is as refused as a past one. An
   ordering comparison is how a replayed number comes to look live.
3. `RUNNER_DRAINING` — the runner has stopped accepting work. Drain refuses before a lease is even
   examined, so draining cannot be defeated by holding a valid lease.
4. `LEASE_ABSENT`, `LEASE_FOREIGN`, `LEASE_EXPIRED`, `MUTABLE_TARGET_NOT_ADMITTED` — the lease must
   exist, name this work key, generation, provider, capability and corpus, be unexpired at the
   observed instant, and name an immutable target.
5. `MANDATE_EXPIRED` — the observed instant is at or after the mandate deadline. Expiry is
   inclusive: a mandate is not still valid at the instant it expires.
6. `PROVIDER_UNREGISTERED`, `CAPABILITY_NOT_ADMITTED` — the closed admission table.
7. `RECEIPT_CONFLICT` — crash reconciliation. A supplied prior receipt must carry this exact
   idempotency key, this exact mandate digest, and a `revision` equal to its own recomputed digest.
   If all three hold, that receipt is returned byte-identically **and the adapter is never called**;
   that is what reconciling receipts before retrying an effect means for a probe. If any check
   fails, the probe refuses rather than minting a second, differing receipt for one key.
8. `PROVIDER_ADAPTER_FAILED` — the adapter threw, returned a non-object, or returned nothing.
9. `OBSERVATION_INVALID`, `OBSERVATION_MISBOUND`, `OBSERVATION_INCOHERENT` — the observation is
   closed-parsed, must carry this mandate digest and this provider and capability, and must agree
   with itself: `AVAILABLE` with reported blockers, or a non-`AVAILABLE` reading with none, is
   incoherent and is refused rather than resolved in the provider's favour.
10. `UNDECLARED_MCP_SERVER` — the observation reported an MCP server the mandate did not declare.
11. `CREDENTIAL_MATERIAL_PRESENT` — a free-form name in the observation is shaped like a well-known
    credential.
12. `AUTHORITY_WIDENING` — the observation claimed any effect, any authority, that source was
    exposed, or that a credential was read.
13. `BUDGET_EXCEEDED` — reported token, context, or wall-clock usage exceeds the mandate budget.

## What the fail-closed gates honestly prove

- **Budget.** A pure function cannot interrupt a provider mid-call. What it can do is refuse to
  publish an over-budget observation as a capability reading, and leave a typed blocker as the
  durable evidence that the budget was breached. The enforcement that stops the spend belongs to the
  execution adapter of a later slice, not to this receipt.
- **Credential material.** Every observation field is a closed token, a bounded identifier, or a
  bounded non-negative integer, so provider session material is *structurally unrepresentable*
  rather than merely scanned for. The one prefix check covers the only free-form names — MCP server
  names — and is a bounded structural check against known credential prefixes, not a secret scanner.
- **Authority.** The refusal is on what the adapter *claims*, not on what it did. This slice cannot
  observe a provider's real behaviour; it can refuse to record a claim of effect as a capability.
- **Crash and replay.** There is no durable store here. Reconciliation is against a prior receipt the
  caller supplies. The durable store, its compare-and-set, and its ownership are a later slice.
- **Lease.** This module is a lease *consumer*, not a lease manager. It proves that a probe holding
  the wrong, expired, or mutable-target lease does not run. It does not issue, renew, or revoke.

## The synthetic-fixture probe

`createSyntheticFixtureProbeAdapter(fixture)` is the one capability probe this slice ships. It is a
pure function over a frozen fixture record. It opens no socket, spawns no process, reads no file,
holds no clock, and carries no credential; the transport scan in `npm run verify` covers the
module's source. It cannot report an effect, an authority, an exposed source, or a credential read,
because it does not copy those fields from the fixture — it writes the safe literals itself, so a
hostile fixture has no field to put them in.

It refuses at construction if the fixture is malformed, and refuses a request whose provider or
capability is not the one it was built for; that refusal reaches the caller as
`PROVIDER_ADAPTER_FAILED`, because a probe that answers a question it was not asked is worse than a
probe that fails.

The request handed to an adapter is deliberately minimal: provider, capability, corpus id, prompt
count, budget, declared MCP servers, and the mandate digest. There is no repository, ref, path,
token, prompt body, or environment in it.

## Not in this slice

`bootstrapRunner`, `executeMandate`, and `drainRunner`; runner registration or removal; the
registration token and its non-persistence proof; GitHub receipt persistence; a durable lease store
with compare-and-set; provider bulkheads and cross-provider routing; the NotebookLM source manifest
and cited artifact; heartbeat and progress receipts; the DuckDB projection; any real provider
adapter; and any Linux host adapter. None of these is implied by the vocabulary this slice reserves.

## R1 acceptance

- The four contracts are closed, and an unknown field or out-of-set value is refused, not ignored.
- Authority, admission and reconciliation gates all decide before the adapter is consulted, and a
  refused probe proves the adapter was never called.
- A stale, future, draining, foreign-lease, expired-lease, mutable-target, expired-mandate,
  unregistered-provider, or unadmitted-capability probe returns a typed `BLOCKED` receipt.
- An unmodified prior receipt replays byte-identically without consulting the adapter; a prior
  receipt for another mandate or a tampered revision is a `RECEIPT_CONFLICT`.
- A truthful `UNAVAILABLE` reading is reported as an observation, not as a Gaia failure.
- Every receipt carries `effect: NONE` and `authority: NONE`, and the emitted vocabulary is closed.
- Repeated probes are byte-identical, and neither key order nor label order changes the revision.
- Mechanism reverts show each gate is a mechanism rather than a coincidence of the fixtures.
