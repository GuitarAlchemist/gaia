# gaia-interagent

A durable local coordination bus for Claude Code and Codex sessions.
Six non-privileged verbs over stdio MCP, an append-only JSONL event log, and adapters
for visible wmux lanes.

Windows-first. Zero dependencies. No network listener, no remote execution, no shell
transport, no privileged verb.

## Agentic microkernel

Gaia is an **agentic microkernel**, not a general-purpose operating system. Its small
trusted core defines content-addressed contracts, exact verifiers, immutable policy,
six non-privileged coordination verbs, explicit effect boundaries, and replayable
receipts. Providers, planners, storage engines, dashboards, IX/IXQL pipelines, and
other capabilities are replaceable adapters around that core.

The architectural rule is **two perspectives for decisions, one authority for
effects**. Framing and design may be challenged independently; claims may be verified
through separate Standards and Spec/adversarial axes. An actual mutation still has one
named owner, one bounded capability, one idempotency boundary, and one receipt. An
extension may narrow policy, but it cannot redefine the kernel's zero-effect authority
or hard safety ceilings.

Cross-module invariants live in `src/advisory-policy.mjs`. Framing-specific rules live
in `src/framing-execution-contract.mjs`; contradiction-specific rules remain in
`src/plan-contradiction-audit.mjs`; effect adapters retain their own concrete preflight
and remeasurement rules. This centralizes shared invariants without collapsing every
domain into a generic rules engine. Gaia does not claim OS process isolation, consensus,
hard-real-time scheduling, or safety-controller authority.

---

## Install status

**This is an installation candidate, not an installed plugin.** It has no marketplace
entry and has not been installed. Fresh, independent Standards and Spec/adversarial
reviews gate installation — the lane that wrote this cannot review it.

## Quick start

```bash
node scripts/gaia-interagent.mjs doctor
node scripts/gaia-interagent.mjs initialize --apply   # idempotent; safe to run again
node scripts/gaia-interagent.mjs status
node scripts/gaia-interagent.mjs verify
node --test                                   # 1611 gates
```

### Functional factory tracer

Run a complete, evidence-gated three-role coordination cycle around a real artifact:

```bash
npm run factory:smoke -- \
  --data-dir ./state/factory-smoke \
  --artifact ./README.md \
  --out ./state/factory-smoke-report.json \
  --task "Review this candidate"
```

The command uses only the six bus verbs and produces a persisted, independently
replayable coordination receipt. It registers coordinator, builder, and reviewer;
sends and acknowledges three correlated messages; records a zero-authority handoff;
and fails unless Gaia's evidence gate passes. It deliberately launches no model and
executes no repository code: it proves the factory control-plane path, not the quality
or provenance of an AI-produced change. Real wmux/Claude/Codex execution remains the
next adapter layer.

### Real subscription-backed agent tracer

After creating a clean linked Git worktree, run one real Claude implementation
worker followed by an independent Codex reviewer. If that review requests changes,
the same command permits one bounded Claude repair and one fresh Codex review:

```bash
npm run factory:agent -- \
  --worktree ../my-project-gaia-run \
  --task "Implement the bounded change and its focused tests" \
  --out ../state/gaia-agent-run.json \
  --timeout-ms 600000
```

Use `--reviewer pi` to replace only the Codex CLI reviewer with Pi over the existing
OpenAI Codex OAuth subscription. This profile first proves `authType: oauth`, rejects
API-key readiness, preloads only the digest-bound patch (maximum 1 MiB), disables
project-local configuration, sessions, extensions, skills, and implicit context, and
enables only Pi's `read`, `grep`, `find`, and `ls` tools for surrounding candidate-tree
context. The Claude worker and bounded repair remain unchanged.

Use `--worker pi` with one or more repeated `--allow-write` arguments to replace the
Claude worker with the experimental bounded Pi patch proposer:

```bash
npm run factory:agent -- \
  --worktree ../my-project-gaia-run \
  --task "Change only the two declared files" \
  --out ../state/gaia-pi-agent-run.json \
  --worker pi \
  --allow-write src/module.mjs \
  --allow-write tests/module.test.mjs
```

Pi remains read-only and receives no shell, edit, or write tool. It returns one typed
JSON patch proposal through the OpenAI Codex OAuth subscription. Gaia rejects unsafe
path syntax, non-text or rename patches, targets outside the exact allowlist, malformed
protocol output, direct worktree mutation, HEAD/index drift, and empty changes. Gaia
then asks Git to check and apply the patch and independently remeasures the result.
Automatic repair is disabled for this v0 profile: a rejected candidate requires a new
explicit run and allowlist. The profile never commits, pushes, publishes, or merges.

### Local hybrid semantic search

Build a content-addressed local index and query it in one command:

```bash
npm run search:hybrid -- \
  --corpus ./corpus.json \
  --query ./query.json \
  --index-out ./state/search/index.json \
  --out ./state/search/result.json
```

When documents and the query do not already carry embeddings, use IX's optional
local-only binary. Both paths are explicit and IX refuses an incomplete model cache:

```bash
npm run search:hybrid -- \
  --corpus ./corpus-without-vectors.json \
  --query ./query-without-vector.json \
  --ix-embed ../ix/target/release/ix-embed \
  --model-cache ../ix/.fastembed_cache \
  --index-out ./state/search/index.json \
  --out ./state/search/result.json
```

The zero-dependency engine combines BM25 and exact cosine ranking with RRF. Inputs carry
caller-supplied local embeddings plus URI/line/digest provenance claims. Gaia validates
their shape but does not independently read the source to prove those claims. Results are
`RETRIEVAL_MATCH` observations with `authority: NONE`, never facts or approvals. Stale-only
evidence returns `UNKNOWN` by default. See
[`docs/hybrid-semantic-search.md`](docs/hybrid-semantic-search.md).

### Advisory plan-contradiction audit

Audit one normalized, digest-bound plan declaration without mutating its source:

```bash
npm run plans:audit -- audit --input ./plan-claim.json
```

The pure seam distinguishes a reproducible structural contradiction from deferred work,
archived/parked declarations, review candidates, and missing evidence. A second `propose`
mode can materialize a bounded repair proposal with competing hypotheses, falsifiers,
controls, immutable evidence references, expiry, and explicit zero-cost limits. Both
outputs are content-addressed and retain `effect: NONE`, `sourceMutationAuthorized: false`,
and `executionAuthorized: false`. DuckDB or another registry may supply observations, but
it is an adapter rather than an authority; Gaia never edits a plan through this seam.

### Bounded execution framing

Materialize a complete request as an immutable, zero-effect contract before a planner
or agent sees it:

```bash
npm run requests:frame -- --input ./bounded-request.json
```

The pure seam records the intended consumer and observable outcome, explicit in/out
scope, assumptions, evidence gates, success criteria, anti-metrics, falsifiers,
rejection criteria, resource ceilings, and stop conditions. A complete request becomes
a deterministic `FRAMED` contract. Missing or contradictory framing becomes one ordered
`NEEDS_CLARIFICATION` result with no partial contract. Malformed input, mutable revision
aliases, caller-supplied authority, paid cost, fanout, execution, and source mutation
fail closed. The seam does not plan, schedule, invoke a model, query a database, or
authorize an effect.

An optional local OpenTelemetry Collector can receive redacted cycle and provider-phase
spans with `--otel-endpoint http://127.0.0.1:4318/v1/traces`. The endpoint is restricted
to HTTP loopback addresses: Gaia cannot use this option to contact a hosted or billable
telemetry backend. Telemetry carries no task, path, prompt, provider output, authority,
or secret and cannot change execution success or failure.

