# Bootstrap deadlock tracer — issue #80's hosted Draft pump cycle as Petri nets

Status: diagnostic tracer for issue #80's next slice ("model one observed cycle and show whether an
already admissible first transition exists"). It installs no seed, starts no daemon, grants no
authority and changes no pump behaviour. It reads code, declares nets, and reads an analysis.

## Question

Issue #80's tracer scenario: *the hosted Draft pump needs a Control Room observation, but the first
observation can only be produced by a pump run.* Is that a Bootstrap Deadlock — "a circular
prerequisite with no currently admissible initial transition" — in the code that ships, or only in
the sentence?

## Answer

| Net | Reading | Evidence (IX `ix_petri_analyze`, exhaustive, 10 000-state budget) |
| --- | --- | --- |
| `asWritten` — the cycle as #80 states it | `BOOTSTRAP_DEADLOCK` | 1 reachable marking; dead at `m0` with the empty witness. `T_RUN_PUMP` is missing `P_OBSERVATION`; every observation transition is missing `P_INTAKE_RECEIPT`. No transition is quasi-live. |
| `asShipped` — the same seam read off the code | `NO_DEADLOCK` | 4 markings, 1-bounded, every transition quasi-live. `T_PRODUCE_FIRST_OBSERVATION` is not live (it fires once) and the net is not reversible: the first observation is a one-way cutover. |
| `seededControl` — `asWritten` plus a modelled first observation | `NO_DEADLOCK` | 2 markings; the seed makes `T_PRODUCE_FIRST_OBSERVATION` unreachable, which is what a seed does. |

The two nets `asWritten` and `asShipped` have identical places, transitions and initial marking and
differ in exactly two arcs: `P_OBSERVATION -> T_RUN_PUMP -> P_OBSERVATION`, the claim that a run
needs an observation. Removing that claim removes the deadlock, and the shipped code does not make
it. In #80's vocabulary this cycle is a **false dependency** (`FALSE_CYCLE`): resolution pattern 1,
"remove a false dependency", already holds, so no seed or bridge is needed for it.

This settles the prose cycle only. It says nothing about #80's generic capability, the capacity
blocker label, or any other cycle.

## The model, and the code each part stands for

The model is read off the code by hand. That is an assumption, not a binding: nothing derives these
arcs from the source, and a behavioural change to the pump does not fail these tests.

| Net element | Stands for |
| --- | --- |
| `P_TICK_DUE` (1) | The `schedule: cron '17 */6 * * *'` trigger of `.github/workflows/hosted-draft-intake.yml`. Only scheduled and dispatched runs get `GAIA_OBSERVATION_PATH`; a labelled issue lane publishes no observation and is not modelled. |
| `P_OBSERVATION_SCHEMA` (1) | `gaia-hosted-draft-pump/1` exists (`src/hosted-draft-pump-observation.mjs`). Contract establishment, not liveness: it enables production but not a run. |
| `T_RUN_PUMP` | `runHostedDraftIntake` in `src/hosted-draft-pump.mjs`. Its inputs are a repository, candidates, a limit and ledger/operation ports. No observation is among them. |
| `P_INTAKE_RECEIPT` | The `GaiaHostedDraftIntakeReceiptV0` that run returns. |
| `T_PRODUCE_FIRST_OBSERVATION` / `T_PRODUCE_NEXT_OBSERVATION` | `produceHostedDraftPumpObservation` in `src/hosted-draft-pump-producer.mjs`. `priorObservation` defaults to `null`, and `requireMonotonic` returns the body unchanged when it is `null`, so the first observation has no observation prerequisite. |
| `T_REFUSE_OBSERVATION` | The typed refusal in `scripts/hosted-draft-pump.mjs`: the run still succeeds and publishes nothing, and the absent observation ages into `STALE`. |
| `P_NO_OBSERVATION` / `P_OBSERVATION` | Complementary places: whether a verified observation has been published. |

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
  against an `ix.duckdb_extension` built from GuitarAlchemist/ix#340 (commit `fa3d18e`). Tests read it in CI and
  re-derive every reading with today's core. Each entry carries the content revision of its net, so
  editing a net without re-recording fails the suite.
- **Live.** The last test in `tests/bootstrap-deadlock.test.mjs` re-runs the analysis through
  `@duckdb/node-api` and the extension and requires the recorded bytes. It skips with
  `IxExtensionUnconfigured` or `DuckDbClientAbsent` — which is every CI run today, because CI installs
  no optional client and no IX release up to v0.5.0 carries `ix_petri_analyze` (the adapter refuses
  that release with `IxPetriFunctionAbsent`). `GAIA_REQUIRE_IX_PETRI=1` turns both skips into failures.

Re-record after changing a net:

```
node scripts/bootstrap-deadlock.mjs --extension <ix.duckdb_extension> > tests/fixtures/bootstrap-deadlock/hosted-draft-pump.json
GAIA_REQUIRE_IX_PETRI=1 GAIA_IX_DUCKDB_EXTENSION=<ix.duckdb_extension> node --test tests/bootstrap-deadlock.test.mjs
```

## Not done here

- No seed, bridge, cutover or retirement receipt; #80's acceptance criteria beyond this diagnosis
  stay open.
- No derivation of nets from code or from the durable ledger.
- No CI job that installs the client and a released extension; that waits for an IX release carrying
  the function.
