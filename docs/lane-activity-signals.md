# Lane activity signals R0

Status: shipped contract for issue #214. This document grants no authority, starts no lane and
approves nothing.

## Operator problem

The local lane observation answers two questions about a pane: is the process alive
(`lifecycle`, from `wmux agent list`), and does the bound artifact prove the work is done
(`taskStates`, [artifact completion signals](artifact-completion-signals.md)). It cannot answer
the third question an operator with nine Claude Code panes open actually asks: **is this pane
waiting for me?**

wmux already knows. Its Claude Code hooks (`wmux-hook.js` on `UserPromptSubmit`, `Stop`,
`Notification` and the tool events), the `wmux report-agent --blocked | --unblocked | --run-start |
--run-end` reports, and its screen-detection manifests all feed one state per surface, readable
in one call:

```text
wmux agent-state
{ "states": [{ "surfaceId": "surf-…", "state": "working" | "idle" | "blocked", … }],
  "blocked": [ … ], "identified": [ … ] }
```

The idea is the one `agentd` (github.com/clickety-clacks/agentd) applies to a Linux desktop:
activity comes from the agent's own hooks, never from CPU or elapsed time, and `unknown` is not
`idle`. Here the producer already exists, so Gaia's whole job is to read it honestly.

## Design It Twice

The load-bearing question is who writes the fact.

1. **Read wmux's own state — selected.** One more frozen, read-only wmux call at the sensor's
   existing process boundary. wmux stays the only producer, and Gaia restates two fields of it.
2. **A Gaia hook or Claude Code mod writing one claim file per surface — rejected.** It would be
   a second producer of a fact wmux already produces. The two would disagree after a missed
   event, and the page would have to pick one without evidence for either.
3. **The interagent bus `heartbeat` verb — rejected.** The bus is a durable append-only log that
   `npm run verify` replays. A claim per turn would grow it with no coordination value, a
   heartbeat names a registered actor rather than a wmux surface, and its note is untrusted text.

## Normative contract

`gaia-local-lane-observation/1` gains one optional top-level array, `activityStates`. It is
present only when the sensor ran with `--activity agent-state` **and** that read succeeded.

Each entry has exactly these seven fields:

| Field | Meaning |
| --- | --- |
| `workspaceId`, `paneId`, `surfaceId`, `agentId` | The lane it describes, verbatim from that lane. |
| `processLifecycle` | The lane's own `lifecycle`, restated so the axes can be read together. |
| `activity` | `WORKING`, `IDLE`, `NEEDS_OPERATOR` or `UNKNOWN`. |
| `activityReason` | Why, from the closed table below. Each reason names exactly one activity. |

| `activityReason` | `activity` | When |
| --- | --- | --- |
| `WMUX_WORKING` | `WORKING` | The lane is running and wmux reports exactly one record, `working`. |
| `WMUX_IDLE` | `IDLE` | The lane is running and wmux reports exactly one record, `idle`. |
| `WMUX_BLOCKED` | `NEEDS_OPERATOR` | The lane is running and wmux reports exactly one record, `blocked`. |
| `NO_CLAIM` | `UNKNOWN` | The lane is running and wmux reports no record for its surface. |
| `UNRECOGNISED_CLAIM` | `UNKNOWN` | The one record's `state` is outside the exact map. |
| `CONFLICTING_CLAIMS` | `UNKNOWN` | More than one record names the surface, even if they agree. |
| `SURFACE_UNKNOWN` | `UNKNOWN` | The lane is running but its surface is the `UNKNOWN` sentinel. |
| `PROCESS_NOT_RUNNING` | `UNKNOWN` | The lane's lifecycle is not `RUNNING`, whatever wmux said. |

`NEEDS_OPERATOR` is spelled for the reader of the page rather than borrowed from wmux's
`blocked`, because a blocker already means something in this product's portfolio and the two
must never be read as one another.

### What the verifier enforces

Every refusal is a refusal to display, never a repair.

- The axis is an array, never `null`. An absent axis omits the key.
- There is exactly one entry per observed lane, in strictly ascending lane order, and no entry for
  anything else. A resealed observation can neither invent a waiting pane nor hide one.
- Fields are closed, identities are bounded, and `activity` is in the vocabulary.
- `activityReason` names `activity`. A null-prototype table means `constructor` names nothing.
- `processLifecycle` and `paneId` are the ones the named lane reported.
- `PROCESS_NOT_RUNNING` appears exactly when the lane is not running.
- `SURFACE_UNKNOWN` appears exactly when a running lane has the sentinel surface.