The v1 profile is deliberately closed: Claude is a host-user worker and, at most
once, repairer instructed to stay in the linked worktree; Codex is an ephemeral,
sandbox-requested read-only reviewer launched fresh for each review. All invocations
inherit only a minimal OS environment allowlist, excluding API
keys, cloud-routing overrides, and custom provider endpoints so their installed
subscription logins are used. Gaia refuses primary and submodule-primary
checkouts, dirty entry state, physical receipt/evidence aliases into the
candidate, final worker HEAD/index drift, changed paths crossing junctions or
symlinks, missing changes, unsupported changed
path types, malformed verdicts, reviewer mutations (including ignored files),
timeouts, excessive output, and any non-zero agent exit.

The receipt binds the base commit, status and binary-patch digests, every changed
file's size and SHA-256, content-addressed local evidence for every bounded agent
output, the requested/observed authority boundary, and both reviewer verdicts when
a repair occurs. The fresh final reviewer is authoritative. The CLI itself never
commits, pushes, merges, or installs. Claude still
runs with host-user authority: prompt policy and post-hoc Git/worktree checks do
not prove that it avoided network, writes elsewhere, or a transient Git action
whose final observable state was restored. A second `REQUEST_CHANGES` is retained
verbatim, starts no loop, and exits fail-closed with code `3`.

While a run is active, the CLI writes redacted human progress to `stderr`: validation,
execution start, worker start/completion, each review start/verdict, the optional repair
start/completion, and the terminal outcome. A liveness line refreshes a running provider
every 10 seconds. Each line includes readable elapsed time and the remaining
provider-time upper bound, followed by the explicit caveat `(not an ETA)`. That bound is
the caller timeout multiplied by the maximum provider invocations still possible; it
does not bound local Git or receipt work. Task text, paths, secrets, and provider output
never enter progress. `stdout` remains exactly the final JSON result. Automation may
request the same closed records as `gaia-cli-progress/1` JSON Lines with
`--progress-format jsonl`; the only accepted formats are `human` and `jsonl`.

### Read-only GitHub portfolio survey

Create a deterministic, content-addressed inventory and advisory schedule across every
repository visible to the authenticated `gh` CLI:

```bash
npm run portfolio:survey -- survey \
  --organization GuitarAlchemist \
  --policy-revision sha256:portfolio-policy-v1 \
  --out ../state/gaia-github-portfolio.json
```

The adapter performs only `gh repo list`, `gh search`, and read-only `gh api` calls. It
fails closed when a query reaches its result cap, retains unavailable relationship,
review, and check evidence as `UNKNOWN`, and never writes GitHub state. `advance` emits
one exact `AWAITING_AUTHORITY` intent; R1 has no create, update, publish, merge, or push
capability. See [`docs/github-portfolio-factory.md`](docs/github-portfolio-factory.md).

### Operating the portfolio factory

Reaching the factory's authorized path takes a human with a key. Mint one, once:

```bash
npm run portfolio:operator -- init \
  --private-key ../state/gaia-operator.key \
  --public-key  ../state/gaia-operator.pub
```

Then authorize exactly one run against a pinned portfolio revision:

```bash
npm run portfolio:operator -- run \
  --portfolio     ../state/gaia-github-portfolio.json \
  --repository    GuitarAlchemist/ga \
  --private-key   ../state/gaia-operator.key \
  --public-key    ../state/gaia-operator.pub \
  --ledger        ../state/gaia-operator-ledger \
  --worktree      ../candidate-worktree \
  --evidence-root ../state/gaia-operator-evidence \
  --out           ../state/gaia-operator-receipt.json \
  --timeout-ms    600000
```

`run` re-reads GitHub, materializes the one `AWAITING_AUTHORITY` intent, shows every
GitHub-derived field of it through one display control that strips terminal control and
bidirectional characters and bounds the line, and requires the operator to type that
intent's full revision. Only then does it read the encrypted key, mint a short-lived grant
in memory, spend it exactly once, and execute. Confirmation comes from the interactive
terminal. On Windows the passphrase comes from a masked dialog hosted by built-in Windows
PowerShell; on other platforms it comes from the hidden terminal reader. There is no
option, environment variable, or file that supplies either. A
session driving this process with a pipe cannot authorize anything. The grant is never
written down, the receipt path is claimed
before authority is spent, and every path that returns after that claim leaves a redacted
receipt there — including walking away from a prompt, which is a refusal that names
itself and exits `1`, never a silent success. What protects the private key on every
platform is its PKCS#8 passphrase; on Windows the file mode is not an access control and
placement is the operator's.
`run` uses the same redacted, heartbeat-backed stderr progress stream as
`factory:agent`; only this operator path emits `authorized_execution`, and only after
confirmation and grant consumption. Refusals and execution failures also end with a
terminal outcome. Progress writer and timer failures are ignored and cannot affect grant
consumption, execution, receipts, final stdout, or exit status.
See [`docs/github-portfolio-operator.md`](docs/github-portfolio-operator.md).

### Factory control room

Generate a self-contained, read-only dashboard directly from the pinned portfolio and
Gaia's append-only drain receipts:

```bash
npm run factory:dashboard -- \
  --portfolio     ../state/gaia-github-portfolio.json \
  --receipts      ../state/gaia-drain-receipts.json \
  --html-out      ../state/gaia-control-room.html \
  --snapshot-out  ../state/gaia-control-room.json \
  --watch-ms      5000
```

A **Current run** card comes first and answers the operator's first question on its own: run
state, the current stage or gate, elapsed work, the last verified transition with its digest, and
the next evidence checkpoint or blocker. Evidence freshness is a separate labelled fact beside
elapsed work, and says in words that a heartbeat proves the sensor is alive rather than that work
advanced. A pulse is rendered only for a fresh, explicit `gaia-cli-progress/1` heartbeat, and is
disabled entirely under `prefers-reduced-motion`. Stored `RUNNING` state without a fresh
heartbeat is shown as stale. Each bounded lifecycle exposes named gates and a percentage; the
open-ended portfolio itself deliberately has no fabricated completion percentage. Pace is stated
as a calibration — `n/5` comparable completed runs — and an unavailable ETA names the exact
missing evidence instead of a mood; a human forecast appears only when one is explicitly supplied,
labelled **Operator forecast**, and is never invented. Aggregate `BLOCKED_*` counts live in a
separately labelled **Portfolio backlog** section with their scope, as-of instant, total, count
and share, because they are properties of the queue and not blockers of the run in front of you.
The layout is phone-first: one readable column with the Current run card first and nothing that
scrolls sideways, reflowing at 768 px and opening into a bounded multi-column grid up to 1600 px
on a desktop. Status meaning always carries a word and a symbol, never colour alone. The HTML has
no remote assets and can be opened in wmux or shared as a standalone artifact. See
[`docs/factory-control-room.md`](docs/factory-control-room.md).

Each live task also carries at most three deterministic sentences — what it is doing, what it last
produced, and what would count as the next evidence — from
`summarizeControlRoomActivity({ snapshot })` in `src/control-room-activity.mjs`. That module is
pure, imports only `node:crypto`, and returns a separately content-addressed
`gaia-control-room-activity/1` value. A tick whose only new events are heartbeats changes **not
one sentence**: every bullet kind, code, parameter and text is byte-identical, which is what "do
not generate text on a ten-second heartbeat" was ever about. `contentRevision` also covers the
freshness lattice, which is clock-derived, so a tick that crosses the 30-second boundary moves
`contentRevision` while every sentence stays byte-identical. An earlier wording here claimed the
digest covered only the sentences and therefore never moved on a heartbeat; that was false in both
directions and is retracted. Every sentence comes from a closed phrasebook and every
interpolated value is a `TOKEN`, so chain-of-thought, prompts, logs, URLs and worker-authored
prose have nowhere to live. `--activity on --activity-out <path>` publishes the value beside the
snapshot on either dashboard command; the two flags are refused unless supplied together.

### Why the drain is not moving

