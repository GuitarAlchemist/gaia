import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { openContextCapsule } from '../src/context-capsule.mjs';

const canonicalValue = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
};
const bytes = (value) => Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8');
const digest = (value) => createHash('sha256').update(value).digest('hex');

function revision(artifactId, rev, content) {
  return Object.freeze({ artifactId, revision: rev, algorithm: 'sha256', digest: digest(content) });
}

function memoryAdapter(entries) {
  const calls = [];
  return {
    calls,
    async readRevision(ref) {
      calls.push(structuredClone(ref));
      const key = `${ref.artifactId}@${ref.revision}`;
      if (!entries.has(key)) throw new Error(`missing test entry ${key}`);
      return new Uint8Array(entries.get(key));
    },
  };
}

test('an exact manifest pin retrieves one projected fact with a deterministic read-only receipt', async () => {
  const factBytes = bytes({
    schema: 'gaia-context-fact/1',
    factId: 'fact-00',
    value: 'answer-00-verified',
    exposure: 'model-context',
    trust: 'untrusted-data',
    authorityEffect: 'none',
  });
  const factRevision = revision('artifact-00', '2', factBytes);
  const manifestBytes = bytes({
    schema: 'gaia-context-capsule-manifest/1',
    capsuleId: 'capsule-r1',
    selectionPolicy: 'exact-pinned-revision/1',
    facts: [{ factId: 'fact-00', source: factRevision }],
  });
  const manifestRevision = revision('capsule-manifest', '1', manifestBytes);
  const adapter = memoryAdapter(new Map([
    ['capsule-manifest@1', manifestBytes],
    ['artifact-00@2', factBytes],
  ]));

  const capsule = await openContextCapsule(manifestRevision, adapter);
  const first = await capsule.get('fact-00');
  const second = await capsule.get('fact-00');

  assert.equal(first.ok, true);
  assert.deepEqual(first.response, {
    schema: 'gaia-context-capsule-response/1',
    factId: 'fact-00',
    value: 'answer-00-verified',
    trust: 'untrusted-data',
    authorityEffect: 'none',
    source: factRevision,
  });
  assert.equal(first.receipt.schema, 'gaia-context-capsule-receipt/1');
  assert.equal(first.receipt.operation, 'get');
  assert.equal(first.receipt.selectionPolicy, 'exact-pinned-revision/1');
  assert.equal(first.receipt.readOnly, true);
  assert.equal(first.receipt.trust, 'untrusted-data');
  assert.equal(first.receipt.authorityEffect, 'none');
  assert.match(first.receipt.receiptRevision.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(second, first, 'same accepted inputs replay byte-identically');
  assert.equal(first.receiptCanonicalJson, second.receiptCanonicalJson);
  assert.deepEqual(adapter.calls, [manifestRevision, factRevision, factRevision]);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.response));
  assert.ok(Object.isFrozen(first.receipt));
});

test('unknown and traversal-shaped fact ids refuse before any fact revision is read', async () => {
  const manifestBytes = bytes({
    schema: 'gaia-context-capsule-manifest/1',
    capsuleId: 'capsule-r1',
    selectionPolicy: 'exact-pinned-revision/1',
    facts: [],
  });
  const manifestRevision = revision('capsule-manifest', '1', manifestBytes);
  const adapter = memoryAdapter(new Map([['capsule-manifest@1', manifestBytes]]));
  const capsule = await openContextCapsule(manifestRevision, adapter);

  const unknown = await capsule.get('fact-99');
  const traversal = await capsule.get('../../fixture-private.json');

  assert.deepEqual(unknown, {
    ok: false,
    error: {
      schema: 'gaia-context-capsule-error/1',
      code: 'CAPSULE_FACT_NOT_PINNED',
      failClosed: true,
      authorityEffect: 'none',
    },
  });
  assert.deepEqual(traversal, {
    ok: false,
    error: {
      schema: 'gaia-context-capsule-error/1',
      code: 'CAPSULE_INVALID_INPUT',
      failClosed: true,
      authorityEffect: 'none',
    },
  });
  assert.deepEqual(adapter.calls, [manifestRevision], 'neither refusal reached a fact Adapter read');
  assert.ok(Object.isFrozen(unknown));
  assert.ok(Object.isFrozen(unknown.error));
});

