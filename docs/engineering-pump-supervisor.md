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
and projection readers. The two existing append-only lifecycle journals are authoritative. A
passive append-only pump-correlation witness binds their exact generations without defining a
third lifecycle machine. DuckDB and the managed status-comment content are rebuildable
projections; R0 does not publish that comment.

The capacity/target linearization point is exclusive append of a portfolio-drain `CLAIMED` receipt
against its expected ledger revision. The GitHub-effect linearization point remains durable creation
of the existing first-evidence intent before authority consumption or provider effect. A stale loser
performs no effect. After an ambiguous response, the existing delivery seam reconciles by stable
operation marker before deciding whether an effect remains outstanding. A retry never establishes
uniqueness.

`CLAIMED` is also the durable pump outbox for the correlation step. A crash after that append and
before the passive correlation append is not healthy idle: a later tick reconstructs the one exact
correlation witness from the sealed claim, subject and policy generation. If GitHub already shows
the exact Draft but the first-evidence journal has no durable `INTENT`, the tick reports a typed
`BLOCKED / DELIVERY_INTENT_MISSING` result after repairing the witness. It neither adopts the Draft
without proof nor retries an effect. Thus the orphan is observable and convergent without creating
a second authority path.
This passive recovery runs after complete nested evidence validation but before provider, CI, or
writer admission gates. It consumes none of those capacities: saturation governs new work, not
reconciliation of a durable outbox already accepted at the claim linearization point.
The same ordering applies when the exact delivery journal already carries an `INTENT` but no
successful terminal receipt. If a complete provider observation now proves the exact Draft, the
supervisor delegates to the existing delivery reconciliation path before admission. That path may
append one effect-free `REUSED` terminal; it consumes no grant, calls no provider effect, creates no
claim, and preserves the existing correlation witness. A `REFUSED` receipt after an ambiguous
response does not erase the earlier durable intent or turn reconciliation into new work.

A fresh `DRAFT_OPEN` observation is already satisfied work. It cannot reserve capacity and cannot
announce `START_DRAFT`. It may reach the delivery adoption path only when the first-evidence journal
already contains an exact matching `INTENT` whose provider response may have been lost. An
unexpired matching `INTENT` owned by another actor remains live: observing its Draft does not permit
a second actor to settle or reinterpret it.

Checklist replay joins the latest drain claim to a delivery operation only through a passive,
durable correlation witness written before delivery. The witness binds the exact claim receipt and
action identity to the delivery operation identity, repository, item and source/policy revisions.
A delivery for another claim generation is not "latest status" for this one: absent an exact match,
delivery-derived fields remain honestly unknown and no old PR evidence is shown.
The projection derives both the checklist and DuckDB rows from one stable set of exact source
snapshots. It retries when any head changes across the read window and typed-refuses when no stable
set can be measured; it never combines independently sampled heads.
The DuckDB metadata row stores all three revisions (`portfolioDrain`, `draftDelivery`, and
`pumpCorrelation`) in the same transaction as the derived rows. A consumer can therefore prove
which exact correlation generation produced the materialized view after restart.

The sealed nested portfolio revision is validated before capacity, provider, CI, or empty-work early
gates. An early gate is a conclusion over verified evidence, never a shortcut around evidence
validation.
After that validation, a genuinely empty work set is healthy `EXPECTED_NONE` even when every
measured execution slot is zero; saturation gates describe blocked work, not an empty queue.

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
lane, and parent; scope, exclusions and authority; short plan; deliverables and acceptance evidence;
repositories/components/surfaces; tools and external dependencies; constraints; failure/escalation
outcome. It is stable after creation. An unmeasured owner or lane is `UNKNOWN` with a reason; the
delivery journal's opaque lease token is never presented as a responsible human or agent identity.

One marker-bound dynamic status-comment projection contains state/current gate, a short `[x]`/`[ ]`
checklist, exactly one `Next:`, ETA range plus confidence, latest evidence, a two- or three-word
origin, `updatedAt`, transition-bound evidence links, and revision. It also separates an estimated
execution profile from observed
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
