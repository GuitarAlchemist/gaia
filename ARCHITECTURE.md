# Gaia Architecture

This is Gaia's authoritative architecture map. It owns system-level boundaries,
dependency direction, authority, state classes, and runtime topology. A linked subsystem
document remains authoritative for that subsystem's local mechanics. If the two conflict,
this map wins for the system boundary and the subsystem document wins inside its named seam.

## Purpose, scope, and non-goals

Gaia coordinates evidence-bearing software delivery. Its kernel preserves identities,
claims, observations, transitions, authority limits, and receipts so another actor can
replay or refuse a result. Replaceable adapters observe tools and repositories, persist
state, project operator views, and perform separately authorized effects.

This map describes behavior implemented in this repository at the verified revision. It
does not make a design document, prototype, research result, or provider capability part of
the kernel. Gaia is not a general-purpose operating system, an authentication service, a
distributed consensus system, a safety controller, a hosted multi-tenant service, or a
source of merge, deployment, spending, credential, or configuration authority.

## System context and organization-neutral boundary

The organization-neutral core speaks in work identities, generations, observations,
intents, effects, revisions, and receipts. Repository owners, account identifiers, API
payloads, client configuration, ref layouts, database tables, and filesystem locations
belong to adapters. An adapter may narrow capability; it cannot reinterpret identity,
freshness, uncertainty, terminal state, or authority.

```mermaid
flowchart LR
  Clients[Claude / Codex / local tools] --> Stdio[stdio MCP edge]
  Stdio --> Kernel[coordination kernel]
  Kernel --> LocalLog[append-only local evidence]
  Sensors[repository and lane sensors] --> Modules[operation modules]
  Modules --> Intent[closed intent]
  Intent --> Approval[explicit authority boundary]
  Approval --> Effects[effect adapters]
  LocalLog --> Projections[rebuildable projections]
  Modules --> Projections
```

Organization policy is injected at a composition root. No organization name, provider,
storage engine, or operator UI is needed to execute the pure state transitions.

## Components and dependency direction

Dependencies point inward:

1. pure state machines and closed policy vocabularies depend only on supplied values;
2. deep operation modules own identity, validation, sequencing, reconciliation, and
   terminal projection;
3. durable and effect adapters implement those modules' narrow seams;
4. scripts, MCP, workflows, and dashboards are composition roots and user-facing edges.

The pure kernel never imports a provider, process environment, clock, filesystem, network,
or UI. Edges inject observations and time. Effect adapters consume an already closed intent;
they do not create authority or revise the domain decision. Read models consume reconciled
evidence and never feed display state back into an effect decision.

## Module and seam map

The interface column is the caller-visible contract. Adapter-specific mechanics are named
only in the final column and must not escape in a result or refusal.

| Module | Interface | Seam | Concrete adapters |
| --- | --- | --- | --- |
| Coordination kernel | `decide(state, command) -> events`; `apply(state, event) -> state` | Six coordination verbs and replay | stdio MCP edge; deterministic tests |
| Durable event log | `load() -> events`; `commit(expected revision, events) -> receipt or refusal` | Single-writer append and compare-and-set | local append-only JSONL; in-memory test fixtures |
| Draft operation | `enqueue(selector)`; `reconcile(identity, expected revision) -> projection or refusal` | One canonical Operation Envelope | protected GitHub Git Data ledger and effect adapter; memory ledger |
| Hosted Draft intake | `runHostedDraftIntake(trigger, observations) -> receipt or refusal`; `produceHostedDraftPumpObservation(receipt) -> observation or refusal` | Resume one unsettled operation before admitting at most one candidate; authority-free sealed observation | serialized GitHub Actions intake; existing Draft ledger/admission/effect adapters; deterministic fixtures |
| Portfolio survey and drain | `survey(observations) -> revision`; `advance(revision) -> intent or refusal` | Read-only inventory to one bounded next transition | GitHub read adapter; deterministic fixtures; append-only drain ledger |
| Pull-request conflict classification | `classifyPrConflict(observation, claim) -> reading or refusal` | Exact-generation, read-only classification under a closed empty strategy registry | normalized GitHub observation; deterministic fixtures |
| Publication and operator | `prepare(intent)`; `authorize(grant)`; `execute(intent) -> receipt` | Human-mediated privileged effect | GitHub publication/operator adapters; owned in-memory broker tests |
| Factory telemetry | `record(phase)`; `replay(events) -> lifecycle or refusal` | Closed evidence events and freshness projection | local evidence log; wmux/Claude sensor; deterministic fixtures |
| Control room | `render(snapshot, observed instant) -> read model` | Authority-free operator projection | static HTML/dashboard; in-memory snapshots |
| Hybrid search | `index(corpus)`; `query(request) -> matches or refusal` | Advisory retrieval with provenance | local JavaScript engine; optional IX embedding input |
| Architecture drift | `checkArchitectureDrift(inventory) -> report or refusal` | Normalized repository inventory | filesystem inventory; deterministic in-memory inventory |

