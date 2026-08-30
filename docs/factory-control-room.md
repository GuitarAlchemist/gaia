# Factory control room R0

## Operator problem

Gaia already emits exact portfolio observations, replayable drain receipts and redacted CLI
progress. Those records are useful evidence but do not answer the operator's first questions
without manual reconstruction: what is actually moving, what is stale, what happens next, and
whether a percentage or ETA is grounded in comparable evidence.

The control room is a read model over those existing contracts. It is not another workflow
engine, database, authority surface or source of truth.

## Design It Twice

The load-bearing seam is the conversion of an immutable drain projection into operator-facing
status. Three designs were compared before selecting R0:

1. **Pure content-addressed read model — selected.** One pure Module verifies the projection
   revision, derives an immutable snapshot and renders a dependency-free artifact. The small
   interface hides heartbeat freshness, gate progress, blocker ranking and ETA policy. Failures
   are typed refusals. The filesystem CLI is a separate replaceable Adapter.
2. **Embedded dashboard server — rejected.** A listener would simplify navigation, but would
   mix transport lifetime, port ownership and browser delivery into the truth Module. It also
   creates a larger operational and security surface without improving status accuracy.
3. **Mutable dashboard database — rejected.** Persisted materialized status could support richer
   history, but would create a second source of truth, migration obligations and stale-write
   failure modes. R0 instead accepts explicit completed-run evidence from its caller.

The selected design optimizes for locality, fail-closed verification and testability. Its cost is
that a separate static host or file viewer must display the artifact and a caller must retain any
history used for pace estimates.

## Decision Receipt

The decision is bound to Gaia base commit
`77461d277f187766bc7d1989fc3b155c524e52ac`, Git blob
`92a0bf249bd7d973c030261219704583709ba09b` for `src/portfolio-drain.mjs`, and Git blob
`4b4c3f0f8a8aaa2047d9284ffc279868b23d3479` for
`docs/engineering-and-research-principles.md`.

Canonical receipt body:

```json
{"baseCommit":"77461d277f187766bc7d1989fc3b155c524e52ac","inputBlobs":{"engineeringPrinciples":"4b4c3f0f8a8aaa2047d9284ffc279868b23d3479","portfolioDrain":"92a0bf249bd7d973c030261219704583709ba09b"},"reversibility":"freely-reversible","schema":"gaia-decision-receipt/1","selectedDesign":"pure-content-addressed-control-room-read-model","status":"SELECTED"}
```

Receipt SHA-256:
`914eaebe1f5703c7faa9271486cd049284b24355badf998ec3cca56a385ab668`.

This receipt selects an implementation candidate; it grants no runtime, publication or merge
authority and is not independent approval.

### Fog-of-war extension — Design It Twice

R1 adds evidence coverage without turning uncertainty into a completion score. Three seams were
compared before implementation:

1. **Snapshot-bound fog-of-war projection — selected.** The pure read model classifies every
   item as `KNOWN`, `PARTIAL` or `UNOBSERVED`, derives one aggregate and one reconnaissance
   frontier, and binds both into the existing content-addressed snapshot. The renderer verifies
   the complete snapshot before displaying it. This keeps epistemic truth in one Module.
2. **Renderer-only inference — rejected.** Re-deriving coverage in HTML would create a second
   truth implementation outside the snapshot revision and make JSON and HTML disagree.
3. **Separate fog service or store — rejected.** A mutable service could retain richer history,
   but would create another authority-free-yet-stale projection and an unnecessary operational
   surface before any longitudinal query has been measured.

The selected design is freely reversible. Its deliberate cost is a closed source-state mapping:
an unfamiliar future state fails closed to `UNOBSERVED` until the truth Module understands it.

The extension is bound to Gaia base commit
`a17392d3cf967bf2d7906d2cbd77dbc01f5f3c87`, Git blob
`1b7ddaf3c57bc984a1abd72fa700ee510243ea62` for `src/control-room.mjs`, Git blob
`92a0bf249bd7d973c030261219704583709ba09b` for `src/portfolio-drain.mjs`, and Git blob
`4b4c3f0f8a8aaa2047d9284ffc279868b23d3479` for
`docs/engineering-and-research-principles.md`.

