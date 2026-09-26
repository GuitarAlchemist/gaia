import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  executeAgentFactory, FactoryAgentError, runNodeTestVerification,
} from '../src/factory-agent.mjs';
import { autonomousJobKey, validateAutonomousReceipt } from '../src/autonomous-factory-contract.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-factory-verification-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const TASK = 'make candidate.test.mjs pass';
const PASSING = "import test from 'node:test';\ntest('candidate', () => {});\n";
const FAILING = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
  + "test('candidate', () => { assert.equal(1, 2); });\n";

function fixture(name) {
  const repo = join(scratch, `${name}-repo`);
  const worktree = join(scratch, `${name}-worktree`);
  git(scratch, 'init', repo);
  git(repo, 'config', 'user.name', 'Gaia Test');
  git(repo, 'config', 'user.email', 'gaia@example.invalid');
  writeFileSync(join(repo, 'README.md'), 'fixture\n', 'utf8');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', `gaia-${name}`, worktree, 'HEAD');
  return { worktree, head: git(worktree, 'rev-parse', 'HEAD'), evidenceDir: join(scratch, `${name}-evidence`) };
}

const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function job(head) {
  const body = {
    action: 'RUN_FACTORY_AGENT', repository: 'GuitarAlchemist/gaia', itemKind: 'ISSUE',
    itemId: 'I_issue163', itemNumber: 163, draft: { number: 164, headRef: 'gaia/issue-163', headRevision: head },
    task: TASK, evidenceState: 'READY', snapshotRevision: 'b'.repeat(64), requiredAuthority: 'FACTORY_RUN',
  };
  const intent = { ...body, intentRevision: digest(body) };
  const jobKey = autonomousJobKey(intent);
  return { jobKey, intent, idempotencyKey: digest({ grantId: jobKey, intentRevision: intent.intentRevision }) };
}
const terminal = (bound, factory, status) => ({ schema: 'gaia-autonomous-factory-receipt/1', status,
  jobKey: bound.jobKey, intentRevision: bound.intent.intentRevision, idempotencyKey: bound.idempotencyKey, factory });
const refused = (fn, code) => assert.throws(fn, error => error.code === code);

test('the host runs node --test itself and records the observed exit code and counts', async () => {
  const dir = mkdtempSync(join(scratch, 'runner-'));
  writeFileSync(join(dir, 'a.test.mjs'), PASSING, 'utf8');
  const passing = await runNodeTestVerification({ cwd: dir });
  assert.equal(passing.termination, 'exit');
  assert.equal(passing.exitCode, 0);
  assert.equal(passing.command, 'node --test --test-reporter=spec');
  assert.deepEqual(passing.runtime, { version: process.version, pinned: null });
  assert.match(passing.output, /^ℹ pass 1\r?$/mu);

  writeFileSync(join(dir, 'a.test.mjs'), FAILING, 'utf8');
  const failing = await runNodeTestVerification({ cwd: dir });
  assert.equal(failing.termination, 'exit');
  assert.notEqual(failing.exitCode, 0);
  assert.match(failing.output, /^ℹ fail 1\r?$/mu);

  writeFileSync(join(dir, '.node-version'), '0.0.1\n', 'utf8');
  await assert.rejects(runNodeTestVerification({ cwd: dir }),
    error => error instanceof FactoryAgentError && error.code === 'VerificationRuntimeMismatch');
});

test('an approved candidate whose own test fails ends rejected, never CANDIDATE_READY', async () => {
  const { worktree, head, evidenceDir } = fixture('approved-failing');
  let seen;
  const factory = await executeAgentFactory({
    worktree, evidenceDir, task: TASK,
    runWorker: async ({ cwd }) => {
      writeFileSync(join(cwd, 'candidate.test.mjs'), FAILING, 'utf8');
      return { provider: 'fixture-worker', output: 'wrote a test' };
    },
    runReviewer: async (context) => {
      seen = context.verification;
      return { provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'looks fine' };
    },
    runVerification: context => runNodeTestVerification(context),
  });

  assert.equal(factory.status, 'rejected');
  assert.equal(factory.verification.passed, false);
  assert.deepEqual(factory.verification.counts, { tests: 1, pass: 0, fail: 1 });
  assert.equal(factory.verification.candidateIdentity, factory.changeSet.identity);
  assert.equal(factory.verification.evidence.role, 'verification');
  assert.equal(seen.passed, false);
  assert.match(seen.outputTail, /candidate/u);
  assert.equal(Object.hasOwn(seen, 'evidence'), false);

  const bound = job(head);
  validateAutonomousReceipt(terminal(bound, factory, 'CANDIDATE_REJECTED'), bound, { requireVerification: true });
  refused(() => validateAutonomousReceipt(
    terminal(bound, { ...factory, status: 'completed' }, 'CANDIDATE_READY'), bound, { requireVerification: true },
  ), 'InvalidReceipt');
});

