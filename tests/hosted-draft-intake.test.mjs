import assert from 'node:assert/strict';
import test from 'node:test';

const MODULE_URL = new URL('../src/hosted-draft-pump.mjs', import.meta.url);
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

const REPOSITORY = Object.freeze({ owner: 'GuitarAlchemist', name: 'gaia' });

function selectorFor(number) {
  return Object.freeze({
    repository: REPOSITORY,
    workItem: Object.freeze({ kind: 'ISSUE', number }),
  });
}

const moduleResult = import(MODULE_URL).catch((loadError) => ({ loadError }));

async function loaded() {
  const value = await moduleResult;
  if (value.loadError) assert.fail(`hosted runner missing: ${value.loadError.code}`);
  return value;
}

// Positive control: the module already loads and already exports the two wired-to-nothing
// runners. Every failure below is therefore the missing intake mechanism, not a broken fixture.
test('positive control: the existing hosted pump runners are present and callable', async () => {
  const mod = await loaded();
  assert.equal(typeof mod.runHostedDraftPump, 'function');
  assert.equal(typeof mod.runHostedDraftSupervisor, 'function');

  const receipt = await mod.runHostedDraftPump({ selector: selectorFor(60) }, {
    operationPorts: {},
    async enqueueDraft() { return { kind: 'StaleRevision', currentCommittedRevision: SHA_A }; },
    async reconcileDraft() { assert.fail('a rejected enqueue performs no effect'); },
  });
  assert.equal(receipt.result.kind, 'StaleRevision');
});

async function intake() {
  const mod = await loaded();
  assert.equal(
    typeof mod.runHostedDraftIntake, 'function',
    'runHostedDraftIntake must be exported from src/hosted-draft-pump.mjs',
  );
  return mod.runHostedDraftIntake;
}

test('an unsettled operation is resumed before any candidate is listed or admitted', async () => {
  const run = await intake();
  const calls = [];
  const receipt = await run({ repository: REPOSITORY, candidates: [61, 62] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() {
      calls.push('listUnsettled');
      return [{
        operationId: SHA_A, workKey: SHA_B, committedRevision: SHA_C, selector: selectorFor(51),
      }];
    },
    async listReadyIssues() { assert.fail('resume must precede candidate listing'); },
    async enqueueDraft() { assert.fail('a resuming run admits no new work'); },
    async reconcileDraft(operationId, expected) {
      calls.push(['reconcile', operationId, expected]);
      return {
        kind: 'Terminal', outcome: 'CREATED', effect: 'CREATE_DRAFT',
        operationId, committedRevision: SHA_D,
      };
    },
  });

  assert.deepEqual(calls[0], 'listUnsettled');
  assert.deepEqual(calls[1], ['reconcile', SHA_A, SHA_C]);
  assert.equal(calls.length, 2);
  assert.equal(receipt.phase, 'RESUME');
  assert.equal(receipt.operationId, SHA_A);
  assert.deepEqual(receipt.skipped, []);
});

test('candidates are probed in ascending order, terminal keys skipped, at most one admitted', async () => {
  const run = await intake();
  const enqueued = [];
  let reconciles = 0;
  const receipt = await run({ repository: REPOSITORY, candidates: [63, 51, 52] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return []; },
    async enqueueDraft(selector, expected) {
      assert.equal(expected, 'NONE');
      const { number } = selector.workItem;
      enqueued.push(number);
      if (number === 63) return { kind: 'Enqueued', operationId: SHA_A, workKey: SHA_B,
        generationKey: SHA_C, committedRevision: SHA_C };
      return { kind: 'StaleRevision', currentCommittedRevision: SHA_D };
    },
    async reconcileDraft(operationId) {
      reconciles += 1;
      return {
        kind: 'Terminal', outcome: 'CREATED', effect: 'CREATE_DRAFT',
        operationId, committedRevision: SHA_D,
      };
    },
  });

  // 51 and 52 are terminal at base; probing must reach 63 and stop there.
  assert.deepEqual(enqueued, [51, 52, 63]);
  assert.equal(reconciles, 1);
  assert.equal(receipt.phase, 'ADMIT');
  assert.equal(receipt.operationId, SHA_A);
  assert.deepEqual(receipt.skipped, [
    { number: 51, reason: 'StaleRevision' },
    { number: 52, reason: 'StaleRevision' },
  ]);
});

test('an empty candidate set is a closed EXPECTED_NONE no-op', async () => {
  const run = await intake();
  const receipt = await run({ repository: REPOSITORY, candidates: [] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return []; },
    async enqueueDraft() { assert.fail('no candidate means no admission'); },
    async reconcileDraft() { assert.fail('no candidate means no effect'); },
  });

  assert.equal(receipt.phase, 'EXPECTED_NONE');
  assert.equal(receipt.operationId, null);
  assert.equal(receipt.workKey, null);
  assert.equal(receipt.committedRevision, null);
  assert.deepEqual(receipt.skipped, []);
});

