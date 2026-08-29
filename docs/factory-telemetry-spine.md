# Passive factory telemetry spine R0

## Problem

Real work happens in local factory CLIs and in Claude/wmux lanes, but the control room could
only see two things: the drain projection, which changes once per bounded transition, and
best-effort `gaia-cli-progress/1` lines, which exist only while one provider pipeline happens
to be attached. So the control room truthfully reported `PAUSED` while useful work was
running. The missing capability is a sensor and a durable place to put what it observed, not
more orchestration.

## Design It Twice

Two smallest end-to-end designs were built out before any code was written.

### A. Direct coupling: read the lane's own output

The control room (or a wmux adapter) tails whatever the running agent already prints, scrapes
run state out of it, and derives activity from the file's modification time.

- **Assumptions.** The lane emits something parseable; its mtime tracks liveness; the text is
  safe to persist.
- **Cost.** Zero new record types, zero new log. Very fast to reach a moving pixel.
- **Fatal problem.** Everything it ingests is arbitrary text, so a prompt, a reasoning trace, a
  credential or a source fragment can end up in durable evidence by accident, and there is no
  point at which that can be structurally prevented. Liveness inferred from an mtime is not
  evidence of a run at all: a decorative timer, a log rotation or a copied file animates the
  UI. Replay is impossible because there is no chain, no sequence and no identity.

### B. Typed local adapter: a closed event set over an append-only content-addressed log — selected

A sensor emits one of exactly seven bounded facts. Each fact is a closed record of typed
identities and canonical tokens, chained by sequence and predecessor hash, appended under the
same single-writer lock protocol the drain ledger already uses. A pure replay turns the set
into one deterministic projection; the control room decides freshness against its own clock.

- **Assumptions.** The bounded local step can name its own gates; a lane and an agent identity
  are either known tokens or honestly `UNKNOWN`; the observer's clock is the right authority on
  whether a heartbeat is still fresh.
- **Cost.** Three small modules and one new durable file. Sensors must be written deliberately
  rather than scraped, so an uninstrumented lane stays invisible instead of guessed at.

### Strongest counterargument against B

"You already have `factory-tracing.mjs` producing OTLP spans; a second event vocabulary is
duplication, and a collector would give you dashboards for free."

It is a real cost. It is outweighed because a span sink is fire-and-forget observability that
is explicitly allowed to fail silently (`factory-tracing.mjs` swallows every sink error, by
design), while this spine is *evidence*: the control room animates from it, so it must fail
closed, replay identically, and be verifiable offline with no collector, no port and no
network dependency. Those are opposite requirements, and satisfying both in one mechanism
would make the tracing path load-bearing — which is exactly what it must not be.

### Hidden costs accepted

- A second append-only log and lock beside the drain ledger. Mitigated by reusing
  `event-log.mjs` primitives (`parseEventLog`, the lock constants, the typed corruption error)
  rather than inventing a second protocol.
- Instrumentation is opt-in per seam. An uninstrumented lane reports nothing, which is honest
  but means coverage grows only as sensors are added.
- The closed field set will reject a genuinely useful future field until the machine version
  is bumped. That is the price of the privacy guarantee being structural.

### Falsifier

If a run's telemetry could animate the control room without a `run.heartbeat` inside the
freshness window — or if any of a gap, a reorder, an identity substitution, an impossible
transition, an unknown event type, a future timestamp or a corrupted line could be replayed
into a moving dashboard instead of a typed refusal — the design has failed. Each of those is a
named negative control in `tests/factory-telemetry.test.mjs`,
`tests/factory-telemetry-log.test.mjs` and `tests/control-room.test.mjs`.

### Rejection criterion

Rebuild this at a different seam if a sensor ever needs to record something that is not a
typed identity or a canonical token, or if two writers ever need to append to one run
concurrently. Both would mean the record is the wrong shape, not that the checks are too
strict.

