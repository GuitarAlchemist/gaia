/** Forced R4 gates for late authority, provider receipts, continuous invocation, and pagination. */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGitGhPrReviewThreadEffects } from '../src/git-gh-pr-review-thread-effects.mjs';
import { createAgentFactoryExecutionAdapter } from '../src/github-portfolio-execution.mjs';
import { portfolioGrantPreimage } from '../src/github-portfolio-authority.mjs';
import { readPrReviewRepairLedger } from '../src/pr-review-thread-repair.mjs';
import * as supervisorCli from '../scripts/pr-review-thread-supervisor.mjs';

const AT = '2026-08-31T21:00:00.000Z';
const HEAD = 'a'.repeat(40);

const comment = (index) => ({
  id: `PRRC_r4_${index}`, body: index === 0 ? 'P1: nested pagination blocker.' : 'supporting evidence',
  review: {
    id: 'PRR_r4', state: 'COMMENTED', submittedAt: AT, commit: { oid: HEAD },
  },
});

test('R4 fully paginates more than 100 nested comments and converges duplicate pages', async () => {
  const first = Array.from({ length: 100 }, (_, index) => comment(index));
  let nestedCalls = 0;
  const adapter = createGitGhPrReviewThreadEffects({
    run: async (args) => {
      const query = String(args.find((entry) => entry.startsWith('query=')) ?? '');
      if (query.includes('GaiaReviewThreadComments')) {
        nestedCalls += 1;
        return { data: { node: { id: 'PRRT_r4', comments: {
          totalCount: 101, pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [comment(99), comment(100)],
        } } } };
      }
      if (query.includes('GaiaReviewThreadDisputes')) {
        return { data: { repository: { pullRequest: { comments: {
          totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [],
        } } } } };
      }
      return { data: { repository: { pullRequest: {
        number: 44, baseRefName: 'main', headRefOid: HEAD,
        reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
          id: 'PRRT_r4', path: 'src/pump.mjs', line: 9, isResolved: false, isOutdated: false,
          comments: {
            totalCount: 101, pageInfo: { hasNextPage: true, endCursor: 'nested-100' }, nodes: first,
          },
        }] },
      } } } };
    },
  });
  const collection = await adapter.collectReviewThreads({
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: AT,
    run: { runId: 'review-r4', laneGeneration: 1 },
  });
  assert.equal(collection.complete, true);
  assert.equal(nestedCalls, 1);
  assert.equal(collection.observations[0].reviewThread.comments.length, 101);
  assert.equal(collection.observations[0].reviewThread.comments
    .some(({ id }) => id === 'PRRC_r4_100'), true);
});

test('R4 lazy exact-intent grant acquisition persists WAITING_AUTHORITY then re-reads the registry', async () => {
  assert.equal(typeof supervisorCli.createLazyGrantRegistryAcquirer, 'function');
  const root = mkdtempSync(join(tmpdir(), 'gaia-r4-grants-'));
  const registryPath = join(root, 'grants.json');
  const requestDirectory = join(root, 'requests');
  writeFileSync(registryPath, '[]\n');
  const intent = {
    intentRevision: 'b'.repeat(64), action: 'POST_REVIEW_THREAD_COMMENT',
    repository: 'GuitarAlchemist/gaia', itemKind: 'PULL_REQUEST', itemId: 'pull-request-44',
    itemNumber: 44, snapshotRevision: 'c'.repeat(64),
  };
  const acquire = supervisorCli.createLazyGrantRegistryAcquirer({ registryPath, requestDirectory });
  await assert.rejects(acquire(intent), (error) => error.code === 'WaitingAuthority');
  const request = JSON.parse(readFileSync(join(requestDirectory, `${intent.intentRevision}.json`), 'utf8'));
  assert.equal(request.intentRevision, intent.intentRevision);
  const commentGrant = { ...intent, grantId: 'comment-r4', signature: 'deferred-to-authority' };
  writeFileSync(registryPath, `${JSON.stringify([commentGrant])}\n`);
  assert.deepEqual(await acquire(intent), commentGrant);
});

