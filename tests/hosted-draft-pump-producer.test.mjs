import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  HOSTED_DRAFT_PUMP_SCHEMA,
  deriveHostedDraftPumpBlock,
  requireHostedDraftPumpObservation,
  sealHostedDraftPumpObservation,
  summarizeHostedDraftPump,
} from '../src/hosted-draft-pump-observation.mjs';
import { main } from '../scripts/hosted-draft-pump.mjs';

const PRODUCER_URL = new URL('../src/hosted-draft-pump-producer.mjs', import.meta.url);

const OPERATION_ID = 'a'.repeat(64);
const WORK_KEY = 'b'.repeat(64);
const COMMITTED = 'c'.repeat(64);
const ROOT_OID = 'd'.repeat(40);
const ROOT_REVISION = 'e'.repeat(64);
const GENERATION_KEY = 'f'.repeat(64);
const ENVELOPE_SOURCE = '9'.repeat(64);

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

const producerModule = import(PRODUCER_URL).catch((loadError) => ({ loadError }));

async function producer() {
  const value = await producerModule;
  if (value.loadError) {
    assert.fail(
      `src/hosted-draft-pump-producer.mjs must ship the observation producer: ${value.loadError.code}`,
    );
  }
  assert.equal(
    typeof value.produceHostedDraftPumpObservation, 'function',
    'produceHostedDraftPumpObservation must be exported',
  );
  return value;
}

function pullRequest() {
  return {
    number: 71,
    url: 'https://github.com/GuitarAlchemist/gaia/pull/71',
    isDraft: true,
    state: 'OPEN',
    operationMarker: `gaia-operation:${OPERATION_ID}`,
    repository: { nodeId: 'R_kgDOGaia', owner: 'GuitarAlchemist', name: 'gaia' },
    baseRef: 'main',
    headRef: 'gaia/draft-70',
    headRevision: '1'.repeat(40),
  };
}

function terminal(overrides = {}) {
  return {
    kind: 'Terminal',
    outcome: 'CREATED',
    effect: 'CREATE_DRAFT',
    operationId: OPERATION_ID,
    workKey: WORK_KEY,
    generationKey: GENERATION_KEY,
    generation: { kind: 'ISSUE', number: 70, revision: ENVELOPE_SOURCE },
    observedSourceRevision: ENVELOPE_SOURCE,
    pullRequest: pullRequest(),
    refusal: null,
    committedRevision: COMMITTED,
    actionRevision: COMMITTED,
    checklistRevision: COMMITTED,
    sourceRevision: COMMITTED,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    schema: 'GaiaHostedDraftPumpCliReceiptV0',
    command: 'intake',
    trigger: 'SCHEDULE',
    phase: 'ADMIT',
    operationId: OPERATION_ID,
    workKey: WORK_KEY,
    committedRevision: COMMITTED,
    workItem: { kind: 'ISSUE', number: 70 },
    unsettledCount: 0,
    result: terminal(),
    skipped: [],
    telemetry: [{ kind: 'CREATED', operationId: OPERATION_ID }],
    ...overrides,
  };
}

function expectedNoneReceipt(overrides = {}) {
  return receipt({
    phase: 'EXPECTED_NONE',
    operationId: null,
    workKey: null,
    committedRevision: null,
    workItem: null,
    unsettledCount: 0,
    result: null,
    telemetry: [],
    ...overrides,
  });
}

async function produce(overrides = {}) {
  const { produceHostedDraftPumpObservation } = await producer();
  return produceHostedDraftPumpObservation({ ...IDENTITY, ...overrides });
}

async function refusalOf(input) {
  const { produceHostedDraftPumpObservation } = await producer();
  try {
    produceHostedDraftPumpObservation({ ...IDENTITY, ...input });
  } catch (error) {
    return error;
  }
  return assert.fail('the producer must refuse rather than publish a guess');
}

function blockOf(artifact, at = PAGE_AT) {
  return summarizeHostedDraftPump({ artifact, observedAt: at });
}

