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
const ACCOUNTABLE = 'github:user:gaia-operator';
const SUPERVISOR = `gaia:operation:${'5'.repeat(64)}`;
const EXECUTION = `gaia:lane:${'6'.repeat(64)}:${HEAD}`;
const EFFECT = 'github:app:gaia-draft-pump';

const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

async function api() {
  const loaded = await import(MODULE_URL);
  for (const name of [
    'createInitialManagedRound', 'planManagedRoundUpdate', 'executeManagedRoundUpdate',
    'executeManagedDraftCreation', 'createMemoryManagedRoundAdapter',
    'createGitHubManagedRoundAdapter', 'createMemoryManagedRoundEvidencePort',
    'createGitHubManagedRoundEvidencePort',
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
      owner: ACCOUNTABLE,
      phaseDeadline: '2026-09-01T22:30:00.000Z',
      nextTransition: 'RED_EVIDENCE_RECORDED',
      escalationAction: 'REQUEST_ARCHITECTURE_REASSESSMENT',
      origin: 'ready-receipt:141ef124',
    },
    origin: 'ready-receipt:141ef124',
    ...overrides,
  };
}

function responsibility(overrides = {}) {
  return {
    ownershipRevision: '7'.repeat(64),
    accountableOwner: ACCOUNTABLE,
    supervisor: SUPERVISOR,
    executionOwner: EXECUTION,
    reportsTo: SUPERVISOR,
    reviewOwners: {
      standards: 'github:user:standards-reviewer',
      spec: 'github:user:spec-reviewer',
    },
    effectOwner: EFFECT,
    escalatesTo: ACCOUNTABLE,
    ...overrides,
  };
}

