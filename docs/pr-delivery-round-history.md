# Evidence-backed delivery rounds in managed PR descriptions

Status: R0 design decision for Gaia issue #51, parent #40. Written and committed **before** any
test or implementation, per ENG-01 and ENG-05 in
[`docs/engineering-and-research-principles.md`](engineering-and-research-principles.md). It selects
one implementation candidate. It grants no runtime, publication, merge or configuration authority,
and it is not independent review.

## Operator problem

A managed Draft body today is a fixed rendering: one operation marker line, `Issue`, `Owner`,
`Gate`, an ETA range and a static checklist (`src/gh-draft-operation-provider.mjs:128`). It states
what was requested once, and never what happened afterwards.

So when a reviewer asks *how did this change get here*, the only answer is local agent history —
lane logs, transcripts, scratch files — which is neither durable, nor shared, nor authoritative.
The GitHub projection, the one surface both operators and reviewers actually read, carries no
record of how many bounded repair rounds were spent, what evidence forced each one, or how much of
the declared budget is left.

The affected actor is the reviewer or operator reading the pull request in GitHub Cloud. The
concrete consumer is the managed section of the PR body itself.

### Success criteria

1. A managed Draft is created with exactly one `R0` round, deterministically, from the same
   evidence that authorized the Draft.
2. A durable reproduced-blocker receipt advances the history exactly once to `R1`; replaying that
   same receipt changes nothing.
3. Every published round names the evidence it was derived from, or prints `UNKNOWN(reason)`.
4. Human text outside the managed section survives every write byte-exact.
5. A write whose postcondition cannot be proved on GitHub ends in `BLOCKED / POSTCONDITION_UNPROVEN`
   with the observed revision and the mismatch, never in an assumed success.

### Falsifiable non-goals

- Not a status narrator. A round is opened by a durable receipt, never by a retry, restart,
  liveness ping, reformat, or a claim that work is progressing.
- Not a second source of lifecycle truth. Merge readiness, CI verdicts and review decisions are
  read; none of them is decided here.
- Not a merger, approver, promoter or pusher. The slice adds exactly one new GitHub effect: an
  update of one managed PR body.

## The bounded R0 tracer slice

ENG-05 asks for the smallest vertical slice that crosses every required seam and can still fail
honestly. Emission alone is not that slice: creating a Draft is a create, so an emission-only
tracer never exercises compare-and-set, read-after-write, or conflict with a human editor — the
three places this feature can actually be wrong.

The slice is therefore **`R0` emission plus exactly one proven advance to `R1`, and nothing
beyond**:

| In slice | Out of slice |
| --- | --- |
| Deterministic `R0` section at Draft creation | Any round beyond `R1` |
| One `R0` to `R1` advance from a durable blocker receipt | Automatic classification of blockers |
| Managed-section grammar, parse and render | Rich formatting, tables, collapsible history |
| Compare-and-set update with read-after-write proof | Merge strategies for concurrent managed edits |
| Bounded five-attempt reconciliation, then `BLOCKED` | Unbounded or background retry |
| Durable transition and GitHub receipt in the existing ledger | DuckDB analytical projection |

`R2..Rn` are deliberately excluded even though the mechanism generalizes. The ordinal successor
rule is written and tested at `R0` to `R1`; claiming it holds for every later round is an untested
generalization, and this document does not make it.

## Design it twice

### Alternative A — regenerate the whole body from state

Every write renders the complete body from Gaia's own model of the PR. Rejected. It makes Gaia the
owner of text a human may legitimately have written, and the issue forbids exactly that. The first
human paragraph added to a managed Draft would be silently deleted, and no read-back could detect
the loss because the regenerated body would match Gaia's expectation perfectly.

### Alternative B — append one comment per round

Each round becomes a new PR comment; the description is never touched. Rejected. It removes the
conflict problem by removing the requirement: the issue asks for the *description* to carry the
history, because that is the surface a reviewer reads first. It also reintroduces reconstruction —
a reader would assemble the history from a comment stream ordered by wall clock.

### Alternative C — one delimited managed section, replaced under compare-and-set — selected

