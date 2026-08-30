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

---

# R1 repair decision and amendment

Recorded **before** any R1 implementation edit, as a labelled amendment rather than a rewrite of
the R0 text above. Nothing in R0 is deleted; where R1 supersedes an R0 sentence, the R0 sentence
stays and this section says so explicitly.

R1 exists because two fresh independent reviews (Standards and Spec) each returned
`REQUEST_CHANGES` against commit `3c5dc68e6e2535d5607d53ed53bfc18681e49820`. R1 repairs only the
independently reproduced union of their blockers. It is a repair lane, not a feature lane: the
obstruction vocabulary, the bus verbs, the drain interpreter, the ledger, and the effect and
authority bounds are all untouched.

## The four blockers R1 repairs

| # | Blocker | Where R0 diverged |
| --- | --- | --- |
| 1 | Liveness scope — `moving` scans every projection item, so an `ACTIVE` token on a terminal or blocked item erases a real obstruction and returns `NONE`. | `src/portfolio-drain-obstruction.mjs:427` versus this document's own precedence clause 3, "If any **lane** is live". |
| 2 | Display binding — a self-consistent obstruction from a different projection or window can be inserted into a resealed snapshot and rendered. | `requireObstruction` checks the obstruction only against itself; it never compares it to the snapshot it is displayed with. |
| 3 | Future evidence — `sourceChangedAt > observedAt` is silently clamped to a zero-length window, which renders as a reassuring `Evidence age 0s`. | `src/control-room.mjs:532` versus this document's own fail-closed rule, "Evidence from the future is a broken sensor, never news." |
| 4 | Refresh observation semantics — each refresh tick writes a new staged portfolio, so the file mtime resets the window every tick and `THROUGHPUT_STALL` is unreachable in the real refresh and watch path. | `scripts/factory-dashboard-refresh.mjs` staging meeting `newestMtime` in `scripts/factory-dashboard.mjs`. |

Blockers 1 and 2 are one-expression repairs against a standard this document already committed to,
so they get no mechanism comparison — there is only one candidate that is not a policy change, and
choosing a different one would be a redesign R1 has no mandate for. Blockers 3 and 4 are genuine
design questions and are compared below.

## Assumptions carried into R1

- **A6.** The publisher's own already-published artifacts are legitimate evidence to the publisher.
  Reading back the control-room snapshot this same command wrote on its previous tick is not a new
  state store; it is the artifact the command's contract already says it maintains.
- **A7.** The drain projection revision is content-addressed and total over the evidence that
  matters. Two ticks whose projection revisions are equal have observed the same evidence, whatever
  their file mtimes say.
- **A8.** A refresh publisher's clock is monotonic across ordinary ticks. Where it is not, that is a
  broken sensor and must surface, not be smoothed.
- **A9.** An operator would rather see the previous complete artifact set beside a loud error than a
  fresh artifact set carrying a synthesized measurement.

A6 through A9 are additions. A1 through A5 in the R0 section above are unchanged.

## Blocker 3 — future evidence

### Mechanism 3A — typed refusal at the adapter seam, last-good artifacts preserved — **selected**

`buildControlRoomSnapshot` refuses a `sourceChangedAt` later than `observedAt` with a typed
`ControlRoomError`, exactly as the pure module's `requireWindow` already refuses an inverted
window. Both command-line adapters build the snapshot **before** they write anything, so a refusal
leaves the previously published portfolio, snapshot and HTML byte-identical. Under `--watch-ms` the
loop reports the error and retries on the next tick.

- **Assumptions relied on.** A8 and A9.
- **Strongest counterargument.** A refusal is a denial of service the clamp did not have: a single
  skewed clock, or a hand-edited published snapshot claiming a first observation in the future, can
  wedge a watch loop indefinitely, because a refusing tick never replaces the artifact that causes
  the refusal. The clamp always produced *something*.
  **Concession.** This is real and is accepted. It is bounded — the operator recovers by correcting
  the clock or deleting the published snapshot, both cheap and both local — and it is the direction
  this document already committed to for the pure module. A wedge that is loud on stderr and leaves
  the last honest artifact visible is strictly more truthful than a fresh page that renders
  `Evidence age 0s` for a sensor whose true state is incoherent. Refusing to publish is not refusing
  to inform.
