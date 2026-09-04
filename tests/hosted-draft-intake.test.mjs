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

test('scheduled recovery resumes unsettled work before any candidate is listed or admitted', async () => {
  const run = await intake();
  const calls = [];
  const receipt = await run({ repository: REPOSITORY, candidates: null }, {
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
  assert.deepEqual(
    calls[2], 'listUnsettled',
    'the count is read again after the run acted, not projected from the snapshot it started with',
  );
  assert.equal(calls.length, 3);
  assert.equal(receipt.phase, 'RESUME');
  assert.equal(receipt.operationId, SHA_A);
  assert.deepEqual(receipt.skipped, []);
});

test('scheduled recovery quarantines an unchanged ambiguous head and drains the next message', async () => {
  const run = await intake();
  const records = [
    { operationId: SHA_A, workKey: SHA_A, committedRevision: SHA_C,
      selector: selectorFor(51) },
    { operationId: SHA_B, workKey: SHA_B, committedRevision: SHA_D,
      selector: selectorFor(52) },
  ];
  const reconciled = [];
  const receipt = await run({ repository: REPOSITORY, candidates: null }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return records; },
    async listReadyIssues() { assert.fail('the second unsettled message must drain first'); },
    async enqueueDraft() { assert.fail('recovery must not admit before draining unsettled work'); },
    async reconcileDraft(operationId, expected) {
      reconciled.push(operationId);
      if (operationId === SHA_A) {
        return {
          kind: 'Pending', state: 'EFFECT_AMBIGUOUS', effect: 'UNKNOWN',
          providerError: 'ProviderAmbiguous', operationId, committedRevision: expected,
        };
      }
      return {
        kind: 'Terminal', outcome: 'REUSED', effect: 'NONE',
        operationId, committedRevision: SHA_A,
      };
    },
  });

  assert.deepEqual(reconciled, [SHA_A, SHA_B]);
  assert.equal(receipt.phase, 'RESUME');
  assert.equal(receipt.workItem.number, 52);
  assert.equal(receipt.unsettledCount, 1);
  assert.deepEqual(receipt.skipped, [{ number: 51, reason: 'EFFECT_AMBIGUOUS' }]);
});

test('an issue-scoped retry remains fail-closed on its unchanged ambiguous operation', async () => {
  const run = await intake();
  let reconciles = 0;
  const receipt = await run({ repository: REPOSITORY, candidates: [51] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() {
      return [{ operationId: SHA_A, workKey: SHA_A, committedRevision: SHA_C,
        selector: selectorFor(51) }];
    },
    async listReadyIssues() { assert.fail('an issue lane never lists the global queue'); },
    async enqueueDraft() { assert.fail('the existing operation must remain authoritative'); },
    async reconcileDraft(operationId, expected) {
      reconciles += 1;
      return { kind: 'Pending', state: 'EFFECT_AMBIGUOUS', effect: 'UNKNOWN',
        providerError: 'ProviderAmbiguous', operationId, committedRevision: expected };
    },
  });

  assert.equal(reconciles, 1);
  assert.equal(receipt.phase, 'RESUME');
  assert.equal(receipt.workItem.number, 51);
  assert.equal(receipt.result.state, 'EFFECT_AMBIGUOUS');
  assert.deepEqual(receipt.skipped, []);
});

test('scheduled recovery stops when ambiguity advances the durable revision', async () => {
  const run = await intake();
  const reconciled = [];
  const receipt = await run({ repository: REPOSITORY, candidates: null }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() {
      return [
        { operationId: SHA_A, workKey: SHA_A, committedRevision: SHA_C,
          selector: selectorFor(51) },
        { operationId: SHA_B, workKey: SHA_B, committedRevision: SHA_D,
          selector: selectorFor(52) },
      ];
    },
    async listReadyIssues() { assert.fail('a changed effect boundary stops the tick'); },
    async enqueueDraft() { assert.fail('a changed effect boundary stops the tick'); },
    async reconcileDraft(operationId) {
      reconciled.push(operationId);
      return { kind: 'Pending', state: 'EFFECT_AMBIGUOUS', effect: 'UNKNOWN',
        providerError: 'ProviderAmbiguous', operationId, committedRevision: SHA_D };
    },
  });

  assert.deepEqual(reconciled, [SHA_A]);
  assert.equal(receipt.workItem.number, 51);
  assert.equal(receipt.committedRevision, SHA_D);
  assert.deepEqual(receipt.skipped, []);
});