Canonical receipt body:

```json
{"baseCommit":"a17392d3cf967bf2d7906d2cbd77dbc01f5f3c87","inputBlobs":{"controlRoom":"1b7ddaf3c57bc984a1abd72fa700ee510243ea62","engineeringPrinciples":"4b4c3f0f8a8aaa2047d9284ffc279868b23d3479","portfolioDrain":"92a0bf249bd7d973c030261219704583709ba09b"},"reversibility":"freely-reversible","schema":"gaia-decision-receipt/1","selectedDesign":"snapshot-bound-fog-of-war-projection","status":"SELECTED"}
```

Receipt SHA-256:
`dd009dd62bf69b60df38881b7f8165a84069cec4c3263a4167a8c11dbb400a9c`.

This receipt grants no execution, publication, model-training or merge authority.

The requirements below name the selected candidate. They were recorded before its implementation
and are independently reviewable against the exact input identities above.

### Obstruction detection — Design It Twice

R2 answers the question `PAUSED` could not: **why** is nothing moving. An empty drain and a
systemically blocked drain were emitting one identical sentence. Three seams were compared before
implementation, and the full decision — assumptions, the strongest counterargument, hidden costs,
the simpler ten-line alternative, two falsifiers and the rejection criterion — is recorded in
[`portfolio-drain-obstruction-design.md`](portfolio-drain-obstruction-design.md).

1. **Pure obstruction Module over the exact drain projection — selected.**
   `classifyPortfolioDrainObstruction` reads one verified projection plus decided lane liveness,
   a measured observation window and optional declared dependency evidence, and returns one
   content-addressed `gaia-portfolio-drain-obstruction/1` value. The control room nests it inside
   its own snapshot revision.
2. **Emit obstruction from `reconcilePortfolioDrain` — rejected.** The interpreter's
   `rulesRevision` is a digest of its own rules, so adding obstruction rules there requires a new
   `machineVersion` and a migration of every persisted receipt. A read-only display improvement
   must not become a one-way door on durable evidence.
3. **Compute it privately inside `buildControlRoomSnapshot` — rejected.** The smallest diff, and
   the strongest competitor, but the classification rules would then be testable only through the
   whole snapshot builder and reachable by no other consumer.

The selected design is freely reversible. Its deliberate costs are a closed vocabulary that reads
an unknown future drain state as an evidence gap, and a fixed precedence that reports one cause
while carrying the full breakdown beside it.

## Obstruction truth rules

- Exactly one state is reported, from a closed vocabulary of nine: `NONE`, `NO_ELIGIBLE_WORK`,
  `EVIDENCE_STARVATION`, `LANE_STALE`, `DEPENDENCY_DEADLOCK`, `REVIEW_STARVATION`,
  `AUTHORITY_STARVATION`, `RECONCILE_REQUIRED`, `THROUGHPUT_STALL`.
- Precedence is fixed, not ranked by count: reconcile, stale lane, live motion, declared
  deadlock, measured stall, empty drain, then authority, review and evidence starvation — nearest
  the exit first. The per-cause `breakdown` is carried alongside so no contributing cause is
  hidden by the one that is reported.
- Every non-`NONE` state binds the exact drain-projection revision, the measured observation
  window, the affected item ids and their count, and exactly one bounded advisory recovery action
  with `effect: NONE`, `authority: NONE` and `advisory: true`. `NO_ELIGIBLE_WORK` over an empty
  portfolio is the one state whose affected list is legitimately empty — there is no item to name.
