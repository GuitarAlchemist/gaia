# Merge queue capability R0 — design decision and contract

Status: design decision plus the contract the tests hold. This document grants no authority,
starts no lane, opens no network connection, administers no repository and approves nothing. It
records what was decided before implementation, which seams were rejected, and the falsifiers the
tests attempt.

## Operator problem

Gaia waited for pull request #34 to enter a merge queue that did not exist.

The evidence available at the time said so plainly, and nothing in Gaia read it:

- `GET /repos/{owner}/{repo}/rulesets` returned an empty list. Zero rulesets, so no ruleset could
  carry a `merge_queue` rule.
- `GET /repos/{owner}/{repo}/branches/main/protection` returned `404`. No classic branch
  protection either.
- The pull request itself was clean, green and had no `autoMergeRequest`.

Gaia held the third fact and read it as *the queue has not picked it up yet*. It is the first two
facts that decide the question, and Gaia never asked them.

The drain then did exactly what it was built to do with a published pull request that will not
merge. `PUBLISHED` maps to `AUTHORITY_STARVATION` in `src/portfolio-drain-obstruction.mjs:75`, and
the operator was told to *ask a human for the explicit grant the item is waiting on*. There was no
grant to ask for. Nothing was withheld, nothing was pending, nobody was slow: the mechanism the
item was waiting on had never been created. An absent capability was reported as slow progress,
which is the single most expensive misreading this product can make, because waiting is free and
therefore never stops on its own.

Worse, while a lane was alive the obstruction did not report even that much. The classifier
short-circuits to `NONE` when any occupied lane is `ACTIVE`
(`src/portfolio-drain-obstruction.mjs:456`). A live worker is exactly what Gaia had — a process
polling a queue that did not exist. Liveness masked the gap, which is the conflation
`docs/engineering-flow-throughput.md` and `docs/local-wmux-lanes.md` have each already refused
once in a different direction.

### Affected actor and consumer

The operator reading `gaia-control-room.html` and asking why a green pull request has not merged,
and the drain gate that decides whether waiting is a reasonable thing to do. The consumers of the
new evidence are `classifyPortfolioDrainObstruction` and `buildControlRoomSnapshot`, both of which
already refuse evidence they cannot verify and must keep refusing at exactly that standard.

### Success criteria

1. Before Gaia plans, displays or waits on a merge queue, the capability of that exact repository
   and that exact default branch is resolved to **one** state from a closed vocabulary of six:
   `AVAILABLE`, `ABSENT`, `MISCONFIGURED`, `PERMISSION_DENIED`, `STALE`, `UNKNOWN`.
2. `ABSENT` is an actionable obstruction carrying exactly one next action. It is never rendered,
   published or worded as queued, pending, in progress, or with any estimate of when it will
   resolve, because none of those is true of a thing that does not exist.
3. Capability is never inferred from a pull request's `mergeable`, `mergeStateStatus`,
   `autoMergeRequest`, check conclusion or review decision. Those describe an item under a
   configuration; this describes the configuration.
4. Every reading binds its evidence: repository identity, repository name, default branch, the
   digest of the exact ruleset payload read, the permission decision, and the canonical UTC
   instant of observation.
5. A live lane cannot suppress a capability obstruction. Process liveness proves a process is
   alive and proves nothing about whether a merge queue exists.
6. Optional remediation preserves every existing rule and every existing required check, or it
   refuses. One durable intent, one effect, compare-and-swap over the expected configuration,
   a stable idempotency identity, and an exact reconciliation after a timeout, a crash or a lost
   response. No blind retry.
7. The GitHub portfolio, the telemetry spine, the drain machine, the local-lane sensor, the
   engineering-flow block and the six bus verbs keep their existing authority exactly.

### Falsifiable non-goals

- No scheduler, no queue hierarchy, no second state machine, no database, no provider layer and no
  recovery framework is introduced. The pump stays `collect ready item -> claim -> Draft PR ->
  review/CI -> merge -> collect next`. Capability is **one preflight fact at the existing merge
  gate**, entering through the same explicit-input seam `dependencies` and `localLanes` already
  use.
- This writer run administers no GitHub repository. It creates no ruleset, edits no branch
  protection, enables no auto-merge, pushes nothing and opens no pull request. The remediation
  path is *prepared and refused-by-default*; performing it is the supervising operator's act.
- No new dependency, no Docker, no MCP startup, no paid API, no install and no WebSocket.
- The retry surface is not widened. Nothing here retries anything. Reconciliation is a *read* that
  decides whether an effect already landed; it is not a retry, and it never issues a second write
  on its own.
- DuckDB is **not** introduced, exactly as `docs/engineering-flow-throughput.md` decided. It is not
  a dependency of this repository. The deterministic projection this evidence flows into is the
  existing `gaia-portfolio-drain-projection/1` and the existing content-addressed control-room
  snapshot. Because no analytical store exists in the execution path at all, an unavailable one
  cannot stop the pump — structurally, not by policy. A downstream analyst bench may read the
  sealed artifact and answer throughput, age, bottleneck and disagreement questions without this
  product knowing, and it owns no scheduling, no claim, no retry and no effect when it does.

## Design It Twice — where the capability fact comes from

### Seam 1 — infer the queue from the pull request's own mergeability

The portfolio survey already reads pull requests. `mergeStateStatus`, `mergeable` and
`autoMergeRequest` are right there, and a queued pull request looks different from an unqueued one.

Rejected, and it is the seam that caused the incident. Those fields describe an *item under a
configuration*; the question is about the configuration. A clean, green pull request in a
repository with no merge queue and a clean, green pull request that a merge queue has not yet
reached are indistinguishable in every one of those fields — Gaia has already run the experiment
and got the wrong answer. Inferring a capability from an instance is how "does not exist" becomes
"has not happened yet", and no amount of care in reading those fields removes that. The artifact
schema below therefore has no field for any of them, and refuses unknown fields, so the inference
cannot be added later by a producer.

