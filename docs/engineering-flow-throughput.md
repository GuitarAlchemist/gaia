# Engineering flow throughput R0 — design decision and contract

Status: design decision plus the shipped contract. This document grants no authority, starts no
lane, opens no network connection and approves nothing. It records what was decided before
implementation, which seams were rejected, and the falsifiers the tests attempt.

## Operator problem

`docs/local-wmux-lanes.md` fixed a control room that read `PAUSED` while real local work was
running. It fixed it in the only honest way available at the time: by reporting **process
liveness** as process liveness. The movement-truth audit then wrote down why that must never be
read as anything else — a heartbeat, a token, a byte of stdout, a spinner or a live PID proves a
sensor or a process is alive and proves nothing at all about the engineering queue.

That leaves the operator with two truthful readings and no answer to the question they actually
have:

> Is the engineering queue moving, and how fast?

Six running panes and `portfolio Moving = 0` are both true. Neither is throughput. The control
room today can say *something is alive* and *nothing tracked is claimed*, and it cannot say *four
issues opened and six closed in the last 24 hours, net −2*, because it holds no evidence of
discrete engineering events at all.

### Affected actor and consumer

The operator reading `gaia-control-room.html` and asking whether the last hour, day or week
produced anything. The consumer of the new evidence is `buildControlRoomSnapshot`, which already
refuses evidence it cannot verify and must keep refusing at exactly that standard.

### Success criteria

1. Every event family that materially changes the engineering queue — issues, pull requests,
   commits, factory runs, evidence reviews — has exact counts and rates over 1h, 24h and 7d
   **when the supplied evidence window is complete for that window**, and reads `UNKNOWN` when it
   is not.
2. `0 observed in a complete window` and `unknown / incomplete evidence` are different readings,
   in the published model, in the markup, and in the words on the page, in both languages.
3. Inflow, outflow and net queue change are rendered for the families where an inflow event
   actually exists in the vocabulary, and are `UNKNOWN` with a named reason for the families where
   it does not. No family gets a fabricated inflow so its net can be printed.
4. Cycle-time median appears only when honest comparable durations exist: at least five closing
   events in the window, **all** of which carry a comparable start instant.
5. Heartbeats, tokens, stdout bytes, spinners and provider process liveness cannot enter the model
   at all — not weighted low, not labelled: the closed vocabulary has no name for them and unknown
   families are refused.
6. Duplicate events, malformed or future instants, unsupported kinds, contradictory terminal
   outcomes, tampered revisions and non-monotonic source snapshots fail closed. Incomplete windows
   display `UNKNOWN`. Nothing in this list ever renders as zero.
7. The GitHub portfolio, the telemetry spine, the drain, the local-lane sensor and the six bus
   verbs keep their existing authority exactly.

### Falsifiable non-goals

- The read model derives no issue or pull-request creation, closure, merge or reopen from an
  `updatedAt` field. The schema has no `updatedAt` field and refuses unknown fields, so there is
  nothing to infer from.
- No browser code fetches GitHub, or anything else. The rendered document embeds no remote
  resource and issues no request.
- No second lifecycle truth source is created. The flow artifact records *events that already
  happened*; it never decides a drain state, a telemetry run state or a portfolio item state, and
  no module reads it to do so.
- Nothing here animates. Throughput is a standing measurement over a closed window; a pulse would
  suggest something is happening about it right now, which is the exact conflation this product
  removed twice already.
- No ETA, no forecast, no completion percentage and no capacity plan is derived from throughput.
- DuckDB is **not** introduced. It is not a dependency of this repository, so R0 adds no
  analytical mirror of any kind; the JSON artifact is the whole interface and a downstream
  analyst bench may read it without this product knowing.

## Design It Twice — where the flow evidence seam goes

### Seam 1 — derive throughput from the portfolio snapshot's `updatedAt` fields

The GitHub portfolio survey already carries per-item timestamps, so counting items whose
`updatedAt` falls inside a window needs no new input at all.