test('a typed collection failure skips the candidate and never admits a second one', async () => {
  const run = await intake();
  const enqueued = [];
  let reconciles = 0;
  const receipt = await run({ repository: REPOSITORY, candidates: [64, 65, 66] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return []; },
    async enqueueDraft(selector) {
      const { number } = selector.workItem;
      enqueued.push(number);
      if (number === 64) {
        const error = new Error('IssueNotReady');
        error.code = 'IssueNotReady';
        throw error;
      }
      return { kind: 'Enqueued', operationId: SHA_A, workKey: SHA_B,
        generationKey: SHA_C, committedRevision: SHA_C };
    },
    async reconcileDraft(operationId) {
      reconciles += 1;
      return { kind: 'Pending', operationId, committedRevision: SHA_D };
    },
  });

  assert.deepEqual(enqueued, [64, 65]);
  assert.equal(reconciles, 1, 'exactly one candidate may be admitted per run');
  assert.equal(receipt.phase, 'ADMIT');
  assert.deepEqual(receipt.skipped, [{ number: 64, reason: 'IssueNotReady' }]);
});

test('probing is bounded and stops without admitting when every candidate is terminal', async () => {
  const run = await intake();
  const enqueued = [];
  const receipt = await run(
    { repository: REPOSITORY, candidates: [1, 2, 3, 4, 5, 6, 7], limit: 5 },
    {
      ledgerPorts: {},
      operationPortsFor() { return {}; },
      operationPortsForSelector() { return {}; },
      async listUnsettledDrafts() { return []; },
      async enqueueDraft(selector) {
        enqueued.push(selector.workItem.number);
        return { kind: 'StaleRevision', currentCommittedRevision: SHA_D };
      },
      async reconcileDraft() { assert.fail('nothing was admitted'); },
    },
  );

  assert.deepEqual(enqueued, [1, 2, 3, 4, 5]);
  assert.equal(receipt.phase, 'EXPECTED_NONE');
  assert.equal(receipt.skipped.length, 5);
});

test('the intake receipt binds the issue the transition belongs to, on every acting phase', async () => {
  const run = await intake();
  const resumed = await run({ repository: REPOSITORY, candidates: [61] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() {
      return [{
        operationId: SHA_A, workKey: SHA_B, committedRevision: SHA_C, selector: selectorFor(51),
      }];
    },
    async enqueueDraft() { assert.fail('a resuming run admits no new work'); },
    async reconcileDraft(operationId) {
      return {
        kind: 'Terminal', outcome: 'REUSED', effect: 'NONE',
        operationId, committedRevision: SHA_D,
      };
    },
  });
  assert.deepEqual(
    resumed.workItem, { kind: 'ISSUE', number: 51 },
    'a resumed operation must publish the issue it belongs to, not the candidates it ignored',
  );

  const admitted = await run({ repository: REPOSITORY, candidates: [63] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return []; },
    async enqueueDraft() {
      return { kind: 'Enqueued', operationId: SHA_A, workKey: SHA_B,
        generationKey: SHA_C, committedRevision: SHA_C };
    },
    async reconcileDraft(operationId) {
      return {
        kind: 'Terminal', outcome: 'CREATED', effect: 'CREATE_DRAFT',
        operationId, committedRevision: SHA_D,
      };
    },
  });
  assert.deepEqual(admitted.workItem, { kind: 'ISSUE', number: 63 });

  const none = await run({ repository: REPOSITORY, candidates: [] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return []; },
    async enqueueDraft() { assert.fail('no candidate means no admission'); },
    async reconcileDraft() { assert.fail('no candidate means no effect'); },
  });
  assert.equal(none.workItem, null);
});

test('the receipt counts what stayed unsettled after the run, not what it found before it', async () => {
  const run = await intake();
  const ports = {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async enqueueDraft() { assert.fail('a resuming run admits no new work'); },
  };
  const unsettled = () => [
    { operationId: SHA_A, workKey: SHA_B, committedRevision: SHA_C, selector: selectorFor(51) },
    { operationId: SHA_B, workKey: SHA_C, committedRevision: SHA_D, selector: selectorFor(52) },
  ];

  const settled = await run({ repository: REPOSITORY, candidates: [61] }, {
    ...ports,
    async listUnsettledDrafts() { return unsettled(); },
    async reconcileDraft(operationId) {
      return {
        kind: 'Terminal', outcome: 'CREATED', effect: 'CREATE_DRAFT',
        operationId, committedRevision: SHA_D,
      };
    },
  });
  assert.equal(settled.phase, 'RESUME');
  assert.equal(
    settled.unsettledCount, 1,
    'a recovery that reached a terminal outcome leaves one behind, not two',
  );

  const stillPending = await run({ repository: REPOSITORY, candidates: [61] }, {
    ...ports,
    async listUnsettledDrafts() { return unsettled(); },
    async reconcileDraft(operationId) {
      return { kind: 'Pending', operationId, committedRevision: SHA_D };
    },
  });
  assert.equal(stillPending.unsettledCount, 2);

  const admitted = await run({ repository: REPOSITORY, candidates: [63] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return []; },
    async enqueueDraft() {
      return { kind: 'Enqueued', operationId: SHA_A, workKey: SHA_B,
        generationKey: SHA_C, committedRevision: SHA_C };
    },
    async reconcileDraft(operationId) {
      return { kind: 'Pending', operationId, committedRevision: SHA_D };
    },
  });
  assert.equal(admitted.unsettledCount, 1, 'an admission that did not settle is still unsettled');

  const none = await run({ repository: REPOSITORY, candidates: [] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return []; },
    async enqueueDraft() { assert.fail('no candidate means no admission'); },
    async reconcileDraft() { assert.fail('no candidate means no effect'); },
  });
  assert.equal(none.unsettledCount, 0);
});
