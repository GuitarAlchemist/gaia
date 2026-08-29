import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ADVISORY_AUTHORITY } from '../src/advisory-policy.mjs';
import { canonicalJson } from '../src/epistemic-research.mjs';
import {
  encodeExecutionContract,
  ExecutionFramingError,
  frameExecutionRequest,
  verifyExecutionContract,
} from '../src/framing-execution-contract.mjs';

const SHA_A = 'a'.repeat(64);

const boundedRequest = () => ({
  request: {
    id: 'frame-gaia-001',
    revision: { algorithm: 'sha256', digest: SHA_A },
    requester: 'operator',
    observedAt: '2026-08-29T18:00:00.000Z',
    expiresAt: '2026-08-30T18:00:00.000Z',
  },
  outcome: {
    consumer: 'gaia-coordinator',
    observable: 'A verified advisory contradiction report is emitted.',
  },
  scope: {
    inScope: ['Read immutable plan observations.', 'Emit one advisory report.'],
    outOfScope: ['Mutate source files.', 'Execute a repair.'],
  },
  assumptions: [
    'The caller-supplied revision identifies the intended immutable observation set.',
  ],
  evidenceGates: [
    'Recompute the input revision before accepting the report.',
    'Run one positive and one negative control.',
  ],
  evaluation: {
    success: ['The same input produces byte-identical output.'],
    antiMetrics: ['Number of source files changed.'],
    falsifiers: ['A repeated run changes the encoded contract.'],
    rejectionCriteria: ['Any requested execution or source mutation authority.'],
  },
  ceilings: {
    wallTimeMs: 60_000,
    tokens: 20_000,
    humanAttentionMinutes: 10,
  },
  stopConditions: ['Any immutable input fails digest verification.'],
});

test('frames one bounded request as a deterministic zero-authority contract', () => {
  const first = frameExecutionRequest(boundedRequest());
  const second = frameExecutionRequest(structuredClone(boundedRequest()));

  assert.equal(first.status, 'FRAMED');
  assert.equal(first.authority.mode, 'advisory');
  assert.equal(first.authority.effect, 'NONE');
  assert.equal(first.authority.sourceMutationAuthorized, false);
  assert.equal(first.authority.executionAuthorized, false);
  assert.deepEqual(first.authority.requestedAuthority, []);
  assert.strictEqual(first.authority, ADVISORY_AUTHORITY);
  assert.equal(first.workShape.maxConcurrency, 1);
  assert.equal(first.workShape.fanoutAuthorized, false);
  assert.equal(first.reversibility, 'NO_EFFECT');
  assert.equal(first.contractId, second.contractId);
  assert.equal(encodeExecutionContract(first), encodeExecutionContract(second));
  assert.equal(verifyExecutionContract(first), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.authority), true);
});

test('returns one deterministic clarification result instead of a partial contract', () => {
  const input = boundedRequest();
  input.outcome.observable = '';
  input.evaluation.falsifiers = [];

  const first = frameExecutionRequest(input);
  const second = frameExecutionRequest(structuredClone(input));

  assert.equal(first.status, 'NEEDS_CLARIFICATION');
  assert.deepEqual(
    first.issues.map((issue) => issue.code),
    ['MISSING_OUTCOME_OBSERVABLE', 'MISSING_EVALUATION_FALSIFIER'],
  );
  assert.equal(first.authority.effect, 'NONE');
  assert.equal(Object.hasOwn(first, 'contractId'), false);
  assert.equal(Object.hasOwn(first, 'workShape'), false);
  assert.equal(first.clarificationId, second.clarificationId);
  assert.equal(Object.isFrozen(first.issues), true);
});

test('rejects malformed, mutable, authority-widening, and open-ended inputs', () => {
  for (const [mutate, expectedCode] of [
    [(input) => { input.unrecognized = true; }, 'UNSUPPORTED_FIELD'],
    [(input) => { input.outcome.unrecognized = true; }, 'UNSUPPORTED_FIELD'],
    [(input) => { input.authority = { executionAuthorized: true }; }, 'AUTHORITY_WIDENING'],
    [(input) => { input.request.revision.digest = 'latest'; }, 'INVALID_DIGEST'],
    [(input) => { input.ceilings.wallTimeMs = 86_400_001; }, 'UNBOUNDED_CEILING'],
    [(input) => { input.ceilings.tokens = 1_000_001; }, 'UNBOUNDED_CEILING'],
    [(input) => { input.ceilings.humanAttentionMinutes = 241; }, 'UNBOUNDED_CEILING'],
    [(input) => { input.request.expiresAt = '2026-09-06T18:00:00.001Z'; }, 'INVALID_TIME'],
  ]) {
    const input = boundedRequest();
    mutate(input);
    assert.throws(
      () => frameExecutionRequest(input),
      (error) => error instanceof ExecutionFramingError && error.code === expectedCode,
    );
  }
});

test('asks for clarification when declared scope overlaps', () => {
  const input = boundedRequest();
  input.scope.outOfScope.push(' Read immutable plan observations. ');

  const result = frameExecutionRequest(input);

  assert.equal(result.status, 'NEEDS_CLARIFICATION');
  assert.deepEqual(result.issues.map((issue) => issue.code), ['SCOPE_OVERLAP']);
  assert.equal(result.issues[0].path, 'scope');
  assert.equal(Object.hasOwn(result, 'scope'), false);
});

test('verification rejects a rehashed contract that widens the derived work shape', () => {
  const contract = structuredClone(frameExecutionRequest(boundedRequest()));
  contract.workShape.maxConcurrency = 2;
  const { contractId: _contractId, revision: _revision, ...body } = contract;
  const digest = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
  contract.contractId = `bec-${digest}`;
  contract.revision = { algorithm: 'sha256', digest };

  assert.throws(
    () => verifyExecutionContract(contract),
    (error) => error instanceof ExecutionFramingError
      && error.code === 'INVALID_MATERIALIZATION',
  );
});

test('read-only CLI emits the canonical contract and leaves its input unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-framing-contract-'));
  const inputPath = join(root, 'request.json');
  writeFileSync(inputPath, JSON.stringify(boundedRequest()), 'utf8');
  const before = readFileSync(inputPath);

  const stdout = execFileSync(
    process.execPath,
    ['scripts/framing-execution-contract.mjs', '--input', inputPath],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );

  assert.equal(stdout, `${encodeExecutionContract(frameExecutionRequest(boundedRequest()))}\n`);
  assert.deepEqual(readFileSync(inputPath), before);
});