Rejected, and it is the most dangerous of the three. `updatedAt` moves for a label change, a
comment, a bot edit, an assignee change and a rename. Counting it as "closed" manufactures
throughput out of chatter, in the exact direction that reassures. It also cannot distinguish
`MERGED` from `CLOSED_WITHOUT_MERGE`, cannot see a reopen at all, and silently reports zero for
any window older than the single snapshot it holds. It is a fabricated lifecycle truth source
wearing a count.

### Seam 2 — extend the factory telemetry spine with throughput events

The spine is already append-only, content-addressed and replayed by the control room.

Rejected. Every spine run is bound to a portfolio `itemId`, a lane token and a gate vocabulary,
and the events this section needs — an issue opened by a human, a commit landed by someone else's
merge queue, a pull request closed without merge — have none of those and never will. Writing them
into the durable evidence log the drain, the receipts and every downstream reader treat as
lifecycle truth converts a read-only measurement into an authority-bearing append, and creates the
second lifecycle truth source the brief forbids by name.

### Seam 3 — a sealed, content-addressed `gaia-engineering-flow/1` artifact, consumed through one explicit CLI flag — **selected**

Two pieces and one file between them:

- `src/engineering-flow.mjs` — the closed `gaia-engineering-flow/1` schema, its total verifier, the
  single digest recipe, and one pure derivation from a verified artifact to the block the control
  room publishes. It reads nothing, opens nothing, holds no clock, and imports `node:crypto` only.
- `scripts/factory-dashboard.mjs` — `--engineering-flow <path>`. The publisher reads the sealed
  artifact, hands it to `buildControlRoomSnapshot` as an explicit input exactly as it already
  hands over `telemetryProjection`, `dependencies` and `localLanes`, and computes the read model
  deterministically from those bytes and one instant.

Who *produces* the artifact is deliberately out of scope for R0. The schema is the interface: a
collector, a scheduled export, a hand-written fixture or a downstream analyst bench can all write
one, and every one of them meets the same total verifier. That is the property that makes this
seam replayable — an operator can read the file, a test can hand-write it, and deleting the flag
removes the feature with no residue in any durable log.

## Design It Twice — how throughput is displayed

### Display 1 — a single "velocity" number in the header

Rejected. One scalar over five incommensurable resources is the collapse
`docs/discrete-coordination-mechanics.md` refuses by name: messages, work items, commits, runs and
reviews keep their own units, and there is no calibrated dimensionless normalization to collapse
them with. It would also make `0` and `unknown` indistinguishable at exactly the moment the
distinction matters most.

### Display 2 — a sparkline per family

Rejected for R0. A sparkline is a claim about a *shape* over time, and the artifact declares
completeness for one window boundary only. Drawing a curve through a window whose left half is
`UNKNOWN` renders the unknown part as a line at zero — the same defect as Display 1, with better
graphics.

### Display 3 — a family × window matrix of exact counts, each cell carrying its own state — **selected**

Five family rows, three window cells each, and every cell independently `MEASURED` or `UNKNOWN`
with its own reason. A cell that is measured shows the exact integer — including `0` — its rate,
its per-outcome breakdown, its queue arithmetic where an inflow exists, and its cycle-time median
where honest durations exist. A cell that is not measured shows the word `UNKNOWN`, the symbol
`○`, and what evidence is missing. The two readings are different words, different symbols and
different `data-state` attributes, so they cannot be confused by an operator, a screen reader or a
test.

## Closed artifact schema

`gaia-engineering-flow/1`. Exactly eight top-level keys; any other key is refused.

```json
{
  "schema": "gaia-engineering-flow/1",
  "effect": "NONE",
  "authority": "NONE",
  "observedAt": "2026-08-30T18:10:00.000Z",
  "windowStartedAt": "2026-08-16T18:10:00.000Z",
  "sequence": 41,
  "events": [
    {
      "eventId": "gh-issue-17-closed-1",
      "occurredAt": "2026-08-30T17:41:02.000Z",
      "family": "ISSUE",
      "outcome": "CLOSED",
      "repository": "GuitarAlchemist/gaia",
      "workItemId": "issue-17",
      "startedAt": "2026-08-29T09:12:44.000Z",
      "sourceKind": "GITHUB_EVENT",
      "sourceRevision": "9df446ffa6b5ea2fc06d51eb29a5dbbe1bcc8732a73b45854bd57db6510183a9"
    }
  ],
  "revision": "<sha256 over the canonical body>"
}
```