// Positive control: the shipped read model already verifies a correctly sealed observation, so a
// failure below is a missing producer rather than a broken fixture or an unreachable read seam.
test('positive control: the shipped read model verifies a correctly sealed observation', () => {
  const sealed = sealHostedDraftPumpObservation({
    observedAt: OBSERVED_AT,
    windowStartedAt: WINDOW_STARTED_AT,
    sequence: 1,
    repository: 'GuitarAlchemist/gaia',
    repositoryNodeId: 'R_kgDOGaia',
    ledgerRootOid: ROOT_OID,
    ledgerRootRevision: ROOT_REVISION,
    unsettledCount: 0,
    transition: {
      tickAt: TICK_AT,
      trigger: 'SCHEDULED_RECOVERY',
      outcome: 'EXPECTED_NONE',
      effect: 'NONE',
      operationId: null,
      workKey: null,
      generationKey: null,
      committedRevision: null,
      observedSourceRevision: ENVELOPE_SOURCE,
      workItem: null,
      pullRequest: null,
      blocker: 'NONE',
    },
  });
  assert.equal(sealed.schema, HOSTED_DRAFT_PUMP_SCHEMA);
  assert.equal(requireHostedDraftPumpObservation(sealed).revision, sealed.revision);
  assert.equal(deriveHostedDraftPumpBlock({ artifact: sealed, observedAt: PAGE_AT }).state,
    'EXPECTED_NONE');
});

test('an admitted intake receipt becomes a verified observation binding operation, issue and PR', async () => {
  const artifact = await produce({ receipt: receipt() });

  assert.equal(artifact.schema, HOSTED_DRAFT_PUMP_SCHEMA);
  assert.equal(requireHostedDraftPumpObservation(artifact).revision, artifact.revision);

  const block = blockOf(artifact);
  assert.equal(block.state, 'ADVANCED');
  assert.equal(block.severity, 'healthy');
  assert.equal(block.operationId, OPERATION_ID);
  assert.equal(block.workKey, WORK_KEY);
  assert.equal(block.committedRevision, COMMITTED);
  assert.deepEqual(block.workItem, { kind: 'ISSUE', number: 70 });
  assert.deepEqual(block.pullRequest, { number: 71, isDraft: true, state: 'OPEN' });
  assert.equal(block.pullRequestBinding, 'PROVEN');
  assert.equal(block.blocker, 'NONE');
  assert.equal(block.trigger, 'SCHEDULED_RECOVERY');
});

test('a labelled trigger is published as READY_LABEL and a schedule as SCHEDULED_RECOVERY', async () => {
  const labelled = await produce({ receipt: receipt({ trigger: 'ISSUES_LABELED' }) });
  assert.equal(blockOf(labelled).trigger, 'READY_LABEL');

  const scheduled = await produce({ receipt: receipt({ trigger: 'SCHEDULE' }) });
  assert.equal(blockOf(scheduled).trigger, 'SCHEDULED_RECOVERY');

  assert.equal((await refusalOf({ receipt: receipt({ trigger: 'WORKFLOW_DISPATCH' }) })).code,
    'InvalidHostedDraftPumpReceipt');
});

test('a resumed reuse reads as a replay, never as intake progress', async () => {
  const artifact = await produce({
    receipt: receipt({
      phase: 'RESUME',
      workItem: { kind: 'ISSUE', number: 51 },
      result: terminal({ outcome: 'REUSED', effect: 'NONE' }),
    }),
  });
  const block = blockOf(artifact);
  assert.equal(block.state, 'REPLAYED');
  assert.deepEqual(block.workItem, { kind: 'ISSUE', number: 51 });
});

test('a tick that admitted nothing publishes EXPECTED_NONE with no operation identity', async () => {
  const artifact = await produce({ receipt: expectedNoneReceipt() });
  const block = blockOf(artifact);
  assert.equal(block.state, 'EXPECTED_NONE');
  assert.equal(block.operationId, null);
  assert.equal(block.workKey, null);
  assert.equal(block.workItem, null);
  assert.equal(block.pullRequest, null);
  assert.equal(block.pullRequestBinding, 'PR_NOT_PROVEN');
  assert.equal(block.blocker, 'NONE');
});

test('an unsettled operation left behind by this run is published as a count, not hidden', async () => {
  const artifact = await produce({
    receipt: receipt({
      unsettledCount: 1,
      result: {
        kind: 'Pending', state: 'EFFECT_AMBIGUOUS', effect: 'UNKNOWN',
        operationId: OPERATION_ID, workKey: WORK_KEY, generationKey: GENERATION_KEY,
        providerError: 'ProviderAmbiguous', committedRevision: COMMITTED,
      },
    }),
  });
  const block = blockOf(artifact);
  assert.equal(block.blocker, 'EFFECT_AMBIGUOUS');
  assert.equal(block.state, 'BLOCKED');
  assert.equal(block.unsettledCount, 1);
});