function command(overrides = {}) {
  return {
    commandRevision: '8'.repeat(64),
    commandOwner: SUPERVISOR,
    commandPath: [SUPERVISOR, EXECUTION],
    generation: HEAD,
    capabilities: ['ASSIGN', 'REVOKE', 'STOP', 'RETRY', 'ESCALATE'],
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
    responsibility: responsibility(),
    command: command(),
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
    responsibility: responsibility(),
    command: command(),
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

function effectClaim(claimId = '9'.repeat(64), overrides = {}) {
  return {
    schema: 'GaiaManagedRoundEffectClaimV0', revision: '8'.repeat(64), claimId,
    observedAt: '2026-09-01T22:40:00.000Z',
    leaseExpiresAt: '2026-09-01T22:45:00.000Z',
    ...overrides,
  };
}

function githubApiFixture(initial = []) {
  const drafts = new Map(initial.map((item) => [item.number, structuredClone(item)]));
  const operations = new Map();
  const calls = [];
  let nextNumber = 69;
  return {
    calls,
    api: {
      async createDraft(effect) {
        calls.push({ method: 'createDraft', effect: structuredClone(effect) });
        const number = nextNumber;
        nextNumber += 1;
        const created = observation(effect.proposedBody, {
          number, headRevision: effect.expectedHeadRevision,
        });
        drafts.set(number, created);
        operations.set(effect.operationId, number);
        return { kind: 'ACKNOWLEDGED', number };
      },
      async observe(number) {
        calls.push({ method: 'observe', number });
        return structuredClone(drafts.get(number) ?? null);
      },
      async observeByOperation(operationId) {
        calls.push({ method: 'observeByOperation', operationId });
        const number = operations.get(operationId);
        return number === undefined ? null : structuredClone(drafts.get(number));
      },
      async compareAndSetBody(effect) {
        calls.push({ method: 'compareAndSetBody', effect: structuredClone(effect) });
        const current = drafts.get(effect.number);
        if (current?.headRevision !== effect.expectedHeadRevision
          || current?.bodyRevision !== effect.expectedBodyRevision) return { kind: 'STALE' };
        const updated = observation(effect.proposedBody, {
          number: effect.number, headRevision: effect.expectedHeadRevision,
        });
        drafts.set(effect.number, updated);
        operations.set(effect.operationId, effect.number);
        return { kind: 'ACKNOWLEDGED' };
      },
    },
  };
}

test('R0 is byte deterministic and every non-movement field is present', async () => {
  const { createInitialManagedRound } = await api();
  const left = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
  const right = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });

  assert.deepEqual(left, right);
  assert.equal(left.kind, 'INITIAL');
  assert.match(left.managedSection, /<!-- gaia-rounds:begin:a{64} -->/u);
  assert.match(left.managedSection, /#### R0/u);
  assert.match(left.managedSection, /Blocker: `UNKNOWN\(AWAITING_FIRST_EVIDENCE\)`/u);
  assert.match(left.managedSection, /Blocker owner: github:user:gaia-operator/u);
  assert.match(left.managedSection, /Phase deadline \(intervention boundary\): 2026-09-01T22:30:00\.000Z/u);
  assert.match(left.managedSection, /Next transition: `RED_EVIDENCE_RECORDED`/u);
  assert.match(left.managedSection, /Escalation action: `REQUEST_ARCHITECTURE_REASSESSMENT`/u);
  assert.match(left.managedSection, /Origin: ready-receipt:141ef124/u);
  assert.match(left.managedSection, /Accountable owner: `github:user:gaia-operator`/u);
  assert.match(left.managedSection, /Supervisor: `gaia:operation:/u);
  assert.match(left.managedSection, /Execution owner: `gaia:lane:/u);
  assert.match(left.managedSection, /Reports to: `gaia:operation:/u);
  assert.match(left.managedSection, /Standards review owner: `github:user:standards-reviewer`/u);
  assert.match(left.managedSection, /Spec review owner: `github:user:spec-reviewer`/u);
  assert.match(left.managedSection, /Effect owner: `github:app:gaia-draft-pump`/u);
  assert.match(left.managedSection, /Escalates to: `github:user:gaia-operator`/u);
  assert.match(left.managedSection, /Command owner: `gaia:operation:/u);
  assert.match(left.managedSection, /Command path: `gaia:operation:[^`]+ -> gaia:lane:/u);
  assert.match(left.managedSection, /Command generation: `1{40}`/u);
  assert.equal((left.managedSection.match(/#### R0/gu) ?? []).length, 1);
});

test('one durable reproduced blocker advances R0 to R1 while preserving human bytes', async () => {
  const { createInitialManagedRound, planManagedRoundUpdate } = await api();
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
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
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
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
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
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
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
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
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt({ roundBudget: 1 }),
  });
  const exhausted = planManagedRoundUpdate({
    workKey: WORK_KEY, observation: observation(oneRound.managedSection),
    receipt: advanceReceipt(oneRound.roundKey),
  });
  assert.equal(exhausted.code, 'BUDGET_EXHAUSTED');
});

test('deadline is an intervention boundary and emits only a pure escalation intent at expiry', async () => {
  const { createInitialManagedRound, planManagedRoundUpdate } = await api();
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
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
      owner: ACCOUNTABLE,
      action: 'REQUEST_ARCHITECTURE_REASSESSMENT',
      deadline: '2026-09-01T22:30:00.000Z',
      observedAt: '2026-09-01T22:30:00.000Z',
      origin: 'ready-receipt:141ef124',
      authority: 'NONE',
    },
  });
  assert.equal('proposedBody' in expired, false);
});

