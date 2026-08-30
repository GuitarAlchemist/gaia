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

### Progress and ETA UX — Design It Twice

R3 answers the question the R0 default view conflated. `Now`, the heartbeat chip, the blocker
mix and the pace sentence sat in one visual register, so an operator could not tell **what is
moving** from **what is merely being pinged**, could not tell a blocker *of the current run*
from a portfolio-wide backlog count, and read `Unknown pace: fewer than 5 comparable completed
runs.` without ever learning which evidence was missing. Two seams were compared before any
production code was written.

**(A) Embed all of it in the existing snapshot and renderer — rejected.**
Put the three operator sentences, the freshness lattice and the backlog shares directly into
`buildControlRoomSnapshot`'s body and into `renderProgress`. It is the smallest diff and cannot
drift from the snapshot, because it *is* the snapshot. It was rejected on three specific grounds.
It changes the `gaia-control-room/1` body, so every previously published `revision` for the same
evidence moves and every machine consumer must re-verify — a presentation improvement becoming a
migration. It binds no evidence of its own, so *"a heartbeat-only tick changes nothing"* could
only be eyeballed across rendered bytes that also carry a moving `observedAt`; the single most
important constraint of this slice would have no seam to assert it at. And the sentences would
exist only as HTML, so a CLI status line, a bus payload or a DuckDB query would have to
re-derive the rules or parse a document.

**(B) A pure derived activity artifact bound to the snapshot — selected.**
One new module, `src/control-room-activity.mjs`, exporting
`summarizeControlRoomActivity({ snapshot })`. It re-verifies the published snapshot's own digest,
reads nothing else, and returns one separately content-addressed, deeply frozen
`gaia-control-room-activity/1` value: for each active item, exactly three bullets — current
verified **action**, most recent concrete **result**, next evidence **checkpoint or blocker** —
authored by a closed phrasebook keyed on tokens the snapshot already carries. It collects no
evidence, spends no provider token, writes nothing, and imports only `node:crypto`.
`gaia-control-room/1` is untouched: same schema, same body, same canonical-JSON recipe, same
digest for the same inputs.

The value carries **two digests**. `revision` covers the whole body and therefore moves on every
tick, because it binds `observedAt`. `contentRevision` covers `{ machine, items }` only, and is
what makes requirement 9 an assertion rather than an intention: **no wall-clock arithmetic and no
heartbeat instant may enter a bullet.** The only instant a bullet may carry is the `observedAt` of
a verified telemetry `lastTransition`, which the spine builds by construction to exclude
`run.heartbeat` (`src/factory-telemetry.mjs`). Drain-sourced and progress-sourced bullets carry
`observedAt: null` — the drain projection is identified by its revision, and `gaia-cli-progress/1`
is unchained self-report that binds no verifiable instant at all. Ages are therefore derived at
render time from `snapshot.observedAt`, never stored. A tick whose only new events are heartbeats
therefore changes **not one sentence**. `contentRevision` also covers the freshness lattice, which
is clock-derived, so a tick that crosses the 30-second boundary moves `contentRevision` while every
sentence stays byte-identical.

**The four-state evidence lattice, and what it deliberately does not mean.**
`FRESH`, `PARTIAL`, `STALE` and `UNKNOWN` describe **the evidence**, never the motion.
`UNKNOWN` is an occupied lane with no telemetry run and no progress record at all — absence of
evidence, never rendered as health. `STALE` is `activity.state === 'STALE'`: evidence existed and
expired. `PARTIAL` is a bullet whose source is unverified, or whose bound evidence carries the
spine's honest `UNKNOWN` sentinel. `FRESH` is everything bound, named and verified. Liveness is
carried separately, by the run-state sentence and by the existing heartbeat chip, so a blocked run
whose block is recorded with a real digest reads `Evidence FRESH` beside `Stopped on <BLOCKER>` —
which is exactly the split requirement 2 asks for. Nothing here re-measures a heartbeat: the
lattice reads decisions `itemTelemetry` and `itemActivity` already made against one window.

**Deviations from the advisory design, recorded exactly.**

- `MAX_ACTIVITY_BYTES` is `16384`, not the advisory `8192`. Eight items × three bullets, each
  bullet carrying a 64-hex `evidenceRevision`, an instant, a code, a source, a state and a
  sentence, canonicalises to roughly 1.3 KB per item; `8192` would have made the documented
  `MAX_ACTIVITY_ITEMS = 8` unreachable, turning a guard rail into a defect. The cap still exists
  so that a future phrasebook edit that breaks the fragment budget fails a test, not a browser.
