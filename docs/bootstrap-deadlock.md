# Bootstrap deadlock tracer — issue #80's hosted Draft pump scenario as Petri nets

Status: diagnostic tracer for issue #80's next slice ("model one observed cycle and show whether an
already admissible first transition exists"). It installs no seed, starts no daemon, grants no
authority and changes no pump behaviour. It reads code, declares nets, and reads an analysis.

## Question

Issue #80's tracer scenario: *the hosted Draft pump needs a Control Room observation, but the first
observation can only be produced by a pump run, and the run must not be considered healthy merely
because the schema exists.* #80 resolves it itself: the schema is contract establishment, the first
real run is bootstrap evidence, a sealed terminal receipt may seed the first observation, only the
next independently reconciled run proves steady state, and a bridge that translates the first
receipt must then emit a Retirement Receipt.

So the question is not whether a run can start without an observation. It is: in the code that
ships, is the receipt seed in place, does anything prove steady state, and can the seed retire?

## Answer

| Net | Reading | Evidence (IX `ix_petri_analyze`, exhaustive, 10 000-state budget) |
| --- | --- | --- |
| `asShipped` — the seam read off the code, with no steady-state proof recorded | `NO_DEADLOCK` | 9 markings, 1-bounded. The first run installs the receipt seed (`P_SEED_UNRETIRED` reaches 1). `P_STEADY_STATE_PROOF` holds 0 and nothing produces it, so `T_RECONCILE_NEXT_RUN`, `T_RECONCILED_RUN` and `T_RECONCILED_RUN_AFTER_STALE` are disabled by construction and `T_RETIRE_SEED` with them; IX works out the consequence, that `P_STEADY_STATE` and `P_SEED_RETIRED` never hold a token. `T_OBSERVATION_GOES_STALE` and `T_RESEED_AFTER_STALE` stay live: whenever the observation has gone STALE, the receipt path can seed it again. |
| `asSpecified` — `asShipped` plus one steady-state proof token | `NO_DEADLOCK` | 21 markings, every transition quasi-live. If the proof existed, steady state and the Retirement Receipt would be reachable. `live` fails for exactly the bootstrap transitions (`T_SEED_FIRST_OBSERVATION`, `T_RESEED_AFTER_STALE`, `T_RESEAL_FROM_RECEIPT`, `T_RECONCILE_NEXT_RUN`, `T_RETIRE_SEED`): after cutover the seed path is dead and a stale observation recovers through a reconciled run. |
| `runGatedOnObservation` — a run that needs a fresh observation (cyclic control) | `BOOTSTRAP_DEADLOCK` | 1 marking; dead at `m0` with the empty witness. Seven transitions are blocked only by facts the others would produce; the smallest cycle through `T_RUN_PUMP` is `T_RUN_PUMP → P_INTAKE_RECEIPT → T_SEED_FIRST_OBSERVATION → P_FRESH_OBSERVATION → T_RUN_PUMP`. The four transitions that wait on the steady-state proof are outside that set, and no explanation routes through them. |
| `seededGatedControl` — the gated net with #80's seed installed | `NO_DEADLOCK` | 6 markings. The seed is a durable fact (`P_SEED_UNRETIRED`) that admits one transition, a run while no observation is fresh (`T_RUN_PUMP_ON_SEED`, read arcs only), as the shipped schedule runs whatever the observation's age. The observation does go STALE, and `T_OBSERVATION_GOES_STALE`, `T_RUN_PUMP_ON_SEED`, `T_RESEED_AFTER_STALE` and `T_RUN_PUMP` all stay live, so it is not labelled deadlocked, as #80's grooming requires. That holds only while the seed cannot retire, and `P_STEADY_STATE_PROOF = 0` is what guarantees it: see *The seed control after retirement* below. |
| `acyclicControl` — a dispatch nobody requests | `MISSING_PREREQUISITE` | Dead at `m0`, and `P_DISPATCH_REQUESTED` has no producer, so there is no cycle. #80 refuses to call this a bootstrap deadlock, and so does the reader. |

What this says about #80's tracer, and no more:

- **The seed exists.** Every hosted run seals its own terminal receipt into the observation
  (`observeTransition`, `scripts/hosted-draft-pump.mjs:537-554`, called at `:640`). The first such
  observation is #80's receipt seed, so under #80 §6 it owes a stable operation identity, an owner,
  a scope, an expiry or revisit condition, a rollback and a Retirement Receipt, and under #79 it is
  a Maintenance Obligation. Nothing in `src/` or `scripts/` records any of those.
