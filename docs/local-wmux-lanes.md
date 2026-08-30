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

---

# R0 pair-review amendment — decided before implementation

An independent read-only pair reviewed the decision above and raised five blockers and seven
significant findings. Each was replayed here before it was accepted; what follows supersedes the
matching text above and was committed before a line of the implementation was written.

## Blocker 1 — an absent observation must not move every published revision

**Replayed and confirmed.** `canonicalJson` enumerates `Object.keys`, so a present `localLanes` key
holding `null` canonicalises to `"localLanes":null` and enters the digest:

```
omitted   6acc1229921f956c81a331375baab0824ea70bc3f384f4a106b5532530373dbf
null key  f71b83bf7a2923ad23486cc9008b651f68bc979f6d5975bd401c2f1f8594b750
```

The snapshot revision is rendered into the HTML Proof block and is bound by
`activity.snapshotRevision`, so the original `localLanes: null | {...}` shape would have moved every
previously published revision for unchanged evidence — the exact migration this repository
already rejected once, by name, for the activity-summary seam.

**Decided: resolution (a).** The key is **omitted entirely** when there is no observation. A
snapshot built without `--local-lanes` is byte-identical to the entry commit's, and that is proved
by a gate rather than asserted (T1). `requireControlRoomSnapshot` verifies the block only when the
key is present, and refuses a present-but-`null` value rather than treating it as absent.

## Blocker 2 — a sensor-cadence window is not a heartbeat window, and an interval must not outrun it

**Accepted.** `HEARTBEAT_FRESH_MS` means "the worker proved it is alive within 30 s". For a local
lane the same number would mean "the sensor ran within 30 s" — a different axis, and collapsing the
two is the confusion this product's evidence lattice exists to prevent. Compounding it, the
originally documented `1000-60000` interval range lets a legal configuration render `STALE` for
half of every cycle while four panes are visibly running, which is a softer restatement of the
operator failure this slice exists to fix.

**Decided:**

- The window is its own exported constant, `LOCAL_LANE_OBSERVATION_FRESH_MS`, defined in the
  observation module and named for what it measures: how recently the **sensor** reported, never
  how recently a worker proved liveness. Its value is 30 s and its meaning is not the heartbeat's.
- The published block names the measurement `observationAgeMs`, not `ageMs`.
- The watcher interval is bounded to **1000-15000 ms**, at most half the window, so no legal
  configuration can produce a permanently stale display. Above that is a usage refusal (T3).

## Blocker 3 — the headline is re-derived at the verify seam

**Accepted.** Once the first sentence an operator reads depends on an externally supplied sensor
input, it becomes the highest-value field to forge in a resealed snapshot, and every input needed
to re-derive it is already in hand.

**Decided:** `requireControlRoomSnapshot` re-derives `activeCount`, `staleCount`, `headline.state`,
`showSpinner`, and the whole local-lane block — `laneCount`, `runningCount`, `liveCount`,
`showPulse`, `state`, `observationAgeMs`, `overSupportedLaneLimit` and every lane's `live` — and
refuses a mismatch. This closes the asymmetry the amendment introduces and tightens two fields
that were previously trusted.

## Blocker 4 — the label pattern is a positive Unicode allowlist, and the channel is named

**Accepted.** Every label on this machine contains U+2014, so the pattern must admit general
Unicode punctuation; once it does, an exclusion list is the wrong shape. Bidi controls (U+202E,
U+2066-U+2069) and zero-width characters (U+200B, U+FEFF) are category `Cf`, not C0 controls, and
labels are **already duplicated in reality on this machine**, which makes visual disambiguation
load-bearing rather than cosmetic.

**Decided:**

- The label pattern is a positive allowlist: `\p{L}`, `\p{N}`, `\p{Zs}` and one named punctuation
  set that includes U+2014 and U+2013. Every `\p{C}` code point is refused in full — `Cc`, `Cf`,
  `Co`, `Cs` and `Cn`, not merely C0 — and a leading `\p{M}` is refused so a combining-mark stack
  cannot break the row.
