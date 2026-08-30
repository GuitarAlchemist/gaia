# Local wmux lanes R0 — design decision and contract

Status: design decision plus the shipped contract. This document grants no authority, starts no
lane, and approves nothing. It records what was decided before implementation, which seams were
rejected, and the falsifiers the tests attempt.

## Operator problem

The control room reported `PAUSED` while four real Claude/wmux reviews were visibly running in
panes on the same machine. The report was truthful about its evidence and useless to the operator:
every sensor feeding the dashboard projects through GitHub portfolio items, and a local review lane
that was never bound to an issue or a pull request is invisible to all of them.

The fix must not be to invent the missing binding. A local lane genuinely has no repository, no
issue, no pull request, no percentage, no pace and no ETA, and manufacturing any of them to make
the lane fit the portfolio shape would trade one silent falsehood for a louder one.

### Affected actor and consumer

The operator reading `gaia-control-room.html` on a laptop while local review lanes run. The
consumer of the new evidence is `buildControlRoomSnapshot`, which already refuses evidence it
cannot verify and must keep refusing at the same standard.

### Success criteria

1. A fresh local observation carrying at least one running lane makes the global headline `ACTIVE`
   and shows a real liveness pulse, described in words as process liveness and never as progress.
2. Lanes are rendered in their own section, labelled `LOCAL_WMUX`, separate from portfolio work,
   and carry no repository, issue, pull request, percentage, pace or ETA.
3. A stale, missing or corrupt observation never animates and is stated explicitly.
4. The observation is a closed versioned schema of bounded metadata. Unknown fields and malformed
   values are refused rather than dropped.
5. The GitHub portfolio, the telemetry spine, DuckDB truth and the six bus verbs keep their
   existing authority exactly.

### Falsifiable non-goals

- The sensor does not read a screen, a prompt, reasoning, stdout, a command line or source code.
- The sensor does not spawn, send to, focus, kill, reap or otherwise mutate any wmux surface.
- The control room does not drive wmux, and wmux is never a dependency of rendering.
- A local lane never becomes a portfolio backlog item, a drain item, or a telemetry-spine run.
- No lane elapsed time, throughput, percentage or ETA is derived. R0 measures liveness only.

## Assumptions, and how each was checked

| Assumption | Check |
| --- | --- |
| `wmux agent list` emits structured JSON, not terminal text | Run against the live install: one `{"agents":[...]}` document, one object per agent. |
| It observes every workspace when no `--workspace` is passed | The live output carried agents from two distinct `workspaceId` values. |
| Records carry stable bounded identities | Observed keys: `agentId`, `surfaceId`, `paneId`, `workspaceId`, `label`, `status`, plus `cmd`, `spawnTime`, `pid`, `exitCode`. |
| Records also carry unsafe content | `cmd` carries a full command line with local absolute paths. It is the exact field this sensor must never read. |
| Observed status vocabulary | `running` and `exited` were both present. Anything else must normalize to `UNKNOWN`, never to a live state. |

## Design It Twice — where the sensor seam goes

### Seam 1 — record local lanes into the factory telemetry spine as synthetic runs

The spine already animates the control room, so a lane could be recorded as `run.started` plus
`run.heartbeat` and the dashboard would light up with no renderer change at all.

Rejected. Every spine run is bound to a portfolio `itemId`, a lane token and a gate vocabulary, so
this seam has to fabricate exactly the binding the operator problem says does not exist. It also
writes into the durable, content-addressed evidence log that the drain, the receipts and DuckDB
treat as truth, which converts a read-only observation into an authority-bearing append. A lane
that vanishes when its pane closes would leave an open run in permanent evidence.

### Seam 2 — let the control room call wmux while rendering

`buildControlRoomSnapshot` could shell out to `wmux agent list` and merge the result.

Rejected. The read model is pure, performs no I/O and is deeply immutable; the same inputs must
produce the same bytes. Calling a local multiplexer from the renderer makes the dashboard
undeterministic, unrenderable on any machine without wmux, and impossible to replay from evidence.
It also inverts the dependency the brief forbids: the control room would drive wmux.

### Seam 3 — a bounded read-only sensor writing a closed observation file, consumed explicitly — **selected**

Three small pieces with one file between them:

- `src/local-lane-observation.mjs` — the closed `gaia-local-lane-observation/1` schema, its total
  verifier, and nothing else. It knows nothing about wmux.
- `src/local-lane-sensor.mjs` — a pure function from already-parsed structured agent metadata to a
  sealed observation. It reads six fields by name and cannot read a seventh.
- `scripts/local-lane-sensor.mjs` — the process boundary: one `wmux agent list` invocation, no
  shell, no workspace filter, no mutating verb, writing the observation file.

The control room takes the observation as an **explicit input** (`localLanes`), exactly as it
already takes `telemetryProjection` and `dependencies`. It never discovers the file, so a dashboard
rendered without the flag is byte-identical to today's.

Chosen because it is the only seam where the new evidence is verifiable, replayable and separable:
the observation file is the whole interface, an operator can read it, a test can hand-write it, and
deleting the flag removes the feature with no residue in any durable log.

