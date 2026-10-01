/**
 * repair-round-breaker.test.mjs — the repair-round circuit breaker (#184).
 *
 * Every attempt runs behind a spy effect, and a refused attempt must leave the spy untouched: the
 * breaker trips before the effect, never after it. The delivery-round advance is driven to its real
 * `BUDGET_EXHAUSTED` refusal, duplicate and concurrent trips and resets are raced on one revision,
 * and a sibling scope is shown to keep going.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createInitialManagedRound, planManagedRoundUpdate } from '../src/pr-delivery-round-history.mjs';
import * as breaker from '../src/repair-round-breaker.mjs';
import {
  advanceReceipt, HEAD, observation, openReceipt, REPAIR_BLOCKER, WORK_KEY,
} from './helpers/delivery-round-fixtures.mjs';

const {
  applyRepairRoundReset, createMemoryRepairRoundStore, decideRepairRound, deliveryBoundary,
  REPAIR_ROUND_REFUSAL_CODES, RepairRoundError, resetRepairRound, runRepairRound,
} = breaker;

const SCOPE = WORK_KEY;
const SIBLING = 'e'.repeat(64);
const POLICY = Object.freeze({
  schema: 'gaia-repair-round-policy/1', revision: 'f'.repeat(64), roundBudget: 2,
});
const hex = (number) => number.toString(16).padStart(64, '0');
const FINGERPRINT = hex(0xf1);
const attempt = (number, boundary = 'ROUND_PROPOSED') => ({
  attemptKey: hex(number), fingerprint: FINGERPRINT, boundary,
});

/** An effect that records every round it is asked to run. */
function spy(log = []) {
  const calls = [];
  const effect = async (round) => {
    log.push('effect');
    calls.push(round);
    return `effect-${calls.length}`;
  };
  return { calls, effect };
}

const run = (store, effect, number, overrides = {}) => runRepairRound({
  store, scope: SCOPE, attempt: attempt(number), policy: POLICY, effect, ...overrides,
});
const reset = (store, receipt, scope = SCOPE) => applyRepairRoundReset({ store, scope, receipt });

const receiptFor = (record, overrides = {}) => ({
  schema: 'gaia-repair-round-reset/1', scope: record.scope, tripKey: record.trip.tripKey,
  operator: 'github:user:gaia-operator', basis: 'NEW_DESIGN', evidenceRevision: '9'.repeat(64),
  ...overrides,
});

const stored = async (store, scope = SCOPE) => (await store.read(scope)).record;
const isRefusal = (code) => (error) => error instanceof RepairRoundError && error.code === code;
const refused = (code, call) => assert.throws(call, isRefusal(code), code);
const rejected = (code, promise) => assert.rejects(promise, isRefusal(code), code);

/** A tripped record, decided purely. */
const trippedRecord = (scope = SCOPE) => decideRepairRound({
  state: null, scope, attempt: attempt(1, 'BUDGET_EXHAUSTED'), policy: POLICY,
}).record;

test('the attempt past the round budget is refused before its effect runs', async () => {
  const log = [];
  const memory = createMemoryRepairRoundStore();
  const store = {
    read: (scope) => { log.push('read'); return memory.read(scope); },
    compareAndSet: (...args) => { log.push('compareAndSet'); return memory.compareAndSet(...args); },
  };
  const { calls, effect } = spy(log);
  for (const number of [1, 2]) {
    const answer = await run(store, effect, number);
    assert.equal(`${answer.kind}:${answer.record.rounds}:${answer.effectResult}`, `ALLOW:${number}:effect-${number}`);
  }
  // The third repairs another failure: the trip names it, the record keeps the last admitted one.
  const other = hex(0xf2);
  const third = await run(store, effect, 3, { attempt: { ...attempt(3), fingerprint: other } });
  assert.equal(`${third.kind}:${third.record.trip.reason}`, 'TRIPPED:ROUND_BUDGET');
  assert.equal(third.record.fingerprint, FINGERPRINT);
  assert.deepEqual(calls.map((round) => round.round), [1, 2], 'the effect never ran for the third');
  assert.deepEqual(log, [
    'read', 'compareAndSet', 'effect',
    'read', 'compareAndSet', 'effect',
    'read', 'compareAndSet',
  ], 'each decision is on record before its effect, and the trip has none');
  assert.equal((await stored(memory)).status, 'TRIPPED');
  assert.deepEqual(third.record.trip, {
    tripKey: third.record.trip.tripKey, reason: 'ROUND_BUDGET', attemptKey: hex(3),
    fingerprint: other, rounds: 2, roundBudget: 2, policyRevision: POLICY.revision,
  });
  assert.ok(Object.isFrozen(third.record.trip), 'a decision is frozen data');
});