Exactly nine per-event keys; any other key is refused, which is the mechanism that makes
"explicit events only" enforceable rather than promised. There is no `updatedAt`, no `title`, no
`body`, no `author`, no `heartbeat`, no `tokens`, no `bytes` and no `pid`, and none of them can be
added by a producer.

### Field rules

| Field | Rule |
| --- | --- |
| `schema` | Exactly `gaia-engineering-flow/1`. |
| `effect`, `authority` | Exactly `NONE`. |
| `observedAt` | Exact ISO instant. The instant this evidence set was read; every window ends here. |
| `windowStartedAt` | Exact ISO instant, at or before `observedAt`. The instant from which this evidence set claims to be **complete**. |
| `sequence` | Safe integer `>= 0`. Monotonic per producer; used to refuse a source snapshot that went backwards. |
| `events` | At most 512, in strictly ascending `(occurredAt, eventId)` order, with no repeated `eventId`. |
| `eventId` | Bounded identity `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. The stable event identity; duplicates are refused, never de-duplicated. |
| `occurredAt` | Exact ISO instant, the canonical UTC instant of the event. Must be at or after `windowStartedAt` and at or before `observedAt`. |
| `family` | Closed: `ISSUE`, `PULL_REQUEST`, `COMMIT`, `FACTORY_RUN`, `EVIDENCE_REVIEW`. |
| `outcome` | Closed **per family** — see below. A family/outcome pair outside the table is refused. |
| `repository` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Required for `ISSUE`, `PULL_REQUEST`, `COMMIT`; may be `null` for `FACTORY_RUN` and `EVIDENCE_REVIEW`, which are not repository-scoped facts. |
| `workItemId` | Bounded identity, required for every family. The subject the event is about. |
| `startedAt` | Exact ISO instant at or before `occurredAt`, or `null`. The comparable start of a closing event, and the only input to cycle time. |
| `sourceKind` | Closed: `GITHUB_EVENT`, `GIT_HISTORY`, `FACTORY_TELEMETRY`, `DRAIN_RECEIPT`, `EVIDENCE_LEDGER`. |
| `sourceRevision` | Exactly 64 lowercase hex characters. The digest of the source the producer read. |
| `revision` | `sha256` over the canonical JSON of the whole body without `revision`. One recipe, exported once. |

Every event's `effect` and `authority` are the artifact's, which are fixed at `NONE`: an event
cannot carry a different one, because the field does not exist per event and unknown fields are
refused.

### Family and outcome vocabulary

| Family | Outcomes | Inflow | Outflow | Closing (cycle time) |
| --- | --- | --- | --- | --- |
| `ISSUE` | `OPENED`, `REOPENED`, `CLOSED` | `OPENED`, `REOPENED` | `CLOSED` | `CLOSED` |
| `PULL_REQUEST` | `OPENED`, `REOPENED`, `MERGED`, `CLOSED_WITHOUT_MERGE` | `OPENED`, `REOPENED` | `MERGED`, `CLOSED_WITHOUT_MERGE` | `MERGED`, `CLOSED_WITHOUT_MERGE` |
| `COMMIT` | `PRODUCED_ON_WORK_BRANCH`, `INTEGRATED_INTO_DEFAULT_BRANCH` | `PRODUCED_ON_WORK_BRANCH` | `INTEGRATED_INTO_DEFAULT_BRANCH` | `INTEGRATED_INTO_DEFAULT_BRANCH` |
| `FACTORY_RUN` | `COMPLETED`, `FAILED` | — | `COMPLETED`, `FAILED` | `COMPLETED`, `FAILED` |
| `EVIDENCE_REVIEW` | `APPROVED`, `REFUSED` | — | `APPROVED`, `REFUSED` | `APPROVED`, `REFUSED` |

`REFUSED` is the single name for a refusal and a request-for-changes verdict: both are the same
fact about the queue — the artifact did not pass and the work returns to its author — and spelling
them separately would invite a reader to add them and call the sum something else.

`FACTORY_RUN` and `EVIDENCE_REVIEW` have no inflow outcome because none was observed to exist as a
discrete, independently sourced event. Their queue arithmetic is therefore `UNKNOWN` with the
reason `NO_OBSERVED_INFLOW`, not zero, and not a fabricated `RUN_STARTED` invented so a net could
be printed.

### Contradictory terminal outcomes

Two outcomes are *mutually exclusive terminals* when one being true makes the other impossible for
the same subject:

- `PULL_REQUEST`: `MERGED` and `CLOSED_WITHOUT_MERGE`.
- `FACTORY_RUN`: `COMPLETED` and `FAILED`.

An artifact carrying both for one `workItemId` is refused outright. Nothing else in the table is
mutually exclusive and nothing else is treated as such: an issue closed, reopened and closed again
is an ordinary history, and a review that requested changes and later approved is the review
process working. Refusing those would be a fabricated contradiction, which is the same class of
error as a fabricated count.

### Refusal rules

Every one of these is a typed `EngineeringFlowError` and a refusal to *display*, never a repair:

1. `schema`, `effect` or `authority` wrong, or an unknown top-level or per-event field present.
2. Any instant that is not exact — `Date.parse` is not a validator, so `2026-08-30` is refused
   rather than widened to midnight UTC, and a value must round-trip through `Date#toISOString`.
