# Factory control room R0

## Operator problem

Gaia already emits exact portfolio observations, replayable drain receipts and redacted CLI
progress. Those records are useful evidence but do not answer the operator's first questions
without manual reconstruction: what is actually moving, what is stale, what happens next, and
whether a percentage or ETA is grounded in comparable evidence.

The control room is a read model over those existing contracts. It is not another workflow
engine, database, authority surface or source of truth.

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
  the current run's elapsed time. The UI always displays the sample size and method.
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

Raw `gaia-cli-progress/1` JSONL is accepted only when exactly one drain item is active. With
multiple active items, each line must use the explicit
`gaia-control-room-progress-observation/1` envelope carrying `itemId`, `capturedAt` and the
original `record`; otherwise the adapter refuses the ambiguous attribution.

## What R0 does not claim

R0 does not invent a project-wide Gaia completion percentage, infer completion from agent text,
or promise an ETA from provider timeout bounds. It does not yet persist a history of comparable
cycles; callers may supply that existing evidence as a JSON array. It also does not host the
HTML. A local file viewer, wmux browser or separately governed static host may display the
artifact without widening Gaia's stdio-only core.
