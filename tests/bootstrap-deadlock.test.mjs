/**
 * Issue #80's tracer scenario, checked by IX's Petri-net analysis through the DuckDB extension port.
 *
 * Two kinds of evidence live here, and they are kept apart on purpose:
 *
 * - RECORDED. tests/fixtures/bootstrap-deadlock/hosted-draft-pump.json is the output of
 *   `node scripts/bootstrap-deadlock.mjs` against an `ix.duckdb_extension` built from
 *   GuitarAlchemist/ix#340 at commit 05d2872 (`pwsh crates/ix-duck-ext/build.ps1 -SmokeTest`), and
 *   probe-nets.json beside it is the same runner over the probe nets in probe-nets.mjs. The
 *   recorded tests run everywhere, including CI, and they are bound to the nets by content
 *   revision: IX is handed each net named by its revision, so editing a net without re-recording
 *   fails them rather than letting them keep asserting a verdict about a net that no longer exists.
 * - LIVE. The last test re-runs the analysis through the real client and extension and requires
 *   the recorded document byte for byte. It needs `@duckdb/node-api` and an extension that carries
 *   `ix_petri_analyze`, named by GAIA_IX_DUCKDB_EXTENSION. The file must be called
 *   `ix.duckdb_extension`: DuckDB derives the entry point from the file stem. Without them it skips
 *   with the named reason, which is what happens in CI today. GAIA_REQUIRE_IX_PETRI=1 turns that
 *   skip into a failure, so a run that is meant to exercise the port cannot go green by doing
 *   nothing.
 *
 * No released IX extension (through v0.5.0) carries the function yet, so the live test is a
 * developer-machine check until one does.
 *
 * Every model assertion below is a property of the nets, which are read off the code by hand
 * (docs/bootstrap-deadlock.md). None of them is a binding to the pump's behaviour.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BOOTSTRAP_READINGS, BootstrapDeadlockError, CLAIMED_PREREQUISITE_ARCS, HOSTED_DRAFT_PUMP_BOOTSTRAP_NETS,
  SEED_ADMITS_RUN, ixNetDocument, netRevision, readBootstrapAnalysis,
} from '../src/bootstrap-deadlock.mjs';
import { IX_PETRI_STATEMENTS, IxPetriDuckDbError, analyzeNetsWithIxPetri } from '../src/duckdb-ix-petri.mjs';
import { runBootstrapDeadlock } from '../scripts/bootstrap-deadlock.mjs';
import { PROBE_NETS } from './fixtures/bootstrap-deadlock/probe-nets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RECORDED_FILE = join(here, 'fixtures', 'bootstrap-deadlock', 'hosted-draft-pump.json');
const RECORDED = JSON.parse(readFileSync(RECORDED_FILE, 'utf8'));
const PROBED_FILE = join(here, 'fixtures', 'bootstrap-deadlock', 'probe-nets.json');
const PROBED = JSON.parse(readFileSync(PROBED_FILE, 'utf8'));
const NETS = HOSTED_DRAFT_PUMP_BOOTSTRAP_NETS;
/** The recorded analysis, with its reading re-derived by today's core rather than read back. */
const recorded = (key) => {
  const { analysis } = RECORDED.nets.find((entry) => entry.key === key);
  return { analysis, reading: readBootstrapAnalysis(NETS[key], analysis) };
};
/** The most tokens IX saw in `place` over the exhaustive enumeration. */
const maxTokens = (analysis, place) => {
  assert.equal(analysis.truncated, false, 'a per-place maximum only bounds an exhaustive run');
  assert.equal(analysis.bounded.verdict, 'holds');
  return Object.fromEntries(analysis.bounded.detail.per_place)[place];
};

const arcKey = ({ from, to }) => `${from}->${to}`;

test('the recorded analyses describe exactly the nets declared today, by revision', () => {
  assert.deepEqual(RECORDED.nets.map(({ key }) => key), Object.keys(NETS));
  for (const entry of RECORDED.nets) {
    assert.equal(entry.netRevision, netRevision(NETS[entry.key]), `${entry.key}: re-record after editing the net`);
    assert.equal(entry.analysis.net, entry.netRevision, `${entry.key}: IX was handed the net by revision`);
    assert.deepEqual(entry.reading, readBootstrapAnalysis(NETS[entry.key], entry.analysis));
  }
});