`PAUSED` used to mean two opposite things at once. An **empty** drain, where every item is
terminal and the pause is the correct resting state, and a systemically **blocked** drain, where
real work exists and every path out of the queue is closed, produced the same sentence.

The control room now names the obstruction. Exactly one state is reported from a closed
vocabulary of nine — `NONE`, `NO_ELIGIBLE_WORK`, `EVIDENCE_STARVATION`, `LANE_STALE`,
`DEPENDENCY_DEADLOCK`, `REVIEW_STARVATION`, `AUTHORITY_STARVATION`, `RECONCILE_REQUIRED`,
`THROUGHPUT_STALL` — and every named obstruction binds the exact drain-projection revision it was
derived from, the observation window it was measured over, the affected item ids and their count,
and one bounded advisory recovery action carrying `effect: NONE` and `authority: NONE`.

```bash
npm run factory:dashboard -- \
  --portfolio     ../state/gaia-github-portfolio.json \
  --dependencies  ../state/gaia-declared-dependencies.json \
  --html-out      ../state/gaia-control-room.html \
  --snapshot-out  ../state/gaia-control-room.json
# Gaia dashboard checked: PAUSED | obstruction EVIDENCE_STARVATION | next TRIAGE_BLOCKED_EVIDENCE | source 9f2c…
```

`--dependencies` is optional and takes explicit declared evidence,
`{ "evidenceRevision": "<sha256>", "edges": [{ "itemId": "…", "dependsOnItemId": "…" }] }`. A
cycle is reported **only** from those declared edges. No issue title, body, label or model output
is ever read as a dependency, and an edge naming an item the portfolio does not carry is refused
rather than dropped.

It fails closed rather than cheerfully. An occupied lane with no liveness evidence is
`LANE_STALE`, because no heartbeat evidence is not evidence of a heartbeat. A drain state the
vocabulary does not recognise is an evidence gap, not health. A source state that merely *claims*
a dependency proves no cycle, so it stays an evidence gap. Only a live **lane** reports the drain
as draining: a terminal, blocked or queued item can legitimately carry a live run — a merged pull
request whose worker has not yet reported completion is ordinary — and none of them is motion out
of the queue. `THROUGHPUT_STALL` needs eligible work, free capacity and five minutes of unchanged
evidence before it is claimed; below that window the answer is `NONE`, meaning "no obstruction
detectable yet", never "healthy".

The observation window is the interval over which the publisher has continuously observed one
exact projection revision — a measured lower bound on the age of the evidence, so a stall can only
ever arrive late. `npm run factory:dashboard` measures it from the newest input file it reads;
`npm run factory:dashboard:refresh` writes its own portfolio on every tick, so it carries the
first-observation instant forward in the snapshot it published last time and starts a fresh window
on the exact tick the revision changes. That carried instant is evidence, so the carrier is
verified with the same total verifier the renderer applies to those exact bytes; a snapshot that
does not verify is no prior observation and the window restarts, which delays a stall rather than
inventing one. Evidence dated after the instant it was observed is a typed refusal rather than a
clamped zero-age reading, and because both commands build before they write, a refused tick leaves
the last complete artifact set untouched.

Where a publisher has no usable evidence for a window start at all, it says so: every snapshot
carries `sourceChangedAtBasis`, either `MEASURED` or `UNOBSERVED`, sealed into its content
address, and the page reads "Not yet measured" rather than an evidence age of `0s`. A window
nobody measured is no longer byte-indistinguishable from one measured as a single instant old.
The rendered obstruction is bound to the snapshot's own `sourceRevision`, `observedAt` and
`sourceChangedAt`, so an obstruction from another projection, or over a window with a forged start
or end, cannot be grafted into a resealed snapshot and displayed.

The obstruction is not an actuator. It starts nothing, retries nothing, unblocks nothing and
grants nothing. See [`docs/portfolio-drain-obstruction-design.md`](docs/portfolio-drain-obstruction-design.md)
for the seams that were rejected, the falsifiers and the rejection criterion.

### Local wmux lanes

The control room said `PAUSED` while four real Claude/wmux reviews were visibly running in panes on
this machine. It was truthful about its evidence and useless to the operator: every sensor it had
projected through GitHub portfolio items, and a local review lane bound to no issue and no pull
request was invisible to all of them.

The fix is a sensor, not a fabricated binding. A bounded read-only sensor reads structured
`wmux agent list` metadata — never a screen, a prompt, reasoning, stdout, a command line or source
code — and writes one closed `gaia-local-lane-observation/1` file. The control room takes that file
as an **explicit input**, exactly as it already takes telemetry and declared dependencies.

```bash
npm run lanes:sensor -- --out ../state/gaia-local-lanes.json

npm run lanes:watch --   --lanes-out     ../state/gaia-local-lanes.json   --portfolio     ../state/gaia-github-portfolio.json   --html-out      ../state/gaia-control-room.html   --snapshot-out  ../state/gaia-control-room.json   --interval-ms   5000
# Local wmux lanes observed: 7 | running 5 | workspaces 2 | observation 9c1f…
# Gaia dashboard checked: ACTIVE | obstruction NO_ELIGIBLE_WORK | local lanes 5/7 FRESH | next OBSERVE_LOCAL_LANE | source b2a0…
```

A fresh observation carrying at least one `RUNNING` lane makes the headline `ACTIVE` and shows a
real pulse, and the page calls that **process liveness** in words rather than progress. Lanes render
in their own section labelled `LOCAL_WMUX`, separate from portfolio work, and carry no repository,
issue, pull request, completion percentage, pace or ETA — a lane genuinely has none, and inventing
one to make it fit the portfolio shape would trade a silent falsehood for a louder one. Exited lanes
are shown and never make the headline active. A stale, missing or corrupt observation animates
nothing: stale is an explicit labelled state with its measured age, missing means the section is
absent, and corrupt or future-dated is a typed refusal that leaves the last artifacts intact.

Every displayable field is bounded by construction. Identities admit no whitespace, quote, angle
bracket or newline; the label is a positive Unicode allowlist that refuses every `\p{C}` code point,
so a bidi override or a zero-width space cannot forge a duplicate of another lane's name. A label
the allowlist refuses is **withheld** under its own `labelState` rather than sanitised or dropped,
and the lane is still reported. The sensor's own window is `LOCAL_LANE_OBSERVATION_FRESH_MS`, named
for what it measures — how recently the *sensor* ran — and never borrowed from the heartbeat
constant, which measures something else. The watcher interval is capped at half of it, so no legal
configuration can render a running lane permanently stale.

`requireControlRoomSnapshot` re-derives the whole block — every count, the pulse, the freshness
state, every lane's liveness and the headline itself — so a resealed snapshot cannot claim a pulse
its own evidence refuses. A snapshot with no observation omits the field entirely rather than
publishing `null`, which is proved byte-for-byte against the entry commit: adding a sensor moves no
previously published revision. See
[`docs/local-wmux-lanes.md`](docs/local-wmux-lanes.md).

### Engineering flow throughput

The control room could say *something is alive* and *nothing tracked is claimed*, and could not say
whether the engineering queue moved. Six running panes and `Moving = 0` are both true; neither is
throughput. A heartbeat, a token, a byte of stdout, a spinner or a live process proves a sensor or
a process is alive and proves nothing at all about the queue.

The evidence is one sealed, content-addressed `gaia-engineering-flow/1` artifact of discrete
events — issues opened, reopened and closed; pull requests opened, reopened, merged and closed
without merge; commits produced on a work branch and integrated into the default branch; factory
runs completed and failed; evidence reviews approved and refused — consumed through one explicit
flag, exactly as telemetry, declared dependencies and local lanes already are.

```bash
npm run factory:dashboard --   --projection ../state/gaia-drain-projection.json   --engineering-flow ../state/gaia-engineering-flow.json   --html-out ../state/gaia-control-room.html   --snapshot-out ../state/gaia-control-room.json
# Gaia dashboard checked: PAUSED | obstruction NONE | next NONE | source b2a0…
```

