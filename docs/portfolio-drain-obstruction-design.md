# Portfolio drain obstruction R0 — design decision

Status: design decision, recorded **before** implementation, per ENG-01 and ENG-02 in
[`docs/engineering-and-research-principles.md`](engineering-and-research-principles.md).
It selects an implementation candidate. It grants no runtime, publication or merge authority
and is not independent review.

## Problem

The control room can already say that nothing is moving. It cannot say **why** nothing is
moving. `PAUSED` is emitted identically for two operationally opposite situations:

- the drain is **empty** — every work item is terminal, or there are no work items at all, so
  there is nothing left to drain and the pause is the correct resting state;
- the drain is **systemically blocked** — real work exists, but every path out of the queue is
  closed: evidence is missing, a lane's heartbeat expired, an explicitly declared dependency
  cycle exists, review or authority never arrives, recorded evidence contradicts the current
  observation, or eligible work and free capacity have simply not moved.

Today an operator distinguishes these by hand, by reading the item list and reconstructing the
drain's rules from memory. That reconstruction is exactly the mechanism the drain module already
owns, so having a human redo it is both wasteful and unreliable.

### Affected actor and consumer

The affected actor is the Gaia operator reading `npm run factory:dashboard` output. The concrete
consumer is `renderControlRoomHtml`, which needs one named obstruction, the age of the evidence
that named it, and one bounded thing to do next.

### Success criteria

1. A pause caused by an empty drain and a pause caused by a blocked drain are visibly different,
   in the snapshot JSON and in the rendered HTML.
2. Every non-`NONE` classification names the exact evidence revision it was derived from, the
   observation window it was measured over, the affected item ids and their count, and exactly
   one bounded advisory recovery action.
3. Unknown or insufficient input produces an explicit epistemic outcome — a typed refusal, or a
   named obstruction that says evidence is missing. It never produces `NONE`.

### Falsifiable non-goals

- Not an actuator. It starts nothing, retries nothing, publishes nothing, merges nothing.
- Not a dependency inferencer. A cycle is reported only from explicitly declared edges. No title,
  body, label or model output is ever read as a dependency.
- Not a scheduler, workflow engine, or second source of lifecycle truth.

## Assumptions

These are stated so a reviewer can attack them directly.

- **A1.** The reconciled `gaia-portfolio-drain-projection/1` value is the complete and exact
  lifecycle truth for the items it carries. Obstruction is a *reading* of that projection, never
  a second reconciliation of receipts.
- **A2.** Liveness of a claimed or running lane is already measured elsewhere (CLI progress or
  the telemetry spine) and reaches this module as a decided `ACTIVE` / `STALE` / `IDLE` token.
  This module re-measures no heartbeat and owns no freshness window of its own.
- **A3.** The interval `[sourceChangedAt, observedAt]` is a truthful measured observation window.
  It is the period over which the pinned evidence has not changed, and its duration is therefore
  the age of that evidence.
- **A4.** Dependency edges are external declared evidence carrying their own revision. Absence of
  edges is absence of evidence, not evidence of absence of a cycle.
- **A5.** The closed obstruction vocabulary is complete enough for R0. Anything it cannot classify
  fails closed to a named epistemic state rather than to health.

## Design It Twice — three seams

### Seam 1 — extend `reconcilePortfolioDrain` to emit obstruction inside the projection

Interface: no new module; `projection.obstruction` appears beside `items` and `decisions`.

- Hidden complexity: obstruction rules would live inside the receipt interpreter.
- Failure modes: the interpreter's `rulesRevision` is `sha256` of `MACHINE_RULES`. Adding
  triggers, actions or rules changes that digest, which by the module's own doctrine requires a
  new immutable `machineVersion` and retention of the previous interpreter for replay. Every
  receipt and every ledger record already written binds the old digest, so this seam turns a
  read-only display improvement into a migration of durable evidence.
- Dependencies: `src/portfolio-drain.mjs`, `src/portfolio-drain-ledger.mjs`, and every persisted
  ledger on disk.
- Trade-offs: one fewer module and one fewer call site, paid for with a one-way door on durable
  data. **Rejected.** It converts a freely reversible change into a migratable one, and the
  benefit is a call-site convenience.

### Seam 2 — compute obstruction inline inside `buildControlRoomSnapshot`

Interface: no new module; the control room grows the rules privately.

- Hidden complexity: classification, cycle detection, recovery wording and precedence all become
  private control-room internals.
- Failure modes: none new at runtime, but the rules become untestable except through the whole
  snapshot builder, and unreachable to any future non-HTML consumer (a CLI summary, the telemetry
  step reporter, a bus payload) without extracting them again later.
- Trade-offs: smallest diff today; the classification mechanism becomes invisible to independent
  verification, which ENG-08 explicitly wants separable. **Rejected**, but it is the strongest
  competitor and is revisited under "simpler alternative" below.