// `P_STEADY_STATE_PROOF` has no producer, so 0 there disables the reconciled path by construction:
// "cannot retire" below restates the modelling premise that no code records a proof, and IX only
// confirms its consequences (which transitions and places that premise leaves unreachable).
test('as shipped, with no steady-state proof recorded: the receipt seed is the only observation producer, re-seeds after STALE, and cannot retire', () => {
  const { analysis, reading } = recorded('asShipped');
  assert.equal(reading.reading, 'NO_DEADLOCK');
  assert.deepEqual(analysis.quasi_live, {
    verdict: 'fails',
    detail: ['T_RECONCILED_RUN', 'T_RECONCILED_RUN_AFTER_STALE', 'T_RECONCILE_NEXT_RUN', 'T_RETIRE_SEED'],
  }, 'no steady-state proof and no Retirement Receipt is reachable');
  assert.equal(maxTokens(analysis, 'P_SEED_UNRETIRED'), 1, 'the first run installs the receipt seed');
  assert.equal(maxTokens(analysis, 'P_STEADY_STATE'), 0);
  assert.equal(maxTokens(analysis, 'P_SEED_RETIRED'), 0);
  assert.equal(analysis.live.verdict, 'fails');
  for (const recurring of ['T_OBSERVATION_GOES_STALE', 'T_RESEED_AFTER_STALE', 'T_RUN_PUMP']) {
    assert.ok(!analysis.live.detail.includes(recurring), `${recurring} stays live: staleness and re-seeding can always recur`);
  }
});

test('as specified: a steady-state proof makes cutover and retirement reachable, then only the normal path runs', () => {
  const { analysis, reading } = recorded('asSpecified');
  assert.equal(reading.reading, 'NO_DEADLOCK');
  assert.deepEqual(analysis.quasi_live, { verdict: 'holds', detail: [] });
  assert.equal(maxTokens(analysis, 'P_STEADY_STATE'), 1);
  assert.equal(maxTokens(analysis, 'P_SEED_RETIRED'), 1);
  assert.deepEqual(analysis.live, {
    verdict: 'fails',
    detail: ['T_RECONCILE_NEXT_RUN', 'T_RESEAL_FROM_RECEIPT', 'T_RESEED_AFTER_STALE', 'T_RETIRE_SEED', 'T_SEED_FIRST_OBSERVATION'],
  }, 'once retired, the seed path is dead and a stale observation recovers through a reconciled run');
});

test('as shipped and as specified differ in exactly one initial token: the steady-state proof', () => {
  const { asShipped, asSpecified } = NETS;
  assert.deepEqual(asSpecified.arcs, asShipped.arcs);
  assert.deepEqual(asSpecified.transitions, asShipped.transitions);
  const differing = asShipped.places.filter((place, index) => place.tokens !== asSpecified.places[index].tokens);
  assert.deepEqual(differing.map(({ id }) => id), ['P_STEADY_STATE_PROOF']);
});