The page renders a family x window matrix: five families, each over the last hour, 24 hours and 7
days, with exact counts, per-outcome breakdowns, rates, inflow/outflow/net queue change where an
inflow event actually exists, and a cycle-time median only where at least five closing events all
carry a comparable start.

The rule the whole section exists for is that **`0` and `UNKNOWN` are opposite readings**. A
complete window with nothing in it reads `0 observed in a complete window`; a window the evidence
does not cover reads `UNKNOWN` with the reason named, and carries `null` everywhere a count would
go. They differ in word, in symbol and in `data-state`, in English and in French, so no operator,
screen reader or test can conflate them. A dashboard that printed `0` for both would be
confidently wrong in the reassuring direction.

Nothing here can be moved by a running process. The vocabulary has no name for a heartbeat, a
token, a byte count, a spinner or a process id, and an unknown family is refused — an activity
signal is not weighted low, it is unsayable. Two snapshots differing only in their flow artifact
carry a byte-identical headline, spinner decision, next action and obstruction. Nothing in the
section animates: a count over a closed window is a standing fact, not something happening now.

Lifecycle facts are never inferred. There are exactly nine per-event fields and an unknown one is
refused, so there is no `updatedAt`-shaped field to derive a creation or a closure from. Duplicate
identities, non-exact or future instants, unsupported kinds, contradictory terminal outcomes,
tampered revisions and a source snapshot whose sequence went backwards all fail closed.
`requireControlRoomSnapshot` re-derives the entire block from the events it carries, so a resealed
snapshot cannot display a count its own evidence does not derive — including the quiet forgery of
an unobserved window resealed as a measured zero. Without the flag the feature is absent and the
document is byte-identical to one produced before it existed. See
[`docs/engineering-flow-throughput.md`](docs/engineering-flow-throughput.md).

### Passive factory telemetry spine

The control room truthfully reported `PAUSED` while real work was happening, because the
only run evidence it had was best-effort CLI progress. The telemetry spine is the missing
sensor, not more orchestration.

A sensor records one of exactly seven bounded facts - `run.started`, `run.heartbeat`,
`gate.entered`, `gate.passed`, `gate.failed`, `run.blocked`, `run.completed` - into one
append-only, content-addressed JSONL log under a single-writer lock. Every field is a typed
identity or a canonical token, so a prompt, a reasoning trace, a credential, a screen
capture, a source fragment or an arbitrary log line has nowhere to live; where evidence is
absent the record says `UNKNOWN`. Replay is a pure function of the event set: duplicate
delivery is idempotent, and gaps, reordering, identity substitution, impossible transitions,
unknown future event types, invalid or future timestamps and corrupted history all fail
closed with typed diagnostics.

Run one real local transition end to end:

```bash
npm run factory:telemetry -- \
  --portfolio      ../state/gaia-portfolio.json \
  --ledger-dir     ../state/gaia-drain \
  --telemetry-dir  ../state/gaia-telemetry \
  --item           issue-27 \
  --event          CLAIMED \
  --lane           LANE_A \
  --agent          CLAUDE_WORKER \
  --out            ../state/gaia-telemetry-step.json
```

That step records a whole run inside one process, so the report it writes is a unit
demonstration of the freshness rule at three explicit instants over a recorded prefix, not
three observations of the durable log. It is a settled run by the time any dashboard can
read it.

To watch a run actually move and expire, record its phases one at a time. Each call returns,
so the run stays open on disk between them:

```bash
npm run factory:telemetry:phase -- --telemetry-dir ../state/gaia-telemetry \
  --run-id run-27-alpha --phase start \
  --repository GuitarAlchemist/gaia --item issue-27 --item-number 27 \
  --lane WMUX_LANE_A --agent CLAUDE_CODE
npm run factory:telemetry:phase -- --telemetry-dir ../state/gaia-telemetry \
  --run-id run-27-alpha --phase heartbeat
npm run factory:telemetry:phase -- --telemetry-dir ../state/gaia-telemetry \
  --run-id run-27-alpha --phase gate-entered --gate CLAIMED
```

`scripts/factory-dashboard.mjs --telemetry <dir>` now renders `ACTIVE` with a pulse and the
truthful current gate. Wait past the 30 s freshness window without another `heartbeat` and
the same log renders `STALE` with the named blockage `TELEMETRY_HEARTBEAT_EXPIRED`, its
evidence age, and `CHECK_STALE_RUN` as the next action. `--phase gate-passed --gate CLAIMED`
then `--phase finish` closes it, and it settles to `PAUSED` for good. A fact recorded after
the rendered instant is refused rather than shown.

The seven phases - `start`, `heartbeat`, `gate-entered`, `gate-passed`, `gate-failed`,
`finish`, `block` - are exactly the seven event kinds under operator-facing names; the seam
adds no event, field or schema. `observeWmuxClaudeTask` is a thin wrapper over that same
seam for one bounded wmux/Claude task: it launches nothing, reads no screen or prompt, and
takes one closed outcome from the task itself. See
[`docs/factory-telemetry-spine.md`](docs/factory-telemetry-spine.md).

### Candidate publication

`buildGitHubCandidatePublishIntent({ transition, gitObservation })` accepts only an exact,
content-addressed `CANDIDATE_READY` transition, revalidates its nested intent, receipt,
factory change-set identity, final APPROVE, idempotency, repository, Git HEAD/base and
reviewed candidate bindings, and returns a frozen
`gaia-github-candidate-publish-intent/1`. The Git observation is inert caller-supplied
data, not a callback and not independent evidence. The result is advisory data with
`effect: NONE`.

`createGitHubCandidatePublicationAdapter` is the separate effect boundary. It consumes
one signed, single-use `PUBLISH_CANDIDATE` grant, remeasures the candidate before every
authority decision, while the concrete adapter repeats the relevant identity check at
each mutation boundary. It permits only commit, explicit leased push, and pull-request creation. It
has no merge or direct issue-mutation capability. An issue-linked pull request may carry
`Closes #N`, which GitHub acts on only after a separate authorized merge. The concrete Git/`gh` adapter reuses an exact
existing remote branch or pull request and refuses conflicting state. Crash recovery
after a local commit remains deliberately fail-closed and is not yet unattended-safe.
See
[`docs/github-portfolio-publish.md`](docs/github-portfolio-publish.md).
The authorized boundary is specified in
[`docs/github-portfolio-publication.md`](docs/github-portfolio-publication.md).

Structural mutations are dry-run by default. `--apply` performs them.

## The tool surface — exactly six verbs

`register` · `send` · `inbox` · `ack` · `heartbeat` · `handoff`

There is no seventh. Nothing on this surface can approve, merge, push, commit,
deploy, read credentials, or mutate configuration. Privilege escalation is prevented
by **absence**, not by a check that could be bypassed.

## Architecture

The authoritative system-wide boundary map is [`ARCHITECTURE.md`](ARCHITECTURE.md).
This README carries the operational inventory; bounded design documents remain
authoritative for their named contracts.

```
   Claude Code ──┐
                 │   stdio JSON-RPC 2.0          ┌────────────────┐
   Codex ────────┼──► src/mcp-server.mjs ─commit─► src/bus-core.mjs │  pure reducer
                 │   (six tools, no auth verbs)  └───────┬────────┘  no I/O, no clock
   wmux lanes ───┘                                       │
                                              events     ▼
                                          ┌──────────────────────────┐
                                          │ events.jsonl             │  append-only
                                          │ (replay ⇒ full restart)  │  one global lock
                                          └──────────────────────────┘
```

