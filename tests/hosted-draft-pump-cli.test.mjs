import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HostedDraftPumpCliError,
  createHostedDraftPumpRuntime,
  main,
} from '../scripts/hosted-draft-pump.mjs';

const OPERATION_ID = 'a'.repeat(64);
const WORK_KEY = 'b'.repeat(64);
const REVISION = 'c'.repeat(64);
const ROOT_OID = 'd'.repeat(40);
const ROOT_REVISION = 'e'.repeat(64);
import { MANAGED_CREATE } from './helpers/managed-draft-config.mjs';
const MANAGED_ADVANCE = Object.freeze({
  number: 69,
  receipt: { schema: 'GaiaRoundReceiptV0', kind: 'ADVANCE' },
  effectActor: 'github:app:gaia-draft-pump',
});
const MANAGED_JSON = JSON.stringify({ create: MANAGED_CREATE, advance: null });

test('intake rejects the production schema-only claim before any runtime or ledger effects', async () => {
  const output = sink(); const errors = sink(); let runtimeStarted = false;
  const exitCode = await main({
    argv:[...commonArgs('intake'),'--repository-node-id','R_node','--owner','GuitarAlchemist'],
    env:{GAIA_ISSUE_NUMBER:'53',GAIA_MANAGED_ROUND_JSON:JSON.stringify({
      create:{receipt:{schema:'GaiaRoundReceiptV0',kind:'OPEN'},effectActor:'github:app:gaia-draft-pump',effectClaim:{schema:'GaiaManagedRoundEffectClaimV0'}},advance:null})},
    stdout:output.stream,stderr:errors.stream,
    runtimeFactory(){runtimeStarted=true;throw new Error('Runtime must not start');},
  });
  assert.equal(runtimeStarted,false);
  assert.equal(exitCode,2);
  assert.equal(output.text(),'');
  assert.deepEqual(errors.json(),{schema:'GaiaHostedDraftPumpCliErrorV0',error:'InvalidArguments'});
});

