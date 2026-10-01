/**
 * Repair-round circuit breaker (#184): one breaker family of #54, built on the boundary the
 * delivery-round advance already has, its `BUDGET_EXHAUSTED` refusal (`planManagedRoundUpdate` in
 * `src/pr-delivery-round-history.mjs`). docs/repair-round-breaker.md is the contract.
 *
 * That refusal is stateless: it stops one advance and records nothing. This breaker keeps one
 * record per work identity scope: how many repair rounds it admitted, the failure fingerprint of
 * the last one, and whether it tripped. It trips when either of these comes first:
 *   - the delivery-round advance reports `BUDGET_EXHAUSTED` (`BUDGET_EXHAUSTED`), whatever the
 *     attempt's key;
 *   - an attempt would go past the policy's round budget (`ROUND_BUDGET`).
 * A tripped scope refuses every later attempt as `TRIPPED` until a reset receipt bound to that
 * trip arms it again. No call reads a clock, so the record outlives a restart exactly as long as
 * the store keeps it: the memory store of this slice keeps nothing across a restart (#54).
 *
 * TRIP BEFORE EFFECT
 * ------------------
 * `decideRepairRound` and `resetRepairRound` are pure. `runRepairRound` reads the scope's record,
 * decides, and compare-and-sets the next record before it calls the effect. Only an `ALLOW` that
 * won its compare-and-set runs the effect. A loser gets `REVISION_CONFLICT` and runs nothing, so
 * concurrent attempts, trips or resets on one revision have one outcome; the loser asks again to
 * have its own decided.
 *
 * NO SELF-AUTHORIZATION, AND NO AUTHENTICATION EITHER
 * ---------------------------------------------------
 * Nothing here mints a reset receipt. `resetRepairRound` checks that a receipt is bound to the
 * scope and to the exact trip it lifts. It does not check that the receipt is authentic: every
 * field is either free text or already in the caller's hands, so any caller can build one. Until
 * #54 supplies an authenticated reset channel, no untrusted caller may reach the reset. The live
 * pump path is not wired to this breaker yet.
 */

import { createHash } from 'node:crypto';

export const REPAIR_ROUND_RECORD_SCHEMA = 'gaia-repair-round-breaker/1';
export const REPAIR_ROUND_POLICY_SCHEMA = 'gaia-repair-round-policy/1';
export const REPAIR_ROUND_RESET_SCHEMA = 'gaia-repair-round-reset/1';

/** What the delivery-round advance said about an attempt. */
export const REPAIR_ROUND_BOUNDARIES = Object.freeze(['ROUND_PROPOSED', 'BUDGET_EXHAUSTED']);

/** Why a scope tripped. */
export const REPAIR_ROUND_TRIP_REASONS = Object.freeze(['BUDGET_EXHAUSTED', 'ROUND_BUDGET']);

/** What an operator reset rests on (#54: a new design or fixed point, or a changed policy). */
export const REPAIR_ROUND_RESET_BASES = Object.freeze(['NEW_DESIGN', 'FIXED_POINT', 'CHANGED_POLICY']);

/** The closed refusal vocabulary. */
export const REPAIR_ROUND_REFUSAL_CODES = Object.freeze([
  'InvalidCall',
  'InvalidScope',
  'InvalidPolicy',
  'InvalidAttempt',
  'InvalidRecord',
  'ScopeMismatch',
  'UnmodelledBoundary',
  'ResetReceiptRequired',
  'InvalidResetReceipt',
  'ResetScopeMismatch',
  'ResetTripMismatch',
  'ResetEvidenceUnchanged',
  'NotTripped',
  'InvalidStore',
  'InvalidEffect',
]);

export class RepairRoundError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RepairRoundError';
    this.code = code;
  }
}

const refuse = (code) => { throw new RepairRoundError(code); };

const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATOR = /^github:user:[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const RECORD_KEYS = Object.freeze([
  'schema', 'scope', 'generation', 'status', 'rounds', 'lastAttemptKey', 'fingerprint', 'trip',
  'lastReset',
]);
const TRIP_KEYS = Object.freeze([
  'tripKey', 'reason', 'attemptKey', 'fingerprint', 'rounds', 'roundBudget', 'policyRevision',
]);
const RESET_KEYS = Object.freeze(['tripKey', 'operator', 'basis', 'evidenceRevision']);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const digest = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
};

/**
 * The exact own data fields of a plain object, copied. Everything after this reads the copy, so
 * what is validated is what is decided and stored: no accessor, prototype or extra key.
 */
function readFields(value, keys, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) refuse(code);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length
      || own.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    refuse(code);
  }
  const fields = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) refuse(code);
    fields[key] = descriptor.value;
  }
  return fields;
}