| Path | Role |
| --- | --- |
| `src/bus-core.mjs` | Pure state machine. `decide` → events, `apply` → state, `replay` → restart. No I/O, no clock, no randomness, no `process.env`. |
| `src/event-log.mjs` | The only I/O. Lock-directory commit protocol, validating reads, fsynced atomic appends. |
| `src/mcp-server.mjs` | stdio JSON-RPC server. Injects the clock at the edge so the core stays pure. |
| `src/mcp-client.mjs` | Minimal MCP client + standalone handshake gate. One handshake, one transport. |
| `src/epistemic-research.mjs` | Pure, content-addressed advisory research-proposal builder; it executes nothing and changes no bus verb. |
| `src/context-capsule.mjs` | Experimental exact-pin, read-only fact projection with deterministic receipts; no bus, model, search, or persistence. |
| `src/lanes.mjs` | The live-lane policy and its evidence. |
| `src/ecosystem.mjs` | GA/Hari/TARS/IX verdicts, enforced in code; the Codex startup-timeout margin. |
| `src/templates.mjs` | Placeholder-only client-config templates and the protected-path refusals. |
| `src/verify.mjs` | Read-only acceptance checks, including the evidence negative controls. |
| `src/inventory.mjs` | The `inventory-digest/1` tree fixed point: walk, manifest, digest. Reads only. |
| `src/lineage-receipt.mjs` | `gaia-lineage-receipt/1`: one open receipt returned, one sealed cross-revision manifest handed to a caller-supplied sink and never returned. Reads only. |
| `src/reporting-context.mjs` | Structural two-channel finalizer for official inventory-routed reports; sealed details cross one captured write capability and only canonical commitments return. |
| `src/cli-progress.mjs` | Best-effort redacted human/JSONL progress, bounded liveness heartbeats, and caller-timeout-derived provider-time bounds for the two execution CLIs; never an authority or result dependency. |
| `src/factory-tracing.mjs` | Optional loopback-only OTLP/HTTP cycle and provider-phase spans with fixed zero-cost/no-authority attributes; telemetry failure never affects execution. |
| `src/factory-agent.mjs` | Deep module for clean linked-worktree admission, exact candidate identity, bounded subscription-agent invocation, sensitive output evidence, and reviewer non-mutation checks. |
| `src/hybrid-search.mjs` | Deterministic BM25 + exact-cosine + RRF retrieval over provenance-bound local embeddings; returns cited matches or honest `UNKNOWN`, never authority. |
| `src/ix-local-embedding.mjs` | Capability-free adapter for IX's cached local embedder; strips provider API keys and verifies model, revision, text hashes, dimensions, and vectors before returning them. |
| `src/github-portfolio.mjs` | Deterministic portfolio revision, conservative classification, bounded scheduling, and one-step authority intent. |
| `src/github-portfolio-authority.mjs` | Exact Ed25519 grant verification plus an atomic, one-use file ledger; prompts and bus text confer no authority. |
| `src/remote-operator-authority-prototype.mjs` | Authority-free tracer bullet for the remote exact-intent Seam; proves remeasurement, expiry, executor binding and one-use consumption while explicitly authorizing no execution. |
| `src/github-portfolio-execution.mjs` | Binds one authorized portfolio intent to one local factory-agent run, linked worktree, and external evidence directory; proves the worktree's measured Git identity is the bound repository before it can be constructed. |
| `src/github-portfolio-operator.mjs` | The operator seam: mints the dedicated encrypted Ed25519 keypair, performs one confirmed, short-lived, in-memory-only authorized advance that always leaves a redacted receipt, and owns the total terminal readers and the exit mapping. |
| `src/github-portfolio-publish.mjs` | Pure dry-run projection from one exact `CANDIDATE_READY` transition plus inert caller-observed Git data to a closed, deterministic advisory publication intent with `effect: NONE`; it accepts no callback or effect capability. |
| `src/github-portfolio-publication.mjs` | Authorized publication controller: consumes one exact publish grant and sequences only observe, commit, leased push, and pull-request creation; typed redaction and no merge capability. |
| `src/portfolio-drain.mjs` | Pure portfolio drain state machine: reconciles exact GitHub observations with content-addressed receipts and restrictive policy holds, then proposes bounded authority-free pump decisions. |
| `src/portfolio-drain-ledger.mjs` | Append-only, CAS-protected receipt ledger and read-only idempotent drain `tick`; binds an exact machine/rules version and performs no worker or GitHub effect. |
| `src/control-room.mjs` | Pure, content-addressed operator read model plus dependency-free HTML renderer; fresh real heartbeats are the only animated signal, and open-ended progress or ETA remains explicitly unknown. |
| `src/git-gh-publication-effects.mjs` | Concrete local Git and `gh` publication effects with repeated identity checks, explicit remote-branch leases, and exact pull-request reuse. |
| `src/github-read-adapter.mjs` | Read-only `gh` ingestion adapter with fail-closed query-cap detection. |
| `src/draft-operation-envelope.mjs` | Canonical Draft operation module: sealed identity, memory reconciliation, and durable Git Data `WORK_ROOT -> ENQUEUED` bootstrap hidden behind one enqueue interface. |
| `src/hosted-draft-collector.mjs` | Closed GitHub observation boundary that derives one canonical Draft Operation Envelope from repository, issue, readiness, branch, permission, and policy facts. |
| `src/factory-telemetry-phase.mjs` | The generic file-backed phase sensor: accepts one closed lifecycle fact and returns, so a run stays open on disk and a separately invoked reader observes it moving, expiring and settling. Binds the subject once, at start. |
| `src/wmux-claude-telemetry-bridge.mjs` | Thin wrapper binding one bounded, caller-supplied wmux/Claude task to the phase seam. Launches nothing, reads no screen or prompt, accepts one closed outcome, and re-throws infrastructure failures rather than recording them as blocked runs. |
| `scripts/gaia-interagent.mjs` | **The supported control script.** Lifecycle + messaging. |
| `scripts/factory-smoke.mjs` | One-command, evidence-gated coordinator → builder → reviewer tracer around a caller-supplied artifact. Executes no code or model. |
| `scripts/factory-agent.mjs` | Real Claude worker → Codex read-only review → optional one Claude repair → fresh Codex review tracer. Produces a fail-closed, content-addressed run receipt; never commits or publishes. |
| `scripts/factory-dashboard.mjs` | One-command portfolio/drain projection → control-room snapshot + standalone HTML adapter, with optional bounded polling and no listener or authority. |
| `src/engineering-flow.mjs` | The closed `gaia-engineering-flow/1` schema, its total verifier, the single digest recipe and the one derivation to the published throughput block. Pure; holds no clock; imports `node:crypto` and the shared exact-instant predicate. |
| `src/local-lane-observation.mjs` | The closed `gaia-local-lane-observation/1` schema and its total verifier: bounded identities, a positive Unicode label allowlist, a three-value lifecycle and a three-value label state. Pure; imports `node:crypto` only. |
| `src/local-lane-sensor.mjs` | Structured wmux agent metadata → one sealed observation, as a pure function that reads six named fields and can reach no seventh. |
| `src/path-identity.mjs` | One definition of "is this output the same file as an input?", decided on filesystem identity rather than on path spelling. |
| `scripts/local-lane-sensor.mjs` | The sensor's process boundary: one `wmux agent list`, no shell, no workspace filter, no mutating verb, one observation file. |
| `scripts/local-lanes-watch.mjs` | One command that refreshes the observation and the control room on a bounded, stoppable, non-overlapping interval. Holds no mechanism of its own. |
| `scripts/factory-telemetry-step.mjs` | One real, bounded, instrumented portfolio-drain transition: reads the ledger, records the closed telemetry arc, attempts exactly one compare-and-swap receipt, and publishes the three control-room views. No provider, no worker, no authority. |
| `scripts/factory-telemetry-phase.mjs` | Records exactly one lifecycle phase of one run, then exits. The operator-facing half of the phase sensor; refuses to rebind a run's subject or to overwrite a durable evidence log. |
| `scripts/hybrid-search.mjs` | One-command local corpus → content-addressed hybrid index → cited result tracer; reserves new outputs and never contacts a provider. |
| `scripts/github-portfolio.mjs` | One-command read-only organization survey; writes only a caller-named new local report. |
| `scripts/github-portfolio-operator.mjs` | Two operator verbs, `init` and `run`. Parses a closed argument list, proves stdin is a terminal, names which streams the terminal is, and composes the existing adapters. Decides nothing about authority. |
| `scripts/bus-cli.mjs` | The low-level six-verb CLI the control script wraps. |
| `scripts/generate-config.mjs` | Codex / Claude Code config generation into a directory you name. |
| `scripts/wmux-lanes.mjs` | Lane adapter over `peer-sessions-wmux`. Adapts; never reimplements. |
| `scripts/tars-mount.mjs` | TARS runtime MCP mount. Zero TARS repo changes. |
| `scripts/ga-watch.mjs` | Read-only GA JSONL tailer → bus `send` with `requestedAuthority: ["report"]`. |
| `scripts/inventory-digest.mjs` | Prints this tree's reproducible fixed point. Writes nothing inside the tree. |
| `scripts/lineage-receipt.mjs` | Emits a lineage receipt, registers an exposure, checks a receipt's freshness. Exit `0`/`2`/`3`. |
| `tests/` | 1611 `node:test` gates, counted as top-level `test()` declarations. `node --test`; data-driven cases run inside a declaration, so the runner reports more executed cases than there are declarations. |