- The observation window is `[sourceChangedAt, observedAt]`: the interval over which this
  publisher has continuously observed this exact projection revision. It is a **measured lower
  bound** on the age of the evidence, never a claim about when the upstream world changed, so it
  can only ever make a stall arrive late. How `sourceChangedAt` is obtained depends on the
  adapter. The file-fed `factory:dashboard` path uses the newest input mtime: the inputs are
  persisted evidence it does not write, so the instant one of them was last written is a real
  lower bound. The `factory:dashboard:refresh` path writes a brand-new staged portfolio on every
  tick, so a mtime there is the survey time and carries no information about the evidence; it
  carries the first-observation instant forward from the control-room snapshot it published on
  its previous tick, for as long as the content-addressed projection revision is unchanged, and
  starts a fresh window on the exact tick that revision changes. The carrier is the published
  artifact itself, so an ordinary process restart resumes the window with no private state store.
  That the artifact is the publisher's own is not an integrity property — the path can be written
  by a second publisher, a rotation or an editor — so the carrier is verified with the same total
  verifier the render seam applies to those exact bytes. A snapshot that is missing, unreadable,
  that fails that verification, that is pinned to a different revision, or that claims to have
  observed evidence before that evidence existed, is no prior observation and the window restarts.
  Every one of those directions delays a stall; none invents one.
- Evidence dated after the instant it was observed is a **typed refusal** at the control-room seam
  as well as inside the pure module. The file-fed adapter never asserts such an instant in the
  first place: an input mtime later than the observation instant shows nothing about how long the
  revision has been in force, so it is discarded and the window starts now, growing from there on
  the next render. That still leaves a single-shot file-fed render under a clock skewed behind the
  filesystem showing a zero-length window — refusing there too would break three telemetry test
  files outside that repair's scope, and it is recorded as an open residual in
  `docs/portfolio-drain-obstruction-design.md` — but the discard is no longer silent. R0 clamped
  that case, which published a reassuring `Evidence age 0s` for a sensor whose true state is
  incoherent and marked the substitution nowhere in the evidence. Both command-line adapters build the snapshot before they
  write anything, so a refusal leaves the previously published portfolio, snapshot and HTML
  byte-identical and the watch loop retries on the next tick.
- Every snapshot declares what kind of thing its window start is. `sourceChangedAtBasis` is a
  closed two-value vocabulary: `MEASURED`, where the start is evidence of *earlier* observation —
  a verified carried first observation, or an input timestamp at or before the observation
  instant — and `UNOBSERVED`, where the publisher had none and the window therefore begins at the
  observation instant. The marker is sealed into the snapshot revision, so it cannot be added,
  removed or flipped without breaking the digest, and `UNOBSERVED` is refused over any window that
  does not start where the observation does, so it can never dress up a measurement nobody took.
  The page reads `Not yet measured` rather than `0s` for an `UNOBSERVED` window. The obstruction's
  own contract is untouched: the marker records the adapter's epistemic position, never the
  ruling.
- `THROUGHPUT_STALL` requires eligible work, free capacity, no live **lane** and at least
  `THROUGHPUT_STALL_WINDOW_MS` (300 000 ms) of unchanged evidence. The threshold is a fixed
  exported constant, never a parameter: a configurable threshold would make the state mean
  something different depending on the arguments it was produced with.
- A dependency cycle is derived **only** from explicitly declared edges carrying their own
  SHA-256 evidence revision. Prose, labels and model output are never read as dependencies, and an
  edge naming an item outside the projection is a typed refusal.
- Liveness is a property of **lanes**. Only a `CLAIMED` or `RUNNING` item can report the drain as
  draining. A terminal, blocked, candidate or queued item can legitimately carry an `ACTIVE`
  liveness token — a merged pull request whose worker has not yet emitted `run.completed` is
  ordinary — and none of them is motion out of the queue.
- Fail-closed, never to health: an occupied lane with no liveness evidence is `LANE_STALE`; an
  unrecognised drain state is an evidence gap; a source state that merely claims a dependency is
  an evidence gap; an undecided liveness token, an incoherent window and a projection whose
  revision does not match its content are typed refusals.