test('scheduled recovery stops when an ambiguous retry carries no observed revision', async () => {
  const run = await intake();
  const reconciled = [];
  const receipt = await run({ repository: REPOSITORY, candidates: null }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() {
      return [
        { operationId: SHA_A, workKey: SHA_A, committedRevision: SHA_C,
          selector: selectorFor(51) },
        { operationId: SHA_B, workKey: SHA_B, committedRevision: SHA_D,
          selector: selectorFor(52) },
      ];
    },
    async listReadyIssues() { assert.fail('missing revision evidence stops the tick'); },
    async enqueueDraft() { assert.fail('missing revision evidence stops the tick'); },
    async reconcileDraft(operationId) {
      reconciled.push(operationId);
      return {
        kind: 'Pending', state: 'EFFECT_AMBIGUOUS', effect: 'UNKNOWN',
        providerError: 'ProviderAmbiguous', operationId,
      };
    },
  });

  assert.deepEqual(reconciled, [SHA_A]);
  assert.equal(receipt.workItem.number, 51);
  assert.equal(receipt.committedRevision, SHA_C);
  assert.deepEqual(receipt.skipped, []);
});

test('scheduled recovery admits one candidate after every probed message stays ambiguously inert', async () => {
  const run = await intake();
  const record = {
    operationId: SHA_A, workKey: SHA_A, committedRevision: SHA_C, selector: selectorFor(51),
  };
  let candidateLists = 0;
  let admissions = 0;
  const receipt = await run({ repository: REPOSITORY, candidates: null }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return [record]; },
    async listReadyIssues() {
      candidateLists += 1;
      return [{ number: 61 }];
    },
    async enqueueDraft(candidate) {
      admissions += 1;
      assert.equal(candidate.workItem.number, 61);
      return {
        kind: 'Enqueued', operationId: SHA_B, workKey: SHA_D,
        generationKey: SHA_A, committedRevision: SHA_D,
      };
    },
    async reconcileDraft(operationId, expected) {
      if (operationId === SHA_A) {
        return {
          kind: 'Pending', state: 'EFFECT_AMBIGUOUS', effect: 'UNKNOWN',
          providerError: 'ProviderAmbiguous', operationId, committedRevision: expected,
        };
      }
      return {
        kind: 'Terminal', outcome: 'CREATED', effect: 'CREATE_DRAFT',
        operationId, committedRevision: SHA_B,
      };
    },
  });

  assert.equal(candidateLists, 1);
  assert.equal(admissions, 1);
  assert.equal(receipt.phase, 'ADMIT');
  assert.equal(receipt.workItem.number, 61);
  assert.equal(receipt.unsettledCount, 1, 'the quarantined record remains durably unsettled');
  assert.deepEqual(receipt.skipped, [{ number: 51, reason: 'EFFECT_AMBIGUOUS' }]);
});

