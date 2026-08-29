import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runFactoryAgentCli } from '../scripts/factory-agent.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'factory-agent.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'gaia-factory-agent-cli-'));

test.after(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('requires the bounded worktree, task, and receipt arguments', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing --worktree/i);
});

test('the public CLI composition wires one bounded repair with the same timeout', async () => {
  const worktree = join(scratch, 'repair-composition-worktree');
  const out = join(scratch, 'repair-composition-receipt.json');
  mkdirSync(worktree);
  const seen = { worker: [], reviewer: [], repair: [] };
  let reviewRound = 0;

  const receipt = await runFactoryAgentCli([
    '--worktree', worktree,
    '--task', 'repair after review',
    '--out', out,
    '--timeout-ms', '4321',
  ], {
    executeFactory: async ({ runWorker, runReviewer, runRepair }) => {
      await runWorker({ role: 'worker' });
      const initial = await runReviewer({ role: 'initial-review' });
      assert.equal(initial.verdict, 'REQUEST_CHANGES');
      await runRepair({ role: 'repair' });
      const final = await runReviewer({ role: 'final-review' });
      assert.equal(final.verdict, 'APPROVE');
      return {
        schema: 'gaia-agent-factory-receipt/1',
        status: 'completed',
        task: 'repair after review',
      };
    },
    runWorker: async (context, options) => {
      seen.worker.push({ context, options });
      return { provider: 'fixture-worker', output: 'worker' };
    },
    runReviewer: async (context, options) => {
      reviewRound += 1;
      seen.reviewer.push({ context, options });
      return {
        provider: `fixture-reviewer-${reviewRound}`,
        verdict: reviewRound === 1 ? 'REQUEST_CHANGES' : 'APPROVE',
        output: `review-${reviewRound}`,
      };
    },
    runRepair: async (context, options) => {
      seen.repair.push({ context, options });
      return { provider: 'fixture-repair', output: 'repair' };
    },
  });

  assert.equal(receipt.status, 'completed');
  assert.equal(seen.worker.length, 1);
  assert.equal(seen.reviewer.length, 2);
  assert.equal(seen.repair.length, 1);
  for (const call of [...seen.worker, ...seen.reviewer, ...seen.repair]) {
    assert.deepEqual(call.options, { timeoutMs: 4321 });
  }
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).status, 'completed');
});

test('the public CLI emits one loopback OTLP trace for the cycle and its provider phases', async () => {
  const worktree = join(scratch, 'otel-composition-worktree');
  const out = join(scratch, 'otel-composition-receipt.json');
  mkdirSync(worktree);
  const endpoints = [];
  const spans = [];

  await runFactoryAgentCli([
    '--worktree', worktree,
    '--task', 'trace the bounded cycle',
    '--out', out,
    '--otel-endpoint', 'http://127.0.0.1:4318/v1/traces',
  ], {
    createTraceSink: ({ endpoint }) => {
      endpoints.push(endpoint);
      return { record: async (span) => { spans.push(structuredClone(span)); } };
    },
    executeFactory: async ({ runWorker, runReviewer }) => {
      await runWorker({ role: 'worker' });
      await runReviewer({ role: 'initial-review' });
      return {
        schema: 'gaia-agent-factory-receipt/1',
        status: 'completed',
        task: 'trace the bounded cycle',
      };
    },
    runWorker: async () => ({ provider: 'fixture-worker', output: 'worker' }),
    runReviewer: async () => ({
      provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'approve',
    }),
  });

  assert.deepEqual(endpoints, ['http://127.0.0.1:4318/v1/traces']);
  assert.deepEqual(spans.map(({ name }) => name).sort(), [
    'gaia.factory.cycle',
    'gaia.factory.initial_review',
    'gaia.factory.worker',
  ]);
  assert.equal(new Set(spans.map(({ traceId }) => traceId)).size, 1);
  const cycle = spans.find(({ name }) => name === 'gaia.factory.cycle');
  for (const phase of spans.filter(({ name }) => name !== 'gaia.factory.cycle')) {
    assert.equal(phase.parentSpanId, cycle.spanId);
  }
  assert.equal(cycle.attributes['gaia.cost_policy'], 'ZERO_ADDITIONAL_DOLLARS');
  assert.equal(cycle.attributes['gaia.authority_effect'], 'NONE');
  assert.equal(cycle.status, 'OK');
});

