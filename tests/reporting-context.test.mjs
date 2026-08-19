import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  finalizeInventoryRoutedReport,
  ReportingContextError,
} from '../src/reporting-context.mjs';
import { inventoryRows } from '../src/inventory.mjs';
import { buildLineageReceipt, LineageReceiptError } from '../src/lineage-receipt.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const digest = (value) => createHash('sha256').update(value).digest('hex');
const canonicalValue = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
};
const canonicalJson = (value) => JSON.stringify(canonicalValue(value));

function tree(files, name) {
  const root = mkdtempSync(join(tmpdir(), `gaia-report-${name}-`));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function policy(overrides = {}) {
  return Object.freeze({
    schema: 'gaia-inventory-routing-policy/1',
    activationReceiptDigest: SHA_B,
    digest: SHA_A,
    mode: 'sealed',
    artifactClasses: Object.freeze([
      'handoff', 'standards-review', 'spec-review',
      'reconciliation', 'preflight', 'readiness',
    ]),
    ...overrides,
  });
}

function request(overrides = {}) {
  const predecessorRoot = tree({
    'src/stable.mjs': 'stable\n',
    'src/changed-secret.mjs': 'before\n',
  }, 'predecessor');
  const successorRoot = tree({
    'src/stable.mjs': 'stable\n',
    'src/changed-secret.mjs': 'after\n',
  }, 'successor');
  return Object.freeze({
    schema: 'gaia-inventory-routed-report-request/1',
    policy: policy(),
    artifactClass: 'standards-review',
    producer: Object.freeze({ ref: 'reviewer-standards', role: 'standards-reviewer' }),
    peerRoles: Object.freeze({
      curatorRef: 'curator-1',
      standardsReviewerRef: 'reviewer-standards',
      specReviewerRef: 'reviewer-spec',
    }),
    lineageDeclaration: Object.freeze({
      cleanliness: Object.freeze({ alternateStreams: 0, porcelainLines: 0, readOnlyAll: true, reparsePoints: 0 }),
      evidence: Object.freeze([
        { digest: SHA_A, label: 'reporting-policy' },
        { digest: SHA_B, label: 'reporting-policy-activation' },
      ]),
      lineageId: 'lineage-alpha',
      notesDigest: SHA_B,
      predecessorRoot,
      sealed: true,
      successorRoot,
      tests: Object.freeze({ deterministicRepeats: 2, failed: 0, mutationsDiscriminating: 1, mutationsTotal: 1, passed: 3 }),
      tSeal: 'routing policy was declared before this seal',
      verdict: 'APPROVE',
    }),
    privateEvidence: Object.freeze({
      schema: 'gaia-inventory-routed-private-evidence/1',
      artifactClass: 'standards-review',
      lineageId: 'lineage-alpha',
      producerRef: 'reviewer-standards',
      content: Object.freeze({
        observations: Object.freeze(['src/changed-secret.mjs changed from 7 to 6 bytes']),
      }),
    }),
    inputReceiptDigests: Object.freeze([]),
    result: 'APPROVE',
    ...overrides,
  });
}

function requestForClass(artifactClass) {
  const resultByClass = {
    handoff: 'COMPLETE',
    'standards-review': 'APPROVE',
    'spec-review': 'APPROVE',
    reconciliation: 'RECONCILED',
    preflight: 'READY',
    readiness: 'READY',
  };
  const producerByClass = {
    handoff: { ref: 'writer-1', role: 'writer' },
    'standards-review': { ref: 'reviewer-standards', role: 'standards-reviewer' },
    'spec-review': { ref: 'reviewer-spec', role: 'spec-reviewer' },
    reconciliation: { ref: 'reconciler-1', role: 'reconciler' },
    preflight: { ref: 'preflight-1', role: 'preflight-reviewer' },
    readiness: { ref: 'readiness-1', role: 'readiness-reviewer' },
  };
  const producer = Object.freeze(producerByClass[artifactClass]);
  return request({
    artifactClass,
    producer,
    result: resultByClass[artifactClass],
    lineageDeclaration: Object.freeze({
      ...request().lineageDeclaration,
      verdict: artifactClass === 'standards-review' || artifactClass === 'spec-review'
        ? 'APPROVE'
        : null,
    }),
    privateEvidence: Object.freeze({
      schema: 'gaia-inventory-routed-private-evidence/1',
      artifactClass,
      lineageId: 'lineage-alpha',
      producerRef: producer.ref,
      content: Object.freeze({ observations: Object.freeze([`${artifactClass} private observation`]) }),
    }),
  });
}

function memorySink() {
  const writes = [];
  const adapter = {
    async writeSealed(document) {
      writes.push(structuredClone(document));
      return { digest: digest(Buffer.from(canonicalJson(document), 'utf8')) };
    },
    async readSealed() {
      return writes;
    },
  };
  return {
    writes,
    sink: adapter.writeSealed.bind(adapter),
  };
}

test('a sealed Standards review writes private evidence before lineage evidence and returns canonical successor-safe JSON', async () => {
  const routedRequest = request();
  const { sink, writes } = memorySink();
  const outcome = await finalizeInventoryRoutedReport(routedRequest, sink);

  assert.equal(writes.length, 2, 'private evidence is durable before the lineage manifest');
  assert.equal(writes[0].schema, 'gaia-inventory-routed-private-evidence/1');
  assert.equal(writes[1].schema, 'gaia-lineage-sealed-manifest/1');
  assert.equal(outcome.report.schema, 'gaia-inventory-routed-report/1');
  assert.equal(outcome.report.artifact_class, 'standards-review');
  assert.equal(outcome.report.authority_effect, 'none');
  assert.equal(outcome.report.policy_activation_receipt_digest, SHA_B);
  assert.equal(outcome.report.lineage_receipt.sealed, true);
  assert.equal(outcome.report.lineage_receipt.verdict, 'APPROVE');
  assert.equal(outcome.canonicalJson, canonicalJson(outcome.report));
  assert.ok(Object.isFrozen(outcome));
  assert.ok(Object.isFrozen(outcome.report));
  assert.deepEqual(Object.keys(outcome.report).sort(), [
    'artifact_class',
    'authority_effect',
    'input_receipt_digests',
    'lineage_id',
    'lineage_receipt',
    'policy_activation_receipt_digest',
    'policy_digest',
    'producer',
    'result',
    'schema',
  ]);

  for (const secret of ['src/changed-secret.mjs', 'before', 'after', 'predecessor']) {
    assert.ok(!outcome.canonicalJson.includes(secret), `public JSON excludes ${secret}`);
  }
  for (const root of [
    routedRequest.lineageDeclaration.predecessorRoot,
    routedRequest.lineageDeclaration.successorRoot,
  ]) {
    for (const row of inventoryRows(root)) {
      assert.ok(!outcome.canonicalJson.includes(row.path), `public JSON excludes ${row.path}`);
      assert.ok(!outcome.canonicalJson.includes(row.sha256), `public JSON excludes ${row.sha256}`);
    }
  }
});

test('the sealed policy routes every required artifact class through the same successor-safe seam', async () => {
  for (const artifactClass of policy().artifactClasses) {
    const { sink, writes } = memorySink();
    const outcome = await finalizeInventoryRoutedReport(requestForClass(artifactClass), sink);

    assert.equal(outcome.report.artifact_class, artifactClass);
    assert.equal(outcome.report.result, requestForClass(artifactClass).result);
    assert.equal(writes.length, 2, `${artifactClass} uses the same two-channel write order`);
    assert.ok(!outcome.canonicalJson.includes('private observation'));
  }
});

test('an unsealed report keeps ordinary open evidence and the existing lineage receipt unchanged', async () => {
  const sealedRequest = requestForClass('standards-review');
  const openEvidence = '# Scope\n\n| Path | Before | After |\n|---|---:|---:|\n| src/example.mjs | 1 | 2 |\n';
  const lineageDeclaration = Object.freeze({
    cleanliness: sealedRequest.lineageDeclaration.cleanliness,
    evidence: Object.freeze([]),
    lineageId: sealedRequest.lineageDeclaration.lineageId,
    notesDigest: sealedRequest.lineageDeclaration.notesDigest,
    predecessorRoot: sealedRequest.lineageDeclaration.predecessorRoot,
    sealed: false,
    successorRoot: sealedRequest.lineageDeclaration.successorRoot,
    tests: sealedRequest.lineageDeclaration.tests,
    verdict: 'APPROVE',
  });
  const { privateEvidence: _privateEvidence, ...sharedRequest } = sealedRequest;
  const openRequest = Object.freeze({
    ...sharedRequest,
    policy: policy({ mode: 'unsealed' }),
    lineageDeclaration,
    openEvidence,
  });

  const expectedReceipt = await buildLineageReceipt(lineageDeclaration, undefined);
  const outcome = await finalizeInventoryRoutedReport(openRequest, undefined);

  assert.equal(outcome.report.open_evidence, openEvidence);
  assert.deepEqual(outcome.report.lineage_receipt, expectedReceipt);
  assert.equal(outcome.report.lineage_receipt.sealed, false);
  assert.equal(outcome.report.lineage_receipt.predecessor.digest, expectedReceipt.predecessor.digest);
});

test('each artifact class requires its declared producer role and keeps the curator separate', async () => {
  for (const artifactClass of policy().artifactClasses) {
    const valid = requestForClass(artifactClass);
    const wrongRole = Object.freeze({
      ...valid,
      producer: Object.freeze({ ...valid.producer, role: 'writer' }),
      privateEvidence: Object.freeze({
        ...valid.privateEvidence,
        producerRef: valid.producer.ref,
      }),
    });
    if (artifactClass === 'handoff') continue;
    await assert.rejects(
      () => finalizeInventoryRoutedReport(wrongRole, memorySink().sink),
      (error) => error.code === 'RoleSeparationViolation' && error.message === error.code,
      `${artifactClass} refuses a generic writer role`,
    );
  }

  const valid = requestForClass('handoff');
  const curatorProduced = Object.freeze({
    ...valid,
    producer: Object.freeze({ ref: 'curator-1', role: 'writer' }),
    privateEvidence: Object.freeze({ ...valid.privateEvidence, producerRef: 'curator-1' }),
  });
  await assert.rejects(
    () => finalizeInventoryRoutedReport(curatorProduced, memorySink().sink),
    (error) => error.code === 'RoleSeparationViolation' && error.message === error.code,
  );
});

test('input receipt order cannot change the canonical public report', async () => {
  const forward = request({ inputReceiptDigests: Object.freeze([SHA_A, SHA_B]) });
  const reverse = request({ inputReceiptDigests: Object.freeze([SHA_B, SHA_A]) });

  const first = await finalizeInventoryRoutedReport(forward, memorySink().sink);
  const second = await finalizeInventoryRoutedReport(reverse, memorySink().sink);

  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.deepEqual(first.report.input_receipt_digests, [SHA_A, SHA_B]);
});

test('sealed routing misuse refuses before either channel is written', async () => {
  const cases = [
    ['unknown class', (value) => {
      value.artifactClass = 'future-report';
    }, 'ArtifactClassNotRouted'],
    ['arbitrary open prose', (value) => {
      value.openEvidence = 'src/changed-secret.mjs';
    }, 'ReportFieldSetViolation'],
    ['activation receipt absent', (value) => {
      value.lineageDeclaration.evidence = value.lineageDeclaration.evidence
        .filter((item) => item.label !== 'reporting-policy-activation');
    }, 'RoutingPolicyOrderUnverifiable'],
    ['policy digest mismatch', (value) => {
      value.lineageDeclaration.evidence[0].digest = 'c'.repeat(64);
    }, 'RoutingPolicyDigestMismatch'],
    ['curator is reviewer', (value) => {
      value.peerRoles.curatorRef = value.peerRoles.standardsReviewerRef;
    }, 'RoleSeparationViolation'],
  ];

  for (const [label, mutate, code] of cases) {
    const value = structuredClone(request());
    mutate(value);
    const { sink, writes } = memorySink();
    await assert.rejects(
      () => finalizeInventoryRoutedReport(value, sink),
      (error) => error instanceof ReportingContextError
        && error.code === code
        && error.message === code
        && error.failClosed === true
        && error.authorityEffect === 'none',
      label,
    );
    assert.equal(writes.length, 0, `${label} writes neither channel`);
  }

  const writes = [];
  const nonWriteOnlySink = {
    async writeSealed(document) {
      writes.push(document);
      return { digest: SHA_A };
    },
    async readSealed() {
      return null;
    },
  };
  await assert.rejects(
    () => finalizeInventoryRoutedReport(request(), nonWriteOnlySink),
    (error) => error.code === 'SealedSinkRequired' && error.message === error.code,
  );
  assert.equal(writes.length, 0, 'a readable Adapter is rejected before use');
});

test('sink failures become bare typed refusals with no private diagnostic', async () => {
  const privateSecret = 'src/changed-secret.mjs changed from 7 to 6 bytes';
  const throwingSink = {
    async writeSealed() {
      throw new Error(`cannot write ${privateSecret}`);
    },
  };
  await assert.rejects(
    () => finalizeInventoryRoutedReport(request(), throwingSink.writeSealed.bind(throwingSink)),
    (error) => error instanceof ReportingContextError
      && error.code === 'ArtifactConflict'
      && error.message === 'ArtifactConflict'
      && !JSON.stringify(error).includes(privateSecret),
  );

  let calls = 0;
  const secondWriteFails = {
    async writeSealed(document) {
      calls += 1;
      if (calls === 2) throw new Error(`manifest path contains ${privateSecret}`);
      return { digest: digest(Buffer.from(canonicalJson(document), 'utf8')) };
    },
  };
  await assert.rejects(
    () => finalizeInventoryRoutedReport(request(), secondWriteFails.writeSealed.bind(secondWriteFails)),
    (error) => error instanceof LineageReceiptError
      && error.code === 'ArtifactConflict'
      && error.message === 'ArtifactConflict'
      && !JSON.stringify(error).includes(privateSecret),
  );
});

test('the finalizer owns the validated request before the first sealed write can mutate its caller', async () => {
  const mutable = structuredClone(request());
  const writes = [];
  const sink = {
    async writeSealed(document) {
      assert.ok(Object.isFrozen(document), 'the exact sealed value is immutable before the write');
      writes.push(structuredClone(document));
      if (writes.length === 1) {
        mutable.artifactClass = 'future-report';
        mutable.result = 'REQUEST_CHANGES';
        mutable.policy.digest = 'c'.repeat(64);
        mutable.lineageDeclaration.lineageId = 'mutated-lineage';
        mutable.lineageDeclaration.verdict = 'REQUEST_CHANGES';
        mutable.privateEvidence.content.observations[0] = 'mutated after validation';
      }
      return { digest: digest(Buffer.from(canonicalJson(document), 'utf8')) };
    },
  };

  const outcome = await finalizeInventoryRoutedReport(mutable, sink.writeSealed.bind(sink));

  assert.equal(writes.length, 2);
  assert.equal(writes[0].artifactClass, 'standards-review');
  assert.deepEqual(writes[0].content.observations, ['src/changed-secret.mjs changed from 7 to 6 bytes']);
  assert.equal(writes[1].lineage_id, 'lineage-alpha');
  assert.equal(outcome.report.artifact_class, 'standards-review');
  assert.equal(outcome.report.result, 'APPROVE');
  assert.equal(outcome.report.policy_digest, SHA_A);
  assert.equal(outcome.report.lineage_id, 'lineage-alpha');
});

test('private evidence rejects symbols, accessors, and non-enumerable properties without evaluating them', async () => {
  const cases = [
    ['symbol', (content) => {
      content[Symbol('secret')] = 'holdout-label-secret';
    }],
    ['non-enumerable', (content) => {
      Object.defineProperty(content, 'secret', { enumerable: false, value: 'holdout-label-secret' });
    }],
    ['accessor', (content, observed) => {
      Object.defineProperty(content, 'secret', {
        enumerable: true,
        get() {
          observed.count += 1;
          return 'holdout-label-secret';
        },
      });
    }],
  ];

  for (const [label, addInvalidProperty] of cases) {
    const value = structuredClone(request());
    const observed = { count: 0 };
    addInvalidProperty(value.privateEvidence.content, observed);
    const { sink, writes } = memorySink();
    await assert.rejects(
      () => finalizeInventoryRoutedReport(value, sink),
      (error) => error instanceof ReportingContextError
        && error.code === 'ReportFieldSetViolation'
        && error.message === error.code,
      label,
    );
    assert.equal(observed.count, 0, `${label} is rejected by descriptor, not evaluated`);
    assert.equal(writes.length, 0, `${label} writes neither channel`);
  }
});

test('only an explicit write capability crosses the finalizer boundary', async () => {
  const prototypeWrites = [];
  class ReadableAdapter {
    async writeSealed(document) {
      prototypeWrites.push(document);
      return { digest: digest(Buffer.from(canonicalJson(document), 'utf8')) };
    }

    async readSealed() {
      return prototypeWrites;
    }
  }
  const readableAdapter = new ReadableAdapter();
  await assert.rejects(
    () => finalizeInventoryRoutedReport(request(), readableAdapter),
    (error) => error instanceof ReportingContextError
      && error.code === 'SealedSinkRequired'
      && error.message === error.code,
  );
  assert.equal(prototypeWrites.length, 0);

  const privatePath = 'C:\\private\\holdout-labels.json';
  let getterCalls = 0;
  const getterAdapter = {};
  Object.defineProperty(getterAdapter, 'writeSealed', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(`cannot open ${privatePath}`);
    },
  });
  await assert.rejects(
    () => finalizeInventoryRoutedReport(request(), getterAdapter),
    (error) => error instanceof ReportingContextError
      && error.code === 'SealedSinkRequired'
      && error.message === error.code
      && !JSON.stringify(error).includes(privatePath),
  );
  assert.equal(getterCalls, 0, 'adapter getters are never evaluated');

  const routedRequest = request();
  const sealedStoreRoot = tree({}, 'sealed-store-outside-measured-roots');
  assert.notEqual(sealedStoreRoot, routedRequest.lineageDeclaration.predecessorRoot);
  assert.notEqual(sealedStoreRoot, routedRequest.lineageDeclaration.successorRoot);
  const writes = [];
  const outsideRootAdapter = {
    async writeSealed(document) {
      writes.push(structuredClone(document));
      writeFileSync(join(sealedStoreRoot, `sealed-${writes.length}.json`), canonicalJson(document));
      return { digest: digest(Buffer.from(canonicalJson(document), 'utf8')) };
    },
    async readSealed() {
      return writes;
    },
  };
  const outcome = await finalizeInventoryRoutedReport(
    routedRequest,
    outsideRootAdapter.writeSealed.bind(outsideRootAdapter),
  );
  assert.equal(writes.length, 2);
  assert.equal(outcome.report.artifact_class, 'standards-review');
});

