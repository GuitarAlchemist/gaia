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
- an append-only intent/receipt journal;
- a concise managed checklist projection;
- a deterministic DuckDB projection of the same transitions.

## Concurrency contract

The logical resource is `(repository, readyItemId, subjectRevision)`. The operation identity is a
content digest of that tuple plus the chosen action and policy revision.

Actors are concurrent supervisor ticks, restarted supervisors, the single effect executor, GitHub,
and the projection readers. The append-only journal is authoritative. DuckDB and the managed GitHub
comment are rebuildable projections.

The linearization point is exclusive durable creation of the operation intent against the expected
observation revision. A stale loser performs no effect and returns a typed refusal. After an
ambiguous GitHub response, the supervisor reconciles by the stable operation marker before deciding
whether an effect remains outstanding. A retry never establishes uniqueness.

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

## Delivery gates

1. Design and public schemas.
2. RED barrier and mechanism-revert tests.
3. Minimal GREEN tracer bullet.
4. Focused tests twice, full suite, `npm run verify`, deterministic replay.
5. Fresh independent Standards and Spec reviews.

