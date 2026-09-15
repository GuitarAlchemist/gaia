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
| `asShipped` — the seam read off the code | `NO_DEADLOCK` | 9 markings, 1-bounded. The first run installs the receipt seed (`P_SEED_UNRETIRED` reaches 1). `T_RECONCILE_NEXT_RUN`, `T_RETIRE_SEED`, `T_RECONCILED_RUN` and `T_RECONCILED_RUN_AFTER_STALE` are enabled in no reachable marking, so `P_STEADY_STATE` and `P_SEED_RETIRED` never hold a token. `T_OBSERVATION_GOES_STALE` and `T_RESEED_AFTER_STALE` stay live: the seed re-fires after every STALE period, forever. |
| `asSpecified` — `asShipped` plus one steady-state proof token | `NO_DEADLOCK` | 21 markings, every transition quasi-live. Steady state and the Retirement Receipt are reachable. `live` fails for exactly the bootstrap transitions (`T_SEED_FIRST_OBSERVATION`, `T_RESEED_AFTER_STALE`, `T_RESEAL_FROM_RECEIPT`, `T_RECONCILE_NEXT_RUN`, `T_RETIRE_SEED`): after cutover the seed path is dead and a stale observation recovers through a reconciled run. |
| `runGatedOnObservation` — a run that needs a fresh observation (cyclic control) | `BOOTSTRAP_DEADLOCK` | 1 marking; dead at `m0` with the empty witness. `T_RUN_PUMP` is missing `P_FRESH_OBSERVATION`; `T_SEED_FIRST_OBSERVATION` is missing `P_INTAKE_RECEIPT` on the cycle `T_SEED_FIRST_OBSERVATION → P_FRESH_OBSERVATION → T_RUN_PUMP → P_INTAKE_RECEIPT → T_SEED_FIRST_OBSERVATION`. |
| `seededGatedControl` — the gated net with a seed installed | `REACHABLE_DEADLOCK` | 6 markings. Not a bootstrap deadlock (a run is admissible at `m0`), but `T_OBSERVATION_GOES_STALE` alone wedges it: a seed does not stop a gated pump re-deadlocking after one STALE period. |
| `acyclicControl` — a dispatch nobody requests | `MISSING_PREREQUISITE` | Dead at `m0`, and `P_DISPATCH_REQUESTED` has no producer, so there is no cycle. #80 refuses to call this a bootstrap deadlock, and so does the reader. |

What this says about #80's tracer, and no more:

- **The seed exists.** Every hosted run seals its own terminal receipt into the observation
  (`observeTransition` in `scripts/hosted-draft-pump.mjs`). The first such observation is #80's
  receipt seed, so under #80 §6 it owes a stable operation identity, an owner, a scope, an
  expiry or revisit condition, a rollback and a Retirement Receipt, and under #79 it is a
  Maintenance Obligation. Nothing in `src/` or `scripts/` records any of those.
- **Nothing proves steady state, so the seed cannot retire.** No code records a typed steady-state
  proof from a later run. The Control Room derives health per observation instead
  (`ADVANCED`, `REPLAYED` and `EXPECTED_NONE` read `healthy` in
  `src/hosted-draft-pump-observation.mjs`), so the very first receipt-seeded observation can already
  read `healthy`: exactly what #80 says a run must not be considered on its own evidence.
- **The seed is not one-time.** Because every run seals from its receipt and an observation goes
  STALE after 12 h (`HOSTED_DRAFT_PUMP_FRESH_MS`; the uploaded artifact also expires after 14 days),
  the pump re-enters "no fresh observation" routinely and the same receipt path seeds it again.
- **One fact separates the code from #80's rule.** `asShipped` and `asSpecified` have identical arcs
  and differ in one initial token, `P_STEADY_STATE_PROOF`. That is the capability to build, not a
  dependency to delete: this is not a `FALSE_CYCLE`.

Unknown, not decided here: whether the bounded recovery of earlier runs' unsettled records inside
`runHostedDraftIntake` could serve as #80's "next independently reconciled run". Whatever it
establishes, it emits no typed proof that the Control Room or a retirement step could consume, so
the model gives `asShipped` no proof token.

## The model, and the code each part stands for

The model is read off the code by hand. That is an assumption, not a binding: nothing derives these
arcs from the source, and a behavioural change to the pump does not fail these tests.