## Design It Twice — how a lane is displayed

### Display 1 — merge lanes into `items`

Rejected. `items` carries `repository`, `itemKind`, `itemNumber`, `sourceState`, `drainState` and a
lifecycle percentage. A local lane has none of them, so the merge forces either fabricated values
or six nullable fields spreading through the drain, the obstruction classifier and the activity
summary — three modules with no business knowing local lanes exist.

### Display 2 — a headline counter only

Rejected. It satisfies the headline requirement and fails the operator: "5 lanes active" with no
label, lifecycle or identity does not tell you which review is running or how old the reading is.

### Display 3 — a separate `localLanes` block and its own labelled section — **selected**

One additional top-level field on the snapshot, sealed into the snapshot revision, plus one
rendered section between the obstruction and the portfolio progress. The portfolio sections are
untouched, the separation is visible rather than promised, and the block is re-derived by the
render-seam verifier so a resealed snapshot cannot claim a pulse its own evidence refuses.

## Closed observation schema

`gaia-local-lane-observation/1`. Exactly seven top-level keys; any other key is refused.

```json
{
  "schema": "gaia-local-lane-observation/1",
  "source": "LOCAL_WMUX",
  "effect": "NONE",
  "authority": "NONE",
  "observedAt": "2026-08-30T03:45:00.000Z",
  "lanes": [
    {
      "workspaceId": "ws-34bd14f7-70a7-4217-9d8e-8997fe71ccbc",
      "paneId": "pane-5b6fc653-c163-4996-83bf-7f8c8bf0ddc3",
      "surfaceId": "surf-c2cc889d-6ba7-4b5b-bb2f-1c8787114184",
      "agentId": "agent-30a16155-4674-457b-9c21-659d289f6e89",
      "label": "Gaia Dashboard UX R0 — Standards",
      "lifecycle": "RUNNING"
    }
  ],
  "revision": "<sha256 of the canonical body>"
}
```

Each lane has exactly six keys. There is no field whose content is free text from a running
process: identities match `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`, which admits no whitespace,
quote, angle bracket or newline, and the label matches a bounded human-name pattern that admits no
`<`, `>`, `"`, backslash, backtick, `$`, `;`, `|` or control character. A command line, a prompt or
a screen fragment has nowhere to live even if a caller tries — the prohibition is a construction,
not a filter.

### Lifecycle vocabulary

Exactly three values: `RUNNING`, `EXITED`, `UNKNOWN`. Only `RUNNING` is ever live. The sensor maps
wmux status strings by exact equality — `running` and `exited` — and everything else becomes
`UNKNOWN`. There is no prefix match, no case folding and no fuzzy match, so an unrecognised future
status can only ever fail closed. No speculative fourth state is defined for a status nothing has
been observed to emit.

### Refusal rules

- An unknown top-level or lane key is refused. Extra fields are never ignored.
- `observedAt` must round-trip exactly through `Date#toISOString`, so a partial or locale timestamp
  is refused rather than parsed leniently.
- Lanes must be strictly ascending by `workspaceId`, `surfaceId`, `agentId` ordinally, which makes
  the order deterministic and makes a duplicate identity a refusal rather than a double count.
- At most 64 lanes.
- `revision` must equal the SHA-256 of the canonical body. A hand edit is refused at the seam.
- An observation dated after the instant the control room observed it is a typed refusal, never a
  clamp, matching the rule the snapshot already applies to its own window.

### Withheld rather than invented, and never dropped

Three closed answers for a label, because dropping a lane would under-report exactly the lanes the
operator is looking for and sanitising one would silently rename someone's work:

| Observed | Published |
| --- | --- |
| absent or `null` | `UNKNOWN` |
| a label the safe pattern admits | verbatim |
| a string the safe pattern refuses | `WITHHELD_UNSAFE_LABEL` |

An identity that is present but malformed is a refusal of the whole observation, not a withheld
value: an identity is what the operator uses to find the pane, and a wrong one is worse than none.

## Control-room contract

`buildControlRoomSnapshot({ ..., localLanes })` accepts the verified observation and publishes:

```
localLanes: null | {
  source, state, observedAt, observationRevision, ageMs, freshnessWindowMs,
  laneCount, runningCount, liveCount, showPulse, binding, caveat, lanes[]
}
```

- `state` is `FRESH` while `ageMs <= 30000`, otherwise `STALE`. The window is the same 30 s the
  heartbeat rule already uses, quoted from one constant rather than restated.
- `live` on a lane is `state === 'FRESH' && lifecycle === 'RUNNING'`. `showPulse` is `liveCount > 0`.
- `binding` is the literal `NONE`, published rather than merely absent, so a consumer reads the
  disclaimer instead of inferring one from a missing field.
- The headline is `ACTIVE` when `activeCount > 0 || liveCount > 0`. With local lanes only, the
  headline detail names them as process liveness with no tracked portfolio binding.
- `requireControlRoomSnapshot` re-derives `laneCount`, `runningCount`, `liveCount`, `showPulse`,
  `state`, `ageMs` and every lane's `live` from the fields in hand, and refuses a mismatch. A
  resealed snapshot cannot assert a pulse over a stale observation.