The architecture-drift verification seam is the only seam introduced by this map itself. One
black-box contract suite runs against both adapters and includes broken-link, missing-section, stale
revision, interface-leak, change-impact, malformed-input, ordering, deletion-depth, and
mechanism-revert controls. Backtick code spans in the Interface column are the structurally
declared machine contract. Provider identifiers, configuration, transport errors, storage
layout, payload, retry, path, ref, and object-identifier terms in those spans fail the gate;
unstructured prose is not treated as proof of either a leak or a clean boundary.
Removing this module would force the workflow, local verifier, and tests to reimplement link
resolution, required-section policy, revision freshness, path sensitivity, closed reporting,
and interface-boundary checks. A black-box deletion control substitutes a shallow pass-through at
the same public seam and demonstrates that broken-link, missing-section, stale-revision,
interface-leak, and undeclared-impact mutants escape unless the caller reimplements those policies;
the unmodified caller also refuses when the seam is absent. The other module contracts and deletion
rationale are maintained in their linked subsystem designs and tests.

## Work lifecycle: pumps, funnels, and lanes

A pump is one bounded pass: observe sensors, replay durable state, select at most one eligible
transition, produce a closed intent, spend only the named authority, and append a receipt or an
explicit no-op. A funnel is the narrowing of many observations through readiness, policy,
capacity, and freshness gates to that one candidate; Gaia does not implement a generic funnel
framework. The portfolio drain and hosted Draft pump are the current concrete funnels.

A lane is an execution surface, not authority and not proof of useful work. Local wmux lanes are
observed by a read-only sensor. Four live lanes per workspace is the supported default; six is a
future validation target and limits above four are experimental. Lane heartbeats establish only
sensor freshness. They do not enter backlog truth, acceptance, completion, cost, percentage, or
ETA.

The principal operation lifecycle is observation -> eligible claim -> intent -> effect started ->
reconciliation -> terminal receipt. Draft operations preserve `ENQUEUED`, `CLAIMED`, `INTENT`,
`EFFECT_STARTED`, and `EFFECT_AMBIGUOUS` as nonterminal distinctions. `CREATED`, `REUSED`,
`REFUSED`, and `CANCELLED` are terminal only when exact evidence supports them. Ambiguous remote
effects remain nonterminal until reconciled; elapsed time and retries cannot manufacture truth.
The scheduled Hosted Draft intake is one concrete pump: a serialized run resumes the first
deterministically ordered unsettled operation before it may admit one eligible issue. Its sealed
observation is a read model with no authority and cannot replace the durable Draft receipt chain.

Pull-request conflict classification is read-only at this revision. It binds the observed base and
head generation and can report clean, unknown, superseded, or escalation-required. Its automation
strategy registry is empty, so automatic resolution, durable conflict claims, patching, pushing,
and reconciliation remain explicitly planned rather than implied by the reserved lifecycle words.

## Authority and state transitions

Gaia keeps these concepts separate:

- a **claim** reserves or reports observed work and grants no effect authority;
- an **intent** is the exact proposed mutation bound to identity, generation, policy, and revision;
- an **effect** is attempted only by one named owner with one bounded capability;
- a **receipt** records preconditions, outcome, evidence revision, and authority actually spent;
- compare-and-set (CAS) rejects a transition when durable state moved after observation.

The coordination bus has exactly six non-privileged verbs: `register`, `send`, `inbox`, `ack`,
`heartbeat`, and `handoff`. Delivery means accepted for delivery, acknowledgement means receipt,
and handoff transfers context rather than privilege. Message text is `untrusted-text`. None of the
six verbs can approve, merge, push, commit, deploy, execute arbitrary code, read credentials,
change configuration, spend money, or grant authority.

State-changing operation modules have one boundary owner. Stable Work Identity is separate from
Generation Identity. Expected durable revisions gate adoption and mutation. Provider outcomes are
projected through closed vocabularies, and repeated delivery is idempotent or returns the prior
receipt without duplicating an effect.

## Durable and rebuildable state

GitHub Cloud is the durable authority for hosted repository facts, protected ledger refs,
published issues and pull requests, checks, and provider-observed effects. The canonical Draft
ledger uses append-only commits and non-force ref updates; Git object identifiers remain private
to its adapter while content revisions cross the module seam.

