import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BUS_VERBS } from '../src/bus-core.mjs';
import {
  ENGINEERING_PUMP_OBSERVATION_SCHEMA,
  projectEngineeringPumpChecklist,
  projectEngineeringPumpTransitions,
  readEngineeringPumpJournal,
  runEngineeringPumpSupervisorTick,
  sealEngineeringPumpObservation,
} from '../src/engineering-pump-supervisor.mjs';
import { synchronizeEngineeringPumpDuckDb } from '../src/duckdb-engineering-pump-supervisor.mjs';

const AT = '2026-08-31T18:00:00.000Z';
const LATER = '2026-08-31T18:03:00.000Z';
const POLICY = 'a'.repeat(64);
const SOURCE = 'b'.repeat(64);
const SUBJECT = 'c'.repeat(64);
const OWNER_A = '1'.repeat(32);
const OWNER_B = '2'.repeat(32);

const scratch = () => mkdtempSync(join(tmpdir(), 'gaia-engineering-pump-r0-'));

function observation(overrides = {}) {
  const body = {
    schema: ENGINEERING_PUMP_OBSERVATION_SCHEMA,
    observedAt: AT,
    repository: 'GuitarAlchemist/gaia',
    policyRevision: POLICY,
    sourceRevision: SOURCE,
    capacity: { writerSlots: 2, providerSlots: 2, ciSlots: 2 },
    readyItems: [{
      readyItemId: 'issue-40', subjectRevision: SUBJECT,
      draftState: 'NONE', writerState: 'NONE',
    }],
    ...overrides,
  };
  return sealEngineeringPumpObservation(body);
}

const draft = (operationIdentity, number = 45) => ({
  number,
  url: `https://github.com/GuitarAlchemist/gaia/pull/${number}`,
  state: 'OPEN',
  isDraft: true,
  operationIdentity,
});

function executor({ reconcile = async () => null, execute } = {}) {
  const calls = [];
  return {
    calls,
    async reconcile(intent) {
      calls.push(['reconcile', intent]);
      return reconcile(intent);
    },
    async execute(intent) {
      calls.push(['execute', intent]);
      return (execute ?? (async (value) => draft(value.operationIdentity)))(intent);
    },
  };
}

const tick = (directory, supplied = {}) => runEngineeringPumpSupervisorTick({
  directory,
  observation: supplied.observation ?? observation(),
  executor: supplied.executor ?? executor(),
  owner: supplied.owner ?? OWNER_A,
  now: () => new Date(supplied.now ?? AT),
  leaseMs: supplied.leaseMs ?? 120_000,
});

test('R0 public seam: a ready item yields one evidence-bound START_DRAFT action', async () => {
  const directory = scratch();
  const result = await tick(directory);
  assert.equal(result.gate.state, 'READY');
  assert.equal(result.gate.nextAction.kind, 'START_DRAFT');
  assert.equal(result.gate.nextAction.readyItemId, 'issue-40');
  assert.equal(result.delivery.outcome, 'CREATED');
  assert.equal(result.gate.observationRevision, observation().observationRevision);
  assert.equal(result.checklist.origin, 'GAIA_PUMP');
  assert.equal(result.checklist.currentStep, 'DRAFT_OPEN');
  assert.equal(result.checklist.next, 'REVIEW');
  assert.deepEqual(result.checklist.steps.map(({ done }) => done), [true, true, true]);
});

test('R0 simultaneous refill: exclusive intent admits one actor and no second effect', async () => {
  const directory = scratch();
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let reached;
  const firstReached = new Promise((resolve) => { reached = resolve; });
  let creates = 0;
  const firstExecutor = executor({
    reconcile: async () => { reached(); await barrier; return null; },
    execute: async (intent) => { creates += 1; return draft(intent.operationIdentity); },
  });
  const secondExecutor = executor({
    execute: async (intent) => { creates += 1; return draft(intent.operationIdentity, 46); },
  });
  const first = tick(directory, { executor: firstExecutor, owner: OWNER_A });
  await firstReached;
  await assert.rejects(
    tick(directory, { executor: secondExecutor, owner: OWNER_B }),
    (error) => error.code === 'PumpInFlight',
  );
  release();
  await first;
  assert.equal(creates, 1);
  assert.deepEqual(readEngineeringPumpJournal({ directory }).transitions.map((x) => x.transition),
    ['INTENT', 'CREATED']);
});