- `src/cli-progress.mjs` does not export `HUMAN_STAGES` and is outside this slice's permitted
  files, so the twelve stage sentences are restated as a closed table inside the activity module
  and sealed into `rulesRevision`. A future rename in either place is a visible digest change,
  not a silent divergence.
- The renderer's `activity` option is **additive and optional, and the renderer computes the same
  value itself when it is absent**, so the Current run card is complete for every caller. Supplied
  activity is not trusted: it is verified for self-consistency and then for binding to *this*
  snapshot. Consequently `renderControlRoomHtml(s)` and
  `renderControlRoomHtml(s, { activity: summarizeControlRoomActivity({ snapshot: s }) })` are
  byte-identical, which is the property the option is tested against.

**Unavoidable deviation from byte-identical R0 output.** Requirements 1, 2, 4, 5 and 7 are
statements about the committed control-room shell itself, not about the optional activity value,
so the document changes whether or not activity is supplied. Exactly these shell changes are
made, and nothing else:

1. a **Current run** card is placed first inside `<main>`, carrying state, current stage or gate,
   elapsed work, the last verified transition and the next evidence checkpoint or blocker;
2. **evidence freshness is labelled separately from elapsed work**, with its own state word,
   symbol and the sentence that a heartbeat proves the sensor is alive rather than that work
   advanced;
3. the aggregate `blockers` mix moves out of *"Why work is blocked"* into a separately labelled
   **Portfolio backlog** section carrying scope, as-of instant, total, count and percentage, and
   stating that those counts are not blockers of the current run; run-level `TELEMETRY_*` signals
   stay with the run and are never counted as portfolio backlog;
4. the pace sentence becomes **Pace calibration: n/5 comparable completed runs**, and an
   unavailable ETA names the exact missing evidence instead of *"Insufficient comparable
   history."*; a human forecast is rendered only from the explicit `operatorForecast` render
   option and only under the label **Operator forecast**, never invented;
5. the stylesheet is restructured from desktop-first `max-width` queries to a phone-first base
   with `min-width` breakpoints at 768 px, 1024 px and 1440 px, and `main` widens to 1600 px, so a
   large viewport is a bounded multi-column grid rather than a narrow central strip.

`buildControlRoomSnapshot`, `requireControlRoomSnapshot`, the obstruction contract, the
fog-of-war contract, the pace and ETA policy and every published digest are unchanged; the
deviation is confined to the rendered document and to the new module.

**Falsifiers, pre-committed.** F1 *(amended in R1; see "Heartbeat truth, restated" below)*: a
tick carrying only heartbeats changes a rendered sentence, or `contentRevision` moves for any
reason other than the freshness lattice crossing its 30-second boundary. The original F1 — "a tick
carrying only heartbeats moves `contentRevision`" — was pre-committed against a claim that is
false, and the shipped product fires it; it is retracted rather than left standing.
F2: a bullet is displayed that the bound `snapshotRevision` alone does not support. F3: an
unverified `gaia-cli-progress/1` record fills the RESULT slot. F4: fresh, partial, stale and
unknown are not four distinct states each carrying a word and a symbol. F5: any byte of prose,
prompt, log, URL or credential reaches a bullet. F6: a percentage, ETA or confidence score that
is not copied from bound evidence appears in a bullet. F7: a self-consistent activity value from
another snapshot, instant or projection renders. F8: a large viewport still renders one narrow
column, or a phone viewport scrolls horizontally.

**Rejection criterion.** Roll back to inline rendering with no module if the module acquires a
clock, a provider, a network call, a filesystem read or any `effect` or `authority` other than
`NONE`; if a bullet is emitted that is not derivable from the bound snapshot; if heartbeat
inertness is satisfied by convention rather than by assertion; or if the `gaia-control-room/1`
body has to change to make any of it work.

**Reversibility: freely reversible.** Delete the module, its test, the renderer option and the
new sections. No schema migrates, no persisted evidence changes, no user data is transformed.

The extension is bound to Gaia base commit
`e4d242abe10118bc63244d5973077fb665724db9`, Git blob
`13785627547556fb44e963244141768613251dcc` for `src/control-room.mjs`, Git blob
`237e337cbbcd75d2a7508b0bcb1d4d97dff7cc6a` for `src/factory-telemetry.mjs`, Git blob
`82b7c1f441ede600f1a18fe774d4de22e844b70a` for `src/cli-progress.mjs`, and Git blob
`4b4c3f0f8a8aaa2047d9284ffc279868b23d3479` for
`docs/engineering-and-research-principles.md`.

