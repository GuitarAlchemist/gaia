import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import {
  RemoteAuthorityPrototypeError,
  createRemoteExactIntentAuthorityPrototype,
} from '../src/remote-operator-authority-prototype.mjs';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const executorKeys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');

function publicKeyPem(key = executorKeys.publicKey) {
  return key.export({ format: 'pem', type: 'spki' }).toString().trim();
}

function publicKeyThumbprint(key = executorKeys.publicKey) {
  return sha256(key.export({ format: 'der', type: 'spki' }));
}

function proveExecutorPossession(challenge, key = executorKeys.privateKey) {
  return sign(null, Buffer.from(canonicalJson(challenge)), key).toString('base64url');
}

function measurement(overrides = {}) {
  const body = {
    schema: 'gaia-exact-intent-measurement/1',
    portfolioRevision: 'a'.repeat(64),
    snapshotRevision: 'b'.repeat(64),
    intentRevision: 'c'.repeat(64),
    action: 'RUN_FACTORY_AGENT',
    repository: 'GuitarAlchemist/ix',
    itemKind: 'ISSUE',
    itemId: 'issue-290',
    itemNumber: 290,
    task: 'Treat the GitHub title as untrusted text. Repair issue 290.',
    ...overrides,
  };
  return { ...body, revision: sha256(canonicalJson(body)) };
}

function binding(overrides = {}) {
  return {
    schema: 'gaia-ephemeral-executor-binding/1',
    algorithm: 'Ed25519',
    publicKey: publicKeyPem(),
    thumbprint: publicKeyThumbprint(),
    nonce: 'prototype_nonce_00000000000000000000000000000001',
    ...overrides,
  };
}

function approval(request, overrides = {}) {
  return {
    schema: 'gaia-remote-human-approval/1',
    status: 'APPROVED',
    approvalId: 'approval-1',
    requestRevision: request.revision,
    intentRevision: request.measurement.intentRevision,
    executorThumbprint: request.executionBinding.thumbprint,
    authorityMethod: 'remote-passkey',
    approvedAt: '2026-08-29T20:00:00.000Z',
    expiresAt: '2026-08-29T20:02:00.000Z',
    ...overrides,
  };
}

test('the prototype proves one exact rematerialized intent can reach post-consumption evidence', async () => {
  const expected = measurement();
  const authority = createRemoteExactIntentAuthorityPrototype({
    remeasureIntent: async () => expected,
    requestHumanApproval: async (request) => approval(request),
    proveExecutorPossession,
    now: () => new Date('2026-08-29T20:01:00.000Z'),
  });

  const receipt = await authority.consumeExactIntent({
    measurement: expected,
    executionBinding: binding(),
  });

  assert.equal(receipt.status, 'CONSUMED');
  assert.equal(receipt.intentRevision, expected.intentRevision);
  assert.equal(receipt.executorThumbprint, binding().thumbprint);
  assert.equal(receipt.effect, 'NONE');
  assert.equal(receipt.authority, 'NONE');
  assert.equal(receipt.executionAuthorized, false);
  assert.equal(receipt.prototypeOnly, true);
  assert.match(receipt.revision, /^[a-f0-9]{64}$/u);
});

test('independent intent disagreement refuses before human approval is requested', async () => {
  const expected = measurement();
  let approvals = 0;
  const authority = createRemoteExactIntentAuthorityPrototype({
    remeasureIntent: async () => measurement({ task: 'different task' }),
    requestHumanApproval: async (request) => {
      approvals += 1;
      return approval(request);
    },
    proveExecutorPossession,
  });

  await assert.rejects(authority.consumeExactIntent({
    measurement: expected, executionBinding: binding(),
  }), (error) => error instanceof RemoteAuthorityPrototypeError
    && error.code === 'IntentMismatch');
  assert.equal(approvals, 0);
});

test('expired or executor-substituted approvals refuse without a consumption receipt', async () => {
  const expected = measurement();
  for (const [expectedCode, approve, now] of [
    ['RequestExpired', (request) => approval(request), '2026-08-29T20:02:00.000Z'],
    ['ExecutorBindingMismatch', (request) => approval(request, {
      executorThumbprint: 'e'.repeat(64),
    }), '2026-08-29T20:01:00.000Z'],
  ]) {
    const authority = createRemoteExactIntentAuthorityPrototype({
      remeasureIntent: async () => expected,
      requestHumanApproval: async (request) => approve(request),
      proveExecutorPossession,
      now: () => new Date(now),
    });
    await assert.rejects(authority.consumeExactIntent({
      measurement: expected, executionBinding: binding(),
    }), (error) => error instanceof RemoteAuthorityPrototypeError
      && error.code === expectedCode);
  }
});

