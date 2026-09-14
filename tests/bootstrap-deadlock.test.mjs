/**
 * Issue #80's tracer cycle, checked by IX's Petri-net analysis through the DuckDB extension port.
 *
 * Two kinds of evidence live here, and they are kept apart on purpose:
 *
 * - RECORDED. tests/fixtures/bootstrap-deadlock/hosted-draft-pump.json is the output of
 *   `node scripts/bootstrap-deadlock.mjs` against an `ix.duckdb_extension` built from
 *   GuitarAlchemist/ix#340 (commit fa3d18e). The recorded tests run everywhere, including CI, and they are bound to
 *   the nets by content revision: edit a net without re-recording and they fail, rather than keep
 *   asserting a verdict about a net that no longer exists.
 * - LIVE. The last test re-runs the analysis through the real client and extension and requires
 *   the recorded document byte for byte. It needs `@duckdb/node-api` and an extension that carries
 *   `ix_petri_analyze`, named by GAIA_IX_DUCKDB_EXTENSION. Without them it skips with the named
 *   reason, which is what happens in CI today. GAIA_REQUIRE_IX_PETRI=1 turns that skip into a
 *   failure, so a run that is meant to exercise the port cannot go green by doing nothing.
 *
 * No released IX extension (through v0.5.0) carries the function yet, so the live test is a
 * developer-machine check until one does.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BOOTSTRAP_READINGS, BootstrapDeadlockError, CLAIMED_PREREQUISITE_ARCS, HOSTED_DRAFT_PUMP_BOOTSTRAP_NETS,
  netRevision, readBootstrapAnalysis,
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

const arcKey = ({ from, to }) => `${from}->${to}`;

test('the recorded analyses describe exactly the nets declared today', () => {
  assert.deepEqual(RECORDED.nets.map(({ key }) => key), Object.keys(NETS));
  for (const entry of RECORDED.nets) {
    assert.equal(entry.netRevision, netRevision(NETS[entry.key]), `${entry.key}: re-record after editing the net`);
    assert.deepEqual(entry.reading, readBootstrapAnalysis(NETS[entry.key], entry.analysis));
  }
});

test('the as-written cycle is a bootstrap deadlock: dead at the initial marking with no admissible first transition', () => {
  const { analysis, reading } = recorded('asWritten');
  assert.equal(reading.reading, 'BOOTSTRAP_DEADLOCK');
  assert.deepEqual(reading.witness, []);
  assert.equal(analysis.truncated, false);
  assert.equal(analysis.states, 1, 'nothing fires, so the initial marking is the whole state space');
  assert.deepEqual(reading.blocked, [
    { transition: 'T_PRODUCE_FIRST_OBSERVATION', missing: ['P_INTAKE_RECEIPT'] },
    { transition: 'T_PRODUCE_NEXT_OBSERVATION', missing: ['P_INTAKE_RECEIPT', 'P_OBSERVATION'] },
    { transition: 'T_REFUSE_OBSERVATION', missing: ['P_INTAKE_RECEIPT'] },
    { transition: 'T_RUN_PUMP', missing: ['P_OBSERVATION'] },
  ]);
  assert.match(reading.marking, /scheduled recovery tick due=1/u, 'the schema and the tick exist; they are not enough');
});

test('the as-shipped seam has no deadlock, and its first observation is a one-way cutover', () => {
  const { analysis, reading } = recorded('asShipped');
  assert.equal(reading.reading, 'NO_DEADLOCK');
  assert.equal(analysis.truncated, false);
  assert.equal(analysis.bounded.verdict, 'holds');
  assert.equal(analysis.bounded.detail.k, 1);
  assert.deepEqual(analysis.quasi_live, { verdict: 'holds', detail: [] }, 'every transition, the first observation included, can fire');
  assert.deepEqual(analysis.live, { verdict: 'fails', detail: ['T_PRODUCE_FIRST_OBSERVATION'] });
  assert.equal(analysis.reversible.verdict, 'fails', 'no path leads back to "no observation published"');
});

test('the seeded control is not labelled deadlocked, and the seed makes the first-observation transition unreachable', () => {
  const { analysis, reading } = recorded('seededControl');
  assert.equal(reading.reading, 'NO_DEADLOCK');
  assert.deepEqual(analysis.quasi_live, { verdict: 'fails', detail: ['T_PRODUCE_FIRST_OBSERVATION'] });
});

test('as-written and as-shipped differ only by the claimed observation prerequisite, so that arc is the false dependency', () => {
  const written = new Set(NETS.asWritten.arcs.map(arcKey));
  const shipped = new Set(NETS.asShipped.arcs.map(arcKey));
  assert.deepEqual([...written].filter((arc) => !shipped.has(arc)).sort(), CLAIMED_PREREQUISITE_ARCS.map(([from, to]) => `${from}->${to}`).sort());
  assert.deepEqual([...shipped].filter((arc) => !written.has(arc)), []);
  assert.deepEqual(NETS.asWritten.places, NETS.asShipped.places);
  assert.deepEqual(NETS.asWritten.transitions, NETS.asShipped.transitions);
  assert.ok(Object.isFrozen(NETS.asWritten.arcs[0]));
});

test('readBootstrapAnalysis separates a reachable deadlock and an undecided enumeration from a bootstrap deadlock', () => {
  const net = NETS.asShipped;
  const base = { net: net.name, states: 3, truncated: false };
  const reachable = readBootstrapAnalysis(net, {
    ...base, deadlock_free: { verdict: 'fails', detail: [{ state: 2, marking: 'x=1', witness: ['T_RUN_PUMP'] }] },
  });
  assert.equal(reachable.reading, 'REACHABLE_DEADLOCK');
  assert.deepEqual(reachable.witness, ['T_RUN_PUMP']);
  const undecided = readBootstrapAnalysis(net, { ...base, truncated: true, deadlock_free: { verdict: 'unknown', detail: { reason: 'budget' } } });
  assert.equal(undecided.reading, 'UNDECIDED');
  assert.deepEqual([...BOOTSTRAP_READINGS].sort(), ['BOOTSTRAP_DEADLOCK', 'NO_DEADLOCK', 'REACHABLE_DEADLOCK', 'UNDECIDED']);
});

test('readBootstrapAnalysis fails closed on an unrecognised verdict, an empty failure, or another net', () => {
  const net = NETS.asWritten;
  const base = { net: net.name, states: 1, truncated: false };
  const refuses = (analysis, code) => assert.throws(
    () => readBootstrapAnalysis(net, analysis),
    (error) => error instanceof BootstrapDeadlockError && error.code === code,
  );
  refuses({ ...base, deadlock_free: { verdict: 'mostly_holds', detail: [] } }, 'AnalysisInvalid');
  refuses({ ...base, deadlock_free: { verdict: 'fails', detail: [] } }, 'AnalysisInvalid');
  refuses({ ...base, net: NETS.asShipped.name, deadlock_free: { verdict: 'holds', detail: [] } }, 'AnalysisNetMismatch');
  refuses({ ...base, truncated: 'no', deadlock_free: { verdict: 'holds', detail: [] } }, 'AnalysisInvalid');
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

test('the Adapter names every absence instead of returning an empty result', async () => {
  const request = { nets: [NETS.asWritten], maxStates: 10, extensionFile: 'ix.duckdb_extension' };
  const refuses = async (options, code) => assert.rejects(
    analyzeNetsWithIxPetri(request, options),
    (error) => error instanceof IxPetriDuckDbError && error.code === code,
  );
  await refuses({ loadApi: async () => { throw new Error('module absent'); } }, 'DuckDbClientAbsent');
  const unloadable = fakeApi({ loadFails: true });
  await refuses({ loadApi: unloadable.loadApi }, 'IxExtensionLoadFailed');
  assert.equal(unloadable.calls.closed, 2, 'the throwaway instance is closed on refusal');
  await refuses({ loadApi: fakeApi({ functionCount: 0 }).loadApi }, 'IxPetriFunctionAbsent');
  await assert.rejects(analyzeNetsWithIxPetri({ ...request, maxStates: 0 }), (error) => error.code === 'MaxStatesInvalid');
  await assert.rejects(analyzeNetsWithIxPetri({ ...request, extensionFile: '' }), (error) => error.code === 'IxExtensionUnnamed');
});

test('the Adapter loads the named extension into an in-memory store and returns one document per net in order', async () => {
  const fake = fakeApi({ analysis: (net, maxStates) => ({ net: net.name, maxStates }) });
  const result = await analyzeNetsWithIxPetri(
    { nets: [NETS.asWritten, NETS.asShipped], maxStates: 7, extensionFile: 'dir/it\'s.duckdb_extension' },
    { loadApi: fake.loadApi },
  );
  assert.deepEqual(result.analyses.map(({ net, analysis }) => [net, analysis.maxStates]), [
    [NETS.asWritten.name, 7], [NETS.asShipped.name, 7],
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