test('concurrent issue lanes cannot be consumed by unrelated unsettled recovery work', async () => {
  const run = await intake();
  const enqueued = [];
  const reconciled = [];
  const ports = {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() {
      return [{
        operationId: SHA_A, workKey: SHA_B, committedRevision: SHA_C,
        selector: selectorFor(51),
      }];
    },
    async listReadyIssues() { assert.fail('an issue lane uses its explicit candidate only'); },
    async enqueueDraft(candidate) {
      const number = candidate.workItem.number;
      enqueued.push(number);
      return {
        kind: 'Enqueued',
        operationId: number === 61 ? SHA_A : SHA_B,
        workKey: number === 61 ? SHA_C : SHA_D,
        generationKey: SHA_A,
        committedRevision: SHA_C,
      };
    },
    async reconcileDraft(operationId) {
      reconciled.push(operationId);
      return {
        kind: 'Terminal', outcome: 'CREATED', effect: 'CREATE_DRAFT',
        operationId, committedRevision: SHA_D,
      };
    },
  };

  const [issue61, issue62] = await Promise.all([
    run({ repository: REPOSITORY, candidates: [61] }, ports),
    run({ repository: REPOSITORY, candidates: [62] }, ports),
  ]);

  assert.deepEqual(enqueued.sort((left, right) => left - right), [61, 62]);
  assert.deepEqual(reconciled.sort(), [SHA_A, SHA_B]);
  assert.equal(issue61.phase, 'ADMIT');
  assert.equal(issue61.workItem.number, 61);
  assert.equal(issue61.unsettledCount, 1, 'unrelated issue 51 remains globally unsettled');
  assert.equal(issue62.phase, 'ADMIT');
  assert.equal(issue62.workItem.number, 62);
  assert.equal(issue62.unsettledCount, 1, 'unrelated issue 51 remains globally unsettled');
});