### Seam 3 — a pure obstruction module over the exact drain projection — **selected**

Interface, one exported function plus its constants and error type:

```js
classifyPortfolioDrainObstruction({
  drainProjection,          // gaia-portfolio-drain-projection/1, revision re-verified here
  observedAt,               // ISO instant, the end of the observation window
  windowStartedAt,          // ISO instant, the start of the observation window
  liveness = [],            // [{ itemId, state: 'ACTIVE' | 'STALE' | 'IDLE' }]
  dependencies = null,      // { evidenceRevision, edges: [{ itemId, dependsOnItemId }] }
}) -> frozen gaia-portfolio-drain-obstruction/1
```

Non-proposal usage sketch, the shape a caller actually writes:

```js
const obstruction = classifyPortfolioDrainObstruction({
  drainProjection: projection,
  observedAt: '2026-08-29T18:40:20.000Z',
  windowStartedAt: '2026-08-29T18:30:20.000Z',
  liveness: items.map(({ itemId, activity }) => ({ itemId, state: activity.state })),
});
// obstruction.state === 'THROUGHPUT_STALL'
// obstruction.recovery.label names one bounded thing to do; effect and authority are NONE
```

- Module depth: a small interface hiding the state mapping, the precedence order, cycle
  detection over declared edges, the fail-closed rules and the recovery vocabulary.
- Locality of change: a new obstruction state, a changed precedence, or a new recovery action is
  one file plus its test. The drain interpreter, the ledger and every persisted receipt are
  untouched, so `rulesRevision` never moves.
- Reversibility: **freely reversible.** Deleting the module, its test, the snapshot field and the
  rendered section removes the behaviour and transforms no user data.
- Testability: the rules are exercised directly at a public seam, without constructing an HTML
  document or a filesystem fixture.
- Cost, stated rather than discovered: one more module and one more call site, and the caller
  must supply liveness and the window explicitly instead of the module going and measuring them.

## Strongest counterargument against the selected seam

*The control room already holds every input this module needs — the verified projection, the
decided activity state, `observedAt` and `sourceChangedAt`. A separate module is therefore a
pass-through layer, and ENG-03 explicitly rejects speculative layers. Worse, splitting the rules
across two files means the snapshot builder and the classifier can disagree about what "stale"
means, which is precisely the kind of second truth this repository keeps refusing elsewhere.*

The response, and it is a partial concession. The disagreement risk is real and is bought off by
A2: this module never re-measures freshness. It consumes the decided token and would refuse an
undecided one, so there is exactly one place where 30 seconds means anything, and it stays in the
control room. What survives the counterargument is that the seam is justified by information
hiding rather than by reuse: the obstruction vocabulary, its precedence and its recovery wording
are a body of policy likely to change on its own schedule, and Parnas's criterion is to
decompose around what changes, not around what is currently called from one place. If a second
consumer never appears and the policy never changes, seam 2 was cheaper and this decision was
wrong by one module.

## Hidden costs of the selected seam

1. **A closed vocabulary hard-fails on the future.** A drain state this module does not know is
   classified `EVIDENCE_STARVATION`, not ignored. That is deliberate — an unrecognised state is
   an evidence gap — but it means a future drain state will be reported under a slightly wrong
   name until this module learns it.
2. **Precedence is a policy, not a fact.** With several classes live at once, exactly one is
   reported. The full per-class breakdown is carried in the projection so nothing is hidden, but
   the *headline* obstruction reflects a chosen ordering that an operator may disagree with.
3. **Liveness must be supplied.** A caller that forgets it does not get a cheerful answer: an
   active lane with no liveness evidence is `LANE_STALE`. Correct, and occasionally annoying.
4. **One more content-addressed value to keep coherent.** The obstruction revision is nested
   inside the snapshot revision, so tampering with either is detectable, at the cost of two
   digests to explain in a review.

## Simpler alternative that was seriously considered

Seam 2 with no new state vocabulary at all: keep the existing `blockers` array, and when the
headline is `PAUSED`, render `blockers[0]` if the array is non-empty and "nothing to drain"
otherwise. Roughly ten lines, no new module, no new schema.

It is rejected on three specific grounds, not on taste.

- It cannot express `THROUGHPUT_STALL`. Eligible `QUEUED` work with free capacity produces no
  blocker entry at all, so the very case where the drain is stalled with nothing wrong reads as
  an empty drain.
- It cannot express `LANE_STALE` distinctly from a blocked source state; `blockers` already
  folds `TELEMETRY_HEARTBEAT_EXPIRED` in beside `BLOCKED_EVIDENCE` and ranks them by count.
- `blockers` binds no evidence revision, no observation window and no recovery action, so it
  cannot satisfy success criterion 2 without becoming the selected design under another name.