test('the delivery-round BUDGET_EXHAUSTED refusal trips the scope, and the next attempt runs no effect', async () => {
  const fingerprint = createHash('sha256').update(`${REPAIR_BLOCKER.class}:${REPAIR_BLOCKER.reason}`).digest('hex');
  const plan = (roundBudget) => {
    const r0 = createInitialManagedRound({ workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(roundBudget) });
    const receipt = advanceReceipt(r0.roundKey);
    return {
      receipt,
      plan: planManagedRoundUpdate({ workKey: WORK_KEY, observation: observation(r0.managedSection), receipt }),
    };
  };
  const store = createMemoryRepairRoundStore();
  const { calls, effect } = spy();
  // Each attempt is keyed by the advance receipt's revision, the key both plans can name.
  const runPlan = ({ receipt, plan: made }) => runRepairRound({
    store, scope: WORK_KEY, policy: POLICY, effect,
    attempt: { attemptKey: receipt.revision, fingerprint, boundary: deliveryBoundary(made) },
  });

  // With a budget of two, the advance proposes R1, and the breaker admits it.
  const admitted = plan(2);
  assert.equal(admitted.plan.kind, 'PROPOSED');
  assert.equal((await runPlan(admitted)).kind, 'ALLOW');
  assert.equal(calls.length, 1);

  // The same advance against a budget of one is refused, under the same key. The refusal trips the
  // scope; a key seen before does not turn it into a duplicate.
  const exhausted = plan(1);
  assert.equal(exhausted.plan.code, 'BUDGET_EXHAUSTED', 'the real advance refuses');
  assert.equal(exhausted.receipt.revision, admitted.receipt.revision);
  const tripped = await runPlan(exhausted);
  assert.equal(`${tripped.kind}:${tripped.record.trip.reason}`, 'TRIPPED:BUDGET_EXHAUSTED');
  assert.equal(tripped.record.trip.fingerprint, fingerprint, 'the trip keeps the failure fingerprint');
  assert.equal((await stored(store)).status, 'TRIPPED', 'what the refusal said is now on record');

  // A round the delivery history would admit is now refused on this scope, before its effect.
  const next = await runRepairRound({
    store, scope: WORK_KEY, policy: POLICY, effect,
    attempt: { attemptKey: admitted.plan.advanceKey, fingerprint, boundary: deliveryBoundary(admitted.plan) },
  });
  assert.equal(next.kind, 'TRIPPED');
  assert.equal(calls.length, 1, 'no effect ran on the tripped scope');

  // Only those two plans are modelled.
  for (const other of [{ kind: 'REFUSED', code: 'StaleBody' }, { kind: 'ALREADY_APPLIED' }, null]) {
    refused('UnmodelledBoundary', () => deliveryBoundary(other));
  }
});