The body is split into three parts by two exact marker lines: prefix, managed section, suffix. Only
the managed section is ever rendered by Gaia. Prefix and suffix are copied through byte-exact from
the body GitHub just returned. The whole body is then written under a compare-and-set on the exact
revision that was read, and the write is believed only after the projection is read back.

Selected because it localizes the change to one renderer plus one parser, keeps human ownership of
everything outside two comment lines, and makes lost updates detectable rather than merely
unlikely.

## Managed section grammar

The grammar is closed and line-anchored, reusing the existing HTML-comment convention of
`markerLine` (`src/gh-draft-operation-provider.mjs:124`):

```text
<!-- gaia-rounds:begin:WORKKEY -->
### Delivery rounds

R0 — RESULT
...
<!-- gaia-rounds:end:WORKKEY -->
```

`WORKKEY` is the 64 lowercase hex characters of the `workKey` defined in
[`docs/draft-operation-envelope.md`](draft-operation-envelope.md). A body is well-formed for this
slice only when it contains exactly one `begin` line and exactly one `end` line, both for the
expected `workKey`, with `begin` strictly before `end`. Anything else — zero, duplicated, crossed,
foreign `workKey`, or a marker appearing inside a fenced code block — is `ManagedSectionMalformed`
and produces no write. Absent evidence of a well-formed section is not evidence that Gaia may
create one over the top of somebody's text.

## What one round records

Each round is one block, rendered from the closed field set the issue names: round ordinal, design
commit, RED commit, GREEN commit, test evidence receipt, review verdicts, result, next step, ETA
range with confidence, origin, and — on `R0` only — the declared bounded round budget. Every field
is either a bound value or the literal `UNKNOWN(reason)`. No field is omitted, and no field is
inferred from prose.

The operator-facing non-movement explanation is also closed and mandatory on every round. It
records one blocker class (`NONE`, `CI`, `REVIEW`, `TEST`, `REPRODUCED_FAILURE`, `DEPENDENCY`,
`AUTHORITY`, or `UNKNOWN(reason)`), one accountable owner, one bounded phase deadline, one next
transition, one escalation action, and one origin. Missing values render as `UNKNOWN(reason)`;
absence is malformed. The phase deadline is an intervention boundary, not a delivery estimate.
When a durable deadline-observation receipt proves that boundary has expired, the pure planner
emits an `ESCALATE` intent naming the recorded action and owner. That intent grants no effect:
the adapter cannot merge, close, force, approve, or otherwise act on it.

Responsibility and command are separate closed subcontracts on every round. Responsibility names
`accountableOwner` (a GitHub-resolvable durable identity), `supervisor` (the durable operation or
controller identity), `executionOwner` (the bounded lane identity), `reportsTo`, distinct
read-only `reviewOwners.standard` and `reviewOwners.spec`, one `effectOwner` or `NONE`, and
`escalatesTo`. `reportsTo` must resolve directly to the supervisor or accountable owner. The
responsibility assignment carries its own durable `ownershipRevision`; changing any link without
changing that revision is refused.

Command names one `commandOwner`, one direct two-node `commandPath` from that owner to the
execution owner, the exact head generation it governs, and its own durable `commandRevision`.
The fixed command vocabulary is `ASSIGN`, `REVOKE`, `STOP`, `RETRY`, and `ESCALATE`; it is not
transitive. Reporting carries evidence upward and grants none of these actions. Command authority
cannot be inferred from prose, liveness, completion, GitHub assignment, or `reportsTo`. Missing
links, self-cycles, orphan lanes, two commanders, duplicate effect owners, stale generations, and
review identities that overlap an effect or execution owner are malformed and produce no write.
Owner handoffs therefore use the same durable-receipt, exact-CAS, read-after-write, and idempotent
replay path as the round transition; no check-then-act ownership claim exists at the adapter seam.

Published rounds are append-only within the section: `R1` is added after `R0`, and the text
recorded for `R0` is never rewritten. A correction is a new round, not an edit of an old one.

## Identity