The local bus `events.jsonl`, portfolio drain ledger, and factory telemetry log are also durable
sources within one local data directory. They use a lock-directory protocol, validating replay,
newline-complete appends, fsync, and CAS. They are not substitutes for GitHub's hosted effect
truth and are not safe on a shared network filesystem.

Control-room snapshots, HTML, indexes, caches, and DuckDB PR-review telemetry are rebuildable
projections. Their absence or corruption cannot be treated as loss of hosted authority. DuckDB is
optional and never decides acceptance, readiness, or an effect. A projection may accelerate or
explain observation; it may not become a second writer of canonical state.

## Providers and offline artifacts

Provider adapters translate a closed intent into a concrete effect and normalize the observation
back into the module vocabulary. Provider identifiers, payloads, diagnostics, retry state,
configuration, credentials, refs, object identifiers, and storage paths stay behind that seam.
Transport ambiguity is normalized as an unsettled observation, not a success or refusal guessed
from prose.

Offline adapters are advisory. The local hybrid-search path accepts caller-supplied embeddings or
an optional local IX embedding binary and preserves URI, line, digest, and freshness provenance.
Its result is `RETRIEVAL_MATCH` with `authority: NONE`. The enforced ecosystem policy currently
allows read-only GA and runtime-only TARS adapters, rejects Hari integration, and defers IX runtime
coupling. Those verdicts do not widen the six bus verbs.

## Failure, restart, replay, reconciliation, and alerts

Gaia fails closed. A lock timeout, torn or corrupt log, invalid chain, stale CAS revision,
unsupported record, incomplete provider observation, or identity mismatch writes no reassuring
partial result. The local bus restarts by validating and replaying the complete append-only log.
A stuck lock is reported and requires a human to establish that its owner is gone; code never
auto-breaks it. A damaged log is preserved for diagnosis and is never silently truncated.

Hosted operations reload their sealed envelope and durable receipt chain. Reconciliation reads
the authoritative provider again and either proves the exact terminal state or remains unsettled.
Each scheduled Hosted Draft intake first lists and resumes one unsettled operation; a resuming run
does not admit new work. A crash after enqueue therefore leaves durable work for the next intake,
while a lost compare-and-set performs no effect and is reported as a typed stale-revision refusal.
Retries repeat a bounded request under the same identity and idempotency boundary; they do not
skip revision checks. Repeated independently reproduced failures at one seam trip the
Boundary redesign circuit breaker and preserve immutable Failure Evidence.

Alerts are evidence-backed projections: blockers, expired telemetry, corrupt evidence, stale
reviews, and authority-needed states. A missing sensor yields unknown or paused state, never a
fabricated failure or success. Detailed recovery procedures remain in
[Crash recovery](docs/crash-recovery.md).

## Security, tenancy, quotas, and human approvals

The bus provides authority confinement, not authentication. Actor trust is positional: a process
able to spawn the server can register and speak as an actor. One data directory is one local trust
and failure boundary; Gaia does not claim hosted tenant isolation, cross-tenant confidentiality,
or service-level availability.

Least privilege is structural: the bus lacks privileged verbs, adapters receive bounded inputs,
provider secrets are excluded from evidence, and irreversible actions are separate transitions.
The hosted operator requires an interactive human to confirm the full revision-bound intent and
spends a short-lived grant once. Non-interactive input cannot authorize it. Publication, merge,
deployment, spending, credential, and configuration rights are never inferred from agent text,
labels, activity, or completion markers.

Resource ceilings are local safeguards, not billing authority: four supported live lanes,
bounded outputs, timeouts, one-step drain transitions, and explicit cost/fanout limits where a
factory request declares them. Gaia has no general quota service and no authority to start paid
work merely because capacity appears available. Production multi-tenancy, billing quotas, and a
remote authority broker are not implemented.

## Observability, provenance, freshness, ETA, and delivery metrics

Every decision-bearing artifact binds stable identities, content revisions, producer/method
context, and derivation links. Raw agent output is untrusted evidence and never becomes an
architecture claim without a source witness. Freshness, quality, acceptance, and authority are
independent axes.

The telemetry spine records a closed seven-event lifecycle with no prompt, reasoning, output,
credential, or free-text field. Replay is deterministic. An observer supplies its own instant and
applies the 30-second heartbeat window. A fresh heartbeat proves liveness of that sensor only; a
stale heartbeat produces an explicit blocker and cannot animate the control room.