- The renderer re-verifies the nested obstruction three ways — its own digest against its own
  content, its invariants, and its binding to the snapshot it is displayed with — and refuses a
  snapshot whose obstruction was edited after it was built, or whose obstruction names an
  evidence revision, a window end or a window **start** other than the snapshot's own
  `sourceRevision`, `observedAt` and `sourceChangedAt`. All three, because the window end cannot
  be stretched without also lying about `observedAt`, which is bound — and the window start is the
  half that lengthens it. The binding is what separates "internally consistent" from "about this
  evidence": without it a self-consistent obstruction from another projection, or one carrying a
  window start that contradicts the `sourceChangedAt` sitting in the same JSON object, can be
  grafted into a resealed snapshot and rendered. There is no animation in this section: an obstruction is a standing fact, and a
  spinner would suggest something is happening about it.
- The Module owns no clock, provider, network call, filesystem access or retry loop, adds no bus
  verb, and leaves `src/portfolio-drain.mjs` untouched, so `machineId`, `machineVersion` and
  `rulesRevision` are unchanged and every persisted receipt replays exactly as before.

`--dependencies <path>` on `npm run factory:dashboard` supplies that declared evidence as
`{ "evidenceRevision": "<sha256>", "edges": [{ "itemId": "…", "dependsOnItemId": "…" }] }`.
Without it, no deadlock can ever be reported.


## Default view

Every visible element answers one operator question:

1. **Now** — active, stale or paused. Stored `RUNNING` state alone is insufficient.
2. **Next action** — one closed action from the drain projection, or a stale-run check.
3. **Why the drain is not moving** — one named obstruction, the age of the evidence that named
   it, the items it affects and one bounded advisory recovery. An empty drain and a blocked drain
   never share a sentence.
4. **Verifiable progress** — named gates for each bounded lifecycle.
5. **Pace and ETA** — measured evidence, its sample size, or an explicit unknown.
6. **Fog of war** — known, partial and unobserved evidence plus the next reconnaissance frontier.
7. **Proof** — the content-addressed control-room snapshot and source projection revision.

The graph, Gantt and full state remain optional detail views. They are not required to
understand the default page.

## Truth rules

- A pulse exists only when the newest observation contains `heartbeat: true`, belongs to a
  running provider stage and is no more than 30 seconds old.
- A `CLAIMED` or `RUNNING` item without such a fresh observation is `STALE`, never animated.
- The bounded lifecycle has five gates: claim, run/review, candidate, publish and terminal.
  Blocked states do not receive a misleading percentage.
- The portfolio is an open queue. Its global completion percentage is always `null`.
- ETA is `UNKNOWN` below five comparable completed `portfolio-factory-run` samples. At five or
  more samples, the estimate is the remaining historical interquartile range after subtracting
  the current run's elapsed time. More than one active run makes the single dashboard ETA
  `UNKNOWN`; per-run forecasts are not invented. The UI always displays the sample size and
  method.
- The source projection revision is recomputed before any status is derived. The returned
  snapshot is deeply immutable, so displayed content cannot move under one revision.
- The renderer independently recomputes the snapshot revision and refuses malformed, legacy or
  tampered fog-of-war fields with a typed `InvalidSnapshot` error.
- Fog-of-war coverage measures only whether source evidence is sufficient to classify an item.
  It is not project completion, correctness or model confidence. Unknown future source states
  are `UNOBSERVED`, never implicitly known.
- `effect` and `authority` are both `NONE`. This module cannot start a lane, spend a grant,
  publish, merge, assign, label or mutate GitHub.

## Interfaces

`buildControlRoomSnapshot({ drainProjection, observedAt, sourceChangedAt, sourceChangedAtBasis,
progressObservations, completedRuns, telemetryProjection, dependencies })` is pure. It returns
one content-addressed `gaia-control-room/1` value carrying a nested, separately content-addressed
`gaia-portfolio-drain-obstruction/1`.

`classifyPortfolioDrainObstruction({ drainProjection, observedAt, windowStartedAt, liveness,
dependencies })` in `src/portfolio-drain-obstruction.mjs` is the obstruction truth Module. It is
pure, imports only `node:crypto`, and is usable without the control room.