- Length is bounded at 64 code points.
- **The channel is stated rather than implied.** A wmux label is chosen by whoever spawns the
  agent, and one agent may spawn another, so `label` must be treated as a channel an observed
  process can influence. It has two named barriers and no others: the allowlist above, which the
  schema enforces at the seam, and `escapeHtml` at every interpolation. That is why an unreadable
  label is withheld rather than sanitised — sanitising would put an attacker-shaped string through
  a transformation and then display the result.

## Blocker 5 — over-capacity is reported, and the document bound is not a lane policy

**Accepted.** The live machine already carries more running panes than
`DEFAULT_MAX_LIVE_LANES = 4`, and a section that silently displays 6, 12 or 40 live lanes beside a
product whose supported ceiling is 4 would be inventing a second, larger, unexplained number.

**Decided:**

- wmux panes and registered bus lanes are different populations — a pane is not a bus actor — so
  the limit is not enforced. It is **reported**: the block publishes `overSupportedLaneLimit`,
  true when any single workspace carries more live lanes than `DEFAULT_MAX_LIVE_LANES` imported
  from `src/lanes.mjs`, following the existing `overSupportedLaneLimit` precedent in
  `scripts/gaia-interagent.mjs`. The page states the observed count and the supported ceiling.
- The 64 cap is renamed `MAX_OBSERVED_LANES` and documented as a **document-size bound**, not a
  lane policy. It borrows no vocabulary from `src/lanes.mjs`.

## S2 — `labelState` beside the label, adopted

A lane genuinely labelled `UNKNOWN` must not be indistinguishable from a lane whose label was
missing. The label carries a separate closed vocabulary field, modelled on `sourceChangedAtBasis`:

| `labelState` | `label` |
| --- | --- |
| `OBSERVED` | the verbatim safe label |
| `ABSENT` | `null` |
| `WITHHELD_UNSAFE` | `null` |

`label` is `null` in both non-`OBSERVED` cases, so the withholding is assertable in a test rather
than inferable from a magic string, and no sentinel lives in the value space it describes.

## S3 — the lane pulse is not a heartbeat, in the markup as well as in the words

A local lane has no heartbeat instant; the only instant available is the sensor's `observedAt`.
Reusing `data-heartbeat-at` would let the client-side ager treat a sensor poll as a heartbeat and
re-create the "a ping is not progress" conflation removed one commit earlier.

**Decided:** the lane pulse carries `data-observed-at`, never `data-heartbeat-at`; it uses its own
`.lane-pulse` class with its own copy; and the `prefers-reduced-motion` media query names **every**
animated class, `.lane-pulse` included. The rule that no keyframe is emitted at all when nothing is
pulsing holds when the only pulse source is a local lane.

## S4 — the responsive and accessibility contract for the new section

The lane row is the worst case in the whole document for a phone: four opaque 40-character
identifiers per lane. The section therefore inherits the existing normative rules, restated here
because they now have a new subject:

- every lane state carries a **word and a symbol** — the live, stale and neutral glyphs the rest of
  the page already uses — and colour is never the meaning;
- the section carries an `aria-label` and the pulse carries `role="status"`, matching the existing
  `metrics` section and heartbeat chip;
- identifiers wrap rather than push the page, inside `min-width: 0` grid children;
- because labels are duplicated in reality, every row shows a short identity beside the label;
- the section is fully translated in the `fr` document. An English literal inside the French
  section is a test failure, not a residual.

## S1 — the watcher is kept, and the reason is recorded

**Rejected, with the disagreement stated.** The pair recommends dropping
`scripts/local-lanes-watch.mjs` as new orchestration for no new truth. The operator brief this
slice answers requires a one-command local watcher workflow as an acceptance criterion, so
dropping it would fail the request rather than simplify it.