test('responsibility and command chains refuse missing links, cycles, or duplicate authority', async (context) => {
  const { createInitialManagedRound, DeliveryRoundError } = await api();
  const invalid = [
    ['missing accountable owner', (() => {
      const value = responsibility();
      delete value.accountableOwner;
      return { responsibility: value };
    })(), 'ResponsibilityMalformed'],
    ['unresolvable reportsTo', {
      responsibility: responsibility({ reportsTo: 'github:user:unrelated' }),
    }, 'UnresolvableReportsTo'],
    ['duplicate effect authority', {
      responsibility: responsibility({ effectOwner: [EFFECT, 'github:app:other'] }),
    }, 'DuplicateEffectAuthority'],
    ['review owner overlaps effect owner', {
      responsibility: responsibility({
        reviewOwners: { standards: EFFECT, spec: 'github:user:spec-reviewer' },
      }),
    }, 'ReviewOwnerConflict'],
    ['command self-cycle', {
      command: command({ commandPath: [SUPERVISOR, SUPERVISOR] }),
    }, 'CommandCycle'],
    ['orphan execution lane', {
      command: command({ commandPath: [SUPERVISOR, `gaia:lane:${'9'.repeat(64)}:${HEAD}`] }),
    }, 'OrphanExecutionOwner'],
    ['dual commanders', {
      command: command({ commandOwner: [SUPERVISOR, ACCOUNTABLE] }),
    }, 'DualCommandOwner'],
    ['stale generation', {
      command: command({ generation: '9'.repeat(40) }),
    }, 'StaleCommandGeneration'],
  ];

  for (const [name, override, code] of invalid) {
    await context.test(name, () => {
      const receipt = openReceipt({
        responsibility: override.responsibility ?? responsibility(),
        command: override.command ?? command(),
      });
      assert.throws(
        () => createInitialManagedRound({ workKey: WORK_KEY, headRevision: HEAD, receipt }),
        (error) => error instanceof DeliveryRoundError && error.code === code,
      );
    });
  }
});

test('revision-bound owner handoff advances once and stale ownership claims are refused', async () => {
  const { createInitialManagedRound, planManagedRoundUpdate } = await api();
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
  const nextExecution = `gaia:lane:${'9'.repeat(64)}:${HEAD}`;
  const handoff = advanceReceipt(initial.roundKey, {
    responsibility: responsibility({
      ownershipRevision: '9'.repeat(64), executionOwner: nextExecution,
    }),
    command: command({
      commandRevision: 'e'.repeat(64), commandPath: [SUPERVISOR, nextExecution],
    }),
  });
  const plan = planManagedRoundUpdate({
    workKey: WORK_KEY, observation: observation(initial.managedSection), receipt: handoff,
  });
  assert.equal(plan.kind, 'PROPOSED');
  assert.ok(plan.proposedBody.includes(`Execution owner: ${'`'}${nextExecution}${'`'}`));
  assert.match(plan.proposedBody, /Ownership revision: `9{64}`/u);
  assert.match(plan.proposedBody, /Command revision: `e{64}`/u);

  const replay = planManagedRoundUpdate({
    workKey: WORK_KEY, observation: observation(plan.proposedBody), receipt: handoff,
  });
  assert.equal(replay.kind, 'ALREADY_APPLIED');

  const staleClaim = planManagedRoundUpdate({
    workKey: WORK_KEY,
    observation: observation(initial.managedSection),
    receipt: advanceReceipt(initial.roundKey, {
      responsibility: responsibility({ executionOwner: nextExecution }),
      command: command({ commandRevision: 'e'.repeat(64), commandPath: [SUPERVISOR, nextExecution] }),
    }),
  });
  assert.deepEqual({ kind: staleClaim.kind, code: staleClaim.code }, {
    kind: 'REFUSED', code: 'OwnershipRevisionRequired',
  });
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
  const {
    createInitialManagedRound, executeManagedRoundUpdate, createMemoryManagedRoundEvidencePort,
  } = await api();
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
  const state = observation(initial.managedSection);
  const fixture = scriptedAdapter(state, [
    (effect, _current, set) => {
      set(observation(effect.proposedBody));
      return { kind: 'AMBIGUOUS' };
    },
  ]);

  const result = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69,
    receipt: advanceReceipt(initial.roundKey), effectActor: EFFECT, adapter: fixture.adapter,
    evidencePort: createMemoryManagedRoundEvidencePort(),
  });

  assert.equal(result.kind, 'APPLIED');
  assert.equal(result.attempts, 1);
  assert.equal(fixture.calls.filter((call) => call.method === 'compareAndSet').length, 1,
    'ambiguous success is reconciled before any retry');
});