test('a run gated on a fresh observation is a bootstrap deadlock: dead at the initial marking, on a prerequisite cycle', () => {
  const { analysis, reading } = recorded('runGatedOnObservation');
  assert.equal(reading.reading, 'BOOTSTRAP_DEADLOCK');
  assert.equal(analysis.states, 1, 'nothing fires, so the initial marking is the whole state space');
  assert.deepEqual(reading.witness, []);
  assert.deepEqual(reading.marking, {
    P_HEALTH_UNPROVEN: 1, P_NO_FRESH_OBSERVATION: 1, P_NO_SEED: 1, P_OBSERVATION_SCHEMA: 1, P_TICK_DUE: 1,
  }, 'the schema and the tick exist; they are not enough');
  const blocked = Object.fromEntries(reading.blocked.map((entry) => [entry.transition, entry]));
  assert.deepEqual(blocked.T_RUN_PUMP, {
    transition: 'T_RUN_PUMP',
    missing: ['P_FRESH_OBSERVATION'],
    cycle: ['T_RUN_PUMP', 'P_INTAKE_RECEIPT', 'T_SEED_FIRST_OBSERVATION', 'P_FRESH_OBSERVATION', 'T_RUN_PUMP'],
  }, 'the smallest cycle through the first seal, the transition missing only the cycle\'s own fact');
  assert.deepEqual(blocked.T_SEED_FIRST_OBSERVATION, {
    transition: 'T_SEED_FIRST_OBSERVATION',
    missing: ['P_INTAKE_RECEIPT'],
    cycle: ['T_SEED_FIRST_OBSERVATION', 'P_FRESH_OBSERVATION', 'T_RUN_PUMP', 'P_INTAKE_RECEIPT', 'T_SEED_FIRST_OBSERVATION'],
  });
  // The proof path is a second producer of the fresh observation, but not a way in: besides the
  // proof it needs a receipt, which only a gated run makes. That is what keeps the set circular
  // under the siphon rule, where retryLoopBehindApproval's T_START, lacking only an approval, is not.
  assert.deepEqual(blocked.T_RECONCILED_RUN_AFTER_STALE.missing, ['P_INTAKE_RECEIPT', 'P_STEADY_STATE', 'P_STEADY_STATE_PROOF']);
  const needsProof = ['T_RECONCILED_RUN', 'T_RECONCILED_RUN_AFTER_STALE', 'T_RECONCILE_NEXT_RUN', 'T_RETIRE_SEED'];
  for (const transition of needsProof) {
    assert.equal(blocked[transition].cycle, null, `${transition} waits on the steady-state proof nothing produces, not on the cycle`);
    for (const { cycle } of reading.blocked) assert.ok(!(cycle ?? []).includes(transition), `no explanation routes through ${transition}`);
  }
});

test('the seeded gated control is not labelled deadlocked: while unretired, the durable seed keeps a run admissible after STALE', () => {
  const { analysis, reading } = recorded('seededGatedControl');
  assert.equal(reading.reading, 'NO_DEADLOCK');
  assert.equal(analysis.truncated, false);
  assert.ok(!analysis.quasi_live.detail.includes('T_RUN_PUMP_ON_SEED'), 'the seed admits a run');
  for (const recurring of ['T_OBSERVATION_GOES_STALE', 'T_RUN_PUMP_ON_SEED', 'T_RESEED_AFTER_STALE', 'T_RUN_PUMP']) {
    assert.ok(!analysis.live.detail.includes(recurring), `${recurring} stays live: STALE never strands the gated run`);
  }
  assert.equal(maxTokens(analysis, 'P_NO_FRESH_OBSERVATION'), 1, 'the observation does go stale');
});

test('an acyclic net dead at its initial marking is refused as a bootstrap deadlock', () => {
  const { reading } = recorded('acyclicControl');
  assert.equal(reading.reading, 'MISSING_PREREQUISITE');
  assert.deepEqual(reading.blocked, [{ transition: 'T_RUN_PUMP', missing: ['P_DISPATCH_REQUESTED'], cycle: null }]);
});

test('the gated net differs from as shipped only by the prerequisite #80 does not claim, and the seeded one only by the seed', () => {
  const added = (key, base) => {
    const arcs = new Set(NETS[key].arcs.map(arcKey));
    const baseArcs = new Set(NETS[base].arcs.map(arcKey));
    assert.deepEqual([...baseArcs].filter((arc) => !arcs.has(arc)), [], `${key} keeps every ${base} arc`);
    return [...arcs].filter((arc) => !baseArcs.has(arc)).sort();
  };
  const keys = (arcs) => arcs.map(([from, to]) => `${from}->${to}`).sort();
  assert.deepEqual(added('runGatedOnObservation', 'asShipped'), keys(CLAIMED_PREREQUISITE_ARCS));
  assert.deepEqual(NETS.runGatedOnObservation.places, NETS.asShipped.places);
  assert.deepEqual(NETS.runGatedOnObservation.transitions, NETS.asShipped.transitions);

  assert.deepEqual(added('seededGatedControl', 'runGatedOnObservation'), keys(SEED_ADMITS_RUN.arcs));
  assert.deepEqual(NETS.seededGatedControl.transitions.map(({ id }) => id),
    [...NETS.runGatedOnObservation.transitions.map(({ id }) => id), SEED_ADMITS_RUN.transition[0]]);
  const seedArcs = new Set(keys(SEED_ADMITS_RUN.arcs));
  for (const place of ['P_SEED_UNRETIRED', 'P_NO_FRESH_OBSERVATION']) {
    assert.ok(seedArcs.has(`${place}->T_RUN_PUMP_ON_SEED`) && seedArcs.has(`T_RUN_PUMP_ON_SEED->${place}`), `${place} is read, never spent`);
  }
  assert.ok(Object.isFrozen(NETS.asShipped.arcs[0]));
});

