# Lane generation bootstrap R0 — design decision and contract

Status: design decision plus the R0 contract that ships with it. This document grants no
authority, starts no lane, spends no quota and approves nothing. It records what was decided
before implementation for issue #93, which seams were rejected, what R0 deliberately leaves
open, and the falsifiers the tests attempt.

## Operator problem

### Review repair decision — 2026-09-05

Independent Standards and Spec reviews rejected the combined candidate `a8d120eb`.
Two counterexamples are retained in PR #95 comment `5548856272`. This bounded repair
addresses incomplete cleanup only; overlapping same-actor resumptions remain a P1
blocker and no concurrency-complete claim or merge is permitted from this slice.

At the existing `bootstrapLaneGeneration(manifest, ports)` seam, a cleanup attempt must
first persist `COMPENSATING` by CAS against its last accepted revision. A stale loser
returns `STALE_REVISION` without cleanup. The intent is written before cleanup effects,
so a lost response or interrupted cleanup can be reconciled at the same ordinal. While
that intent exists, a newer ordinal is refused. The owning actor's next invocation
continues cleanup only, never startup. Terminal `COMPENSATED` requires successful cleanup
and a fresh structured observation with no operation-marked panes or agent records.
An unavailable observation or unresolved cleanup remains `COMPENSATING` and returns
`CLEANUP_INCOMPLETE`; successful cleanup recovery returns `GENERATION_COMPENSATED`.

Falsifiers: cleanup methods throw; cleanup methods acknowledge without removing resources;
the cleanup-intent response is lost; a successor is attempted before cleanup settles.
Recovery must restore the fixture's baseline, preserve Music, and perform no new spawns.
The narrower alternative (leave `IN_FLIGHT`) is rejected: it can restart failed work
instead of finishing cleanup. Marking failure terminal is rejected because it admits
orphan overlap. No new bus verb, provider authority, dependency or production adapter.

This is not an execution fence: same-actor overlapping resumptions can still perform
concurrent provider effects. That separate counterexample must be closed before review
approval. A read-before-effect check or process-local mutex is not a cross-host repair.

Two reproduced failures, both recorded in issue #93, say the same thing about the same seam.

On 2026-09-01 a lane spawn accepted a pane identity that no longer existed and returned a
`running` agent whose pane and surface were absent from the live tree. A real child process ran
where no operator could see it, the only visible pane sat at a shell prompt, and the counted
`running` agents included records with no child and no artifact. Every retry added another
hidden record.

On 2026-09-02 a live four-pane grid was expanded to six *after* agents had spawned. Four active
surfaces collapsed into one pane carrying four stacked tabs, and restarting a watchdog left its
exited surface stacked beside its replacement.

The two failures share one root: the launch had no linearization point. `running` was published
by the terminal multiplexer at the moment a process was created, so a launch could be counted
before anything was verified, and the topology was mutated underneath launches that had already
been counted. Neither failure is a wmux defect that a wmux fix would close, because Gaia had no
durable statement of what the generation was supposed to be — so after a host or app crash there
was nothing to reconstruct *from*, and nothing to compensate *against*.

### Affected actor and consumer

The operator who restarts a machine and expects the declared orchestration generation to come
back, and the supervising lane that has to know whether a subordinate lane exists at all. The
consumer of the new evidence is any reader of the durable launch receipt: a dashboard that must
not print `ACTIVE` from a multiplexer's `running` alone, and a watchdog that must find its
reporting edge after its own restart.

### Success criteria

1. One published launch receipt means: every declared lane has exactly one visible pane, exactly
   one terminal surface, one process bound to the returned agent identity, and a persisted
   reporting edge — all proven against one fresh structured snapshot before publication.
2. Any failure before that point leaves the visible terminal count and the live agent count
   exactly as they were, having stopped, reaped and closed only what this operation created.
3. The same manifest bootstrapped twice produces one generation, one set of panes and one set of
   processes; the second call returns the first receipt.
4. A generation is identified by content, not by remembered pane identities, so it can be
   reconstructed from the authoritative document alone.