test('each envelope refusal is published as its own typed blocker, and an unknown one refuses', async () => {
  const cases = [
    ['ProviderUnavailable', 'PROVIDER_UNAVAILABLE'],
    ['ProviderProtocolViolation', 'PROVIDER_PROTOCOL_VIOLATION'],
    ['NoEffectCapacity', 'NO_EFFECT_CAPACITY'],
  ];
  for (const [refusal, blocker] of cases) {
    const artifact = await produce({
      receipt: receipt({
        result: terminal({
          outcome: 'REFUSED', effect: 'NONE', pullRequest: null, refusal,
        }),
      }),
    });
    const block = blockOf(artifact);
    assert.equal(block.blocker, blocker, `${refusal} must publish ${blocker}`);
    assert.equal(block.state, 'BLOCKED');
    assert.equal(block.severity, 'blocked');
  }

  const refused = await refusalOf({
    receipt: receipt({
      result: terminal({
        outcome: 'REFUSED', effect: 'NONE', pullRequest: null, refusal: 'SomethingNew',
      }),
    }),
  });
  assert.equal(refused.code, 'InvalidHostedDraftPumpReceipt');
  assert.match(refused.message, /SomethingNew/u);
});

test('a receipt that is not a verified terminal or reconciled outcome performs no effect and refuses', async () => {
  const unobservable = [
    { kind: 'StaleRevision', currentCommittedRevision: COMMITTED },
    {
      kind: 'CrossGenerationIntent', workKey: WORK_KEY, operationId: OPERATION_ID,
      committedRevision: COMMITTED,
    },
    {
      kind: 'Enqueued', operationId: OPERATION_ID, workKey: WORK_KEY,
      generationKey: GENERATION_KEY, committedRevision: COMMITTED,
    },
    terminal({ outcome: 'CANCELLED', effect: 'NONE', pullRequest: null }),
  ];
  for (const result of unobservable) {
    const error = await refusalOf({ receipt: receipt({ result }) });
    assert.equal(
      error.code, 'UnobservableHostedDraftPumpReceipt',
      `${result.kind}/${result.outcome ?? ''} must refuse rather than publish a guess`,
    );
  }
});

test('an empty admission caused by a cross-generation skip reads BLOCKED, never healthy', async () => {
  const artifact = await produce({
    receipt: expectedNoneReceipt({
      skipped: [
        { number: 51, reason: 'StaleRevision' },
        { number: 64, reason: 'CrossGenerationIntent' },
      ],
    }),
  });
  const block = blockOf(artifact);
  assert.equal(block.blocker, 'CROSS_GENERATION_INTENT');
  assert.equal(block.state, 'BLOCKED');

  const benign = await produce({
    receipt: expectedNoneReceipt({ skipped: [{ number: 51, reason: 'StaleRevision' }] }),
  });
  assert.equal(blockOf(benign).state, 'EXPECTED_NONE');

  const unknown = await refusalOf({
    receipt: expectedNoneReceipt({ skipped: [{ number: 64, reason: 'IssueNotReady' }] }),
  });
  assert.equal(unknown.code, 'UnobservableHostedDraftPumpReceipt');
});

test('a mismatched receipt binding is refused rather than reconciled by the producer', async () => {
  const mismatches = [
    receipt({ operationId: 'd'.repeat(64) }),
    receipt({ workKey: '7'.repeat(64) }),
    receipt({ committedRevision: '8'.repeat(64) }),
    receipt({ phase: 'ADMIT', workItem: null }),
    expectedNoneReceipt({ operationId: OPERATION_ID }),
    expectedNoneReceipt({ result: terminal() }),
    receipt({ phase: 'OBSERVE' }),
    receipt({ schema: 'GaiaSomethingElseV0' }),
    receipt({ command: 'reconcile' }),
  ];
  for (const input of mismatches) {
    const error = await refusalOf({ receipt: input });
    assert.match(
      error.code,
      /^(?:InvalidHostedDraftPumpReceipt|UnobservableHostedDraftPumpReceipt)$/u,
      `${JSON.stringify(input.phase)} must be refused by a typed code`,
    );
  }
});

