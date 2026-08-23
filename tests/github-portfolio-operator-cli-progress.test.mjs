import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runPortfolioOperatorCli } from '../scripts/github-portfolio-operator.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-operator-progress-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function parseProgress(chunks) {
  return chunks.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('operator run keeps its final result on stdout and reports authorized repair progress on stderr', async () => {
  const publicKeyPath = join(scratch, 'operator.pub');
  writeFileSync(publicKeyPath, 'fixture public key', 'utf8');
  const stdout = [];
  const stderr = [];
  let clock = 5_000;
  let authorityExecutions = 0;
  let reviewRound = 0;

  const exitCode = await runPortfolioOperatorCli([
    'run',
    '--portfolio', join(scratch, 'portfolio.json'),
    '--repository', 'GuitarAlchemist/ga',
    '--private-key', join(scratch, 'operator.key'),
    '--public-key', publicKeyPath,
    '--ledger', join(scratch, 'ledger'),
    '--worktree', join(scratch, 'worktree'),
    '--evidence-root', join(scratch, 'evidence'),
    '--out', join(scratch, 'receipt.json'),
    '--timeout-ms', '2000',
  ], {
    isInteractive: () => true,
    nowMs: () => {
      clock += 11;
      return clock;
    },
    writeStdout: (chunk) => stdout.push(chunk),
    writeProgress: (chunk) => stderr.push(chunk),
    createGithubRead: () => ({ read: async () => ({}) }),
    createAuthority: () => ({ consume: async () => ({}) }),
    createExecution: ({ runWorker, runReviewer, runRepair }) => ({
      execute: async () => {
        authorityExecutions += 1;
        await runWorker({});
        const initial = await runReviewer({});
        assert.equal(initial.verdict, 'REQUEST_CHANGES');
        await runRepair({});
        const final = await runReviewer({});
        assert.equal(final.verdict, 'APPROVE');
        return { status: 'completed' };
      },
    }),
    runWorker: async (_context, options) => {
      assert.deepEqual(options, { timeoutMs: 2000 });
      return { provider: 'fixture-worker', output: 'secret worker output' };
    },
    runReviewer: async (_context, options) => {
      assert.deepEqual(options, { timeoutMs: 2000 });
      reviewRound += 1;
      return {
        provider: 'fixture-reviewer',
        verdict: reviewRound === 1 ? 'REQUEST_CHANGES' : 'APPROVE',
        output: 'secret review output',
      };
    },
    runRepair: async (_context, options) => {
      assert.deepEqual(options, { timeoutMs: 2000 });
      return { provider: 'fixture-repair', output: 'secret repair output' };
    },
    runOperator: async ({ execution }) => {
      await execution.execute({});
      return {
        status: 'AUTHORIZED',
        transition: { status: 'CANDIDATE_READY' },
        revision: 'a'.repeat(64),
      };
    },
    summarize: () => ({ text: 'FINAL RESULT\n', exitCode: 0 }),
  });

  assert.equal(exitCode, 0);
  assert.equal(authorityExecutions, 1);
  assert.equal(stdout.join(''), 'FINAL RESULT\n');
  const progress = parseProgress(stderr);
  assert.deepEqual(progress.map(({ stage }) => stage), [
    'validating',
    'authorized_execution',
    'worker_running',
    'worker_completed',
    'initial_review_running',
    'initial_review_verdict',
    'repair_running',
    'repair_completed',
    'final_review_running',
    'final_review_verdict',
    'terminal_outcome',
  ]);
  assert.equal(progress.at(-1).outcome, 'CANDIDATE_READY');
  assert.deepEqual(progress.map(({ remainingProviderTimeUpperBoundMs }) =>
    remainingProviderTimeUpperBoundMs), [8000, 8000, 8000, 6000, 6000, 4000, 4000, 2000, 2000, 0, 0]);
  assert.ok(!stderr.join('').match(/secret|portfolio\.json|operator\.key|worktree/iu));
});

test('operator progress writer failure cannot prevent the authorized result', async () => {
  const publicKeyPath = join(scratch, 'broken-writer.pub');
  writeFileSync(publicKeyPath, 'fixture public key', 'utf8');
  let executed = 0;
  const exitCode = await runPortfolioOperatorCli([
    'run',
    '--portfolio', join(scratch, 'broken-portfolio.json'),
    '--repository', 'GuitarAlchemist/ga',
    '--private-key', join(scratch, 'broken.key'),
    '--public-key', publicKeyPath,
    '--ledger', join(scratch, 'broken-ledger'),
    '--worktree', join(scratch, 'broken-worktree'),
    '--evidence-root', join(scratch, 'broken-evidence'),
    '--out', join(scratch, 'broken-receipt.json'),
  ], {
    isInteractive: () => true,
    writeStdout: () => {},
    writeProgress: async () => { throw new Error('stderr unavailable'); },
    createGithubRead: () => ({}),
    createAuthority: () => ({}),
    createExecution: () => ({ execute: async () => { executed += 1; } }),
    runOperator: async ({ execution }) => {
      await execution.execute({});
      return {
        status: 'AUTHORIZED', transition: { status: 'CANDIDATE_READY' }, revision: 'b'.repeat(64),
      };
    },
    summarize: () => ({ text: 'UNCHANGED\n', exitCode: 0 }),
  });
  assert.equal(exitCode, 0);
  assert.equal(executed, 1);
});