5. A second lane provider — a different terminal host, a different agent runtime, a different
   model vendor — is admitted by publishing a capability descriptor, and by changing no branch in
   Gaia's decision code.

### Falsifiable non-goals

- The bootstrapper reads no screen, prompt, banner, reasoning trace, command line or standard
  output. Structured metadata and process identity are the only correctness evidence, and the
  closed evidence vocabulary contains no member that could be satisfied by scraping.
- It holds no credential, opens no network connection, answers no trust or permission prompt,
  spends no paid quota and starts no billed work.
- It adds no bus verb. The six coordination verbs are untouched, and no receipt here grants
  authority to merge, push, publish, deploy or spend.
- It is not a scheduler, a watchdog, a supervisor runtime or a dashboard. It publishes the
  evidence those consumers need and does none of their work.
- It never touches a workspace it did not create for the generation under bootstrap. `Music`,
  and every other unrelated workspace, is out of reach by construction rather than by care.
- Gaia core does not depend on wmux. wmux is one adapter behind the seam, and the R0 tests do not
  require it to be installed, running or reachable.

## Prior art read before designing

- [Local wmux lanes](local-wmux-lanes.md) — the read-only lane sensor, the closed observation, and
  the rule that lane liveness is sensor freshness rather than progress. The bootstrapper produces
  the durable receipt that sensor deliberately cannot.
- [Canonical Draft operation envelope](draft-operation-envelope.md) and
  [ADR 0001](adr/0001-canonical-operation-envelope.md) — stable work identity separated from
  generation identity, compare-and-set on a durable revision, stable operation identity, and
  unsettled-rather-than-guessed outcomes. This design reuses that vocabulary rather than
  inventing a parallel one.
- [Crash recovery](crash-recovery.md) — fail-closed replay and the single-writer commit protocol.
- [Agent-platform capability benchmark](research/2026-08-30-agent-platform-capability-benchmark.md)
  — records that durable attempt supervision and a provider/cost policy plane are Gaia's real
  gaps, and that "zero additional cost" is an admission constraint rather than a pricing promise.
  The capability descriptor below is the smallest honest form of that admission constraint.
- [Scale and lanes](scale-and-lanes.md) — four live lanes is the measured default. This module
  reuses `resolveLaneLimit` rather than re-deciding the number.

## Design It Twice — where the bootstrap seam goes

### Seam 1 — harden the spawn call behind the existing lane adapter

Add the postcondition checks to the adapter that already shells out to the peer tool: re-read the
tree after spawning, and undo the spawn when it disagrees.

Rejected. It fixes the visible half of one failure and none of the durable half. An adapter that
verifies its own spawn still has no statement of what the generation was supposed to contain, so
it cannot reconstruct anything after a host crash, cannot elect one winner between two concurrent
launches, and cannot tell a retry from a second launch. It also puts the transition rules inside
the provider adapter, which is exactly where a second provider would have to reimplement them.

### Seam 2 — record lane launches into the factory telemetry spine and derive the generation from replay

The spine already replays a closed lifecycle deterministically, so a launch could be a run and
the generation could be the set of runs that replay as live.

Rejected, for the reason [local wmux lanes](local-wmux-lanes.md) rejected the same seam and one
more. Every spine run binds to a portfolio item and a gate vocabulary that a locally declared lane
does not have, and — decisively — an evidence log is an *append* of what happened, not a
compare-and-set over what may happen next. Two concurrent bootstraps both appending "started" is
not an election. The winner has to be decided by a durable compare-and-set before any process
exists.

### Seam 3 — a deep bootstrap module over two narrow ports: a durable generation store and a lane-provider adapter — **selected**

One module owns the whole transition: closed manifest validation, generation identity, winner
election, ordering, verification, receipt publication and compensation. It owns no mechanism. Two
injected ports supply everything it cannot compute:

- **store** — `read(workKey)` and `commit(workKey, expectedRevision, record)`, a single-writer
  compare-and-set over one durable record per stable work identity. An in-memory adapter ships for
  tests and deterministic replay; the durable local and hosted adapters are named in the omissions.
