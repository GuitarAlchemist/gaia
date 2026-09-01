import assert from 'node:assert/strict';
import test from 'node:test';

const MODULE_URL = new URL('../src/hosted-draft-pump.mjs', import.meta.url);
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SELECTOR = Object.freeze({
  repository: Object.freeze({ owner: 'GuitarAlchemist', name: 'gaia' }),
  workItem: Object.freeze({ kind: 'ISSUE', number: 60 }),
});

const moduleResult = import(MODULE_URL).catch((loadError) => ({ loadError }));

async function api() {
  const loaded = await moduleResult;
  if (loaded.loadError) assert.fail(`hosted runner missing: ${loaded.loadError.code}`);
  for (const name of ['runHostedDraftPump', 'runHostedDraftSupervisor']) {
    assert.equal(typeof loaded[name], 'function', `missing ${name}`);
  }
  return loaded;
}

test('one pump tick reconciles only after a durable enqueue', async () => {
  const mod = await api();
  const calls = [];
  const receipt = await mod.runHostedDraftPump({ selector: SELECTOR }, {
    operationPorts: Object.freeze({ name: 'ports' }),
    async enqueueDraft(selector, expected, ports) {
      calls.push(['enqueue', selector, expected, ports]);
      return {
        kind: 'Enqueued', operationId: SHA_A, workKey: SHA_B,
        generationKey: SHA_C, committedRevision: SHA_B,
      };
    },
    async reconcileDraft(operationId, expected, ports) {
      calls.push(['reconcile', operationId, expected, ports]);
      return {
        kind: 'Terminal', outcome: 'CREATED', effect: 'CREATE_DRAFT',
        operationId, committedRevision: SHA_C,
      };
    },
  });

  assert.deepEqual(calls.map(([kind]) => kind), ['enqueue', 'reconcile']);
  assert.equal(calls[0][2], 'NONE');
  assert.equal(calls[1][1], SHA_A);
  assert.equal(calls[1][2], SHA_B);
  assert.deepEqual(receipt, {
    schema: 'GaiaHostedDraftPumpReceiptV0',
    action: 'START',
    selector: SELECTOR,
    operationId: SHA_A,
    result: {
      kind: 'Terminal', outcome: 'CREATED', effect: 'CREATE_DRAFT',
      operationId: SHA_A, committedRevision: SHA_C,
    },
  });
});

test('a rejected enqueue performs no reconciliation effect', async () => {
  const mod = await api();
  let reconciled = false;
  const receipt = await mod.runHostedDraftPump({ selector: SELECTOR }, {
    operationPorts: {},
    async enqueueDraft() {
      return { kind: 'StaleRevision', currentCommittedRevision: SHA_A };
    },
    async reconcileDraft() { reconciled = true; },
  });

  assert.equal(reconciled, false);
  assert.equal(receipt.operationId, null);
  assert.equal(receipt.result.kind, 'StaleRevision');
});

test('the supervisor deterministically resumes one durable unsettled operation', async () => {
  const mod = await api();
  const records = [
    { operationId: SHA_C, workKey: SHA_C, committedRevision: SHA_C, selector: SELECTOR },
    { operationId: SHA_A, workKey: SHA_A, committedRevision: SHA_A, selector: SELECTOR },
  ];
  const resumed = [];
  const receipt = await mod.runHostedDraftSupervisor({ limit: 1 }, {
    ledgerPorts: {},
    async listUnsettledDrafts() { return records; },
    async operationPortsFor(record) {
      resumed.push(['ports', record.operationId]);
      return Object.freeze({ operationId: record.operationId });
    },
    async reconcileDraft(operationId, expected, ports) {
      resumed.push(['reconcile', operationId, expected, ports.operationId]);
      return { kind: 'Pending', state: 'EFFECT_AMBIGUOUS', operationId, committedRevision: expected };
    },
  });

  assert.deepEqual(resumed, [
    ['ports', SHA_A],
    ['reconcile', SHA_A, SHA_A, SHA_A],
  ]);
  assert.equal(receipt.schema, 'GaiaHostedDraftSupervisorReceiptV0');
  assert.equal(receipt.discovered, 2);
  assert.equal(receipt.attempted, 1);
  assert.equal(receipt.results[0].operationId, SHA_A);
});

test('invalid limits and dependency results fail before any provider work', async () => {
  const mod = await api();
  await assert.rejects(
    mod.runHostedDraftSupervisor({ limit: 0 }, {}),
    (error) => error?.code === 'InvalidHostedDraftPump',
  );
  await assert.rejects(
    mod.runHostedDraftSupervisor({ limit: 1 }, {
      ledgerPorts: {},
      async listUnsettledDrafts() { return [{ operationId: 'not-a-revision' }]; },
      async operationPortsFor() { assert.fail('invalid record must fail first'); },
      async reconcileDraft() { assert.fail('invalid record must fail first'); },
    }),
    (error) => error?.code === 'InvalidUnsettledOperation',
  );
});