test('intake rejects malformed receipts and claims with redacted errors before effects', async (context) => {
  for (const [name, mutate] of [
    ['schema-only receipt', value => { value.receipt = {schema:'GaiaRoundReceiptV0',kind:'OPEN'}; }],
    ['wrong effect owner', value => { value.effectActor = 'github:app:other-app'; }],
    ['lease exceeds ten minutes', value => { value.effectClaim.leaseExpiresAt = '2026-09-05T15:11:00.000Z'; }],
    ['unknown claim field', value => { value.effectClaim.secret = 'never-publish-this'; }],
    ['invalid command generation', value => { value.receipt.command.generation = 'not-a-head'; }],
  ]) {
    await context.test(name, async () => {
      const create = structuredClone(MANAGED_CREATE); mutate(create);
      const output = sink(); const errors = sink(); let runtimeStarted = false;
      const exitCode = await main({
        argv:[...commonArgs('intake'),'--repository-node-id','R_node'],
        env:{GAIA_ISSUE_NUMBER:'53',GAIA_MANAGED_ROUND_JSON:JSON.stringify({create,advance:null})},
        stdout:output.stream,stderr:errors.stream,
        runtimeFactory(){runtimeStarted=true;throw new Error('Runtime must not start');},
      });
      assert.equal(runtimeStarted,false);
      assert.equal(exitCode,2);
      assert.equal(output.text(),'');
      assert.deepEqual(errors.json(),{schema:'GaiaHostedDraftPumpCliErrorV0',error:'InvalidArguments'});
    });
  }
});

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
      '--managed-round', MANAGED_JSON,
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
    managedRound: { create: MANAGED_CREATE, advance: MANAGED_ADVANCE },
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
  const evidencePort = { read() {}, compareAndAppend() {}, leaseState() {} };
  const managedApi = { createDraft() {}, observe() {}, observeByOperation() {},
    compareAndSetBody() {}, proveCreateAbsent() {} };
  const managedAdapter = { observe() {}, compareAndSet() {} };
  const dependencies = {
    createGhGitDataApi(options) { calls.push(['git-data', options]); return gitData; },
    createGitDataDraftOperationStore(options) { calls.push(['store', options]); return store; },
    createGhDraftCollectorApi() { calls.push(['collector-api']); return collectorApi; },
    createHostedDraftCollector(options) { calls.push(['collector', options]); return collector; },
    createGhDraftOperationProvider(options) { calls.push(['provider', options]); return provider; },
    createGitHubManagedRoundEvidencePort(options) {
      calls.push(['managed-evidence', options]); return evidencePort;
    },
    createGhManagedRoundApi(options) { calls.push(['managed-api', options]); return managedApi; },
    createGitHubManagedRoundAdapter(options) {
      calls.push(['managed-adapter', options]); return managedAdapter;
    },
    createGitHubActionsDraftAdmission(options) { calls.push(['admission', options]); return admission; },
    createDraftOperationPorts(options) { calls.push(['ports', options]); return options; },
    async enqueueDraft(selector, expected, ports) {
      calls.push(['enqueue-core', selector, expected, ports]);
      return { kind: 'Enqueued', operationId: OPERATION_ID };
    },
    async reconcileDraft(operationId, expected, ports) {
      calls.push(['reconcile-core', operationId, expected, ports]);
      return { kind: 'Terminal', outcome: 'CREATED', operationId,
        pullRequest: { number: 69 } };
    },
    async executeManagedRoundUpdate(input) {
      calls.push(['managed-update', input]);
      return { kind: 'APPLIED', operationId: '9'.repeat(64) };
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
  assert.deepEqual(calls.find(([kind]) => kind === 'provider')[1].managedRound, {
    workKey: WORK_KEY, ...MANAGED_CREATE, evidencePort,
  });
  assert.equal(calls.find(([kind]) => kind === 'managed-evidence')[1].gitData, gitData);
  assert.equal(calls.find(([kind]) => kind === 'managed-adapter')[1].api, managedApi);
  assert.deepEqual(calls.find(([kind]) => kind === 'managed-update')[1], {
    workKey: WORK_KEY, number: 69, receipt: MANAGED_ADVANCE.receipt,
    effectActor: MANAGED_ADVANCE.effectActor, adapter: managedAdapter, evidencePort,
  });
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
    managedRound: { create: MANAGED_CREATE, advance: null },
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

test('intake is an accepted command and reaches the runtime as such', async () => {
  const output = sink();
  const errors = sink();
  const seen = [];
  const exitCode = await main({
    argv: [...commonArgs('intake'), '--repository-node-id', 'R_node', '--owner', 'GuitarAlchemist'],
    env: { GAIA_ISSUE_NUMBER: '70', GAIA_MANAGED_ROUND_JSON: MANAGED_JSON },
    stdout: output.stream,
    stderr: errors.stream,
    runtimeFactory(configuration) {
      seen.push(configuration);
      return Object.freeze({
        async listUnsettled() { return []; },
        async enqueue() { return { kind: 'StaleRevision', currentCommittedRevision: REVISION }; },
        async reconcile() { assert.fail('nothing was admitted'); },
      });
    },
  });

  assert.equal(errors.text(), '');
  assert.equal(exitCode, 0);
  assert.equal(seen[0].command, 'intake');
  assert.deepEqual(seen[0].managedRound, JSON.parse(MANAGED_JSON));
  assert.equal(output.json().command, 'intake');
});

test('intake admission is sealed to the intake workflow path, with no CLI or env override', async () => {
  const paths = [];
  function dependenciesCapturing() {
    return {
      createGhGitDataApi() { return {}; },
      createGitDataDraftOperationStore() {
        return {
          async inspectByOperation() {
            return {
              identity: { workKey: WORK_KEY },
              envelope: { workItem: { kind: 'ISSUE', number: 70 } },
            };
          },
        };
      },
      createGhDraftCollectorApi() { return {}; },
      createHostedDraftCollector() { return {}; },
      createGhDraftOperationProvider() { return {}; },
      createGitHubManagedRoundEvidencePort() {
        return { read() {}, compareAndAppend() {}, leaseState() {} };
      },
      createGitHubActionsDraftAdmission({ expectedWorkflowPath }) {
        paths.push(expectedWorkflowPath);
        return {};
      },
      createDraftOperationPorts() { return {}; },
      async enqueueDraft() {
        return {
          kind: 'Enqueued', operationId: OPERATION_ID, workKey: WORK_KEY,
          generationKey: 'f'.repeat(64), committedRevision: REVISION,
        };
      },
      async reconcileDraft() {
        return { kind: 'Pending', operationId: OPERATION_ID, committedRevision: REVISION };
      },
      async listUnsettledDrafts() { return []; },
      async readWorkflowAdmission() { return {}; },
    };
  }

  const base = Object.freeze({
    repository: Object.freeze({ owner: 'GuitarAlchemist', name: 'gaia' }),
    repositoryNodeId: 'R_node',
    pumpActorId: 1234,
    ledgerRootOid: ROOT_OID,
    ledgerRootRevision: ROOT_REVISION,
    presentation: undefined,
    managedRound: { create: MANAGED_CREATE, advance: null },
  });

  const intake = createHostedDraftPumpRuntime(
    { ...base,
      command: 'intake',
      environment: {
        GAIA_ADMISSION_WORKFLOW_PATH: '.github/workflows/attacker.yml',
        EFFECT_WORKFLOW_PATH: '.github/workflows/attacker.yml',
      } },
    { async append() {} },
    dependenciesCapturing(),
  );
  await intake.enqueue({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    workItem: { kind: 'ISSUE', number: 70 },
  });
  await intake.reconcile({
    operationId: OPERATION_ID, workKey: WORK_KEY, expectedRevision: REVISION,
  });

  const reconcile = createHostedDraftPumpRuntime(
    { ...base, command: 'reconcile', environment: {} },
    { async append() {} },
    dependenciesCapturing(),
  );
  await reconcile.reconcile({
    operationId: OPERATION_ID, workKey: WORK_KEY, expectedRevision: REVISION,
  });

  assert.ok(paths.length >= 1, 'admission must be constructed for an intake effect');
  for (const path of paths.slice(0, -1)) {
    assert.equal(path, '.github/workflows/hosted-draft-intake.yml');
  }
  assert.equal(paths.at(-1), '.github/workflows/hosted-draft-pump-effect.yml');
});