function sha256(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) refuse(code);
  return value;
}

const count = (value, minimum, code) => {
  if (!Number.isSafeInteger(value) || value < minimum) refuse(code);
  return value;
};

const nullable = (value, read) => (value === null ? null : read(value));

/** A work identity scope: the 64-hex work key the delivery-round history is keyed by. */
const readScope = (value) => sha256(value, 'InvalidScope');

function readPolicy(value) {
  const policy = readFields(value, ['schema', 'revision', 'roundBudget'], 'InvalidPolicy');
  if (policy.schema !== REPAIR_ROUND_POLICY_SCHEMA) refuse('InvalidPolicy');
  return {
    revision: sha256(policy.revision, 'InvalidPolicy'),
    roundBudget: count(policy.roundBudget, 1, 'InvalidPolicy'),
  };
}

function readAttempt(value) {
  const attempt = readFields(value, ['attemptKey', 'fingerprint', 'boundary'], 'InvalidAttempt');
  if (!REPAIR_ROUND_BOUNDARIES.includes(attempt.boundary)) refuse('InvalidAttempt');
  return {
    attemptKey: sha256(attempt.attemptKey, 'InvalidAttempt'),
    fingerprint: sha256(attempt.fingerprint, 'InvalidAttempt'),
    boundary: attempt.boundary,
  };
}

function readTrip(value) {
  const trip = readFields(value, TRIP_KEYS, 'InvalidRecord');
  if (!REPAIR_ROUND_TRIP_REASONS.includes(trip.reason)) refuse('InvalidRecord');
  return {
    tripKey: sha256(trip.tripKey, 'InvalidRecord'),
    reason: trip.reason,
    attemptKey: sha256(trip.attemptKey, 'InvalidRecord'),
    fingerprint: sha256(trip.fingerprint, 'InvalidRecord'),
    rounds: count(trip.rounds, 0, 'InvalidRecord'),
    roundBudget: count(trip.roundBudget, 1, 'InvalidRecord'),
    policyRevision: sha256(trip.policyRevision, 'InvalidRecord'),
  };
}

function readLastReset(value) {
  const reset = readFields(value, RESET_KEYS, 'InvalidRecord');
  if (!REPAIR_ROUND_RESET_BASES.includes(reset.basis)) refuse('InvalidRecord');
  if (typeof reset.operator !== 'string' || !OPERATOR.test(reset.operator)) refuse('InvalidRecord');
  return {
    tripKey: sha256(reset.tripKey, 'InvalidRecord'),
    operator: reset.operator,
    basis: reset.basis,
    evidenceRevision: sha256(reset.evidenceRevision, 'InvalidRecord'),
  };
}

/** A breaker record. A record is `TRIPPED` exactly when it carries a trip. */
function readRecord(value) {
  const record = readFields(value, RECORD_KEYS, 'InvalidRecord');
  if (record.schema !== REPAIR_ROUND_RECORD_SCHEMA) refuse('InvalidRecord');
  if (!['ARMED', 'TRIPPED'].includes(record.status)) refuse('InvalidRecord');
  const read = (field) => sha256(field, 'InvalidRecord');
  const trip = nullable(record.trip, readTrip);
  if ((trip !== null) !== (record.status === 'TRIPPED')) refuse('InvalidRecord');
  return {
    schema: REPAIR_ROUND_RECORD_SCHEMA,
    scope: read(record.scope),
    generation: count(record.generation, 1, 'InvalidRecord'),
    status: record.status,
    rounds: count(record.rounds, 0, 'InvalidRecord'),
    lastAttemptKey: nullable(record.lastAttemptKey, read),
    fingerprint: nullable(record.fingerprint, read),
    trip,
    lastReset: nullable(record.lastReset, readLastReset),
  };
}

function readResetReceipt(value) {
  if (value === null || value === undefined) refuse('ResetReceiptRequired');
  const receipt = readFields(value,
    ['schema', 'scope', 'tripKey', 'operator', 'basis', 'evidenceRevision'], 'InvalidResetReceipt');
  if (receipt.schema !== REPAIR_ROUND_RESET_SCHEMA) refuse('InvalidResetReceipt');
  if (typeof receipt.operator !== 'string' || !OPERATOR.test(receipt.operator)) refuse('InvalidResetReceipt');
  if (!REPAIR_ROUND_RESET_BASES.includes(receipt.basis)) refuse('InvalidResetReceipt');
  return {
    scope: sha256(receipt.scope, 'InvalidResetReceipt'),
    tripKey: sha256(receipt.tripKey, 'InvalidResetReceipt'),
    operator: receipt.operator,
    basis: receipt.basis,
    evidenceRevision: sha256(receipt.evidenceRevision, 'InvalidResetReceipt'),
  };
}