test('a pinned fact with different bytes fails closed without content or receipt', async () => {
  const expectedFactBytes = bytes({
    schema: 'gaia-context-fact/1', factId: 'fact-00', value: 'expected',
    exposure: 'model-context', trust: 'untrusted-data', authorityEffect: 'none',
  });
  const factRevision = revision('artifact-00', '2', expectedFactBytes);
  const manifestBytes = bytes({
    schema: 'gaia-context-capsule-manifest/1', capsuleId: 'capsule-r1',
    selectionPolicy: 'exact-pinned-revision/1', facts: [{ factId: 'fact-00', source: factRevision }],
  });
  const manifestRevision = revision('capsule-manifest', '1', manifestBytes);
  const tamperedFactBytes = bytes({
    schema: 'gaia-context-fact/1', factId: 'fact-00', value: 'tampered',
    exposure: 'model-context', trust: 'untrusted-data', authorityEffect: 'none',
  });
  const adapter = memoryAdapter(new Map([
    ['capsule-manifest@1', manifestBytes],
    ['artifact-00@2', tamperedFactBytes],
  ]));
  const capsule = await openContextCapsule(manifestRevision, adapter);

  const outcome = await capsule.get('fact-00');

  assert.deepEqual(outcome, {
    ok: false,
    error: {
      schema: 'gaia-context-capsule-error/1',
      code: 'CAPSULE_DIGEST_MISMATCH',
      failClosed: true,
      authorityEffect: 'none',
    },
  });
  assert.equal('response' in outcome, false);
  assert.equal('receipt' in outcome, false);
});

test('an oversized pinned fact is refused rather than truncated into model context', async () => {
  const factBytes = bytes({
    schema: 'gaia-context-fact/1', factId: 'fact-00', value: 'x'.repeat(70_000),
    exposure: 'model-context', trust: 'untrusted-data', authorityEffect: 'none',
  });
  const factRevision = revision('artifact-00', '2', factBytes);
  const manifestBytes = bytes({
    schema: 'gaia-context-capsule-manifest/1', capsuleId: 'capsule-r1',
    selectionPolicy: 'exact-pinned-revision/1', facts: [{ factId: 'fact-00', source: factRevision }],
  });
  const manifestRevision = revision('capsule-manifest', '1', manifestBytes);
  const adapter = memoryAdapter(new Map([
    ['capsule-manifest@1', manifestBytes],
    ['artifact-00@2', factBytes],
  ]));
  const capsule = await openContextCapsule(manifestRevision, adapter);

  const outcome = await capsule.get('fact-00');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'CAPSULE_LIMIT_EXCEEDED');
  assert.equal('response' in outcome, false);
  assert.equal('receipt' in outcome, false);
});

test('opening and reading never freezes or mutates the caller-owned manifest pin', async () => {
  const factBytes = bytes({
    schema: 'gaia-context-fact/1', factId: 'fact-00', value: 'answer',
    exposure: 'model-context', trust: 'untrusted-data', authorityEffect: 'none',
  });
  const factRevision = revision('artifact-00', '2', factBytes);
  const manifestBytes = bytes({
    schema: 'gaia-context-capsule-manifest/1', capsuleId: 'capsule-r1',
    selectionPolicy: 'exact-pinned-revision/1', facts: [{ factId: 'fact-00', source: factRevision }],
  });
  const callerPin = {
    artifactId: 'capsule-manifest', revision: '1', algorithm: 'sha256', digest: digest(manifestBytes),
  };
  const before = structuredClone(callerPin);
  const adapter = memoryAdapter(new Map([
    ['capsule-manifest@1', manifestBytes], ['artifact-00@2', factBytes],
  ]));

  const capsule = await openContextCapsule(callerPin, adapter);
  await capsule.get('fact-00');

  assert.deepEqual(callerPin, before);
  assert.equal(Object.isFrozen(callerPin), false, 'the Module freezes its own copy, not caller state');
  callerPin.revision = 'caller-still-owns-this-object';
  assert.equal(callerPin.revision, 'caller-still-owns-this-object');
});