test('R0 duplicate, delayed and replayed observations converge to one terminal receipt', async () => {
  const directory = scratch();
  const effects = executor();
  const first = await tick(directory, { executor: effects });
  const replay = await tick(directory, { executor: effects, owner: OWNER_B });
  assert.equal(replay.delivery.operationIdentity, first.delivery.operationIdentity);
  assert.equal(replay.delivery.outcome, 'CREATED');
  assert.equal(effects.calls.filter(([name]) => name === 'execute').length, 1);
  assert.deepEqual(readEngineeringPumpJournal({ directory }).transitions.map((x) => x.transition),
    ['INTENT', 'CREATED']);
});

test('R0 lost GitHub response is reconciled by stable marker before any retry', async () => {
  const directory = scratch();
  let remote = null;
  let executes = 0;
  const lost = executor({
    execute: async (intent) => {
      executes += 1;
      remote = draft(intent.operationIdentity);
      throw Object.assign(new Error('response lost'), { code: 'ResponseLost' });
    },
  });
  await assert.rejects(tick(directory, { executor: lost }), /response lost/u);
  const recovery = executor({
    reconcile: async () => remote,
    execute: async () => { executes += 1; throw new Error('blind retry'); },
  });
  const adopted = await tick(directory, { executor: recovery, owner: OWNER_B, now: LATER });
  assert.equal(adopted.delivery.outcome, 'RECONCILED');
  assert.equal(executes, 1);
  assert.deepEqual(recovery.calls.map(([name]) => name), ['reconcile']);
});

test('R0 crash after intent restarts with empty memory, reconciles, then executes once', async () => {
  const directory = scratch();
  const crashing = executor({ reconcile: async () => {
    throw Object.assign(new Error('process crashed'), { code: 'CrashAfterIntent' });
  } });
  await assert.rejects(tick(directory, { executor: crashing }), /process crashed/u);
  assert.deepEqual(readEngineeringPumpJournal({ directory }).transitions.map((x) => x.transition),
    ['INTENT']);
  let creates = 0;
  const restarted = executor({
    reconcile: async () => null,
    execute: async (intent) => { creates += 1; return draft(intent.operationIdentity); },
  });
  const result = await tick(directory, { executor: restarted, owner: OWNER_B, now: LATER });
  assert.equal(result.delivery.outcome, 'CREATED');
  assert.equal(creates, 1);
  assert.deepEqual(restarted.calls.map(([name]) => name), ['reconcile', 'execute']);
});

test('R0 stale, future and corrupt evidence fail closed before journal or effect', async () => {
  for (const [label, supplied, code] of [
    ['stale', observation({ observedAt: '2026-08-31T17:00:00.000Z' }), 'ObservationStale'],
    ['future', observation({ observedAt: '2026-08-31T18:01:00.000Z' }), 'ObservationFromFuture'],
    ['corrupt', { ...observation(), sourceRevision: 'd'.repeat(64) }, 'ObservationRevisionMismatch'],
  ]) {
    const directory = scratch();
    const effects = executor();
    await assert.rejects(tick(directory, { observation: supplied, executor: effects }),
      (error) => error.code === code, label);
    assert.equal(effects.calls.length, 0, label);
    assert.equal(readEngineeringPumpJournal({ directory }).count, 0, label);
  }
});

test('R0 provider and CI saturation are explicit effect-free gates', async () => {
  for (const [capacity, state] of [
    [{ writerSlots: 2, providerSlots: 0, ciSlots: 2 }, 'PROVIDER_SATURATED'],
    [{ writerSlots: 2, providerSlots: 2, ciSlots: 0 }, 'CI_SATURATED'],
    [{ writerSlots: 0, providerSlots: 2, ciSlots: 2 }, 'CAPACITY_FULL'],
  ]) {
    const effects = executor();
    const result = await tick(scratch(), { observation: observation({ capacity }), executor: effects });
    assert.equal(result.gate.state, state);
    assert.equal(result.gate.nextAction.kind, 'NONE');
    assert.equal(result.delivery, null);
    assert.equal(effects.calls.length, 0);
  }
});