Engineering and research work is governed by
[`docs/engineering-and-research-principles.md`](docs/engineering-and-research-principles.md).
In particular, load-bearing interfaces and seams use **Design It Twice** before
implementation, while experiments require falsifiable hypotheses, controls,
immutable provenance, quantified uncertainty, and independent replay. This is a
process constraint, not runtime authority and not evidence of integration.

Coordination observability follows a discrete-first mechanics model described in
[`docs/discrete-coordination-mechanics.md`](docs/discrete-coordination-mechanics.md):
typed balance, queue, graph-gradient, stability, and fatigue observables are valid
research candidates, while continuum stress tensors, torseurs, mixed-unit stress
scalars, and mechanics-derived automatic routing remain deferred or rejected.

A possible OpenXR **spatial terminal** for WorkGraph exploration is preserved as a
deferred, falsifiable design exploration in
[`docs/spatial-terminal.md`](docs/spatial-terminal.md). It is not an implemented or
authorised integration.

Reporting rules for a lineage declared **sealed** — what an open document may and may
not say about a revision pair — are stated as doctrine in
[`docs/holdout-safe-reporting.md`](docs/holdout-safe-reporting.md). It is doctrine, not
enforcement: no shipped check reads prose. The machine-checkable part of it is
`src/lineage-receipt.mjs`, described under "Lineage receipt" below.

## The authority boundary

- Message bodies are stored and delivered as **`untrusted-text`**. Inbound text grants
  no approval, push, merge, configuration, credential, or scope authority.
- Per-message authority is metadata from a fixed allowlist (`read`, `observe`,
  `suggest`, `draft`, `report`). Everything else is denied, named in the response, and
  recorded as an `authority.denied` event.
- `busAuthority` is a frozen constant, identical for every actor, assigned at
  registration. No message can change it — including the sender's own.
- `handoff` transfers work. `authorityTransferred` is always `[]`.
- A `requestedAuthority` that is not an array of strings is **refused**, not coerced:
  coercing `"approve"` to `[]` would write an audit record saying nothing privileged
  was asked for, when something was.

## Semantics you must not misread

- **Delivery ≠ completion.** `send` returns
  `accepted-for-delivery; not read, not agreed, not completed`.
  `ack` returns `receipt only; not agreement, approval, or completion`.
- **Stable refs, duplicate names.** Registration mints `act-NNNN`. Two sessions may
  share a display name; addressing it is **refused as ambiguous with both refs
  listed**, never silently misrouted.
- **Explicit return address.** Every message carries `replyTo`, defaulting to the
  sender.
- **Stale, not deleted.** Unseen for 30s is `stale` — still registered, still
  addressable. Partial reachability is normal.
- **Fail closed.** A lock timeout or a damaged record makes a call write nothing and
  report `failClosed: true`; the CLIs exit **3**, never 1. `1` is reserved for "the
  bus answered and said no". That distinction is the difference between *retry with a
  better address* and *stop and fetch a human*.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | the answer was no — either the bus refused a call (ambiguous address, wrong recipient, unknown ref) or a read-only lifecycle command returned an unhealthy verdict (see `doctor` below) |
| 2 | usage error |
| 3 | fail-closed I/O — lock timeout or corrupt log. **Nothing was written.** No retry helps. |

### `doctor` exits 1 on an unhealthy data directory

`doctor` writes nothing and repairs nothing; its exit code is its verdict. It exits **1**,
not 0, when the directory replays but is not internally sound:

- the log carries an **address this bus never minted** (`integrityFindings`), or
- the **correlation issuer has less than one claim window of runway left** —
  `correlationHeadroom` at or below 1,000,000 of `Number.MAX_SAFE_INTEGER`. That is the
  fingerprint of a log a pre-fix build poisoned; auto-issue is dead or one accepted claim
  from it. Non-numeric thread names (`cor-review-lane`) still work, but restoring
  auto-issue needs a **new data directory** — the log is append-only and nothing repairs it.

Health here is measured on the issuer's remaining runway, which is the same quantity
admission bounds, so a directory built only from calls the bus answered `ok:true` is never
condemned for containing them. A corrupt or unreplayable log is a different verdict: **3**.

### `verify` exits 1 on every condition `doctor` does, and on the authority invariants too

`verify`'s evidence checks fall into exactly two classes, and membership is decided by
one question: **is this check legitimately false on a correct, empty workspace?**

**Authority and integrity — these gate on every run.** None of them is a question a
correct empty workspace answers badly; each is vacuously or genuinely true on a fresh
bus, and a log that fails one carries a defect every time it is read.

| Check | What a failure means |
| --- | --- |
| `replayable` | the records do not fold into a state at all |
| `deterministic replay` | replaying the same events twice gives two different states |
| `no handoff transferred authority` | a handoff moved authority; `authorityTransferred` must be `[]` |
| `no message was granted a privileged authority` | a grant left the allowlist |
| `every body is labelled untrusted-text` | a body lost the label that makes it data rather than instructions |
| `every address in the log belongs to an actor this bus minted` | the log carries a forged address (also a `doctor` condition) |
| `every correlation id is inside the issuer range` | an id the issuer could never have emitted |
| `the correlation issuer still has room to mint` | auto-issue is dead or one claim from it (also a `doctor` condition) |
| `every actor.registered carries the frozen busAuthority` | a registration claims an authority the frozen constant does not contain |

**Evidence richness — advisory by default.** *Is this log a genuine multi-party
exchange?* A fresh workspace legitimately is not one, so these are reported without
gating: `at least three actors`, `more than one actor kind`, `a correlated thread of
three or more messages`, `at least one acknowledgement`, `at least one handoff`. Claim
that a log *is* evidence with `--evidence <path>` or `--require-evidence` and all five
gate as well. `evidenceOk` and `evidenceGatesResult` in the payload say which regime the
run was in. Advisory means reported, never hidden — a fresh workspace still prints its
five red checks and still exits **0**.

The negative controls always gate, in both regimes: a verifier that cannot fail proves
nothing.

**The relationship to `doctor`.** `verify` exits **1** with `ok: false` on both
conditions listed for `doctor` above, and agrees with it there. It also gates on the
seven other rows in the table, which `doctor` **does not** inspect at all — `doctor`'s
verdict covers identity and correlation health only. So a log whose handoff transferred
`approve` makes `verify` exit 1 and leaves `doctor` at 0. The two commands never
disagree about a directory; `verify` simply asks more of it. Both previously exited 0 on
such a log while `verify` displayed its own red check saying otherwise, and a reader
keying on the exit code or on `ok` read that as a pass.

