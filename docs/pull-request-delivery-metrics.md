# Pull-request delivery metrics

Status: issue #89 R0 is a tracer bullet. It ingests one closed, revision-bound fixture pull-request
lifecycle, projects a small closed set of named intervals and counts, and renders one bounded
managed Markdown summary. It performs no GitHub mutation, holds no provider client, and grants no
transition, merge, retry, or scheduling authority.

## Operator outcome

For one pull request, R0 answers a bounded subset of the operator questions: how long draft,
review, CI queue, CI execution and conflict repair took on the exact head under test, how many
delivery rounds, review cycles, check runs and conflict episodes occurred, whether the initial
delivery forecast was hit, and which of those are `UNKNOWN(reason)` because the evidence is absent.
Anything the fixture does not witness is named as an unknown with its reason. It is never zero.

## Authority

GitHub-shaped observations are the authoritative input. R0 accepts them only as deterministic
fixtures; it opens no socket and runs no provider command. Normalization produces append-only,
content-addressed facts, and every derived number is a function of those facts alone. Before the
projection reads a fact set it re-derives every fact's evidence revision and event identity and the
set's facts revision, exactly as a terminal receipt is re-verified against its sealed revision; a fact
set that does not match its own revisions is a typed refusal, so the facts revision the summary
publishes is one the projection verified, never a stamp it passed through. An observation whose fields
are accessor-backed rather than plain data is refused before any field is read twice.

The analytical projection is disposable. Deleting the store and rebuilding it from the same facts
yields byte-equivalent canonical rows, and the pure in-process projection — not the store — remains
the authority the summary is rendered from. The store computes facts-derived intervals and counts
only. Authority-bound fields never enter it: `deliveredAt`, the initial forecast, and the forecast
verdict have no column there, so no query can invent a delivery.

## Closed event vocabulary

```text
DRAFT_OPENED  HEAD_ADVANCED  READY_FOR_REVIEW  REVIEW_SUBMITTED
CHECK_QUEUED  CHECK_STARTED  CHECK_COMPLETED
CONFLICT_OBSERVED  CONFLICT_RESOLVED  FORECAST_RECORDED  MERGED
```

Every observation carries its repository, pull-request number, head binding, exact instant, the
provider's own event identifier, one scalar subject, one closed outcome token, and — for
`FORECAST_RECORDED` only — an integer minute window. A fact is refused, never repaired, when a
field is missing, a timestamp is not an exact instant, the subject pull request does not match, or
the instant is after the observed instant.

## Identity, coalescing, and replay

Event identity is `(repository, pullRequestNumber, kind, providerEventId)` digested. Two
observations of the same provider event — a webhook and a poll — coalesce into one fact. Two
observations claiming the same identity with different content are a typed conflict refusal, not a
last-writer-wins overwrite: delivery order cannot fabricate state.

Facts are ordered by `(occurredAt, kind, eventIdentity)`, so a shuffled or duplicated input stream
produces the identical facts revision and the identical projection revision.

## Head generations

A head generation is opened by `DRAFT_OPENED` and by each `HEAD_ADVANCED`, and it owns the facts
that carry its head oid from its opening instant until the next generation opens. Binding is by
generation, not by oid alone. Metrics named `*_CURRENT_HEAD` read only the facts owned by the
current generation, which is the latest generation carrying the current head. A green check on a
superseded head is retained as history and can never satisfy the current head; when the current head
has no green check the metric is `UNKNOWN(NO_GREEN_CHECK_ON_CURRENT_HEAD)`.

A force-push that returns the branch to an earlier tree (`A → B → A`) opens a third generation with
the first one's oid. The first generation keeps its own checks and its own fact count, and the third
starts with none: a delivery round is a push, not a tree, and the provider re-runs checks on the new
push. Evidence stamped before the generation it names — a check that reports on a head before the
advance to that head is stamped — belongs to no generation and is not attributed to the current head.
The analytical store applies the same window, so both engines agree on this lifecycle.

## Named metrics (R0)

Intervals: `DRAFT_AGE`, `TIME_TO_FIRST_REVIEW`, `CI_QUEUE_CURRENT_HEAD`,
`CI_EXECUTION_CURRENT_HEAD`, `TIME_TO_GREEN_CURRENT_HEAD`, `CONFLICT_REPAIR`, `TOTAL_LEAD_TIME`.

Counts: `DELIVERY_ROUNDS`, `HEAD_CHANGES`, `REVIEW_CYCLES`, `CHECK_RUNS_CURRENT_HEAD`,
`CONFLICT_EPISODES`.

Each is published as a named fact with its own value or its own unknown reason. An interval whose
end is stamped before its start is `UNKNOWN(INCONSISTENT_ORDER)` in both the pure projection and
the analytical store; neither engine publishes a negative duration. R0 publishes no composite,
weighted, or normalized score, and no metric triggers an effect.

## Forecast and delivery

The initial forecast is the earliest `FORECAST_RECORDED` fact, decided by instant and then by event
identity. A later forecast is recorded as the current forecast and can never replace the initial
one, in any arrival order.

`deliveredAt` comes only from an authorized terminal receipt bound to this exact repository, pull
request, and current head. A `MERGED` observation is evidence, not authority, and does not set it.
An unbound receipt is refused. With no receipt the delivery fields are
`UNKNOWN(NO_AUTHORIZED_TERMINAL_RECEIPT)`, and the forecast verdict is unknown with them.

Token and provider cost are `UNKNOWN(NO_ATTRIBUTED_RECEIPT)` in R0: no signed cost receipt exists
yet, and activity is not progress.

## Managed Markdown

The summary occupies one region between two exact marker comments. Text outside the region is
preserved byte-for-byte, and a body carrying zero or more than one begin/end pair is ambiguous and
refused rather than rewritten. The region carries the repository, pull request, current head, facts
revision, projection revision, and observed instant, so a reader can re-derive it.

Publication is prepared as a no-effect intent under compare-and-set: the caller supplies the body
revision it observed and the revision it expects, and a stale projection head or a stale body
revision is refused. R0 ships no publication effect adapter.

## Not in R0

No workflow, no artifact upload, no portfolio-wide query, no webhook or polling collector, no
provider client, no cost receipt, no bus verb, no new configuration, and no live GitHub mutation
anywhere in the tests. Those remain later slices of #89.