3. `occurredAt` after `observedAt`, `windowStartedAt` after `observedAt`, `occurredAt` before
   `windowStartedAt`, or `startedAt` after `occurredAt`. Future evidence is refused, never clamped:
   clamping converts incoherent time into a false reading of freshness.
4. A repeated `eventId`, or events not in strictly ascending `(occurredAt, eventId)` order.
5. An unsupported `family`, `outcome`, family/outcome pair, or `sourceKind`.
6. Mutually exclusive terminal outcomes for one `workItemId`.
7. `revision` that does not match the canonical digest of the body.
8. More than 512 events.
9. A source snapshot that went backwards: when a prior observation of the same source is supplied,
   an artifact whose `observedAt` or `sequence` is lower than the prior one's is refused.

The consumer additionally refuses an artifact `observedAt` after the instant the control room read
it, for the same reason `localLanes` does.

## Read model

`summarizeEngineeringFlow({ artifact, observedAt, priorObservation })` returns one block. The
control room publishes it under `engineeringFlow` and **omits the key entirely when there is no
artifact**, never publishing `null`: a present key holding `null` canonicalises into the digest and
would move every previously published snapshot revision for evidence that did not change.

### Where the windows end, and why

Windows end at the **artifact's** `observedAt`, not at the snapshot's. The artifact is what
declares which interval its evidence is complete over; ending the windows anywhere else would
report a count for an interval nobody claimed to have observed. The staleness of that reading is
published separately — `observationAgeMs` against `ENGINEERING_FLOW_FRESH_MS`, with an explicit
`FRESH`/`STALE` state — so an operator reading `4 closed in the last hour` can see how old *the
last hour* is.

`ENGINEERING_FLOW_FRESH_MS` is 300 000 ms and is its own constant. It is not borrowed from
`HEARTBEAT_FRESH_MS` and not borrowed from `LOCAL_LANE_OBSERVATION_FRESH_MS`; those answer "did the
run prove it is alive?" and "did the pane sensor run?". This one answers "how stale is this
throughput reading?", and it is five minutes because the shortest published window is one hour: an
artifact older than that is more than eight per cent of the shortest window out of date and can no
longer honestly be read as "the last hour".

### Completeness, and the difference between 0 and UNKNOWN

A window of `W` milliseconds is **complete** when

```
Date.parse(windowStartedAt) <= Date.parse(observedAt) - W
```