## Inventory digest — binding this tree to a number anyone can recompute

Reviews of this product bind their subject with a tree digest. Until now nothing shipped
produced one, so each reviewing lane stated a private recipe and hoped the next lane
guessed the same one, and the older `inventory-digest-1` label attached to an earlier
snapshot is not derivable from any tree here. A fixed point nobody else can recompute is
a claim, not evidence.

```
node scripts/inventory-digest.mjs                      # this tree
node scripts/inventory-digest.mjs --root <dir> --json  # any tree, as JSON
```

```
format=inventory-digest/1
root=<the absolute path measured>
count=<files hashed>
bytes=<total bytes hashed>
digest=ordinal-path-bytes-sha256/1 <64 hex chars>
```

`inventory-digest/1` is the output contract; `ordinal-path-bytes-sha256/1` is the hash
recipe it emits. **The digest is never printed without the recipe beside it**, because a
bare hex string is exactly what gets copied into a review and later cannot be reproduced.

### The recipe, exactly

1. Walk every **regular file** under the root, skipping any directory named `.git` or
   `node_modules` at any depth. Nothing else is skipped — dotfiles and hidden
   directories are ordinary files and are included. Empty directories contribute
   nothing, so two trees differing only in one share a digest.
2. Per file: the path **relative to the root** with every separator rewritten to `/`,
   its exact **byte count**, and the **SHA-256 of its exact bytes** as lowercase hex.
3. One line per file: `relative/path|byte-count|file-sha256`.
4. Sort by path, **ordinal** — by UTF-16 code unit. Never `localeCompare`, never
   case-folded. `B.txt` < `Z.txt` < `_.txt` < `a.txt`.
5. Join with LF. **No trailing LF.**
6. The digest is the SHA-256 of the UTF-8 encoding of that document, lowercase hex.

### Why it reproduces elsewhere, and where it will not

- **Raw bytes, never decoded text.** A CRLF checkout and an LF checkout of the same
  sources are different trees and get different fixed points. This repository pins
  `* -text` in `.gitattributes` so a clean checkout on any host reproduces the bytes
  that were hashed; without that pin the recipe would work only on the host that wrote
  it. The tree deliberately contains files of both regimes, so the pin is load-bearing
  and testable rather than theoretical.
- **Nothing absolute is hashed.** The document holds relative, `/`-separated paths only,
  so the same tree at any location on any platform yields the same digest.
- **On POSIX a backslash is a legal character in a file name** and is left untouched;
  on Windows it is a separator and cannot occur in a name, so rewriting it is lossless.
- **An entry that is neither a regular file nor a directory is refused by name**, not
  skipped. Silently skipping would produce a fixed point of a tree that is not the one
  on disk. Symbolic links, junctions and device nodes therefore stop the command.
- **It never writes inside the tree it measures.** There is no flag that makes it. A
  `--manifest <path>` inside `--root` is **refused** — decided on filesystem identity,
  so an 8.3 alias, a junction or an admin-share UNC spelling of the root cannot walk
  around it — because a manifest landing in the tree changes the tree, and the digest
  printed beside it would then not be the digest of the tree asked about.
- **Deliberate compatibility difference.** This adopts `ordinal-path-bytes-sha256/1` as
  an independent review stated and used it, so the value that review published for this
  tree is reproducible here. It does **not** try to reproduce the older
  `inventory-digest-1` label: that value is not derivable from any tree this product
  ships, and inventing a recipe that happened to hit it would be fitting a number rather
  than defining one. Fixed points from before `src/inventory.mjs` existed are labels,
  not digests.

This README states no digest of its own tree. A published number would be invalidated by
the edit that published it, which is the same self-reference the `--manifest` refusal
exists to prevent. Run the command.

## Lineage receipt — publishing that a revision was reviewed, without publishing the diff

A quantity **leaks if it is a function of both revisions**. For a per-file holdout population
over a revision pair, the changed/unchanged split *is* the label vector, so the ordinary review
practice that entitles such a population to be evaluated — an independent Standards review and
an independent Spec review, each showing it measured something — is the same practice that
spends it. `docs/holdout-safe-reporting.md` states the doctrine; `src/lineage-receipt.mjs` is
the part a machine can check.

```
node scripts/lineage-receipt.mjs --successor <S-root> --predecessor <P-root>      --lineage <lineage-id> --declaration <decl.json>      --sealed --sealed-manifest <path-outside-every-root> --t-seal "<prose>"      [--open-store <dir>]... [--receipt <path>] [--json]

node scripts/lineage-receipt.mjs --verify <receipt> --successor <S-root>
node scripts/lineage-receipt.mjs --register-exposure --lineage <id> --reader <ref>      --released <digest> --register <path>
```

`buildLineageReceipt(declaration, sealedSink)` produces **two documents on two channels**. The
open receipt — schema `gaia-lineage-receipt/1` — is returned and is safe to publish. The sealed
manifest — `gaia-lineage-sealed-manifest/1` — carries every cross-revision row and is handed to
the caller-supplied sink; it is **never returned**, never printed, never logged, and never
interpolated into an error. There is no code path that returns it, which is a structural
property rather than a filter you have to trust. The trusted composition root supplies the
sink, exactly as it supplies the context capsule's revision adapter; the module can write
nowhere itself.

- **The open field set is closed.** `schema`, `recipe`, `lineage_id`, `sealed`, `successor`
  (`count`, `bytes`, `digest`), `sealed_manifest` (`schema`, `digest`), `cleanliness`,
  `evidence`, `tests`, `verdict`, `notes_digest`. A field not on that list is a schema
  violation, not an extension.
- **In sealed mode there is no predecessor field of any kind** — not its digest, not its count.
  The pairing is itself a cross-revision quantity.
- **`sealed_manifest.bytes` is forbidden.** The manifest's length is close to linear in the
  number of changed rows, so publishing it would publish the cardinality while naming no path.
- **No wall clock, anywhere.** Freshness is decided by digest resolution: a receipt is fresh
  exactly while the roots it names still reproduce their recorded digests, and stale means
  *refuse and re-derive*, never *use anyway*.
- **Unsealed is the default and reproduces today's behaviour** — both revisions' own
  `inventory-digest/1` triples, openly. A sink passed in unsealed mode is **refused**, not
  ignored, and so is its absence in sealed mode.