- **provider** — `describe`, `createTopology`, `spawn`, `snapshot`, `stopAgent`, `reapSurface`,
  `closePane`. Seven operations, all structural, none of which can return prose that changes a
  decision.

Chosen because it is the only seam where the transition rules are testable without any terminal
multiplexer, replaceable without rewriting them, and durable enough to reconstruct from. The
deletion test is direct: remove this module and every caller — the wmux adapter today, a second
provider tomorrow — must reimplement identity, election, ordering, verification and compensation,
and the two would not agree.

## Design It Twice — how a second provider is admitted

### Admission 1 — a registry of named provider modules, each with its own policy

One module per provider, each free to interpret its own liveness and its own idea of started.

Rejected. It puts business logic behind the provider name, which is the leak the architecture map
forbids: Gaia would then have a wmux branch, a Claude branch and a Gemini branch, and the
correctness of a launch would depend on which one ran. Adding the fifth provider would mean
reading the other four to discover what "started" is allowed to mean.

### Admission 2 — a closed capability descriptor the provider publishes and the module enforces — **selected**

`gaia-lane-provider-capability/1` carries exactly six things: the provider identity, the closed
capability set it implements, its cost/quota observation, its authentication mode, its
liveness/evidence contract, and its declared limits. The module reads only those fields. It never
reads the provider identity to choose a rule — the identity exists so a receipt can say which
adapter produced the evidence, and a test asserts that two descriptors differing only in identity
decide identically.

Consequences that make the descriptor load-bearing rather than decorative:

- a descriptor that does not implement every capability the protocol needs is refused *before* any
  pane exists, with `CAPABILITY_INSUFFICIENT`;
- an authentication mode outside the closed set is refused; no member carries a credential, and
  `EXTERNAL_OPERATOR` means an already-authorized interactive seat, never a secret this module
  holds;
- a declared quota smaller than the generation is refused with `QUOTA_INSUFFICIENT` before spawn,
  which is how "no paid work merely because capacity appears available" survives a new provider;
- the evidence contract chooses which structured observation proves startup, and the provider may
  only *narrow* the startup deadline the manifest declared, never widen it.

Claude, Codex, Antigravity/Gemini, Auggie, Junie and any later runtime fit through those six
fields or are refused. Neither their names nor their behaviours appear in this module.

## Decision receipt

- Selected: Seam 3 with Admission 2 — one deep module, two narrow ports, one closed capability
  descriptor.
- Rejected: adapter-local hardening (Seam 1); telemetry-spine replay as the generation (Seam 2);
  a named-provider registry (Admission 1).
- Optimization target: seam placement and reversibility over minimal surface. The transition rules
  are the expensive-to-reverse decision; the mechanisms behind both ports are cheap to replace.
- Reversibility class: **compensatable**. Every effect this module can cause is a resource it
  created and recorded, and the compensation path is the module's own failure path.
- Authority: none. No bus verb, no credential, no paid call, no privileged effect.

## Closed documents

### `gaia-lane-generation-manifest/1` — the authoritative input

Fetched from versioned GitHub state; local files and any projection are rebuildable. Exactly nine
top-level fields, and any other key is refused rather than dropped: `schema`, `repository`,
`workItem`, `workspaceId`, `generationOrdinal`, `providerId`, `policy`, `lanes`, `revision`.

`revision` is the SHA-256 of the canonical bytes of the other eight fields, so a manifest whose
content was edited after publication does not validate. `policy` carries `startupDeadlineMs`,
`ttlMs`, `retryBudget` and `cleanupPolicy`; R0 spends only `startupDeadlineMs` and persists the
rest into the receipt for the consumers that will spend them. Each lane carries `laneId`, `role`,
`subject` (an immutable revision or a mutable branch, distinguished rather than merged),
`supervisor` and `artifactMarker`.

The reporting edge is validated as a graph, not as a string: every `supervisor` resolves to
`OPERATOR` or to another lane in the same manifest, at least one lane reports to `OPERATOR`, and
a cycle is refused. A lane with no reachable owner is exactly the record that later disappears as
an exited process.

### `gaia-lane-provider-capability/1` — the provider-neutral admission seam