test('failing output reaches the one repair, and only a passing re-run makes the candidate ready', async () => {
  const { worktree, head, evidenceDir } = fixture('repaired');
  const reviews = [];
  let findings;
  const factory = await executeAgentFactory({
    worktree, evidenceDir, task: TASK,
    runWorker: async ({ cwd }) => {
      writeFileSync(join(cwd, 'candidate.test.mjs'), FAILING, 'utf8');
      return { provider: 'fixture-worker', output: 'wrote a test' };
    },
    runReviewer: async ({ verification }) => {
      reviews.push(verification);
      return verification.passed
        ? { provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'tests pass' }
        : { provider: 'fixture-reviewer', verdict: 'REQUEST_CHANGES', output: 'fix the failing test' };
    },
    runRepair: async (context) => {
      findings = context.findings;
      writeFileSync(join(context.cwd, 'candidate.test.mjs'), PASSING, 'utf8');
      return { provider: 'fixture-repair', output: 'fixed' };
    },
    runVerification: context => runNodeTestVerification(context),
  });

  assert.match(findings, /^fix the failing test\n\nHost verification \(node --test --test-reporter=spec\) did not pass:/u);
  assert.match(findings, /ℹ fail 1/u);
  assert.deepEqual(reviews.map(item => item.passed), [false, true]);
  assert.equal(factory.status, 'completed');
  assert.equal(factory.verifications.initial.passed, false);
  assert.equal(factory.verifications.initial.candidateIdentity, factory.repair.initialCandidateIdentity);
  assert.deepEqual(factory.verification, factory.verifications.final);
  assert.equal(factory.verification.evidence.role, 'verification-final');
  assert.equal(factory.reviews.initial.evidence.role, 'reviewer-initial');

  const bound = job(head);
  const ready = terminal(bound, factory, 'CANDIDATE_READY');
  validateAutonomousReceipt(ready, bound, { requireVerification: true });
  for (const mutation of [
    value => { value.factory.verification.passed = false; },
    value => { value.factory.verification.counts.fail = 1; },
    value => { value.factory.verifications.final = value.factory.verifications.initial; },
    value => { value.factory.verifications.initial.candidateIdentity = value.factory.changeSet.identity; },
    value => { delete value.factory.verifications; },
  ]) {
    const bad = structuredClone(ready); mutation(bad);
    refused(() => validateAutonomousReceipt(bad, bound), 'InvalidReceipt');
  }
});

test('a verification run that changes the candidate fails closed', async () => {
  const { worktree, evidenceDir } = fixture('mutating');
  await assert.rejects(executeAgentFactory({
    worktree, evidenceDir, task: TASK,
    runWorker: async ({ cwd }) => {
      writeFileSync(join(cwd, 'candidate.test.mjs'), PASSING, 'utf8');
      return { provider: 'fixture-worker', output: 'wrote a test' };
    },
    runReviewer: async () => assert.fail('the reviewer must not see a mutated candidate'),
    runVerification: async ({ cwd }) => {
      writeFileSync(join(cwd, 'stray.txt'), 'written by a test\n', 'utf8');
      return { runtime: { version: process.version, pinned: null }, command: 'node --test',
        termination: 'exit', exitCode: 0, output: 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n' };
    },
  }), error => error instanceof FactoryAgentError && error.code === 'VerificationMutation');
});

test('a new terminal receipt needs a verification record, while a stored legacy one stays readable', async () => {
  const { worktree, head, evidenceDir } = fixture('legacy');
  const factory = await executeAgentFactory({
    worktree, evidenceDir, task: TASK,
    runWorker: async ({ cwd }) => {
      writeFileSync(join(cwd, 'candidate.test.mjs'), PASSING, 'utf8');
      return { provider: 'fixture-worker', output: 'wrote a test' };
    },
    runReviewer: async () => ({ provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'ok' }),
  });
  assert.equal(Object.hasOwn(factory, 'verification'), false);
  const bound = job(head);
  const legacy = terminal(bound, factory, 'CANDIDATE_READY');
  validateAutonomousReceipt(legacy, bound);
  refused(() => validateAutonomousReceipt(legacy, bound, { requireVerification: true }), 'VerificationRequired');
});