test('private evidence outside the canonical JSON domain refuses before the sink', async () => {
  for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n]) {
    const value = structuredClone(request());
    value.privateEvidence.content.invalid = invalid;
    const { sink, writes } = memorySink();
    await assert.rejects(
      () => finalizeInventoryRoutedReport(value, sink),
      (error) => error instanceof ReportingContextError
        && error.code === 'ReportFieldSetViolation'
        && error.message === error.code,
    );
    assert.equal(writes.length, 0);
  }
});

test('routing-policy closure and channel presence fail closed before either channel', async () => {
  const invalidPolicies = [
    policy({ artifactClasses: Object.freeze(policy().artifactClasses.slice(1)) }),
    policy({ artifactClasses: Object.freeze([...policy().artifactClasses, 'future-report']) }),
    policy({ artifactClasses: Object.freeze([
      ...policy().artifactClasses.slice(0, -1),
      'handoff',
    ]) }),
  ];
  for (const invalidPolicy of invalidPolicies) {
    const { sink, writes } = memorySink();
    await assert.rejects(
      () => finalizeInventoryRoutedReport(request({ policy: invalidPolicy }), sink),
      (error) => error.code === 'RoutingPolicyRequired' && error.message === error.code,
    );
    assert.equal(writes.length, 0);
  }

  await assert.rejects(
    () => finalizeInventoryRoutedReport(request(), undefined),
    (error) => error.code === 'SealedSinkRequired' && error.message === error.code,
  );

  const sealedRequest = request();
  const { privateEvidence: _privateEvidence, ...openFields } = sealedRequest;
  const openRequest = {
    ...openFields,
    policy: policy({ mode: 'unsealed' }),
    lineageDeclaration: {
      ...sealedRequest.lineageDeclaration,
      evidence: [],
      sealed: false,
    },
    openEvidence: 'ordinary open review evidence',
  };
  await assert.rejects(
    () => finalizeInventoryRoutedReport(openRequest, memorySink().sink),
    (error) => error.code === 'SealedSinkForbidden' && error.message === error.code,
  );

  const openWithPrivateEvidence = { ...openRequest, privateEvidence: sealedRequest.privateEvidence };
  await assert.rejects(
    () => finalizeInventoryRoutedReport(openWithPrivateEvidence, undefined),
    (error) => error.code === 'ReportFieldSetViolation' && error.message === error.code,
  );
});
