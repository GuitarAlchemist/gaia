import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HostedDraftPumpCliError,
  createHostedDraftPumpRuntime,
  main,
} from '../scripts/hosted-draft-pump.mjs';
import { GitHubActionsDraftAdmissionError } from '../src/github-actions-draft-admission.mjs';

const OPERATION_ID = 'a'.repeat(64);
const WORK_KEY = 'b'.repeat(64);
const REVISION = 'c'.repeat(64);
const ROOT_OID = 'd'.repeat(40);
const ROOT_REVISION = 'e'.repeat(64);

function sink() {
  let value = '';
  return {
    stream: { write(chunk) { value += String(chunk); } },
    text() { return value; },
    json() { return JSON.parse(value.trim()); },
  };
}

function commonArgs(command) {
  return [
    command,
    '--repository', 'GuitarAlchemist/gaia',
    '--pump-actor-id', '1234',
    '--ledger-root-oid', ROOT_OID,
    '--ledger-root-revision', ROOT_REVISION,
  ];
}

test('enqueue emits one closed durable receipt and never invokes a provider effect', async () => {
  const output = sink();
  const errors = sink();
  const calls = [];
  const exitCode = await main({
    argv: [...commonArgs('enqueue'), '--issue', '60'],
    env: {}, stdout: output.stream, stderr: errors.stream,
    runtimeFactory(configuration, telemetry) {
      calls.push(['runtime', configuration]);
      return Object.freeze({
        async enqueue(selector) {
          calls.push(['enqueue', selector]);
          await telemetry.append({ kind: 'ENQUEUED', operationId: OPERATION_ID });
          return {
            kind: 'Enqueued', operationId: OPERATION_ID, workKey: WORK_KEY,
            generationKey: 'f'.repeat(64), committedRevision: REVISION,
          };
        },
        async reconcile() { assert.fail('enqueue must perform no provider effect'); },
        async listUnsettled() { assert.fail('enqueue must not run the supervisor'); },
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(errors.text(), '');
  assert.deepEqual(calls[1], ['enqueue', {
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    workItem: { kind: 'ISSUE', number: 60 },
  }]);
  assert.deepEqual(output.json(), {
    schema: 'GaiaHostedDraftPumpCliReceiptV0',
    command: 'enqueue',
    operationId: OPERATION_ID,
    workKey: WORK_KEY,
    committedRevision: REVISION,
    result: {
      kind: 'Enqueued', operationId: OPERATION_ID, workKey: WORK_KEY,
      generationKey: 'f'.repeat(64), committedRevision: REVISION,
    },
    telemetry: [{ kind: 'ENQUEUED', operationId: OPERATION_ID }],
  });
});

test('reconcile binds one durable operation, Actions work key, and concise Draft presentation', async () => {
  const output = sink();
  const errors = sink();
  let observedConfiguration;
  const exitCode = await main({
    argv: [
      ...commonArgs('reconcile'),
      '--operation-id', OPERATION_ID,
      '--work-key', WORK_KEY,
      '--expected-revision', REVISION,
      '--repository-node-id', 'R_kgDOGaia',
      '--owner', 'Gaia hosted Draft pump',
      '--gate', 'R4_PROVIDER',
      '--check', 'Bind the exact generation',
      '--check', 'Publish provider evidence',
      '--eta-minutes', '60:120',
    ],
    env: {
      GITHUB_REPOSITORY: 'GuitarAlchemist/gaia',
      GITHUB_RUN_ID: '9001',
      GITHUB_RUN_ATTEMPT: '2',
    },
    stdout: output.stream, stderr: errors.stream,
    runtimeFactory(configuration, telemetry) {
      observedConfiguration = configuration;
      return Object.freeze({
        async enqueue() { assert.fail('reconcile must not collect a new issue'); },
        async reconcile(operation) {
          await telemetry.append({ kind: 'REUSED', operationId: operation.operationId });
          return {
            kind: 'Terminal', outcome: 'REUSED', effect: 'NONE',
            operationId: operation.operationId, committedRevision: 'f'.repeat(64),
          };
        },
        async listUnsettled() { assert.fail('reconcile must not list all operations'); },
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(errors.text(), '');
  assert.deepEqual(observedConfiguration.presentation, {
    owner: 'Gaia hosted Draft pump',
    gate: 'R4_PROVIDER',
    checklist: ['Bind the exact generation', 'Publish provider evidence'],
    eta: { minimumMinutes: 60, maximumMinutes: 120 },
  });
  assert.equal(observedConfiguration.workKey, WORK_KEY);
  assert.equal(output.json().result.outcome, 'REUSED');
  assert.deepEqual(output.json().telemetry, [{ kind: 'REUSED', operationId: OPERATION_ID }]);
});

test('list-unsettled emits the durable supervisor projection without local state', async () => {
  const output = sink();
  const exitCode = await main({
    argv: commonArgs('list-unsettled'), env: {}, stdout: output.stream, stderr: sink().stream,
    runtimeFactory(_configuration, telemetry) {
      return Object.freeze({
        async enqueue() { assert.fail(); },
        async reconcile() { assert.fail(); },
        async listUnsettled() {
          assert.deepEqual(telemetry.events, []);
          return [{
            operationId: OPERATION_ID, workKey: WORK_KEY, committedRevision: REVISION,
            selector: {
              repository: { owner: 'GuitarAlchemist', name: 'gaia' },
              workItem: { kind: 'ISSUE', number: 60 },
            },
          }];
        },
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(output.json(), {
    schema: 'GaiaHostedDraftPumpCliReceiptV0',
    command: 'list-unsettled',
    operations: [{
      operationId: OPERATION_ID, workKey: WORK_KEY, committedRevision: REVISION,
      selector: {
        repository: { owner: 'GuitarAlchemist', name: 'gaia' },
        workItem: { kind: 'ISSUE', number: 60 },
      },
    }],
    telemetry: [],
  });
});

test('invalid arguments and provider failures return only closed redacted errors', async (context) => {
  await context.test('invalid arguments', async () => {
    const output = sink();
    const errors = sink();
    const exitCode = await main({
      argv: ['enqueue', '--repository', 'GuitarAlchemist/gaia', '--unknown', 'secret'],
      env: {}, stdout: output.stream, stderr: errors.stream,
      runtimeFactory() { assert.fail('invalid arguments must fail before composition'); },
    });
    assert.equal(exitCode, 2);
    assert.equal(output.text(), '');
    assert.deepEqual(errors.json(), {
      schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'InvalidArguments',
    });
  });

  await context.test('redacted operation failure', async () => {
    const output = sink();
    const errors = sink();
    const secret = 'ghp_do-not-leak';
    const exitCode = await main({
      argv: [...commonArgs('enqueue'), '--issue', '60'],
      env: {}, stdout: output.stream, stderr: errors.stream,
      runtimeFactory() {
        return Object.freeze({
          async enqueue() { throw new Error(`403 token ${secret}`); },
          async reconcile() { assert.fail(); },
          async listUnsettled() { assert.fail(); },
        });
      },
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(errors.json(), {
      schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'OperationFailed',
    });
    assert.ok(!errors.text().includes(secret));
  });

  await context.test('closed admission configuration classification', async () => {
    const output = sink();
    const errors = sink();
    const exitCode = await main({
      argv: [...commonArgs('enqueue'), '--issue', '60'],
      env: {}, stdout: output.stream, stderr: errors.stream,
      runtimeFactory() {
        return Object.freeze({
          async enqueue() { throw new GitHubActionsDraftAdmissionError('InvalidConfiguration'); },
          async reconcile() { assert.fail(); },
          async listUnsettled() { assert.fail(); },
        });
      },
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(errors.json(), {
      schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'AdmissionConfigurationFailed',
    });
  });

  assert.equal(new HostedDraftPumpCliError('InvalidArguments').message, 'InvalidArguments');
});

test('the production runtime composition wires existing collector, Git Data, provider, admission, and core seams', async () => {
  const calls = [];
  const telemetry = { events: [], async append(event) { this.events.push(event); } };
  const environment = {
    GITHUB_REPOSITORY: 'GuitarAlchemist/gaia',
    GITHUB_RUN_ID: '9001',
    GITHUB_RUN_ATTEMPT: '2',
  };
  const configuration = {
    command: 'reconcile',
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActorId: 1234,
    ledgerRootOid: ROOT_OID,
    ledgerRootRevision: ROOT_REVISION,
    environment,
    operationId: OPERATION_ID,
    workKey: WORK_KEY,
    expectedRevision: REVISION,
    repositoryNodeId: 'R_kgDOGaia',
    presentation: {
      owner: 'Gaia hosted Draft pump',
      gate: 'R4_PROVIDER',
      checklist: ['Bind the exact generation'],
      eta: { minimumMinutes: 60, maximumMinutes: 120 },
    },
  };
  const gitData = { name: 'git-data' };
  const store = {
    name: 'store',
    async inspectByOperation() {
      return {
        identity: { workKey: WORK_KEY },
        envelope: { workItem: { kind: 'ISSUE', number: 60 } },
      };
    },
  };
  const collectorApi = { name: 'collector-api' };
  const collector = { collect() {} };
  const provider = { lookupExact() {}, createDraft() {} };
  const admission = { executorEpoch: { runId: 9001, runAttempt: 2 }, reserveEffect() {} };
  const dependencies = {
    createGhGitDataApi(options) { calls.push(['git-data', options]); return gitData; },
    createGitDataDraftOperationStore(options) { calls.push(['store', options]); return store; },
    createGhDraftCollectorApi() { calls.push(['collector-api']); return collectorApi; },
    createHostedDraftCollector(options) { calls.push(['collector', options]); return collector; },
    createGhDraftOperationProvider(options) { calls.push(['provider', options]); return provider; },
    createGitHubActionsDraftAdmission(options) { calls.push(['admission', options]); return admission; },
    createDraftOperationPorts(options) { calls.push(['ports', options]); return options; },
    async enqueueDraft(selector, expected, ports) {
      calls.push(['enqueue-core', selector, expected, ports]);
      return { kind: 'Enqueued', operationId: OPERATION_ID };
    },
    async reconcileDraft(operationId, expected, ports) {
      calls.push(['reconcile-core', operationId, expected, ports]);
      return { kind: 'Terminal', operationId };
    },
    async listUnsettledDrafts(ports) {
      calls.push(['list-core', ports]);
      return [];
    },
    async readWorkflowAdmission() { return {}; },
  };

  const runtime = createHostedDraftPumpRuntime(configuration, telemetry, dependencies);
  await runtime.enqueue({ repository: configuration.repository,
    workItem: { kind: 'ISSUE', number: 60 } });
  await runtime.reconcile({ operationId: OPERATION_ID,
    workKey: WORK_KEY, expectedRevision: REVISION });
  await runtime.listUnsettled();

  assert.deepEqual(calls.filter(([kind]) => kind.endsWith('-core')).map(([kind]) => kind), [
    'enqueue-core', 'reconcile-core', 'list-core',
  ]);
  assert.equal(calls.find(([kind]) => kind === 'store')[1].gitData, gitData);
  assert.equal(calls.find(([kind]) => kind === 'provider')[1].expectedRepository.nodeId,
    'R_kgDOGaia');
  assert.deepEqual(calls.find(([kind]) => kind === 'provider')[1].presentation,
    configuration.presentation);
  assert.equal(calls.find(([kind]) => kind === 'admission')[1].expectedWorkKey, WORK_KEY);
  assert.equal(calls.find(([kind]) => kind === 'admission')[1].expectedWorkflowPath,
    '.github/workflows/hosted-draft-pump-effect.yml');
  assert.equal(calls.find(([kind]) => kind === 'reconcile-core')[3].executorEpoch.runId, 9001);
});

test('reconcile rejects a mismatched work key before provider, admission, or durable mutation', async () => {
  const calls = [];
  const configuration = {
    command: 'reconcile', repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActorId: 1234, ledgerRootOid: ROOT_OID, ledgerRootRevision: ROOT_REVISION,
    environment: {
      GITHUB_REPOSITORY: 'GuitarAlchemist/gaia', GITHUB_RUN_ID: '9001',
      GITHUB_RUN_ATTEMPT: '2',
    },
    operationId: OPERATION_ID, workKey: WORK_KEY, expectedRevision: REVISION,
    repositoryNodeId: 'R_kgDOGaia',
    presentation: {
      owner: 'Gaia hosted Draft pump', gate: 'DELIVERY',
      checklist: ['Persist one terminal receipt'],
      eta: { minimumMinutes: 60, maximumMinutes: 120 },
    },
  };
  const dependencies = {
    createGhGitDataApi() { return {}; },
    createGitDataDraftOperationStore() {
      return {
        async inspectByOperation() {
          return {
            identity: { workKey: 'f'.repeat(64) },
            envelope: { workItem: { kind: 'ISSUE', number: 60 } },
          };
        },
      };
    },
    createGhDraftCollectorApi() { return {}; },
    createHostedDraftCollector() { return {}; },
    createGhDraftOperationProvider() { calls.push('provider'); return {}; },
    createGitHubActionsDraftAdmission() { calls.push('admission'); return {}; },
    createDraftOperationPorts() { calls.push('ports'); return {}; },
    async enqueueDraft() {},
    async reconcileDraft() { calls.push('mutation'); },
    async listUnsettledDrafts() { return []; },
    async readWorkflowAdmission() { return {}; },
  };
  const runtime = createHostedDraftPumpRuntime(configuration, { async append() {} }, dependencies);
  await assert.rejects(
    runtime.reconcile({ operationId: OPERATION_ID, workKey: WORK_KEY,
      expectedRevision: REVISION }),
    (error) => error?.code === 'OperationBindingMismatch',
  );
  assert.deepEqual(calls, ['ports']);
});