test('a concurrent or duplicate trip has one outcome', async () => {
  const store = createMemoryRepairRoundStore();
  const { calls, effect } = spy();
  await run(store, effect, 1);
  await run(store, effect, 2);
  const before = await store.read(SCOPE);
  const raced = await Promise.all([run(store, effect, 3), run(store, effect, 4)]);
  assert.deepEqual(raced.map((answer) => answer.kind).toSorted(), ['REVISION_CONFLICT', 'TRIPPED']);
  const after = await store.read(SCOPE);
  assert.equal(after.record.generation, before.record.generation + 1, 'one trip was written');

  // The tripping attempt asked again, and the one that lost the race, get the same trip.
  for (const attemptKey of [after.record.trip.attemptKey, hex(3), hex(4)]) {
    const again = await run(store, effect, 0, { attempt: { ...attempt(0), attemptKey } });
    assert.equal(`${again.kind}:${again.write}`, 'TRIPPED:false');
    assert.equal(again.record.trip.tripKey, after.record.trip.tripKey, 'asked again, it is the same trip');
  }
  assert.equal((await store.read(SCOPE)).version, after.version, 'and nothing is written');
  assert.equal(calls.length, 2);

  // A trip that loses the race to an ALLOW is not lost: asked again, it trips the scope.
  const crowded = createMemoryRepairRoundStore();
  await run(crowded, effect, 1);
  const [allowed, lost] = await Promise.all([
    run(crowded, effect, 2), run(crowded, effect, 3, { attempt: attempt(3, 'BUDGET_EXHAUSTED') }),
  ]);
  assert.equal(`${allowed.kind}:${lost.kind}`, 'ALLOW:REVISION_CONFLICT');
  const retried = await run(crowded, effect, 3, { attempt: attempt(3, 'BUDGET_EXHAUSTED') });
  assert.equal(`${retried.kind}:${retried.record.trip.reason}`, 'TRIPPED:BUDGET_EXHAUSTED');

  // Two attempts racing for the last round: one runs its effect, the other runs nothing.
  const fresh = createMemoryRepairRoundStore();
  const second = spy();
  await run(fresh, second.effect, 1);
  const race = await Promise.all([run(fresh, second.effect, 2), run(fresh, second.effect, 3)]);
  assert.deepEqual(race.map((answer) => answer.kind).toSorted(), ['ALLOW', 'REVISION_CONFLICT']);
  assert.equal(second.calls.length, 2);
  // The attempt that won, asked again, is neither counted nor run twice.
  const winner = race.find((answer) => answer.kind === 'ALLOW').record.lastAttemptKey;
  const repeat = await run(fresh, second.effect, 0, { attempt: { ...attempt(0), attemptKey: winner } });
  assert.equal(`${repeat.kind}:${repeat.record.rounds}:${repeat.write}`, 'DUPLICATE:2:false');
  assert.equal(second.calls.length, 2);
});

test('a concurrent or duplicate reset has one outcome, and the reset scope runs again', async () => {
  const store = createMemoryRepairRoundStore();
  const { calls, effect } = spy();
  for (const number of [1, 2, 3]) await run(store, effect, number);
  const receipt = receiptFor(await stored(store));

  const raced = await Promise.all([reset(store, receipt), reset(store, receipt)]);
  assert.deepEqual(raced.map((answer) => answer.kind).toSorted(), ['RESET', 'REVISION_CONFLICT']);
  const armed = await store.read(SCOPE);
  assert.equal(`${armed.record.status}:${armed.record.rounds}`, 'ARMED:0');
  assert.deepEqual(armed.record.lastReset, {
    tripKey: receipt.tripKey, operator: receipt.operator, basis: 'NEW_DESIGN',
    evidenceRevision: receipt.evidenceRevision,
  });
  const again = await reset(store, receipt);
  assert.equal(`${again.kind}:${again.write}`, 'ALREADY_RESET:false');
  assert.equal((await store.read(SCOPE)).version, armed.version);
  // Another receipt for the trip already lifted finds no trip, rather than claiming the reset.
  await rejected('NotTripped', reset(store, { ...receipt, operator: 'github:user:someone-else' }));

  // Armed again, the scope admits rounds up to its budget, then trips anew.
  for (const number of [4, 5]) assert.equal((await run(store, effect, number)).kind, 'ALLOW');
  assert.equal((await run(store, effect, 6)).kind, 'TRIPPED');
  assert.equal(calls.length, 4);
  // The old receipt lifts only the trip it names.
  await rejected('ResetTripMismatch', reset(store, receipt));
});

test('a reset without a receipt, for another scope or for another trip is refused with a named code', async () => {
  const record = trippedRecord();
  refused('ResetReceiptRequired', () => resetRepairRound({ state: record, receipt: null }));
  refused('ResetReceiptRequired', () => resetRepairRound({ state: record, receipt: undefined }));
  const lift = (patch) => () => resetRepairRound({ state: record, receipt: receiptFor(record, patch) });
  refused('ResetScopeMismatch', lift({ scope: SIBLING }));
  refused('ResetTripMismatch', lift({ tripKey: hex(7) }));
  refused('NotTripped', () => resetRepairRound({ state: null, receipt: receiptFor(record) }));
  const armed = decideRepairRound({ state: null, scope: SCOPE, attempt: attempt(1), policy: POLICY }).record;
  refused('NotTripped', () => resetRepairRound({ state: armed, receipt: receiptFor(record) }));
  for (const patch of [
    { operator: 'gaia-operator' }, { operator: 'github:app:gaia-draft-pump' }, { basis: 'TIME_PASSED' },
    { schema: 'gaia-repair-round-reset/2' }, { evidenceRevision: 'none' }, { extra: true },
  ]) {
    refused('InvalidResetReceipt', lift(patch));
  }

  // A changed policy must name a policy other than the one the scope tripped under.
  refused('ResetEvidenceUnchanged', lift({ basis: 'CHANGED_POLICY', evidenceRevision: POLICY.revision }));
  assert.equal(lift({ basis: 'CHANGED_POLICY' })().kind, 'RESET');

  const store = createMemoryRepairRoundStore();
  await rejected('ResetReceiptRequired', reset(store, null));
  await rejected('ResetScopeMismatch', reset(store, receiptFor(record), SIBLING));
  await rejected('InvalidResetReceipt', reset(store, receiptFor(record, { basis: 'TIME_PASSED' })));
  await rejected('NotTripped', reset(store, receiptFor(record)));
});