- **Hidden costs.** (1) The refusal is reachable from a plain filesystem race in the hand-fed
  `--portfolio` path, where a file rewritten between the clock sample and the `stat` is genuinely
  ordinary; that path loses a tick rather than clamping it. (2) The error names a clock skew the
  operator may not be able to see from the message alone. (3) One R0 test that asserted the clamp
  must be inverted to assert the refusal, which is a deliberate, disclosed behavioural change and
  not a smoothing-away.
- **Reversibility.** Freely reversible. Restoring the single clamp expression restores R0 behaviour
  exactly; no data is written, migrated or destroyed by either behaviour.

### Mechanism 3B — carry the clamp explicitly in the evidence

Keep clamping, but publish that it happened: add `windowClamped: true` to the snapshot, render
`Evidence age UNKNOWN` instead of `0s`, and give the clamped case its own severity.

- **Assumptions relied on.** That a downstream consumer will read a new boolean, and that "unknown"
  rendered beside an otherwise complete classification is read as a warning rather than as a detail.
- **Strongest counterargument against it.** It still classifies. The obstruction state, the affected
  ids and the recovery are all computed over a window that was never measured, and they are
  published as an ordinary `gaia-portfolio-drain-obstruction/1` result that any consumer other than
  this one renderer will read as measured. The flag lives in the snapshot; the obstruction it
  qualifies is content-addressed separately and would carry no trace of the clamp.
- **Hidden costs.** Larger than 3A, not smaller: a new snapshot field, a new render path, new
  entries in each of the English and French copy maps, and a new value in the severity map — the
  exact seven-map duplication the R0 Standards review already flagged as a latent hazard. It also
  adds a second, weaker meaning of "measured window" to a schema whose whole value is that the
  field means one thing.
- **Rejected because** the R1 mandate prefers typed refusal and last-good-artifact preservation
  unless a smaller closed-state mechanism is *proven* smaller. 3B is demonstrably larger in edited
  surface and it preserves the substitution it was meant to remove.

### Simplest alternative considered for blocker 3

Delete the clamp and let the pure module's existing `ObstructionError('InvalidWindow', …)` escape
uncaught through the adapter. Zero new code. Rejected: the error would name the pure module's seam
for a fault that belongs to the adapter's clock, `ControlRoomError` is the typed vocabulary every
other adapter fault already uses, and the message would not tell an operator which of the two
instants was wrong. The saving is a few lines; the cost is a diagnostic an operator cannot act on.

### Falsifier for blocker 3 — F3

Build a control-room snapshot whose `sourceChangedAt` is later than its `observedAt`. If it returns
a snapshot at all — with any evidence age, zero or otherwise — the mechanism has failed. It must
throw a typed refusal, and the refresh adapter must leave a previously published artifact set
byte-identical when it does.

## Blocker 4 — refresh observation semantics

### Mechanism 4A — first-observation continuity carried in the published snapshot — **selected**

The refresh adapter reads back the control-room snapshot it published on its previous tick. If that
snapshot's `sourceRevision` equals the projection revision computed on this tick, the adapter
carries its `sourceChangedAt` forward unchanged; otherwise the window starts now. The dashboard
command gains one injected resolver, `resolveSourceChangedAt`, whose default is the existing
newest-input-mtime behaviour, so the hand-fed `--portfolio` path is bit-for-bit unchanged.

The refresh path therefore never reads a temp-file mtime at all, and never treats the survey instant
as an evidence-change instant beyond the one honest claim it can make: *this publisher first
observed this exact revision at this instant.*

