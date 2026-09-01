import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const MODULE_URL = new URL('../src/pr-delivery-round-history.mjs', import.meta.url);
const WORK_KEY = 'a'.repeat(64);
const HEAD = '1'.repeat(40);
const DESIGN = '2'.repeat(40);
const RED = '3'.repeat(40);
const GREEN = '4'.repeat(40);
const RECEIPT_0 = 'b'.repeat(64);
const RECEIPT_1 = 'c'.repeat(64);

const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

async function api() {
  const loaded = await import(MODULE_URL);
  for (const name of [
    'createInitialManagedRound', 'planManagedRoundUpdate', 'executeManagedRoundUpdate',
    'DeliveryRoundError',
  ]) assert.equal(typeof loaded[name], name === 'DeliveryRoundError' ? 'function' : 'function');
  return loaded;
}

function evidence(overrides = {}) {
  return {
    designCommit: DESIGN,
    redCommit: RED,
    greenCommit: 'UNKNOWN(NOT_REACHED)',
    testEvidenceReceipt: 'UNKNOWN(NOT_REACHED)',
    reviewVerdicts: ['UNKNOWN(AWAITING_REVIEW)'],
    result: 'IN_PROGRESS',
    nextStep: 'Run the focused RED gate',
    estimate: {
      range: 'UNKNOWN(INSUFFICIENT_HISTORY)',
      confidence: 'UNKNOWN(INSUFFICIENT_HISTORY)',
      origin: 'ready-receipt:141ef124',
    },
    blocker: {
      class: 'UNKNOWN',
      reason: 'AWAITING_FIRST_EVIDENCE',
      owner: 'Gaia delivery pump',
      phaseDeadline: '2026-09-01T22:30:00.000Z',
      nextTransition: 'RED_EVIDENCE_RECORDED',
      escalationAction: 'REQUEST_ARCHITECTURE_REASSESSMENT',
      origin: 'ready-receipt:141ef124',
    },
    origin: 'ready-receipt:141ef124',
    ...overrides,
  };
}

function openReceipt(overrides = {}) {
  return {
    schema: 'GaiaRoundReceiptV0',
    kind: 'OPEN',
    revision: RECEIPT_0,
    ordinal: 0,
    predecessorRoundKey: 'NONE',
    trigger: 'DRAFT_CREATED',
    roundBudget: 2,
    evidence: evidence(),
    ...overrides,
  };
}

function advanceReceipt(predecessorRoundKey, overrides = {}) {
  return {
    schema: 'GaiaRoundReceiptV0',
    kind: 'ADVANCE',
    revision: RECEIPT_1,
    ordinal: 1,
    predecessorRoundKey,
    trigger: 'REPRODUCED_BLOCKER',
    evidence: evidence({
      greenCommit: GREEN,
      testEvidenceReceipt: 'd'.repeat(64),
      reviewVerdicts: ['CHANGES_REQUESTED'],
      result: 'REPAIR_REQUIRED',
      nextStep: 'Apply the bounded repair',
      blocker: {
        class: 'REPRODUCED_FAILURE',
        reason: 'FOCUSED_TEST_FAILED',
        owner: 'issue-51 writer',
        phaseDeadline: '2026-09-01T23:30:00.000Z',
        nextTransition: 'REPAIR_EVIDENCE_RECORDED',
        escalationAction: 'REQUEST_ARCHITECTURE_REASSESSMENT',
        origin: `test-receipt:${'d'.repeat(12)}`,
      },
      origin: `blocker-receipt:${RECEIPT_1.slice(0, 12)}`,
    }),
    ...overrides,
  };
}

function observation(body, overrides = {}) {
  return {
    number: 69,
    headRevision: HEAD,
    body,
    bodyRevision: digest(body),
    ...overrides,
  };
}