Canonical receipt body:

```json
{"baseCommit":"e4d242abe10118bc63244d5973077fb665724db9","inputBlobs":{"cliProgress":"82b7c1f441ede600f1a18fe774d4de22e844b70a","controlRoom":"13785627547556fb44e963244141768613251dcc","engineeringPrinciples":"4b4c3f0f8a8aaa2047d9284ffc279868b23d3479","factoryTelemetry":"237e337cbbcd75d2a7508b0bcb1d4d97dff7cc6a"},"reversibility":"freely-reversible","schema":"gaia-decision-receipt/1","selectedDesign":"snapshot-bound-derived-control-room-activity-projection","status":"SELECTED"}
```

Receipt SHA-256:
`94fd98ebd41571aa49e0850609f30b909f3594d7960ee77d7f2fde92a2a787d5`.

This receipt selects an implementation candidate; it grants no runtime, publication or merge
authority and is not independent approval.

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

1. **Current run** — first, and largest. State, current stage or gate, elapsed work, the last
   verified transition, evidence freshness as its own labelled fact, and the next evidence
   checkpoint or blocker. Stored `RUNNING` state alone is insufficient, and a fresh ping is
   never shown as progress.
2. **Next action** — one closed action from the drain projection, or a stale-run check.
3. **Why the drain is not moving** — one named obstruction, the age of the evidence that named
   it, the items it affects and one bounded advisory recovery. An empty drain and a blocked drain
   never share a sentence.
4. **Verifiable progress** — named gates for each bounded lifecycle, and at most three
   deterministic activity bullets per live task: current verified action, most recent concrete
   result, next evidence checkpoint or blocker.
5. **Pace and ETA** — pace calibration as `n/5` comparable completed runs, a statistical ETA
   only where the evidence supports one, otherwise the exact missing evidence, and an
   **Operator forecast** only where a human explicitly supplied it.
6. **Portfolio backlog** — the aggregate blocked mix with its scope, as-of instant, total, count
   and percentage, stated as portfolio-wide and explicitly not blockers of the current run.
7. **Fog of war** — known, partial and unobserved evidence plus the next reconnaissance frontier.
8. **Proof** — the content-addressed control-room snapshot and source projection revision.

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

## Activity summary truth rules

- `summarizeControlRoomActivity({ snapshot })` in `src/control-room-activity.mjs` is pure, imports
  only `node:crypto`, and returns one deeply frozen `gaia-control-room-activity/1` value with
  `effect: NONE` and `authority: NONE`. It reads no clock, opens no file, calls no provider and
  spends no token.
- An item is summarized only when it is a live task: not terminal, and either occupying a lane
  (`CLAIMED` or `RUNNING`) or carrying an observed telemetry run. Aggregate portfolio blockers are
  not tasks and are counted in the Portfolio backlog section instead.
- Exactly three bullets per item, in fixed slot order. Slot 1 `ACTION` is what the task is doing
  now; slot 2 `RESULT` is the last **verified** transition, or the explicit `NO_VERIFIED_RESULT`
  absence; slot 3 is `BLOCKER` when a blocker exists and `CHECKPOINT` otherwise. The blocker
  displaces the checkpoint because `TRANSITIONS.BLOCKED` is empty — a blocked run admits no next
  transition, so naming one would be a fabricated expectation.
- An unverified source may never fill the RESULT slot. `gaia-cli-progress/1` is self-reported and
  unchained, so it may say what is happening and never that something was produced.
- `run.heartbeat` is named by no checkpoint, in any run state. It advances no state and produces
  no evidence, so offering it as something to wait for would invite an operator to read the next
  ping as progress.
- Every sentence comes from the closed phrasebook sealed into `machine.rulesRevision`; every
  interpolated value is a `TOKEN` matching `/^[A-Z][A-Z0-9_]{0,31}$/`. There is no field whose
  content originates outside a closed set, so chain-of-thought, prompts, terminal or provider
  logs, URLs, credentials and worker-authored prose have nowhere to live — by construction, not by
  filtering.
- The renderer refuses a supplied activity value whose own digests do not match its content, or
  which is not bound to this snapshot's `revision`, `observedAt`, `sourceRevision` and telemetry
  projection revision, or which names an item the snapshot does not carry. Internally consistent
  is not the same as about this evidence.