test('issue-scoped RESUME keeps unrelated residual work in the global count', async () => {
  const run = await intake();
  const receipt = await run({ repository: REPOSITORY, candidates: [61] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() {
      return [
        { operationId: SHA_A, workKey: SHA_B, committedRevision: SHA_C,
          selector: selectorFor(52) },
        { operationId: SHA_B, workKey: SHA_C, committedRevision: SHA_D,
          selector: selectorFor(61) },
      ];
    },
    async enqueueDraft() { assert.fail('the matching unsettled operation must resume'); },
    async reconcileDraft(operationId) {
      assert.equal(operationId, SHA_B, 'the lane may act only on issue 61');
      return { kind: 'Terminal', outcome: 'CREATED', effect: 'CREATE_DRAFT',
        operationId, committedRevision: SHA_A };
    },
  });

  assert.equal(receipt.phase, 'RESUME');
  assert.equal(receipt.workItem.number, 61);
  assert.equal(receipt.unsettledCount, 1, 'issue 52 remains globally unsettled');
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
  const resumed = await run({ repository: REPOSITORY, candidates: null }, {
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

  const settled = await run({ repository: REPOSITORY, candidates: null }, {
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

  const stillPending = await run({ repository: REPOSITORY, candidates: null }, {
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

// --- Spec R1 blocker S1: the observation denominator ------------------------------------------
//
// Every test below drives the real shipped chain and nothing else: `runHostedDraftIntake` produces
// the receipt, `produceHostedDraftPumpObservation` seals it, and `summarizeHostedDraftPump`
// renders what the Control Room renders. A durable fake ledger stands in for the Git Data ledger,
// and — unlike the static fakes above — it records the writes a run performs and the writes a
// concurrent lane performs, because the defect is invisible to a ledger that cannot change.

const ROOT_OID = 'd'.repeat(40);
const ROOT_REVISION = 'e'.repeat(64);
const WINDOW_STARTED_AT = '2026-09-01T12:00:00.000Z';
const TICK_AT = '2026-09-01T12:00:30.000Z';
const OBSERVED_AT = '2026-09-01T12:00:31.000Z';
const PAGE_AT = '2026-09-01T12:05:00.000Z';

const IDENTITY = Object.freeze({
  repository: 'GuitarAlchemist/gaia',
  repositoryNodeId: 'R_kgDOGaia',
  ledgerRootOid: ROOT_OID,
  ledgerRootRevision: ROOT_REVISION,
  sequence: 9001,
  windowStartedAt: WINDOW_STARTED_AT,
  tickAt: TICK_AT,
  observedAt: OBSERVED_AT,
});

const hex = (seed, width) => seed.toString(16).padStart(width, '0');

/** One durable, mutable unsettled set. Records carry exactly the four fields intake validates. */
function ledger(initial = []) {
  const rows = new Map();
  const add = (number) => {
    rows.set(number, {
      operationId: hex(number * 7, 64),
      workKey: hex(number * 13, 64),
      committedRevision: hex(number * 17, 64),
      selector: selectorFor(number),
    });
    return rows.get(number);
  };
  for (const number of initial) add(number);
  return {
    add,
    settle(number) { rows.delete(number); },
    list() { return [...rows.values()].map((row) => ({ ...row })); },
  };
}

async function renderThrough(receipt, trigger) {
  const { produceHostedDraftPumpObservation } = await import(
    new URL('../src/hosted-draft-pump-producer.mjs', import.meta.url)
  );
  const { summarizeHostedDraftPump } = await import(
    new URL('../src/hosted-draft-pump-observation.mjs', import.meta.url)
  );
  const artifact = produceHostedDraftPumpObservation({
    ...IDENTITY,
    receipt: {
      schema: 'GaiaHostedDraftPumpCliReceiptV0',
      command: 'intake',
      trigger,
      phase: receipt.phase,
      operationId: receipt.operationId,
      workKey: receipt.workKey,
      committedRevision: receipt.committedRevision,
      workItem: receipt.workItem,
      unsettledCount: receipt.unsettledCount,
      result: receipt.result,
      skipped: receipt.skipped,
      telemetry: [],
    },
  });
  return summarizeHostedDraftPump({ artifact, observedAt: PAGE_AT });
}

// Positive control. This is the reading the seam exists to publish, and it must survive the repair
// untouched: a genuinely empty ledger with no candidate is the healthiest reading there is, and a
// fix that reached `healthy` by never rendering it would be a worse defect than the one repaired.
test('positive control: a genuinely empty ledger still publishes EXPECTED_NONE as healthy', async () => {
  const run = await intake();
  const durable = ledger();
  const receipt = await run({ repository: REPOSITORY, candidates: null }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return durable.list(); },
    async listReadyIssues() { return []; },
    async enqueueDraft() { assert.fail('no candidate means no admission'); },
    async reconcileDraft() { assert.fail('no candidate means no effect'); },
  });

  assert.equal(receipt.phase, 'EXPECTED_NONE');
  assert.equal(receipt.unsettledCount, 0);

  const block = await renderThrough(receipt, 'SCHEDULE');
  assert.equal(block.state, 'EXPECTED_NONE');
  assert.equal(block.severity, 'healthy');
  assert.equal(block.unsettledCount, 0, 'an empty ledger is genuinely zero');
});

// S1, first interleaving: the recovery lane snapshots an empty unsettled set, a labeled lane for
// issue 62 durably enqueues while the recovery lane is still selecting, and the recovery lane
// publishes the pre-action zero. Since R1 the recovery lane is the only lane with an observation
// path, so this false `healthy` stands until the next six-hourly tick.
test('a lane that enqueues during a recovery run is not published as a healthy repository', async () => {
  const run = await intake();
  const durable = ledger();
  const receipt = await run({ repository: REPOSITORY, candidates: null }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return durable.list(); },
    async listReadyIssues() {
      // The concurrent labeled lane for issue 62 wins its own queue and commits durably here.
      durable.add(62);
      return [];
    },
    async enqueueDraft() { assert.fail('this run has no candidate of its own'); },
    async reconcileDraft() { assert.fail('this run performs no effect'); },
  });

  assert.equal(receipt.phase, 'EXPECTED_NONE');
  assert.equal(
    durable.list().length, 1,
    'fixture control: one operation really is unsettled when this run publishes',
  );
  assert.equal(
    receipt.unsettledCount, 1,
    'the receipt must count the concurrent durable write, not the pre-action snapshot',
  );

  const block = await renderThrough(receipt, 'SCHEDULE');
  assert.equal(block.unsettledCount, 1);
  assert.equal(block.state, 'UNSETTLED');
  assert.notEqual(
    block.severity, 'healthy',
    'the Control Room must never render healthy over durably unsettled work',
  );
});

// S1, second interleaving, and the one that is guaranteed rather than merely likely: this run does
// list issue 62 and does attempt it, but loses the compare-and-set. Losing proves the winner's
// write was already durable before this run read the ledger again, so no correct post-action read
// can miss it. The receipt is still `EXPECTED_NONE` — a `StaleRevision` skip is benign to the
// producer — and today it still carries zero.
test('a recovery run that loses the enqueue race publishes the winner as unsettled, not healthy', async () => {
  const run = await intake();
  const durable = ledger();
  const receipt = await run({ repository: REPOSITORY, candidates: null }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return durable.list(); },
    async listReadyIssues() { return [{ number: 62 }]; },
    async enqueueDraft(candidate) {
      assert.equal(candidate.workItem.number, 62);
      // The labeled lane's enqueue is already committed; this one is the CAS loser.
      const winner = durable.add(62);
      return { kind: 'StaleRevision', currentCommittedRevision: winner.committedRevision };
    },
    async reconcileDraft() { assert.fail('a lost enqueue performs no effect'); },
  });

  assert.equal(receipt.phase, 'EXPECTED_NONE');
  assert.deepEqual(receipt.skipped, [{ number: 62, reason: 'StaleRevision' }]);
  assert.equal(
    receipt.unsettledCount, 1,
    'the compare-and-set winner is durably unsettled and must be counted',
  );

  const block = await renderThrough(receipt, 'SCHEDULE');
  assert.equal(block.unsettledCount, 1);
  assert.equal(block.state, 'UNSETTLED');
  assert.notEqual(block.severity, 'healthy');
});

// The correction is one-directional by construction. A post-action read that returns fewer
// operations than this run projected — a lagging or partial read — must not be able to talk the
// published count down toward `healthy`, because a bug in the read would then manufacture exactly
// the false clear this repair exists to remove.
test('a post-action read that returns less than the run projected cannot lower the count', async () => {
  const run = await intake();
  const receipt = await run({ repository: REPOSITORY, candidates: [63] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    // Both reads answer empty, while this run admits an operation that never settles.
    async listUnsettledDrafts() { return []; },
    async enqueueDraft() {
      return { kind: 'Enqueued', operationId: SHA_A, workKey: SHA_B,
        generationKey: SHA_C, committedRevision: SHA_C };
    },
    async reconcileDraft(operationId) {
      return { kind: 'Pending', operationId, committedRevision: SHA_D };
    },
  });

  assert.equal(receipt.phase, 'ADMIT');
  assert.equal(
    receipt.unsettledCount, 1,
    'the operation this run left open is still counted when the ledger read does not show it',
  );
});

// The other half of the same rule: the operation this run admitted is already in the projection, so
// finding it again in the post-action read must not add a second one.
test('the operation this run admitted is counted once, not twice', async () => {
  const run = await intake();
  const durable = ledger();
  const receipt = await run({ repository: REPOSITORY, candidates: [63] }, {
    ledgerPorts: {},
    operationPortsFor() { return {}; },
    operationPortsForSelector() { return {}; },
    async listUnsettledDrafts() { return durable.list(); },
    async enqueueDraft(candidate) {
      const row = durable.add(candidate.workItem.number);
      return { kind: 'Enqueued', operationId: row.operationId, workKey: row.workKey,
        generationKey: SHA_C, committedRevision: row.committedRevision };
    },
    async reconcileDraft(operationId) {
      return { kind: 'Pending', operationId, committedRevision: SHA_D };
    },
  });

  assert.equal(receipt.phase, 'ADMIT');
  assert.equal(durable.list().length, 1, 'fixture control: exactly one operation is open');
  assert.equal(receipt.unsettledCount, 1, 'the admitted operation is one operation, not two');
});