test('R4 real CLI ticks request COMMENT then RESOLVE grants only after each durable intent exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-r4-cli-grants-'));
  const state = join(root, 'state'); const authorityLedger = join(root, 'authority');
  const evidence = join(root, 'evidence');
  mkdirSync(state); mkdirSync(authorityLedger); mkdirSync(evidence);
  const registryPath = join(root, 'grants.json'); const publicKeyPath = join(root, 'public.pem');
  const gatePath = join(root, 'gate.json'); writeFileSync(registryPath, '[]\n');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  const sourceRevision = '2'.repeat(64); const repairHead = 'b'.repeat(40);
  const observation = {
    schema: 'gaia-pr-review-thread-observation/1', observedAt: AT,
    repository: 'GuitarAlchemist/gaia', pullRequest: { number: 44, baseBranch: 'main' },
    review: { id: 'PRR_r4_cli', state: 'COMMENTED', submittedAt: AT, reviewedHeadOid: HEAD },
    reviewThread: {
      id: 'PRRT_r4_cli', path: 'src/pump.mjs', line: 9, isResolved: false,
      isOutdated: false, disputed: false,
      comments: [{ id: 'PRRC_r4_cli', body: 'P1: exact CLI lifecycle.' }],
    },
    currentHeadOid: repairHead,
    applicability: {
      anchorDigestAtReview: '3'.repeat(64), anchorDigestAtCurrentHead: '3'.repeat(64),
    },
    repair: {
      headOid: repairHead, descendsFromReviewedHead: true, touchesAnchorPath: true,
      commitsAheadOfReviewedHead: 1, addressedCommentIds: ['PRRC_r4_cli'],
    },
    checks: {
      headOid: repairHead, requiredContexts: ['test'],
      conclusions: [{ context: 'test', conclusion: 'SUCCESS' }],
    },
    run: { runId: 'review-r4-cli', laneGeneration: 1 }, sourceRevision,
  };
  let resolved = false; const replies = [];
  const github = {
    async collectReviewThreads() {
      return {
        schema: 'gaia-pr-review-thread-collection/1', complete: true, observedAt: AT,
        sourceRevision, observations: [{
          ...observation, reviewThread: { ...observation.reviewThread, isResolved: resolved },
        }],
      };
    },
    async readRepairEvidence() { return observation; },
    async readReviewThread() { return { isResolved: resolved, comments: replies }; },
    async postReviewThreadComment({ threadIdentity }) {
      const receipt = { id: 'reply-r4', url: 'https://github.com/x/y/pull/44#discussion_r4', marker: threadIdentity };
      replies.push(receipt); return receipt;
    },
    async resolveReviewThread() { resolved = true; return { isResolved: true }; },
    async findChecklist() { return null; },
    async createChecklist() { throw new Error('checklist has no authority in this fixture'); },
    async updateChecklist() { throw new Error('checklist has no authority in this fixture'); },
  };
  const argv = [
    '--repository', 'GuitarAlchemist/gaia', '--pull-request', '44', '--state-dir', state,
    '--worktree', root, '--evidence-root', evidence, '--database', join(root, 'telemetry.duckdb'),
    '--public-key', publicKeyPath, '--authority-ledger', authorityLedger,
    '--grant', registryPath, '--gate-out', gatePath,
  ];
  const dependencies = {
    createGithub: () => github,
    createExecution: () => ({
      async findReceipt() {
        return { status: 'completed', changeSet: { identity: '4'.repeat(64) }, addressedCommentIds: ['PRRC_r4_cli'] };
      },
      async execute() { throw new Error('existing factory receipt must be adopted'); },
    }),
    synchronize: async () => ({ schema: 'sync', rowCount: 0 }),
    now: () => new Date(AT), writeStdout: () => {},
  };
  const requests = () => {
    const requestDir = join(state, 'pr-review-thread-grant-requests');
    try {
      return execFileSync(process.execPath, ['-e',
        `const fs=require('fs'),p=${JSON.stringify(requestDir)};console.log(JSON.stringify(fs.readdirSync(p).map(n=>JSON.parse(fs.readFileSync(require('path').join(p,n),'utf8')))))`],
      { encoding: 'utf8', windowsHide: true }).trim();
    } catch { return '[]'; }
  };
  const makeGrant = (intent) => {
    const { schema: _requestSchema, ...grantIntent } = intent;
    const payload = {
      schema: 'gaia-github-portfolio-grant/1', grantId: `r4-${intent.action.toLowerCase()}`,
      ...grantIntent, expiresAt: '2026-08-31T22:00:00.000Z',
    };
    return { ...payload, signature: sign(null, portfolioGrantPreimage(payload), privateKey).toString('base64url') };
  };

  await supervisorCli.runPrReviewThreadSupervisorCli(argv, dependencies);
  let requested = JSON.parse(requests());
  const commentIntent = requested.find(({ action }) => action === 'POST_REVIEW_THREAD_COMMENT');
  assert.ok(commentIntent, 'COMMENT grant is requested only after its durable CLAIMED intent');
  assert.equal(readPrReviewRepairLedger({ directory: state }).transitions
    .some(({ revision }) => revision === commentIntent.intentRevision), true);
  writeFileSync(registryPath, `${JSON.stringify([makeGrant(commentIntent)])}\n`);

  await supervisorCli.runPrReviewThreadSupervisorCli(argv, dependencies);
  requested = JSON.parse(requests());
  const resolveIntent = requested.find(({ action }) => action === 'RESOLVE_REVIEW_THREAD');
  assert.ok(resolveIntent, 'RESOLVE gets its own request only after COMMENT completed');
  assert.notEqual(resolveIntent.intentRevision, commentIntent.intentRevision);
  writeFileSync(registryPath,
    `${JSON.stringify([makeGrant(commentIntent), makeGrant(resolveIntent)])}\n`);
  await supervisorCli.runPrReviewThreadSupervisorCli(argv, dependencies);
  assert.equal(resolved, true);
  assert.equal(replies.length, 1);
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function executionFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gaia-r4-factory-'));
  const repo = join(root, 'repo'); const worktree = join(root, 'worktree');
  const evidenceRoot = join(root, 'evidence'); mkdirSync(repo); mkdirSync(evidenceRoot);
  git(repo, 'init', '--initial-branch=main'); git(repo, 'config', 'user.name', 'Gaia Test');
  git(repo, 'config', 'user.email', 'gaia@example.invalid');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/GuitarAlchemist/gaia.git');
  writeFileSync(join(repo, 'fixture.txt'), 'fixture\n');
  git(repo, 'add', 'fixture.txt'); git(repo, 'commit', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', 'r4-fixture', worktree, 'HEAD');
  return { root, worktree, evidenceRoot };
}