- Complete → `state: "MEASURED"`. `total` is an exact integer, possibly `0`. Every per-outcome
  count is an exact integer, possibly `0`. `ratePerHour` is `total / hours`, rounded to four
  decimal places by one deterministic formula.
- Incomplete → `state: "UNKNOWN"`, `reasonCode: "WINDOW_INCOMPLETE"`, and `total`, `ratePerHour`
  and every per-outcome count are `null`. **Never `0`.**

This is the single most important rule in this document. Zero and unknown are opposite readings:
one says the queue produced nothing, the other says we did not look. A dashboard that prints `0`
for both is worse than one that prints nothing, because it is confidently wrong in the reassuring
direction.

### Queue arithmetic

For `ISSUE`, `PULL_REQUEST` and `COMMIT` over a complete window:

```
inflow  = sum of the family's inflow outcomes
outflow = sum of the family's outflow outcomes
net     = inflow - outflow
```

`net` is a **queue change**, not a backlog: it says the tracked queue grew or shrank by that many
items over that window, and it says nothing about its absolute size. For `FACTORY_RUN` and
`EVIDENCE_REVIEW` it is `UNKNOWN` / `NO_OBSERVED_INFLOW`.

### Cycle time

Over a complete window, let `C` be the family's closing events inside it.

- `C.length < 5` → `UNKNOWN` / `NOT_ENOUGH_COMPARABLE_DURATIONS`. Five is the same threshold the
  existing pace and ETA policy already uses, quoted rather than re-invented.
- any `c` in `C` with `startedAt === null` → `UNKNOWN` / `INCOMPLETE_COMPARABLE_DURATIONS`. A
  median over the subset that happens to carry a start is a selection-biased estimate presented as
  a measurement, so the whole cell is withheld rather than computed over what is convenient.
- otherwise → `MEASURED`, `sampleSize = C.length`, `medianMs` = the lower median of the sorted
  durations, matching `measurePace`'s existing convention exactly.

### Published block

```json
{
  "source": "GAIA_ENGINEERING_FLOW",
  "state": "FRESH",
  "binding": "NONE",
  "observedAt": "2026-08-30T18:10:00.000Z",
  "windowStartedAt": "2026-08-16T18:10:00.000Z",
  "artifactRevision": "<sha256>",
  "sequence": 41,
  "observationAgeMs": 0,
  "freshnessWindowMs": 300000,
  "eventCount": 1,
  "families": [
    {
      "family": "ISSUE",
      "windows": [
        {
          "window": "PT1H",
          "windowMs": 3600000,
          "state": "MEASURED",
          "reasonCode": null,
          "total": 1,
          "ratePerHour": 1,
          "outcomes": { "OPENED": 0, "REOPENED": 0, "CLOSED": 1 },
          "queue": { "state": "MEASURED", "reasonCode": null, "inflow": 0, "outflow": 1, "net": -1 },
          "cycleTime": { "state": "UNKNOWN", "reasonCode": "NOT_ENOUGH_COMPARABLE_DURATIONS", "sampleSize": 1, "medianMs": null }
        }
      ]
    }
  ],
  "events": [ "… the verified events, verbatim …" ]
}
```

The block carries `events` verbatim. That is a deliberate size cost paid for one property: the
render seam re-derives the **entire** block — every count, rate, state, reason, queue figure and
median — from those events and those instants, and refuses a snapshot whose published block is not
what its own evidence derives. A digest taken over evidence the verifier cannot see is not
verifiable, and this product has already twice found that the field an operator reads as "work is
happening" is the highest-value one to forge in a resealed snapshot.

## Truth rules

1. Activity and capacity signals are not throughput, and cannot become throughput. The vocabulary
   has no `HEARTBEAT`, `TOKEN`, `STDOUT_BYTES`, `SPINNER` or `PROCESS_LIVENESS` family, unknown
   families are refused, and the block feeds neither `headline`, nor `showSpinner`, nor
   `nextAction`, nor `obstruction`. Two snapshots differing only in their flow artifact carry a
   byte-identical headline, spinner decision and next action.
2. Nothing in the flow section animates. There is no pulse, no keyframe and no live region: a
   throughput count over a closed window is a standing fact.