- **The sealed store must sit outside every measured root and every declared open store**,
  decided on filesystem identity, so a case variant, a trailing or doubled separator, a dot
  segment, an 8.3 alias, a `\?\` spelling, an admin-share UNC path or a junction cannot walk
  around it.
- **Refusals are typed and say only their code**: `SealedSinkRequired`, `SealedSinkForbidden`,
  `SealedStoreContainment`, `LineageReplayDivergence`, `RootUnreadable`, `NonRegularEntry`,
  `FieldSetViolation`, `IdentifierRefused`, `ArtifactConflict`. Error text is an open document
  too, so no refusal carries a path from either root, a row, or a cardinality.

Write order is sealed manifest → fsync → digest → open receipt → fsync. Payload before pointer:
a crash can leave an orphaned sealed manifest, which publishes nothing, or a receipt naming a
digest that does not resolve, which is a refusal for its consumer. **No crash window can publish
a vector.**

What this does **not** do: it does not make the vector unknowable — anyone holding both
revisions computes it in one command — and it does not close the freehand-prose channel, which
is doctrine and has no machine-checkable observable. The property obtained is **evidentiary, not
cryptographic**. Sealing is forward-only; burned lineages stay burned. No bus verb is added and
none is widened, and no digest recipe is introduced. The decision, the alternatives, the
invariants and the reversibility trigger are recorded in
[`docs/holdout-safe-reporting-design.md`](docs/holdout-safe-reporting-design.md).

### Inventory-routed official reports

`finalizeInventoryRoutedReport(request, sealedWrite)` is the single structural entry point for the
policy's six official classes: `handoff`, `standards-review`, `spec-review`, `reconciliation`,
`preflight`, and `readiness`. In sealed mode it writes canonical private evidence to the
caller-supplied curator write function, delegates the lineage commitment to
`buildLineageReceipt`, and returns only canonical `gaia-inventory-routed-report/1` JSON. Detailed
reviews can therefore use both revisions privately without publishing their changed-path vector.

The finalizer accepts the function itself, not an Adapter object. It synchronously copies the
validated request into an immutable canonical value before the first write, then uses that owned
value for both its content commitment and the sealed write. A readable Adapter may remain in the
trusted composition root, but only its explicitly bound `writeSealed` function crosses this seam.

In unsealed mode ordinary open evidence is preserved and no write capability is permitted. The sealed class
set is exact rather than extensible: adding a class requires a new policy digest and activation
receipt before sealing. The returned bytes are suitable for an external signing system, but this
module authenticates nobody, constitutes no curator, grants no authority, and mints no seal. The
agent procedure is
[`skills/gaia-interagent/references/reporting-context-template.md`](skills/gaia-interagent/references/reporting-context-template.md).

## Lanes: 4 is the supported maximum

**Four live lanes per workspace.** `scripts/wmux-lanes.mjs` refuses a fifth. *Live*
means a surface the peer tool currently reports `running` — not a lane that has spoken
to the bus recently. Nothing heartbeats a lane actor, so a lane that is thinking rather
than calling the bus is still a live lane and still counts. Retiring a lane frees its
slot.

- **6** is the *next validation target*. It is **not** validated with real
  Claude/Codex lanes.
- **8** is **unproven with real clients**. The 8- and 16-writer measurements that
  exist used identical Node workers; they prove id uniqueness, JSONL integrity and
  deterministic replay under contention, and nothing about throughput, heterogeneity,
  or a log of 10⁴–10⁵ events.

`--experimental-lanes` accepts a limit up to 8 and labels the run experimental. It
changes no evidence. Above 8 is refused outright. See `docs/scale-and-lanes.md`.

## Client configuration

```bash
node scripts/generate-config.mjs --client codex  --out <your-scratch-dir> --write
node scripts/generate-config.mjs --client claude --out <your-scratch-dir> --write
```

`--out` is required and there is no default. Any path inside `~/.codex`, `~/.claude`,
`~/.claude.json` or `~/.agents` is **refused**, and so is your home directory itself —
a client launched from `$HOME` auto-loads a `.mcp.json` found there, so writing one
into `$HOME` would install an auto-loading MCP configuration user-wide. A
*subdirectory* of `$HOME` is fine. This product never edits user-global client
configuration and offers no flag that would; `--force` cannot reach a refused path,
because the refusal precedes the overwrite decision.

**The refusal is decided on filesystem identity, not on spelling.** One directory has
many legal names, and a guard that compares strings refuses some of them and admits the
rest — which is a refusal claim that is false as written. `--out` is compared by volume
and file id where the path exists; by its canonical spelling where it does not; and,
where neither of those can answer — a root that does not exist yet, named through a
spelling `realpath` will not reduce — by the file id of the nearest ancestor that *does*
exist plus the segments below it. So all of these name `~/.codex` and all of them are
refused, **whether or not `~/.codex` has been created yet**:

| Spelling | Example |
| --- | --- |
| case variant (Windows/macOS) | `~\.Codex`, `~\.CODEX` |
| trailing, doubled or forward separators | `~\.codex\`, `~\\.codex`, `~/.codex` |
| dot segments | `~\.codex\.`, `~\x\..\.codex` |
| 8.3 short name | `~\CODEX~1` |
| extended-length / device namespace | `\\?\…\.codex`, `\\.\…\.codex` |
| admin-share UNC for the same volume | `\\localhost\C$\…\.codex` |
| a junction or symlink pointing at it | `~\my-link` |

It runs in the other direction too, and that half is load-bearing: a directory that is
**not** one of those roots stays writable however unusual its spelling — a junction to a
directory nobody protects, a `\\?\` spelling of your own scratch directory, or a sibling
whose name merely starts the same way (`~/.codex-scratch`). On Linux `~/.Codex` and
`~/.codex` are genuinely different directories you own, and both stay writable; a link
to `~/.codex` there is still refused, because identity is a filesystem fact rather than
a property of the name.

- Codex: load with `CODEX_HOME=<out>`, or copy to a trusted project's
  `.codex/config.toml`. The generated `startup_timeout_sec` is deliberately larger
  than the bus lock timeout — see `docs/crash-recovery.md`.
- Claude Code: `claude --strict-mcp-config --mcp-config <out>/.mcp.json`, which makes
  that file the only MCP source for the session.

## Ecosystem adapters

| Repo | Verdict | Enforced how |
| --- | --- | --- |
| GA | `ADAPTER_ONLY` | `scripts/ga-watch.mjs` tails GA JSONL read-only and never writes GA. |
| TARS | `ADAPTER_ONLY` | `scripts/tars-mount.mjs` emits a runtime mount; no TARS repo change. |
| Hari | `REJECT` | `assertIntegrationAllowed('hari')` throws. No integration ships. |
| IX | `DEFER` | `assertIntegrationAllowed('ix')` throws. Revisit on the two trigger conditions. |

Claude's native `SendMessage` is **not** a transport here: it addresses Claude Code
sessions only, on macOS/Linux, and cannot reach a non-Claude client. See
`docs/ecosystem-adapters.md`.

## Known limitations

1. **Per-call cost is O(events × actors).** `apply` ages every actor on every event,
   under one global lock, on a log that never compacts. No projection, index, or
   cached tail offset is implemented, and none is claimed.
2. **Trust is positional, not cryptographic.** Any process that can spawn the server
   can register as any actor and send as any ref. Every guarantee is about
   *authority*, not *authentication*.
3. **Locks are never broken, only reported.** Auto-breaking a stale lock is a TOCTOU
   with no atomic compare-and-delete available. A stuck lock needs a human.
4. **Fail-closed means unavailable, not degraded.** A wedged bus stops; it does not
   partially serve.
5. **No real Claude+Codex smoke was run in this lane.** See the product handoff for
   exactly what was and was not exercised.
6. **The bundled `.mcp.json` uses a relative server path.** Its resolution at plugin
   install time is unverified, because this candidate has not been installed.
7. One data directory is local-filesystem only. The lock is a local `mkdir`; do not
   share a data directory over a network filesystem.
8. **The evidence gate attests shape, not provenance.** `verify --require-evidence`
   checks that a log replays, that every address is a ref this bus minted, that its
   correlation ids are inside the issuer range and that the issuer still has runway to
   mint, that a multi-party correlated exchange
   with an ack and a handoff is present, and that the authority invariants are intact.
   Nothing in the event schema binds a record to a producing process, so a log this
   product generated by itself passes every check. `evidenceOk: true` means well-formed
   and untampered; it is never proof that two real clients talked to each other — see
   limitation 5.

## Data

`%LOCALAPPDATA%\gaia-interagent\data` on Windows (`$XDG_DATA_HOME` or
`~/.local/share` elsewhere). Override with `GAIA_INTERAGENT_DATA_DIR` or `--data-dir`.
Nothing is ever written inside the installed plugin.

The directory is **created by the first write only** — `initialize --apply`, or the
first bus verb that commits an event. Configuring a client to spawn the bundled server,
starting that server, and running `status`, `doctor`, `verify` or `uninstall-preview`
all create nothing.

Run `node scripts/gaia-interagent.mjs uninstall-preview` to see exactly what an
uninstall removes — and what it does not.