### Why the selected seam is deeper and smaller

The whole public surface is four functions plus a durable adapter, and behind them sit chain
validation, duplicate idempotency, monotonic sequence and time checks, gate matching, the
one-run-per-item selection rule and the closed-field privacy guarantee. A caller that deleted
the module would have to reimplement all of it to get an animation it could trust. It is
smaller than A because it carries no parser, no heuristics and no text at all.

## Event record

```text
schema           gaia-factory-telemetry-event/1
machineId        gaia.factory-telemetry
machineVersion   1
rulesRevision    SHA-256 of the interpreter rules
runId            ^[a-z0-9][a-z0-9-]{7,63}$
repository       owner/name
itemId           canonical identifier
itemNumber       positive integer
lane             canonical token, or UNKNOWN
agent            canonical token, or UNKNOWN
itemRevision     SHA-256 of the observed subject, or UNKNOWN
sequence         monotonic, contiguous from 0 within one run
previousRevision null exactly at sequence 0, else the predecessor's revision
observedAt       exact UTC instant, e.g. 2026-08-29T18:00:00.000Z
event            one of the closed set below
gate             canonical token on gate.* only, otherwise null
blocker          canonical token on run.blocked only, otherwise null
evidenceRevision SHA-256 of the referenced evidence, or UNKNOWN
revision         SHA-256 of the whole body
```

There is no free-text field. The record is checked against this exact key set, so an extra
`prompt`, `reasoning`, `stdout`, `token` or `diff` field fails closed even when the caller
re-hashes the body to match.

## Run machine

```text
             run.started
                  |
                  v
  run.heartbeat  RUNNING  run.completed -> COMPLETED (terminal)
        ^        |     |
        |        |     +-- run.blocked -> BLOCKED (terminal)
        |        v
        |   gate.entered
        |        |
        +---- IN_GATE --- gate.passed | gate.failed --> RUNNING
                  |
                  +------ run.blocked -------------> BLOCKED (terminal)
```

`gate.passed` and `gate.failed` must name the gate that is actually open; leaving a different
gate is `TelemetryGateMismatch`. Both terminal states admit nothing further.

## Typed refusals

| Code | Condition |
| --- | --- |
| `TelemetryEventInvalid` | closed-field violation, malformed identity, bad instant, content that does not match its revision |
| `TelemetryEventUnknown` | an event type outside the closed set, including a future one |
| `TelemetryMachineUnsupported` | a record written by a different interpreter version |
| `TelemetryRunUnstarted` | a run whose first event is not `run.started` |
| `TelemetrySequenceGap` | a missing sequence position |
| `TelemetrySequenceConflict` | two different events at one sequence position |
| `TelemetryChainBroken` | a predecessor link that does not match |
| `TelemetryIdentitySubstituted` | repository, item, lane, agent or subject revision changed mid-run |
| `TelemetryTransitionInvalid` | an impossible transition |
| `TelemetryGateMismatch` | leaving a gate other than the open one |
| `TelemetryTimestampReordered` | an observation before its predecessor |
| `TelemetryTimestampFuture` | an observation after the caller's instant |
| `TelemetryItemAmbiguous` | two unfinished runs for one item |
| `LogCasMismatch` | the durable log moved since the caller observed it |
| `LogPathInvalid` / `LogRequestInvalid` | an implicit directory or a malformed expected head |
| `CorruptLogError` | a torn line, a tampered record, a broken record chain, a foreign machine |

Duplicate delivery of the identical content-addressed event is not a refusal: it is a no-op at
the write seam and is de-duplicated during replay.

## Freshness