3. `0` in a complete window and `UNKNOWN` over an incomplete one are different published states,
   different rendered words, different symbols and different `data-state` attributes, in English
   and in French.
4. No lifecycle state is decided here. The flow block never sets, contradicts or overrides a drain
   state, a telemetry run state or a portfolio item state, and no module reads it to do so.
5. Every event carries its own canonical UTC instant, its subject identity, its source kind, its
   source digest, artifact-level `effect: NONE` and `authority: NONE`, and a stable event identity.
6. The renderer issues no network request of any kind. Browser-side script in this document only
   ages the already-displayed snapshot; it gains nothing new here.
7. Removing `--engineering-flow` from a publisher invocation produces a document byte-identical to
   the one produced before this feature existed.

## Responsive layout rules

- Base (phone): the family list is one column and each family's three windows are one column. No
  rule is wider than a 320 px viewport and nothing scrolls sideways.
- `768px`: each family's windows become three columns — the natural shape of the matrix — and the
  family list stays one column.
- `1024px`: the family list becomes two columns.
- `1440px`: the family list becomes three columns, so a desktop uses the width it has rather than
  leaving a narrow strip.
- Every state carries a word **and** a symbol; colour is never the only carrier of meaning. Every
  decorative symbol is `aria-hidden="true"` and the section names itself with an `aria-label`.

## Interfaces

`summarizeEngineeringFlow({ artifact, observedAt, priorObservation })` in
`src/engineering-flow.mjs` is the flow truth Module. It is pure, imports only `node:crypto`, holds
no clock, and is usable without the control room.
`requireEngineeringFlowArtifact(value)` totally verifies one sealed artifact on its own terms.
`sealEngineeringFlow({ observedAt, windowStartedAt, sequence, events })` orders and content-
addresses one. `engineeringFlowRevision(...)` is the single digest recipe, exported so no consumer
has to grow a second implementation of it. `deriveEngineeringFlowBlock(...)` is the one derivation
the builder and the render-seam verifier both call.

`buildControlRoomSnapshot({ …, engineeringFlow, priorEngineeringFlow })` takes the sealed artifact
as one more explicit input. `requireControlRoomSnapshot` re-derives the whole published block.
`renderControlRoomHtml` renders one section, in English or French, between the local lanes and the
verifiable progress.

`npm run factory:dashboard -- --engineering-flow <path>` is the only way the artifact reaches the
publisher. Without the flag the feature is absent and the document is unchanged. The publisher
reads the prior observation for the monotonicity check out of the snapshot it published last time,
verified with the same total verifier the render seam applies — the same carrier the observation
window already uses, so no private state store is introduced.

## Reversibility

**Class: freely reversible.** No listener, no persistent store, no migration, no bus export, no
privileged effect and no new dependency. Removing the module, the flag, the section, the tests and
this document removes the behaviour with no residue in any durable log and no transformation of
user data. Roll back if independent review finds that a count can be displayed that its own
published events do not derive, or that any activity or capacity signal can reach the model.

## Falsifiers

The implementation is wrong if any of these can be made to happen:

1. An incomplete window renders `0` instead of `UNKNOWN`.
2. A duplicate `eventId`, a future instant, an unknown family, a contradictory terminal pair, a
   tampered revision or a backwards `sequence` is accepted.
3. An event is counted from an `updatedAt`-shaped field, or any field outside the closed nine.
4. A heartbeat, token, byte count, spinner or PID changes any published number.
5. A cycle-time median is published over a sample of fewer than five, or over a sample where any
   closing event lacks a start.
6. A resealed snapshot displays a count its own carried events do not derive.
7. The flow block changes the headline, the spinner, the next action or the obstruction.
8. The rendered document issues a network request, or animates anything in this section.
9. English and French disagree about any state, count or reason, or either language is incomplete.

## Rejection criterion

Reject this work if reviewing it shows that throughput and liveness have been re-conflated in any
direction — a count that a running process can move without an engineering event, or an engineering
event that is displayed as liveness. The whole value of this section is that it answers a different
question from the one the local-lane section answers, using evidence the local-lane section cannot
produce.