The observation `revision` recipe is **not** widened to cover the axis, for the reason it was
not widened for `taskStates`: the control room re-derives that revision from the lanes alone.
The axis therefore carries no content address of its own. Its entries are fully determined by
the lanes plus wmux's claims, and the verifier checks everything that can be checked without
those claims.

## What the sensor reads, and what it never reads

From each `agent-state` record the sensor reads `surfaceId` and `state`, by name, and nothing
else. It never spreads a record or walks its keys, so these never reach the observation:

- `blockedReason`, `choices` and `metadata`: free text an agent or a tool wrote;
- `sessionId`: an identity this observation has no use for;
- `updatedAt`, `blockedSince` and `answeredAt`: instants that would become an age or a pace.

The argv is `WMUX_ACTIVITY_ARGV`, the frozen constant `['agent-state']`. It is made only under
`--activity agent-state`, whose single legal value names that call, so no flag value reaches the
argv. It runs without a shell and with no `--surface` filter, under the same timeout and output
bound as `agent list`. The sensor still cannot construct `report-agent`, `answer-agent` or
`release-agent`.

## Failure semantics

This is the one wmux read that does **not** fail the tick. Lifecycle is still truthful without
it. So an `agent-state` call that errors, exits non-zero, prints nothing, prints non-JSON, or
returns no exact `states` array of records:

- omits `activityStates` entirely,
- still writes the lane observation, and
- names the reason on the summary line: `| activity not observed: wmux agent-state …`.

An absent axis means "not observed". A present axis full of `UNKNOWN` means "observed, and
nothing was claimed". The two are never confused, and neither of them is ever published as `IDLE`.

## Display only

Activity is display evidence. It is not:

- an approval request;
- a permission;
- a portfolio blocker;
- a liveness proof;
- an input to any decision.

This matches `ARCHITECTURE.md`, which already says delivery metrics measure "accepted
transitions and receipts, not … lane activity". A negative-control test refuses any `src/` module
other than the schema and the sensor that names `activityStates`, `NEEDS_OPERATOR` or
`WMUX_BLOCKED`. A later rendering slice must amend that gate deliberately, not slip past it.

## Known limits, stated rather than hidden

- **The claims are wmux's, not Gaia's.** Gaia restates them. It does not verify that an agent is
  really waiting.
- **A `blocked` state never expires in wmux.** wmux's own detection manifest says so. Gaia
  publishes what wmux says as of the observation instant and derives no elapsed time, so a stale
  `blocked` reads as `NEEDS_OPERATOR` until wmux clears it.
- **Screen detection is one of wmux's sources.** The Gaia sensor still reads no screen. It
  consumes one closed token wmux derived, and the derivation is wmux's responsibility.
- **The join is by surface.** Two running lanes that report one surface both receive that
  surface's claim. wmux has not been observed to do this.

## What the control room does with the third axis: nothing, yet

`projectLocalLanes` verifies the observation, so it accepts the new field. It then derives the
lane block from the seven lane fields it always used. A gate compares the renderings with and
without the axis byte for byte, and asserts that no activity token reaches the snapshot. A
control-room column is the next slice.

## Running it

```bash
node scripts/local-lane-sensor.mjs --out state/lanes.json --activity agent-state
npm run lanes:watch -- --lanes-out state/lanes.json --activity agent-state --projection … --html-out …
```

## Falsifiers

`tests/local-lane-activity.test.mjs` holds the gates. Each one names what would break it:

- **Exact map.** Case folding, prefix matching or `null` fails it.
- **Two named reads.** A record whose other fields throw when touched fails it if the derivation
  ever reads one. A leak marker in every other field fails it if anything travels.
- **Enrichment only.** A claim for an unobserved surface fails it if it creates or resurrects a
  lane.
- **Verifier.** Fifteen resealed mutations fail it if any is accepted.
- **Opt-in.** Without the flag, exactly one wmux call is made. With it, exactly two are made, in
  order.
- **Failure semantics.** Each of four failure shapes fails it unless the axis is omitted and the
  lanes are written.
- **Display only.** Any other `src/` module naming the axis fails it.
- **Control room, T24 in `tests/control-room-local-lanes.test.mjs`.** No rendered byte changes.