const outcome = (kind, record, write) => deepFreeze({ kind, record, write });

function tripped(prior, reason, attempt, policy) {
  const generation = prior.generation + 1;
  const tripKey = digest({
    schema: REPAIR_ROUND_RECORD_SCHEMA, scope: prior.scope, generation, reason,
    attemptKey: attempt.attemptKey, fingerprint: attempt.fingerprint,
  });
  return {
    ...prior,
    generation,
    status: 'TRIPPED',
    trip: {
      tripKey, reason, attemptKey: attempt.attemptKey, fingerprint: attempt.fingerprint,
      rounds: prior.rounds, roundBudget: policy.roundBudget, policyRevision: policy.revision,
    },
  };
}

function decide(record, scope, attempt, policy) {
  if (record !== null && record.scope !== scope) refuse('ScopeMismatch');
  // A tripped scope stays tripped whatever is asked of it, until a reset.
  if (record?.status === 'TRIPPED') return outcome('TRIPPED', record, false);
  const prior = record ?? {
    schema: REPAIR_ROUND_RECORD_SCHEMA, scope, generation: 0, status: 'ARMED', rounds: 0,
    lastAttemptKey: null, fingerprint: null, trip: null, lastReset: null,
  };
  // The advance said the budget is spent: that trips the scope, whatever key the attempt carries.
  if (attempt.boundary === 'BUDGET_EXHAUSTED') {
    return outcome('TRIPPED', tripped(prior, 'BUDGET_EXHAUSTED', attempt, policy), true);
  }
  // The last admitted round asked again is not counted or run twice.
  if (prior.lastAttemptKey === attempt.attemptKey) return outcome('DUPLICATE', prior, false);
  if (prior.rounds >= policy.roundBudget) {
    return outcome('TRIPPED', tripped(prior, 'ROUND_BUDGET', attempt, policy), true);
  }
  return outcome('ALLOW', {
    ...prior,
    generation: prior.generation + 1,
    rounds: prior.rounds + 1,
    lastAttemptKey: attempt.attemptKey,
    fingerprint: attempt.fingerprint,
  }, true);
}

function reset(record, receipt) {
  if (record === null) refuse('NotTripped');
  if (record.scope !== receipt.scope) refuse('ResetScopeMismatch');
  const lastReset = {
    tripKey: receipt.tripKey, operator: receipt.operator, basis: receipt.basis,
    evidenceRevision: receipt.evidenceRevision,
  };
  if (record.status === 'ARMED') {
    // The same receipt applied again finds the scope it already armed; any other finds no trip.
    if (record.lastReset !== null && canonical(record.lastReset) === canonical(lastReset)) {
      return outcome('ALREADY_RESET', record, false);
    }
    refuse('NotTripped');
  }
  if (record.trip.tripKey !== receipt.tripKey) refuse('ResetTripMismatch');
  // A changed policy has to name a policy other than the one the scope tripped under.
  if (receipt.basis === 'CHANGED_POLICY'
      && receipt.evidenceRevision === record.trip.policyRevision) {
    refuse('ResetEvidenceUnchanged');
  }
  return outcome('RESET', {
    ...record, generation: record.generation + 1, status: 'ARMED', rounds: 0, trip: null, lastReset,
  }, true);
}

/**
 * Decide one repair-round attempt for a scope. `state` is the scope's record, or null before its
 * first attempt. Returns a frozen `{ kind, record, write }`: `ALLOW`, `TRIPPED` or `DUPLICATE`
 * (the last admitted round asked again, which grants nothing new), with the record to
 * compare-and-set when `write` is true.
 */
export function decideRepairRound(input) {
  const call = readFields(input, ['state', 'scope', 'attempt', 'policy'], 'InvalidCall');
  const scope = readScope(call.scope);
  const attempt = readAttempt(call.attempt);
  const policy = readPolicy(call.policy);
  return decide(nullable(call.state, readRecord), scope, attempt, policy);
}

/**
 * Lift a trip with a reset receipt bound to it. Returns a frozen `{ kind, record, write }`:
 * `RESET`, or `ALREADY_RESET` when the same receipt already armed the scope. The receipt's
 * authenticity is not checked here (see the header).
 */
export function resetRepairRound(input) {
  const call = readFields(input, ['state', 'receipt'], 'InvalidCall');
  const receipt = readResetReceipt(call.receipt);
  return reset(nullable(call.state, readRecord), receipt);
}