// Synthetic documents: the reader's contract on shapes no recorded net produces.
test('readBootstrapAnalysis separates a reachable deadlock and an undecided enumeration from a bootstrap deadlock', () => {
  const net = NETS.asShipped;
  const base = { net: netRevision(net), states: 3, truncated: false };
  const dead = { verdict: 'fails', detail: [{ state: 2, marking: 'x=1', tokens: [['P_IDLE', 1]], witness: ['T_RUN_PUMP'] }] };
  const reachable = readBootstrapAnalysis(net, { ...base, deadlock_free: dead, deadlock_count: 1 });
  assert.equal(reachable.reading, 'REACHABLE_DEADLOCK');
  assert.deepEqual(reachable.witness, ['T_RUN_PUMP']);
  assert.deepEqual(reachable.marking, { P_IDLE: 1 });
  const undecided = readBootstrapAnalysis(net, { ...base, truncated: true, deadlock_free: { verdict: 'unknown', detail: { reason: 'budget' } } });
  assert.equal(undecided.reading, 'UNDECIDED');
  const cutShort = readBootstrapAnalysis(net, { ...base, truncated: true, deadlock_free: dead, deadlock_count: 1 });
  assert.equal(cutShort.reading, 'UNDECIDED', 'an unexplored dead marking could be circular');
  assert.deepEqual([...BOOTSTRAP_READINGS].sort(), [
    'BOOTSTRAP_DEADLOCK', 'MISSING_PREREQUISITE', 'NO_DEADLOCK', 'REACHABLE_DEADLOCK', 'UNDECIDED',
  ]);
  assert.equal(ixNetDocument(net).name, netRevision(net));
});

/**
 * Small nets from the re-reviews (tests/fixtures/bootstrap-deadlock/probe-nets.mjs), read from the
 * analyses the same extension recorded for them in probe-nets.json: every `states`, `state`,
 * `deadlock_count`, `tokens` and `witness` below is one IX returned for that exact net.
 */
const probe = (key) => {
  const { analysis } = PROBED.nets.find((entry) => entry.key === key);
  return { analysis, reading: readBootstrapAnalysis(PROBE_NETS[key], analysis) };
};
const cycles = (reading) => Object.fromEntries(reading.blocked.map(({ transition, cycle }) => [transition, cycle]));

test('the recorded probe analyses describe exactly the probe nets declared today, by revision', () => {
  assert.equal(PROBED.maxStates, RECORDED.maxStates);
  assert.deepEqual(PROBED.nets.map(({ key }) => key), Object.keys(PROBE_NETS));
  for (const entry of PROBED.nets) {
    assert.equal(entry.netRevision, netRevision(PROBE_NETS[entry.key]), `${entry.key}: re-record after editing the net`);
    assert.equal(entry.analysis.net, entry.netRevision);
    assert.deepEqual(entry.reading, readBootstrapAnalysis(PROBE_NETS[entry.key], entry.analysis));
  }
});

test('a loop downstream of an unobtainable prerequisite is not a bootstrap deadlock, whichever transition it re-enters through', () => {
  const approval = probe('approvalWithWorkLoop');
  assert.equal(approval.analysis.states, 1);
  assert.equal(approval.reading.reading, 'MISSING_PREREQUISITE');
  assert.deepEqual(cycles(approval.reading), { T_RESET: null, T_WORK: null }, 'T_RESET waits on T_WORK, which waits on nothing the net makes');

  // T_START, the way into P_RUNNING, lacks only the approval. The loop re-enters P_RUNNING through
  // its own T_RETRY, but a place with a producer short only of facts outside the loop has a way in.
  const retry = probe('retryLoopBehindApproval');
  assert.equal(retry.reading.reading, 'MISSING_PREREQUISITE');
  assert.deepEqual(cycles(retry.reading), { T_FAIL: null, T_FINISH: null, T_RETRY: null, T_START: null });
  assert.deepEqual(retry.reading.blocked.find(({ transition }) => transition === 'T_START').missing, ['P_APPROVAL']);

  const unproducible = probe('cyclePlusUnproducible');
  assert.equal(unproducible.reading.reading, 'MISSING_PREREQUISITE', 'no seed on the cycle admits T, which also needs B');

  const later = probe('loopAfterWedge');
  assert.equal(later.analysis.states, 2);
  assert.equal(later.reading.reading, 'REACHABLE_DEADLOCK');
  assert.deepEqual(later.reading.witness, ['T0']);
  assert.deepEqual(later.reading.blocked, []);
});

