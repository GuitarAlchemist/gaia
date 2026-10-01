# Lane-attempt decisions

Status: a pure decision core (#180). It decides; it stops, releases, sends and retries nothing, and
it grants no authority. Porting the runner and adding lane-net transitions stay on #103.

Architect R3 found three durable-execution semantics missing from the lane runner:

- a per-attempt deadline;
- a heartbeat timeout;
- a compensation record when an attempt ends without completing.

`src/lane-attempt.mjs` decides them over the lane lifecycle net that already ships
(`LANE_NET_TEMPLATE` in `src/drain-petri-net.mjs`), before any runner is ported.

## The call

```js
decideLaneAttempt({ attempt, observation, now })
```

| Input | Fields |
| --- | --- |
| `attempt` | `laneId`, `attemptNumber`, `startedAt`, `deadline`, `heartbeatTimeoutMs` |
| `observation` | `heartbeat`: `null` or `{ at, step }` with `step` `L<n>`; `markerSeenAt`: `null` or an instant; `abortOrderedAt`: `null` or an instant |
| `now` | the caller's instant. The module reads no clock. |

Instants are ISO-8601 UTC, to the second or the millisecond. Every observed instant must lie between
the attempt's start and `now`. An abort ordered before the attempt started belongs to the net's
`T_ABORT_BEFORE_ATTEMPT`, not to this call.

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

- **Boundaries are inclusive.** At the deadline instant the attempt is out of time; at the last
  heartbeat plus exactly the timeout it has timed out.
- **Equal instants** resolve in `LANE_ATTEMPT_PRECEDENCE` order: `ABORTED`, `DEADLINE_EXCEEDED`,
  `HEARTBEAT_TIMEOUT`, `COMPLETE`. An order or a limit is honoured before a completion is accepted,
  so a marker written at the deadline instant does not complete the attempt.
- **The answer does not depend on when the caller asks.** Once every instant is past, asking later
  gives the same decision. A marker that arrives after the attempt already timed out is reported as
  `lateMarkerAt`, never read as completion.
- **Only the last heartbeat is observed.** A silent gap between two earlier heartbeats is
  invisible, so a caller that decides at every heartbeat it reads sees every gap.

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

A test compares this map with `LANE_NET_TEMPLATE`. If a transition out of `L_ATTEMPT_RUNNING` is
added later, the test fails until the transition is mapped and `UNMAPPED` shrinks.

## The compensation record

Every terminal decision other than `COMPLETE` carries a `gaia-lane-attempt-compensation/1` record.
The record names the work; the caller does it.

| Field | Meaning |
| --- | --- |
| `decision`, `decisiveAt` | what ended the attempt, and when |
| `lastStep`, `lastHeartbeatAt` | the last `L<n>` step the attempt reported, and when |
| `lateMarkerAt` | a marker that came too late to count, for a person to look at |
| `undo` | `STOP_ATTEMPT_PROCESS`: the provider process may still run. `RELEASE_LANE_SLOT`: only for an unmapped decision, because no shipped transition returns its `LANE_SLOTS` token. `DISCARD_UNVERIFIED_OUTPUT`: what the attempt wrote is not its verified result. |
| `report` | `SEND_LANE_ABORTED` after an abort (the net's `L_LANE_ABORTED_SENT`), otherwise `ESCALATE_TO_COORDINATOR` |

## Refusals

Input the module cannot judge throws `LaneAttemptError`. Its code is one of the following:

| Code | When |
| --- | --- |
| `InvalidAttempt` | the attempt is not an object with exactly its five keys |
| `InvalidLaneId` | the lane id is not a short identifier |
| `InvalidAttemptNumber` | the attempt number is not a positive integer |
| `InvalidInstant` | an instant is malformed, or is not a real calendar time |
| `DeadlineNotAfterStart` | the deadline is not after the start |
| `InvalidHeartbeatTimeout` | the heartbeat timeout is not a positive whole number of milliseconds |
| `InvalidObservation` | the observation, or its heartbeat, does not have exactly its keys |
| `InvalidHeartbeatStep` | the heartbeat step is not `L<n>` |
| `NowBeforeStart` | `now` is before the start |
| `ObservationOutOfRange` | an observed instant is before the start or after `now` |