## Decision Receipt

- **Decision:** add one sealed, content-addressed `gaia-engineering-flow/1` artifact, consumed
  through one explicit publisher flag, projected by one pure module into one re-derived control-room
  block and one non-animated responsive section.
- **Alternatives rejected:** deriving throughput from portfolio `updatedAt` (fabricates counts from
  chatter, cannot see reopen or merge-vs-close, and is a second lifecycle truth source); extending
  the telemetry spine (binds unbindable events and converts a measurement into a durable
  authority-bearing append); a single velocity scalar (collapses five incommensurable units);
  sparklines (draw the unknown part of a window as a line at zero).
- **Authority delta:** none. `effect: NONE`, `authority: NONE`, six bus verbs unchanged, no network,
  no new dependency, no new command.
- **Reversibility:** freely reversible.
- **Falsifiers:** the nine listed above, each with at least one gate and, for the two mechanisms the
  brief names, a mechanism-revert mutation proving the gate tests the mechanism rather than the
  outcome.

## Gates

In `tests/engineering-flow.test.mjs`:

| Gate | What it holds |
| --- | --- |
| F1 | The closed schema round-trips, seals deterministically, and is deeply frozen. |
| F2 | Unknown top-level and per-event fields are refused — including `updatedAt`. |
| F3 | Non-exact, future and incoherent instants are refused rather than clamped. |
| F4 | Duplicate event identities and non-ascending order are refused. |
| F5 | Unsupported family, outcome, family/outcome pair and source kind are refused. |
| F6 | Contradictory terminal outcomes are refused; legitimate reopen and re-review histories are not. |
| F7 | A tampered revision is refused. |
| F8 | A backwards `observedAt` or `sequence` against a prior observation is refused. |
| F9 | Exact counts and rates over a complete 1h, 24h and 7d window. |
| F10 | An incomplete window is `UNKNOWN` with `WINDOW_INCOMPLETE`, and every count is `null`. |
| F11 | A complete window with no events is `MEASURED` with `total: 0`. |
| F12 | Queue arithmetic where an inflow exists; `NO_OBSERVED_INFLOW` where it does not. |
| F13 | Cycle time only at five or more closing events all carrying a start. |
| F14 | Deterministic replay: identical evidence produces byte-identical blocks. |
| F15 | The digest recipe and the exact-instant rule each have exactly one implementation. |
| F16 | An activity or capacity family cannot be expressed at all. |

In `tests/control-room-engineering-flow.test.mjs`:

| Gate | What it holds |
| --- | --- |
| C1 | An absent artifact moves no published snapshot revision, and a present `null` is refused. |
| C2 | The block never touches the headline, spinner, next action or obstruction. |
| C3 | The render seam re-derives the whole block; a resealed count is refused. |
| C4 | `0` and `UNKNOWN` render as different words, symbols and `data-state` values. |
| C5 | The section animates nothing and adds no keyframe. |
| C6 | The French document translates the whole section and leaks no English copy. |
| C7 | One phone column, and the desktop breakpoints use the width they have. |
| C8 | Every state carries a word and a symbol; symbols are `aria-hidden`; the section is labelled. |
| C9 | The document issues no network request. |
| C10 | The `--engineering-flow` flag plumbs through, and the CLI refuses an unreadable or aliased path. |
| C11 | Deterministic replay through the CLI. |
| MR1 | Mechanism revert: widening the event field list to admit `updatedAt` is what would let an inferred lifecycle field in. |
| MR2 | Mechanism revert: making every window complete is what would print `0` for unknown evidence. |

## What R0 does not claim

R0 does not claim to *produce* the artifact from any live source. It defines and consumes the
seam; a collector is separate work with its own authority question. It does not claim a trend, a
forecast, a capacity model or a cause. It does not claim that a complete window is an accurate
window — completeness is the producer's assertion, verified for internal coherence and refused when
incoherent, and no verifier here can prove an event the producer never wrote down. It does not
mirror anything into DuckDB.