test('a prerequisite cycle with no way in is a bootstrap deadlock: at the initial marking, after a firing, over read arcs and one token short', () => {
  const atStart = probe('pureCycle');
  assert.equal(atStart.analysis.states, 1, 'dead at m0 is the whole state space');
  assert.equal(atStart.reading.reading, 'BOOTSTRAP_DEADLOCK');
  assert.deepEqual(cycles(atStart.reading), { T: ['T', 'C', 'U', 'A', 'T'], U: ['U', 'A', 'T', 'C', 'U'] });

  const later = probe('wedgesOnCycleLater');
  assert.equal(later.analysis.states, 2);
  assert.equal(later.analysis.deadlock_free.detail[0].state, 1, 'IX numbers the dead marking after m0');
  assert.equal(later.reading.reading, 'BOOTSTRAP_DEADLOCK', '#80 asks about the currently admissible transitions');
  assert.deepEqual(later.reading.witness, ['T0']);
  assert.deepEqual(cycles(later.reading), { T: ['T', 'C', 'U', 'A', 'T'], T0: null, U: ['U', 'A', 'T', 'C', 'U'] });

  const readArcs = probe('mutualReadArcs');
  assert.equal(readArcs.reading.reading, 'BOOTSTRAP_DEADLOCK', 'a read arc produces nothing; the writes close the cycle');
  const weighted = probe('weightedCycle');
  assert.equal(weighted.reading.reading, 'BOOTSTRAP_DEADLOCK');
  assert.deepEqual(weighted.reading.marking, { A: 1 }, 'one token short of the weight-2 arc');
});

test('a circular component anywhere in a dead marking decides the label, and the other blocked transitions still name what they lack', () => {
  const { reading } = probe('blockerPlusUnrelatedLoop');
  assert.equal(reading.reading, 'BOOTSTRAP_DEADLOCK', 'TX and TY are blocked only by each other');
  assert.deepEqual(reading.blocked, [
    { transition: 'TX', missing: ['X'], cycle: ['TX', 'Y', 'TY', 'X', 'TX'] },
    { transition: 'TY', missing: ['Y'], cycle: ['TY', 'X', 'TX', 'Y', 'TY'] },
    { transition: 'T_RESET', missing: ['P_DONE'], cycle: null },
    { transition: 'T_WORK', missing: ['P_APPROVAL'], cycle: null },
  ]);
});

test('when IX lists only some dead markings and none of them is circular, the reading is UNDECIDED and says how many it classified', () => {
  const { analysis, reading } = probe('hiddenBehindEight');
  assert.deepEqual([analysis.states, analysis.deadlock_count, analysis.deadlock_free.detail.length], [10, 9, 8]);
  assert.deepEqual(analysis.deadlock_free.detail.map(({ witness }) => witness), [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [`T_A${i}`]),
    'the eight plain dead ends come first; the circular one, after T_Z, is not listed');
  assert.equal(reading.reading, 'UNDECIDED');
  assert.deepEqual([reading.classifiedDeadlocks, reading.deadlockCount], [8, 9]);
  assert.deepEqual([reading.marking, reading.witness, reading.blocked], [null, null, []]);
  for (const key of Object.keys(PROBE_NETS).filter((name) => name !== 'hiddenBehindEight')) {
    const { analysis: complete, reading: whole } = probe(key);
    assert.equal(whole.classifiedDeadlocks, complete.deadlock_free.detail.length);
    assert.equal(whole.deadlockCount, complete.deadlock_count, `${key}: every other probe lists every dead marking`);
  }
});