- Bullet ages are derived at render time from `snapshot.observedAt`. No age is stored, so a
  heartbeat-only tick changes **not one sentence**. `contentRevision` also covers the freshness
  lattice, which is clock-derived, so a tick that crosses the 30-second boundary moves
  `contentRevision` while every sentence stays byte-identical — including a tick carrying no new
  event at all, where only the clock advanced.

## Responsive layout rules

- The document is phone-first. The base stylesheet declares no multi-column
  `grid-template-columns`, so a viewport narrower than 768 px is one readable column with the
  Current run card first and nothing that can scroll horizontally: every grid child carries
  `min-width: 0`, every identifier wraps with `overflow-wrap: anywhere`, and wide content scrolls
  inside its own container rather than the page.
- `min-width: 768px` reflows to two columns for the metrics, backlog, pace and evidence panels
  while the hero stays stacked; `min-width: 1024px` opens the hero and the work list;
  `min-width: 1440px` widens `main` to 1600 px and expands the Current run facts and the work list
  to three columns, so a large desktop is a bounded multi-column grid and never a narrow central
  strip.
- Colour is never meaning. Every status carries a word and a symbol: `●` fresh or active, `◐`
  partial, `▲` stale or needs attention, `■` blocked, `○` unknown, unobserved or neutral.
- The one animation in the product remains `.heartbeat-pulse`, emitted only when the snapshot
  carries a genuinely fresh recorded heartbeat, and disabled entirely under
  `prefers-reduced-motion: reduce`. No keyframe is emitted at all when nothing is pulsing.

## Interfaces

`buildControlRoomSnapshot({ drainProjection, observedAt, sourceChangedAt, sourceChangedAtBasis,
progressObservations, completedRuns, telemetryProjection, dependencies })` is pure. It returns
one content-addressed `gaia-control-room/1` value carrying a nested, separately content-addressed
`gaia-portfolio-drain-obstruction/1`.

`classifyPortfolioDrainObstruction({ drainProjection, observedAt, windowStartedAt, liveness,
dependencies })` in `src/portfolio-drain-obstruction.mjs` is the obstruction truth Module. It is
pure, imports only `node:crypto`, and is usable without the control room.

`summarizeControlRoomActivity({ snapshot })` in `src/control-room-activity.mjs` is the activity
truth Module. It is pure, imports only `node:crypto`, and returns one content-addressed, deeply
frozen `gaia-control-room-activity/1` value carrying two digests: `revision` over the whole body,
and `contentRevision` over what the summary actually says. `requireControlRoomActivity(value)`
verifies one such value on its own terms, and is usable without the control room.

`renderControlRoomHtml(snapshot, { language, activity, operatorForecast })` returns one
dependency-free HTML document. It embeds no remote resource. Browser-side code only ages the
already displayed snapshot and stops a pulse when its heartbeat expires. `activity` is additive
and optional: when it is omitted the renderer derives the same value itself, and when it is
supplied it is verified for self-consistency and for binding to this exact snapshot before a
single bullet is displayed. `operatorForecast` is the only way a human forecast can appear; it is
a bounded plain sentence, rendered under its own **Operator forecast** label, excluded from the
statistical ETA, and never invented when absent.

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

# R4 review-repair decision — decided before repairing anything

Four independent reviews of the progress and ETA UX slice — Standards, Spec, a responsive and
accessibility adversary, and an epistemic and security adversary — all returned `REQUEST_CHANGES`.
Their blocker union is repaired here. Each finding was replayed against the shipped code before it
was accepted, and every repair below was written into this document before the code changed.

The reviews are advisory evidence, not authority. Where a finding is accepted, the mechanism is
named; where one is narrowed or declined, the reason is recorded in the same place.

## Blocker union, and the mechanism chosen for each

### U1 — heartbeat inertness is asserted unconditionally and is true only inside the window

*Standards B1, epistemic FINDING 4.* `contentRevision` digests `{ items, machine }`; each item
carries `evidenceState`, which is derived from `activity.state`, which is pure clock arithmetic
against a 30 s window. So a tick whose only new event is a heartbeat — and even a tick with **no**
new event, where only the clock advanced — moves `contentRevision` whenever the tick crosses the
freshness boundary. The existing gate pinned both of its ticks inside the window and then asserted
that the state had not changed, which is a demonstration that cannot fail.