`renderControlRoomHtml(snapshot)` returns one dependency-free HTML document. It embeds no
remote resource. Browser-side code only ages the already displayed snapshot and stops a pulse
when its heartbeat expires.

`npm run factory:dashboard` is the filesystem adapter. It accepts either an existing exact
drain projection or a portfolio plus optional receipt and hold arrays, writes replaceable
derived JSON/HTML outputs and can poll the input files from 1 through 60 seconds. It opens no
network listener. English is the default; `--language fr` selects the optional French renderer.
`--dependencies <path>` supplies explicit declared dependency evidence; without it no dependency
deadlock can ever be reported. Its one stdout line now names the obstruction beside the headline
state and the next action.

`npm run factory:dashboard:refresh -- ...` is the explicit GitHub refresh Adapter. Each tick
performs one fresh, read-only organization survey, reconciles the resulting portfolio through
the same drain Module, prepares portfolio/snapshot/HTML artifacts off-path, then replaces the
three caller-owned outputs with the self-contained HTML last. The default is one tick, suitable
for a scheduler. `--watch-ms 30000` enables a visible sequential watch from 10 through 300
seconds: ticks never overlap, a failed tick is reported and retried, and the last valid HTML is
left in place. Cancellation stops before a pre-aborted tick, interrupts the default `gh`
subprocesses during an active survey, and prevents a late survey result from being published.
The Adapter grants no authority and performs no GitHub mutation.

```powershell
npm run factory:dashboard:refresh -- `
  --organization GuitarAlchemist `
  --policy-revision sha256:portfolio-policy-v1 `
  --portfolio-out C:\state\gaia-portfolio.json `
  --snapshot-out C:\site\gaia-control-room.json `
  --html-out C:\site\gaia-control-room.html `
  --language en `
  --watch-ms 30000
```

The three outputs cannot be replaced as one filesystem transaction. Preparing all content
first and publishing the self-contained HTML last ensures the browser sees either the previous
complete page or the new complete page. A crash during evidence-file replacement can briefly
leave JSON ahead of HTML; the next successful tick repairs it. Consumers requiring a single
atomic identity must use the content-addressed snapshot revision embedded in the HTML rather
than assume directory-wide atomicity. Before surveying GitHub, the Adapter canonicalizes the
nearest existing ancestor of every path, compares its filesystem volume/file identity plus the
remaining path segments, and refuses output aliases (including admin-share UNC spellings),
Windows case aliases, and any output that aliases the receipts, holds, progress or history
evidence it will read. At the publication boundary—after the potentially long GitHub survey
and all caller-injected rendering dependencies—it measures those identities again and refuses
before the first replacement if any parent, junction or target identity changed. The same
publication boundary rechecks cancellation, so an abort raised during rendering writes nothing.

Raw `gaia-cli-progress/1` JSONL is accepted only when exactly one drain item is active. With
more than one raw line, or with multiple active items, each line must use the explicit
`gaia-control-room-progress-observation/1` envelope carrying `itemId`, `capturedAt` and the
original `record`; otherwise the adapter refuses the ambiguous attribution.

## Reversibility

**Class: freely reversible.** R0 has no listener, persistent store, migration, bus export or
privileged effect. Removing the Module, Adapter, tests, documentation and generated artifacts
removes the behavior without transforming user data. Roll back if independent review finds that
the read model can display a state not bound by its source revision, or if operating the Adapter
requires hidden mutable state. Revisit a server only when a real remote consumer cannot use a
static artifact; revisit persistence only after a measured history query cannot be served by an
explicit caller-owned dataset.

## What R0 does not claim

R0 does not invent a project-wide Gaia completion percentage, infer completion from agent text,
or promise an ETA from provider timeout bounds. It does not yet persist a history of comparable
cycles; callers may supply that existing evidence as a JSON array. It also does not host the
HTML. A local file viewer, wmux browser or separately governed static host may display the
artifact without widening Gaia's stdio-only core.
