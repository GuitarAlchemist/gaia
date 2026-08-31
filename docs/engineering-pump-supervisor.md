# Engineering pump supervisor

Issue: [#40](https://github.com/GuitarAlchemist/gaia/issues/40)

## Outcome

Build one deterministic reconciler that keeps Gaia's existing pumps supplied with bounded work:

`observe -> derive gate -> choose one next action -> persist intent -> execute -> reconcile -> refill`

The supervisor coordinates existing components. It is not a provider runner, scheduler, database
authority, merge authority, or new privileged bus.

## R0 tracer bullet

R0 closes one end-to-end transition: when verified ready work exists, no Draft PR represents it,
capacity is available, and no conflicting writer owns the target, the supervisor emits exactly one
durable `START_DRAFT` intent. The injected effect executor may create the Draft PR; the next
observation reconciles the provider receipt before any retry.

The first public contract will expose:

- an evidence-bound observation;
- a closed gate and exactly one next action;
- composition over the existing portfolio-drain claim ledger and first-evidence Draft delivery journal;
- a concise managed checklist projection;
- a deterministic DuckDB projection of the same transitions.

The supervisor does not introduce a third intent/receipt machine. The portfolio-drain ledger is the
authoritative exclusive capacity and target reservation. `planFirstEvidenceDraftPr` and the existing
first-evidence delivery journal remain authoritative for `OPEN_DRAFT_PULL_REQUEST`, exact authority,
provider reconciliation, and durable outcomes. Pump state, checklist content, and DuckDB rows are
rebuildable projections of those two sources.

## Concurrency contract

The logical resource is `(repository, readyItemId, subjectRevision)`. The operation identity is a
content digest of that tuple plus the chosen action and policy revision.

Actors are concurrent supervisor ticks, restarted supervisors, the single effect executor, GitHub,
and projection readers. The two existing append-only journals are authoritative. DuckDB and the
managed status-comment content are rebuildable projections; R0 does not publish that comment.

The capacity/target linearization point is exclusive append of a portfolio-drain `CLAIMED` receipt
against its expected ledger revision. The GitHub-effect linearization point remains durable creation
of the existing first-evidence intent before authority consumption or provider effect. A stale loser
performs no effect. After an ambiguous response, the existing delivery seam reconciles by stable
operation marker before deciding whether an effect remains outstanding. A retry never establishes
uniqueness.

R0 must deterministically force:

- simultaneous refill attempts;
- duplicate, delayed, and replayed observations;
- effect success followed by response loss;
- crash after durable intent and before receipt;
- restart with empty process memory;
- stale, future, corrupt, or mismatched evidence;
- provider exhaustion and CI saturation;
- healthy empty input (`EXPECTED_NONE`).

## Boundaries

- Preserve the six bus verbs: `register`, `send`, `inbox`, `ack`, `heartbeat`, and `handoff`.
- Observations never grant GitHub, merge, approval, deployment, credential, or provider authority.
- One writer owns one target. Independent targets may proceed concurrently within measured capacity.
- Checklist and ETA projections update only after verified transitions.
- No automatic merge or recovery is introduced by R0.
- R0 explicitly defers adaptive 3--6 lane fanout, fractal funnels, handlers for other pump signals,
  merge/queue repair, provider scheduling, and every new authority or bus verb.

## Self-contained work projection

The stable issue-body projection answers, compactly: outcome, value/urgency and audience; owner,
lane and parent; scope, exclusions and authority; short plan; deliverables and acceptance evidence;
repositories/components/surfaces; tools and external dependencies; constraints; failure/escalation
outcome; and evidence links. It is stable after creation.

One marker-bound dynamic status-comment projection contains state/current gate, a short `[x]`/`[ ]`
checklist, exactly one `Next:`, ETA range plus confidence, latest evidence, a two- or three-word
origin, `updatedAt`, and revision. It also separates an estimated execution profile from observed
telemetry:

- profile: complexity, uncertainty, estimated token range and confidence, parallelism ceiling,
  missing capabilities/components, hardware/software limits, external services, and risk;
- observations: actual tokens only when provider evidence exists, agent/CI wall time, retries,
  queue delay, blockers, and estimate variance.

Unknown values carry a reason and are never inferred. These fields support admission, routing, ETA,
and scaling decisions; they grant no authority. A metric that does not affect any decision after an
explicit review window is removed or relegated from the bounded status projection. R0 projects this
content locally and into DuckDB only; GitHub publication requires a separately authorized effect.

## Delivery gates

1. Design and public schemas.
2. RED barrier and mechanism-revert tests.
3. Minimal GREEN tracer bullet.
4. Focused tests twice, full suite, `npm run verify`, deterministic replay.
5. Fresh independent Standards and Spec reviews.