**Two resolutions were offered and both are acceptable to the reviewers.** Taken: **narrow the
claim to what is true, and gate the boundary.** Excluding `evidenceState` and the liveness sort key
from `contentRevision` would make the unconditional sentence true, but it would also make the
digest silent about a state change an operator cares about, and it would move a published digest
for every consumer — a migration bought to rescue a sentence.

The claim now reads, in the module, in the truth rules and in the README:

> A tick whose only new events are heartbeats changes **not one sentence**. `contentRevision` also
> covers the freshness lattice, which is clock-derived, so a tick that crosses the 30-second
> boundary moves `contentRevision` while every sentence stays byte-identical.

Gated three ways: sentences are byte-identical across a heartbeat-only tick **inside** the window
and across one that **crosses** it; `contentRevision` is stable in the first case and moves in the
second.

**Correction, recorded in R1.** At R0 this section overstated its own closure. The narrowed claim
reached the module docstring only; `README.md`, the two-digests narrative, the truth rule under
"Bullet ages" and falsifier F1 kept the retracted wording, and none of the three gates named above
was written — `tests/control-room-activity.test.mjs` was byte-identical to the entry commit. An
independent Spec review reproduced both facts. The propagation and the gates land in **R1.1**
below, which also records why the existing inside-window assertion is kept rather than replaced:
it is the true half of a two-sided claim, and the boundary gates are the half that was missing.

### U2 — two divergent orderings decide which run is "the current run"

*Standards B2.* `renderCurrentRun` takes `activity.items[0]`; the work list sorts the same items
with a different comparator that adds a lifecycle-percentage key and uses `localeCompare` where the
activity module uses ordinal comparison. The same page can name `issue-3` the current run and
`issue-7` the highest-priority work.

**Repair:** one canonical ordering, exported from `src/control-room-activity.mjs` as
`compareControlRoomItems` and used by both. The lifecycle-percentage key is dropped rather than
added to the other side: it ranks a `RUNNING` item above a `CLAIMED` one for a reason that has
nothing to do with liveness, and the activity module's order is the one that decides the Current
run card today.

### U3 — the activity verifier is not total

*Standards B3 and B4, spec BLOCKER 3, epistemic FINDING 2.* Four separate holes with one shape:

- `interpolate` substitutes on `Object.hasOwn` alone, so a `params.stage` outside `STAGE_SENTENCES`
  interpolates the literal string `undefined` and the verifier accepts a sentence the producer can
  never emit. The renderer's copy of the same rule already guards it — one rule, two
  implementations, two behaviours.
- `ACTION_CODES[runState]`, `RESULT_CODES[event]`, `CHECKPOINT_CODES[runState]` and
  `TEMPLATES[code]` are plain-object lookups that reach `Object.prototype`, so a resealed snapshot
  whose `runState` is `constructor` skips the `undefined` guard and throws a raw `TypeError`
  instead of a typed refusal. `lastTransition: null` passes validation and then crashes the
  renderer.
- `requireControlRoomActivity` never inspects `evidenceRevision` or `observedAt`, so a resealed
  summary carries attacker-chosen free text — a URL, a local path, key-shaped material — to the
  operator's screen through fields the closed-phrasebook claim does not cover. HTML escaping holds
  and there is no injection; this is a content-provenance failure, not a script hole.
- `summarizeItem` copies `repository`, `itemId`, `itemNumber`, `drainState`, `runId`, `lane` and
  `agent` out of the snapshot unvalidated, while the module's docstring and the truth rules claim
  **no** field originates outside a closed set.

**Repairs, in the order they close:**

1. `interpolate` refuses to substitute an `undefined` value, matching the renderer exactly.
2. The four lookup tables become null-prototype frozen maps, so a prototype key is not a vocabulary
   member. `requireControlRoomSnapshot` additionally refuses a telemetry `runState` or
   `lastTransition.event` outside its closed vocabulary, and refuses a missing `lastTransition`
   where the renderer dereferences one.
3. `requireControlRoomActivity` constrains `evidenceRevision` to 64 hex characters, the literal
   `UNKNOWN`, or `null`, and `observedAt` to an exact ISO instant or `null` — and refuses one dated
   after the summary's own observation instant, which is the producer's rule the verifier was
   missing.
4. The identity fields are **bound rather than pattern-matched**: `requireActivity` at the render
   seam already holds the matching snapshot item, so `repository`, `itemNumber`, `drainState`,
   `runId`, `lane` and `agent` must equal that item's values exactly. Pattern-matching them would
   have invented a vocabulary; binding them uses the one already in hand.
