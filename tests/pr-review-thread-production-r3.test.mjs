/** R3 race-closure gates for production review-thread orchestration. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGitGhPrReviewThreadEffects } from '../src/git-gh-pr-review-thread-effects.mjs';
import {
  PortfolioExecutionError,
  createAgentFactoryExecutionAdapter,
} from '../src/github-portfolio-execution.mjs';
import { runPrReviewThreadSupervisorCli } from '../scripts/pr-review-thread-supervisor.mjs';

const REVIEWED = 'a'.repeat(40);
const OBSERVED = '2026-08-31T20:00:00.000Z';

function reviewGraph({ head = REVIEWED, threads = 1 } = {}) {
  return {
    data: { repository: { pullRequest: {
      number: 44, baseRefName: 'main', headRefOid: head,
      reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: Array.from({ length: threads }, (_, index) => ({
          id: `PRRT_r3_${index}`, path: `src/pump-${index}.mjs`, line: 9,
          isResolved: false, isOutdated: false,
          comments: {
            totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              id: `PRRC_r3_${index}`, body: 'P1: exact production blocker.',
              review: {
                id: `PRR_r3_${index}`, state: 'COMMENTED', submittedAt: OBSERVED,
                commit: { oid: REVIEWED },
              },
            }],
          },
        })),
      },
    } } },
  };
}

function disputeGraph({ comments = [] } = {}) {
  return {
    data: { repository: { pullRequest: { comments: {
      totalCount: comments.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: comments,
    } } } },
  };
}

test('R3 a complete provider dispute window derives NONE per thread and supports many threads', async () => {
  const adapter = createGitGhPrReviewThreadEffects({
    run: async (args) => String(args.find((entry) => entry.startsWith('query=')))
      .includes('GaiaReviewThreadDisputes') ? disputeGraph() : reviewGraph({ threads: 3 }),
  });
  const collection = await adapter.collectReviewThreads({
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: OBSERVED,
    run: { runId: 'review-r3', laneGeneration: 1 },
  });
  assert.equal(collection.complete, true);
  assert.deepEqual(collection.observations.map(({ reviewThread }) => reviewThread.disputed),
    [false, false, false]);
});

test('R3 repair evidence re-reads the current head and blocks a missing required check', async () => {
  const freshHead = 'b'.repeat(40);
  const calls = [];
  const adapter = createGitGhPrReviewThreadEffects({
    run: async (args) => {
      calls.push(args.join(' '));
      const endpoint = args[1] ?? '';
      if (endpoint === 'repos/GuitarAlchemist/gaia/pulls/44') {
        return { head: { sha: freshHead }, base: { ref: 'main' } };
      }
      if (endpoint.includes('/compare/')) {
        return { status: 'ahead', ahead_by: 1, files: [{ filename: 'src/pump-0.mjs' }] };
      }
      if (endpoint.includes('/contents/')) return { encoding: 'base64', content: 'eA==' };
      if (endpoint.includes('/check-runs')) return { check_runs: [] };
      if (endpoint.endsWith('/branches/main/protection')) {
        return { required_status_checks: { contexts: ['required-ci'] } };
      }
      if (endpoint.endsWith('/rulesets')) return [];
      throw new Error(`unexpected ${endpoint}`);
    },
  });
  const observation = (await createGitGhPrReviewThreadEffects({
    readDisputeEvidence: async () => false,
    run: async () => reviewGraph({ head: REVIEWED }),
  }).collectReviewThreads({
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: OBSERVED,
    run: { runId: 'review-r3', laneGeneration: 1 },
  })).observations[0];

  const measured = await adapter.readRepairEvidence({
    observation,
    laneReceipt: { status: 'completed', addressedCommentIds: ['PRRC_r3_0'] },
  });
  assert.equal(measured.repair.headOid, freshHead);
  assert.equal(measured.checks.headOid, freshHead);
  assert.deepEqual(measured.checks.requiredContexts, ['required-ci']);
  assert.equal(measured.checks.conclusions[0].conclusion, 'UNKNOWN');
  assert.ok(calls.some((call) => call.includes(`compare/${REVIEWED}...${freshHead}`)));
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function executionFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gaia-r3-execution-'));
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktree');
  const evidenceRoot = join(root, 'evidence');
  mkdirSync(repo); mkdirSync(evidenceRoot);
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Gaia Test');
  git(repo, 'config', 'user.email', 'gaia@example.invalid');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/GuitarAlchemist/gaia.git');
  writeFileSync(join(repo, 'fixture.txt'), 'fixture\n');
  git(repo, 'add', 'fixture.txt'); git(repo, 'commit', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', 'r3-fixture', worktree, 'HEAD');
  return { root, worktree, evidenceRoot };
}

test('R3 a durable execution receipt cannot broaden addressed ids beyond measured changed paths', async () => {
  const { worktree, evidenceRoot } = executionFixture();
  const key = 'c'.repeat(64);
  const adapter = createAgentFactoryExecutionAdapter({
    expectedRepository: 'GuitarAlchemist/gaia', worktree, evidenceRoot,
    executeFactory: async ({ task }) => ({
      schema: 'gaia-agent-factory-receipt/1', status: 'completed', task,
      changeSet: { identity: 'd'.repeat(64), files: [{ path: 'src/other.mjs' }] },
    }),
    runWorker: async () => {}, runReviewer: async () => {}, runRepair: async () => {},
  });
  await adapter.execute({
    idempotencyKey: key,
    intent: {
      action: 'RUN_FACTORY_AGENT', repository: 'GuitarAlchemist/gaia', task: 'Repair exact thread.',
      reviewThreadEvidence: {
        threadIdentity: 'e'.repeat(64), reviewThreadId: 'PRRT_r3_0',
        anchorPath: 'src/pump-0.mjs', addressedCommentIds: ['PRRC_r3_0'],
        sourceRevision: 'f'.repeat(64), observedAt: OBSERVED,
      },
    },
  });
  const restarted = createAgentFactoryExecutionAdapter({
    expectedRepository: 'GuitarAlchemist/gaia', worktree, evidenceRoot,
    executeFactory: async () => { throw new Error('must reconcile without retry'); },
    runWorker: async () => {}, runReviewer: async () => {}, runRepair: async () => {},
  });
  assert.deepEqual((await restarted.findReceipt({ idempotencyKey: key })).addressedCommentIds, []);
});

test('R3 corrupt durable receipt identity or expected revision typed-refuses on restart', async () => {
  const { worktree, evidenceRoot } = executionFixture();
  const key = '1'.repeat(64);
  const adapter = createAgentFactoryExecutionAdapter({
    expectedRepository: 'GuitarAlchemist/gaia', worktree, evidenceRoot,
    executeFactory: async ({ task }) => ({
      schema: 'gaia-agent-factory-receipt/1', status: 'completed', task,
      changeSet: { identity: '2'.repeat(64), files: [{ path: 'src/pump-0.mjs' }] },
    }),
    runWorker: async () => {}, runReviewer: async () => {}, runRepair: async () => {},
  });
  const intent = {
    action: 'RUN_FACTORY_AGENT', repository: 'GuitarAlchemist/gaia', task: 'Repair exact thread.',
    reviewThreadEvidence: {
      threadIdentity: '3'.repeat(64), reviewThreadId: 'PRRT_r3_0',
      anchorPath: 'src/pump-0.mjs', addressedCommentIds: ['PRRC_r3_0'],
      sourceRevision: '4'.repeat(64), observedAt: OBSERVED,
    },
  };
  await adapter.execute({ intent, idempotencyKey: key });
  const path = join(evidenceRoot, key, 'receipt.json');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...receipt, operationIdentity: '5'.repeat(64) }));
  await assert.rejects(adapter.findReceipt({ idempotencyKey: key, intent }),
    (error) => error instanceof PortfolioExecutionError
      && error.code === 'CorruptExecutionReceipt');
});

test('R3 the CLI refuses gate output aliases and hardlinks to authority inputs', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-r3-path-'));
  const grant = join(scratch, 'grant.json');
  const gate = join(scratch, 'gate.json');
  const publicKey = join(scratch, 'public.pem');
  writeFileSync(grant, '{}\n');
  writeFileSync(publicKey, 'unused\n');
  linkSync(grant, gate);
  await assert.rejects(runPrReviewThreadSupervisorCli([
    '--repository', 'GuitarAlchemist/gaia', '--pull-request', '44',
    '--state-dir', scratch, '--worktree', scratch, '--evidence-root', scratch,
    '--database', join(scratch, 'telemetry.duckdb'), '--public-key', publicKey,
    '--authority-ledger', scratch, '--grant', grant, '--gate-out', gate,
  ], {
    createGithub: () => { throw new Error('path refusal must precede effects'); },
    createExecution: () => { throw new Error('path refusal must precede effects'); },
    createAuthority: () => { throw new Error('path refusal must precede effects'); },
    synchronize: async () => {}, writeStdout: () => {},
  }), /distinct|alias|identity|output/iu);
});