test('the seeded gated control is deadlock-free only while its seed is unretired: once a proof lets it retire, STALE strands the gated run', () => {
  const { analysis, reading } = probe('seededGatedControlWithProof');
  assert.equal(analysis.truncated, false);
  assert.equal(analysis.states, 18);
  // Not BOOTSTRAP_DEADLOCK: the seed run is a way into the cycle, closed by the retired seed, so
  // what strands the run is the retirement, not the cycle alone.
  assert.equal(reading.reading, 'REACHABLE_DEADLOCK');
  assert.deepEqual(reading.witness, ['T_RUN_PUMP', 'T_RECONCILE_NEXT_RUN', 'T_OBSERVATION_GOES_STALE', 'T_RETIRE_SEED', 'T_SCHEDULE_TICK']);
  assert.deepEqual(reading.marking, {
    P_NO_FRESH_OBSERVATION: 1, P_OBSERVATION_SCHEMA: 1, P_SEED_RETIRED: 1, P_STEADY_STATE: 1, P_STEADY_STATE_PROOF: 1, P_TICK_DUE: 1,
  }, 'retired, stale, due: the gated run needs a fresh observation, the seed run an unretired seed, the reconciled run a receipt');
  assert.equal(recorded('seededGatedControl').reading.reading, 'NO_DEADLOCK', 'without the proof the seed never retires');
});

test('readBootstrapAnalysis fails closed on an unrecognised verdict, an empty or prose-only failure, or another revision', () => {
  const net = NETS.runGatedOnObservation;
  const base = { net: netRevision(net), states: 1, truncated: false };
  const refuses = (analysis, code) => assert.throws(
    () => readBootstrapAnalysis(net, analysis),
    (error) => error instanceof BootstrapDeadlockError && error.code === code,
  );
  refuses({ ...base, deadlock_free: { verdict: 'mostly_holds', detail: [] } }, 'AnalysisInvalid');
  refuses({ ...base, deadlock_free: { verdict: 'fails', detail: [] } }, 'AnalysisInvalid');
  refuses({ ...base, deadlock_free: { verdict: 'fails', detail: [{ state: 0, marking: 'x=1', witness: [] }] } }, 'AnalysisInvalid');
  const listed = { verdict: 'fails', detail: [{ state: 0, marking: '', tokens: [], witness: [] }] };
  refuses({ ...base, deadlock_free: listed }, 'AnalysisInvalid');
  refuses({ ...base, deadlock_free: listed, deadlock_count: 0 }, 'AnalysisInvalid');
  refuses({ ...base, truncated: 'no', deadlock_free: { verdict: 'holds', detail: [] } }, 'AnalysisInvalid');
  refuses({ ...base, truncated: true, deadlock_free: { verdict: 'holds', detail: [] } }, 'AnalysisInvalid');
  refuses({ ...base, net: net.name, deadlock_free: { verdict: 'holds', detail: [] } }, 'AnalysisNetMismatch');
  const edited = { ...net, places: net.places.map((place) => ({ ...place, tokens: 0 })) };
  assert.equal(edited.name, net.name, 'an edit that keeps the name');
  assert.throws(
    () => readBootstrapAnalysis(edited, { ...base, deadlock_free: { verdict: 'holds', detail: [] } }),
    (error) => error.code === 'AnalysisNetMismatch',
  );
});

/** A client double speaking the three calls the Adapter makes. */
function fakeApi({ loadFails = false, functionCount = 1, analysis = () => ({}) } = {}) {
  const calls = { sql: [], closed: 0, config: null };
  const connection = {
    async run(sql) {
      calls.sql.push(sql);
      if (loadFails) throw new Error('not an extension');
    },
    async runAndReadAll(sql, params) {
      calls.sql.push(sql);
      const rows = sql === IX_PETRI_STATEMENTS.functionPresent
        ? [{ n: BigInt(functionCount) }]
        : [{ analysis: JSON.stringify(analysis(JSON.parse(params[0]), params[1])) }];
      return { getRowObjects: () => rows };
    },
    closeSync() { calls.closed += 1; },
  };
  const api = {
    DuckDBInstance: {
      async create(file, config) {
        calls.config = { file, config };
        return { connect: async () => connection, closeSync() { calls.closed += 1; } };
      },
    },
  };
  return { calls, loadApi: async () => api };
}