## Truth rules

- A local lane is process liveness. It is never progress, never a percentage, never a pace input
  and never an ETA input. The page says so in words beside the pulse.
- A stale, missing or corrupt observation animates nothing. Stale is rendered as an explicit,
  labelled state with its measured age; missing means the section is absent entirely.
- Exited lanes are published and displayed, and they never make the headline `ACTIVE`. An
  observation of exited lanes only leaves a paused drain `PAUSED`.
- Local lanes are an additional sensor source. They do not enter `items`, `blockers`, `capacity`,
  the obstruction classifier, the activity summary, pace or ETA, and they add no backlog.
- The sensor is read-only with respect to wmux: it invokes exactly `agent list`, passes no
  workspace filter and refuses to construct any other verb.
- `effect` and `authority` are `NONE` on the observation and unchanged on the snapshot.

## Interfaces

| Unit | Contract |
| --- | --- |
| `src/local-lane-observation.mjs` | `requireLocalLaneObservation`, `sealLocalLaneObservation`, the closed vocabularies and the safe patterns. Pure; imports only `node:crypto`. |
| `src/local-lane-sensor.mjs` | `observeLocalLanes({ agents, observedAt })` — pure structured metadata to sealed observation. Reads six named fields. No I/O, no clock, no process. |
| `scripts/local-lane-sensor.mjs` | `wmux agent list` once, no shell, no filter, no mutation; writes the observation file. `--out` required. |
| `scripts/factory-dashboard.mjs` | `--local-lanes <path>` explicit input. Absent flag renders exactly as before. |
| `scripts/local-lanes-watch.mjs` | One command: refresh the observation, then the control room. `--interval-ms` is explicit, bounded to 1000-60000, and stops on SIGINT/SIGTERM. |

The observation file is deliberately not part of the observation-window evidence for the drain
projection: its `observedAt` moves on every tick and it says nothing about how long the projection
revision has been in force, so including its mtime would restart a window it has no evidence about.

## Reversibility

Freely reversible. Removing `--local-lanes` removes the section and the headline contribution; the
snapshot field returns to `null` and every existing artifact renders unchanged. Nothing is written
to the event log, the drain ledger, the telemetry spine or GitHub, so there is nothing to
compensate. The sensor's only durable output is one file the operator chose the path of.

## Falsifiers

| Id | Falsifier | Refuted by |
| --- | --- | --- |
| F1 | A fresh observation with a running lane leaves the headline `PAUSED`. | The active-lane headline test. |
| F2 | A local lane acquires a repository, issue, pull request, percentage, pace or ETA. | The no-binding test scans the published snapshot and the rendered document. |
| F3 | An observation of exited lanes only animates or reports `ACTIVE`. | The exited-only test. |
| F4 | A stale observation animates, or is displayed as if fresh. | The stale-no-pulse test asserts no keyframe and an explicit stale state. |
| F5 | A future, corrupt or extra-field observation is displayed. | Three refusal tests, one per failure. |
| F6 | A label carrying markup reaches the document unescaped. | Schema refusal, sensor withholding, and renderer escaping — three prongs. |
| F7 | The sensor ingests a screen, prompt, stdout or command line. | The negative control: the fake wmux emits all of them with unique markers and asserts none reaches any artifact. |
| F8 | The sensor invokes a mutating or screen-reading wmux verb. | The fake wmux exits non-zero for every verb but `agent list` and records the exact argv it saw. |

## Rejection criterion

If the observation seam cannot show a fresh running lane as `ACTIVE` without any fabricated
portfolio binding, or if any lane field can carry free text from a running process, the seam is
wrong and is withdrawn rather than patched.

## Decision Receipt

- **Selected:** Seam 3 (bounded read-only sensor, closed observation file, explicit control-room
  input) with Display 3 (separate `localLanes` block and labelled `LOCAL_WMUX` section).
- **Rejected:** Seam 1 (synthetic telemetry runs — fabricates the missing binding and writes
  authority-bearing evidence), Seam 2 (control room drives wmux — destroys purity, determinism and
  portability), Display 1 (merge into `items` — forces fabricated portfolio fields), Display 2
  (headline counter only — not actionable).
- **Reversibility class:** freely reversible.
- **Exact inputs:** live `wmux agent list` output observed on this machine; `src/control-room.mjs`,
  `src/control-room-activity.mjs`, `scripts/factory-dashboard.mjs` and `docs/factory-control-room.md`
  at the entry commit.
- **Authority:** none. `effect: NONE`, `authority: NONE` on every value this work publishes.

## What R0 does not claim

- It does not claim a local lane is doing useful work. `RUNNING` is a process status reported by
  wmux, and a running process may be idle, stuck or wrong.
- It does not claim the lane set is complete. It is complete with respect to what
  `wmux agent list` reported at one instant, and a lane wmux does not know about is invisible.
- It does not claim liveness implies progress, and the page says so beside every pulse.
- It does not measure lane elapsed time, throughput or cost, and derives no forecast of any kind.
- It changes nothing about the six bus verbs, provider routing, GitHub effects, IXQL, DuckDB truth
  or paid API behaviour.