test('R0 EXPECTED_NONE is healthy idle and conflicting ownership is a named no-op', async () => {
  const empty = await tick(scratch(), { observation: observation({ readyItems: [] }) });
  assert.equal(empty.gate.state, 'EXPECTED_NONE');
  assert.equal(empty.gate.nextAction.kind, 'NONE');
  const owned = await tick(scratch(), { observation: observation({ readyItems: [{
    readyItemId: 'issue-40', subjectRevision: SUBJECT,
    draftState: 'NONE', writerState: 'OWNED',
  }] }) });
  assert.equal(owned.gate.state, 'WRITER_OWNED');
  assert.equal(owned.gate.nextAction.kind, 'NONE');
});

test('R0 deterministic replay rebuilds the same transitions and checklist bytes', async () => {
  const directory = scratch();
  await tick(directory);
  assert.equal(
    JSON.stringify(projectEngineeringPumpTransitions({ directory })),
    JSON.stringify(projectEngineeringPumpTransitions({ directory })),
  );
  assert.equal(
    JSON.stringify(projectEngineeringPumpChecklist({ directory })),
    JSON.stringify(projectEngineeringPumpChecklist({ directory })),
  );
});

test('R0 DuckDB is a deterministic projection and never the claim authority', async () => {
  const directory = scratch();
  await tick(directory);
  const calls = [];
  const openClient = async () => ({
    run: async (sql, params = []) => { calls.push([sql, params]); },
    close() {},
  });
  const first = await synchronizeEngineeringPumpDuckDb({
    directory, databasePath: join(directory, 'pump.duckdb'), openClient,
  });
  const firstCalls = JSON.stringify(calls);
  calls.length = 0;
  const second = await synchronizeEngineeringPumpDuckDb({
    directory, databasePath: join(directory, 'pump.duckdb'), openClient,
  });
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(calls), firstCalls);
  assert.equal(first.rowCount, 2);
  assert.equal(first.authority, 'NONE');
});

test('R0 MECHANISM REVERT: removing reconciliation duplicates a lost-response Draft', async () => {
  const sourcePath = new URL('../src/engineering-pump-supervisor.mjs', import.meta.url);
  const source = readFileSync(sourcePath, 'utf8');
  const needle = 'const reconciled = await executor.reconcile(operationIntent);';
  assert.equal(source.includes(needle), true, 'the shipped mechanism must be present');
  const mutantPath = join(scratch(), 'engineering-pump-supervisor-mutant.mjs');
  writeFileSync(mutantPath, source.replace(needle, 'const reconciled = null;'));
  const mutant = await import(`${new URL(`file:///${mutantPath.replaceAll('\\', '/')}`)}?mutant=1`);
  const directory = scratch();
  let remote = null;
  let executes = 0;
  await assert.rejects(mutant.runEngineeringPumpSupervisorTick({
    directory, observation: observation(), owner: OWNER_A, now: () => new Date(AT),
    executor: executor({ execute: async (intent) => {
      executes += 1; remote = draft(intent.operationIdentity); throw new Error('lost');
    } }),
  }));
  await mutant.runEngineeringPumpSupervisorTick({
    directory, observation: observation(), owner: OWNER_B, now: () => new Date(LATER),
    executor: executor({
      reconcile: async () => remote,
      execute: async (intent) => { executes += 1; return draft(intent.operationIdentity, 46); },
    }),
  });
  assert.equal(executes, 2, 'the mutant performs a blind duplicate effect');
});

test('R0 preserves the six unprivileged bus verbs', () => {
  assert.deepEqual([...BUS_VERBS], [
    'register', 'send', 'inbox', 'ack', 'heartbeat', 'handoff',
  ]);
});