| Net element | Stands for |
| --- | --- |
| `P_TICK_DUE` (1), `P_IDLE`, `T_SCHEDULE_TICK` | The `schedule: cron '17 */6 * * *'` trigger of `.github/workflows/hosted-draft-intake.yml`. The non-cancelling `gaia-draft-intake-recovery` concurrency group serializes recovery runs, so the next run starts after this one finishes. Only scheduled and dispatched runs get `GAIA_OBSERVATION_PATH`; a labelled issue lane publishes no observation and is not modelled. |
| `P_OBSERVATION_SCHEMA` (1) | `gaia-hosted-draft-pump/1` exists (`src/hosted-draft-pump-observation.mjs`). Contract establishment, not liveness: every seal reads it, and it enables nothing on its own. |
| `T_RUN_PUMP` | `runHostedDraftIntake` in `src/hosted-draft-pump.mjs`. Its inputs are a repository, candidates, a limit and ledger/operation ports. No observation is among them. |
| `P_INTAKE_RECEIPT` | The sealed `GaiaHostedDraftIntakeReceiptV0` that run returns. |
| `T_SEED_FIRST_OBSERVATION`, `T_RESEED_AFTER_STALE`, `T_RESEAL_FROM_RECEIPT` | One code path: `observeTransition` → `produceHostedDraftPumpObservation(receipt)` in `scripts/hosted-draft-pump.mjs`, which never passes `priorObservation`, so `requireMonotonic` compares nothing. The net splits it three ways only to count the first seed (`P_NO_SEED` → `P_SEED_UNRETIRED`), which #80 §6 needs identified; the code keeps no such record. |
| `T_REFUSE_OBSERVATION` | The typed refusal in `observeTransition`: the run still succeeds and publishes nothing, and the absent observation ages into `STALE`. |
| `P_NO_FRESH_OBSERVATION` / `P_FRESH_OBSERVATION`, `T_OBSERVATION_GOES_STALE` | Whether a fresh observation is published. Absent and older than `HOSTED_DRAFT_PUMP_FRESH_MS` read the same (`STALE` displaces every other state in `deriveState`). |
| `P_HEALTH_UNPROVEN` / `P_STEADY_STATE`, `T_RECONCILE_NEXT_RUN`, `T_RECONCILED_RUN`, `T_RECONCILED_RUN_AFTER_STALE` | #80's rule, not code: a later run reconciled independently of its own receipt proves steady state, and steady-state runs keep producing observations on the normal path. |
| `P_STEADY_STATE_PROOF` | The capability that rule needs. 0 in `asShipped` (no code records it), 1 in `asSpecified`. |
| `P_SEED_UNRETIRED` / `P_SEED_RETIRED`, `T_RETIRE_SEED` | #80's Retirement Receipt, allowed only after steady state. No code emits one. |

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
2. `unknown` is `UNDECIDED`; `holds` is `NO_DEADLOCK`.
3. A dead marking with a non-empty witness is `REACHABLE_DEADLOCK`.
4. A dead marking with the empty witness is dead at `m0`. For each transition the reader names the
   pre-set places `m0` leaves short and the shortest prerequisite cycle back through one of them (a
   transition leads to the places it strictly adds tokens to, a place to the transitions that need
   it; ties break by id). Any cycle makes it `BOOTSTRAP_DEADLOCK`; none makes it
   `MISSING_PREREQUISITE`.

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
  against an `ix.duckdb_extension` built from GuitarAlchemist/ix#340 at commit `f09f6a5`
  (`pwsh crates/ix-duck-ext/build.ps1 -SmokeTest`, DuckDB v1.5.3, windows_amd64). Tests read it in
  CI and re-derive every reading with today's core. Each analysis names the content revision of its
  net, so editing a net without re-recording fails the suite.
- **Live.** The last test in `tests/bootstrap-deadlock.test.mjs` re-runs the analysis through
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
GAIA_REQUIRE_IX_PETRI=1 GAIA_IX_DUCKDB_EXTENSION=<dir>/ix.duckdb_extension node --test tests/bootstrap-deadlock.test.mjs
```

## Not done here

- No seed identity, bridge, cutover proof or Retirement Receipt; the tracer shows they are owed,
  and #80's acceptance criteria beyond this diagnosis stay open.
- No decision on whether intake recovery reconciliation can count as the steady-state proof.
- No derivation of nets from code or from the durable ledger.
- No CI job that installs the client and a released extension; that waits for an IX release carrying
  the function.