- **The seed and the producer are one call.** In code, `T_SEED_FIRST_OBSERVATION`,
  `T_RESEED_AFTER_STALE`, `T_RESEAL_FROM_RECEIPT` and the post-cutover `T_RECONCILED_RUN` would all
  be that same `observeTransition`, the only thing that produces an observation at all. Retiring the
  seed would retire its standing as bootstrap evidence and its #79 obligation, not that call:
  removing it leaves the Control Room with no observation and a permanent `STALE`.
- **Whether anything proves steady state is a reading of the code, not an IX result.** `asShipped`
  gives `P_STEADY_STATE_PROOF` no token and no producer, so "steady state and retirement are
  unreachable" is that premise, and any enumerator returns it. The premise is the decision below.
  If no proof exists, then the seed cannot retire; if one is built, `asSpecified` shows the cutover.
- **Health is not read from the schema.** #80 says the run "must not be considered healthy merely
  because the schema exists", and the code does not do that: `deriveState`
  (`src/hosted-draft-pump-observation.mjs:333-340`) reads `BLOCKED` unless the run's blocker is
  `NONE`, and `UNSETTLED` unless its `unsettledCount` is 0. The run reads that count from the
  durable ledger before and after it acts (`src/hosted-draft-pump.mjs:287-290`, `:230-237`, and the
  receipts at `:319`, `:364`, `:373`). So the first receipt-seeded observation can read `healthy`
  on that run's own ledger reconciliation. What #80 adds is that only the *next* independently
  reconciled run proves steady state, and the code keeps nothing that links a later run to the
  first.
- **The seed is not one-time.** Every run seals from its receipt, and an observation reads `STALE`
  after 12 h (`HOSTED_DRAFT_PUMP_FRESH_MS`, `src/hosted-draft-pump-observation.mjs:58-67`), twice
  the 6 h schedule (`.github/workflows/hosted-draft-intake.yml:25`). So `STALE` needs at least two
  consecutive scheduled runs that publish nothing (a refused observation, a failed intake, or a run
  that did not happen), or an uploaded artifact past its 14-day retention. When it happens, the same
  receipt path seeds again.
- **Retiring the seed strands a gated run.** With the proof token set, the seeded control retires
  its seed and then reaches a dead marking (below). The shipped run is not gated, so this is a
  finding about #80's retirement rule on a gated run, not about the code.
- **One fact separates the code from #80's rule.** `asShipped` and `asSpecified` have identical arcs
  and differ in one initial token, `P_STEADY_STATE_PROOF`. That is the capability to build, not a
  dependency to delete: this is not a `FALSE_CYCLE`.

### Is intake's recovery reconciliation the steady-state proof? Evidence yes, proof no

- **Evidence, yes.** A later scheduled run does reconcile earlier work from the durable ledger, not
  from the earlier run's receipt: `runHostedDraftIntake` lists the unsettled operations
  (`src/hosted-draft-pump.mjs:287-290`), reconciles the first by work key (`:298-321`), and reads
  the ledger again after acting (`concurrentlyAppeared`, `:230-237`).
- **Proof, no, as shipped.** It reconciles only operations still unsettled, so an earlier run that
  reached a terminal outcome leaves the next run nothing of it to reconcile (`:298`). The
  observation a run seals names no earlier observation or seed: `observeTransition` passes no
  `priorObservation` (`scripts/hosted-draft-pump.mjs:537-554`), and the prior the dashboard passes
  (`priorHostedDraftPumpOf`, `scripts/factory-dashboard.mjs:210-219`, used at `:388`) is compared
  for ordering only (`requireMonotonic`, `src/hosted-draft-pump-observation.mjs:284-293`). And the
  block is derived from one observation (`summarizeHostedDraftPump`, `:436-438`), so nothing consumes
  two runs as a proof or could hand one to a retirement step.

So `asShipped` gives `P_STEADY_STATE_PROOF` no token. That is this reading, made by hand, and it
moves if any of those three facts change.

### The seed control after retirement

`seededGatedControl` is `NO_DEADLOCK` because its seed never retires: retirement needs steady state,
steady state needs the proof, and the proof token is 0. The probe net `seededGatedControlWithProof`
is the same net with that token set to 1 (`tests/fixtures/bootstrap-deadlock/probe-nets.mjs`). IX
enumerates 18 markings and finds one dead marking, after
`T_RUN_PUMP → T_RECONCILE_NEXT_RUN → T_OBSERVATION_GOES_STALE → T_RETIRE_SEED → T_SCHEDULE_TICK`:
the seed is retired, the observation is STALE, a run is due, and steady state is proven. There:

- the gated run `T_RUN_PUMP` needs a fresh observation;
- the seed run `T_RUN_PUMP_ON_SEED` needs the unretired seed, which is spent for good;
- the reconciled run after STALE, `T_RECONCILED_RUN_AFTER_STALE`, needs a receipt, which only a
  run makes.

So #80's rule, "retire the seed once a later independently reconciled run proves steady state",
strands a run that is gated on a fresh observation at the next STALE observation. Steady state is
not enough to stay admissible once the seed is gone; the reconciled path would need its own way to
run without a receipt. The reading is `REACHABLE_DEADLOCK`, not `BOOTSTRAP_DEADLOCK`: the seed run
is a way into the cycle, and what closes it is the retirement, not the cycle alone (see the rules
below). `T_RUN_PUMP_ON_SEED` stands for the shipped schedule only while the seed stands; the shipped
run takes no observation and keeps running after any retirement, so the code is not stranded.

## The model, and the code each part stands for

The model is read off the code by hand. That is an assumption, not a binding: nothing derives these
arcs from the source, and a behavioural change to the pump does not fail these tests.

| Net element | Stands for |
| --- | --- |
| `P_TICK_DUE` (1), `P_IDLE`, `T_SCHEDULE_TICK` | The `schedule: cron '17 */6 * * *'` trigger of `.github/workflows/hosted-draft-intake.yml`. The non-cancelling `gaia-draft-intake-recovery` concurrency group serializes recovery runs, so the next run starts after this one finishes. Only scheduled and dispatched runs get `GAIA_OBSERVATION_PATH`; a labelled issue lane publishes no observation and is not modelled. |
| `P_OBSERVATION_SCHEMA` (1) | `gaia-hosted-draft-pump/1` exists (`src/hosted-draft-pump-observation.mjs`). Contract establishment, not liveness: every seal reads it, and it enables nothing on its own. |
| `T_RUN_PUMP` | `runHostedDraftIntake` in `src/hosted-draft-pump.mjs`. Its inputs are a repository, candidates, a limit and ledger/operation ports. No observation is among them. |
| `P_INTAKE_RECEIPT` | The sealed `GaiaHostedDraftIntakeReceiptV0` that run returns. |
| `T_SEED_FIRST_OBSERVATION`, `T_RESEED_AFTER_STALE`, `T_RESEAL_FROM_RECEIPT` | One code path: `observeTransition` → `produceHostedDraftPumpObservation(receipt)` in `scripts/hosted-draft-pump.mjs`, which passes no `priorObservation`; the dashboard's later check against its own previous publication compares ordering only. The net splits the call three ways only to count the first seed (`P_NO_SEED` → `P_SEED_UNRETIRED`), which #80 §6 needs identified; the code keeps no such record. |
| `T_REFUSE_OBSERVATION` | The typed refusal in `observeTransition`: the run still succeeds and publishes nothing, and the absent observation ages into `STALE`. |
| `P_NO_FRESH_OBSERVATION` / `P_FRESH_OBSERVATION`, `T_OBSERVATION_GOES_STALE` | Whether a fresh observation is published. Absent and older than `HOSTED_DRAFT_PUMP_FRESH_MS` read the same (`STALE` displaces every other state in `deriveState`). |
| `P_HEALTH_UNPROVEN` / `P_STEADY_STATE`, `T_RECONCILE_NEXT_RUN`, `T_RECONCILED_RUN`, `T_RECONCILED_RUN_AFTER_STALE` | #80's rule, not code: a later run reconciled independently of its own receipt proves steady state, and steady-state runs keep producing observations on the normal path. In code a steady-state run would seal through the same `observeTransition`; the net tells the two apart only by the proof token. |
| `P_STEADY_STATE_PROOF` | The capability that rule needs. It has no producer and only read arcs, so it is a premise, not state: 0 in `asShipped` (the reading above), 1 in `asSpecified`. |
| `P_SEED_UNRETIRED` / `P_SEED_RETIRED`, `T_RETIRE_SEED` | #80's Retirement Receipt, allowed only after steady state. No code emits one. |
| `T_RUN_PUMP_ON_SEED` (`seededGatedControl` only) | #80's seed rule on the gated control, not code: the durable seed admits a run while no observation is fresh, read and never spent by running. It stands for the shipped fact that a scheduled run needs no observation at all (`runHostedDraftIntake`'s inputs above), and it stops matching that fact once `T_RETIRE_SEED` consumes the seed. |