test('the public CLI selects the Pi OAuth reviewer without changing the worker profile', async () => {
  const worktree = join(scratch, 'pi-reviewer-worktree');
  const out = join(scratch, 'pi-reviewer-receipt.json');
  mkdirSync(worktree);
  let piCalls = 0;

  await runFactoryAgentCli([
    '--worktree', worktree,
    '--task', 'review through Pi',
    '--out', out,
    '--reviewer', 'pi',
  ], {
    executeFactory: async ({ runWorker, runReviewer }) => {
      await runWorker({ role: 'worker' });
      const review = await runReviewer({ role: 'initial-review' });
      assert.equal(review.provider, 'pi-openai-codex-subscription');
      return {
        schema: 'gaia-agent-factory-receipt/1',
        status: 'completed',
        task: 'review through Pi',
      };
    },
    runWorker: async () => ({ provider: 'fixture-worker', output: 'worker' }),
    runReviewer: async () => { throw new Error('Codex reviewer must not run'); },
    runPiReview: async () => {
      piCalls += 1;
      return {
        provider: 'pi-openai-codex-subscription', verdict: 'APPROVE', output: 'approve',
      };
    },
  });

  assert.equal(piCalls, 1);
  const envelope = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(envelope.workerProfile, 'claude-subscription');
  assert.equal(envelope.reviewerProfile, 'pi-openai-codex-subscription-read-only');
});

test('the public CLI selects the Pi writer with repeated exact allowed paths', async () => {
  const worktree = join(scratch, 'pi-writer-worktree');
  const out = join(scratch, 'pi-writer-receipt.json');
  mkdirSync(worktree);
  let seen;

  await runFactoryAgentCli([
    '--worktree', worktree,
    '--task', 'write only the bounded files',
    '--out', out,
    '--worker', 'pi',
    '--allow-write', 'src/allowed.mjs',
    '--allow-write', 'tests/allowed.test.mjs',
  ], {
    executeFactory: async ({ runWorker, runRepair }) => {
      assert.equal(runRepair, undefined, 'Pi writer v0 must not inherit the Claude repair lane');
      const worker = await runWorker({
        cwd: worktree, task: 'write only the bounded files', baseHead: 'a'.repeat(40),
      });
      assert.equal(worker.provider, 'pi-openai-codex-subscription');
      return {
        schema: 'gaia-agent-factory-receipt/1',
        status: 'completed',
        task: 'write only the bounded files',
      };
    },
    runWorker: async () => { throw new Error('Claude worker must not run'); },
    runPiWrite: async (context) => {
      seen = structuredClone(context);
      return { provider: 'pi-openai-codex-subscription', output: 'WORKER: COMPLETE\n' };
    },
    runReviewer: async () => ({
      provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'approve',
    }),
  });

  assert.deepEqual(seen.allowedPaths, ['src/allowed.mjs', 'tests/allowed.test.mjs']);
  assert.deepEqual(seen.baseline, { head: 'a'.repeat(40) });
  const envelope = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(envelope.workerProfile, 'pi-openai-codex-subscription-bounded-writer');
  assert.equal(envelope.repairProfile, 'disabled-for-pi-writer-v0');
  assert.deepEqual(envelope.allowedWritePaths, [
    'src/allowed.mjs', 'tests/allowed.test.mjs',
  ]);
  assert.equal(envelope.reviewerProfile, 'codex-subscription-read-only');
});

test('refuses a receipt path inside the candidate before launching an agent', () => {
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--worktree', ROOT,
    '--task', 'must not run',
    '--out', join(ROOT, 'forbidden-agent-receipt.json'),
  ], { cwd: scratch, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the candidate worktree/i);
});

test('refuses a receipt path physically inside the candidate through a junction', () => {
  const repo = join(scratch, 'junction-repo');
  const worktree = join(scratch, 'junction-worktree');
  const alias = join(scratch, 'junction-alias');
  git(scratch, 'init', repo);
  git(repo, 'config', 'user.name', 'Gaia Test');
  git(repo, 'config', 'user.email', 'gaia@example.invalid');
  writeFileSync(join(repo, 'candidate.txt'), 'before\n', 'utf8');
  git(repo, 'add', 'candidate.txt');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', 'gaia-junction', worktree, 'HEAD');
  symlinkSync(worktree, alias, 'junction');

  const physicalReceipt = join(worktree, 'receipt.json');
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--worktree', worktree,
    '--task', 'must not run',
    '--out', join(alias, 'receipt.json'),
  ], { cwd: scratch, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /physically outside the candidate worktree/i);
  assert.equal(existsSync(physicalReceipt), false);
});
