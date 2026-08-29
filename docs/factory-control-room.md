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

## Default view

Every visible element answers one operator question:

1. **Now** — active, stale or paused. Stored `RUNNING` state alone is insufficient.
2. **Next action** — one closed action from the drain projection, or a stale-run check.
3. **Verifiable progress** — named gates for each bounded lifecycle.
4. **Pace and ETA** — measured evidence, its sample size, or an explicit unknown.
5. **Proof** — the content-addressed control-room snapshot and source projection revision.

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
- `effect` and `authority` are both `NONE`. This module cannot start a lane, spend a grant,
  publish, merge, assign, label or mutate GitHub.

## Interfaces

`buildControlRoomSnapshot({ drainProjection, observedAt, sourceChangedAt,
progressObservations, completedRuns })` is pure. It returns one content-addressed
`gaia-control-room/1` value.

`renderControlRoomHtml(snapshot)` returns one dependency-free HTML document. It embeds no
remote resource. Browser-side code only ages the already displayed snapshot and stops a pulse
when its heartbeat expires.

`npm run factory:dashboard` is the filesystem adapter. It accepts either an existing exact
drain projection or a portfolio plus optional receipt and hold arrays, writes replaceable
derived JSON/HTML outputs and can poll the input files from 1 through 60 seconds. It opens no
network listener. English is the default; `--language fr` selects the optional French renderer.

`npm run factory:dashboard:refresh -- ...` is the explicit GitHub refresh Adapter. Each tick
performs one fresh, read-only organization survey, reconciles the resulting portfolio through
the same drain Module, prepares portfolio/snapshot/HTML artifacts off-path, then replaces the
three caller-owned outputs with the self-contained HTML last. The default is one tick, suitable
for a scheduler. `--watch-ms 30000` enables a visible sequential watch from 10 through 300
seconds: ticks never overlap, a failed tick is reported and retried, and the last valid HTML is
left in place. The Adapter grants no authority and performs no GitHub mutation.

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
than assume directory-wide atomicity.

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