`schema`, `providerId`, `capabilities`, `authenticationMode`, `costObservation`,
`evidenceContract`, `limits`. Described above; enforced before topology.

### `gaia-lane-generation-record/1` — the durable transition record

`schema`, `workKey`, `generationId`, `generationOrdinal`, `operationId`, `actor`, `state`, `plan`,
`receipt`. `state` is one of `CLAIMED`, `IN_FLIGHT`, `ACTIVE`, `COMPENSATED`. There is no state
that means "probably fine": `ACTIVE` exists only beside a published receipt.

### `gaia-lane-launch-receipt/1` — the linearization point

Published only after every postcondition passes. Carries the identities, the observed layout
revision, the per-lane pane/surface/agent identities actually observed, the persisted supervisor
edge and artifact marker per lane, the evidence kind that proved startup, the policy, and its own
content revision. `verifyLaneLaunchReceipt` re-derives that revision, so a receipt edited after
publication is refused by its own reader.

## The protocol, in the one order it may run

1. validate the manifest; derive the work identity, generation identity and operation identity by
   content;
2. admit the provider capability against the manifest and the measured lane limit;
3. read the durable record and decide: replay, resume, refuse, or claim;
4. compare-and-set the claim — exactly one actor may hold a generation in flight;
5. **create the complete empty topology for the whole generation**, tagged with the operation
   marker, and record the observed layout revision;
6. enumerate fresh pane identities from a structured snapshot; adopt any pane already carrying
   this operation's marker instead of creating a second one;
7. spawn exactly one process per pane, in declared order, adopting an already-marked agent rather
   than spawning twice;
8. take **one** fresh snapshot and verify every postcondition against it: the layout has not
   moved, each pane exists and holds exactly one surface, each agent's pane and surface match what
   was returned, the process is live, the startup evidence its provider declared is present within
   the effective deadline, and each lane's reporting edge is registered;
9. publish the receipt and move the record to `ACTIVE`;
10. on any refusal in 5-9, compensate exactly: stop the agents this operation spawned, reap their
    surfaces, close the panes this operation created — in reverse order, by recorded identity
    only — then record `COMPENSATED` and return a typed refusal.

Step 5 before step 7 is the rule the 2026-09-02 failure violated. The whole grid is built before
any provider process exists, so a generation is never expanded around live surfaces.

## Concurrency, replay and staleness

- **One winner.** The claim is a compare-and-set against the durable revision. The loser observes
  a held claim, performs no provider call at all, and returns `CLAIM_HELD`.
- **Stable operation identity.** The operation identity is derived from the generation, so a retry
  is the same operation. A retry by the same actor reconciles: it adopts marked resources, fills
  only what is missing, and cannot create a second pane, tab or process.
- **A lost response is not a lost effect.** A crash or dropped reply leaves `IN_FLIGHT`; the next
  attempt reads the durable plan, re-observes, and either completes the same generation or
  compensates it. Elapsed time never converts an unverified launch into a receipt.
- **Stale generations have no effect.** A manifest whose `generationOrdinal` is not greater than
  the ordinal already recorded for that work identity is refused with `STALE_GENERATION` before
  any effect, including when its content differs.
- **Cleanup is bounded by construction.** Compensation iterates the recorded plan of this
  operation. It has no code path that enumerates a workspace and closes what it finds.

## What R0 does not close, stated against issue #93

R0 is the smallest end-to-end tracer bullet through every seam of the transition. It leaves these
acceptance lines open, and they are omissions rather than claims:

1. **No durable store adapter ships.** The store port and its deterministic in-memory adapter
   ship; the local append-only and hosted GitHub-backed adapters do not. Reconstruction is proven
   against the port, not yet against a disk or a protected hosted ledger.
2. **No CLI or skill entrypoint ships.** "A clean host runs one documented command" is not
   demonstrated; the public seam is the module function.
3. **No wmux adapter ships behind the port.** The provider port is exercised by a deterministic
   fake. Nothing here changes the existing read-only lane sensor or the peer-tool adapter, and no
   Windows integration fixture against a live wmux is included.