### Seam 2 — probe GitHub live inside the drain gate

Read the rulesets at the moment the merge decision is made, so the answer is never stale.

Rejected. `src/portfolio-drain-obstruction.mjs` "reconciles nothing, re-measures no heartbeat, owns
no clock, opens no socket, calls no provider, retries nothing and adds no bus verb" — that is its
own header, and it is the property that makes the drain replayable and testable at all. Putting a
network read inside it makes the classifier nondeterministic, makes every barrier test a network
test, and makes a GitHub outage into a drain outage. It also answers freshness by pretending the
problem away rather than by measuring it, which hides the one number an operator needs when the
answer is `AVAILABLE`: how old is that?

### Seam 3 — a sealed, content-addressed `gaia-merge-queue-capability/1` artifact, produced by one read-only probe and consumed through one explicit input — **selected**

Three pieces and one file between them:

- `src/merge-queue-capability.mjs` — the closed `gaia-merge-queue-capability/1` schema, its total
  verifier, the single digest recipe, the pure decision from observation to state, the freshness
  downgrade to `STALE`, and the pure remediation planner, executor and reconciler. It reads
  nothing, opens nothing and holds no clock.
- `probeMergeQueueCapability({ repository, repositoryId, defaultBranch, read, observedAt })`, in
  that same module — the one read-only producer. `src/github-read-adapter.mjs` itself is not
  modified: its `gaia-github-read-snapshot/1` schema is consumed by the portfolio survey and
  widening it would change evidence three other modules already verify.

  The probe takes its own injected `read(args)`, returning `{ status, body, complete }`, rather than
  reusing `runGh`. That is not a preference. `runGh` (`src/github-read-adapter.mjs:6`) returns
  `null` for empty output, returns the raw string when the body is not JSON, and rejects with an
  `execFile` error whose `stderr` — the only place the HTTP status appears — is never read. Its
  return value therefore cannot distinguish `403` from `404` from `200 []`, and that distinction is
  the entire decision this module makes. Discarding the status is correct for the portfolio survey
  and disqualifying here.
- `scripts/factory-dashboard.mjs` — `--merge-queue-capability <path>`. The publisher reads the
  sealed artifact and hands it to `buildControlRoomSnapshot` as one more explicit input, exactly as
  it already hands over `dependencies`, `localLanes` and `engineeringFlow`. Without the flag the
  feature is absent and the document is byte-identical to the one produced before it existed.

Who *produces* the artifact on a schedule is out of scope for R0, for the same reason it was out of
scope for the flow artifact. The schema is the interface, and the same total verifier meets a
probe, a hand-written fixture and an operator's own export.

## Closed artifact schema

`gaia-merge-queue-capability/1`. Exactly nine top-level keys; any other key is refused.

```json
{
  "schema": "gaia-merge-queue-capability/1",
  "effect": "NONE",
  "authority": "NONE",
  "observedAt": "2026-08-30T19:18:00.000Z",
  "repositoryId": "R_kgDOExample",
  "repository": "GuitarAlchemist/gaia",
  "defaultBranch": "main",
  "observation": {
    "rulesetsRead": "OK",
    "rulesetsComplete": true,
    "protectionRead": "NOT_FOUND",
    "rulesets": [],
    "rulesetDigest": "5f2b…",
    "adminPermission": "ABSENT",
    "unknownRuleTypes": []
  },
  "revision": "<sha256 over the canonical body>"
}
```

### Field rules