`reversible: fails` in `asShipped` and `asSpecified` is a property of this model, not of the pump:
the net counts the first seed as a durable fact, while the code keeps no record that would stop
"first observation" happening again after an artifact expires.

Not modelled: a failed intake (non-zero exit, no receipt). A failure transition would let the
schedule fire and fail forever, which removes every dead marking and so hides the gated net's
bootstrap deadlock from a dead-marking analysis; reading that needs a progress notion (liveness of
`T_RUN_PUMP`), which this tracer does not add.

## How a reading is decided

`readBootstrapAnalysis(net, analysis)` in `src/bootstrap-deadlock.mjs`:

1. The analysis must name the net's content revision. The runner hands IX `ixNetDocument(net)`, the
   net named by its revision, so an analysis of an edited net is refused (`AnalysisNetMismatch`)
   whatever its human label.
2. `unknown` is `UNDECIDED`. `holds` is `NO_DEADLOCK`, and `holds` from a truncated enumeration is
   refused (`AnalysisInvalid`).
3. Each dead marking IX lists is classified at that marking. A transition *produces* a place when it
   strictly adds tokens to it (a read arc produces nothing), and is *short* of a place holding fewer
   tokens than its arc needs. The circular set is the largest set of short places and blocked
   transitions such that:
   - every member transition is short only of member places;
   - every member place is produced by some member transition, and every transition that produces
     it, member or not, is short of some member place.

   The reader finds it by starting from every short place and blocked transition and dropping,
   until nothing changes, whatever breaks a rule. The marking is circular when the set is not empty.
   For each member the reader reports the shortest cycle `[transition, ..., missing place,
   transition]` that stays inside the set; ties go to transitions missing fewer places, then to ids.
4. The first circular dead marking makes the reading `BOOTSTRAP_DEADLOCK`, at `m0` or after a
   firing: #80 asks about the currently admissible transitions. A longer list could not undo that.
5. Otherwise, if IX found more dead markings than it lists (`deadlock_count` above the listed 8) or
   stopped at its budget, an unlisted or unexplored dead marking could be circular, and the reading
   is `UNDECIDED`. Only when every dead marking was classified is a dead `m0`
   `MISSING_PREREQUISITE` and any other dead marking `REACHABLE_DEADLOCK`. Every reading carries
   `deadlockCount` (what IX found) and `classifiedDeadlocks` (what was read).

Why these rules. The second rule makes the member places a *siphon*: every transition that puts
tokens into them first takes tokens from them. A siphon short at a marking stays short whatever
else fires, so no transition outside the set is a way in, even if every other missing fact were
supplied. Dead markings and siphons are the classical pair (at a dead marking of an ordinary net
the empty places form a siphon). A siphon alone is not enough here, because a place nothing
produces is a siphon by itself, and a missing approval is not a circular prerequisite. The first
rule, with "produced by some member", keeps only a siphon that a seed on its own places restarts:
every member is blocked only by facts other members would produce, so the set holds a cycle.

What the rules decide, pinned by recorded probe nets in `tests/bootstrap-deadlock.test.mjs`:

- **A loop behind a missing approval is not circular, whichever way it re-enters.** In
  `retryLoopBehindApproval` the loop `T_FAIL → P_FAILED → T_RETRY → P_RUNNING` re-enters
  `P_RUNNING` through its own transition, but `T_START` also produces `P_RUNNING` and lacks only
  the approval: a way in. The reading is `MISSING_PREREQUISITE`. The earlier rule, which kept a
  place when *any* producer was a member, read it `BOOTSTRAP_DEADLOCK`.
- **The gated control stays circular, for a reason in the net.** `runGatedOnObservation`'s fresh
  observation also has a producer outside the set, `T_RECONCILED_RUN_AFTER_STALE`. It is not a way
  in: besides the proof it needs a receipt, which only a gated run makes. With the proof alone
  supplied it still could not fire; `T_START` with the approval could.
- **A cycle whose entry also needs a place nothing produces is not circular**
  (`cyclePlusUnproducible`): no seed on the cycle admits it.
- **A retired seed closes a way in** (`seededGatedControlWithProof`, above), so that dead marking is
  `REACHABLE_DEADLOCK`.
- **A circular component anywhere decides the label.** `blockerPlusUnrelatedLoop` is a work
  transition lacking an approval next to a disconnected empty loop `X → TX → Y → TY → X`. The loop is
  a circular prerequisite with no admissible transition, so the reading is `BOOTSTRAP_DEADLOCK`. The
  label says a circular blockage exists at the marking, not that it is the only one; the rows with
  `cycle: null` (`T_WORK` missing `P_APPROVAL`) say what else is blocked.