- **Assumptions relied on.** A6 and A7.
- **Restart survival.** Free, and with no new file. The previous snapshot is already published at
  `--snapshot-out`; a restarted process reads the same bytes any operator or downstream consumer
  reads. A snapshot that is missing, unparseable or not a `gaia-control-room/1` body is treated as
  "no prior observation" and the window starts now, which is the conservative direction.
- **Strongest counterargument.** `sourceChangedAt` now means two different things depending on which
  adapter produced the snapshot: newest input mtime in the file-fed path, first observation of this
  revision in the refresh path. That is a genuine ambiguity in a field name that survives R1.
  **Concession.** Accepted, and the documentation is corrected rather than the name. Both readings
  are the same *kind* of quantity — the earliest instant from which this publisher can show that the
  pinned revision was already in force — and both are **lower bounds** on the true evidence age. A
  lower bound can only ever make `THROUGHPUT_STALL` arrive late, never early, so the ambiguity
  cannot manufacture a stall. Renaming the field would change the `gaia-control-room/1` schema,
  which is outside the R1 mandate and would break consumers to fix a comment.
- **Hidden costs.** (1) A publisher whose snapshot output is deleted or rotated between ticks
  restarts its window, silently delaying a stall by up to one threshold. (2) Two publishers writing
  the same `--snapshot-out` would interleave their windows; the existing path-aliasing guards make
  that visible only for input aliasing, not for two independent commands. (3) The resolver is a new
  injected dependency on `runFactoryDashboardCli`, which is one more seam to keep honest. (4) The
  carried instant is trusted from a file, so a hand-edited future `sourceChangedAt` reaches the
  blocker-3 refusal — deliberately, and the two mechanisms are tested together.
- **Reversibility.** Freely reversible. Removing the resolver argument restores the mtime behaviour
  in both paths; nothing new is persisted, and the carried value lives in a field the snapshot
  already had.

### Mechanism 4B — a sidecar observation-window state file

Write `.gaia-observation-window.json` beside the outputs holding `{ revision, firstObservedAt }`,
and read it at the start of each tick.

- **Assumptions relied on.** That a private file beside the outputs is more durable than the
  published snapshot, and that its lifecycle can be kept in step with three artifacts it is not
  written with.
- **Strongest counterargument against it.** It is a state store. The R1 mandate forbids adding one,
  and the prohibition is not arbitrary: a private file that nobody publishes, nobody digests and
  nobody reviews becomes an unaudited authority over a measurement that appears in the artifact. It
  also duplicates two fields the published snapshot already carries, so the two can disagree, and
  the sidecar wins silently.
- **Hidden costs.** A fourth output path to guard against aliasing, a fourth atomic replace, a new
  file format to version, and a new failure mode where the sidecar survives but the snapshot does
  not.
- **Rejected** on the mandate and on redundancy. 4A gets the same durability from bytes that are
  already published, already content-addressed and already reviewed.

### Simplest alternative considered for blocker 4

Keep mtime semantics and simply stop rewriting `portfolio.json` when the surveyed bytes are
byte-identical to the published ones, so its mtime stops moving. Rejected on three counts. First, it
still equates a file mtime with an evidence-change instant, which the R1 mandate forbids outright.
Second, byte identity of the surveyed portfolio is a *stricter* test than projection-revision
identity — any survey timestamp or ordering jitter in the portfolio body breaks it — so the window
would reset on ticks where the evidence provably did not change. Third, any unrelated process
touching the file resets the window with no trace. It is smaller, and it is wrong in the direction
that hides stalls.

### Falsifier for blocker 4 — F4

Run the refresh adapter for several ticks against a survey that never changes, with eligible work
and free capacity, advancing only the injected clock. If the observation window does not grow across
ticks, or `THROUGHPUT_STALL` is still unreachable once the window passes
`THROUGHPUT_STALL_WINDOW_MS`, the mechanism has failed. Then change the surveyed portfolio: if the
window does **not** reset to zero on the tick whose projection revision changed, the mechanism has
also failed — a carried-forward window across genuinely changed evidence would be a fabricated
measurement, which is worse than the defect being repaired.