test('a pinned fact with duplicate JSON object names is refused as non-canonical', async () => {
  const factBytes = Buffer.from(
    '{"authorityEffect":"none","exposure":"model-context","factId":"fact-00",'
      + '"schema":"gaia-context-fact/0","schema":"gaia-context-fact/1",'
      + '"trust":"untrusted-data","value":"answer"}',
    'utf8',
  );
  const factRevision = revision('artifact-00', '2', factBytes);
  const manifestBytes = bytes({
    schema: 'gaia-context-capsule-manifest/1', capsuleId: 'capsule-r1',
    selectionPolicy: 'exact-pinned-revision/1', facts: [{ factId: 'fact-00', source: factRevision }],
  });
  const manifestRevision = revision('capsule-manifest', '1', manifestBytes);
  const adapter = memoryAdapter(new Map([
    ['capsule-manifest@1', manifestBytes], ['artifact-00@2', factBytes],
  ]));
  const capsule = await openContextCapsule(manifestRevision, adapter);

  const outcome = await capsule.get('fact-00');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'CAPSULE_NON_CANONICAL_JSON');
  assert.equal('response' in outcome, false);
});

test('symbolic latest and branch-like revisions are refused before fact exposure', async () => {
  const emptyManifestBytes = bytes({
    schema: 'gaia-context-capsule-manifest/1', capsuleId: 'capsule-r1',
    selectionPolicy: 'exact-pinned-revision/1', facts: [],
  });
  const latestPin = {
    artifactId: 'capsule-manifest', revision: 'latest', algorithm: 'sha256', digest: digest(emptyManifestBytes),
  };
  const latestAdapter = memoryAdapter(new Map([['capsule-manifest@latest', emptyManifestBytes]]));

  await assert.rejects(
    openContextCapsule(latestPin, latestAdapter),
    (error) => error.code === 'CAPSULE_INVALID_INPUT' && error.failClosed === true,
  );
  assert.deepEqual(latestAdapter.calls, [], 'a mutable manifest alias is refused before Adapter access');

  const factBytes = bytes({
    schema: 'gaia-context-fact/1', factId: 'fact-00', value: 'answer',
    exposure: 'model-context', trust: 'untrusted-data', authorityEffect: 'none',
  });
  const branchSource = { artifactId: 'artifact-00', revision: 'main', algorithm: 'sha256', digest: digest(factBytes) };
  const manifestBytes = bytes({
    schema: 'gaia-context-capsule-manifest/1', capsuleId: 'capsule-r1',
    selectionPolicy: 'exact-pinned-revision/1', facts: [{ factId: 'fact-00', source: branchSource }],
  });
  const manifestPin = revision('capsule-manifest', '1', manifestBytes);
  const branchAdapter = memoryAdapter(new Map([
    ['capsule-manifest@1', manifestBytes], ['artifact-00@main', factBytes],
  ]));

  await assert.rejects(
    openContextCapsule(manifestPin, branchAdapter),
    (error) => error.code === 'CAPSULE_INVALID_MANIFEST' && error.failClosed === true,
  );
  assert.deepEqual(branchAdapter.calls, [manifestPin], 'a mutable source alias never reaches a fact read');
});

test('schema and source failures remain typed across the capsule boundary', async () => {
  const cases = [
    {
      name: 'unsupported fact schema',
      fact: {
        schema: 'gaia-context-fact/999', factId: 'fact-00', value: 'answer',
        exposure: 'model-context', trust: 'untrusted-data', authorityEffect: 'none',
      },
      code: 'CAPSULE_UNSUPPORTED_SCHEMA',
    },
    {
      name: 'fact id disagrees with its manifest source',
      fact: {
        schema: 'gaia-context-fact/1', factId: 'fact-01', value: 'answer',
        exposure: 'model-context', trust: 'untrusted-data', authorityEffect: 'none',
      },
      code: 'CAPSULE_SOURCE_MISMATCH',
    },
  ];

  for (const scenario of cases) {
    const factBytes = bytes(scenario.fact);
    const factRevision = revision('artifact-00', '2', factBytes);
    const manifestBytes = bytes({
      schema: 'gaia-context-capsule-manifest/1', capsuleId: 'capsule-r1',
      selectionPolicy: 'exact-pinned-revision/1', facts: [{ factId: 'fact-00', source: factRevision }],
    });
    const manifestRevision = revision('capsule-manifest', '1', manifestBytes);
    const adapter = memoryAdapter(new Map([
      ['capsule-manifest@1', manifestBytes], ['artifact-00@2', factBytes],
    ]));

    const capsule = await openContextCapsule(manifestRevision, adapter);
    const outcome = await capsule.get('fact-00');

    assert.equal(outcome.ok, false, scenario.name);
    assert.equal(outcome.error.code, scenario.code, scenario.name);
    assert.equal('response' in outcome, false, scenario.name);
  }

  const unsupportedManifestBytes = bytes({
    schema: 'gaia-context-capsule-manifest/999', capsuleId: 'capsule-r1',
    selectionPolicy: 'exact-pinned-revision/1', facts: [],
  });
  const unsupportedManifestRevision = revision('capsule-manifest', '1', unsupportedManifestBytes);
  const unsupportedManifestAdapter = memoryAdapter(new Map([
    ['capsule-manifest@1', unsupportedManifestBytes],
  ]));

  await assert.rejects(
    openContextCapsule(unsupportedManifestRevision, unsupportedManifestAdapter),
    (error) => error.code === 'CAPSULE_UNSUPPORTED_SCHEMA'
      && error.failClosed === true
      && error.authorityEffect === 'none',
  );
});