Canonical JSON and SHA-256 are the ones already defined for the operation envelope; this slice
introduces no second hashing convention.

```text
roundLineageKey = sha256(canonical({ schema: 'GaiaRoundLineageKeyV0', workKey }))
roundKey        = sha256(canonical({ schema: 'GaiaRoundKeyV0', roundLineageKey, ordinal }))
advanceKey      = sha256(canonical({ schema: 'GaiaRoundAdvanceKeyV0',
                                     predecessorRoundKey, blockerReceiptRevision }))
```

- The lineage binds to `workKey`, which excludes branch generation, lane, agent, prompt and clock.
  A rebase, a retry, or a new lane therefore continues the same history instead of starting a
  second one.
- `advanceKey` is the idempotency key of the successor transition. Duplicate delivery of the same
  blocker receipt resolves to the same `advanceKey`, returns the prior result, and performs no
  second GitHub effect.
- Two different receipts that both claim the same predecessor race for exactly one successor
  ordinal; the loser observes the successor already published and refuses with
  `RoundLineageConflict` rather than opening `R1` twice.

## State and CAS invariants

- **INV-1 — closed states.** `ABSENT` to `R0_PUBLISHED` to `R1_PUBLISHED`, with `BUDGET_EXHAUSTED`,
  `BLOCKED_POSTCONDITION_UNPROVEN` and `REFUSED` as the only other terminals. No other transition
  exists in this slice.
- **INV-2 — successor rule.** An advance increments the ordinal by exactly one. Gaps, reuse, and
  decreases are refused before any effect.
- **INV-3 — evidence precondition.** An advance requires a durable receipt identified by its own
  revision. A missing receipt is `MissingBlockerReceipt`, never an assumed round.
- **INV-4 — budget.** The bounded round budget is declared at `R0`. Reaching it moves the lineage
  to `BUDGET_EXHAUSTED`, which opens an architecture reassessment; it never silently permits
  another repair round. Exceeding it requires an explicit human exception recorded as evidence,
  which this slice can represent but does not grant.
- **INV-5 — read before write.** Every write is preceded by one observation of `number`,
  `headRefOid` and `body`, from which `bodyRevision = sha256(body)` is derived. GitHub exposes no
  body ETag, so the revision is content-derived by definition.
- **INV-6 — compare-and-set.** The write carries the exact expected `number`, `headRefOid` and
  `bodyRevision`. Any drift in the observation taken immediately before the write refuses the
  attempt; a changed head is `StaleHead`, a changed body is `StaleBody`.
- **INV-7 — transport acknowledgement is not proof.** A successful `gh` invocation proves only that
  the command was accepted. The postcondition is proved by re-reading the projection and comparing
  `sha256(observedBody)` against the exact expected body revision.
- **INV-8 — bounded reconciliation.** At most five attempts. Each attempt re-reads, re-derives the
  merge of the rendered section onto the observed prefix and suffix, and re-writes. After the fifth
  unproven attempt the outcome is `BLOCKED / POSTCONDITION_UNPROVEN`, carrying the observed
  revision and the exact mismatch.
- **INV-9 — human text is preserved.** Prefix and suffix are copied byte-exact from the body just
  observed. A concurrent human edit outside the section survives; a concurrent edit that changes the
  managed section under Gaia is `ManagedSectionConflict` and stops the loop immediately rather than
  consuming the remaining attempts.
- **INV-10 — durable evidence.** The round transition and the GitHub update receipt are appended to
  the existing durable GitHub ledger. Local artifacts are observations, not authority. A failed
  attempt is retained as immutable Failure Evidence and is never rewritten by a later success.
- **INV-11 — deadline means intervene.** Deadline evaluation consumes an explicit durable
  observation time. Before expiry it is a non-event; at or after expiry it produces a pure
  escalation intent and no GitHub mutation. It never predicts completion or grants the escalation
  action it names.
- **INV-12 — one direct command edge.** One revision-bound command owner may command one bounded
  execution owner for the exact observed generation. The reporting graph and review identities
  carry no command or effect authority, and command never flows transitively through them.