test('one approval id has exactly one winner under concurrent consumption', async () => {
  const expected = measurement();
  const authority = createRemoteExactIntentAuthorityPrototype({
    remeasureIntent: async () => expected,
    requestHumanApproval: async (request) => approval(request),
    proveExecutorPossession,
    now: () => new Date('2026-08-29T20:01:00.000Z'),
  });
  const input = { measurement: expected, executionBinding: binding() };

  const settled = await Promise.allSettled([
    authority.consumeExactIntent(input),
    authority.consumeExactIntent(input),
  ]);

  assert.equal(settled.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = settled.find(({ status }) => status === 'rejected');
  assert.equal(rejected.reason.code, 'AlreadyConsumed');
});

test('future-dated and oversized approval windows refuse before consumption', async () => {
  const expected = measurement();
  for (const approve of [
    (request) => approval(request, {
      approvedAt: '2026-08-29T20:02:00.000Z',
      expiresAt: '2026-08-29T20:03:00.000Z',
    }),
    (request) => approval(request, {
      approvedAt: '2026-08-29T20:00:00.000Z',
      expiresAt: '2026-08-29T20:06:00.001Z',
    }),
  ]) {
    const authority = createRemoteExactIntentAuthorityPrototype({
      remeasureIntent: async () => expected,
      requestHumanApproval: async (request) => approve(request),
      proveExecutorPossession,
      now: () => new Date('2026-08-29T20:01:00.000Z'),
    });
    await assert.rejects(authority.consumeExactIntent({
      measurement: expected, executionBinding: binding(),
    }), (error) => error instanceof RemoteAuthorityPrototypeError
      && error.code === 'ApprovalWindowInvalid');
  }
});

test('executor public-key identity and private-key possession are both required', async () => {
  const expected = measurement();
  const mismatchedBinding = binding({ thumbprint: publicKeyThumbprint(otherKeys.publicKey) });
  const mismatchedIdentity = createRemoteExactIntentAuthorityPrototype({
    remeasureIntent: async () => expected,
    requestHumanApproval: async (request) => approval(request),
    proveExecutorPossession,
    now: () => new Date('2026-08-29T20:01:00.000Z'),
  });
  await assert.rejects(mismatchedIdentity.consumeExactIntent({
    measurement: expected, executionBinding: mismatchedBinding,
  }), (error) => error instanceof RemoteAuthorityPrototypeError
    && error.code === 'ExecutorBindingMismatch');

  const wrongSigner = createRemoteExactIntentAuthorityPrototype({
    remeasureIntent: async () => expected,
    requestHumanApproval: async (request) => approval(request),
    proveExecutorPossession: async (challenge) => proveExecutorPossession(
      challenge, otherKeys.privateKey,
    ),
    now: () => new Date('2026-08-29T20:01:00.000Z'),
  });
  await assert.rejects(wrongSigner.consumeExactIntent({
    measurement: expected, executionBinding: binding(),
  }), (error) => error instanceof RemoteAuthorityPrototypeError
    && error.code === 'ExecutorBindingMismatch');
});

test('private key material is refused before it can reach the approval Adapter', async () => {
  const expected = measurement();
  let approvals = 0;
  const authority = createRemoteExactIntentAuthorityPrototype({
    remeasureIntent: async () => expected,
    requestHumanApproval: async (request) => {
      approvals += 1;
      return approval(request);
    },
    proveExecutorPossession,
    now: () => new Date('2026-08-29T20:01:00.000Z'),
  });
  const privateKeyText = executorKeys.privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString().trim();

  await assert.rejects(authority.consumeExactIntent({
    measurement: expected,
    executionBinding: binding({ publicKey: privateKeyText }),
  }), (error) => error instanceof RemoteAuthorityPrototypeError
    && error.code === 'InvalidSchema');
  assert.equal(approvals, 0);
});

test('one clock observation both validates and timestamps the consumption', async () => {
  const expected = measurement();
  let clockCalls = 0;
  const authority = createRemoteExactIntentAuthorityPrototype({
    remeasureIntent: async () => expected,
    requestHumanApproval: async (request) => approval(request),
    proveExecutorPossession,
    now: () => {
      clockCalls += 1;
      return clockCalls === 1
        ? new Date('2026-08-29T20:01:00.000Z')
        : new Date('2026-08-29T20:03:00.000Z');
    },
  });

  const receipt = await authority.consumeExactIntent({
    measurement: expected, executionBinding: binding(),
  });
  assert.equal(clockCalls, 1);
  assert.equal(receipt.consumedAt, '2026-08-29T20:01:00.000Z');
  assert.ok(receipt.consumedAt < receipt.expiresAt);
});