5. The two claims are narrowed to the bullets they are true of, in the module docstring and in the
   truth rules, and the item identities are described as snapshot-bound rather than closed.

### U4 — future and unparseable evidence renders as `0s ago`

*Epistemic FINDING 3.* `bulletAge` subtracts and `formatDuration` clamps negatives to zero, so
evidence stamped in the year 2999 renders as `0s ago` — the single most reassuring reading
available, and the exact defect class `sourceChangedAtBasis` was built to eliminate one commit
earlier. An unparseable instant renders `NaNs ago`.

**Repair:** the verifier refuses a future-dated instant (U3.3), and `bulletAge` names an incoherent
or unparseable instant instead of clamping it. Defence in depth on purpose: the refusal is the
barrier, and the renderer stops producing a reassuring number even if something reaches it.

### U5 — the dashboard adapter's alias guard is a spelling test

*Spec BLOCKER 2, epistemic FINDING 1, confirmed destructive.* `scripts/factory-dashboard.mjs`
compares `resolve()`d strings, which normalise separators and `..` but not case, 8.3 short names,
junctions or UNC spellings. On the declared platform this accepted
`--projection …/projection.json --snapshot-out …/Projection.json` and **overwrote the input drain
projection with the snapshot**. The correct guard already ships twice in this tree, in
`scripts/factory-dashboard-refresh.mjs` and, with its reasoning written out, in `src/inventory.mjs`.

**Repair:** lift `pathIdentity` into `src/path-identity.mjs`, one definition, and use it from both
adapters for both the outputs-must-differ and the output-aliases-input checks. Lifting rather than
copying is the point — a third copy of a rule two copies already disagreed about is the defect.

### U6 — one long token scrolls the page sideways at every viewport

*Spec BLOCKER 1, responsive 3.1.* `overflow-wrap: anywhere` is declared on `code` alone. A CI-run
URL in an issue title, a 140-character `org/repo`, or a maximum-length gate token in the Current
run card's checkpoint sentence pushes `documentElement.scrollWidth` to 756, 778, 1091 and 2761 px
at 375, 800, 1440 and 1920 px viewports. The shipped assertion checks only that the substring
`overflow-wrap: anywhere` appears somewhere in the base stylesheet, so it passes on a rule scoped
to `code`.

**Repair:** declare the wrapping on `body`, which every rendered string inherits, and keep the
`code` rule. The gate is replaced with one bound to the elements that actually carry
operator-authored strings, over a fixture whose title, repository and gate token are long unbroken
tokens.

**Stated honestly:** no headless browser measurement was run in this lane. The repair is verified
structurally — the declaration is on an ancestor of every operator-authored string, and no rule
overrides it — and a browser re-measurement of the four viewports remains the reviewer's evidence
to reproduce, not this lane's.

### U7 — the artifact replaces itself every five seconds with no way to stop it

*Responsive 3.2.* `<meta http-equiv="refresh" content="5">` is emitted unconditionally in both
languages. The DOM, its `role="status"` live regions and any assistive-technology virtual buffer
are destroyed and rebuilt every 5.00 s, and the page offers zero controls. This fails WCAG 2.2
SC 2.2.1 (Level A), whose real-time exception does not apply to a dashboard whose interval could be
a control. It is documented nowhere.

**Repair, both halves of "remove or make controllable":**

- The meta refresh is **removed**. The default document does not reload itself at all.
- Auto-refresh becomes opt-in — `renderControlRoomHtml(..., { autoRefreshSeconds })` and
  `--refresh-seconds` on the adapter — and the opt-in path is implemented as a script-driven
  reload with a real, visible, focusable **Stop auto-refresh** button that cancels it. A meta
  refresh cannot be cancelled once parsed, which is precisely why it is the wrong mechanism for a
  control the standard requires to exist.

### U8 — local wmux work stays separate from GitHub backlog

The subject of this slice's own amendment, above. Local lanes enter no portfolio structure: not
`items`, not `blockers`, not `capacity`, not the obstruction, not pace and not ETA.

## Findings recorded and not repaired here

- **Spec residual, `requireProjection` does not re-run `requireItem`** — pre-existing, out of this
  slice's scope, and noted by the pair as the hole a "synthesize a LOCAL_WMUX item" shortcut would
  fall through. Staying on the selected seam keeps it closed; `itemKind` is not widened.
