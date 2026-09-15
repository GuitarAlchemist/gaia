/**
 * Issue #80's tracer scenario, checked by IX's Petri-net analysis through the DuckDB extension port.
 *
 * Two kinds of evidence live here, and they are kept apart on purpose:
 *
 * - RECORDED. tests/fixtures/bootstrap-deadlock/hosted-draft-pump.json is the output of
 *   `node scripts/bootstrap-deadlock.mjs` against an `ix.duckdb_extension` built from
 *   GuitarAlchemist/ix#340 at commit 725bac4 (`pwsh crates/ix-duck-ext/build.ps1 -SmokeTest`). The
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

const here = dirname(fileURLToPath(import.meta.url));
const RECORDED_FILE = join(here, 'fixtures', 'bootstrap-deadlock', 'hosted-draft-pump.json');
const RECORDED = JSON.parse(readFileSync(RECORDED_FILE, 'utf8'));
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
  const needsProof = ['T_RECONCILED_RUN', 'T_RECONCILED_RUN_AFTER_STALE', 'T_RECONCILE_NEXT_RUN', 'T_RETIRE_SEED'];
  for (const transition of needsProof) {
    assert.equal(blocked[transition].cycle, null, `${transition} waits on the steady-state proof nothing produces, not on the cycle`);
    for (const { cycle } of reading.blocked) assert.ok(!(cycle ?? []).includes(transition), `no explanation routes through ${transition}`);
  }
});

test('the seeded gated control is not labelled deadlocked: the durable seed keeps a run admissible after STALE', () => {
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

test('readBootstrapAnalysis separates a reachable deadlock and an undecided enumeration from a bootstrap deadlock', () => {
  const net = NETS.asShipped;
  const base = { net: netRevision(net), states: 3, truncated: false };
  const reachable = readBootstrapAnalysis(net, {
    ...base, deadlock_free: { verdict: 'fails', detail: [{ state: 2, marking: 'x=1', tokens: [['P_IDLE', 1]], witness: ['T_RUN_PUMP'] }] },
  });
  assert.equal(reachable.reading, 'REACHABLE_DEADLOCK');
  assert.deepEqual(reachable.witness, ['T_RUN_PUMP']);
  assert.deepEqual(reachable.marking, { P_IDLE: 1 });
  const undecided = readBootstrapAnalysis(net, { ...base, truncated: true, deadlock_free: { verdict: 'unknown', detail: { reason: 'budget' } } });
  assert.equal(undecided.reading, 'UNDECIDED');
  assert.deepEqual([...BOOTSTRAP_READINGS].sort(), [
    'BOOTSTRAP_DEADLOCK', 'MISSING_PREREQUISITE', 'NO_DEADLOCK', 'REACHABLE_DEADLOCK', 'UNDECIDED',
  ]);
  assert.equal(ixNetDocument(net).name, netRevision(net));
});

/**
 * Small nets from the re-review, each read from the dead markings IX reports for it. The analyses
 * carry only the fields the reader consumes, with the `tokens` and `witness` an extension built from
 * ix#340 at 725bac4 returned for these exact nets.
 */
const small = (name, places, transitions, arcs) => ({
  name,
  places: places.map(([id, tokens]) => ({ id, tokens })),
  transitions: transitions.map((id) => ({ id })),
  arcs: arcs.map(([from, to]) => ({ from, to })),
});
const readDead = (net, deadlocks) => readBootstrapAnalysis(net, {
  net: netRevision(net), states: deadlocks.length + 1, truncated: false,
  deadlock_free: { verdict: 'fails', detail: deadlocks.map(([tokens, witness], state) => ({ state, marking: '', tokens, witness })) },
});
const cycles = (reading) => Object.fromEntries(reading.blocked.map(({ transition, cycle }) => [transition, cycle]));

test('a loop downstream of an unobtainable prerequisite is not a bootstrap deadlock', () => {
  const approvalWithWorkLoop = small('approval nobody grants, plus a reset loop',
    [['P_APPROVAL', 0], ['P_IDLE', 1], ['P_DONE', 0]], ['T_WORK', 'T_RESET'],
    [['P_APPROVAL', 'T_WORK'], ['P_IDLE', 'T_WORK'], ['T_WORK', 'P_DONE'], ['P_DONE', 'T_RESET'], ['T_RESET', 'P_IDLE']]);
  const reading = readDead(approvalWithWorkLoop, [[[['P_IDLE', 1]], []]]);
  assert.equal(reading.reading, 'MISSING_PREREQUISITE');
  assert.deepEqual(cycles(reading), { T_RESET: null, T_WORK: null }, 'T_RESET waits on T_WORK, which waits on nothing the net makes');

  const cyclePlusUnproducible = small('a cycle whose entry also needs a place nothing produces',
    [['A', 0], ['B', 0], ['C', 0]], ['T', 'U'], [['A', 'T'], ['B', 'T'], ['T', 'C'], ['C', 'U'], ['U', 'A']]);
  assert.equal(readDead(cyclePlusUnproducible, [[[], []]]).reading, 'MISSING_PREREQUISITE', 'no seed on the cycle admits T');
});

test('a pure prerequisite cycle is a bootstrap deadlock at the initial marking and when a later firing wedges on it', () => {
  const pureCycle = small('pure cycle', [['A', 0], ['C', 0]], ['T', 'U'], [['A', 'T'], ['T', 'C'], ['C', 'U'], ['U', 'A']]);
  const atStart = readDead(pureCycle, [[[], []]]);
  assert.equal(atStart.reading, 'BOOTSTRAP_DEADLOCK');
  assert.deepEqual(cycles(atStart), { T: ['T', 'C', 'U', 'A', 'T'], U: ['U', 'A', 'T', 'C', 'U'] });

  const wedgesOnCycleLater = small('one step, then the pure cycle', [['S', 1], ['A', 0], ['C', 0]], ['T0', 'T', 'U'],
    [['S', 'T0'], ['A', 'T'], ['T', 'C'], ['C', 'U'], ['U', 'A']]);
  const later = readDead(wedgesOnCycleLater, [[[], ['T0']]]);
  assert.equal(later.reading, 'BOOTSTRAP_DEADLOCK', '#80 asks about the currently admissible transitions');
  assert.deepEqual(later.witness, ['T0']);
  assert.deepEqual(cycles(later), { T: ['T', 'C', 'U', 'A', 'T'], T0: null, U: ['U', 'A', 'T', 'C', 'U'] });

  const loopAfterWedge = small('one step, then an approval nobody grants', [['S', 1], ['P_APPROVAL', 0], ['P_IDLE', 0], ['P_DONE', 0]],
    ['T0', 'T_WORK', 'T_RESET'],
    [['S', 'T0'], ['T0', 'P_IDLE'], ['P_APPROVAL', 'T_WORK'], ['P_IDLE', 'T_WORK'], ['T_WORK', 'P_DONE'], ['P_DONE', 'T_RESET'], ['T_RESET', 'P_IDLE']]);
  const ordinary = readDead(loopAfterWedge, [[[['P_IDLE', 1]], ['T0']]]);
  assert.equal(ordinary.reading, 'REACHABLE_DEADLOCK');
  assert.deepEqual(ordinary.blocked, []);
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

test('live: the IX extension reproduces the recorded analyses byte for byte', async (t) => {
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
});