Replay never decides freshness, because replay is pure and the same events must always give
the same projection. The control room compares `lastHeartbeatAt` against its own `observedAt`
inside one explicit window (30 s, reported as `freshnessWindowMs`). Only a live run
(`RUNNING` or `IN_GATE`) with a heartbeat inside that window animates. Outside it the same
evidence becomes `TELEMETRY_HEARTBEAT_EXPIRED` in the blocker list, carrying `evidenceAgeMs`,
and `nextAction` becomes `CHECK_STALE_RUN`. A blocked run becomes `TELEMETRY_<BLOCKER>`. A run
whose evidence is dated after the rendered instant is refused with `InvalidTelemetry` rather
than displayed.

## The arm

`runInstrumentedDrainTransition` is the one place the spine touches real execution, and it is
the whole loop in a single bounded step:

```text
sensors            read the portfolio snapshot and the durable drain ledger
durable state      replay those receipts into one exact projection
pump decision      build the single candidate receipt for the requested transition
minimum authority  attempt exactly one compare-and-swap append, or explicitly do nothing
receipt/feedback   record the closed telemetry arc the control room then reads
```

A permitted transition records `run.started`, `run.heartbeat`, `gate.entered`, `gate.passed`,
`run.completed` and appends exactly one drain receipt. A transition the drain interpreter
refuses is an explicit no-op: `gate.failed` and `run.blocked` are recorded, the blocker is the
interpreter's own diagnostic code as a canonical token, and nothing is written to the ledger.
Only the drain interpreter's own refusals become a blocked run; a lock timeout or a corrupted
log propagates, because an infrastructure failure is not a bounded no-op.

The arm launches no worker, calls no provider, retries nothing, publishes nothing, routes
nothing and adds no bus verb. The six bus verbs are untouched.

## R1 — the phase sensor, so a run can actually be observed moving

R0 shipped a correct mechanism with an unreachable state. Every sensor it had recorded a whole
run inside one process, so the durable log never held a live run, and a separately invoked
dashboard could only ever see a settled one. `ACTIVE` and `STALE` were real behaviours of the
projection, reachable only by replaying a truncated event prefix at a chosen instant in the
same process that wrote it. That is a unit demonstration of the freshness rule, not an
observation, and both independent reviews blocked on exactly that.

### Design It Twice

**A. Make the existing step CLI long-running.** Give `factory-telemetry-step.mjs` a
`--hold-ms` that keeps the process alive between the heartbeat and the terminal event, beating
on a timer. *Cost:* one flag. *Fatal problem:* the sensor becomes a clock. A process that beats
because a timer fired is asserting liveness it never measured — precisely the decorative-timer
failure the spine exists to refuse — and a crash mid-hold leaves the arm unable to record
anything at all. It also makes every test that touches the seam wall-clock bound.

**B. A seam that accepts one closed fact and returns — selected.** `recordFactoryTelemetryPhase`
takes one phase, appends one event under the existing CAS and single-writer protocol, and
returns. The run stays open on disk because nothing closed it, not because something is holding
it open. Liveness is asserted only by whoever actually did the work, one `heartbeat` at a time.
Any process, at any later moment, can add the next phase or read the log. The observer decides
freshness against its own clock, exactly as before.

### The seam

Seven phases, one per existing event kind, and the map is a bijection:

```text
start        -> run.started        heartbeat -> run.heartbeat
gate-entered -> gate.entered       gate-passed -> gate.passed
gate-failed  -> gate.failed        finish -> run.completed
block        -> run.blocked
```

No event kind, field or schema is added. The subject is bound exactly once, at `start`, and
every later phase reads it back out of the durable log; a phase that supplies a disagreeing
subject is refused as `PhaseSubjectSubstituted` rather than silently rebinding the run. An
unknown phase, an unstarted run, an already-started run, an impossible transition, a lost
update and an unavailable lock all fail closed and write nothing. A re-delivered phase — the
same fact from a sensor that crashed before acknowledging its own append — is recognised by
rebuilding the log head against its own predecessor and comparing content addresses, so it is
an idempotent no-op with `effect: NONE`.

### The wmux/Claude bridge