test('a sibling scope keeps returning ALLOW after a trip', async () => {
  const store = createMemoryRepairRoundStore();
  const { calls, effect } = spy();
  assert.equal((await run(store, effect, 1, { attempt: attempt(1, 'BUDGET_EXHAUSTED') })).kind, 'TRIPPED');
  for (const number of [2, 3]) {
    assert.equal((await run(store, effect, number, { scope: SIBLING })).kind, 'ALLOW');
  }
  assert.deepEqual(calls.map((round) => round.scope), [SIBLING, SIBLING]);
  assert.equal((await stored(store)).status, 'TRIPPED', 'the tripped scope is untouched');
  assert.equal((await run(store, effect, 4)).kind, 'TRIPPED');
});

test('only a reset lifts a trip: asking again, a larger budget or another policy do not', async () => {
  const record = trippedRecord();
  const ask = (state, next, policy = POLICY) => decideRepairRound({ state, scope: SCOPE, attempt: next, policy });
  // The record is the whole state and the decision reads no clock: whoever reads the same record
  // gets the same answer, however long they waited.
  for (const policy of [POLICY, { ...POLICY, roundBudget: 1000 }, { ...POLICY, revision: hex(0xaa) }]) {
    for (const boundary of ['ROUND_PROPOSED', 'BUDGET_EXHAUSTED']) {
      const answer = ask(structuredClone(record), attempt(9, boundary), policy);
      assert.equal(`${answer.kind}:${answer.write}`, 'TRIPPED:false');
    }
  }
  const lifted = resetRepairRound({ state: record, receipt: receiptFor(record, { basis: 'CHANGED_POLICY' }) });
  assert.equal(ask(lifted.record, attempt(9)).kind, 'ALLOW');
});

test('malformed input is refused with named codes', async () => {
  const call = (patch) => () => decideRepairRound({
    state: null, scope: SCOPE, attempt: attempt(1), policy: POLICY, ...patch,
  });
  refused('InvalidCall', () => decideRepairRound(null));
  refused('InvalidCall', call({ extra: true }));
  refused('InvalidScope', call({ scope: 'A'.repeat(64) }));
  refused('InvalidPolicy', call({ policy: { ...POLICY, roundBudget: 0 } }));
  refused('InvalidPolicy', call({ policy: { ...POLICY, schema: 'gaia-repair-round-policy/2' } }));
  refused('InvalidAttempt', call({ attempt: { ...attempt(1), boundary: 'RETRY' } }));
  refused('InvalidAttempt', call({ attempt: { ...attempt(1), attemptKey: 'k' } }));
  const record = trippedRecord();
  refused('InvalidRecord', call({ state: { ...record, trip: null } }));
  refused('InvalidRecord', call({ state: { ...record, status: 'ARMED' } }));
  refused('InvalidRecord', call({ state: { ...record, generation: 0 } }));
  refused('InvalidRecord', call({ state: { ...record, extra: true } }));
  refused('ScopeMismatch', call({ state: trippedRecord(SIBLING) }));

  const { calls, effect } = spy();
  const port = (read, written = null) => ({ read: async () => read, compareAndSet: async () => written });
  await rejected('InvalidStore', run({}, effect, 1));
  await rejected('InvalidStore', run(port({ state: 'GONE' }), effect, 1));
  await rejected('InvalidStore', run(port({ state: 'UNSEEN' }, { kind: 'OK' }), effect, 1));
  await rejected('InvalidEffect', run(createMemoryRepairRoundStore(), 'effect', 1));
  const foreign = port({ state: 'PRESENT', version: 'v', record: trippedRecord(SIBLING) });
  await rejected('ScopeMismatch', run(foreign, effect, 1));
  await rejected('ScopeMismatch', reset(foreign, receiptFor(trippedRecord())));
  assert.equal(calls.length, 0, 'no refused call ran the effect');

  assert.ok(REPAIR_ROUND_REFUSAL_CODES.every((code) => /^[A-Z][A-Za-z]+$/u.test(code)));
});