test('R0 is byte deterministic and every non-movement field is present', async () => {
  const { createInitialManagedRound } = await api();
  const left = createInitialManagedRound({ workKey: WORK_KEY, receipt: openReceipt() });
  const right = createInitialManagedRound({ workKey: WORK_KEY, receipt: openReceipt() });

  assert.deepEqual(left, right);
  assert.equal(left.kind, 'INITIAL');
  assert.match(left.managedSection, /<!-- gaia-rounds:begin:a{64} -->/u);
  assert.match(left.managedSection, /#### R0/u);
  assert.match(left.managedSection, /Blocker: `UNKNOWN\(AWAITING_FIRST_EVIDENCE\)`/u);
  assert.match(left.managedSection, /Accountable owner: Gaia delivery pump/u);
  assert.match(left.managedSection, /Phase deadline \(intervention boundary\): 2026-09-01T22:30:00\.000Z/u);
  assert.match(left.managedSection, /Next transition: `RED_EVIDENCE_RECORDED`/u);
  assert.match(left.managedSection, /Escalation action: `REQUEST_ARCHITECTURE_REASSESSMENT`/u);
  assert.match(left.managedSection, /Origin: ready-receipt:141ef124/u);
  assert.equal((left.managedSection.match(/#### R0/gu) ?? []).length, 1);
});

test('one durable reproduced blocker advances R0 to R1 while preserving human bytes', async () => {
  const { createInitialManagedRound, planManagedRoundUpdate } = await api();
  const initial = createInitialManagedRound({ workKey: WORK_KEY, receipt: openReceipt() });
  const body = `human prefix\r\n${initial.managedSection}\r\nhuman suffix`;
  const receipt = advanceReceipt(initial.roundKey);

  const plan = planManagedRoundUpdate({
    workKey: WORK_KEY, observation: observation(body), receipt,
  });

  assert.equal(plan.kind, 'PROPOSED');
  assert.equal(plan.expected.number, 69);
  assert.equal(plan.expected.headRevision, HEAD);
  assert.equal(plan.expected.bodyRevision, digest(body));
  assert.equal(plan.idempotencyKey, plan.advanceKey);
  assert.ok(plan.proposedBody.startsWith('human prefix\r\n'));
  assert.ok(plan.proposedBody.endsWith('\r\nhuman suffix'));
  assert.equal((plan.proposedBody.match(/#### R0/gu) ?? []).length, 1);
  assert.equal((plan.proposedBody.match(/#### R1/gu) ?? []).length, 1);
  assert.match(plan.proposedBody, /Blocker: `REPRODUCED_FAILURE\(FOCUSED_TEST_FAILED\)`/u);
});

test('duplicate receipt converges and a competing R1 receipt is a typed stale loser', async () => {
  const { createInitialManagedRound, planManagedRoundUpdate } = await api();
  const initial = createInitialManagedRound({ workKey: WORK_KEY, receipt: openReceipt() });
  const first = planManagedRoundUpdate({
    workKey: WORK_KEY,
    observation: observation(initial.managedSection),
    receipt: advanceReceipt(initial.roundKey),
  });

  const replay = planManagedRoundUpdate({
    workKey: WORK_KEY,
    observation: observation(first.proposedBody),
    receipt: advanceReceipt(initial.roundKey),
  });
  assert.equal(replay.kind, 'ALREADY_APPLIED');
  assert.equal(replay.idempotencyKey, first.idempotencyKey);

  const loser = planManagedRoundUpdate({
    workKey: WORK_KEY,
    observation: observation(first.proposedBody),
    receipt: advanceReceipt(initial.roundKey, { revision: 'e'.repeat(64) }),
  });
  assert.deepEqual({ kind: loser.kind, code: loser.code }, {
    kind: 'REFUSED', code: 'RoundLineageConflict',
  });
});

test('retry, restart, heartbeat, formatting and missing evidence never advance', async (context) => {
  const { createInitialManagedRound, planManagedRoundUpdate } = await api();
  const initial = createInitialManagedRound({ workKey: WORK_KEY, receipt: openReceipt() });
  for (const trigger of ['RETRY', 'RESTART', 'HEARTBEAT', 'FORMATTING']) {
    await context.test(trigger, () => {
      const refused = planManagedRoundUpdate({
        workKey: WORK_KEY,
        observation: observation(initial.managedSection),
        receipt: advanceReceipt(initial.roundKey, { trigger }),
      });
      assert.deepEqual({ kind: refused.kind, code: refused.code }, {
        kind: 'REFUSED', code: 'NonEvidenceEvent',
      });
    });
  }
  const missing = planManagedRoundUpdate({
    workKey: WORK_KEY,
    observation: observation(initial.managedSection),
    receipt: { ...advanceReceipt(initial.roundKey), revision: 'UNKNOWN(MISSING)' },
  });
  assert.deepEqual({ kind: missing.kind, code: missing.code }, {
    kind: 'REFUSED', code: 'MissingBlockerReceipt',
  });
});

test('malformed markers, stale observation and exhausted budget fail closed', async (context) => {
  const { createInitialManagedRound, planManagedRoundUpdate } = await api();
  const initial = createInitialManagedRound({ workKey: WORK_KEY, receipt: openReceipt() });
  const cases = [
    ['', 'ManagedSectionMalformed'],
    [`${initial.managedSection}\n${initial.managedSection}`, 'ManagedSectionMalformed'],
    [initial.managedSection.replace(WORK_KEY, 'f'.repeat(64)), 'ManagedSectionMalformed'],
  ];
  for (const [body, code] of cases) {
    await context.test(code, () => {
      const result = planManagedRoundUpdate({
        workKey: WORK_KEY, observation: observation(body),
        receipt: advanceReceipt(initial.roundKey),
      });
      assert.deepEqual({ kind: result.kind, code: result.code }, { kind: 'REFUSED', code });
    });
  }
  const stale = planManagedRoundUpdate({
    workKey: WORK_KEY,
    observation: observation(initial.managedSection, { bodyRevision: 'f'.repeat(64) }),
    receipt: advanceReceipt(initial.roundKey),
  });
  assert.equal(stale.code, 'StaleBody');

  const oneRound = createInitialManagedRound({
    workKey: WORK_KEY, receipt: openReceipt({ roundBudget: 1 }),
  });
  const exhausted = planManagedRoundUpdate({
    workKey: WORK_KEY, observation: observation(oneRound.managedSection),
    receipt: advanceReceipt(oneRound.roundKey),
  });
  assert.equal(exhausted.code, 'BUDGET_EXHAUSTED');
});

test('deadline is an intervention boundary and emits only a pure escalation intent at expiry', async () => {
  const { createInitialManagedRound, planManagedRoundUpdate } = await api();
  const initial = createInitialManagedRound({ workKey: WORK_KEY, receipt: openReceipt() });
  const before = planManagedRoundUpdate({
    workKey: WORK_KEY,
    observation: observation(initial.managedSection),
    receipt: {
      schema: 'GaiaRoundDeadlineReceiptV0', revision: 'd'.repeat(64),
      observedAt: '2026-09-01T22:29:59.999Z',
    },
  });
  assert.deepEqual({ kind: before.kind, code: before.code }, {
    kind: 'REFUSED', code: 'DeadlineNotReached',
  });

  const expired = planManagedRoundUpdate({
    workKey: WORK_KEY,
    observation: observation(initial.managedSection),
    receipt: {
      schema: 'GaiaRoundDeadlineReceiptV0', revision: 'e'.repeat(64),
      observedAt: '2026-09-01T22:30:00.000Z',
    },
  });
  assert.deepEqual(expired, {
    kind: 'ESCALATE',
    intent: {
      schema: 'GaiaRoundEscalationIntentV0',
      workKey: WORK_KEY,
      roundKey: initial.roundKey,
      owner: 'Gaia delivery pump',
      action: 'REQUEST_ARCHITECTURE_REASSESSMENT',
      deadline: '2026-09-01T22:30:00.000Z',
      observedAt: '2026-09-01T22:30:00.000Z',
      origin: 'ready-receipt:141ef124',
      authority: 'NONE',
    },
  });
  assert.equal('proposedBody' in expired, false);
});

function scriptedAdapter(initial, script) {
  let current = structuredClone(initial);
  const calls = [];
  return {
    calls,
    set(value) { current = structuredClone(value); },
    adapter: {
      async observe(number) {
        calls.push({ method: 'observe', number });
        return structuredClone(current);
      },
      async compareAndSet(effect) {
        calls.push({ method: 'compareAndSet', effect: structuredClone(effect) });
        const step = script.shift() ?? 'APPLY';
        if (typeof step === 'function') return step(effect, current, (next) => { current = next; });
        if (step === 'APPLY') {
          current = observation(effect.proposedBody);
          return { kind: 'ACKNOWLEDGED' };
        }
        return { kind: step };
      },
    },
  };
}

test('effect boundary linearizes at exact CAS and reconciles an ambiguous acknowledgement', async () => {
  const { createInitialManagedRound, executeManagedRoundUpdate } = await api();
  const initial = createInitialManagedRound({ workKey: WORK_KEY, receipt: openReceipt() });
  const state = observation(initial.managedSection);
  const fixture = scriptedAdapter(state, [
    (effect, _current, set) => {
      set(observation(effect.proposedBody));
      return { kind: 'AMBIGUOUS' };
    },
  ]);

  const result = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69,
    receipt: advanceReceipt(initial.roundKey), adapter: fixture.adapter,
  });

  assert.equal(result.kind, 'APPLIED');
  assert.equal(result.attempts, 1);
  assert.equal(fixture.calls.filter((call) => call.method === 'compareAndSet').length, 1,
    'ambiguous success is reconciled before any retry');
});

test('forced CAS mutation preserves human edits and stale losers perform no effect', async () => {
  const { createInitialManagedRound, executeManagedRoundUpdate } = await api();
  const initial = createInitialManagedRound({ workKey: WORK_KEY, receipt: openReceipt() });
  const fixture = scriptedAdapter(observation(`before\n${initial.managedSection}\nafter`), [
    (_effect, current, set) => {
      set(observation(`human edit\n${current.body}`));
      return { kind: 'STALE' };
    },
    'APPLY',
  ]);

  const result = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69,
    receipt: advanceReceipt(initial.roundKey), adapter: fixture.adapter,
  });
  assert.equal(result.kind, 'APPLIED');
  assert.equal(result.attempts, 2);
  assert.ok(result.observed.body.startsWith('human edit\nbefore\n'));

  const winnerBody = result.observed.body;
  const loser = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69,
    receipt: advanceReceipt(initial.roundKey, { revision: 'f'.repeat(64) }),
    adapter: fixture.adapter,
  });
  assert.deepEqual({ kind: loser.kind, code: loser.code }, {
    kind: 'REFUSED', code: 'RoundLineageConflict',
  });
  assert.equal(result.observed.body, winnerBody);
  assert.equal(fixture.calls.filter((call) => call.method === 'compareAndSet').length, 2);
});

test('five unproved postconditions end in typed POSTCONDITION_UNPROVEN', async () => {
  const { createInitialManagedRound, executeManagedRoundUpdate } = await api();
  const initial = createInitialManagedRound({ workKey: WORK_KEY, receipt: openReceipt() });
  const fixture = scriptedAdapter(observation(initial.managedSection), Array(5).fill('AMBIGUOUS'));

  const result = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69,
    receipt: advanceReceipt(initial.roundKey), adapter: fixture.adapter,
  });

  assert.equal(result.kind, 'BLOCKED');
  assert.equal(result.code, 'POSTCONDITION_UNPROVEN');
  assert.equal(result.attempts, 5);
  assert.equal(result.observed.bodyRevision, digest(initial.managedSection));
  assert.equal(fixture.calls.filter((call) => call.method === 'compareAndSet').length, 5);
});