test('receipt digests match an independent literal canonical-json oracle', async () => {
  const factBytes = bytes({
    schema: 'gaia-context-fact/1', factId: 'fact-oracle', value: 'verified-oracle',
    exposure: 'model-context', trust: 'untrusted-data', authorityEffect: 'none',
  });
  const factRevision = {
    artifactId: 'artifact-oracle', revision: '7', algorithm: 'sha256',
    digest: '8d02f34d873411166f849aa0b1feab2b120fb9f669c7779c4041e97ba3e98951',
  };
  const manifestBytes = bytes({
    schema: 'gaia-context-capsule-manifest/1', capsuleId: 'capsule-oracle',
    selectionPolicy: 'exact-pinned-revision/1', facts: [{ factId: 'fact-oracle', source: factRevision }],
  });
  const manifestRevision = {
    artifactId: 'capsule-manifest-oracle', revision: '3', algorithm: 'sha256',
    digest: 'cec6ec8371f3fc39f3307f89144b781680f01038e4d792c8ff5dba0df2d3f52c',
  };
  const adapter = memoryAdapter(new Map([
    ['capsule-manifest-oracle@3', manifestBytes], ['artifact-oracle@7', factBytes],
  ]));

  const capsule = await openContextCapsule(manifestRevision, adapter);
  const outcome = await capsule.get('fact-oracle');

  assert.equal(outcome.ok, true);
  assert.equal(
    outcome.receipt.requestRevision.digest,
    '57e705443189a8382f313bb703dc23cc13a7195a91d5052b8afb1d23c0e39a85',
  );
  assert.equal(
    outcome.receipt.responseRevision.digest,
    '2a542e9f67d34bdc5d524dba94f799a0962514be284a8ab4f679455eca290c52',
  );
  assert.equal(
    outcome.receipt.receiptRevision.digest,
    '57c22aeba810cf127531ad51a20bf6554430e0601c59185ff3539763f3ca9962',
  );
  assert.equal(
    outcome.receiptCanonicalJson,
    '{"authorityEffect":"none","capsuleRevision":{"algorithm":"sha256","artifactId":"capsule-manifest-oracle","digest":"cec6ec8371f3fc39f3307f89144b781680f01038e4d792c8ff5dba0df2d3f52c","revision":"3"},"operation":"get","readOnly":true,"receiptRevision":{"algorithm":"sha256","digest":"57c22aeba810cf127531ad51a20bf6554430e0601c59185ff3539763f3ca9962"},"requestRevision":{"algorithm":"sha256","digest":"57e705443189a8382f313bb703dc23cc13a7195a91d5052b8afb1d23c0e39a85"},"responseRevision":{"algorithm":"sha256","digest":"2a542e9f67d34bdc5d524dba94f799a0962514be284a8ab4f679455eca290c52"},"schema":"gaia-context-capsule-receipt/1","selectionPolicy":"exact-pinned-revision/1","sourceRevision":{"algorithm":"sha256","artifactId":"artifact-oracle","digest":"8d02f34d873411166f849aa0b1feab2b120fb9f669c7779c4041e97ba3e98951","revision":"7"},"trust":"untrusted-data"}',
  );
});