test('the Adapter names every absence instead of returning an empty result, and keeps DuckDB\'s load error', async () => {
  const request = { nets: [NETS.asShipped], maxStates: 10, extensionFile: 'ix.duckdb_extension' };
  const refuses = async (options, code, message = /./u) => assert.rejects(
    analyzeNetsWithIxPetri(request, options),
    (error) => error instanceof IxPetriDuckDbError && error.code === code && message.test(error.message),
  );
  await refuses({ loadApi: async () => { throw new Error('module absent'); } }, 'DuckDbClientAbsent');
  const unloadable = fakeApi({ loadFails: true });
  await refuses({ loadApi: unloadable.loadApi }, 'IxExtensionLoadFailed', /file stem must be `ix`.*not an extension/u);
  assert.equal(unloadable.calls.closed, 2, 'the throwaway instance is closed on refusal');
  await refuses({ loadApi: fakeApi({ functionCount: 0 }).loadApi }, 'IxPetriFunctionAbsent');
  await assert.rejects(analyzeNetsWithIxPetri({ ...request, maxStates: 0 }), (error) => error.code === 'MaxStatesInvalid');
  await assert.rejects(analyzeNetsWithIxPetri({ ...request, extensionFile: '' }), (error) => error.code === 'IxExtensionUnnamed');
});

test('the Adapter loads the named extension into an in-memory store and returns one document per net in order', async () => {
  const fake = fakeApi({ analysis: (net, maxStates) => ({ net: net.name, maxStates }) });
  const result = await analyzeNetsWithIxPetri(
    { nets: [NETS.asShipped, NETS.asSpecified], maxStates: 7, extensionFile: 'dir/it\'s.duckdb_extension' },
    { loadApi: fake.loadApi },
  );
  assert.deepEqual(result.analyses.map(({ net, analysis }) => [net, analysis.maxStates]), [
    [NETS.asShipped.name, 7], [NETS.asSpecified.name, 7],
  ]);
  assert.deepEqual(fake.calls.config, { file: ':memory:', config: { allow_unsigned_extensions: 'true' } });
  assert.match(fake.calls.sql[0], /^LOAD '.*it''s\.duckdb_extension'$/u, 'the file name is quoted, never spliced raw');
  assert.equal(fake.calls.closed, 2);
});

test('the core imports only a hash, and the Adapter reads no environment, spawns nothing, and opens no database file', () => {
  const core = readFileSync(join(here, '..', 'src', 'bootstrap-deadlock.mjs'), 'utf8');
  const adapter = readFileSync(join(here, '..', 'src', 'duckdb-ix-petri.mjs'), 'utf8');
  assert.deepEqual([...core.matchAll(/^import .* from '([^']+)';$/gmu)].map(([, module]) => module), ['node:crypto']);
  assert.ok(!/duckdb/iu.test(core.replace(/^ \*.*$/gmu, '')), 'the core never speaks to the store');
  for (const [name, source] of [['core', core], ['adapter', adapter]]) {
    assert.ok(!/process\.env\b/u.test(source), `${name}: no environment read`);
    assert.ok(!/node:(?:child_process|net|http|https|fs)/u.test(source), `${name}: no transport or file write`);
    assert.ok(!source.includes('\r'), `${name}: zero CR bytes`);
  }
});

test('live: the IX extension reproduces the recorded analyses, of the pump nets and the probe nets, byte for byte', async (t) => {
  const required = process.env.GAIA_REQUIRE_IX_PETRI === '1';
  const extensionFile = process.env.GAIA_IX_DUCKDB_EXTENSION;
  if (extensionFile === undefined || extensionFile === '') {
    if (required) assert.fail('GAIA_REQUIRE_IX_PETRI=1 but GAIA_IX_DUCKDB_EXTENSION names no extension');
    t.skip('IxExtensionUnconfigured: set GAIA_IX_DUCKDB_EXTENSION to an ix.duckdb_extension carrying ix_petri_analyze');
    return;
  }
  let live;
  try {
    live = await runBootstrapDeadlock({ extensionFile, maxStates: RECORDED.maxStates });
  } catch (error) {
    if (!required && error instanceof IxPetriDuckDbError && error.code === 'DuckDbClientAbsent') {
      t.skip('DuckDbClientAbsent: the optional @duckdb/node-api client is not installed');
      return;
    }
    throw error;
  }
  assert.equal(`${JSON.stringify(live, null, 2)}\n`, readFileSync(RECORDED_FILE, 'utf8'));
  const probed = await runBootstrapDeadlock({ extensionFile, maxStates: PROBED.maxStates, nets: PROBE_NETS });
  assert.equal(`${JSON.stringify(probed, null, 2)}\n`, readFileSync(PROBED_FILE, 'utf8'));
});