- **INV-13 — one effect owner.** A round names either one effect owner or `NONE`. The effect adapter
  remains separately injected and capability-bounded; naming an owner is evidence, not a grant.

## Failure modes

| Condition | Outcome | Effect |
| --- | --- | --- |
| Malformed or ambiguous markers | `ManagedSectionMalformed` | none |
| Head moved between read and write | `StaleHead` | none |
| Body changed between read and write | `StaleBody` | retry within budget |
| Managed section changed underneath | `ManagedSectionConflict` | none, loop stops |
| Successor ordinal already published | `RoundLineageConflict` | none |
| Advance without a receipt | `MissingBlockerReceipt` | none |
| Five attempts, postcondition unproven | `BLOCKED / POSTCONDITION_UNPROVEN` | write attempted, result recorded as unknown |

Every one of these fails closed. None of them degrades into a partial write that is reported as
success.

## Pre-registered falsifiers

Per SCI-01, these observations disconfirm the design and are recorded before the tests exist:

1. A managed Draft is created whose body contains no `R0` section, or contains two.
2. The same blocker receipt, delivered twice, produces two rounds or two GitHub effects.
3. A retry, restart, liveness ping or reformat advances the ordinal.
4. Any byte outside the managed section differs after a write that was not made by a human.
5. A write is reported as applied while the read-back shows a different body revision.
6. The attempt loop exceeds five write attempts, or terminates with a success verdict it did not
   prove.
7. `UNKNOWN(reason)` is replaced anywhere by a fabricated ETA, verdict or commit.
8. The text recorded for a published round changes after the fact.

## Test plan

RED first, committed before the implementation, run with `node --test`. Each gate below maps to a
falsifier or a Done-when item in issue #51:

1. **Deterministic `R0`.** Rendering the same evidence twice yields byte-identical sections; the
   created body contains exactly one well-formed section.
2. **Single advance.** One reproduced-blocker receipt moves `R0_PUBLISHED` to `R1_PUBLISHED`; the
   ordinal increments by exactly one.
3. **Idempotent replay.** The same receipt delivered twice, and the same advance replayed from the
   ledger, produce one round and one effect.
4. **Non-events.** Retry, restart, heartbeat and formatting inputs produce no transition.
5. **Grammar.** Zero, duplicate, crossed, foreign-`workKey` and code-fenced markers each refuse with
   `ManagedSectionMalformed` and write nothing.
6. **Human preservation.** A body carrying human text before and after the section round-trips
   byte-exact through a successful advance.
7. **Concurrency.** A managed-section edit interleaved between read and write yields
   `ManagedSectionConflict`; a head move yields `StaleHead`.
8. **Read-after-write.** A stubbed provider that acknowledges the write but returns an unchanged
   body forces exactly five attempts and then `BLOCKED / POSTCONDITION_UNPROVEN` carrying the
   observed revision.
9. **Budget.** Reaching the declared budget yields `BUDGET_EXHAUSTED`, not another round.
10. **Missing evidence.** An advance without a receipt refuses; a missing ETA renders
    `UNKNOWN(INSUFFICIENT_HISTORY)`.
11. **Replay determinism.** Replaying the ledger reconstructs the same lineage state, including the
    retained failed attempt.
12. **Mechanism-revert controls.** Removing the compare-and-set, the read-after-write comparison,
    the attempt bound, or the prefix and suffix preservation must each make a test fail. Each
    control writes its mutant, imports it and asserts a behavioural divergence; reading the source
    as a string does not discharge a control.
13. **Markdown validity.** The rendered section parses as valid Markdown and stays concise under the
    declared field set.
14. **Non-movement and deadline.** Every round renders the closed blocker explanation. A deadline
    observation before expiry is a typed non-event; one at expiry emits the recorded escalation
    intent with no provider write, merge, close, force, or approval capability.
15. **Responsibility versus command.** Positive cases render every responsibility link and the
    direct command edge. Negative cases refuse missing links, self-cycles, orphan lanes, dual
    commanders, duplicate effect authority, overlapping review/effect owners, unresolvable
    `reportsTo`, and stale command generations.
