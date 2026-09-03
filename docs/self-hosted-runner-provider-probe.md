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

An MCP server name is the one operator-supplied string this module ever republishes, so its
*accepted representation* is bounded rather than merely inspected. A name is a lowercase label
path: at most four segments separated by a single `-`, `.` or `_`; each segment a letter followed by
at most eleven lowercase alphanumerics; at most forty characters in total; and no segment that is an
unbroken run of eight or more hexadecimal characters. `filesystem`, `claude-code`, `context7` and
`github.mcp` are names. `glpat-abcdefghijklmnop`, `hf_abcdefghijklmnopqrst`,
`npm_abcdefghijklmnopqrst`, a bare forty-character hex value, and every mixed-case token form are
not names at this revision, whichever prefix they carry.

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
provider-reported blockers, `effect: NONE`, `authority: NONE`, an `observationSource`, and a
`revision` that is the SHA-256 of exactly the receipt it is published on.

`observationSource` is the closed discriminator that makes synthetic evidence distinguishable at
rest. It is taken from the *adapter's own declared source*, never from the fixture and never from
the observation body, and the observation must claim the same source or the probe refuses. Its
vocabulary is `SYNTHETIC_FIXTURE` and `LIVE_PROVIDER`; the only adapter this slice ships declares
`SYNTHETIC_FIXTURE`, and `LIVE_PROVIDER` exists for the same reason `CODE_WRITE` does — a token that
is representable can be refused by a mechanism, and a single-valued discriminator discriminates
nothing. On a `BLOCKED` receipt `observationSource` is `null`, because a blocked receipt publishes
no observation.

The idempotency key is derived from the work key, the generation, the provider, the capability and
the mandate id. It binds a receipt to one generation, so a receipt minted by an older generation can
never be replayed into a newer one.

A prior receipt supplied for reconciliation is untrusted input. Its `revision` is a bare content
hash that any caller can recompute, and the idempotency key and mandate digest are derivable from
public exports, so those three values prove that a receipt is whole, not that this module minted
it. Before gate 7 can return a prior receipt it is parsed against this same contract: `outcome`
from its vocabulary and `blocker` a registered code exactly when the outcome is `BLOCKED`;
`effect` and `authority` literally `NONE`; the idempotency key, mandate digest and runner work
key digest-shaped; `runnerGeneration` bounded; `provider`, `capability`, `availability`,
`observationSource` and `providerBlockers` from their vocabularies; `observedAt` a comparable
instant; `quota` and `usage` read by the observation parsers; every MCP name an admitted label,
in sorted order; a `BLOCKED` receipt carrying no observation and an observed receipt carrying one
coherent observation. It is then bound to this runner work key, generation, provider, capability,
idempotency key and mandate digest. A receipt outside that contract, or bound to another context,
is refused as `RECEIPT_CONFLICT` and never repaired, so the reconciliation path republishes
nothing the minting path could not have published.

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
4. `MANDATE_EXPIRED` — the observed instant is at or after the mandate deadline. Expiry is
   inclusive: a mandate is not still valid at the instant it expires.
5. `LEASE_ABSENT`, `LEASE_FOREIGN`, `LEASE_EXPIRED`, `MUTABLE_TARGET_NOT_ADMITTED` — the lease must
   exist, name this work key, generation, provider, capability and corpus, be unexpired at the
   observed instant, and name an immutable target.
6. `PROVIDER_UNREGISTERED`, `CAPABILITY_NOT_ADMITTED` — the closed admission table.
7. `RECEIPT_CONFLICT` — crash reconciliation. A supplied prior receipt must parse as a receipt
   this module could have minted (the contract above), carry a `revision` equal to its own
   recomputed digest, and name this exact idempotency key, mandate digest, runner work key,
   generation, provider and capability. If all of that holds, that receipt is returned
   byte-identically **and the adapter is never called**; that is what reconciling receipts before
   retrying an effect means for a probe. If any check fails, the probe refuses rather than minting
   a second, differing receipt for one key, and never repairs the receipt it was handed.
8. `PROVIDER_ADAPTER_FAILED` — the adapter threw, returned a non-object, or returned nothing.
9. `OBSERVATION_INVALID`, `OBSERVATION_MISBOUND`, `OBSERVATION_INCOHERENT` — the observation is
   closed-parsed, must carry this mandate digest, this provider, this capability and this adapter's
   declared observation source, and must agree with itself: `AVAILABLE` with reported blockers, or a
   non-`AVAILABLE` reading with none, is incoherent and is refused rather than resolved in the
   provider's favour. An observation claiming a source the adapter did not declare is misbound.
10. `CREDENTIAL_MATERIAL_PRESENT` — a name in the observation is not an admitted MCP server label,
    or carries a well-known credential prefix. A name that is not a label is refused here rather
    than parsed as one, because Gaia cannot tell an unusual name from session material and must not
    republish either.
11. `UNDECLARED_MCP_SERVER` — the observation reported an MCP server the mandate did not declare.
12. `AUTHORITY_WIDENING` — the observation claimed any effect, any authority, that source was
    exposed, or that a credential was read.
13. `BUDGET_EXCEEDED` — reported token, context, or wall-clock usage exceeds the mandate budget.

## Four corrections this design did not survive

The order above was decided before the gates ran. Four steps of the original design did not survive
them, and `src/runner-provider-probe.mjs` implements the corrections structurally rather than as
advice.