/** The boundary a delivery-round plan reports, for the plans the breaker models. */
export function deliveryBoundary(plan) {
  const kind = plan !== null && typeof plan === 'object' ? plan.kind : undefined;
  if (kind === 'PROPOSED') return 'ROUND_PROPOSED';
  if (kind === 'REFUSED' && plan.code === 'BUDGET_EXHAUSTED') return 'BUDGET_EXHAUSTED';
  return refuse('UnmodelledBoundary');
}

/** The store's two methods, each read once and bound to the store. */
function readStore(value) {
  if (value === null || typeof value !== 'object') refuse('InvalidStore');
  const { read, compareAndSet } = value;
  if (typeof read !== 'function' || typeof compareAndSet !== 'function') refuse('InvalidStore');
  return {
    read: (scope) => read.call(value, scope),
    compareAndSet: (scope, expectedVersion, record) => compareAndSet.call(
      value, scope, expectedVersion, record,
    ),
  };
}

/** What the store holds for a scope: no record yet (`NONE`), or one record at a version. */
async function observe(store, scope) {
  // Each field of the answer is read once, so the version checked is the version sent back.
  const { state, version, record: stored } = (await store.read(scope)) ?? {};
  if (state === 'UNSEEN') return { version: 'NONE', record: null };
  if (state !== 'PRESENT' || typeof version !== 'string') refuse('InvalidStore');
  const record = readRecord(stored);
  if (record.scope !== scope) refuse('ScopeMismatch');
  return { version, record };
}

/** Compare-and-set a decided record; a loser on the version is told so and nothing else happens. */
async function commit(store, scope, observed, decision) {
  if (!decision.write) return true;
  const { kind } = (await store.compareAndSet(scope, observed.version, decision.record)) ?? {};
  if (kind === 'STALE') return false;
  if (kind !== 'SET') refuse('InvalidStore');
  return true;
}

const conflict = (scope) => Object.freeze({ kind: 'REVISION_CONFLICT', scope });

/**
 * Run one repair-round attempt behind the breaker. The decided record is compare-and-set before
 * the effect is called, and only an `ALLOW` that won it calls
 * `effect({ scope, attemptKey, round })`. Returns the decision (with `effectResult` after an
 * `ALLOW`) or `REVISION_CONFLICT`. A caller told `REVISION_CONFLICT` asks again: its attempt is
 * then decided on the record that won, so a trip that lost the race to an `ALLOW` is still
 * recorded.
 */
export async function runRepairRound(input) {
  const call = readFields(input, ['store', 'scope', 'attempt', 'policy', 'effect'], 'InvalidCall');
  const store = readStore(call.store);
  if (typeof call.effect !== 'function') refuse('InvalidEffect');
  const scope = readScope(call.scope);
  const attempt = readAttempt(call.attempt);
  const policy = readPolicy(call.policy);
  const observed = await observe(store, scope);
  const decision = decide(observed.record, scope, attempt, policy);
  if (!(await commit(store, scope, observed, decision))) return conflict(scope);
  if (decision.kind !== 'ALLOW') return decision;
  const effectResult = await call.effect(Object.freeze({
    scope, attemptKey: attempt.attemptKey, round: decision.record.rounds,
  }));
  return Object.freeze({ ...decision, effectResult });
}

/** Apply a reset receipt to a scope's stored record. */
export async function applyRepairRoundReset(input) {
  const call = readFields(input, ['store', 'scope', 'receipt'], 'InvalidCall');
  const store = readStore(call.store);
  const scope = readScope(call.scope);
  const receipt = readResetReceipt(call.receipt);
  if (receipt.scope !== scope) refuse('ResetScopeMismatch');
  const observed = await observe(store, scope);
  const decision = reset(observed.record, receipt);
  if (!(await commit(store, scope, observed, decision))) return conflict(scope);
  return decision;
}

/**
 * A compare-and-set store held in memory, keyed by scope. Each call is one atomic step, and it
 * shares no object with its callers. It keeps nothing across a restart: it is for tests and for
 * callers whose breaker lives no longer than one run.
 */
export function createMemoryRepairRoundStore() {
  const records = new Map();
  const calls = [];
  return Object.freeze({
    calls,
    async read(scope) {
      calls.push({ method: 'read', scope });
      const record = records.get(scope);
      if (record === undefined) return { state: 'UNSEEN' };
      return { state: 'PRESENT', version: digest(record), record: structuredClone(record) };
    },
    async compareAndSet(scope, expectedVersion, record) {
      calls.push({ method: 'compareAndSet', scope, expectedVersion });
      const current = records.has(scope) ? digest(records.get(scope)) : 'NONE';
      if (current !== expectedVersion) return { kind: 'STALE', currentVersion: current };
      const stored = structuredClone(record);
      records.set(scope, stored);
      return { kind: 'SET', version: digest(stored) };
    },
  });
}