16. **Ownership handoff.** A changed chain requires a changed durable ownership/command receipt;
    exact replay converges to one successor and uses the same read-after-write proof as any other
    managed-section update.

Tests bind to a deterministic in-memory provider adapter and to the production-shaped `gh` adapter
through the same black-box contract, per ENG-03.

## Explicitly deferred

These are named so their absence is a recorded decision, not an oversight. Each remains an open
requirement of issue #51 and is not satisfied by this slice:

- **DuckDB projection** of current round, round duration, blocker and estimate variance. The
  append-only ledger stays replay authority; the analytical copy is a later slice.
- **`R2..Rn`.** Only the `R0` to `R1` successor is written and tested here.
- **Automatic blocker classification.** This slice consumes a receipt; deciding which review, CI or
  reproduced failure deserves one is upstream and unchanged.
- **Human budget exception workflow.** The state is representable; granting it is human authority
  and out of scope.
- **Adoption of pre-existing unmanaged PR bodies.** A body with no section is left alone.
- **ETA variance modelling.** `R0` publishes a range and a confidence, or `UNKNOWN(reason)`.
- **Cross-repository and multi-lineage histories.** One repository, one lineage per `workKey`.

## R1 production-composition correction

Fresh review of the R0 tracer found two integration gaps. The pure renderer proved that a canonical
R0 could exist, but no production-shaped Draft-creation adapter was required to carry it. The R1
executor proved GitHub-body read-after-write, but could return `APPLIED` before the transition and
provider receipt existed in durable GitHub evidence. Both gaps are in scope for the one R0-to-R1
slice and are closed here; DuckDB and later rounds remain deferred.

### Canonical R0 at the create effect

The creation adapter receives a fully validated R0 receipt, `workKey`, exact head revision, and the
human/provider base body. It calls `createInitialManagedRound`, appends exactly that canonical
section once, performs the one Draft create, then reads the Draft back and compares the exact head
and whole-body revision. The adapter cannot synthesize owners, deadlines, evidence, or command
authority from presentation prose. An absent or malformed R0 receipt refuses before GitHub.

The same black-box contract runs against two adapters: a deterministic in-memory adapter and a
production-shaped GitHub adapter whose injected API must expose atomic `compareAndSetBody`. That
capability, not a read followed by an unconditional edit, is the linearization point. A GitHub API
binding that cannot supply atomic expected-revision update is unsupported and must fail closed;
the adapter does not emulate CAS with check-then-act.

### Durable GitHub evidence before success

One append-only Git Data ref per `workKey` stores closed `INTENT` and `APPLIED` records. `INTENT`
binds `workKey`, stable operation identity (`roundKey` for R0 or `advanceKey` for R1), exact expected
head/body revisions, proposed body revision, effect owner, and receipt revision. `APPLIED` binds the
intent revision plus the exact GitHub read-back revision and provider receipt. Git Data
`compareAndAppend` is the evidence linearization point; every append is read back before it is
accepted.

The executor order is fixed:

1. derive the canonical proposal;
2. persist or reconcile the idempotent `INTENT`;
3. perform the provider create/CAS at most once for that intent;
4. reconcile an ambiguous response by reading GitHub before any retry;
5. persist and read back `APPLIED`;
6. only then return success.

A crash after `INTENT` replays by inspecting GitHub first. A duplicate call returns the same
durable terminal receipt byte-for-byte. Two actors reading one evidence revision race at Git Data
CAS; the stale loser performs no provider effect. GitHub success followed by a lost response is
reconciled, never blindly repeated. Evidence append ambiguity is also read back before retry.

### Added R1 falsifiers

1. A production-shaped create body lacks exactly one canonical R0 section.
2. In-memory and production-shaped adapters disagree on any public effect-contract result.
3. `APPLIED` is returned before both the GitHub read-back and durable `APPLIED` receipt exist.
4. Replaying one operation adds a provider effect or changes the terminal receipt bytes.
5. Removing durable intent, atomic CAS, read-after-write, or evidence reconciliation leaves the
   contract green.

## R2 real-provider and create-claim correction

