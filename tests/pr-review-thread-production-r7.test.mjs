/** Forced R7 gates for durable clocks and the sealed lane request. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGitGhPrReviewThreadEffects } from '../src/git-gh-pr-review-thread-effects.mjs';
import { createAgentFactoryExecutionAdapter } from '../src/github-portfolio-execution.mjs';
import {
  createBoundedRepairLaneEffects,
  runPrReviewThreadSupervisorTick,
} from '../src/pr-review-thread-supervisor.mjs';

const AT = '2026-09-01T00:00:00.000Z';
const HEAD = 'a'.repeat(40);

const graph = {
  data: { repository: { pullRequest: {
    number: 44, baseRefName: 'main', headRefOid: HEAD,
    reviewThreads: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        id: 'PRRT_R7', path: 'src/pump.mjs', line: 9,
        isResolved: false, isOutdated: false,
        comments: {
          totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: 'PRRC_R7', body: 'P1: durable clocks and requests must remain sealed.',
            review: {
              id: 'PRR_R7', state: 'COMMENTED', submittedAt: AT, commit: { oid: HEAD },
            },
          }],
        },
      }],
    },
  } } },
};

const disputes = { data: { repository: { pullRequest: { comments: {
  totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [],
} } } } };

function provider() {
  return createGitGhPrReviewThreadEffects({
    readDisputeEvidence: async () => false,
    run: async (args) => String(args.find((value) => value.startsWith('query=')) ?? '')
      .includes('GaiaReviewThreadDisputes') ? disputes : graph,
  });
}

function githubFixture() {
  const collector = provider();
  let checklist = null;
  return {
    ...collector,
    async readRepairEvidence({ observation }) { return observation; },
    async findChecklist() { return checklist; },
    async createChecklist({ marker, body }) {
      checklist = { id: 'checklist-r7', marker, body }; return checklist;
    },
    async updateChecklist({ marker, body }) {
      checklist = { ...checklist, marker, body }; return checklist;
    },
  };
}

function waiting() {
  const error = new Error('grant pending'); error.code = 'WaitingAuthority'; return error;
}

function tickInput({ directory, github, lanes, acquireGrant, tickNumber }) {
  return {
    directory, repository: 'GuitarAlchemist/gaia', pullRequest: 44,
    github, lanes,
    authority: { async consume({ grant, intent }) {
      assert.equal(grant.intentRevision, intent.intentRevision);
      return { status: 'AUTHORIZED', grantId: `grant-${intent.action}` };
    } },
    acquireGrant,
    synchronizeTelemetry: async () => ({ schema: 'sync', rowCount: 0 }),
    now: () => new Date(Date.parse(AT) + tickNumber * 1_000),
    run: { runId: 'review-r7', laneGeneration: 1 },
  };
}

function laneIntentPath(directory) {
  const root = join(directory, 'pr-review-thread-operations');
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.intent.json')) continue;
    const path = join(root, name);
    const intent = JSON.parse(readFileSync(path, 'utf8'));
    if (intent.kind === 'LANE_START') return path;
  }
  throw new Error('lane intent not found');
}

function hasLaneIntent(directory) {
  try { laneIntentPath(directory); return true; } catch { return false; }
}

test('R7 malformed, future, and incoherent durable clocks typed-refuse before lane effects', async () => {
  const cases = [
    ['malformed expiry', (intent) => { intent.expiresAt = 'not-an-instant'; }],
    ['future observation', (intent) => {
      intent.observedAt = '2026-09-01T01:00:00.000Z';
      intent.expiresAt = '2026-09-01T01:02:00.000Z';
      intent.request.observedAt = intent.observedAt;
    }],
    ['incoherent nested time', (intent) => {
      intent.request.observedAt = '2026-09-01T00:00:01.000Z';
    }],
  ];

  for (const [name, mutate] of cases) {
    const directory = mkdtempSync(join(tmpdir(), 'gaia-r7-clock-'));
    const github = githubFixture(); let laneStarts = 0;
    const lanes = {
      async findRepairLane() { return null; },
      async startRepairLane({ idempotencyKey }) {
        laneStarts += 1; return { id: 'lane-r7', idempotencyKey, status: 'running' };
      },
    };
    const firstGrant = async (intent) => {
      if (intent.action === 'CLAIM_REVIEW_THREAD' && !hasLaneIntent(directory)) {
        return { action: intent.action, intentRevision: intent.intentRevision };
      }
      throw waiting();
    };
    await runPrReviewThreadSupervisorTick(tickInput({
      directory, github, lanes, acquireGrant: firstGrant, tickNumber: 0,
    }));
    const path = laneIntentPath(directory);
    const intent = JSON.parse(readFileSync(path, 'utf8')); mutate(intent);
    writeFileSync(path, `${JSON.stringify(intent)}\n`);
    const grantAll = async (candidate) => ({
      action: candidate.action, intentRevision: candidate.intentRevision,
    });
    await assert.rejects(
      runPrReviewThreadSupervisorTick(tickInput({
        directory, github, lanes, acquireGrant: grantAll, tickNumber: 1,
      })),
      (error) => error?.code === 'OperationIntentCorrupt',
      name,
    );
    assert.equal(laneStarts, 0, `${name} must perform no lane effect`);
  }
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function executionFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gaia-r7-factory-'));
  const repo = join(root, 'repo'); const worktree = join(root, 'worktree');
  const evidenceRoot = join(root, 'evidence'); mkdirSync(repo); mkdirSync(evidenceRoot);
  git(repo, 'init', '--initial-branch=main'); git(repo, 'config', 'user.name', 'Gaia Test');
  git(repo, 'config', 'user.email', 'gaia@example.invalid');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/GuitarAlchemist/gaia.git');
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'pump.mjs'), 'export {};\n');
  git(repo, 'add', 'src/pump.mjs'); git(repo, 'commit', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', 'r7-fixture', worktree, 'HEAD');
  return { root, worktree, evidenceRoot };
}

test('R7 real bounded lane effects adopt original factory receipt after response loss and clock advance', async () => {
  const { root, worktree, evidenceRoot } = executionFixture();
  const directory = join(root, 'state'); mkdirSync(directory);
  const github = githubFixture(); let executions = 0;
  const firstGrant = async (intent) => {
    if (intent.action === 'CLAIM_REVIEW_THREAD' && !hasLaneIntent(directory)) {
      return { action: intent.action, intentRevision: intent.intentRevision };
    }
    throw waiting();
  };
  const firstExecution = createAgentFactoryExecutionAdapter({
    expectedRepository: 'GuitarAlchemist/gaia', worktree, evidenceRoot,
    executeFactory: async ({ task, persistReceipt }) => {
      executions += 1;
      await persistReceipt({
        schema: 'gaia-agent-factory-receipt/1', status: 'completed', task,
        changeSet: { identity: '1'.repeat(64), files: [{ path: 'src/pump.mjs' }] },
      });
      throw new Error('response lost after durable provider success');
    },
    runWorker: async () => {}, runReviewer: async () => {}, runRepair: async () => {},
  });

  await runPrReviewThreadSupervisorTick(tickInput({
    directory, github, lanes: createBoundedRepairLaneEffects({ execution: firstExecution }),
    acquireGrant: firstGrant, tickNumber: 0,
  }));
  const grantAll = async (intent) => ({
    action: intent.action, intentRevision: intent.intentRevision,
  });
  await assert.rejects(runPrReviewThreadSupervisorTick(tickInput({
    directory, github, lanes: createBoundedRepairLaneEffects({ execution: firstExecution }),
    acquireGrant: grantAll, tickNumber: 1,
  })), { code: 'LaneStartFailed' });
  assert.equal(executions, 1);

  const restartedExecution = createAgentFactoryExecutionAdapter({
    expectedRepository: 'GuitarAlchemist/gaia', worktree, evidenceRoot,
    executeFactory: async () => { executions += 1; throw new Error('blind retry'); },
    runWorker: async () => {}, runReviewer: async () => {}, runRepair: async () => {},
  });
  const adopted = await runPrReviewThreadSupervisorTick(tickInput({
    directory, github, lanes: createBoundedRepairLaneEffects({ execution: restartedExecution }),
    acquireGrant: grantAll, tickNumber: 2,
  }));
  assert.equal(adopted.results[0].lane.status, 'completed');
  assert.equal(executions, 1, 'empty-memory restart adopts the original receipt without retry');
});