- **A partial list does not fail open.** `hiddenBehindEight` has eight plain dead ends before a
  circular dead marking. IX reports `deadlock_count: 9` and lists 8, none circular, so the reading
  is `UNDECIDED` with `classifiedDeadlocks: 8` and `deadlockCount: 9`. `ix_petri_analyze` fixes the
  list at 8 and takes no argument to raise it, so this reader cannot ask for more today.

Markings are read from IX's structured `tokens` (`[place id, tokens]` pairs), never from the
`marking` string, which IX renders from free-text labels.

## How the analysis reaches Gaia

Gaia computes no reachability for this. `src/drain-petri-net.mjs` has `checkReachability`, but over
its own drain net definitions (step/resource kinds, receptivities treated as free, a proper
completion notion) and it refuses past its bound rather than returning shortest witnesses, liveness,
a boundedness witness or reversibility. Issue #100's grooming asks to avoid a duplicate Petri
implementation, and ADR issue #107 names a DuckDB extension behind a port as option (b), so this
tracer consumes IX (`ix-petri`) through that port instead of writing a second enumerator:

```
src/bootstrap-deadlock.mjs   pure: nets, content revision, reading      (imports node:crypto only)
src/duckdb-ix-petri.mjs      adapter: LOAD ix.duckdb_extension; SELECT ix_petri_analyze(net, max_states)
scripts/bootstrap-deadlock.mjs  runner: prints the analysis document
```

This does not decide #107. `drain-petri-net.mjs` is untouched.

## Evidence classes, stated plainly

- **Recorded.** `tests/fixtures/bootstrap-deadlock/hosted-draft-pump.json` was produced by the runner
  against an `ix.duckdb_extension` built from GuitarAlchemist/ix#340 at commit `05d2872`
  (`pwsh crates/ix-duck-ext/build.ps1 -SmokeTest`, DuckDB v1.5.3, windows_amd64, sha256
  `1caf5e42b4a9ab078e46eab801a3655860dbb5a5b95666011f39ee91b2c146ce`), and `probe-nets.json` beside
  it by the same runner over the probe nets in `probe-nets.mjs`. Tests read both in CI and re-derive
  every reading with today's core. Each analysis names the content revision of its net, so editing
  a net without re-recording fails the suite.
- **Live.** The last test in `tests/bootstrap-deadlock.test.mjs` re-runs both analyses through
  `@duckdb/node-api` and the extension and requires the recorded bytes. It skips with
  `IxExtensionUnconfigured` or `DuckDbClientAbsent` — which is every CI run today, because CI installs
  no optional client and no IX release up to v0.5.0 carries `ix_petri_analyze` (the adapter refuses
  that release with `IxPetriFunctionAbsent`). `GAIA_REQUIRE_IX_PETRI=1` turns both skips into failures.

`GAIA_IX_DUCKDB_EXTENSION` must name a file called `ix.duckdb_extension`. DuckDB derives the
extension's entry point from the file stem, so a renamed copy fails with `IxExtensionLoadFailed`,
which carries DuckDB's own message (`did not contain function "<stem>_init_c_api"`).

Re-record after changing a net:

```
node scripts/bootstrap-deadlock.mjs --extension <dir>/ix.duckdb_extension > tests/fixtures/bootstrap-deadlock/hosted-draft-pump.json
node --input-type=module -e "import { runBootstrapDeadlock } from './scripts/bootstrap-deadlock.mjs'; import { PROBE_NETS } from './tests/fixtures/bootstrap-deadlock/probe-nets.mjs'; process.stdout.write(JSON.stringify(await runBootstrapDeadlock({ extensionFile: process.argv[1], nets: PROBE_NETS }), null, 2) + '\n');" <dir>/ix.duckdb_extension > tests/fixtures/bootstrap-deadlock/probe-nets.json
GAIA_REQUIRE_IX_PETRI=1 GAIA_IX_DUCKDB_EXTENSION=<dir>/ix.duckdb_extension node --test tests/bootstrap-deadlock.test.mjs
```

## Not done here

- No seed identity, bridge, cutover proof or Retirement Receipt; the tracer shows they are owed,
  and #80's acceptance criteria beyond this diagnosis stay open.
- No typed steady-state proof. The reading above says why intake's recovery reconciliation is
  evidence but not that proof as shipped.
- No derivation of nets from code or from the durable ledger.
- No CI job that installs the client and a released extension; that waits for an IX release carrying
  the function.
