/** R3 race-closure gates for production review-thread orchestration. */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createGitGhPrReviewThreadEffects } from '../src/git-gh-pr-review-thread-effects.mjs';
import {
  createFileEd25519AuthorityAdapter,
  portfolioGrantPreimage,
} from '../src/github-portfolio-authority.mjs';
import {
  PortfolioExecutionError,
  createAgentFactoryExecutionAdapter,
} from '../src/github-portfolio-execution.mjs';
import { runPrReviewThreadSupervisorCli } from '../scripts/pr-review-thread-supervisor.mjs';
import { createGrantRegistryAcquirer } from '../scripts/pr-review-thread-supervisor.mjs';
import { createBoundedRepairLaneEffects } from '../src/pr-review-thread-supervisor.mjs';

const REVIEWED = 'a'.repeat(40);
const OBSERVED = '2026-08-31T20:00:00.000Z';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const mutantScratch = mkdtempSync(join(tmpdir(), 'gaia-r3-mutant-'));
test.after(() => rmSync(mutantScratch, { recursive: true, force: true }));

/**
 * Write a one-expression mutant of a shipped module OUTSIDE `src/`, so the product gates
 * that enumerate the shipped tree, and `verify`, which scans it, never race this file's
 * write/remove pairs (#98). Sibling imports are rewritten to absolute URLs.
 */