test('a future-dated tick is refused at the producer, never clamped to a reassuring zero', async () => {
  const future = await refusalOf({
    receipt: receipt(), tickAt: '2026-09-01T12:00:32.000Z', observedAt: OBSERVED_AT,
  });
  assert.equal(future.code, 'IncoherentHostedDraftPump');

  const window = await refusalOf({
    receipt: receipt(), windowStartedAt: '2026-09-01T12:00:40.000Z',
  });
  assert.equal(window.code, 'IncoherentHostedDraftPump');
});

test('a reading that went backwards against the published prior is refused', async () => {
  const first = await produce({ receipt: receipt(), sequence: 9002 });
  const backwards = await refusalOf({
    receipt: receipt(),
    sequence: 9001,
    priorObservation: {
      observedAt: first.observedAt,
      sequence: first.sequence,
      workKey: first.transition.workKey,
      committedRevision: first.transition.committedRevision,
    },
  });
  assert.equal(backwards.code, 'IncoherentHostedDraftPump');

  const older = await refusalOf({
    receipt: receipt(),
    observedAt: '2026-09-01T11:59:00.000Z',
    tickAt: '2026-09-01T11:58:00.000Z',
    windowStartedAt: '2026-09-01T11:57:00.000Z',
    priorObservation: { observedAt: first.observedAt, sequence: 1 },
  });
  assert.equal(older.code, 'IncoherentHostedDraftPump');
});

test('replay of one run converges: identical bytes, identical revision, accepted against itself', async () => {
  const once = await produce({ receipt: receipt() });
  const twice = await produce({ receipt: receipt() });
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
  assert.equal(once.revision, twice.revision);

  const again = await produce({
    receipt: receipt(),
    priorObservation: {
      observedAt: once.observedAt,
      sequence: once.sequence,
      workKey: once.transition.workKey,
      committedRevision: once.transition.committedRevision,
    },
  });
  assert.equal(again.revision, once.revision);
});

test('the observation carries the content address of the receipt it was derived from', async () => {
  const { hostedDraftPumpReceiptRevision } = await producer();
  assert.equal(typeof hostedDraftPumpReceiptRevision, 'function');

  const source = receipt();
  const artifact = await produce({ receipt: source });
  assert.equal(artifact.transition.observedSourceRevision, hostedDraftPumpReceiptRevision(source));

  // Key order is transport, not evidence: the same receipt reordered addresses identically.
  const reordered = Object.fromEntries(Object.entries(source).reverse());
  assert.equal(hostedDraftPumpReceiptRevision(reordered), hostedDraftPumpReceiptRevision(source));

  // A different transition addresses differently, so the receipt and the observation cannot be
  // paired across two different runs.
  assert.notEqual(
    hostedDraftPumpReceiptRevision(receipt({ phase: 'RESUME' })),
    hostedDraftPumpReceiptRevision(source),
  );
});

test('the producer claims no authority, no binding and no readiness it did not read', async () => {
  const artifact = await produce({ receipt: receipt() });
  assert.equal(artifact.effect, 'NONE');
  assert.equal(artifact.authority, 'NONE');

  const block = blockOf(artifact);
  assert.equal(block.binding, 'NONE');
  assert.equal(block.readiness, 'NOT_CLAIMED');
  for (const forbidden of ['eta', 'pace', 'forecast', 'progress', 'share', 'rate', 'nextAction']) {
    assert.ok(!Object.hasOwn(block, forbidden), `the pump block must publish no ${forbidden}`);
  }
});

test('the producer performs nothing: no clock, no file, no process, no network', async () => {
  await producer();
  const source = readFileSync(PRODUCER_URL, 'utf8');
  for (const forbidden of [
    'node:fs', 'node:child_process', 'node:net', 'node:http', 'node:https', 'node:process',
    'duckdb', 'wmux', 'Date.now', 'new Date(', 'fetch(', 'process.env',
  ]) {
    assert.ok(!source.includes(forbidden), `the producer must not reach for ${forbidden}`);
  }
  const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gmu)].map(([, id]) => id);
  assert.deepEqual(imports, ['./hosted-draft-pump-observation.mjs']);
});

// ---------------------------------------------------------------------------
// production reachability: the hosted intake run writes the observation itself
// ---------------------------------------------------------------------------

function sink() {
  let value = '';
  return {
    stream: { write(chunk) { value += String(chunk); } },
    text() { return value; },
    json() { return JSON.parse(value.trim()); },
  };
}