The pair's underlying concern is accepted in full and constrains the script instead:

- it holds **no mechanism** — one tick calls the two existing entry points in this process, and
  spawns no subprocess of its own beyond the single `wmux agent list` the sensor already makes;
- ticks are **non-overlapping**: the next tick is scheduled after the current one settles;
- there is **no retry**. A failed tick prints its typed error, leaves the previous artifacts
  untouched, and waits for the next interval;
- the interval is explicit, bounded to 1000-15000 ms per Blocker 2, and stops on SIGINT/SIGTERM.

## S5 — the golden fixture and the digest-bound receipt

`tests/fixtures/wmux-agent-list-redacted.json` is one real `wmux agent list` payload from this
machine, reduced to the six safe fields — `cmd`, `pid`, `spawnTime` and `exitCode` were stripped
before it was written and appear nowhere in it. It carries 7 agents across 2 workspaces, 5
`running` and 2 `exited`, with two labels that are byte-identical duplicates.

```
tests/fixtures/wmux-agent-list-redacted.json
sha256 74541f35bf527b3bc4f226fe4e1815000497088d5337c5084bde211afa0d09ba
```

It is the sensor's golden input and the replayable "exact input" the original Decision Receipt
lacked.

## S6 and S7 — kept as written

The drain-window carve-out stays, and gains a negative gate (T17) so a future adapter edit cannot
quietly wire the observation file into the mtime scan. `requireProjection`'s weaker item
re-validation is pre-existing and out of scope; staying on Seam 3 keeps that hole closed, and
`itemKind` is not widened.

## Amended Decision Receipt

```json
{
  "receipt": "gaia-local-wmux-lanes-r0/1",
  "selectedSensorSeam": "SEAM_3_BOUNDED_READ_ONLY_SENSOR_EXPLICIT_FILE",
  "selectedDisplaySeam": "DISPLAY_3_SEPARATE_LOCAL_LANES_BLOCK",
  "absentObservation": "KEY_OMITTED",
  "observationWindowMs": 30000,
  "watchIntervalMsRange": [1000, 15000],
  "labelPolicy": "POSITIVE_UNICODE_ALLOWLIST_WITH_LABEL_STATE",
  "laneLimitPolicy": "REPORTED_NOT_ENFORCED",
  "maxObservedLanes": 64,
  "reversibility": "FREELY_REVERSIBLE",
  "effect": "NONE",
  "authority": "NONE",
  "goldenInput": {
    "path": "tests/fixtures/wmux-agent-list-redacted.json",
    "sha256": "74541f35bf527b3bc4f226fe4e1815000497088d5337c5084bde211afa0d09ba"
  },
  "baseCommit": "7cbb02670929b8ea8a4c14a55a86245c650a2d24",
  "rejected": [
    "SEAM_1_SYNTHETIC_TELEMETRY_RUNS",
    "SEAM_2_CONTROL_ROOM_DRIVES_WMUX",
    "DISPLAY_1_MERGE_INTO_ITEMS",
    "DISPLAY_2_HEADLINE_COUNTER_ONLY",
    "S1_DROP_THE_WATCHER"
  ]
}
```

## Gates this amendment commits to

`T1` digest stability with the key omitted · `T2` freshness boundary at exactly the window ·
`T3` interval above half the window refused · `T4` headline liveness term · `T5` exited-only stays
paused · `T6` verify-seam re-derivation including `headline.state` · `T7` activity-summary
inertness under local lanes · `T8` exact-equality status mapping · `T9` closed-key refusal both
directions · `T10` adversarial label set · `T11` withholding never drops a lane · `T12` future
observation refused, not clamped · `T13` ordering and duplicate identity · `T14` sensor argv ·
`T15` content negative control · `T16` no portfolio binding · `T17` drain window untouched ·
`T18` reduced motion and semantics · `T19` French parity. Each carries a mechanism-revert
mutation where the pair named one.