## Falsifier

The design is wrong if either of these is observed:

- **F1.** Two portfolios that an operator agrees are operationally opposite — one where every
  item is terminal, one where every item is blocked awaiting evidence — receive the same
  `state` from `classifyPortfolioDrainObstruction`. If the module cannot separate an empty drain
  from a blocked drain, it has failed at its only job.
- **F2.** A run whose heartbeat is fresh but whose elapsed time is long (healthy long-running
  work) is reported as an obstruction, or a run whose heartbeat expired is reported as `NONE`.
  If liveness cannot be distinguished from duration, the module manufactures false alarms and
  misses real ones.

Both falsifiers are executed as negative controls in
`tests/portfolio-drain-obstruction.test.mjs`, together with a mutation witness: the module source
is textually mutated in a temporary copy outside the repository and re-imported, and the same
fixtures must produce a different classification. A fixture that cannot detect the mutant is not
testing the mechanism.

## Rejection criterion

Roll this design back — delete the module, the snapshot field and the rendered section — if an
independent review finds any of:

- an obstruction state is reported that is not derivable from the bound `evidenceRevision` and
  the declared dependency evidence alone;
- a dependency cycle is reported from anything other than explicitly declared edges;
- the classifier reports `NONE` for input it did not have enough evidence to classify;
- the module acquires a clock, a provider, a network call, a retry loop, a bus verb, or any
  `effect` or `authority` other than `NONE`.

## Selected minimal seam

Seam 3, at its smallest: one pure module, one exported classifier, one new optional field on the
control-room snapshot, one rendered section, and no change to `src/portfolio-drain.mjs` or to any
persisted receipt.

### Closed obstruction vocabulary

Exactly these nine states are possible. There is no other value.

| State | Meaning |
| --- | --- |
| `NONE` | No obstruction is detectable from this evidence over this window. |
| `NO_ELIGIBLE_WORK` | The drain is empty: no non-terminal work item exists. |
| `EVIDENCE_STARVATION` | Items are blocked awaiting evidence Gaia does not hold. |
| `LANE_STALE` | A claimed or running lane has no live heartbeat evidence. |
| `DEPENDENCY_DEADLOCK` | Declared dependency edges form a cycle among non-terminal items. |
| `REVIEW_STARVATION` | Items are waiting for a review that has not arrived. |
| `AUTHORITY_STARVATION` | Items are finished with their work and waiting on an explicit grant. |
| `RECONCILE_REQUIRED` | Recorded receipts and the current observation disagree. |
| `THROUGHPUT_STALL` | Eligible work and free capacity exist, and have not moved over the window. |

### Drain state to obstruction class

| Drain state | Class | Why |
| --- | --- | --- |
| `BLOCKED_EVIDENCE`, `BLOCKED_UNKNOWN`, `BLOCKED_TRIAGE` | evidence | Evidence Gaia does not hold. |
| `BLOCKED_DEPENDENCY` | evidence | The source claims a dependency; without declared edges Gaia cannot confirm or refute it, so it is an evidence gap and never a cycle. |
| any unrecognised drain state | evidence | Fail closed: an unclassifiable state is an evidence gap, never health. |
| `BLOCKED_REVIEW`, `BLOCKED_DRAFT` | review | A blocked or draft pull request cannot be reviewed as it stands. |
| `BLOCKED_HUMAN`, `BLOCKED_POLICY`, `AWAITING_MERGE_AUTHORITY`, `PUBLISHED`, `FAILED_AUTHORITY_CONSUMED` | authority | Each waits on an explicit human grant; consumed authority is deliberately not retryable. |
| `TERMINAL_*` | none | Terminal work obstructs nothing. |
| `QUEUED` | eligible | Runnable work, counted for `THROUGHPUT_STALL`. |
| `CLAIMED`, `RUNNING` | lane | Liveness decides. |
| `CANDIDATE_READY` | none | An authority-free `PREPARE_PUBLICATION_INTENT` decision is available. |
| `RECONCILE_REQUIRED` | reconcile | The machine's own truth is in doubt. |

### Precedence

Exactly one state is reported, chosen in this fixed order. Fixed precedence is chosen over
ranking by count so that the answer never depends on a majority vote among unrelated causes.

1. `RECONCILE_REQUIRED` — recorded evidence contradicts the observation, so nothing below it can
   be trusted.
2. `LANE_STALE` — a lane is occupied by a run nobody can see; capacity is consumed by a ghost.
3. If any lane is live, the drain is draining: `NONE`.
4. `DEPENDENCY_DEADLOCK` — a declared cycle cannot resolve itself with time.
5. `THROUGHPUT_STALL` — eligible work, free capacity, nothing live, and the evidence has been
   unchanged for at least `THROUGHPUT_STALL_WINDOW_MS`.