Fresh Standards review reproduced two remaining P1 gaps. The shipped `gh` Draft provider still
rendered its legacy body directly, so the managed creation executor had no production caller. Also,
two same-operation callers could reuse one INTENT, both observe no Draft, and both invoke create.
R2 closes only those gaps; it does not add another delivery round or another provider effect.

### Real Draft-provider composition

`createGhDraftOperationProvider` receives the exact managed-round input as data: `workKey`, the
validated R0 receipt, the receipt-bound effect actor, a bounded effect-claim receipt, and the GitHub
evidence port. Its public `createDraft` calls `executeManagedDraftCreation`. The provider's legacy
presentation is only the human-authored base body; the executor appends canonical R0 before the
provider command, and the raw `gh pr create --body` receives that proposed body byte-for-byte. The
exact `gh pr view` readback must carry the same body before either the managed executor or the outer
Draft operation may report success. Missing managed input refuses before `gh` creation; the
provider may not synthesize an owner, deadline, receipt, command path, or evidence origin.

### Durable create claim

INTENT records desire, not exclusive ownership. Before create, the executor appends a closed CLAIM
record bound to `workKey`, R0 `roundKey`, INTENT revision, a unique executor claim id, exact claim
receipt revision, `observedAt`, and a bounded `leaseExpiresAt`. Git Data `compareAndAppend` against
the observed evidence head is the claim linearization point. Only the caller whose exact CLAIM is
confirmed after that append may call the provider.

A contender that loses claim CAS reads the winner and returns `EffectClaimHeld`; it performs no
provider create. A claim cannot be inferred from process liveness, prose, GitHub assignment, or a
prior observation. An unexpired claim cannot be replaced. After expiry, a new revision-bound claim
may be appended by CAS, after reconciling GitHub first. A lost claim-append response is reconciled
by exact claim id and revision before proceeding. A crash after CLAIM and before create leaves a
bounded lease, not permanent ownership; recovery uses a fresh claim only after that boundary.

The bounded actors are independent executor epochs, each with a unique claim id. Reusing one claim
id concurrently is an invalid actor identity, not a second grant of effect authority. Stable work
identity remains `workKey`; stable operation/idempotency identity remains R0 `roundKey`. CLAIM does
not grant merge, close, ready, force, approval, or any new GitHub authority.

### Added R2 falsifiers

1. The real `gh pr create --body` lacks exactly one canonical R0 section.
2. Removing the provider-to-executor composition restores the legacy body while tests stay green.
3. A barrier lets two distinct claims observe no Draft and both invoke provider create.
4. Removing CLAIM CAS or treating INTENT reuse as ownership leaves the concurrency test green.
5. A stale claimant, unexpired contender, or ambiguous claim response performs a blind create.

## R3 hosted composition and recovery correction

Fresh review found that the hosted executor omitted the managed-round configuration, that recovery
treated an eventually-consistent null lookup as proof that no Draft existed, that lease takeover
trusted a contender timestamp, and that the R1 executor remained test-only. R3 closes those four
production seams without granting another effect or implementing later rounds.

The hosted reconcile input carries one closed, operator-authored managed-round contract. It contains
the exact R0 receipt, bounded create claim, effect actor, and (when a reproduced blocker is ready)
the exact R1 advance receipt and target pull-request number. The runtime does not infer any owner,
command edge, deadline, trigger, or authority from the legacy presentation. It constructs one GitHub
evidence port from the existing Git Data adapter, passes the R0 contract to the real Draft provider,
and, after the existing operation reconciliation returns a created or reused exact Draft, invokes
the public R1 executor only when the explicit advance receipt is present. The R1 adapter is the
existing atomic GitHub body adapter and success still requires durable APPLIED readback.

A null provider observation means `UNKNOWN`, never `ABSENT`. Recovery after a durable create CLAIM
may append a successor claim only when two independent facts are available: the evidence port's
authoritative clock reports the previous lease expired, and the provider positively proves the
operation absent. The GitHub adapter currently cannot make that strong absence statement and
therefore returns `UNKNOWN`; it fails closed rather than repeating `gh pr create`. A deterministic
memory adapter may prove absence from its authoritative operation map.