**An expired mandate is not work, so there is nothing for a lease to be held against.** The lease
was originally checked before the deadline. That order reports `LEASE_EXPIRED` to a runner whose
real problem is that its mandate ran out — a true statement that names the wrong cause, and one
that would send an operator to renew a lease instead of reissuing a mandate. The deadline now
decides first.

**A credential-shaped name must not be republished in order to complain about it.** The
undeclared-MCP-server check originally ran before the credential-shape check, so a name like
`ghp_...` would have been refused for being undeclared, after being read as a server name. The
credential shape now decides first, and such a name reaches no other gate.

**A prefix list is a sample, not a bound; the accepted representation is the bound.** The first
implementation bounded MCP server names only by charset and length and then compared them against a
sample of published credential prefixes. That is a denylist wearing a schema's clothes: an
independently reproduced probe showed `glpat-abcdefghijklmnop`, `hf_abcdefghijklmnopqrst`,
`npm_abcdefghijklmnopqrst` and a bare forty-character hex value passing both boundaries and being
echoed verbatim into a successful, content-addressed receipt — the durable artifact this design
calls evidence. Lengthening the sample would have repeated the mistake at the next unlisted prefix.
The correction narrows what a name *is*, so that a credential-shaped value has no admitted
representation to arrive in. The prefix list is retained unchanged, and unextended, as a second
check on names that are otherwise well-formed labels.

**A recomputed revision is not provenance; the receipt contract is.** The reconciliation gate
originally checked a prior receipt's key set and its revision, then returned it. A revision is a
bare content hash any caller can recompute, and the two bound digests are derivable from public
exports, so an independent review reproduced a receipt-shaped object carrying `effect:
REVIEW_POSTED`, `authority: MERGE_APPROVAL`, a caller-chosen observation source, five
credential-shaped MCP names, an out-of-vocabulary quota and usage, and another runner's work key,
generation, provider and capability being returned as this probe's receipt, with the adapter never
called. It is the correction above — untrusted content reaching a receipt unparsed — at a third
seam: the mandate and the observation were parsed, the prior receipt was only re-hashed. A prior
receipt is now parsed against the receipt contract and bound to the current context before it can
reconcile anything, and a forgery is refused as `RECEIPT_CONFLICT`, never repaired.

## What the fail-closed gates honestly prove

- **Budget.** A pure function cannot interrupt a provider mid-call. What it can do is refuse to
  publish an over-budget observation as a capability reading, and leave a typed blocker as the
  durable evidence that the budget was breached. The enforcement that stops the spend belongs to the
  execution adapter of a later slice, not to this receipt.
- **Credential material.** Every observation field is a closed token, a bounded identifier, a
  bounded lowercase label path, or a bounded non-negative integer. The claim this bullet is allowed
  to make is about *representation*, not detection: a value that is not one of those four things
  cannot be carried at all, and the label bound admits no published credential format. What it is
  not is a secret scanner. A short lowercase label is still an operator-supplied string, and a name
  such as `cafe` is admitted because it is a name; the honest guarantee is that the receipt's MCP
  field carries at most four short lowercase labels, not that nothing memorable fits in them.
- **Authority.** The refusal is on what the adapter *claims*, not on what it did. This slice cannot
  observe a provider's real behaviour; it can refuse to record a claim of effect as a capability.
- **Crash and replay.** There is no durable store here. Reconciliation is against a prior receipt the
  caller supplies, and that receipt is parsed against the receipt contract and bound to the current
  context before it is believed. What this slice cannot prove is that the store handed back the
  receipt it was given; the durable store, its compare-and-set, and its ownership are a later slice.
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

It declares `observationSource: 'SYNTHETIC_FIXTURE'` on the adapter itself. The fixture contract has
no such field, so a fixture cannot claim to be a live provider, and the kernel reads the declaration
from the adapter rather than from the answer the adapter returns.

The request handed to an adapter is deliberately minimal: provider, capability, corpus id, prompt
count, budget, declared MCP servers, and the mandate digest. There is no repository, ref, path,
token, prompt body, or environment in it.

## The module is text

The digest domain separator is the NUL character, and it is written in the source as the
two-character escape `\0`. Embedding the raw byte made every `grep -r` and `rg` sweep over `src/`
skip the file as binary — including a reviewer's manual sweep for authority or credential handling —
and made a receipt's content address depend on a byte an editor or a `.gitattributes` normalization
can silently drop. The escape is byte-identical at runtime, so no work key, idempotency key or
receipt revision changes; one gate pins those digests and one gate asserts the source file contains
no NUL byte.

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
  receipt for another mandate, runner, generation, provider or capability, a tampered revision, or a
  recomputed-consistent receipt outside the receipt contract is a `RECEIPT_CONFLICT`, refused
  field by field and never repaired.
- A truthful `UNAVAILABLE` reading is reported as an observation, not as a Gaia failure, and every
  successful receipt names the source of the reading, so synthetic evidence is distinguishable at
  rest from a reading a later slice takes from a live provider.
- Credential-shaped MCP identifiers have no admitted representation at any boundary — mandate,
  fixture, observation, or prior receipt — a safe identifier is still admitted and still
  published, and the module source is text.
- Every receipt carries `effect: NONE` and `authority: NONE`, and the emitted vocabulary is closed.
- Repeated probes are byte-identical, and neither key order nor label order changes the revision.
- Mechanism reverts show each gate is a mechanism rather than a coincidence of the fixtures.