6. `NO_ELIGIBLE_WORK` — no non-terminal item exists at all.
7. `AUTHORITY_STARVATION`, then `REVIEW_STARVATION`, then `EVIDENCE_STARVATION` — nearest the
   exit first, because the cheapest unblocking is the work with the least left to do.
8. `NONE`.

`THROUGHPUT_STALL_WINDOW_MS` is a fixed exported constant, not a parameter. A configurable
threshold would make the state's meaning depend on the arguments it was produced with, which is
the same reason `inventory-digest/1` refuses an exclusion flag. Below that window the honest
answer is `NONE` — "no obstruction detectable yet", not "healthy" — and the window that produced
it is bound into the result so a reviewer can see exactly how long was observed.

### Fail-closed rules

- A `CLAIMED` or `RUNNING` item with no liveness entry is `STALE`. No heartbeat evidence is not
  evidence of a heartbeat.
- An unrecognised drain state is an evidence gap, never health.
- A dependency edge naming an item outside the projection is a typed refusal: an edge to an
  unknown item is not evidence about this drain.
- A window whose start is after its end is a typed refusal. Evidence from the future is a broken
  sensor, never news.
- A projection whose revision does not match its content is a typed refusal.
- Any liveness token outside `ACTIVE` / `STALE` / `IDLE` is a typed refusal rather than a guess.

### Result shape

```js
{
  schema: 'gaia-portfolio-drain-obstruction/1',
  effect: 'NONE',
  authority: 'NONE',
  state: <one of the nine>,
  evidenceRevision: <drainProjection.revision>,
  dependencyEvidenceRevision: <sha256 | null>,
  observationWindow: { startedAt, endedAt, durationMs },
  affectedItemIds: [<sorted ordinal>],
  affectedCount: <number>,
  label: <English statement, counts included>,
  recovery: { kind, label, effect: 'NONE', authority: 'NONE', advisory: true } | null,
  breakdown: [{ state, count }],
  revision: sha256(canonicalJson(body)),
}
```

`NONE` carries an empty `affectedItemIds`, `affectedCount: 0` and `recovery: null`. Every other
state carries exactly one bounded recovery action.

Correction, recorded during implementation rather than silently applied: the design first said
every non-`NONE` state also carries at least one affected item. `NO_ELIGIBLE_WORK` is the one
exception, and it has to be. An empty drain over an empty portfolio has no item to name, so its
`affectedItemIds` is `[]` — naming nothing is the truthful answer, and inventing a placeholder
item to satisfy a shape rule would be worse than the exception. Its recovery label still states
how many recorded items ended, so the count an operator needs is not lost.

## Reversibility

**Class: freely reversible.** No persistent store, no migration, no schema written to disk that
another actor already depends on, no bus verb, no privileged effect. The drain interpreter's
`machineId`, `machineVersion` and `rulesRevision` are unchanged by construction, so every
existing receipt and ledger record replays exactly as before.

## Decision Receipt

Bound to Gaia base commit `102aaf429ca1ff38319256cdb8284e487aa4e37a`, Git blob
`1a29b149d35f006dd64a0a88d88bd96eb3725c86` for `src/portfolio-drain.mjs`, Git blob
`3838fc3610a2b1d06df1e92f25b7f92cafabd2f7` for `src/control-room.mjs`, and Git blob
`4b4c3f0f8a8aaa2047d9284ffc279868b23d3479` for
`docs/engineering-and-research-principles.md`.

Canonical receipt body:

```json
{"baseCommit":"102aaf429ca1ff38319256cdb8284e487aa4e37a","inputBlobs":{"controlRoom":"3838fc3610a2b1d06df1e92f25b7f92cafabd2f7","engineeringPrinciples":"4b4c3f0f8a8aaa2047d9284ffc279868b23d3479","portfolioDrain":"1a29b149d35f006dd64a0a88d88bd96eb3725c86"},"reversibility":"freely-reversible","schema":"gaia-decision-receipt/1","selectedDesign":"pure-obstruction-projection-over-the-exact-drain-projection","status":"SELECTED"}
```

Receipt SHA-256:
`ae5b61399c4a607e568f32560d4acb63f305fbec1db425f90b9146ee998f10b9`.

This receipt selects an implementation candidate. It grants no runtime, publication, merge or
model-training authority, and it is not independent review.

## What R0 does not claim

R0 does not start, retry, unblock, reassign or escalate anything. Its recovery action is one
sentence of advice bound to evidence, with `effect: NONE` and `authority: NONE`. It does not
infer dependencies from prose, labels or model output. It does not measure heartbeats, own a
clock, call a provider, open a socket or add a bus verb — the tool surface remains exactly
`register`, `send`, `inbox`, `ack`, `heartbeat`, `handoff`.