`observeWmuxClaudeTask` is a thin wrapper over that seam and imports nothing else. It opens the
run, hands the caller's bounded task a `beat()` it may call whenever it is genuinely still
working, and closes the run on the task's own closed outcome (`COMPLETED`, or `BLOCKED` with a
canonical blocker token). It launches nothing, drives no wmux surface, reads no screen, prompt,
reasoning trace or terminal output, and consumes no authority. A task that throws is re-thrown
untouched rather than recorded as a named blockage, because an infrastructure failure means the
task was never evaluated; the run stays open and truthfully expires as
`TELEMETRY_HEARTBEAT_EXPIRED`. An unreadable outcome fails closed the same way.

The wrapper is deliberately generic in mechanism: what makes it the wmux/Claude bridge is the
identity it binds (`lane`, `agent`) and the operator protocol below, not code that controls
wmux. That is the boundary the issue asks for — a file-backed ingress with a wmux/Claude
consumer — and not a second control plane.

### Observing one run move, expire and settle

Each command is a separate process. Between them the run is open on disk.

```bash
T=../state/gaia-telemetry
D="node scripts/factory-dashboard.mjs --portfolio ../state/gaia-portfolio.json --telemetry $T"

node scripts/factory-telemetry-phase.mjs --telemetry-dir $T --run-id run-27-alpha \
  --phase start --repository GuitarAlchemist/gaia --item issue-27 --item-number 27 \
  --lane WMUX_LANE_A --agent CLAUDE_CODE
node scripts/factory-telemetry-phase.mjs --telemetry-dir $T --run-id run-27-alpha \
  --phase heartbeat
node scripts/factory-telemetry-phase.mjs --telemetry-dir $T --run-id run-27-alpha \
  --phase gate-entered --gate CLAIMED

$D --snapshot-out ../state/cr-active.json --html-out ../state/cr-active.html
# ACTIVE, showSpinner true, one heartbeat-pulse span, stage CLAIMED

sleep 31

$D --snapshot-out ../state/cr-stale.json --html-out ../state/cr-stale.html
# STALE, showSpinner false, no pulse, TELEMETRY_HEARTBEAT_EXPIRED, next CHECK_STALE_RUN

node scripts/factory-telemetry-phase.mjs --telemetry-dir $T --run-id run-27-alpha \
  --phase gate-passed --gate CLAIMED
node scripts/factory-telemetry-phase.mjs --telemetry-dir $T --run-id run-27-alpha \
  --phase finish

$D --snapshot-out ../state/cr-settled.json --html-out ../state/cr-settled.html
# PAUSED, activity IDLE, runState COMPLETED, no blockers
```

Wrapping a real visible wmux/Claude task is the same three opening commands, then the task in a
pane the operator can watch, then the two closing ones — with one `--phase heartbeat` for each
point at which the task is observed still working:

```bash
wmux browser open https://github.com/GuitarAlchemist/gaia/issues/27
claude -p "Summarise issue 27 acceptance criteria in five bullets"
```

Nothing in the spine launches either command. The operator does, and records what was observed.

## Boundaries

- The JSONL log is the portable evidence boundary for R0. A DuckDB projection, if it is ever
  added, is a rebuildable read model and never authority.
- No collector, broker, listener, network dependency or new runtime dependency.
- `effect: NONE` and `authority: NONE` on every telemetry read seam. The arm reports
  `effect: LOCAL_LEDGER_APPEND` only when it actually wrote one drain receipt.

## Reproduce

```bash
node --test tests/factory-telemetry.test.mjs
node --test tests/factory-telemetry-log.test.mjs
node --test tests/factory-drain-telemetry.test.mjs
node --test tests/control-room.test.mjs
node --test tests/factory-telemetry-step-cli.test.mjs
node --test tests/factory-telemetry-phase.test.mjs
node --test tests/factory-telemetry-phase-cli.test.mjs
node --test tests/wmux-claude-telemetry-bridge.test.mjs
node --test
```