test('R4 empty-memory restart adopts factory receipt written before wrapper return', async () => {
  const { root, worktree, evidenceRoot } = executionFixture();
  const child = join(root, 'provider-crash.mjs'); const key = 'd'.repeat(64);
  const moduleUrl = new URL('../src/github-portfolio-execution.mjs', import.meta.url).href;
  const intent = {
    action: 'RUN_FACTORY_AGENT', repository: 'GuitarAlchemist/gaia', task: 'Repair exact thread.',
    reviewThreadEvidence: {
      threadIdentity: 'e'.repeat(64), reviewThreadId: 'PRRT_r4', anchorPath: 'fixture.txt',
      addressedCommentIds: ['PRRC_r4_0'], sourceRevision: 'f'.repeat(64), observedAt: AT,
    },
  };
  writeFileSync(child, `
import { createAgentFactoryExecutionAdapter } from ${JSON.stringify(moduleUrl)};
const [worktree,evidenceRoot,key,intentText]=process.argv.slice(2); const intent=JSON.parse(intentText);
const adapter=createAgentFactoryExecutionAdapter({
 expectedRepository:'GuitarAlchemist/gaia',worktree,evidenceRoot,
 executeFactory:async ({task,persistReceipt})=>{
   await persistReceipt({schema:'gaia-agent-factory-receipt/1',status:'completed',task,
     changeSet:{identity:'1'.repeat(64),files:[{path:'fixture.txt'}]}});
   process.exit(73);
 },runWorker:async()=>{},runReviewer:async()=>{},runRepair:async()=>{},
});
await adapter.execute({intent,idempotencyKey:key});
`, 'utf8');
  const crashed = spawnSync(process.execPath,
    [child, worktree, evidenceRoot, key, JSON.stringify(intent)], { encoding: 'utf8', windowsHide: true });
  assert.equal(crashed.status, 73);
  let retried = 0;
  const restarted = createAgentFactoryExecutionAdapter({
    expectedRepository: 'GuitarAlchemist/gaia', worktree, evidenceRoot,
    executeFactory: async () => { retried += 1; throw new Error('blind retry'); },
    runWorker: async () => {}, runReviewer: async () => {}, runRepair: async () => {},
  });
  const adopted = await restarted.findReceipt({ idempotencyKey: key, intent });
  assert.equal(adopted.status, 'completed'); assert.equal(retried, 0);
});

test('R4 continuous supervisor serializes automatic ticks and consumes every gate', async () => {
  assert.equal(typeof supervisorCli.runPrReviewThreadSupervisorLoop, 'function');
  const calls = []; const controller = new AbortController();
  await supervisorCli.runPrReviewThreadSupervisorLoop(['--watch-ms', '10000'], {
    signal: controller.signal,
    runTick: async () => {
      calls.push('tick');
      return { state: calls.length === 1 ? 'BLOCKED' : 'READY', blocksMerge: calls.length === 1 };
    },
    consumeGate: async (gate) => {
      calls.push(`gate:${gate.state}`); if (gate.state === 'READY') controller.abort();
    },
    wait: async () => {},
  });
  assert.deepEqual(calls, ['tick', 'gate:BLOCKED', 'tick', 'gate:READY']);
});
