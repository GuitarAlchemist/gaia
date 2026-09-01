import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGitHubActionsDraftAdmission,
} from '../src/github-actions-draft-admission.mjs';

const REPOSITORY = 'GuitarAlchemist/gaia';
const WORK_KEY = 'a'.repeat(64);
const OPERATION_ID = 'b'.repeat(64);
const CLAIMED_REVISION = 'c'.repeat(64);
const EPOCH = Object.freeze({ runId: 73001, runAttempt: 2 });

function context(overrides = {}) {
  return {
    workKey: WORK_KEY,
    operationId: OPERATION_ID,
    executorEpoch: EPOCH,
    claimedRevision: CLAIMED_REVISION,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    repository: { full_name: REPOSITORY },
    id: EPOCH.runId,
    run_attempt: EPOCH.runAttempt,
    status: 'in_progress',
    ...overrides,
  };
}

function adapter(readWorkflowAdmission, environment = {}) {
  return createGitHubActionsDraftAdmission({
    expectedRepository: REPOSITORY,
    expectedWorkKey: WORK_KEY,
    environment: {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_RUN_ID: String(EPOCH.runId),
      GITHUB_RUN_ATTEMPT: String(EPOCH.runAttempt),
      ...environment,
    },
    readWorkflowAdmission,
  });
}

test('an exact in-progress run reserves one effect slot under the workflow-owned concurrency lock', async () => {
  const calls = [];
  const admission = adapter(async (request) => {
    calls.push(structuredClone(request));
    return observation();
  });

  assert.deepEqual(admission.executorEpoch, EPOCH);
  assert.equal(await admission.reserveEffect(context()), 'AVAILABLE');
  assert.deepEqual(calls, [{
    repository: REPOSITORY,
    runId: EPOCH.runId,
    runAttempt: EPOCH.runAttempt,
  }]);
});

test('the adapter fails closed before reading GitHub for a non-exact claim context', async () => {
  let reads = 0;
  const admission = adapter(async () => {
    reads += 1;
    return observation();
  });
  const refusals = [
    context({ workKey: 'd'.repeat(64) }),
    context({ operationId: 'not-an-operation' }),
    context({ executorEpoch: { runId: EPOCH.runId, runAttempt: 1 } }),
    context({ claimedRevision: 'not-a-revision' }),
    { ...context(), unexpected: true },
  ];

  for (const claim of refusals) {
    assert.equal(await admission.reserveEffect(claim), 'ZERO');
  }
  assert.equal(reads, 0);
});

test('unavailable or mismatched workflow evidence never grants capacity', async () => {
  const mismatches = [
    observation({ repository: { full_name: 'GuitarAlchemist/ix' } }),
    observation({ id: EPOCH.runId + 1 }),
    observation({ run_attempt: EPOCH.runAttempt + 1 }),
    observation({ status: 'queued' }),
    observation({ status: 'completed' }),
    null,
  ];

  for (const observed of mismatches) {
    const admission = adapter(async () => observed);
    assert.equal(await admission.reserveEffect(context()), 'ZERO');
  }
});

test('GitHub read failures are redacted into ZERO and outputs are closed', async () => {
  const admission = adapter(async () => {
    throw new Error('secret provider response');
  });

  const result = await admission.reserveEffect(context());
  assert.equal(result, 'ZERO');
  assert.ok(['AVAILABLE', 'ZERO'].includes(result));
});

test('configuration is bound to canonical Actions identity values', () => {
  for (const environment of [
    { GITHUB_REPOSITORY: 'GuitarAlchemist/ix' },
    { GITHUB_RUN_ID: '0' },
    { GITHUB_RUN_ID: '73001.0' },
    { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_RUN_ATTEMPT: '02' },
  ]) {
    assert.throws(
      () => adapter(async () => observation(), environment),
      (error) => error?.code === 'InvalidConfiguration'
        && !String(error.message).includes('GuitarAlchemist/ix'),
    );
  }
});

test('the Actions epoch can be read from the exotic process.env-style object', async () => {
  const environment = Object.assign(Object.create({ environmentMarker: true }), {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_RUN_ID: String(EPOCH.runId),
    GITHUB_RUN_ATTEMPT: String(EPOCH.runAttempt),
  });
  const admission = createGitHubActionsDraftAdmission({
    expectedRepository: REPOSITORY,
    expectedWorkKey: WORK_KEY,
    environment,
    readWorkflowAdmission: async () => observation(),
  });

  assert.equal(await admission.reserveEffect(context()), 'AVAILABLE');
});