function intakeArgs(extra = []) {
  return [
    'intake',
    '--repository', 'GuitarAlchemist/gaia',
    '--pump-actor-id', '1234',
    '--repository-node-id', 'R_kgDOGaia',
    '--ledger-root-oid', ROOT_OID,
    '--ledger-root-revision', ROOT_REVISION,
    ...extra,
  ];
}

function stubRuntime(reconciled) {
  return () => Object.freeze({
    async listUnsettled() { return []; },
    async enqueue() {
      return {
        kind: 'Enqueued', operationId: OPERATION_ID, workKey: WORK_KEY,
        generationKey: GENERATION_KEY, committedRevision: COMMITTED,
      };
    },
    async reconcile() { return reconciled; },
    async listReadyIssues() { return [{ number: 70 }]; },
  });
}

function outPath() {
  return join(mkdtempSync(join(tmpdir(), 'gaia-pump-observation-')), 'observation.json');
}

test('the hosted intake run writes the sealed observation itself, with no human-authored JSON', async () => {
  const output = sink();
  const errors = sink();
  const path = outPath();
  const exitCode = await main({
    argv: intakeArgs(['--observation-out', path, '--run-id', '9001', '--issue', '70']),
    env: {},
    stdout: output.stream,
    stderr: errors.stream,
    runtimeFactory: stubRuntime(terminal()),
  });

  assert.equal(errors.text(), '');
  assert.equal(exitCode, 0);
  assert.ok(existsSync(path), 'the intake run must write the observation the Control Room reads');

  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const verified = requireHostedDraftPumpObservation(artifact);
  assert.equal(verified.schema, HOSTED_DRAFT_PUMP_SCHEMA);
  assert.equal(verified.transition.trigger, 'READY_LABEL');
  assert.deepEqual(verified.transition.workItem, { kind: 'ISSUE', number: 70 });
  assert.equal(verified.sequence, 9001);
  assert.equal(verified.repository, 'GuitarAlchemist/gaia');

  const emitted = output.json();
  assert.deepEqual(emitted.observation, { state: 'PRODUCED', revision: artifact.revision });
});

test('an intake run that cannot say what the pump did writes no observation and names the refusal', async () => {
  const output = sink();
  const errors = sink();
  const path = outPath();
  const exitCode = await main({
    argv: intakeArgs(['--observation-out', path, '--run-id', '9001', '--issue', '70']),
    env: {},
    stdout: output.stream,
    stderr: errors.stream,
    runtimeFactory: stubRuntime({ kind: 'StaleRevision', currentCommittedRevision: COMMITTED }),
  });

  assert.equal(exitCode, 0, 'a refused observation does not fail an intake that succeeded');
  assert.equal(existsSync(path), false, 'no document may be published for a guess');
  assert.deepEqual(output.json().observation, {
    state: 'REFUSED', reason: 'UnobservableHostedDraftPumpReceipt',
  });
});

test('an observation cannot be requested without the run identity that sequences it', async () => {
  const errors = sink();
  const exitCode = await main({
    argv: intakeArgs(['--observation-out', outPath()]),
    env: {},
    stdout: sink().stream,
    stderr: errors.stream,
    runtimeFactory() { assert.fail('argument parsing must refuse before any runtime is built'); },
  });
  assert.equal(exitCode, 2);
  assert.deepEqual(errors.json(), {
    schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'InvalidArguments',
  });
});

test('an intake run that was asked for no observation writes none and claims none', async () => {
  const output = sink();
  const exitCode = await main({
    argv: intakeArgs(['--issue', '70']),
    env: {},
    stdout: output.stream,
    stderr: sink().stream,
    runtimeFactory: stubRuntime(terminal()),
  });
  assert.equal(exitCode, 0);
  assert.ok(!Object.hasOwn(output.json(), 'observation'));
});

test('the same hosted run replayed writes byte-identical observation bytes', async () => {
  const bytes = [];
  for (let run = 0; run < 2; run += 1) {
    const path = outPath();
    const clock = ['2026-09-01T12:00:00.000Z', '2026-09-01T12:00:30.000Z', OBSERVED_AT];
    let index = 0;
    await main({
      argv: intakeArgs(['--observation-out', path, '--run-id', '9001', '--issue', '70']),
      env: {},
      stdout: sink().stream,
      stderr: sink().stream,
      runtimeFactory: stubRuntime(terminal()),
      now() { return clock[Math.min(index++, clock.length - 1)]; },
    });
    bytes.push(readFileSync(path, 'utf8'));
  }
  assert.equal(bytes[0], bytes[1]);
});
