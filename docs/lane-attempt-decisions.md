# Lane-attempt decisions

Status: a pure decision core (#180). It decides; it stops, releases, sends and retries nothing, and
it grants no authority. Porting the runner and adding lane-net transitions stay on #103.

Architect R3 found three durable-execution semantics missing from the lane runner:

- a per-attempt deadline;
- a heartbeat timeout;
- a compensation record when an attempt ends without completing.

`src/lane-attempt.mjs` decides them over the lane lifecycle net that already ships
(`LANE_NET_TEMPLATE` in `src/drain-petri-net.mjs`), before any runner is ported.

## The two calls

```js
decideLaneAttempt({ attempt, observation, now })   // from a snapshot
replayLaneAttempt({ attempt, events, now })        // from the attempt's event log
```

| Input | Fields |
| --- | --- |
| `attempt` | `laneId`, `attemptNumber`, `startedAt`, `deadline`, `heartbeatTimeoutMs` |
| `observation` | `heartbeat`: `null` or `{ at, step }` with `step` `L<n>`; `markerSeenAt`: `null` or an instant; `abortOrderedAt`: `null` or an instant |
| `events` | `{ kind: 'HEARTBEAT', at, step }`, `{ kind: 'MARKER', at }` or `{ kind: 'ABORT', at }`, in any order, at most 65,536 |
| `now` | the caller's instant. The module reads no clock. |

Instants are ISO-8601 UTC, to the second or the millisecond.

- **Before the start.** A heartbeat or an abort order observed before the attempt's start counts
  at the start. Clock skew between the lane and the coordinator therefore never stops the deadline
  or the timeout from deciding, and an abort ordered before the attempt started aborts it as it
  starts.
- **A marker before the start** was left by an earlier attempt, for instance one that wrote its
  marker and then exited non-zero. It never completes this attempt. The decision reports it as
  `staleMarkerAt` (in a log, the first such marker), whatever it decides. The module cannot tell a
  leftover marker first seen after the start from a new one, so the caller scopes markers to the
  attempt or removes them before starting the next.
- **After `now`.** An observed instant after `now` is refused. Read the observation or the log
  first, then take `now`.
- **Read once.** Every input field is read once, so what is validated is what is decided.

## Which event decides

Each terminal decision has an instant:

| Decision | Its instant |
| --- | --- |
| `ABORTED` | the abort order |
| `DEADLINE_EXCEEDED` | the deadline |
| `HEARTBEAT_TIMEOUT` | the last heartbeat (the start, before any) plus the timeout |
| `COMPLETE` | the completion marker |

Among the instants at or before `now`, **the earliest decides**. If none has come, the decision is
`CONTINUE`, and `nextDueAt` says when the deadline or the heartbeat expiry falls due.

- **Boundaries are inclusive.** At the deadline instant the attempt is out of time. A heartbeat
  landing exactly at the expiry of the one before it is too late.
- **Equal instants** resolve in `LANE_ATTEMPT_PRECEDENCE` order: `ABORTED`, `DEADLINE_EXCEEDED`,
  `HEARTBEAT_TIMEOUT`, `COMPLETE`. An order or a limit is honoured before a completion is accepted,
  so a marker written at the deadline instant does not complete the attempt.
- **A snapshot holds only the last heartbeat.** For one snapshot, asking later gives the same
  decision once every instant is past. But a later heartbeat replaces an earlier one, and with it
  a timeout that had already fallen due.
- **The log keeps it.** `replayLaneAttempt` judges each observed instant before folding in its
  heartbeat. Events of one instant are judged together, so ties keep their precedence, whatever
  their order in the log. Of several heartbeats that count at one instant, the one seen last
  stands (heartbeats moved up to the start keep their order), and of those seen at once, the
  highest step. The first terminal decision stands. So for one log, every `now` from the instant a
  decision fell due gives that same decision, however rarely the caller asks.
- **Persist the first terminal decision.** That promise holds only while events land in the order
  of their instants. The bus stamps an event before it takes the log lock
  (`src/mcp-server.mjs`), so a slow writer can land a heartbeat stamped 7:59 after a replay at 8:00
  has already timed the attempt out, and a later replay then continues it. The caller persists the
  first terminal decision it acts on and never derives it again, after a restart included.
- **The log is bounded.** A log of more than 65,536 events is refused whole, the deadline
  included. Size the heartbeat interval to the attempt: a heartbeat every second fills the bound in
  about 18 hours, one every five seconds in about 91.
- **Late markers.** A marker that arrives after the attempt has already ended is reported as
  `lateMarkerAt`, never read as completion.

## What the net can carry

In the shipped net an attempt leaves `L_ATTEMPT_RUNNING` only through an observed exit
(`T_EXIT_ERROR`, `T_EXIT_CLEAN`), and a running attempt cannot be aborted.

| Decision | Lane-net transition |
| --- | --- |
| `CONTINUE` | none: the attempt stays in `L_ATTEMPT_RUNNING` |
| `COMPLETE` | `T_EXIT_CLEAN` |
| `DEADLINE_EXCEEDED` | none yet: listed in `UNMAPPED` |
| `HEARTBEAT_TIMEOUT` | none yet: listed in `UNMAPPED` |
| `ABORTED` | none yet for a running attempt: listed in `UNMAPPED` |

`T_EXIT_CLEAN` still fires only on its own receptivity, an `exit=0` heartbeat. The module never
sees the exit code. After `COMPLETE`, the caller keeps watching for the exit, and a provider that
wrote its marker and then exits non-zero leaves through `T_EXIT_ERROR`.

A test compares this map with `LANE_NET_TEMPLATE`, reading each arc by its place whether it is
written as a name or as `{ place, weight }`. If a transition out of `L_ATTEMPT_RUNNING` is added
later, the test fails until the transition is mapped and `UNMAPPED` shrinks.

## The decision

Each call returns a frozen `gaia-lane-attempt-decision/1` record:

| Field | Meaning |
| --- | --- |
| `laneId`, `attemptNumber`, `decidedAt` | the attempt, and the caller's `now` |
| `decision`, `decisiveAt` | one of the five decisions, and the instant that decided it (`null` for `CONTINUE`) |
| `transition` | `T_EXIT_CLEAN` for `COMPLETE`, otherwise `null` |
| `nextDueAt` | for `CONTINUE`, the earlier of the deadline and the heartbeat expiry |
| `staleMarkerAt` | a marker observed before the start, which never decides |
| `compensation` | the record below, for every terminal decision other than `COMPLETE` |

## The compensation record

Every terminal decision other than `COMPLETE` carries a `gaia-lane-attempt-compensation/1` record.
The record names the work; the caller does it.

| Field | Meaning |
| --- | --- |
| `decision`, `decisiveAt` | what ended the attempt, and when |
| `lastStep`, `lastHeartbeatAt` | the last `L<n>` step the attempt reported, and when it counted |
| `lateMarkerAt` | a marker that came too late to count |
| `undo` | `STOP_ATTEMPT_PROCESS`, because the provider process may still run. `RELEASE_LANE_SLOT`, only for an unmapped decision. Then `DISCARD_UNVERIFIED_OUTPUT`, or `QUARANTINE_LATE_OUTPUT` when a late marker exists: keep that output aside for a person, never as the attempt's result. |
| `releaseSlotUnless` | `T_EXIT_CLEAN` and `T_EXIT_ERROR`, the exits that return a running attempt's `LANE_SLOTS` token. Release the slot only if neither fires for this attempt, so it goes back once. |
| `report` | `SEND_LANE_ABORTED` after an abort (the net's `L_LANE_ABORTED_SENT`), otherwise `ESCALATE_TO_COORDINATOR` |

## Refusals

Input the module cannot judge throws `LaneAttemptError`. Its code is one of the following:

| Code | When |
| --- | --- |
| `InvalidCall` | the call is not an object with exactly its three keys |
| `InvalidAttempt` | the attempt is not an object with exactly its five keys |
| `InvalidLaneId` | the lane id is not a short identifier |
| `InvalidAttemptNumber` | the attempt number is not a positive integer |
| `InvalidInstant` | an instant is malformed, or is not a real calendar time |
| `DeadlineNotAfterStart` | the deadline is not after the start |
| `InvalidHeartbeatTimeout` | the heartbeat timeout is not a positive whole number of milliseconds |
| `InvalidObservation` | the observation, or its heartbeat, does not have exactly its keys |
| `InvalidHeartbeatStep` | a heartbeat step is not `L<n>`, with `n` written without leading zeros |
| `InvalidEvents` | the log is not an array, or holds more than 65,536 events |
| `InvalidEvent` | an event has an unknown kind or not exactly its keys |
| `NowBeforeStart` | `now` is before the start |
| `ObservationOutOfRange` | an observed instant is after `now` |