function plantMutant(name, mutant) {
  const mutantPath = join(mutantScratch, name);
  writeFileSync(mutantPath, mutant.replaceAll("from './", `from '${pathToFileURL(SRC).href}`), 'utf8');
  return pathToFileURL(mutantPath).href;
}

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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function disputeSourceRevision(thread, head = REVIEWED) {
  return createHash('sha256').update(canonicalJson({
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, currentHeadOid: head,
    reviewThreadId: thread.id, isResolved: thread.isResolved, isOutdated: thread.isOutdated,
    comments: thread.comments.nodes.map(({ id, body, review }) => ({
      id, body, reviewId: review?.id, reviewState: review?.state,
      reviewedHeadOid: review?.commit?.oid,
    })),
  })).digest('hex');
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

test('R3 per-thread provider dispute evidence derives OPEN, UNKNOWN, and NONE independently', async () => {
  const graph = reviewGraph({ threads: 3 });
  const [open, corrupt] = graph.data.repository.pullRequest.reviewThreads.nodes;
  const marker = (thread, sourceRevision, status) => ({
    id: `IC_${thread.id}`, updatedAt: OBSERVED,
    body: `gaia-dispute-evidence: ${JSON.stringify({
      schema: 'gaia-pr-review-thread-dispute-provider/1',
      reviewThreadId: thread.id, sourceRevision, status,
    })}`,
  });
  const disputes = disputeGraph({ comments: [
    marker(open, disputeSourceRevision(open), 'OPEN'),
    marker(corrupt, '0'.repeat(64), 'NONE'),
  ] });
  const adapter = createGitGhPrReviewThreadEffects({
    run: async (args) => String(args.find((entry) => entry.startsWith('query=')))
      .includes('GaiaReviewThreadDisputes') ? disputes : graph,
  });
  const collection = await adapter.collectReviewThreads({
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: OBSERVED,
    run: { runId: 'review-r3', laneGeneration: 1 },
  });
  assert.deepEqual(collection.observations.map(({ reviewThread }) => reviewThread.disputed),
    [true, 'UNKNOWN', false]);
});

test('R3 a malformed dispute marker poisons the complete provider window to UNKNOWN', async () => {
  const graph = reviewGraph({ threads: 2 });
  const adapter = createGitGhPrReviewThreadEffects({
    run: async (args) => String(args.find((entry) => entry.startsWith('query=')))
      .includes('GaiaReviewThreadDisputes')
      ? disputeGraph({ comments: [{ id: 'IC_bad', body: 'gaia-dispute-evidence: not-json' }] })
      : graph,
  });
  const collection = await adapter.collectReviewThreads({
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: OBSERVED,
    run: { runId: 'review-r3', laneGeneration: 1 },
  });
  assert.deepEqual(collection.observations.map(({ reviewThread }) => reviewThread.disputed),
    ['UNKNOWN', 'UNKNOWN']);
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
  assert.equal(calls.filter((call) => call.includes('pulls/44')).length, 2,
    'the exact head is confirmed after every pinned measurement');
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
    action: 'RUN_FACTORY_AGENT', repository: 'GuitarAlchemist/gaia',
    task: [
      'Repair review thread PRRT_r3_0 on GuitarAlchemist/gaia#44.',
      `Reviewed head: ${REVIEWED}.`,
      'Anchor path: src/pump-0.mjs.',
      'Address exactly comment ids: PRRC_r3_0.',
    ].join(' '),
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
      && ['CorruptExecutionReceipt', 'ExecutionReceiptMismatch'].includes(error.code));
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

test('R3 CLAIM CHECKLIST COMMENT and RESOLVE use exact grants; COMMENT reuse is refused durably', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-r3-grants-'));
  const ledgerDir = join(root, 'ledger');
  mkdirSync(ledgerDir);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const makeIntent = (action, token) => ({
    intentRevision: token.repeat(64), action, repository: 'GuitarAlchemist/gaia',
    itemKind: 'PULL_REQUEST', itemId: 'pull-request-44', itemNumber: 44,
    snapshotRevision: '9'.repeat(64),
  });
  const makeGrant = (intent, suffix) => {
    const payload = {
      schema: 'gaia-github-portfolio-grant/1', grantId: `r3-${suffix}`,
      ...intent, expiresAt: '2026-08-31T22:00:00.000Z',
    };
    return {
      ...payload,
      signature: sign(null, portfolioGrantPreimage(payload), privateKey).toString('base64url'),
    };
  };
  const comment = makeIntent('POST_REVIEW_THREAD_COMMENT', '6');
  const resolve = makeIntent('RESOLVE_REVIEW_THREAD', '7');
  const claim = makeIntent('CLAIM_REVIEW_THREAD', '4');
  const checklist = makeIntent('UPSERT_REVIEW_THREAD_CHECKLIST', '5');
  const grants = [
    makeGrant(claim, 'claim'), makeGrant(checklist, 'checklist'),
    makeGrant(comment, 'comment'), makeGrant(resolve, 'resolve'),
  ];
  const acquire = createGrantRegistryAcquirer(grants);
  const authority = createFileEd25519AuthorityAdapter({
    publicKey, ledgerDir, now: () => new Date('2026-08-31T21:00:00.000Z'),
  });
  const commentGrant = await acquire(comment);
  const resolveGrant = await acquire(resolve);
  assert.notEqual(commentGrant.grantId, resolveGrant.grantId);
  await authority.consume({ grant: await acquire(claim), intent: claim });
  await authority.consume({ grant: await acquire(checklist), intent: checklist });
  await authority.consume({ grant: commentGrant, intent: comment });
  await authority.consume({ grant: resolveGrant, intent: resolve });
  await assert.rejects(authority.consume({ grant: commentGrant, intent: comment }),
    (error) => error.code === 'GrantConsumed');
});

test('R3 a true empty-memory restart reconciles factory success before any retry', async () => {
  const { root, worktree, evidenceRoot } = executionFixture();
  const key = '8'.repeat(64);
  const counter = join(root, 'factory-count.txt');
  const child = join(root, 'crash-after-success.mjs');
  const moduleUrl = new URL('../src/github-portfolio-execution.mjs', import.meta.url).href;
  const intent = {
    action: 'RUN_FACTORY_AGENT', repository: 'GuitarAlchemist/gaia',
    task: [
      'Repair review thread PRRT_r3_0 on GuitarAlchemist/gaia#44.',
      `Reviewed head: ${REVIEWED}.`,
      'Anchor path: src/pump-0.mjs.',
      'Address exactly comment ids: PRRC_r3_0.',
    ].join(' '),
    reviewThreadEvidence: {
      threadIdentity: 'a'.repeat(64), reviewThreadId: 'PRRT_r3_0',
      anchorPath: 'src/pump-0.mjs', addressedCommentIds: ['PRRC_r3_0'],
      sourceRevision: 'b'.repeat(64), observedAt: OBSERVED,
    },
  };
  writeFileSync(child, `
import { writeFileSync } from 'node:fs';
import { createAgentFactoryExecutionAdapter } from ${JSON.stringify(moduleUrl)};
const [worktree,evidenceRoot,counter,key,intentText] = process.argv.slice(2);
const intent = JSON.parse(intentText);
const adapter = createAgentFactoryExecutionAdapter({
  expectedRepository:'GuitarAlchemist/gaia', worktree, evidenceRoot,
  executeFactory:async ({task})=>{
    writeFileSync(counter,'1');
    return {schema:'gaia-agent-factory-receipt/1',status:'completed',task,
      changeSet:{identity:'c'.repeat(64),files:[{path:'src/pump-0.mjs'}]}};
  },
  runWorker:async()=>{},runReviewer:async()=>{},runRepair:async()=>{},
});
await adapter.execute({intent,idempotencyKey:key});
process.exit(73);
`, 'utf8');
  const crashed = spawnSync(process.execPath, [
    child, worktree, evidenceRoot, counter, key, JSON.stringify(intent),
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(crashed.status, 73);
  assert.equal(readFileSync(counter, 'utf8'), '1');
  let retried = 0;
  const restartedExecution = createAgentFactoryExecutionAdapter({
    expectedRepository: 'GuitarAlchemist/gaia', worktree, evidenceRoot,
    executeFactory: async () => { retried += 1; throw new Error('must not retry'); },
    runWorker: async () => {}, runReviewer: async () => {}, runRepair: async () => {},
  });
  const lane = createBoundedRepairLaneEffects({ execution: restartedExecution });
  const found = await lane.findRepairLane({
    threadIdentity: intent.reviewThreadEvidence.threadIdentity,
    idempotencyKey: key, repository: intent.repository, pullRequest: 44,
    reviewThreadId: intent.reviewThreadEvidence.reviewThreadId,
    reviewedHeadOid: REVIEWED, anchorPath: intent.reviewThreadEvidence.anchorPath,
    actionableCommentIds: intent.reviewThreadEvidence.addressedCommentIds,
    sourceRevision: intent.reviewThreadEvidence.sourceRevision,
    observedAt: intent.reviewThreadEvidence.observedAt,
  });
  assert.equal(found.status, 'completed');
  assert.deepEqual(found.addressedCommentIds, ['PRRC_r3_0']);
  assert.equal(retried, 0);
});

test('R3 MECHANISM REVERT: stable identity and receipt reconciliation prevent duplicate factory effects', async () => {
  const { worktree, evidenceRoot } = executionFixture();
  const key = 'd'.repeat(64);
  const intent = {
    action: 'RUN_FACTORY_AGENT', repository: 'GuitarAlchemist/gaia', task: 'Repair exact thread.',
    reviewThreadEvidence: {
      threadIdentity: 'e'.repeat(64), reviewThreadId: 'PRRT_r3_0',
      anchorPath: 'src/pump-0.mjs', addressedCommentIds: ['PRRC_r3_0'],
      sourceRevision: 'f'.repeat(64), observedAt: OBSERVED,
    },
  };
  const original = createAgentFactoryExecutionAdapter({
    expectedRepository: 'GuitarAlchemist/gaia', worktree, evidenceRoot,
    executeFactory: async ({ task }) => ({
      schema: 'gaia-agent-factory-receipt/1', status: 'completed', task,
      changeSet: { identity: '1'.repeat(64), files: [{ path: 'src/pump-0.mjs' }] },
    }),
    runWorker: async () => {}, runReviewer: async () => {}, runRepair: async () => {},
  });
  await original.execute({ intent, idempotencyKey: key });
  const source = readFileSync(join(SRC, 'github-portfolio-execution.mjs'), 'utf8');
  {
    const stableSource = source.replace(
      "kind: 'RUN_FACTORY_AGENT', threadIdentity: evidence?.threadIdentity ?? null,",
      "kind: 'REVERTED_FACTORY_AGENT', threadIdentity: evidence?.threadIdentity ?? null,",
    );
    assert.notEqual(stableSource, source);
    const stableMutant = await import(plantMutant('r3-stable-identity-mutant.mjs', stableSource));
    const stableAdapter = stableMutant.createAgentFactoryExecutionAdapter({
      expectedRepository: 'GuitarAlchemist/gaia', worktree, evidenceRoot,
      executeFactory: async () => { throw new Error('must not run'); },
      runWorker: async () => {}, runReviewer: async () => {}, runRepair: async () => {},
    });
    await assert.rejects(stableAdapter.findReceipt({ idempotencyKey: key, intent }),
      (error) => error.code === 'ExecutionReceiptMismatch');

    const reconcileSource = source.replace(
      'if (existsSync(existingReceiptPath)) {', 'if (false) {',
    );
    assert.notEqual(reconcileSource, source);
    const reconcileMutant = await import(plantMutant('r3-reconciliation-mutant.mjs', reconcileSource));
    let duplicateEffects = 0;
    const reconcileAdapter = reconcileMutant.createAgentFactoryExecutionAdapter({
      expectedRepository: 'GuitarAlchemist/gaia', worktree, evidenceRoot,
      executeFactory: async ({ task }) => {
        duplicateEffects += 1;
        return { schema: 'gaia-agent-factory-receipt/1', status: 'completed', task };
      },
      runWorker: async () => {}, runReviewer: async () => {}, runRepair: async () => {},
    });
    await reconcileAdapter.execute({ intent, idempotencyKey: key });
    assert.equal(duplicateEffects, 1, 'without reconciliation the provider effect is repeated');
  }
});

test('R3 MECHANISM REVERT: removing intent-before-effect starts a lane without durable intent', async () => {
  const source = readFileSync(join(SRC, 'pr-review-thread-supervisor.mjs'), 'utf8');
  const mutantSource = source.replace(
    'if (reserve(path, intent)) operationIntent = intent;',
    'if (true) operationIntent = intent;',
  );
  assert.notEqual(mutantSource, source);
  {
    const mutant = await import(plantMutant('r3-intent-before-effect-mutant.mjs', mutantSource));
    const directory = mkdtempSync(join(tmpdir(), 'gaia-r3-intent-mutant-'));
    const collection = await createGitGhPrReviewThreadEffects({
      readDisputeEvidence: async () => false, run: async () => reviewGraph(),
    }).collectReviewThreads({
      repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: OBSERVED,
      run: { runId: 'review-r3', laneGeneration: 1 },
    });
    let started = 0;
    const github = {
      async collectReviewThreads() { return collection; },
      async readReviewThread() { return { isResolved: false, comments: [] }; },
      async postReviewThreadComment() { throw new Error('not reached'); },
      async resolveReviewThread() { throw new Error('not reached'); },
      async readRepairEvidence({ observation }) { return observation; },
      async findChecklist() { return null; },
      async createChecklist({ body }) { return { id: 'IC_r3', body }; },
      async updateChecklist({ body }) { return { id: 'IC_r3', body }; },
    };
    await assert.rejects(mutant.runPrReviewThreadSupervisorTick({
      directory, repository: 'GuitarAlchemist/gaia', pullRequest: 44, github,
      lanes: {
        async findRepairLane() { return null; },
        async startRepairLane(request) {
          started += 1;
          const operationFiles = existsSync(join(directory, 'pr-review-thread-operations'))
            ? readdirSync(join(directory, 'pr-review-thread-operations')) : [];
          assert.equal(operationFiles.some((name) => name.endsWith('.intent.json')), false);
          return { id: 'lane-r3', idempotencyKey: request.idempotencyKey };
        },
      },
      authority: { async consume() { return { status: 'AUTHORIZED' }; } }, grant: null,
      synchronizeTelemetry: async () => ({ rowCount: 0 }), now: () => new Date(OBSERVED),
    }), { code: 'LaneStartFailed' });
    assert.equal(started, 1);
  }
});