test('forced CAS mutation preserves human edits and stale losers perform no effect', async () => {
  const {
    createInitialManagedRound, executeManagedRoundUpdate, createMemoryManagedRoundEvidencePort,
  } = await api();
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
  const fixture = scriptedAdapter(observation(`before\n${initial.managedSection}\nafter`), [
    (_effect, current, set) => {
      set(observation(`human edit\n${current.body}`));
      return { kind: 'STALE' };
    },
    'APPLY',
  ]);

  const result = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69,
    receipt: advanceReceipt(initial.roundKey), effectActor: EFFECT, adapter: fixture.adapter,
    evidencePort: createMemoryManagedRoundEvidencePort(),
  });
  assert.equal(result.kind, 'APPLIED');
  assert.equal(result.attempts, 2);
  assert.ok(result.observed.body.startsWith('human edit\nbefore\n'));

  const winnerBody = result.observed.body;
  const loser = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69,
    receipt: advanceReceipt(initial.roundKey, { revision: 'f'.repeat(64) }),
    effectActor: EFFECT, adapter: fixture.adapter,
    evidencePort: createMemoryManagedRoundEvidencePort(),
  });
  assert.deepEqual({ kind: loser.kind, code: loser.code }, {
    kind: 'REFUSED', code: 'RoundLineageConflict',
  });
  assert.equal(result.observed.body, winnerBody);
  assert.equal(fixture.calls.filter((call) => call.method === 'compareAndSet').length, 2);

  const managedMutation = scriptedAdapter(observation(initial.managedSection), [
    (_effect, current, set) => {
      set(observation(current.body.replace('Result: `IN_PROGRESS`', 'Result: `HUMAN_EDIT`')));
      return { kind: 'STALE' };
    },
  ]);
  const conflict = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69,
    receipt: advanceReceipt(initial.roundKey), effectActor: EFFECT,
    adapter: managedMutation.adapter,
    evidencePort: createMemoryManagedRoundEvidencePort(),
  });
  assert.deepEqual({ kind: conflict.kind, code: conflict.code }, {
    kind: 'REFUSED', code: 'ManagedSectionConflict',
  });
  assert.equal(managedMutation.calls.filter((call) => call.method === 'compareAndSet').length, 1,
    'a managed-section mutation is never merged or retried');
});

test('five unproved postconditions end in typed POSTCONDITION_UNPROVEN', async () => {
  const {
    createInitialManagedRound, executeManagedRoundUpdate, createMemoryManagedRoundEvidencePort,
  } = await api();
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
  const fixture = scriptedAdapter(observation(initial.managedSection), Array(5).fill('AMBIGUOUS'));

  const result = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69,
    receipt: advanceReceipt(initial.roundKey), effectActor: EFFECT, adapter: fixture.adapter,
    evidencePort: createMemoryManagedRoundEvidencePort(),
  });

  assert.equal(result.kind, 'BLOCKED');
  assert.equal(result.code, 'POSTCONDITION_UNPROVEN');
  assert.equal(result.attempts, 5);
  assert.equal(result.observed.bodyRevision, digest(initial.managedSection));
  assert.equal(fixture.calls.filter((call) => call.method === 'compareAndSet').length, 5);
});

test('only the single receipt-bound effect owner reaches CAS and handoffs are read-back proven', async () => {
  const {
    createInitialManagedRound, executeManagedRoundUpdate, createMemoryManagedRoundEvidencePort,
  } = await api();
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
  const nextExecution = `gaia:lane:${'9'.repeat(64)}:${HEAD}`;
  const receipt = advanceReceipt(initial.roundKey, {
    responsibility: responsibility({
      ownershipRevision: '9'.repeat(64), executionOwner: nextExecution,
    }),
    command: command({
      commandRevision: 'e'.repeat(64), commandPath: [SUPERVISOR, nextExecution],
    }),
  });

  for (const effectActor of ['github:app:wrong-owner', 'NONE']) {
    const denied = scriptedAdapter(observation(initial.managedSection), []);
    const result = await executeManagedRoundUpdate({
      workKey: WORK_KEY, number: 69, receipt, effectActor, adapter: denied.adapter,
      evidencePort: createMemoryManagedRoundEvidencePort(),
    });
    assert.deepEqual({ kind: result.kind, code: result.code }, {
      kind: 'REFUSED', code: 'EffectOwnerMismatch',
    });
    assert.equal(denied.calls.filter((call) => call.method === 'compareAndSet').length, 0);
  }

  const allowed = scriptedAdapter(observation(initial.managedSection), ['APPLY']);
  const applied = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69, receipt, effectActor: EFFECT, adapter: allowed.adapter,
    evidencePort: createMemoryManagedRoundEvidencePort(),
  });
  assert.equal(applied.kind, 'APPLIED');
  assert.equal(applied.attempts, 1);
  assert.ok(applied.observed.body.includes(nextExecution));
  assert.equal(allowed.calls.filter((call) => call.method === 'compareAndSet').length, 1);
});