| Field | Rule |
| --- | --- |
| `schema` | Exactly `gaia-merge-queue-capability/1`. |
| `effect`, `authority` | Exactly `NONE`. A capability reading is a read; it can never carry an effect. |
| `observedAt` | Exact ISO instant, round-tripping through `Date#toISOString`. The canonical UTC instant the probe read GitHub. |
| `repositoryId` | Bounded identity `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. GitHub's own node identity, **not** the name. A repository can be renamed and a name can be transferred; an identity cannot. Evidence bound to a name alone can silently describe a different repository. |
| `repository` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Carried beside the identity for the operator to read, never used to decide anything. |
| `defaultBranch` | Bounded branch name, 1 to 255 characters, no control characters. The exact branch the capability is claimed for. A merge queue on a branch nobody merges into is not the capability. |
| `observation.rulesetsRead` | Closed: `OK`, `FORBIDDEN`, `RATE_LIMITED`, `NOT_FOUND`, `FAILED`. |
| `observation.rulesetsComplete` | Boolean. Whether the listing was exhausted. A paginated or truncated read is not a complete one, and a merge queue rule on an unread page is indistinguishable from no merge queue rule at all. |
| `observation.protectionRead` | Closed: `OK`, `FORBIDDEN`, `RATE_LIMITED`, `NOT_FOUND`, `FAILED`. |
| `observation.rulesets` | At most 64 entries, each a closed four-key record — see below. Present only when `rulesetsRead` is `OK`; otherwise exactly `[]`. |
| `observation.rulesetDigest` | Exactly 64 lowercase hex characters when `rulesetsRead` is `OK`, otherwise `null`. `sha256` over the canonical JSON of `rulesets`. This is the compare-and-swap token. |
| `observation.adminPermission` | Closed: `PRESENT`, `ABSENT`, `UNKNOWN`. Whether the identity that read is known to be able to write. |
| `observation.unknownRuleTypes` | Sorted, deduplicated, at most 64 bounded rule-type names the probe saw and this version does not model. Non-empty is meaningful, never ignored. |
| `revision` | `sha256` over the canonical JSON of the whole body without `revision`. One recipe, exported once. |

Each entry of `observation.rulesets` has exactly four keys:

| Field | Rule |
| --- | --- |
| `rulesetId` | Bounded identity. GitHub's ruleset id, as a string. |
| `enforcement` | Closed: `active`, `evaluate`, `disabled`. |
| `targetsDefaultBranch` | Boolean. Whether this ruleset's ref-name condition resolves to include the named default branch — see the resolution rule below. |
| `mergeQueueRule` | `null`, or a closed record `{ "enabled": true }`. A rule this version does not model contributes its type name to `unknownRuleTypes` and never a `mergeQueueRule`. |

### Resolving `targetsDefaultBranch`

GitHub expresses a ruleset's ref-name condition as an `include` list and an `exclude` list, where
each entry is a literal ref such as `refs/heads/main` or one of the magic values `~ALL` and
`~DEFAULT_BRANCH`. The probe resolves the boolean against the *named* default branch:

- included when `include` contains `~ALL`, or `~DEFAULT_BRANCH`, or the literal
  `refs/heads/<defaultBranch>`;
- then excluded when `exclude` contains `~ALL`, `~DEFAULT_BRANCH`, or that same literal;
- a pattern the probe cannot resolve to one of those forms contributes its ruleset to
  `unknownRuleTypes` and therefore decides `UNKNOWN`, rather than being guessed either way.

Both halves matter. Matching only the literal misses a `~DEFAULT_BRANCH` ruleset that really does
govern the branch and produces a false `ABSENT`; ignoring `exclude` accepts a ruleset that includes
`~ALL` and then subtracts `refs/heads/main`, producing a false `AVAILABLE` — the failure this whole
document exists to prevent, arriving through the back door. A ruleset scoped to the literal
`refs/heads/main` also stops governing the moment the default branch is renamed, which is why the
boolean is resolved against the branch this artifact names rather than stored as a pattern.

There is no `mergeable`, no `mergeStateStatus`, no `autoMergeRequest`, no `checkConclusion`, no
`reviewDecision`, no `title`, no `author`, no `url`, no `token` and no `command` field, and
unknown fields are refused. That refusal is the mechanism that makes success criterion 3
enforceable rather than promised: there is no field a future producer could route a pull-request
status through.

## Deciding the state

`decideMergeQueueCapability({ artifact, observedAt })` is a total function from a verified artifact
and one instant to one state. It is evaluated in exactly this order, and the first rule that fires
wins.

| # | Condition | State |
| --- | --- | --- |
| 1 | `rulesetsRead` is `FORBIDDEN`, or `protectionRead` is `FORBIDDEN` | `PERMISSION_DENIED` |
| 2 | `rulesetsRead` is `RATE_LIMITED` or `FAILED`, or `protectionRead` is `RATE_LIMITED` or `FAILED` | `UNKNOWN` |
| 3 | `rulesetsRead` is `NOT_FOUND`, or `rulesetsComplete` is `false`, or `unknownRuleTypes` is non-empty | `UNKNOWN` |
| 4 | Exactly one `active` ruleset targets the default branch with `mergeQueueRule.enabled` | `AVAILABLE` |
| 5 | A merge queue rule exists but every carrier of it is `evaluate` or `disabled`, or does not target the default branch, or more than one carrier is `active` | `MISCONFIGURED` |
| 6 | No ruleset carries a merge queue rule at all | `ABSENT` |

Then, and only then, freshness is applied: if
`Date.parse(observedAt) - Date.parse(artifact.observedAt) > MERGE_QUEUE_CAPABILITY_FRESH_MS`, the
decided state is replaced by `STALE`. An `observedAt` before the artifact's own is refused, never
clamped, for the same reason the flow artifact refuses future evidence.

Eight notes on why these rules are what they are:

- **Rule 1 outranks everything.** GitHub answers `404` for a resource the caller may not see, so a
  `404` from a token without admin is indistinguishable from a `404` for a resource that does not
  exist. `PERMISSION_DENIED` is therefore decided from the read outcome, before any content is
  interpreted. The trap this avoids is the expensive one: a permission failure degrading to
  `ABSENT` and triggering a remediation that can only ever fail, forever.
- **A rate-limit or single-sign-on `403` is not a permission denial.** GitHub answers `403` for a
  primary rate limit, a secondary rate limit and a SAML session requirement, none of which is
  "your token lacks admin". Telling an operator to widen a token's scope because a rate limit was
  hit is a false next action, and classifying the same response as `ABSENT` is the original defect.
  The probe separates them into `RATE_LIMITED`, which is `UNKNOWN` and resolves by re-probing.
- **`ABSENT` requires a complete read.** `GET /repos/{owner}/{repo}/rulesets` paginates. A first
  page that happens not to contain the merge queue ruleset looks exactly like a repository that has
  none, which is `ABSENT` fabricated out of a truncation. `rulesetsComplete` carries the producer's
  assertion that the listing was exhausted, and an incomplete listing is `UNKNOWN` — the same
  discipline `searchIsComplete` already applies to the portfolio survey at
  `src/github-read-adapter.mjs:78`.
- **`adminPermission` does not decide the state.** It is evidence about *writing*; the capability
  question is about *reading* what exists. It gates remediation, not classification. A read-only
  identity that successfully lists zero rulesets has honestly established `ABSENT`.
- **Rule 2 puts `unknownRuleTypes` in `UNKNOWN`, not `AVAILABLE`.** A rule Gaia cannot model may be
  the very thing that governs merging. Absence of understanding is not evidence of absence of a
  constraint. It is also what makes the remediation refusal in the next section decidable rather
  than optimistic.
- **Rule 3 is `UNKNOWN`, not `ABSENT`.** A `404` on the rulesets *collection* means the repository
  was not found, not that it has no rulesets. `ABSENT` requires a successful read that returned
  nothing relevant — the same distinction between `0` and unknown this product enforces everywhere.
  Note the asymmetry with the protection endpoint: `protectionRead: NOT_FOUND` is the ordinary,
  expected answer for an unprotected branch and contributes nothing to `UNKNOWN`; it is only
  `rulesetsRead: NOT_FOUND` that is incoherent.
- **Branch protection never contributes a positive capability finding.** The REST branch-protection
  payload has no merge-queue field at all — merge queue is expressed only as a ruleset rule — so a
  `200` from that endpoint is *silent* on the capability, not evidence of absence. `protectionRead`
  enters the decision in exactly two ways: `FORBIDDEN` proves a permission problem, and
  `RATE_LIMITED`/`FAILED` prove the observation is incomplete. It can never make a capability
  `AVAILABLE` and it can never make one `ABSENT`. Deriving absence from an endpoint that cannot
  express presence is the same category of error as deriving it from a pull request.
- **Rule 5 refuses ambiguity by counting.** Two active rulesets each carrying a merge queue rule
  is not "more available"; it is a configuration whose effective behaviour Gaia cannot predict and
  whose remediation target is undecidable. `MISCONFIGURED` names that, and no write is prepared
  against it.
- **`STALE` is a consumer verdict, never a probe verdict.** The producer records what it saw and
  when. Whether that is still usable depends on when it is read, which the producer cannot know.
  Every state decays, including `ABSENT`: an operator may have created the ruleset in the
  intervening minutes, and reporting a stale `ABSENT` as fresh would send them to fix something
  already fixed.

`MERGE_QUEUE_CAPABILITY_FRESH_MS` is `300_000` and is its own constant. It is not borrowed from
`HEARTBEAT_FRESH_MS`, `LOCAL_LANE_OBSERVATION_FRESH_MS`, `ENGINEERING_FLOW_FRESH_MS` or
`THROUGHPUT_STALL_WINDOW_MS`, each of which answers a different question. Five minutes is the
interval over which a repository administrator can plausibly change a ruleset without Gaia
noticing, and it is deliberately shorter than any wait it authorises.

**When the age check cannot run at all** — a missing or unverifiable artifact — the answer is the
absence of the input, not a state. The consumer publishes nothing and selects no capability
obstruction, and the drain reports exactly the obstruction it reported before this feature existed.
Fabricating `UNKNOWN` out of a missing file would move every previously published snapshot revision
for evidence nobody produced, which the flow contract's C1 already forbids by name.

## Where it enters the drain

`classifyPortfolioDrainObstruction({ …, mergeQueueCapability = null })` takes the sealed artifact
as one more explicit optional input, in exactly the shape `dependencies` already has.

Two states join the closed obstruction vocabulary, taking it from nine to eleven:

- **`CAPABILITY_ABSENT`** — Gaia read the configuration successfully and it will not serve a merge.
  Covers `ABSENT` and `MISCONFIGURED`. Both are positive findings; they differ in what to do next,
  which is why the recovery action is parameterised by the capability state and the label names
  which one it is.
- **`CAPABILITY_UNVERIFIED`** — Gaia could not establish the capability. Covers
  `PERMISSION_DENIED`, `STALE` and `UNKNOWN`.

Two states rather than one, because "we looked and it is not there" and "we could not look" are
opposite readings, and collapsing them is the same defect as printing `0` for an unmeasured window.
Two rather than five, because the remaining distinctions change the *sentence*, not the *decision*:
in all five cases waiting is the wrong thing to do, and the exact next action is carried in the
recovery label.

### Relevance

A capability obstruction is selected only when at least one **live** item sits in a merge-dependent
drain state — `PUBLISHED` or `AWAITING_MERGE_AUTHORITY`. Those items are the `affectedItemIds`. A
repository with no merge queue and nothing waiting to merge is not obstructed by the missing queue,
and reporting it as such would make the obstruction a standing property of the repository rather
than a statement about the drain.

`AVAILABLE` selects nothing, and neither does a `null` capability.

### Precedence

The classifier's fixed precedence becomes:

```
RECONCILE_REQUIRED
LANE_STALE
CAPABILITY_ABSENT
CAPABILITY_UNVERIFIED
(any ACTIVE lane -> NONE)
DEPENDENCY_DEADLOCK
THROUGHPUT_STALL
NO_ELIGIBLE_WORK
AUTHORITY_STARVATION / REVIEW_STARVATION / EVIDENCE_STARVATION
```

Both new states sit **above the live-lane short-circuit**, and that placement is the fix. The
incident's drain had a live worker polling a queue that did not exist, and `moving` returned `NONE`.
Liveness proves a process is alive; it cannot prove a mechanism exists, and this repository has
written that rule down twice already in the opposite direction. A capability gap is precisely the
condition a busy process cannot resolve and will happily hide.

They sit **below** `RECONCILE_REQUIRED` and `LANE_STALE` because those are failures of the evidence
Gaia holds about its own work. A capability verdict computed against a projection Gaia does not
trust is not worth reporting first.

They sit **above** `AUTHORITY_STARVATION`, which is the exact misreading being fixed: a published
pull request under an absent merge queue is not waiting for a grant, and telling an operator to ask
for one sends them to a person who has nothing to give.

### Reaching the operator in every headline state

Correct classification is not enough on its own, because the obstruction sentence currently reaches
the headline only through the `PAUSED` branch (`src/control-room.mjs:1010`), and `headlineState`
reports `ACTIVE` whenever any portfolio lane *or any local wmux lane on the operator's own machine*
is live (`src/control-room.mjs:871`). Under the incident's conditions — a busy worker polling a
queue that did not exist — the headline would have read `Active` and the capability sentence would
never have been shown, even with the precedence fix above.

A capability obstruction therefore reaches the headline detail in **every** headline state, not
only in `PAUSED`. This is the second half of the same fix: liveness must not suppress it in the
classifier, and it must not suppress it in the headline either.

Two further totality obligations follow from adding to a closed vocabulary, and each is a real
defect if missed rather than a formality:

- `localizedObstructionLabel` (`src/control-room.mjs:1558`) is a bare object lookup with no
  fallback, so a state absent from the French phrasebook renders the literal string `undefined`.
- `OBSTRUCTION_SEVERITY` (`src/control-room.mjs:1590`) is likewise total-by-assumption, and a
  missing entry produces a CSS class named `undefined`.

Both tables, in both languages, gain both states, and one gate asserts every table is total over
`PORTFOLIO_DRAIN_OBSTRUCTION_STATES` rather than asserting the two new entries specifically.

### No forecast under a capability obstruction

`ETA` must not report `FORECAST` while a capability obstruction stands. An estimate of when
something will finish is a claim that it is progressing, and this is the exact wording criterion 2
forbids. The obstruction is the answer; a completion time alongside it would contradict it in the
reassuring direction.

### Recovery actions

Exactly one, bounded, advisory, `effect: NONE`, `authority: NONE`, as every existing recovery is.
Never queued, never pending, never an estimate.

| Capability state | `kind` | The one next action |
| --- | --- | --- |
| `ABSENT` | `CREATE_MERGE_QUEUE_RULE` | Create one active repository ruleset carrying a merge queue rule that targets the named default branch, then re-probe. |
| `MISCONFIGURED` | `CORRECT_MERGE_QUEUE_RULE` | Correct the named ruleset so exactly one active ruleset carries a merge queue rule for the named default branch, then re-probe. |
| `PERMISSION_DENIED` | `GRANT_CAPABILITY_READ` | Grant the reading identity permission to list this repository's rulesets, then re-probe. |
| `STALE` | `REPROBE_CAPABILITY` | Re-probe the capability: this reading is older than its freshness window. |
| `UNKNOWN` | `REPORT_UNREADABLE_CAPABILITY` | Report the named unreadable field or unmodelled rule type; this reading cannot be completed by waiting. |

Every label names the repository and the branch and nothing else. No URL, no command, no token, no
path, no account, no provider prose.

## Remediation — one intent, one effect, compare before write

R0 prepares remediation and refuses it by default. Performing it is the supervising operator's act,
and nothing in this writer run performs it.

### The intent

`planMergeQueueRemediation({ capability, observedAt, authority })` returns either one sealed
`gaia-merge-queue-remediation-intent/1` or one sealed refusal. It is pure and writes nothing.

The intent carries:

- `intentId` — the stable idempotency identity. `sha256` over the canonical JSON of
  `{ repositoryId, defaultBranch, capability: 'MERGE_QUEUE', desiredRuleDigest }` — and **nothing
  else**. It is a pure function of the *target and the desired end state*.

  This is worth stating negatively, because the two obvious alternatives both break it. The
  identity must not include the authority grant: the repository's existing publication path derives
  its idempotency key as `sha256({ grantId, intentRevision })`
  (`src/github-portfolio-publication.mjs:255`), which is per-*attempt* and correct there — but two
  concurrent remediators legitimately hold two different grants, so borrowing that recipe here
  yields two identities, two stamps, two read-before-writes that each find nothing, and two
  rulesets. It must also not include `expectedRulesetDigest`: that digest moves whenever *any*
  ruleset in the repository changes, so two remediators observing the same absent merge queue a
  second apart would again compute different identities. The precondition digest is a
  compare-and-swap token, not a name.

  Deterministic in this exact sense, two independent remediators compute the *same* identity, which
  is what makes the reconciliation below decidable across them.
- `expectedRulesetDigest` — the exact `observation.rulesetDigest` the plan was made against. This
  is the compare-and-swap token.
- `stamp` — `gaia-mq-<first 16 hex of intentId>`, the name the created ruleset must carry. It is
  computed **before** the write and written *as part of* the write payload. A mark applied after a
  successful response cannot survive a lost response, which is the entire failure this addresses.
- `additions` — the exact rules to add, as an additive diff. Never a replacement document.
- `preserved` — every existing ruleset id and every existing required check the plan promises not
  to touch, listed explicitly so the promise is reviewable and testable rather than implied.

### What refuses, before any write is possible

Each is a typed refusal carrying its own reason code, and none of them is retried:

1. `CAPABILITY_NOT_REMEDIABLE` — the state is not `ABSENT`. **`ABSENT` is the only remediable
   state**, and every other one — including `MISCONFIGURED` — produces no intent at all.
   `PERMISSION_DENIED`, `STALE` and `UNKNOWN` are the guard against the incident's twin:
   remediating a repository Gaia merely could not read. `MISCONFIGURED` is excluded for a different
   and equally firm reason: a merge queue rule that exists in `evaluate`, on the wrong branch, or in
   two competing active rulesets is configuration a human deliberately wrote, and every repair for
   it is a *modification* of an existing rule rather than an addition — which refusal 5 below
   refuses anyway. Accepting `MISCONFIGURED` here would mean writing a planner whose only possible
   outcome is a refusal, and inviting a later relaxation of refusal 5 to make it "work".
   Additive creation into a repository that has no merge queue rule at all is the one write this
   design is prepared to describe.
2. `UNKNOWN_RULE_PRESENT` — `unknownRuleTypes` is non-empty. Gaia cannot promise to preserve a rule
   it does not model, so it declines to promise.
3. `INSUFFICIENT_AUTHORITY` — `adminPermission` is not `PRESENT`, or the supplied authority grant
   does not cover this repository.
4. `AMBIGUOUS_CONFIGURATION` — more than one active ruleset targets the default branch, so the
   remediation target is undecidable.
5. `DESTRUCTIVE_REPLACEMENT` — the computed diff would remove or modify any existing rule, any
   existing required status check, any bypass actor or any existing ruleset. GitHub's ruleset and
   branch-protection writes are *replacements*, not merges: a `PUT` carrying a partial rules array
   silently deletes every rule it omits, and a required status check dropped this way removes a
   gate no one will notice is gone. The planner therefore computes the full resulting configuration
   and refuses unless the existing set is a strict subset of it.

### The effect, and the one place it may happen

`executeMergeQueueRemediation({ intent, readRulesets, applyRuleset })` performs **at most one**
call to `applyRuleset`, and only after a compare-and-swap:

1. Re-read the rulesets and recompute the digest.
2. If it differs from `expectedRulesetDigest`, refuse `PRECONDITION_CHANGED` and write nothing. The
   plan was made against a configuration that no longer exists, and a plan is not a licence.
3. If it matches, call `applyRuleset` exactly once with the stamped payload.

`applyRuleset` is an injected function parameter, and is a fake in every test. It is deliberately
**not** a new method on `createGitGhCandidatePublicationEffects`
(`src/git-gh-publication-effects.mjs:139`). That port is closed at exactly four methods —
`observe`, `commit`, `push`, `openPullRequest` — and
`tests/github-portfolio-publication.test.mjs:117` asserts its surface as a gate. Repository
administration is a different authority from candidate publication, and merging the two into one
port would make the gate that proves Gaia cannot merge weaker in order to make this feature
smaller. Passing the executor its own function keeps that boundary exactly where it is.

### Why Gaia cannot authorize this itself

`src/bus-core.mjs:44` lists `merge`, `admin`, `config-write`, `credential-read`, `deploy`,
`grant-authority` and `push` as `NEVER_GRANTABLE`. Creating a repository ruleset is repository
administration and configuration writing, and it is therefore not a capability the bus can grant to
anything, in any grant, ever. That is not an obstacle this design works around — it is the reason
the remediation is prepared and refused by default, and the reason performing it is an act of the
supervising operator outside the bus rather than a step Gaia can take. The `INSUFFICIENT_AUTHORITY`
refusal below is the in-module expression of a boundary the bus already enforces.

### Reconciliation after a timeout, a crash or a lost response

`reconcileMergeQueueRemediation({ intent, rulesets })` is a pure decision over a fresh read, and it
issues no write of its own. Because the stamp was written *into* the payload before the request
left, the read is decidable:

| What the read shows | Verdict | What happens |
| --- | --- | --- |
| Exactly one ruleset named `intent.stamp`, carrying the desired rule | `APPLIED` | Terminal. My effect landed. No write. |
| No ruleset named `intent.stamp`, but another active ruleset carries a merge queue rule for the branch | `SUPERSEDED` | Terminal. Someone else's effect landed and the capability is satisfied. No write, ever. |
| Neither | `NOT_APPLIED` | The single effect above may be attempted, once. |
| More than one ruleset named `intent.stamp` | `AMBIGUOUS` | Terminal refusal. A human decides. No write. |
| A ruleset named `intent.stamp` that does **not** carry the desired rule | `AMBIGUOUS` | Terminal refusal. No write. |

Two concurrent remediators derive the same `intentId` and therefore the same stamp, so the second
one's reconciliation reads the first one's ruleset and terminates at `APPLIED` without writing.
Terminal receipts are content-addressed over `{ intentId, verdict, observedRulesetDigest }`, so two
remediators reaching the same verdict over the same observation emit byte-identical receipts.

`NOT_APPLIED` is a verdict, not a retry policy. It permits the one effect the intent was created
for; it does not schedule, back off or repeat, and there is no loop anywhere in this module.

**Residual risk, stated rather than papered over.** GitHub's ruleset API is not transactional and
does not enforce unique ruleset names, so a true time-of-check-to-time-of-use window exists between
the compare-and-swap read and the write. Two remediators can, in principle, both pass the check and
both write. The design does not claim to close that window; it claims that the window is *detected*
— the next reconciliation reads two rulesets carrying the stamp and terminates at `AMBIGUOUS`
rather than silently proceeding — and that Gaia never issues a second write on its own in any
branch of the table above. This is recorded as a known limitation of the provider, not a defect of
the module.

## Telemetry and observability

Every accepted transition and every refusal is observable through the evidence the control room
already publishes and re-derives — no new log, no new store, no new verb.

- The capability block is published under `mergeQueueCapability` in the control-room snapshot, and
  **the key is omitted entirely when there is no artifact**, never published as `null`, for the
  same digest-stability reason the flow block gives.
- The block carries the state, the repository identity, the branch, the ruleset digest, the
  permission decision, `observedAt`, `observationAgeMs` and `freshnessWindowMs`, and the verified
  observation verbatim — so the render seam re-derives the state from the evidence it carries and
  refuses a resealed snapshot whose published state its own observation does not decide.
- The obstruction carries the capability state, the affected item ids, its own evidence revision
  and one bounded recovery, and is bound to the snapshot by the existing
  `evidenceRevision` / `observationWindow` check at `src/control-room.mjs:739`.
- Refusals are typed errors with stable codes, so a refused plan is as observable as an accepted
  one.
- **Nothing is appended to the drain ledger or the telemetry log.** Capability evidence does not
  enter `MACHINE_RULES` (`src/portfolio-drain.mjs:89`), so `PORTFOLIO_DRAIN_MACHINE.rulesRevision`
  is byte-identical before and after this work and no persisted receipt needs migrating. That is
  the rejected Seam 1 of `docs/portfolio-drain-obstruction-design.md` restated for this feature: a
  read-only measurement must not become an authority-bearing append. One gate pins the digest to a
  literal so the property cannot be lost silently.
- **One absent capability is one obstruction with one next action**, however many pull requests are
  waiting on it. The affected item ids are all of them; the recovery is one. A per-item blocker
  would turn one missing ruleset into twelve things to do.

Nothing published anywhere carries a credential, a token, an account identifier, a URL, a command
line, a filesystem path, a prompt, a chain of reasoning or provider prose. The rendered strings are
the closed labels in this document, in English and in French.

## Interfaces

`src/merge-queue-capability.mjs`:

- `MERGE_QUEUE_CAPABILITY_SCHEMA`, `MERGE_QUEUE_CAPABILITY_STATES`,
  `MERGE_QUEUE_CAPABILITY_FRESH_MS`
- `requireMergeQueueCapability(value)` — total verifier
- `sealMergeQueueCapability({ observedAt, repositoryId, repository, defaultBranch, observation })`
- `mergeQueueCapabilityRevision(body)` — the single digest recipe
- `decideMergeQueueCapability({ artifact, observedAt })` — the one derivation
- `planMergeQueueRemediation(...)`, `executeMergeQueueRemediation(...)`,
  `reconcileMergeQueueRemediation(...)`
- `MergeQueueCapabilityError`

`classifyPortfolioDrainObstruction({ …, mergeQueueCapability })` and
`buildControlRoomSnapshot({ …, mergeQueueCapability })` each take it as one explicit input.
`npm run factory:dashboard -- --merge-queue-capability <path>` is the only way it reaches the
publisher.

## Reversibility

**Class: freely reversible.** No listener, no persistent store, no migration, no bus export, no new
dependency, and no privileged effect performed. Removing the module, the flag, the two obstruction
states, the tests and this document removes the behaviour with no residue in any durable log and no
transformation of user data. Roll back if independent review finds that a capability state can be
published that its own carried observation does not decide, or that any pull-request status can
reach the decision.

## Falsifiers

The implementation is wrong if any of these can be made to happen:

1. A capability state is decided from `mergeable`, `mergeStateStatus`, `autoMergeRequest`, a check
   conclusion or a review decision — or any field outside the closed schema is accepted.
2. A `403` on either read produces anything other than `PERMISSION_DENIED`.
3. A `404` on the rulesets collection produces `ABSENT`.
4. An unmodelled rule type produces `AVAILABLE`.
5. Evidence older than the freshness window is read as anything but `STALE`.
6. A live `ACTIVE` lane suppresses a capability obstruction.
7. `ABSENT` is rendered, published or worded as queued, pending, in progress, or with an estimate.
8. A remediation plan is produced for `PERMISSION_DENIED`, `STALE` or `UNKNOWN`.
9. A remediation writes when the observed ruleset digest differs from the expected one.
10. A remediation removes or modifies any existing rule, required check, bypass actor or ruleset.
11. Reconciliation issues a write in any branch other than `NOT_APPLIED`, or two concurrent
    remediators produce two accepted effects for one intent identity.
12. A missing capability artifact changes any previously published snapshot revision.
13. A credential, token, URL, command, path, prompt or provider sentence reaches any rendered
    string.
14. English and French disagree about any state, label or recovery, or either is incomplete.

## Rejection criterion

Reject this work if reviewing it shows that an absent capability can still be read anywhere as slow
progress — in the state, in the obstruction, in the label, in the recovery, in the rendered words,
or by being suppressed by liveness, freshness, caching, a default value, an optional field or a
swallowed exception. That is the whole point. Every other property here is in service of it.

## Decision Receipt

- **Decision:** one sealed, content-addressed `gaia-merge-queue-capability/1` artifact, produced by
  one read-only probe over the existing injected `gh` seam, decided by one pure total function into
  one of six closed states, consumed as one explicit input by the existing obstruction classifier
  and the existing control-room builder, selecting one of two new obstruction states above the
  live-lane short-circuit; plus one pure, refused-by-default, compare-before-write remediation with
  a pre-stamped idempotency identity and an exact reconciliation.
- **Alternatives rejected:** inferring capability from pull-request mergeability (the defect that
  caused the incident, and unfixable by care); probing GitHub live inside the drain gate (destroys
  the classifier's purity, makes a GitHub outage a drain outage, and hides freshness instead of
  measuring it); a single merged capability obstruction state (collapses "not there" into "could
  not look"); five obstruction states, one per capability state (the extra distinctions change the
  sentence, not the decision).
- **Authority delta:** none. `effect: NONE`, `authority: NONE` on every published artifact, six bus
  verbs unchanged, no new dependency, no new command, no repository administered.
- **Reversibility:** freely reversible.
- **Falsifiers:** the fourteen listed above, each with at least one gate, and mechanism-revert
  mutations for the two mechanisms the incident turned on — the live-lane short-circuit and the
  `403`/`404` distinction.

## Gates

In `tests/merge-queue-capability.test.mjs`:

| Gate | What it holds |
| --- | --- |
| M1 | The closed schema round-trips, seals deterministically, and is deeply frozen. |
| M2 | Unknown top-level, observation and ruleset fields are refused — including `mergeable`, `mergeStateStatus` and `autoMergeRequest`. |
| M3 | Non-exact, future and incoherent instants are refused rather than clamped. |
| M4 | No ruleset and a `404` protection read decide `ABSENT`. |
| M5 | An unprotected branch with an active merge queue ruleset decides `AVAILABLE`. |
| M6 | `403` on either read decides `PERMISSION_DENIED`, and outranks the content. |
| M7 | `404` on the rulesets collection decides `UNKNOWN`, never `ABSENT`. |
| M8 | `evaluate`, `disabled`, wrong-branch and two-active carriers decide `MISCONFIGURED`. |
| M9 | An unmodelled rule type decides `UNKNOWN`, never `AVAILABLE`. |
| M9a | A rate-limit or single-sign-on `403` decides `UNKNOWN`, never `PERMISSION_DENIED` or `ABSENT`. |
| M9b | An incomplete or paginated rulesets listing decides `UNKNOWN`, never `ABSENT`. |
| M9c | `~ALL`, `~DEFAULT_BRANCH`, a literal ref and an `exclude` that subtracts the default branch each resolve correctly; `~ALL` excluding the default branch decides `ABSENT`. |
| M9d | A `200` branch-protection read contributes no positive finding, and cannot decide `AVAILABLE` or `ABSENT` on its own. |
| M9e | No pull-request field participates: holding the observation constant while varying every pull-request field leaves the decision byte-identical. |
| M10 | Evidence beyond the freshness window decides `STALE`, from every underlying state. |
| M11 | Deterministic replay: identical evidence produces byte-identical decisions and digests. |
| M12 | The digest recipe and the exact-instant rule each have exactly one implementation. |
| M13 | The planner refuses every state except `ABSENT` — including `MISCONFIGURED` — with `CAPABILITY_NOT_REMEDIABLE`. |
| M13a | Two different authority grants over the same target compute one identical `intentId` and one identical stamp. |
| M13b | Two observations of the same absent capability taken at different instants, with different `expectedRulesetDigest` values, compute one identical `intentId`. |
| M14 | The planner refuses an unknown rule type, insufficient authority and an ambiguous configuration. |
| M15 | The planner refuses any diff that drops an existing rule or required check. |
| M16 | The executor performs no write when the observed digest differs from the expected one. |
| M17 | The executor performs exactly one write when the digest matches. |
| M18 | Reconciliation over a lost response after success reads `APPLIED` and writes nothing. |
| M19 | Reconciliation over another remediator's ruleset reads `SUPERSEDED` and writes nothing. |
| M20 | Two concurrent remediators derive one identity and produce at most one effect and one terminal receipt. |
| M21 | Two stamped rulesets, and a stamped ruleset without the desired rule, read `AMBIGUOUS`. |
| M22 | Partial failure leaves no partial configuration and no second write. |

In `tests/control-room-merge-queue-capability.test.mjs`:

| Gate | What it holds |
| --- | --- |
| K1 | An absent artifact moves no published snapshot revision, and a present `null` is refused. |
| K2 | `ABSENT` with a published item selects `CAPABILITY_ABSENT` with one exact recovery. |
| K3 | An `ACTIVE` lane does not suppress a capability obstruction. |
| K4 | `AVAILABLE`, and a capability with nothing waiting to merge, select no capability obstruction. |
| K5 | `PERMISSION_DENIED`, `STALE` and `UNKNOWN` select `CAPABILITY_UNVERIFIED`. |
| K5a | A capability obstruction reaches the headline detail in every headline state, including `ACTIVE` driven only by a local lane. |
| K5b | Every label, recovery, severity and translation table is total over `PORTFOLIO_DRAIN_OBSTRUCTION_STATES`, in both languages. |
| K5c | No `FORECAST` eta is published while a capability obstruction stands. |
| K5d | Twelve waiting items under one absent capability produce one obstruction and one recovery. |
| K5e | `PORTFOLIO_DRAIN_MACHINE.rulesRevision` is byte-identical to its pinned literal. |
| K6 | No rendered string contains a credential, token, URL, command, path or provider prose. |
| K7 | No rendered string for `ABSENT` contains queued, pending, in progress or an estimate. |
| K8 | The render seam re-derives the state; a resealed capability state is refused. |
| K9 | The French document translates both new states and every recovery, and leaks no English. |
| K10 | The `--merge-queue-capability` flag plumbs through, and the CLI refuses an unreadable path. |
| K11 | Deterministic replay through the CLI. |
| MR1 | Mechanism revert: moving the capability check below the live-lane short-circuit is what would let a busy worker hide an absent queue. |
| MR2 | Mechanism revert: collapsing `403` into `404` is what would turn a permission failure into `ABSENT` and a doomed remediation. |

## What R0 does not claim

R0 does not claim to produce the artifact on a schedule; it defines and consumes the seam. It does
not claim to administer any repository — no ruleset is created by this work. It does not claim to
close GitHub's non-transactional write window, only to detect it and refuse. It does not claim that
`AVAILABLE` means a merge will succeed; it means the mechanism exists, which is exactly the fact
that was missing. It mirrors nothing into DuckDB.

Three limits are worth naming exactly, because each is a real thing an operator might expect and
not get:

- **There is no merge-queue wait loop in this repository to fix.** The waiter in the incident was an
  agent's own reasoning, not code. R0 cannot compel a reasoning loop to consult a fact; what it can
  do, and does, is make the fact exist, be decidable, be published, be bound to its evidence, and be
  rendered in every headline state rather than only in the one nobody was looking at. A capability
  module that is correct and unconsulted would change nothing, so the surfacing rules above are not
  presentation polish — they are the mechanism.
- **`AVAILABLE` does not license an unbounded wait.** A merge queue that exists can still stall. R0
  measures whether the mechanism exists; it declares no wall-time ceiling on waiting for a queue
  that does. That ceiling belongs to the bounded-execution vocabulary in
  `src/framing-execution-contract.mjs`, and wiring it is separate work.
- **The per-item lifecycle percentage is unchanged.** `AWAITING_MERGE_AUTHORITY` still renders as
  four of five gates complete (`src/control-room.mjs:55`), so an item blocked on an absent
  capability still shows a high per-item progress figure beside a correct obstruction. Repairing
  that means binding a repository-scoped fact to an item-scoped progress model, which is a larger
  change than this one and would be the wrong thing to attach to a tracer bullet. It is recorded
  here, and in the writer handoff, as a known residual rather than left to be discovered.