The control room reports queue and lifecycle counts, terminal outcomes, blockers, evidence age,
last verified transition, and the next evidence checkpoint. It does not invent project-completion
percentages, throughput, confidence, or an ETA for open-ended work. Provider progress may show
elapsed time and a remaining timeout upper bound labelled `(not an ETA)`. Delivery metrics measure
accepted transitions and receipts, not tokens, lane activity, or prose completion markers.

## Runtime topology and operating modes

- **Local plugin candidate:** Node.js over stdio MCP, append-only local state, no listener, no
  remote execution, and no shell transport. Windows with Node 20 and 24 is the supported CI path;
  Ubuntu remains portability discovery.
- **Local factory/operator:** bounded Claude/Codex/wmux processes, offline artifacts, explicit
  worktrees, read-only dashboards, and an interactive authority boundary for privileged effects.
- **Hosted pump:** GitHub Actions runs the serialized scheduled/issue-triggered Draft intake and
  the separately sealed effect path. Protected Git refs are the durable ingress/receipt ledger;
  Actions is not the queue or authority source.
- **Read-only/offline analysis:** portfolio survey, hybrid search, telemetry replay, architecture
  verification, and control-room rendering run with `effect: NONE`.

This repository is an installation candidate, not an installed plugin. Automatic pull-request
conflict resolution and its effect lifecycle, remote operator authority beyond the shipped
interactive path, and six-lane validation remain planned; production tenant/quota services are out
of scope. Planned work stays non-normative until code, evidence, and a fresh verification revision
are linked here.

## Detailed architecture references

- [Engineering and research principles](docs/engineering-and-research-principles.md) — normative
  module, authority, tracer, evidence, and redesign constraints.
- [Canonical Draft operation envelope](docs/draft-operation-envelope.md) and
  [ADR 0001](docs/adr/0001-canonical-operation-envelope.md) — identity, ledger, CAS, effect, and
  reconciliation ownership.
- [Hosted Draft intake](docs/hosted-draft-intake.md) and
  [Hosted Draft observation producer](docs/hosted-draft-pump-producer.md) — scheduled admission,
  resume-first recovery, receipt-derived observation, and authority boundaries.
- [Portfolio factory](docs/github-portfolio-factory.md),
  [portfolio drain pump](docs/portfolio-drain-pump.md), and
  [hosted operator](docs/github-portfolio-operator.md) — observation, funnel, intent, and approval.
- [Factory telemetry spine](docs/factory-telemetry-spine.md) and
  [control room](docs/factory-control-room.md) — lifecycle evidence, freshness, and projections.
- [Scale and lanes](docs/scale-and-lanes.md) and
  [local wmux lanes](docs/local-wmux-lanes.md) — measured concurrency and lane semantics.
- [Ecosystem adapters](docs/ecosystem-adapters.md) and
  [hybrid semantic search](docs/hybrid-semantic-search.md) — bounded external and offline inputs.
- [Pull-request conflict classifier](docs/pr-conflict-reconciler.md) — exact-generation read-only
  classification and the deliberately empty automation registry.
- [Crash recovery](docs/crash-recovery.md),
  [artifact completion signals](docs/artifact-completion-signals.md), and
  [holdout-safe reporting](docs/holdout-safe-reporting.md) — recovery, terminal evidence, and
  provenance discipline.

## Verification

The authoritative machine-readable `Last verified at` record is
`package.json#gaiaArchitectureVerification`. It binds a verification date and reviewed Git commit
to the SHA-256 revision of the exact `ARCHITECTURE.md` bytes. The named commit must contain those
same bytes; merely naming an older reachable commit is stale. Keeping the attestation outside this
file avoids a self-referential content hash while leaving this map byte-stable after review.

Verification inspects the root README, the pure coordination kernel, append-only event log,
operation envelope, portfolio/drain, telemetry/control-room, lane, ecosystem, recovery, security,
and runtime contracts at the attested commit. `npm run architecture:verify` checks this document's
required sections, internal links, exact content revision and commit witness, declared interface
contracts, and architecture-sensitive change declaration. The production CLI derives the commit
witness from raw `git show --end-of-options <commit>:ARCHITECTURE.md` bytes; callers cannot inject
revision evidence. An explicit base is limited to a full commit identifier or canonical
`refs/heads/`, `refs/tags/`, or `refs/remotes/` name and is passed after Git's
`--end-of-options` delimiter. Detailed subsystem claims remain owned by the linked documents and
their black-box tests. The CI architecture-impact gate is intentionally pull-request-only because
its declaration and evidence are PR-body facts. Main-push CI still runs the supported test matrix;
it does not reconstruct or invent impact evidence after merge.