test('input is copied from data fields once, and the store shares no object with its callers', async () => {
  const getter = (object, key, get) => Object.defineProperty({ ...object }, key, { enumerable: true, get });
  const call = (patch) => () => decideRepairRound({
    state: null, scope: SCOPE, attempt: attempt(1), policy: POLICY, ...patch,
  });
  // An accessor is refused before it is read, so a getter can neither throw past the vocabulary
  // nor answer one value to the check and another to the decision.
  let reads = 0;
  const counted = () => { reads += 1; return 'ROUND_PROPOSED'; };
  refused('InvalidAttempt', call({ attempt: getter(attempt(1), 'boundary', counted) }));
  refused('InvalidPolicy', call({ policy: getter(POLICY, 'roundBudget', () => { throw new Error('boom'); }) }));
  assert.equal(reads, 0);
  const hidden = Object.defineProperty({ ...attempt(1) }, 'boundary', { value: 'ROUND_PROPOSED', enumerable: false });
  refused('InvalidAttempt', call({ attempt: hidden }));

  // The store's methods and each field of its answers are read once.
  const memory = createMemoryRepairRoundStore();
  const { effect } = spy();
  await run(memory, effect, 1);
  const versions = [];
  let methodReads = 0;
  const tricky = {
    get read() {
      methodReads += 1;
      return async (scope) => {
        const answer = await memory.read(scope);
        let flips = 0;
        return { ...answer, get version() { flips += 1; return flips === 1 ? answer.version : { not: 'a string' }; } };
      };
    },
    compareAndSet: async (scope, expectedVersion, record) => {
      versions.push(expectedVersion);
      return memory.compareAndSet(scope, expectedVersion, record);
    },
  };
  assert.equal((await run(tricky, effect, 2)).kind, 'ALLOW');
  assert.equal(methodReads, 1);
  assert.equal(typeof versions[0], 'string', 'the version sent back is the version checked');

  // Neither what a caller reads nor what it wrote can change what the store holds.
  const read = await memory.read(SCOPE);
  read.record.rounds = 99;
  assert.equal((await stored(memory)).rounds, 2);
  const decided = structuredClone(decideRepairRound({
    state: (await memory.read(SCOPE)).record, scope: SCOPE, attempt: attempt(3), policy: { ...POLICY, roundBudget: 5 },
  }).record);
  await memory.compareAndSet(SCOPE, (await memory.read(SCOPE)).version, decided);
  decided.rounds = 99;
  assert.equal((await stored(memory)).rounds, 3);
});

test('NEGATIVE CONTROL: the breaker mints no reset receipt and reads no clock', () => {
  assert.deepEqual(Object.keys(breaker).toSorted(), [
    'REPAIR_ROUND_BOUNDARIES', 'REPAIR_ROUND_POLICY_SCHEMA', 'REPAIR_ROUND_RECORD_SCHEMA',
    'REPAIR_ROUND_REFUSAL_CODES', 'REPAIR_ROUND_RESET_BASES', 'REPAIR_ROUND_RESET_SCHEMA',
    'REPAIR_ROUND_TRIP_REASONS', 'RepairRoundError', 'applyRepairRoundReset',
    'createMemoryRepairRoundStore', 'decideRepairRound', 'deliveryBoundary', 'resetRepairRound',
    'runRepairRound',
  ].toSorted(), 'no export issues a receipt');
  const source = readFileSync(new URL('../src/repair-round-breaker.mjs', import.meta.url), 'utf8');
  // The reset schema is named where it is declared and where a receipt is checked, nowhere else.
  assert.equal(source.split("'gaia-repair-round-reset/1'").length, 2);
  assert.equal(source.split('REPAIR_ROUND_RESET_SCHEMA').length, 3);
  // Time cannot lift a trip because nothing here can read it.
  assert.doesNotMatch(source, /\bDate\b|\bprocess\b|\bperformance\b|\bset(?:Timeout|Interval)\b/u);
});
