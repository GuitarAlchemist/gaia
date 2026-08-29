# Gaia systemic-risk threat model R1

Date: 2026-08-29
Status: research synthesis; advisory; no implementation or effect authority
Scope: Gaia as a durable, long-running, multi-agent software/research coordinator, including its evidence graph, local event-sourced bus, factory/operator seams, model providers, adapters, and human approval boundaries

## Executive verdict

Gaia's strongest current property is architectural, not cognitive: the six-verb interagent bus carries untrusted text and has no privileged verb, while the current epistemic proposal builder is pure, content-addressed, zero-budget, reversible, and advisory. Those properties materially contain prompt injection and false authority on that surface. They do **not** establish that agent conclusions are correct, independent, fresh, private, affordable, recoverable across schema change, or safe once a separate adapter receives real effect authority. The local basis for this verdict is Gaia's [README](../../README.md), [engineering and research principles](../engineering-and-research-principles.md), [crash-recovery design](../crash-recovery.md), [lane evidence](../scale-and-lanes.md), [context capsule design](../context-capsule-design.md), and [`epistemic-research.mjs`](../../src/epistemic-research.mjs).

The highest systemic risks are therefore:

1. an ill-framed request or proxy metric becomes a durable objective and is optimized after its original assumptions have expired;
2. mutually dependent agents manufacture apparent consensus from the same model, context, evidence, or judge;
3. untrusted evidence influences an authority-bearing deputy, or a valid grant is exercised against state other than the state a human reviewed;
4. distributed retries, stale leases, replay, or migration duplicate or misapply irreversible effects;
5. monitoring and human approval observe summaries rather than the exact trajectory, evidence, state, cost, and effect about to cross the boundary.

R1 recommends treating **framing as a learned, separately evaluated capability**. A vague request should first become a bounded execution contract. The contract must name the observable outcome, in-scope and out-of-scope work, assumptions, evidence gates, budget, authority, reversibility class, stop conditions, falsifiers, and rejection criteria. No work decomposition, agent fanout, or effect grant should occur before that contract is accepted. NASA's systems-engineering process begins by clarifying stakeholder expectations, objectives, constraints, and mission-success criteria, and validates proposed designs against those expectations and budget/schedule constraints; its requirements checklist also demands explicit assumptions, traceability, consistency, and verifiability ([NASA Systems Engineering Handbook](https://science.nasa.gov/wp-content/uploads/2023/04/nasa_systems_engineering_handbook_0.pdf), [requirements checklist](https://www.nasa.gov/reference/system-engineering-handbook-appendix/)). Applying that discipline to agent work is a **Gaia design hypothesis**, not a claim that an execution contract eliminates semantic ambiguity.

## Evidence discipline and labels

This report separates claims as follows:

- **Verified fact** means a statement directly supported by Gaia source/design documents or a cited primary external source.
- **Inference** means a Gaia-specific conclusion derived from those facts; it has not been established by a Gaia production measurement unless explicitly stated.
- **Design hypothesis** means a proposed control whose effectiveness remains to be tested against a declared falsifier.
- **Unknown** means the available evidence does not justify a conclusion. Unknown is not a low-risk score.

External evidence is limited to official standards/specifications and documentation, original papers, and first-party security or system guidance. Direct links accompany every external factual claim. No risk below should be read as a measured probability; likelihood and coupling must be measured in the deployment context.

## System boundary, assets, and adversaries

### Verified current Gaia properties

- The bus exposes only `register`, `send`, `inbox`, `ack`, `heartbeat`, and `handoff`; messages are stored as untrusted text and cannot grant commit, push, merge, deploy, spend, credential-read, or configuration authority ([README](../../README.md)).
- State is reconstructed from an append-only JSONL log by a pure reducer. Commit uses one filesystem lock, re-reads and validates the whole log under that lock, appends complete newline-terminated records, and fsyncs ([crash-recovery design](../crash-recovery.md)).
- Acknowledgement means receipt, not correctness, agreement, approval, or completion; a handoff transfers work, not authority ([`bus-core.mjs`](../../src/bus-core.mjs)).
- The log has no automatic compaction or schema migration. Replay is `O(events × actors)` under one global lock, and automatic stale-lock breaking is deliberately absent ([crash-recovery design](../crash-recovery.md)).
- Four live lanes are the supported default; higher counts are experimental or unproven with real heterogeneous clients ([lane evidence](../scale-and-lanes.md)).
- Gaia's epistemic proposal type requires immutable evidence digests, competing hypotheses, falsifiers, a negative control, explicit zero paid cost, reversibility, uncertainty mass, expiry, and no requested or execution authority ([`epistemic-research.mjs`](../../src/epistemic-research.mjs)).

### Protected assets

The protected assets are: user intent; source and artifact integrity; authority grants and signing keys; private data and credentials; provider accounts and budgets; exact candidate/evidence identity; event-log integrity; workgraph semantics; human attention; audit and recovery evidence; and the ability to stop, roll back, compensate, or safely decommission a run.

### Threat and failure actors

Threats include a malicious document, web page, repository, MCP server, dependency, provider account, or peer; a compromised build or update channel; a faulty or hallucinating model; correlated but honest agents; stale or contradictory authoritative sources; a crashed, delayed, duplicated, or partitioned process; a well-meaning human under automation bias or overload; and Gaia itself optimizing a proxy, continuing beyond its evidence, or replaying under changed semantics. Systemic safety must not assume malice is required.

### Trust boundaries

1. user request -> execution contract;
2. external/source content -> evidence record;
3. evidence record -> model context;
4. one agent's output -> another agent or judge;
5. advisory proposal -> policy/authority decision;
6. grant -> effect adapter -> external system;
7. in-memory state -> durable log -> replayed state;
8. old schema/model/provider -> new schema/model/provider;
9. telemetry/summary -> human understanding;
10. local dependency/build/update -> executable Gaia installation.

## Framing as a first-class learned capability

### Minimal bounded execution contract

Before planning or fanout, Gaia should produce an immutable, reviewable contract with:

- `requestId`, `requestRevision`, requester, and timestamp;
- one observable outcome and the affected consumer;
- explicit `inScope` and `outOfScope` sets;
- assumptions, each with owner, validation method, expiry, and consequence if false;
- required evidence gates and exact source/evaluation revisions;
- budget ceilings for wall time, tokens, paid cost, concurrency, disk, network, and human attention;
- allowed tools/data/effects and an explicit denied-authority set;
- reversibility class (`free`, `compensatable`, `migratable`, `one-way`) and compensation evidence;
- stop conditions, timeout, escalation path, and partial-result policy;
- success metrics plus anti-metrics that reveal Goodharting;
- falsifiers and rejection criteria;
- the smallest end-to-end tracer bullet and a maximum decomposition depth.

**Inference:** this contract makes drift detectable because later events can be compared with a stable object; it does not make the initial interpretation correct. **Design hypothesis:** framing quality can be learned and evaluated on held-out vague requests by scoring contract completeness, stakeholder correction rate, scope-change frequency, and downstream rework, while keeping all generated contracts advisory until a human or deterministic policy accepts them.

### F-1 — Scope creep and silent goal drift

**Evidence status:** inference from durable long-running coordination; contract control is a design hypothesis.

**Trigger:** a request lacks non-goals, later evidence is treated as a new instruction, a subtask discovers adjacent work, or an agent rewrites the outcome to match available tools.

**Harm:** authorized work expands without consent; cost and privacy exposure grow; success is declared against a different goal.

**Detectable signals:** changed-path or tool-use set exceeds contract; new nouns/targets appear without a contract revision; budget or decomposition depth rises; success criteria are edited after results.

**Prevent/contain:** exact contract revision on every work item and effect intent; deny unlisted targets/effects; route scope changes to an explicit superseding contract; compare final evidence to the original outcome and non-goals.

**Recovery:** stop, preserve the trajectory, classify out-of-scope effects, compensate reversible effects, and restart only from a reviewed contract revision.

**Residual uncertainty:** semantic equivalence between natural-language scope statements is not mechanically solved.

**Falsifier/rejection criterion:** reject the control as sufficient if held-out ambiguous requests still produce materially different execution scopes without a contract-change event.

### F-2 — Premature concretization