test('every managed Draft is created with canonical R0 through both public adapters', async (context) => {
  const {
    createInitialManagedRound, executeManagedDraftCreation, createMemoryManagedRoundAdapter,
    createGitHubManagedRoundAdapter, createMemoryManagedRoundEvidencePort, DeliveryRoundError,
  } = await api();
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
  const github = githubApiFixture();
  const cases = [
    ['memory', createMemoryManagedRoundAdapter(), null],
    ['github', createGitHubManagedRoundAdapter({ api: github.api }), github],
  ];

  for (const [name, adapter, fixture] of cases) {
    await context.test(name, async () => {
      const evidencePort = createMemoryManagedRoundEvidencePort();
      const result = await executeManagedDraftCreation({
        workKey: WORK_KEY,
        headRevision: HEAD,
        baseBody: 'human-authored prefix\r\nwith exact bytes',
        receipt: openReceipt(),
        effectActor: EFFECT,
        effectClaim: effectClaim(),
        adapter,
        evidencePort,
      });
      assert.equal(result.kind, 'APPLIED');
      assert.equal(result.operationId, initial.roundKey);
      assert.equal(result.observed.body,
        `human-authored prefix\r\nwith exact bytes\n\n${initial.managedSection}`);
      assert.equal((result.observed.body.match(/<!-- gaia-rounds:begin:/gu) ?? []).length, 1);
      assert.equal((result.observed.body.match(/#### R0/gu) ?? []).length, 1);
      const evidenceSnapshot = await evidencePort.read(WORK_KEY);
      assert.deepEqual(
        evidenceSnapshot.records.map((record) => record.kind), ['INTENT', 'CLAIM', 'APPLIED'],
      );
      if (fixture) {
        assert.equal(fixture.calls.filter((call) => call.method === 'createDraft').length, 1);
        assert.ok(fixture.calls.some((call) => call.method === 'observeByOperation'));
      }
    });
  }

  assert.throws(
    () => createGitHubManagedRoundAdapter({
      api: { createDraft() {}, observe() {}, observeByOperation() {} },
    }),
    (error) => error instanceof DeliveryRoundError && error.code === 'AtomicCasUnavailable',
  );
});

test('one black-box R0-to-R1 effect contract agrees across memory and GitHub adapters', async (context) => {
  const {
    createInitialManagedRound, executeManagedRoundUpdate, createMemoryManagedRoundAdapter,
    createGitHubManagedRoundAdapter, createMemoryManagedRoundEvidencePort,
  } = await api();
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
  const starting = observation(`before\n${initial.managedSection}\nafter`);
  const github = githubApiFixture([starting]);
  const cases = [
    ['memory', createMemoryManagedRoundAdapter({ observations: [starting] })],
    ['github', createGitHubManagedRoundAdapter({ api: github.api })],
  ];
  const results = [];

  for (const [name, adapter] of cases) {
    await context.test(name, async () => {
      const result = await executeManagedRoundUpdate({
        workKey: WORK_KEY,
        number: 69,
        receipt: advanceReceipt(initial.roundKey),
        effectActor: EFFECT,
        adapter,
        evidencePort: createMemoryManagedRoundEvidencePort(),
      });
      assert.equal(result.kind, 'APPLIED');
      assert.equal((result.observed.body.match(/#### R1/gu) ?? []).length, 1);
      results.push(JSON.parse(JSON.stringify(result)));
    });
  }
  assert.deepEqual(results[0], results[1]);
  assert.equal(github.calls.filter((call) => call.method === 'compareAndSetBody').length, 1);
});

test('GitHub evidence persists INTENT and read-back-proven APPLIED before byte-identical success', async () => {
  const {
    executeManagedDraftCreation, createMemoryManagedRoundAdapter,
    createGitHubManagedRoundEvidencePort,
  } = await api();
  const records = [];
  const calls = [];
  const trace = [];
  const gitData = {
    async read(ref) {
      calls.push({ method: 'read', ref });
      trace.push('evidence:read');
      return records.length === 0 ? { state: 'UNSEEN' } : {
        state: 'PRESENT',
        records: records.map((record) => structuredClone(record)),
      };
    },
    async compareAndAppend(ref, expectedHeadOid, body) {
      calls.push({ method: 'compareAndAppend', ref, expectedHeadOid, body: structuredClone(body) });
      trace.push(`evidence:${body.kind}`);
      const current = records.at(-1)?.oid ?? 'NONE';
      if (current !== expectedHeadOid) return { kind: 'STALE', currentHeadOid: current };
      const oid = String(records.length + 1).repeat(40);
      const record = { oid, body: structuredClone(body), committedRevision: digest(JSON.stringify(body)) };
      records.push(record);
      return { kind: 'APPENDED', ...structuredClone(record) };
    },
  };
  const evidencePort = createGitHubManagedRoundEvidencePort({ gitData });
  const memoryAdapter = createMemoryManagedRoundAdapter();
  const adapter = {
    observe: (...args) => memoryAdapter.observe(...args),
    observeByOperation: (...args) => memoryAdapter.observeByOperation(...args),
    compareAndSet: (...args) => memoryAdapter.compareAndSet(...args),
    async createDraft(...args) {
      trace.push('provider:createDraft');
      return memoryAdapter.createDraft(...args);
    },
  };
  const input = {
    workKey: WORK_KEY, headRevision: HEAD, baseBody: 'human', receipt: openReceipt(),
    effectActor: EFFECT, effectClaim: effectClaim(), adapter, evidencePort,
  };

  const first = await executeManagedDraftCreation(input);
  assert.equal(first.kind, 'APPLIED');
  assert.deepEqual(records.map((record) => record.body.kind), ['INTENT', 'CLAIM', 'APPLIED']);
  assert.ok(calls.filter((call) => call.method === 'read').length >= 4,
    'each durable append is reconciled through read-after-write');
  assert.ok(trace.indexOf('evidence:INTENT') < trace.indexOf('provider:createDraft'));
  assert.ok(trace.indexOf('evidence:CLAIM') < trace.indexOf('provider:createDraft'));
  assert.ok(trace.indexOf('provider:createDraft') < trace.indexOf('evidence:APPLIED'));
  const intentAppend = trace.indexOf('evidence:INTENT');
  assert.equal(trace[intentAppend + 1], 'evidence:read',
    'durable intent is read back before the provider effect');
  assert.deepEqual(records[2].body.providerReceipt, {
    schema: 'GaiaGitHubRoundEffectReceiptV0',
    operationId: first.operationId,
    number: first.observed.number,
    headRevision: HEAD,
    bodyRevision: first.observed.bodyRevision,
  });

  const replay = await executeManagedDraftCreation(input);
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
  assert.equal(memoryAdapter.calls.filter((call) => call.method === 'createDraft').length, 1);
});

test('durable intent CAS makes a competing advance a stale loser with no provider effect', async () => {
  const {
    createInitialManagedRound, executeManagedRoundUpdate, createMemoryManagedRoundAdapter,
    createMemoryManagedRoundEvidencePort,
  } = await api();
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD, receipt: openReceipt(),
  });
  const adapter = createMemoryManagedRoundAdapter({
    observations: [observation(initial.managedSection)],
  });
  const evidencePort = createMemoryManagedRoundEvidencePort();
  const winner = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69, receipt: advanceReceipt(initial.roundKey),
    effectActor: EFFECT, adapter, evidencePort,
  });
  assert.equal(winner.kind, 'APPLIED');

  const loser = await executeManagedRoundUpdate({
    workKey: WORK_KEY, number: 69,
    receipt: advanceReceipt(initial.roundKey, { revision: 'f'.repeat(64) }),
    effectActor: EFFECT, adapter, evidencePort,
  });
  assert.deepEqual({ kind: loser.kind, code: loser.code }, {
    kind: 'REFUSED', code: 'RoundLineageConflict',
  });
  assert.equal(adapter.calls.filter((call) => call.method === 'compareAndSet').length, 1);
});

test('two same-operation creators linearize on one durable claim before provider effect', async () => {
  const {
    executeManagedDraftCreation, createMemoryManagedRoundEvidencePort,
  } = await api();
  let firstObservations = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let current = null;
  let creates = 0;
  const adapter = {
    async observe() { return current === null ? null : structuredClone(current); },
    async observeByOperation() {
      if (firstObservations < 2) {
        firstObservations += 1;
        if (firstObservations === 2) release();
        await barrier;
        return null;
      }
      return current === null ? null : structuredClone(current);
    },
    async createDraft(effect) {
      creates += 1;
      current = observation(effect.proposedBody);
      return { kind: 'ACKNOWLEDGED', number: 69 };
    },
    async compareAndSet() { return { kind: 'STALE' }; },
  };
  const evidencePort = createMemoryManagedRoundEvidencePort();
  const input = {
    workKey: WORK_KEY, headRevision: HEAD, baseBody: 'human', receipt: openReceipt(),
    effectActor: EFFECT, adapter, evidencePort,
  };

  const [left, right] = await Promise.all([
    executeManagedDraftCreation({ ...input, effectClaim: effectClaim('a'.repeat(64)) }),
    executeManagedDraftCreation({ ...input, effectClaim: effectClaim('b'.repeat(64), {
      revision: '7'.repeat(64),
    }) }),
  ]);

  assert.equal(creates, 1);
  assert.equal([left, right].filter((result) => result.kind === 'APPLIED').length, 1);
  assert.equal([left, right].filter(
    (result) => result.kind === 'REFUSED' && result.code === 'EffectClaimHeld',
  ).length, 1);
});

test('a crashed create claim is held until its exact lease boundary, then replaced once', async () => {
  const {
    executeManagedDraftCreation, createMemoryManagedRoundEvidencePort,
  } = await api();
  let current = null;
  let creates = 0;
  const adapter = {
    async observe() { return current === null ? null : structuredClone(current); },
    async observeByOperation() { return current === null ? null : structuredClone(current); },
    async createDraft(effect) {
      creates += 1;
      if (creates === 1) return { kind: 'AMBIGUOUS' };
      current = observation(effect.proposedBody);
      return { kind: 'ACKNOWLEDGED', number: 69 };
    },
    async compareAndSet() { return { kind: 'STALE' }; },
  };
  const evidencePort = createMemoryManagedRoundEvidencePort();
  const input = {
    workKey: WORK_KEY, headRevision: HEAD, baseBody: 'human', receipt: openReceipt(),
    effectActor: EFFECT, adapter, evidencePort,
  };

  const crashed = await executeManagedDraftCreation({
    ...input, effectClaim: effectClaim('c'.repeat(64)),
  });
  assert.deepEqual({ kind: crashed.kind, code: crashed.code }, {
    kind: 'BLOCKED', code: 'POSTCONDITION_UNPROVEN',
  });

  const early = await executeManagedDraftCreation({
    ...input,
    effectClaim: effectClaim('d'.repeat(64), {
      revision: '6'.repeat(64), observedAt: '2026-09-01T22:44:59.999Z',
      leaseExpiresAt: '2026-09-01T22:49:59.999Z',
    }),
  });
  assert.deepEqual({ kind: early.kind, code: early.code }, {
    kind: 'REFUSED', code: 'EffectClaimHeld',
  });
  assert.equal(creates, 1);

  const recovered = await executeManagedDraftCreation({
    ...input,
    effectClaim: effectClaim('e'.repeat(64), {
      revision: '7'.repeat(64), observedAt: '2026-09-01T22:45:00.000Z',
      leaseExpiresAt: '2026-09-01T22:50:00.000Z',
    }),
  });
  assert.equal(recovered.kind, 'APPLIED');
  assert.equal(creates, 2);
  const snapshot = await evidencePort.read(WORK_KEY);
  assert.deepEqual(snapshot.records.map((record) => record.kind), [
    'INTENT', 'CLAIM', 'CLAIM', 'APPLIED',
  ]);
});
