/**
 * Production R1 gates for the review-thread pump. These tests exercise only public seams: the
 * GitHub collector/effect Adapter, the supervisor tick, the merge gate and the DuckDB projection.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGitGhPrReviewThreadEffects } from '../src/git-gh-pr-review-thread-effects.mjs';
import {
  derivePrReviewThreadMergeGate,
  runPrReviewThreadSupervisorTick,
} from '../src/pr-review-thread-supervisor.mjs';
import {
  PR_REVIEW_THREAD_DUCKDB_STATEMENTS,
  synchronizePrReviewThreadDuckDb,
} from '../src/duckdb-pr-review-thread-telemetry.mjs';
import {
  EMPTY_PR_REVIEW_REPAIR_LEDGER_REVISION,
  appendPrReviewRepairTransition,
  readPrReviewRepairLedger,
} from '../src/pr-review-thread-repair.mjs';

const OID = 'a'.repeat(40);
const AT = '2026-08-31T14:00:00.000Z';

const graph = ({ resolved = false } = {}) => ({
  data: {
    repository: {
      pullRequest: {
        number: 44,
        baseRefName: 'main',
        headRefOid: OID,
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: 'PRRT_thread_44', path: 'src/pump.mjs', line: 41,
            isResolved: resolved, isOutdated: false,
            comments: {
              nodes: [{
                id: 'PRRC_comment_44', body: 'P1: missed COMMENTED review thread.',
                review: {
                  id: 'PRR_review_44', state: 'COMMENTED', submittedAt: AT,
                  commit: { oid: OID },
                },
              }],
            },
          }],
        },
      },
    },
  },
});

test('R1 collector builds a COMMENTED P1 observation from actual GraphQL review-thread data', async () => {
  const calls = [];
  const adapter = createGitGhPrReviewThreadEffects({
    run: async (args) => { calls.push(args); return graph(); },
  });

  const observations = await adapter.collectReviewThreads({
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: AT,
    run: { runId: 'review-44', laneGeneration: 1 },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['api', 'graphql']);
  assert.equal(observations.complete, true);
  assert.equal(observations.observations.length, 1);
  const [observation] = observations.observations;
  assert.equal(observation.review.state, 'COMMENTED');
  assert.equal(observation.review.reviewedHeadOid, OID);
  assert.equal(observation.reviewThread.comments[0].body, 'P1: missed COMMENTED review thread.');
  assert.match(observation.sourceRevision, /^[a-f0-9]{64}$/u);
});

function concurrentLanePort() {
  const receipts = new Map();
  let starts = 0;
  return {
    get starts() { return starts; },
    async findRepairLane({ idempotencyKey }) { return receipts.get(idempotencyKey) ?? null; },
    async startRepairLane(request) {
      if (receipts.has(request.idempotencyKey)) return receipts.get(request.idempotencyKey);
      starts += 1;
      const receipt = { id: `lane-${request.threadIdentity}`, idempotencyKey: request.idempotencyKey };
      receipts.set(request.idempotencyKey, receipt);
      return receipt;
    },
  };
}

function supervisorGithub() {
  const checklists = new Map();
  let creates = 0;
  return {
    get creates() { return creates; },
    async collectReviewThreads() {
      const adapter = createGitGhPrReviewThreadEffects({ run: async () => graph() });
      return adapter.collectReviewThreads({
        repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: AT,
        run: { runId: 'review-44', laneGeneration: 1 },
      });
    },
    async readReviewThread() { return { isResolved: false, comments: [] }; },
    async postReviewThreadComment() { throw new Error('not verified yet'); },
    async resolveReviewThread() { throw new Error('not verified yet'); },
    async findChecklist({ marker }) { return checklists.get(marker) ?? null; },
    async createChecklist(request) {
      if (checklists.has(request.marker)) return checklists.get(request.marker);
      creates += 1;
      const receipt = { id: 'IC_checklist_44', url: 'https://github.com/x/y/issues/44#issuecomment-1' };
      checklists.set(request.marker, receipt);
      return receipt;
    },
    async updateChecklist(request) { return checklists.get(request.marker); },
  };
}

test('R1 duplicate collector ticks converge to one bounded lane and one claim checklist', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaia-pr-review-production-'));
  const github = supervisorGithub();
  const lanes = concurrentLanePort();
  const authority = { consume: async () => ({ status: 'AUTHORIZED', grantId: 'unused' }) };
  const tick = () => runPrReviewThreadSupervisorTick({
    directory, repository: 'GuitarAlchemist/gaia', pullRequest: 44,
    github, lanes, authority, grant: null, now: () => new Date(AT),
    synchronizeTelemetry: async () => ({ rowCount: 3 }),
  });

  await Promise.all([tick(), tick()]);

  assert.equal(lanes.starts, 1, 'one stable operation identity starts at most one lane');
  assert.equal(github.creates, 1, 'one marker creates at most one checklist comment');
  const transitions = readPrReviewRepairLedger({ directory }).transitions;
  assert.equal(transitions.filter(({ transition }) => transition === 'CLAIMED').length, 1);
});

test('R1 merge gate consumes unresolved P1 and refuses an incomplete collector window', async () => {
  const adapter = createGitGhPrReviewThreadEffects({ run: async () => graph() });
  const complete = await adapter.collectReviewThreads({
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: AT,
    run: { runId: 'review-44', laneGeneration: 1 },
  });
  const blocked = derivePrReviewThreadMergeGate(complete);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.blocksMerge, true);
  assert.deepEqual(blocked.blockingThreadIds, ['PRRT_thread_44']);

  const unknown = derivePrReviewThreadMergeGate({ ...complete, complete: false });
  assert.equal(unknown.state, 'UNKNOWN');
  assert.equal(unknown.blocksMerge, true, 'an incomplete read never reports merge readiness');
});

test('R1 DuckDB synchronization persists all seven lifecycle transitions transactionally', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaia-pr-review-duckdb-'));
  let head = EMPTY_PR_REVIEW_REPAIR_LEDGER_REVISION;
  const lifecycle = ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED', 'RESOLVED'];
  for (const [index, transition] of lifecycle.entries()) {
    const result = appendPrReviewRepairTransition({
      directory,
      expectedLedgerRevision: head,
      transition: {
        transition, threadIdentity: 'b'.repeat(64), intent: 'NONE', owner: 'c'.repeat(32),
        leaseExpiresAt: transition === 'CLAIMED' ? '2026-08-31T14:02:00.000Z' : null,
        repository: 'GuitarAlchemist/gaia', pullRequest: 44,
        reviewThreadId: 'PRRT_thread_44', reviewedHeadOid: OID, currentHeadOid: OID,
        reviewState: 'COMMENTED', severity: 'P1', actionableCommentIds: ['PRRC_comment_44'],
        repairHeadOid: index < 3 ? null : 'd'.repeat(40),
        recordedAt: new Date(Date.parse(AT) + index * 1000).toISOString(),
        comment: transition === 'COMMENTED'
          ? { id: 'PRRC_reply_44', url: 'https://github.com/x/y/pull/44#discussion_r1' }
          : null,
        refusal: null, revision: 'ignored',
      },
    });
    head = result.ledger.revision;
  }
  const calls = [];
  const openClient = async () => ({
    async run(sql, params = []) { calls.push({ sql, params }); },
    close() {},
  });

  const result = await synchronizePrReviewThreadDuckDb({
    directory, databasePath: join(directory, 'telemetry.duckdb'), openClient,
  });

  assert.equal(result.rowCount, 7);
  assert.equal(calls.filter(({ sql }) => sql === PR_REVIEW_THREAD_DUCKDB_STATEMENTS.insertRow).length, 7);
  assert.equal(calls[0].sql, PR_REVIEW_THREAD_DUCKDB_STATEMENTS.createRows);
  assert.ok(calls.some(({ sql }) => sql === PR_REVIEW_THREAD_DUCKDB_STATEMENTS.begin));
  assert.ok(calls.some(({ sql }) => sql === PR_REVIEW_THREAD_DUCKDB_STATEMENTS.commit));
});

test('R1 exact resolved thread is the only resolution effect target', async () => {
  const calls = [];
  const adapter = createGitGhPrReviewThreadEffects({
    run: async (args) => {
      calls.push(args);
      return { data: { resolveReviewThread: { thread: { id: 'PRRT_thread_44', isResolved: true } } } };
    },
  });
  const result = await adapter.resolveReviewThread({
    repository: 'GuitarAlchemist/gaia', pullRequest: 44,
    reviewThreadId: 'PRRT_thread_44', threadIdentity: 'b'.repeat(64),
    idempotencyKey: 'e'.repeat(64),
  });
  assert.deepEqual(result, { isResolved: true });
  assert.ok(calls[0].includes('PRRT_thread_44'));
});