4. **The dashboard still derives nothing from this receipt.** Making `ACTIVE` depend on the
   reconciled receipt is a control-room change R0 does not make.
5. **No watchdog is started.** The receipt persists the reporting edge a watchdog needs; starting,
   supervising and reaping on time-to-live are later slices, and `ttlMs`/`retryBudget` are
   persisted unspent.
6. **A compensated generation is terminal in R0.** Retrying it requires a new
   `generationOrdinal`; the retry budget is not spent automatically.
7. **Generations above the measured lane limit are refused.** Six-lane validation remains the
   existing planned target; this module does not widen it.
8. **No artifact-funnel event is emitted.** Completion and failure become receipt and refusal
   here, not yet a funnel event.
9. **A newer generation does not supersede a live one.** Tearing down a published generation so a
   higher ordinal can replace it is a transition R0 does not perform, so the attempt is refused
   with `ACTIVE_GENERATION_PRESENT` rather than half-performed.
10. **Reconstruction is proven at the module seam, not from a cold host.** Every crash point in
    the protocol is exercised by resuming a durable record, but no test starts a second operating
    system process.

## Three corrections the implementation made to this design

Written before the code existed, this document made three claims the implementation did not
sustain. They are corrected here rather than quietly diverged from.

1. **"Refuse, or claim" was missing a case.** The election reads a record that may already be
   `ACTIVE` at a *lower* ordinal. Publishing a new generation beside a live one would leave the
   older generation's panes running with nothing owning them, so R0 adds
   `ACTIVE_GENERATION_PRESENT` and performs no effect. Supersession is a transition, not a side
   effect of claiming.
2. **Adoption needs the plan, not only the marker.** A crash between creating the topology and
   recording it leaves marked panes that no durable record maps to a lane. That mapping is
   unknowable rather than guessable — pane ordering is an adapter detail, not a contract — so
   those panes are compensated and the attempt refuses `TOPOLOGY_MISMATCH`.
3. **Compensation is narrower than the plan, not wider.** Targets are the marked resources in one
   fresh observation, so a pane this operation created but never recorded is still undone, and a
   surface stacked onto one of our panes is reaped even though no plan entry names it. The plan is
   the fallback used only when the observation itself fails.

## Falsifiers the tests attempt

| Gate | The claim it tries to break |
| --- | --- |
| B1 | An unknown manifest field, a bad revision, or an unresolvable/cyclic supervisor is accepted |
| B2 | Two byte-different manifests share a generation identity, or one manifest's identity is unstable |
| B3 | A process is spawned before the complete topology exists |
| B4 | A capability descriptor missing a required capability, carrying an unknown authentication mode, or declaring a quota below the generation reaches a spawn |
| B5 | Two concurrent bootstraps both act; the loser touches a pane, an agent or the record |
| B6 | A stale `generationOrdinal` performs any effect |
| B7 | A partial spawn failure leaves a pane, surface, agent or claimed record behind |
| B8 | Compensation touches a resource this operation did not create |
| B9 | A receipt is published while a pane carries a stacked second surface |
| B10 | A receipt is published when the returned agent's pane or surface is absent from the fresh snapshot |
| B11 | A receipt is published for a process that exited before verification |
| B12 | A receipt is published outside the effective startup deadline |
| B13 | A layout change during spawn is published anyway |
| B14 | A replay after a lost response creates a second pane, tab or process |
| B15 | A second bootstrap of a published generation re-spawns instead of returning the prior receipt |
| B16 | A published receipt can be edited and still verify, or a receipt exists without a persisted reporting edge |
| B17 | The decision depends on the provider identity: two descriptors differing only in identity decide differently |
| B18 | The module reads a screen, a prompt, a command line or standard output as correctness evidence |

## Verification

`node --test tests/lane-generation-bootstrap.test.mjs` is the focused suite; `npm test` and
`npm run verify` are the full gates. The RED commit lands the falsifiers first and fails; the
GREEN commit implements the smallest slice that passes them. A mechanism-revert control removes
the verification-before-publication step and demonstrates that the postcondition gates escape
rather than merely that a test is present.