- **Responsive 3.3, the French document's landmark name is hardcoded English** — accepted as real.
  Repaired for the new section only, whose `aria-label` is translated; the pre-existing English
  landmark on `metrics` is left for its own slice rather than widened into this diff.
- **Responsive 3.4, the progress meter has no accessible name**, and **3.5, the backlog silently
  drops kinds past the eighth** — accepted as real, not repaired here. Both are pre-existing and
  neither is in the blocker union the operator asked to close.
- **Standards L1, inconsistent `?.` guarding around a missing `activity`** — closed as a
  side-effect of U3.2, which validates the field rather than guarding at each use.

# R1 — the two blockers an independent Spec review reproduced

Entry commit `45e988fe63394e759dc4dc08c9cc052ed1fd8523`. The Standards review of R0 returned
APPROVE; the Spec review returned REQUEST_CHANGES on exactly two findings, each reproduced against
the shipped modules before it was accepted here, and each reproduced again in this lane before a
line of repair was written. Everything below was written before the code changed.

The scope is those two findings and nothing else. No bus verb, authority, effect, network call,
retry, clock source, provider, install or configuration surface is added, widened or renamed by
this repair, and the LOCAL_WMUX sensor stays separated from the GitHub portfolio exactly as U8
left it.

## R1.1 — Heartbeat truth, restated everywhere it was stated wrongly

*Spec review section 4. The successor of U1, which narrowed the claim in one place and left three
others standing.*

**What was actually wrong.** U1 chose the right resolution and applied it to one location.
`src/control-room-activity.mjs` carried the narrowed claim; `README.md`, the narrative under
"The value carries two digests", the truth rule under "Bullet ages", and the pre-committed
falsifier F1 all still carried the retracted one. A reader keying on any of those four read the
same false invariant they read before, and the R0 repair section asserted a closure a reader could
disprove with one `git diff`. That is worse than the original defect: an uncorrected claim is a
mistake, and a claim documented as corrected while still false is a claim nobody will check again.

**The claim, in the one wording now used in every normative location:**

> A tick whose only new events are heartbeats changes **not one sentence** — every bullet kind,
> code, parameter and text is byte-identical. `contentRevision` also covers the freshness lattice,
> which is clock-derived, so a tick that crosses the 30-second boundary moves `contentRevision`
> while every sentence stays byte-identical.

Reproduced against the shipped kernel at the entry commit, with the last heartbeat at
`18:40:10.000Z` and nothing else changing:

```
observedAt 18:40:40.000Z  age 30000ms  evidenceState FRESH
observedAt 18:40:40.001Z  age 30001ms  evidenceState STALE
sentences byte-identical : true
contentRevision stable   : false
```

**The digest recipe is deliberately not changed.** Dropping `evidenceState` from
`contentRevision` would make the shorter sentence true, and would buy it by making a published
digest silent about a state change an operator reads off the page — and by moving that digest for
every existing consumer. A migration bought to rescue a sentence is the wrong trade; the sentence
is corrected instead.

**Gates, and what each one is for.** Four assertions and one witness, in
`tests/control-room-activity.test.mjs`:

1. **The boundary is exact and inclusive, on a clock-only tick.** Two summaries one millisecond
   apart over identical evidence and no new event at all: 30000 ms is `FRESH`, 30001 ms is
   `STALE`, every sentence is byte-identical, and `contentRevision` **moves**. This is the
   assertion the retracted claim would have failed.
2. **A heartbeat-only tick that crosses the boundary** — the tick's only new event is a
   `run.heartbeat` — likewise changes no sentence and moves `contentRevision`.
3. **A heartbeat-only tick inside the window** keeps `contentRevision` byte-identical, so the
   claim is bounded in both directions rather than merely permissive. A digest that moved on every
   tick would fail this one; a digest that never moved would fail 1 and 2.
4. **Mutation witness, mechanism-revert.** A one-expression mutant that excludes `evidenceState`
   from `contentRevision` — the resolution this document declined — makes the boundary-crossing
   digest stable. If gates 1 and 2 passed under that mutant they would be testing nothing about
   the lattice; they fail under it, which is what makes them non-vacuous.
5. **A truth gate over the prose itself.** `README.md`, this document and the module are read as
   text; the retracted phrasings are asserted absent and the narrowed one asserted present in
   each. The defect this repair closes was a documentation defect, so the gate that keeps it
   closed has to read documentation. This gate is RED at the entry commit.