## Rejection criterion for R1

R1 is rejected, and the R0 behaviour restored, if any one of the following holds.

1. Restricting `moving` to live lanes changes the reported state for any fixture in which the
   `ACTIVE` token sits on a `CLAIMED` or `RUNNING` item — that would mean the repair changed the
   policy rather than the predicate.
2. The render-seam binding refuses any snapshot that `buildControlRoomSnapshot` itself produced.
3. The future-evidence refusal is reachable from the refresh adapter under a monotonic clock and an
   unmodified published snapshot.
4. The carried observation window ever survives a projection-revision change, or ever produces a
   window longer than the interval since this publisher first observed that revision.
5. Any of these mechanisms requires a new bus verb, a new state store, a change to the obstruction
   vocabulary, a change to the drain interpreter or ledger bytes, or any `effect` or `authority`
   other than `NONE`.

## What R1 supersedes in the R0 text above

- The fail-closed rule "Evidence from the future is a broken sensor, never news" now holds at the
  **adapter** seam as well as inside the pure module. The R0 sentence in
  `docs/factory-control-room.md` describing the clamp is superseded and corrected there.
- The observation window is defined as **the interval over which this publisher has continuously
  observed this exact projection revision** — a measured lower bound on the age of the evidence, not
  a claim about when the upstream world changed. The R0 phrasing "the interval over which the pinned
  evidence has not changed, which is also the age of that evidence" is superseded.
- Precedence clause 3 is unchanged in intent and now matches the code: **lane**, not item.

## R1 Decision Receipt

Bound to Gaia entry commit `3c5dc68e6e2535d5607d53ed53bfc18681e49820`, Git blob
`4704d60bbc8acaac9940d67e863d229b8df1d9b3` for `src/portfolio-drain-obstruction.mjs`, Git blob
`ebe7899d63db1f2ccb4cfe081b710eaa5902ffc5` for `src/control-room.mjs`, Git blob
`46eecebafb81a6d6915d67d3eb53fefa0bbca8ba` for `scripts/factory-dashboard.mjs`, and Git blob
`c0a54c2770a1d23201814d5ab72bbb618922dd71` for `scripts/factory-dashboard-refresh.mjs`.

Canonical receipt body:

```json
{"entryCommit":"3c5dc68e6e2535d5607d53ed53bfc18681e49820","inputBlobs":{"controlRoom":"ebe7899d63db1f2ccb4cfe081b710eaa5902ffc5","factoryDashboard":"46eecebafb81a6d6915d67d3eb53fefa0bbca8ba","factoryDashboardRefresh":"c0a54c2770a1d23201814d5ab72bbb618922dd71","portfolioDrainObstruction":"4704d60bbc8acaac9940d67e863d229b8df1d9b3"},"repairs":["liveness-scope","display-binding","future-evidence-typed-refusal","refresh-first-observation-continuity"],"reversibility":"freely-reversible","schema":"gaia-decision-receipt/1","status":"SELECTED"}
```

This receipt selects a repair mechanism. It grants no runtime, publication, merge or model-training
authority, and it is not independent review. R1 is owed fresh independent Standards and Spec
reviews; this amendment is not one.

## What R1 does not claim

R1 does not widen the obstruction vocabulary, add a bus verb, add a state store, touch the drain
interpreter or the ledger, change retry behaviour, grant publication or merge authority, call a
provider, or open a socket. It does not address any low or cosmetic finding from the R0 reviews:
the seven-map vocabulary duplication, the French view's dropped counts, the `NO_ELIGIBLE_WORK`
count disagreement, the unread `counts.occupied`, the loose `requireWindow` parsing and the
dashboard's silent acceptance of unknown flags all remain open and are recorded as residuals rather
than repaired here.
