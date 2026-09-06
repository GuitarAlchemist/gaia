import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main } from '../scripts/hosted-draft-pump.mjs';

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

function commonArgs() {
  return [
    'intake',
    '--repository', 'test-org/test-repo',
    '--pump-actor-id', '123',
    '--repository-node-id', 'R_test',
    '--ledger-root-oid', ROOT_OID,
    '--ledger-root-revision', ROOT_REVISION,
  ];
}

function policyFixture(overrides = {}) {
  return {
    schema: 'GaiaNormalAdmissionPolicyV0', version: 1,
    repository: { nodeId: 'R_test', owner: 'test-org', name: 'test-repo' },
    effectActorId: 123,
    validFrom: '2026-09-05T21:00:00.000Z', validUntil: '2026-09-05T22:00:00.000Z',
    accountableOwner: 'github:user:test-owner', effectOwner: 'github:app:test-pump',
    reviewOwners: { standards: 'github:user:test-standards', spec: 'github:user:test-spec' },
    allowedEffect: 'CREATE_DRAFT', roundBudget: 1,
    ...overrides,
  };
}

async function withPolicyFile(t, policy) {
  const dir = mkdtempSync(join(tmpdir(), 'gaia-normal-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'policy.json');
  writeFileSync(path, JSON.stringify(policy));
  return path;
}

test('a normal-policy file that mismatches the bound repository/actor is refused before any runtime', async (t) => {
  const path = await withPolicyFile(t, policyFixture({ effectActorId: 999 }));
  const output = sink(); const errors = sink(); let runtimeStarted = false;
  const exitCode = await main({
    argv: [...commonArgs(), '--normal-policy', path],
    env: {}, stdout: output.stream, stderr: errors.stream,
    runtimeFactory() { runtimeStarted = true; throw new Error('runtime must not start'); },
  });
  assert.equal(runtimeStarted, false);
  assert.equal(exitCode, 2);
  assert.equal(output.text(), '');
  assert.deepEqual(errors.json(), { schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'NormalPolicyScopeMismatch' });
});

test('a missing normal-policy file refuses precisely, never falling back to a fixture claim', async () => {
  const output = sink(); const errors = sink(); let runtimeStarted = false;
  const exitCode = await main({
    argv: [...commonArgs(), '--normal-policy', join(tmpdir(), 'gaia-normal-policy-does-not-exist.json')],
    env: {}, stdout: output.stream, stderr: errors.stream,
    runtimeFactory() { runtimeStarted = true; throw new Error('runtime must not start'); },
  });
  assert.equal(runtimeStarted, false);
  assert.equal(exitCode, 2);
  assert.equal(output.text(), '');
  assert.deepEqual(errors.json(), { schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'NormalPolicyUnavailable' });
});

test('malformed normal policy returns only a closed non-secret diagnostic', async t => {
  for (const [content, expected] of [
    ['{"private":"secret-sentinel",', 'InvalidNormalPolicyJson'],
    [JSON.stringify(policyFixture({ accountableOwner: 'secret-sentinel' })), 'InvalidNormalPolicy'],
    [JSON.stringify(policyFixture({ validFrom: 'secret-sentinel' })), 'InvalidNormalTime'],
  ]) {
    const path = await withPolicyFile(t, {});
    writeFileSync(path, content);
    const output = sink(); const errors = sink(); let calls = 0;
    const code = await main({ argv: [...commonArgs(), '--normal-policy', path], env: {},
      stdout: output.stream, stderr: errors.stream, runtimeFactory: () => { calls++; } });
    assert.equal(code, 2);
    assert.equal(calls, 0);
    assert.equal(output.text(), '');
    assert.deepEqual(errors.json(), { schema: 'GaiaHostedDraftPumpCliErrorV0', error: expected });
    assert.doesNotMatch(errors.text(), /secret-sentinel|policy\.json|stack/);
  }
});

test('canary-policy and normal-policy are mutually exclusive', async (t) => {
  const normalPath = await withPolicyFile(t, policyFixture());
  const canaryPath = await withPolicyFile(t, {
    schema: 'GaiaCanaryAdmissionPolicyV0', version: 1,
    repository: { nodeId: 'R_test', owner: 'test-org', name: 'test-repo' },
    issue: 40, operationId: 'a'.repeat(64), generationKey: 'b'.repeat(64),
    headRevision: 'c'.repeat(40), effectActorId: 123,
    validFrom: '2026-09-05T21:00:00.000Z', validUntil: '2026-09-05T22:00:00.000Z',
    accountableOwner: 'github:user:test-owner', effectOwner: 'github:app:test-pump',
    reviewOwners: { standards: 'github:user:test-standards', spec: 'github:user:test-spec' },
    allowedEffect: 'CREATE_DRAFT', roundBudget: 1,
  });
  const output = sink(); const errors = sink(); let runtimeStarted = false;
  const exitCode = await main({
    argv: [...commonArgs(), '--normal-policy', normalPath, '--canary-policy', canaryPath],
    env: {}, stdout: output.stream, stderr: errors.stream,
    runtimeFactory() { runtimeStarted = true; throw new Error('runtime must not start'); },
  });
  assert.equal(runtimeStarted, false);
  assert.equal(exitCode, 2);
  assert.deepEqual(errors.json(), { schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'InvalidArguments' });
});

test('a well-formed normal-policy binds into configuration and never requires a static managed-round blob', async (t) => {
  const policy = policyFixture();
  const path = await withPolicyFile(t, policy);
  const output = sink(); const errors = sink();
  let configuration;
  const exitCode = await main({
    argv: [...commonArgs(), '--normal-policy', path],
    env: {}, stdout: output.stream, stderr: errors.stream,
    runtimeFactory(config) {
      configuration = config;
      return Object.freeze({
        async enqueue() { assert.fail('this test does not select a candidate'); },
        async reconcile() { assert.fail('this test does not select a candidate'); },
        async listUnsettled() { return []; },
        async listReadyIssues() { return []; },
      });
    },
  });
  assert.equal(exitCode, 0, errors.text());
  assert.deepEqual(configuration.normalPolicy, policy);
  assert.equal(configuration.canaryPolicy, undefined);
  assert.deepEqual(configuration.managedRound, { advance: null });
});