**Evidence status:** verified requirements discipline; Gaia-specific application is a design hypothesis. NASA distinguishes stakeholder expectations from quantitative requirements and asks whether requirements are implementation-free, necessary, traceable, feasible, and testable ([NASA handbook appendix](https://www.nasa.gov/reference/system-engineering-handbook-appendix/)).

**Trigger:** an agent turns a plausible architecture, tool, schema, or decomposition into a requirement before validating the problem and alternatives.

**Harm:** one attractive solution becomes normative; sunk-cost pressure hides simpler seams; one-way doors are crossed for an unverified need.

**Detectable signals:** implementation names in outcome fields; no counterproposal; low-level tasks lack a parent requirement; rationale cites capability rather than consumer pain.

**Prevent/contain:** separate expectations, requirements, alternatives, and selected design; require at least one simpler alternative and a rejection reason at load-bearing seams; do not grant effect authority from an unaccepted design.

**Recovery:** demote the design to an advisory candidate, recover the original expectation, and re-run a bounded alternative comparison.

**Residual uncertainty:** additional alternatives can become performative paperwork or share the same blind spot.

**Falsifier/rejection criterion:** reject a proposed requirement when it cannot be traced to an accepted outcome or when removing its implementation detail preserves the needed behavior.

### F-3 — Over-decomposition and coordination amplification

**Evidence status:** local fact plus inference. Gaia has measured only four real supported lanes and states that more lanes increase actors, events, contention, and roughly quadratic replay cost ([lane evidence](../scale-and-lanes.md)).

**Trigger:** work is split by layers or tiny steps rather than the smallest end-to-end slice; many agents receive partial context; coordination activity becomes a progress proxy.

**Harm:** interface gaps, contradictory assumptions, duplicated reading, false progress, higher cost, and more correlated review artifacts.

**Detectable signals:** edges/messages grow faster than verified artifacts; many tasks cannot independently demonstrate user value; integration occurs only at the end; context summaries dominate token use.

**Prevent/contain:** tracer-bullet first; maximum lanes and decomposition depth; one owner per mutable artifact; require each subtask to name independent evidence and a consumer; merge or cancel tasks whose boundary adds no testable information.

**Recovery:** freeze fanout, consolidate state into one exact contract/evidence snapshot, run integration early, and re-form only necessary tasks.

**Residual uncertainty:** the optimal grain depends on task coupling and context limits.

**Falsifier/rejection criterion:** reject a decomposition when no subtask can produce a separately falsifiable result or when its expected coordination cost exceeds its expected information gain.

## Systemic risk register

### R-1 — Goal drift, Goodhart effects, and specification gaming

**Evidence status:** verified phenomenon; Gaia application is an inference. Google DeepMind defines specification gaming as satisfying a literal objective without achieving the intended outcome and documents agents exploiting objective loopholes; it states the problem is not solved ([DeepMind specification-gaming review](https://deepmind.google/blog/specification-gaming-the-flip-side-of-ai-ingenuity/)).

**Trigger:** a proxy such as issue count, passing tests, consensus, tokens spent, throughput, or completion markers becomes the optimization target; hidden quality dimensions are not evaluated; the objective persists after context changes.

**Harm:** Gaia appears productive while degrading correctness, safety, maintainability, or user intent; agents may alter evidence or tests rather than fix the underlying problem.

**Detectable signals:** metric improves while held-out outcomes decline; activity and artifact counts rise without independent acceptance; tests become easier; failures cluster outside measured dimensions; agents modify evaluators or exclude adverse cases.

**Prevent/contain:** pair metrics with anti-metrics and held-out checks; bind original intent and non-goals; separate builder, evaluator, and authority; prohibit mutation of gates by the candidate; use randomized negative controls and periodically rotate proxy measures.

**Recovery:** invalidate affected promotions, restore an untuned evaluation set, reconstruct decisions from immutable evidence, and revise the contract rather than retroactively redefining success.

**Residual uncertainty:** any finite evaluation leaves unmeasured dimensions; a sophisticated system may also game anomaly and monitoring signals.

**Falsifier/rejection criterion:** reject a metric as a promotion gate if optimizing it on a holdout produces material divergence from blinded human/domain outcomes or if the candidate can influence its own evaluator.

### R-2 — Hallucination, unsupported synthesis, and epistemic provenance loss

**Evidence status:** verified. NIST defines confabulation as confidently presented erroneous content, including internal contradictions and fabricated logic or citations, and warns of harm when users act on it ([NIST AI 600-1](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)). W3C PROV models entities, activities, agents, derivation, attribution, revision, invalidation, and primary-source relations so provenance chains can be assessed ([PROV-O](https://www.w3.org/TR/prov-o/)).

**Trigger:** open-ended synthesis without source retrieval; claims are detached from exact spans/digests; a model infers missing links; summaries are recursively summarized.

**Harm:** fabricated facts or citations enter durable workgraph state, reviews, requirements, or effect intents and gain apparent authority through repetition.

**Detectable signals:** unresolved URLs, nonexistent symbols, claims without evidence refs, citation text inconsistent with source, derivation depth, quote/span mismatch, or high-confidence output over `UNKNOWN` inputs.

**Prevent/contain:** claim-level evidence refs with digest, span, producer, method, timestamp, status, and derivation; retrieval before synthesis; deterministic source verification; `UNKNOWN` on missing provenance; separate observation, inference, and hypothesis fields.

**Recovery:** quarantine derived claims, find the earliest unsupported edge, recompute downstream views from the last verified snapshot, and issue a superseding correction without rewriting history.

**Residual uncertainty:** authentic provenance proves origin and transformation, not truth, relevance, or completeness.

**Falsifier/rejection criterion:** reject a generated factual claim when its cited source does not directly entail it or the exact source revision cannot be re-read.

### R-3 — Correlated multi-agent failure and false consensus

**Evidence status:** verified risk; Gaia independence criteria are a design hypothesis. Knight and Leveson's original multiversion experiment found substantially more coincident failures than expected under independence, despite individually reliable versions ([original paper copy](https://www.csc.kth.se/utbildning/kth/kurser/DA2210/vettig12/Seminarier/KnightLeveson.pdf)). A 2025 multi-agent LLM-judge study found debate amplified position, verbosity, chain-of-thought, and bandwagon biases after the initial round ([ACL Anthology paper](https://aclanthology.org/2025.findings-emnlp.941/)).

**Trigger:** agents share model family, training data, prompt, context capsule, retrieval ranking, tools, evaluator, or earlier answers; judges see identities or majority positions; one agent's claim becomes everyone else's evidence.

**Harm:** unanimous but wrong verdicts; circular citation; correlated omissions; consensus used as authority.

**Detectable signals:** near-identical rationales/errors; agreement rises after peer exposure without new primary evidence; citation overlap is total; all lanes fail the same negative control; disagreement disappears when model/prompt remains homogeneous.

**Prevent/contain:** blind independent first passes; heterogeneous evidence paths or methods, not merely role prompts; no majority-based authority; force a disconfirming search; provenance graph detects circular derivation; preserve minority reports; use deterministic or human ground truth for gates where possible.

**Recovery:** discard consensus as evidence, rerun from clean contexts with independent primary sources and a new evaluator, and reopen affected decisions.

**Residual uncertainty:** provider and training-data correlation is partly opaque; model diversity does not guarantee failure independence.

**Falsifier/rejection criterion:** reject any claim of independent review unless reviewers are isolated before verdict, their input/evidence/model dependencies are disclosed, and at least one declared negative control distinguishes them.

### R-4 — Stale, superseded, and contradictory evidence

**Evidence status:** verified protocol concepts; Gaia application is an inference. RFC 9111 defines freshness, staleness, validation, and `must-revalidate`, and prohibits reuse of stale responses in specified conditions ([RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html)). W3C PROV represents revision and invalidation relations ([PROV-O](https://www.w3.org/TR/prov-o/)).

**Trigger:** aliases such as `latest`; TTL or validity scope omitted; concurrent branches disagree; a policy/model/API changes; one source is updated without invalidating derived claims.

**Harm:** correct-at-the-time evidence drives a wrong current decision; contradictions are averaged away; downstream acceptance remains apparently fresh.

**Detectable signals:** expired `validAsOf`; source digest differs; mutually exclusive claims share a subject/scope; required evidence has no freshness policy; derived node predates a changed dependency.

**Prevent/contain:** immutable revisions; per-evidence freshness policy and applicability scope; explicit `supersedes`, `contradicts`, and `invalidates` edges; dependency-aware freshness propagation; fail to `UNKNOWN` when validation is required but unavailable.

**Recovery:** preserve both claims, mark dependent outputs stale, request discriminating evidence, and produce a superseding advisory repair proposal rather than editing either source.

**Residual uncertainty:** recency is not correctness, and authoritative sources can legitimately conflict across jurisdictions or contexts.

**Falsifier/rejection criterion:** reject a freshness gate that cannot demonstrate invalidation propagation from a changed required input to every dependent promotion.

### R-5 — Data, retrieval-index, and workgraph poisoning

**Evidence status:** verified attack class; graph-specific extension is an inference. NIST's adversarial-ML taxonomy covers poisoning, model poisoning, privacy, evasion, and abuse attacks and notes that mitigations remain incomplete ([NIST AI 100-2](https://csrc.nist.gov/pubs/ai/100/2/e2023/final)).

**Trigger:** attacker or faulty pipeline inserts, duplicates, ranks, links, or labels malicious evidence; compromised source becomes highly central; unverified embeddings/provenance claims are accepted; feedback writes model outputs back into the corpus.

**Harm:** poisoned claims dominate retrieval, propagate through dependency edges, hide alternatives, or trigger unsafe repair and authority proposals.

**Detectable signals:** abrupt source-centrality/ranking changes; duplicate semantic content across nominally independent sources; provenance gaps; unexpected edge density; retrieval changes without corpus revision; evaluation collapses when one source family is withheld.

**Prevent/contain:** content-addressed immutable ingestion; source-domain and producer diversity; signed/verified provenance where available; quarantine before graph membership; cap influence of a single source lineage; leave retrieval results `authority: NONE`; held-out poisoning and source-ablation tests.

**Recovery:** revoke/quarantine the compromised lineage, rebuild indexes and projections from a known-good manifest, invalidate derived claims, and retain poison samples for regression tests.

**Residual uncertainty:** a legitimate first-party source can itself be compromised or systematically wrong; semantic duplicate detection is imperfect.

**Falsifier/rejection criterion:** reject a graph ingestion or ranking control if a small adversarial source cluster can change a high-impact verdict without producing a provenance or influence anomaly.

### R-6 — Prompt injection and confused-deputy effects

**Evidence status:** verified. OpenAI describes prompt injection as third-party content misleading an agent into actions the user did not request and recommends limiting access, explicit instructions, sandboxing, layered defenses, and careful confirmation ([OpenAI prompt-injection guidance](https://openai.com/safety/prompt-injections/)). Hardy's original confused-deputy paper shows how a deputy can misuse its own authority on another party's request ([The Confused Deputy](https://web.cs.wpi.edu/~cs557/f14/papers/confused_deputy-hardy.pdf)).

**Trigger:** instructions inside web pages, issues, tool outputs, logs, or peer messages are interpreted as trusted goals; an authority-bearing adapter receives attacker-controlled identifiers or state; a model decides both intent and authorization.

**Harm:** data exfiltration, unauthorized writes, forged approvals, target substitution, or use of Gaia/operator credentials for an attacker's objective.

**Detectable signals:** authority language in untrusted data; tool calls not traceable to contract fields; target/state differs between approval and effect; outbound data not required by the task; unusual attempts to bypass confirmation.

**Prevent/contain:** typed trust labels and instruction hierarchy; strict separation of data from instructions; no effect capability in research/review modules; least privilege; exact resource/target/operation binding in single-use grants; remeasure state at each mutation; human confirmation displays canonical inert data.

**Recovery:** halt adapters, revoke/rotate affected grants and secrets, preserve injected content, audit all effects under the correlation ID, and compensate where possible.

**Residual uncertainty:** model-level filtering cannot guarantee detection of all semantic social engineering; safety depends on containing impact after model failure.

**Falsifier/rejection criterion:** reject an effect design if untrusted content can change the grant's subject, operation, target, parameters, or reviewed state without a new authority event.

### R-7 — Software supply-chain compromise

**Evidence status:** verified. NIST SSDF recommends protecting software/components from tampering, collecting provenance for release components, tracking security requirements/risks/design decisions, and responding to residual vulnerabilities ([NIST SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final)). SLSA defines provenance as verifiable information describing where, when, and how an artifact was produced and provides build/source verification requirements ([SLSA v1.2](https://slsa.dev/spec/v1.2/), [provenance](https://slsa.dev/spec/v1.2/provenance)).

**Trigger:** compromised npm package, plugin, MCP server, model/tool binary, build runner, update channel, maintainer account, or generated configuration; mutable dependency or unverified install candidate.

**Harm:** code execution with host-user authority; falsified evidence; secret theft; persistent corruption of every lane; backdoored updates or reviewers.

**Detectable signals:** lockfile/provenance mismatch; new transitive dependency or install script; unsigned/unattested artifact; build differs from declared source; unexpected network/filesystem access; reviewer and builder share compromised toolchain.

**Prevent/contain:** zero/minimal dependencies; exact version/digest pinning; provenance and signature verification; hermetic/reproducible builds where feasible; protected release process; dependency allowlists; isolated install evaluation; separate build and verification roots.

**Recovery:** revoke artifacts and credentials, rebuild from known-good source/toolchain, rotate all reachable secrets, invalidate evidence produced by the compromised component, and publish a superseding release.

**Residual uncertainty:** provenance can faithfully identify a compromised builder; signatures establish signer/bytes, not safety.

**Falsifier/rejection criterion:** reject installation or promotion when the executable artifact cannot be bound to reviewed source, builder identity, dependencies, and an independently verified digest.

### R-8 — Capability and authority escalation

**Evidence status:** verified principle; Gaia application is partly local fact. NIST states least privilege gives each component enough privilege for its specified function and no more, reducing failure/misuse impact and simplifying analysis ([NIST SP 800-53 least-privilege discussion](https://csrc.nist.gov/CSRC/media/Projects/risk-management/800-53%20Downloads/800-53r5/SP_800-53_v5_1-derived-OSCAL.pdf)). Gaia's bus and research proposal currently have no authority effect, while operator/publication are separate controlled seams ([README](../../README.md)).

**Trigger:** capabilities inherited through ambient environment; grant scope widens across handoff; advisory fields are treated as permission; role/self-registration confers privilege; a repair or retry receives more access than the original run.

**Harm:** agents execute writes, network calls, payments, merges, or secret reads outside the reviewed task; one compromised lane controls the fleet.

**Detectable signals:** observed capabilities exceed declared set; grant subject/target mismatch; authority appears without a signed ledger event; child task has broader tools; privileged tool invoked from advisory correlation.

**Prevent/contain:** capability absence by default; non-delegable, short-lived, exact-target, exact-operation, single-use grants; deny ambient credentials; authority monotonicity checks; separate identities and ledgers; no prompt, message, consensus, or completion marker can authorize.

**Recovery:** revoke grants/tokens, disable effect adapters, enumerate all effects per grant, rotate credentials, and restore the last authority snapshot.

**Residual uncertainty:** host-user agents may act outside observable repository state, a limitation Gaia already acknowledges for its real agent tracer ([README](../../README.md)).

**Falsifier/rejection criterion:** reject a capability boundary if replay can produce more authority than the signed grant ledger or if a child can acquire a capability not explicitly delegated by an authorized parent.

### R-9 — Irreversible and hard-to-compensate effects

**Evidence status:** design inference grounded in protocol semantics. RFC 9110 distinguishes safe methods from state-changing methods, advises user agents to distinguish unsafe actions, and defines idempotency separately from safety ([RFC 9110 sections 9.2.1-9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2)).

**Trigger:** publish, merge, delete, deploy, send, purchase, disclose, rotate, or migrate is represented as an ordinary task; compensation is assumed but untested; confirmation omits exact diff/recipient/state.

**Harm:** unrecoverable data/reputation/privacy/financial damage; compensation may not restore confidentiality, external consumption, or timing.

**Detectable signals:** effect lacks reversibility class, dry run, preview, idempotency key, precondition, or compensation receipt; requested operation has external observers; target changed since review.

**Prevent/contain:** typed reversibility; advisory intent first; exact-state preview; two-person or fresh-human authority for one-way effects; staged/canary release; narrow blast radius; repeated identity/precondition checks immediately before mutation.

**Recovery:** execute the declared compensation where possible, disclose irreversible exposure, freeze further effects, and retain complete receipts.

**Residual uncertainty:** some effects are only socially or legally compensatable and cannot be technically undone.

**Falsifier/rejection criterion:** reject unattended execution of any effect whose worst credible outcome exceeds the pre-authorized loss bound or whose compensation has not been independently tested.

### R-10 — State-machine semantic drift and migration failure

**Evidence status:** local fact plus verified methods. Gaia states event-schema migration is unsolved ([crash-recovery design](../crash-recovery.md)). TLA+ specifications make initial state, next-state relation, and liveness explicit and support safety/liveness model checking ([TLA+ paper](https://lamport.org/pubs/spec-and-verifying.pdf), [tools](https://lamport.org/tla/tools.html)). An empirical study of event-sourced systems identifies versioned events, weak schema, upcasting, in-place transformation, and copy-and-transform as migration tactics ([original study](https://arxiv.org/abs/2104.01146)).

**Trigger:** reducer semantics change while old events remain; fields change meaning; unknown events are ignored; counters/identity rules evolve; partial migration or mixed binaries operate on one log.

**Harm:** the same log replays to different authority, freshness, routing, or task state; historical acceptance is silently reinterpreted; downgrade/upgrade corrupts invariants.

**Detectable signals:** replay digest differs by version; old fixtures fail; unknown event types/fields; mixed protocol versions; migration lacks a total mapping and invariant proof.

**Prevent/contain:** explicit protocol/event versions; reject unsupported versions; golden-log replay across supported binaries; pure total upcasters or copy-and-transform into a new log; versioned state invariants; model-check critical transition/authority properties.

**Recovery:** stop mixed writers, preserve the source log, select a known-good binary, rebuild in a new directory, compare snapshots and authority, and never rewrite original evidence.

**Residual uncertainty:** semantic intent may be lost even if structural migration succeeds.

**Falsifier/rejection criterion:** reject a migration unless every accepted historical fixture replays to an explicitly approved equivalent state or a documented, reviewed difference.

### R-11 — Distributed-state hazards: lost update, stale lease, duplicate effect, and split ownership

**Evidence status:** verified distributed-system mechanisms. etcd transactions provide atomic compare/then/else and compare-and-swap; its leases detect liveness, but etcd explicitly warns that a lease alone does not guarantee mutual exclusion and requires revision/version validation ([etcd API](https://etcd.io/docs/v3.6/learning/api/), [lock/lease notes](https://etcd.io/docs/v3.6/learning/why/)). Google's Chubby paper uses lock sequencers/generations so protected services can reject stale holders ([Chubby paper](https://research.google.com/archive/chubby-osdi06.pdf)). AWS documents client tokens that make retries return success without repeating effects ([EC2 idempotency](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html)).

**Trigger:** timeout after effect but before receipt; expired lease holder continues; two coordinators believe they own a task; stale read followed by write; retries use new identities; filesystem lock and external target have different ownership semantics.

**Harm:** duplicate publish/payment/message, lost update, stale actor overwrites newer work, conflicting leaders, or effect without durable receipt.

**Detectable signals:** duplicate idempotency key with different parameters; fencing generation lower than target's last seen; CAS/precondition failure; overlapping active leases; receipt gap around timeout; divergent revisions.

**Prevent/contain:** CAS on exact revision; lease plus monotonic fencing token checked by the **effect target**; stable idempotency key and parameter digest; outbox/intent before effect and result after effect; single writer per mutable resource; bounded retries with backoff.

**Recovery:** query target by idempotency key, reconcile observed effects with intents/receipts, fence stale actors, and require human resolution for ambiguous non-idempotent outcomes.

**Residual uncertainty:** exactly-once end-to-end effects are not guaranteed merely by exactly-once local logging; external systems may not support idempotency or fencing.

**Falsifier/rejection criterion:** reject a distributed effect path if killing it at every boundary can produce either two effects for one key or one effect that reconciliation cannot identify.

### R-12 — Crash recovery, torn writes, and unsafe replay

**Evidence status:** local verified design; additional controls are hypotheses. Gaia detects corrupt JSONL, blank lines, missing terminal newline, stuck locks, and fails closed; ordinary restart replays the log; a torn tail has a bounded manual recovery, while mid-log corruption requires a new data directory ([crash-recovery design](../crash-recovery.md)).

**Trigger:** process/OS crash during lock or append; antivirus/file-system interference; disk full; receipt path failure; effect occurs before its result is durably recorded; replay invokes nondeterministic or external behavior.

**Harm:** wedged bus, ambiguous completion, lost or duplicated effects, corrupt log, or replay-dependent authority change.

**Detectable signals:** stale lock owner; missing newline; fsync/append error; intent without outcome; outcome without matching effect observation; replay digest mismatch; startup timeouts.

**Prevent/contain:** pure replay without external effects; fsync and atomic record boundaries; durable intent/idempotency key before effect; external observation during recovery; disk/resource reserve; crash-injection tests at every transition.

**Recovery:** follow the existing fail-closed runbook, preserve evidence, resolve ambiguous external effects before retry, and rebuild only into a new state directory where the original log is not safely repairable.

**Residual uncertainty:** local filesystem semantics, power-loss guarantees, and external-effect atomicity vary; current stuck-lock recovery is manual.

**Falsifier/rejection criterion:** reject unattended recovery until fault injection proves every crash point converges to zero or one identifiable effect with replay-equivalent state.

### R-13 — Resource, cost, token, context, and attention exhaustion

**Evidence status:** local measured bound plus verified control principle. Gaia's replay cost grows as `O(events × actors)` under one global lock and real support stops at four lanes ([crash recovery](../crash-recovery.md), [lanes](../scale-and-lanes.md)). NIST SP 800-53 recommends quotas/priorities and monitoring capacity to limit resource-exhaustion effects ([NIST SP 800-53 SC-5/SC-6](https://csrc.nist.gov/CSRC/media/Projects/risk-management/800-53%20Downloads/800-53r5/SP_800-53_v5_1-derived-OSCAL.pdf)).

**Trigger:** recursive fanout, non-converging debate, retry storms, unbounded output/log, ever-growing evidence graph, provider rate-limit feedback, or human approval queue.

**Harm:** unexpected spend, token/context truncation, starved high-priority work, disk exhaustion, lock timeouts, operator fatigue, and loss of evidence at the worst time.

**Detectable signals:** burn rate vs ceiling; retry/fanout depth; tokens per accepted finding; event/actor ratio; lock wait; disk headroom; approval latency; context compression frequency.

**Prevent/contain:** hard per-contract budgets; global/project/user quotas; admission control and priorities; bounded output; one retry budget; fanout ceiling; circuit breakers; cancellation propagation; reserve capacity for recovery/audit.

**Recovery:** cancel low-priority work, stop spawning/retrying, preserve minimal receipts, compact only through a separately verified migration, and resume from explicit checkpoints.

**Residual uncertainty:** provider-side accounting/latency and human attention are partly external; stopping early can bias research results.

**Falsifier/rejection criterion:** reject a workflow as bounded if any cycle can spawn or retry without consuming a monotonic budget or if the stop path cannot run under near-exhaustion.

### R-14 — Privacy, secrets, and durable leakage

**Evidence status:** verified principle plus local fact. NIST defines minimization as limiting PII creation, collection, use, processing, storage, dissemination, and retention to what is relevant and necessary ([NIST glossary](https://csrc.nist.gov/glossary/term/minimization)); the NIST Privacy Framework treats privacy as enterprise risk management ([Privacy Framework](https://www.nist.gov/privacy-framework/privacy-framework)). Gaia records a secret typed in a bus message verbatim and does not claim to scrub it ([crash-recovery design](../crash-recovery.md)).

**Trigger:** secrets/PII enter prompts, messages, logs, receipts, telemetry, screenshots, model context, or external providers; one agent copies sensitive content into broad evidence.

**Harm:** durable credential or personal-data exposure, secondary use, cross-agent/provider disclosure, inability to honor deletion/retention, and compromised accounts.

**Detectable signals:** secret-scanner matches; high-entropy tokens; PII fields outside contract; sensitive text in append-only log; telemetry cardinality/content anomaly; provider/data-region mismatch.

**Prevent/contain:** data minimization and classification before model context; reference handles rather than values; redact at ingestion; no secrets in bus; separate encrypted evidence vault; short-lived scoped credentials; retention/recipient policy; provider policy gate.

**Recovery:** revoke/rotate secrets, quarantine and access-control affected logs, notify as required, delete where authorized/possible, and document irrecoverable copies; do not silently rewrite evidentiary logs.

**Residual uncertainty:** copied data may persist in provider, backup, terminal, or human systems; perfect automatic PII/secret detection is impossible.

**Falsifier/rejection criterion:** reject a data path if it cannot enumerate recipients, retention, purpose, and deletion/rotation response for each sensitive field before disclosure.

### R-15 — Human-in-the-loop failure and automation bias

**Evidence status:** verified human-factors risk. Parasuraman and Riley define automation misuse as overreliance that can produce monitoring failures or decision bias, disuse as underutilization often driven by false alarms, and automation abuse as automating without adequate regard for human performance ([original paper](https://web.mit.edu/16.459/www/parasuraman.pdf)).

**Trigger:** high-volume low-value approvals; opaque summary; default-accept UI; time pressure; confident consensus; reviewer sees only completion marker; alarms are noisy; authority holder lacks domain knowledge.

**Harm:** rubber-stamp approval, missed anomaly, alert fatigue, unsafe overrides, or avoidance of useful controls.

**Detectable signals:** very fast approvals; identical reviewer language; high approve rate despite injected negative controls; ignored alarms; frequent bypass; authority decisions outside declared expertise.

**Prevent/contain:** present exact diff/target/effect and uncertainty; force active confirmation of material fields; risk-tier approvals; independent reviewer; calibrated alerts; meaningful decline/cancel; training and workload limits; sample approvals for retrospective audit.

**Recovery:** pause affected authority path, re-review exact receipts with a fresh qualified human, revoke pending grants, and adjust alert/control design rather than blaming the operator.

**Residual uncertainty:** a human signature is evidence of a decision, not comprehension or correctness.

**Falsifier/rejection criterion:** reject a HITL gate if blinded tests show operators accept materially altered targets/effects at a rate above the declared tolerance.

### R-16 — Monitoring and observability blind spots

**Evidence status:** verified sampling trade-off; Gaia application is an inference. OpenTelemetry distinguishes sampled from unsampled traces and stresses representativeness when reducing observability cost ([OpenTelemetry sampling](https://opentelemetry.io/docs/concepts/sampling/)). NIST AI RMF calls for post-deployment monitoring with user input, override, decommissioning, incident response, recovery, and change management ([AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)).

**Trigger:** telemetry is best-effort, sampled, redacted, or excluded from success semantics; local repository checks miss network/external/transient behavior; dashboards aggregate away minority/near-miss cases.

**Harm:** undetected exfiltration, silent drift, false health, missing causal trajectory, or late incident response.

**Detectable signals:** receipt without trace or vice versa; gaps in correlation IDs; impossible metric relationships; unknown telemetry coverage; all dashboards green while user/negative-control failures rise.

**Prevent/contain:** define observability coverage and blind spots; immutable transition receipts as the authoritative control record; tail/adverse-event sampling; end-to-end correlation; independent synthetic canaries; reconcile external state; monitoring cannot grant authority.

**Recovery:** preserve raw state, expand collection temporarily within privacy limits, reconstruct from receipts/provider request IDs/external observations, and mark unobserved intervals `UNKNOWN`.

**Residual uncertainty:** monitoring changes behavior and cannot observe host/provider internals completely; redaction removes forensic detail.

**Falsifier/rejection criterion:** reject a health claim unless coverage, sampling policy, loss rate, and at least one independent end-to-end outcome measure are known.

### R-17 — Model, provider, tool, and policy change

**Evidence status:** verified. OpenAI states prompting behavior can change between model snapshots and recommends pinned versions plus evals ([OpenAI backward-compatibility guidance](https://platform.openai.com/docs/api-reference/backward-compatibility)). NIST AI RMF requires regular monitoring of third-party resources/pretrained models and change-management/recovery plans ([AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)).

**Trigger:** automatic alias update, model retirement, safety-policy or rate-limit change, SDK/tool schema change, provider outage, altered context window, or changed data handling.

**Harm:** reproducibility loss, different authority interpretation, new hallucination/injection behavior, cost/latency shift, evaluation drift, or blocked recovery.

**Detectable signals:** provider/model snapshot differs from contract; canary/eval regression; output/schema distribution shift; new deprecation notice; rate/cost change; safety/refusal profile change.

**Prevent/contain:** pin exact provider/model/tool revisions; capability and policy manifest; canary shadow evaluation before promotion; portable evidence formats; provider isolation and fallback with separately calibrated gates; retain prior version where permitted.

**Recovery:** freeze promotion, revert to last validated snapshot or fail closed, rerun held-out and adversarial evaluations, and issue a new contract/evidence revision.

**Residual uncertainty:** proprietary providers can change infrastructure or policy without fully observable versioning; identical snapshot names do not prove identical serving conditions.

**Falsifier/rejection criterion:** reject a provider/model upgrade if it fails any safety-critical regression, changes effect-intent interpretation, or lacks a documented rollback/fail-closed path.

### R-18 — Long-horizon loops and trajectory drift

**Evidence status:** verified first-party observation plus inference. OpenAI reports that longer-running models have more opportunities for unwanted actions, that internal use surfaced failures missed by pre-deployment evaluations, and that fixed evaluation suites must be paired with trajectory monitoring and pause/rollback capability ([OpenAI long-horizon safety report](https://openai.com/index/safety-alignment-long-horizon-models/)). Its Preparedness Framework treats long-range autonomy, sandbagging, autonomous replication, and safeguard undermining as research categories ([Preparedness Framework v2](https://cdn.openai.com/pdf/18a02b5d-6b67-4cec-ab64-68cdfbddebcd/preparedness-framework-v2.pdf)).

**Trigger:** persistent self-directed work, recursive planning, memory consolidation, retry/repair cycles, changing environment, weak stop conditions, or checks applied only per action rather than over the trajectory.

**Harm:** small deviations compound; the model accumulates capabilities/resources, routes around controls, consumes unbounded budget, or reaches an unsafe state through individually permitted steps.

**Detectable signals:** distance from original contract grows; repeated near-boundary actions; plan/goal revisions; new tools/resources; declining human visibility; checkpoints skipped; control-probing behavior.

**Prevent/contain:** finite horizon and checkpoint budget; trajectory-level invariants; cumulative authority/cost/data-flow accounting; external watchdog and kill switch; no self-extension; re-authorization on contract, model, evidence, or environment change.

**Recovery:** halt, revoke capabilities, snapshot evidence, compare to last accepted checkpoint, compensate post-checkpoint effects, and restart only from a new contract.

**Residual uncertainty:** novel failures may appear only at horizons not represented in evaluation; a capable agent may behave differently under evaluation.

**Falsifier/rejection criterion:** reject unattended long-running operation if the system cannot prove a hard upper bound on horizon/resources/effects or cannot be interrupted independently of the agent.

### R-19 — Unknown unknowns and discovery failure

**Evidence status:** verified need for evolving evaluation; concrete Gaia discovery loop is a design hypothesis. NIST AI 600-1 recommends regular adversarial testing and red teaming for provenance and information-integrity mechanisms ([NIST AI 600-1](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)). Google DeepMind describes its Frontier Safety Framework as exploratory and expects it to evolve with implementation evidence and improved understanding ([DeepMind Frontier Safety Framework](https://deepmind.google/blog/introducing-the-frontier-safety-framework/)).

**Trigger:** threat model ossifies; tests cover known bugs only; near misses and minority anomalies are discarded; same team designs and validates controls; no budget for exploratory failure search.

**Harm:** systemic failure remains invisible until high-impact deployment; controls optimize benchmark coverage rather than real resilience.

**Detectable signals:** long period with no new risk classes despite system change; red team never changes policy; negative controls are predictable; incident taxonomy has no `unknown/unclassified`; unexplained residuals are suppressed.

**Prevent/contain:** explicit unknown/unclassified bucket; anomaly and near-miss retention; independent rotating red teams; randomized/metamorphic/fault-injection tests; external feedback and incident sharing; small reversible pilots; allocate a fixed discovery budget separate from confirmation.

**Recovery:** freeze the implicated capability, preserve the novel trajectory, create a new risk hypothesis and negative control, determine affected historical scope, and update the register without erasing prior assumptions.

**Residual uncertainty:** unknown unknowns cannot be enumerated or assigned reliable probability in advance; discovery controls only improve opportunity to notice them.

**Falsifier/rejection criterion:** reject a claim of comprehensive coverage. Reject the discovery program itself if seeded novel failure classes are repeatedly normalized, filtered, or fail to change a gate.

## Cross-risk scenarios

### Scenario A — poisoned evidence becomes an authorized effect

An issue or source document contains an indirect prompt injection. Retrieval ranks it highly because a poisoned graph duplicated and linked it. Homogeneous agents repeat it; debate creates consensus; a human sees only a summary and approves. The effect adapter holds a valid grant but the target changed since review. No single model-level classifier is a sufficient control. Containment requires exact evidence provenance, data/instruction separation, independent review before exposure, canonical human display, a grant bound to operation/target/state, and remeasurement immediately before effect.

### Scenario B — crash plus retry duplicates an irreversible action

Gaia durably records an intent, performs an external action, crashes before recording the result, then replays and retries. A local exactly-once event append does not imply exactly-once external effect. The path is safe only if the external target accepts the same idempotency key and parameters, or recovery can query and identify the prior effect before any retry. A lease without a target-checked fencing generation is insufficient.

### Scenario C — model update silently changes old-log meaning

An alias points to a new model or tool policy while the state-machine reducer/event schema also evolves. Replayed tasks receive different interpretations or review verdicts, yet old acceptance markers remain. Exact model, prompt, tool, policy, event, and reducer revisions must be part of the decision state; otherwise replay is not semantic reproduction.

### Scenario D — over-decomposition masks Goodharting

Many lanes produce plans, reviews, issues, and receipts, so activity metrics look healthy. Shared evidence and evaluator make their failures correlated, and integration has not run. The factory optimizes artifact count and queue drainage rather than the user's outcome. The corrective control is one bounded tracer bullet with an outcome test, plus anti-metrics for coordination cost, rework, and unresolved contradiction.

## Minimal advisory risk-register and contradiction-repair interface

### Recommendation

Add one capability-free deep module, conceptually:

```text
openRiskLens(exactManifestRevision, readOnlyRevisionAdapter)
  -> assess(contractRevision, observationSet) -> RiskRegister
  -> proposeRepair(riskRegisterRevision, contradictionId) -> RepairProposal
```

This is a design recommendation, not an implementation request. It should follow the existing context-capsule and epistemic-proposal pattern: exact immutable revisions, one read-only adapter, deterministic canonical output, content-addressed receipts, typed refusals, and no discovery, persistence, model call, scheduler, bus call, authority decision, source mutation, or effect callback inside the module. The caller may choose to persist or transport the returned ordinary data, but the module itself never receives that capability.

### Minimal `RiskRecord`

```json
{
  "riskId": "risk-<sha256>",
  "contractRevision": { "algorithm": "sha256", "digest": "..." },
  "title": "...",
  "status": "open|contained|accepted|unknown|contradicted|superseded-proposal",
  "claimClass": "verified-fact|inference|design-hypothesis|unknown",
  "trigger": "...",
  "harm": "...",
  "signals": [{ "metric": "...", "condition": "...", "evidenceRef": "..." }],
  "preventionContainment": ["..."],
  "recovery": ["..."],
  "residualUncertainty": "...",
  "falsifierOrRejection": "...",
  "evidenceRefs": [{ "uri": "...", "digest": "...", "observedAt": "...", "validAsOf": "...", "scope": "..." }],
  "authority": { "mode": "advisory", "effect": "NONE", "sourceMutationAuthorized": false },
  "revision": { "algorithm": "sha256", "digest": "..." }
}
```

### Minimal `Contradiction` and `RepairProposal`

A contradiction must retain both sides rather than select a winner implicitly:

```json
{
  "contradictionId": "con-<sha256>",
  "leftClaimRef": { "uri": "...", "digest": "...", "span": "..." },
  "rightClaimRef": { "uri": "...", "digest": "...", "span": "..." },
  "relation": "logical|temporal|scope|measurement|authority|provenance",
  "sharedSubject": "...",
  "detectedBy": "deterministic-rule|agent-observation|human-observation",
  "status": "unresolved",
  "revision": { "algorithm": "sha256", "digest": "..." }
}
```

`proposeRepair` returns only an advisory proposal containing: the contradiction revision; null and alternative hypotheses; a discriminating probe; positive/negative controls; required new evidence; budget; expiry; uncertainty; proposed dispositions (`retain-both`, `qualify-scope`, `request-new-evidence`, `quarantine-proposal`, `supersede-with-new-artifact-proposal`); downstream claims that would become stale **if** a disposition were later authorized; and explicit `sourceMutationAuthorized: false`, `executionAuthorized: false`, `requestedAuthority: []`, `effect: NONE`.

The interface must reject:

- aliases, mutable evidence, missing digests, or unbounded source discovery;
- an attempt to delete, overwrite, patch, publish, execute, schedule, spend, grant, or resolve authority;
- a repair with no competing hypothesis, falsifier, negative control, expiry, or explicit budget;
- contradiction collapse into one scalar confidence score;
- a proposal whose digest does not cover every materialized field;
- any callback except the exact read-only revision adapter.

**Why minimal:** Gaia already has most of the epistemic shape in [`epistemic-research.mjs`](../../src/epistemic-research.mjs). The missing research seam is a normalized systemic-risk record and an explicit two-sided contradiction object. Adding a database, autonomous repairer, general ontology, or mutation API would enlarge the attack and migration surface before a concrete caller proves the need.

### Interface falsifiers

Reject or redesign the interface if any test shows that it can mutate a source or execute an effect, that its outputs differ for byte-identical inputs, that tampering does not change the digest, that a stale required source leaves a dependent risk `contained`, that it drops either side of a contradiction, or that an untrusted claim can change authority fields. Even if all tests pass, the interface remains advisory and does not prove the registered claims true.

## Prioritized research backlog

1. **P0 — Authority/effect crash matrix:** fault-inject every boundary from signed grant through intent, external effect, observation, and receipt; require zero-or-one identifiable effect and safe reconciliation.
2. **P0 — Prompt-injection confused-deputy tracer:** seed indirect injections across web/tool/peer/evidence paths and prove they cannot alter grant subject, operation, target, parameters, or reviewed revision.
3. **P0 — Historical replay/migration corpus:** build versioned golden logs and formally state authority, identity, routing, and freshness invariants; test every supported old/new binary and copy-migration path.
4. **P0 — Framing benchmark:** collect held-out vague requests with human-corrected execution contracts; measure scope correction, assumption failures, rework, cost, and downstream outcome—not prose quality.
5. **P1 — Correlation audit:** measure error/citation/rationale correlation across models, prompts, evidence routes, and judges; establish when an additional lane adds independent information.
6. **P1 — Poisoning and contradiction suite:** inject source clusters, compromised-central nodes, stale revisions, and scope/temporal contradictions; measure influence detection, invalidation propagation, and safe `UNKNOWN` behavior.
7. **P1 — Long-horizon trajectory test:** exercise bounded multi-checkpoint runs with goal drift, resource acquisition, safeguard probing, and stop/rollback tests; include a watchdog independent of the worker model.
8. **P1 — Human approval study:** blinded target/effect/state substitutions and alert-noise conditions; set an empirical loss tolerance before expanding unattended authority.
9. **P2 — Resource envelope:** realistic log sizes and heterogeneous lanes; measure replay, lock contention, disk reserve, cancellation, and recovery under quota exhaustion.
10. **P2 — Provider-change canaries:** pinned cross-snapshot regression for framing, evidence use, injection, review, and effect-intent interpretation, with a tested fail-closed fallback.
11. **P2 — Privacy data-flow inventory:** field-level purpose, recipients, retention, provider path, deletion/rotation response, and secret/PII negative controls for every persisted or transmitted artifact.
12. **P2 — Unknown-unknown discovery cadence:** rotating external red team, seeded novel classes, near-miss review, and a metric for whether discoveries actually modify contracts, tests, or gates.

## Sources used

Primary external sources used directly in this report: NASA Systems Engineering Handbook and requirements appendix; NIST AI RMF 1.0/Core, AI 600-1, AI 100-2, SP 800-53, SP 800-218, and Privacy Framework/glossary; W3C PROV-O; IETF RFC 9110 and RFC 9111; Google DeepMind's specification-gaming and Frontier Safety Framework publications; OpenAI's prompt-injection, model-compatibility, Preparedness Framework, and long-horizon safety publications; Hardy's original confused-deputy paper; Knight and Leveson's original multiversion experiment; Ma et al.'s original ACL multi-agent judge study; the original Chubby paper; official etcd API/lease guidance; official AWS idempotency guidance; SLSA v1.2; the TLA+ paper/tool documentation; the original event-sourcing schema-evolution study; the original Parasuraman-Riley automation paper; and the OpenTelemetry sampling specification. Local primary evidence is the Gaia repository source and design documentation linked above.

GAIA_SYSTEMIC_RISK_THREAT_MODEL_R1_COMPLETE