Lease expiry is a store-clock decision. The new contender's `observedAt` and `leaseExpiresAt` only
validate the requested lease's positive bounded duration; they cannot expire an earlier claim. An
evidence port without an authoritative clock returns `UNKNOWN`, which refuses takeover. Thus a
future-skewed contender, process liveness, elapsed wall time, or prose cannot steal an active claim.

### Added R3 falsifiers

1. The hosted provider receives no exact R0 contract or durable GitHub evidence port.
2. The hosted reconcile path receives an explicit durable R1 receipt but performs no atomic managed
   body transition or returns before the update receipt is durable.
3. An eventually-consistent null lookup after an ambiguous create causes another provider create.
4. A future-skewed contender timestamp replaces a claim that the evidence store reports active.
5. Removing positive absence proof, authoritative lease-state validation, or hosted R1 composition
   leaves its public black-box test green.

## R4 repository binding and current-main intake correction

R4 validates the PR against the current `origin/main` merge tree. That tree adds the scheduled and
issues-labelled intake command; its real reconcile path previously dereferenced an absent
`configuration.managedRound`, so the intake could enqueue but could not create a managed Draft.
R4 requires both event paths to carry the same exact operator-authored managed-round contract used
by manual reconcile. Intake may select and transport that data but cannot synthesize owners,
command authority, deadlines, evidence, claims, or an R1 receipt. An absent contract is a closed
argument refusal before enqueue or provider work. An explicit R1 remains optional and receipt-bound.

The production body adapter binds repository identity before every observation and mutation. It
first reads `gh repo view <owner>/<name> --json id,nameWithOwner` and requires both the durable node
id and canonical owner/name to equal `expectedRepository`. A mismatch refuses before the pull
request GET or PATCH. Owner/name alone is never authority, and a prior successful check is not
reused as proof for a later mutation.

The public `createGhManagedRoundApi` seam is exercised as a real black box with scripted `gh`
responses. The contract proves repository binding, GET plus ETag capture, PATCH with the exact
`If-Match`, exact readback, lost-response reconciliation by the outer executor, one PATCH only,
and redacted failures. Durable mechanism-revert tests import behaviorally mutated modules: removing
the node-id comparison, `If-Match`, or the hosted managed-round intake propagation must make a
public assertion fail.

### Added R4 falsifiers

1. A repository with the same owner/name but another node id reaches a pull-request GET or PATCH.
2. A body update omits the ETag `If-Match`, performs more than one PATCH, or treats a lost response
   as permission to repeat the mutation.
3. Provider diagnostics or secrets escape a typed adapter refusal.
4. Either the scheduled or issues-labelled intake path reaches reconcile without the exact
   managed-round contract.
5. Any repository-binding, provider-CAS, or intake-propagation mechanism revert remains green.

## Authority and reversibility

The slice adds exactly one GitHub effect — updating one managed PR body — behind the same closed,
injected provider that today exposes only `lookupExact` and `createDraft`
(`src/gh-draft-operation-provider.mjs:235`). No method here can merge, approve, dismiss, promote,
push, close, or change labels, rulesets, configuration or credentials. The six bus verbs are
unchanged. No new dependency is introduced.

Reversibility: freely reversible. Disabling the composition stops all writes; bodies already
published remain valid Markdown, and the two marker lines are inert HTML comments. The ledger is
append-only, so rollback deletes and rewrites nothing.

## Decision receipt

- **Effect delta:** one, an update of one managed PR body, compare-and-set, idempotency-keyed,
  reconcilable, bounded at five attempts.
- **Authority delta:** none.
- **Bus delta:** none. Six verbs, unchanged.
- **Dependency delta:** none.
- **Falsifier:** any of the eight pre-registered observations above, most sharply a second round
  from a duplicate receipt, or a success verdict that read-after-write did not prove.
- **ETA:** `UNKNOWN(INSUFFICIENT_HISTORY)` — no comparable managed-body compare-and-set lane has
  completed in this ledger.