**Falsifiers for this repair.** R1.1-F1: any shipped normative text asserts that a heartbeat-only
or clock-only tick cannot move `contentRevision`. R1.1-F2: a boundary-crossing tick changes a
rendered sentence. R1.1-F3: a tick inside the window moves `contentRevision`.

## R1.2 — `localLanes.observationRevision` is provenance, and is re-derived

*Spec review section 5. Introduced by R0.*

**What was actually wrong.** `requireLocalLanes` re-derives the whole lane block and compares
canonical JSON, which is why twenty-three resealing forgeries met twenty refusals. One field
escaped: `observationRevision` was checked only for `typeof … === 'string'` and was then fed back
into the derivation as its own expected value, so the comparison could not disagree with it. A
resealed snapshot therefore carried arbitrary free text — a URL, a local path, key-shaped
material, a fabricated progress sentence — into the LOCAL_WMUX evidence line an operator reads as
the identity of the observation this page was built from. Reproduced at the entry commit: seven
such values, seven acceptances, seven renders.

**This is provenance, not injection.** `escapeHtml` holds at every interpolation and no markup
escapes; the failure is that a field presented as the identity of the evidence was not bound to
the evidence. That is the class `requireControlRoomActivity` already closes on `evidenceRevision`
in this same commit, and the class U3 was raised to close. One rule with two implementations and
two behaviours is the alias-guard shape `src/path-identity.mjs` exists to eliminate.

**Repair: re-derive, do not pattern-match.** The field is fully determined by the block the
snapshot already publishes. Confirmed at the entry commit:

```
published observationRevision : 0a185bdb0b2889d64649cb1768e8129562ee45e808d294817b1d502bcd69969d
re-derived from the block     : 0a185bdb0b2889d64649cb1768e8129562ee45e808d294817b1d502bcd69969d
```

So `src/local-lane-observation.mjs` — the module that owns the schema, and the only module that
may own its digest recipe — exports that recipe as `localLaneObservationRevision({ observedAt,
lanes })`, and `sealLocalLaneObservation` is rewritten to call it. **One recipe, one
implementation**: adding a second hasher in the control room would have reproduced the very defect
being repaired. `requireLocalLanes` then re-derives the revision from `block.observedAt` and
`block.lanes` — projected to the seven observation fields, so the derived `live` flag is excluded
— refuses a published value that disagrees, and passes the *derived* value into the block rather
than the published one.

A pattern check (`/^[a-f0-9]{64}$/`, as the sibling module applies to `evidenceRevision`) was
considered and rejected as the weaker of two available repairs: it would still accept sixty-four
wrong hex characters as the identity of this evidence. Re-derivation refuses those too. The
sibling module keeps its pattern check because `evidenceRevision` names evidence the summary does
not carry and therefore cannot rebuild; this block carries its own lanes.

**Gates, and what each one is for.** In `tests/control-room-local-lanes.test.mjs`:

1. **T20 — free text is refused at both public seams.** Seven forged revisions — a URL, a path, a
   fabricated progress sentence, markup, a bidi override, the empty string, and sixty-four wrong
   hex characters — are each refused by `requireControlRoomSnapshot` and by
   `renderControlRoomHtml` with a typed `ControlRoomError` / `InvalidSnapshot`, and none of the
   seven strings reaches a rendered document.
2. **T20 honest positive control.** The unedited snapshot still verifies and still renders its
   revision, for one lane, for several lanes, for a withheld label and for a stale block. A
   verifier that refused everything would pass gate 1 and fail this one; without it, gate 1 proves
   nothing.
3. **T20 binding, not merely well-formedness.** The honest revision of a *different* lane set — a
   real digest, correctly derived, of the wrong evidence — is refused when spliced into this
   block. This is what separates re-derivation from a pattern check.
4. **T20 MECHANISM REVERT.** A one-expression mutant that removes the new comparison accepts the
   free-text forgery and renders it. The gate therefore tests the mechanism rather than passing
   for an unrelated reason.

**Falsifiers for this repair.** R1.2-F1: any string that is not the digest of the published block
is accepted in `observationRevision`. R1.2-F2: an honest snapshot is refused. R1.2-F3: the control
room grows a second implementation of the observation digest recipe.

**Rejection criterion.** Revert R1.2 if re-derivation ever refuses an observation the sensor
itself sealed — that would mean the two implementations had drifted, which is exactly the failure
this repair is shaped to make impossible.
