/**
 * Production R1 gates for the review-thread pump. These tests exercise only public seams: the
 * GitHub collector/effect Adapter, the supervisor tick, the merge gate and the DuckDB projection.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
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
import { readFactoryTelemetryLog } from '../src/factory-telemetry-log.mjs';
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
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
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
      const adapter = createGitGhPrReviewThreadEffects({
        run: async () => graph(), readDisputeEvidence: async () => false,
      });
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
      const receipt = {
        id: 'IC_checklist_44', url: 'https://github.com/x/y/issues/44#issuecomment-1',
        body: request.body,
      };
      checklists.set(request.marker, receipt);
      return receipt;
    },
    async updateChecklist(request) {
      const updated = { ...checklists.get(request.marker), body: request.body };
      checklists.set(request.marker, updated);
      return updated;
    },
    async readRepairEvidence({ observation }) { return observation; },
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

test('R1 concurrent ticks never duplicate a lane start while the first provider call is open', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaia-pr-review-production-race-'));
  const github = supervisorGithub();
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  let starts = 0;
  const receipt = { id: 'lane-held', idempotencyKey: null };
  const lanes = {
    async findRepairLane() { return null; },
    async startRepairLane(request) {
      starts += 1;
      receipt.idempotencyKey = request.idempotencyKey;
      entered();
      await hold;
      return receipt;
    },
  };
  const tick = () => runPrReviewThreadSupervisorTick({
    directory, repository: 'GuitarAlchemist/gaia', pullRequest: 44,
    github, lanes, authority: { consume: async () => ({ status: 'AUTHORIZED' }) },
    grant: null, now: () => new Date(AT), synchronizeTelemetry: async () => ({ rowCount: 3 }),
  });

  const first = tick();
  await started;
  const second = await tick();
  assert.equal(second.results[0].lane.state, 'PENDING');
  assert.equal(starts, 1);
  release();
  await first;
  assert.equal(starts, 1, 'the durable intent is the unique lane-start linearization point');
});

test('R2 concurrent checklist upserts linearize on one durable intent before one provider effect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaia-pr-review-checklist-race-'));
  const base = supervisorGithub();
  const comments = new Map();
  let creates = 0;
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const github = {
    ...base,
    async findChecklist({ marker }) { return comments.get(marker) ?? null; },
    async createChecklist(request) {
      creates += 1;
      assert.ok(
        readdirSync(join(directory, 'pr-review-thread-operations'))
          .some((name) => name.endsWith('.intent.json')),
        'the durable intent exists before the provider effect begins',
      );
      const receipt = { id: 'IC_race', url: 'https://github.test/comment/1', body: request.body };
      comments.set(request.marker, receipt);
      entered();
      await hold;
      return receipt;
    },
    async updateChecklist() { throw new Error('an identical body must be adopted, not patched'); },
  };
  const lanes = concurrentLanePort();
  const tick = () => runPrReviewThreadSupervisorTick({
    directory, repository: 'GuitarAlchemist/gaia', pullRequest: 44,
    github, lanes, authority: { consume: async () => ({ status: 'AUTHORIZED' }) },
    grant: null, now: () => new Date(AT), synchronizeTelemetry: async () => ({ rowCount: 3 }),
  });

  const winner = tick();
  await started;
  const loser = await tick();
  assert.equal(loser.results[0].lane.id.startsWith('lane-'), true);
  assert.equal(creates, 1);
  release();
  await winner;
  assert.equal(creates, 1, 'two actors at one revision produce one checklist effect');
});

test('R2 a lost checklist response is reconciled from the marker after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaia-pr-review-checklist-lost-'));
  const base = supervisorGithub();
  const comments = new Map();
  let creates = 0;
  let loseResponse = true;
  const github = {
    ...base,
    async findChecklist({ marker }) { return comments.get(marker) ?? null; },
    async createChecklist(request) {
      creates += 1;
      const receipt = { id: 'IC_lost', url: 'https://github.test/comment/lost', body: request.body };
      comments.set(request.marker, receipt);
      if (loseResponse) throw new Error('provider response lost after success');
      return receipt;
    },
    async updateChecklist() { throw new Error('reconciliation must not retry another effect'); },
  };
  const lanes = concurrentLanePort();
  const tick = () => runPrReviewThreadSupervisorTick({
    directory, repository: 'GuitarAlchemist/gaia', pullRequest: 44,
    github, lanes, authority: { consume: async () => ({ status: 'AUTHORIZED' }) },
    grant: null, now: () => new Date(AT), synchronizeTelemetry: async () => ({ rowCount: 3 }),
  });

  await assert.rejects(tick(), { code: 'ChecklistFailed' });
  loseResponse = false;
  await tick();
  assert.equal(creates, 1, 'a fresh supervisor adopts the provider marker without recreating');
});

test('R2 production reconciliation reaches verified exact-thread resolution from measured evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaia-pr-review-production-resolve-'));
  const base = supervisorGithub();
  const replies = [];
  let resolved = false;
  const github = {
    ...base,
    async readRepairEvidence({ observation, laneReceipt }) {
      return {
        ...observation,
        applicability: {
          anchorDigestAtReview: '1'.repeat(64), anchorDigestAtCurrentHead: '1'.repeat(64),
        },
        repair: {
          headOid: OID, descendsFromReviewedHead: true, touchesAnchorPath: true,
          commitsAheadOfReviewedHead: 1,
          addressedCommentIds: laneReceipt.addressedCommentIds,
        },
        checks: {
          headOid: OID, requiredContexts: ['test'],
          conclusions: [{ context: 'test', conclusion: 'SUCCESS' }],
        },
      };
    },
    async readReviewThread() { return { isResolved: resolved, comments: replies }; },
    async postReviewThreadComment({ threadIdentity }) {
      const receipt = {
        id: 'PRRC_reply', url: 'https://github.com/x/y/pull/44#discussion_r1', marker: threadIdentity,
      };
      replies.push(receipt);
      return receipt;
    },
    async resolveReviewThread({ reviewThreadId }) {
      assert.equal(reviewThreadId, 'PRRT_thread_44');
      resolved = true;
      return { isResolved: true };
    },
  };
  const lanes = {
    async findRepairLane() { return null; },
    async startRepairLane(request) {
      return {
        id: 'lane-verified', idempotencyKey: request.idempotencyKey,
        addressedCommentIds: ['PRRC_comment_44'],
      };
    },
  };
  for (let tick = 0; tick < 4 && !resolved; tick += 1) {
    await runPrReviewThreadSupervisorTick({
      directory, repository: 'GuitarAlchemist/gaia', pullRequest: 44,
      github, lanes, authority: { consume: async () => ({ status: 'AUTHORIZED' }) },
      grant: null, now: () => new Date(AT), synchronizeTelemetry: async () => ({ rowCount: 7 }),
    });
  }
  assert.equal(resolved, true);
  assert.deepEqual(
    ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED', 'RESOLVED']
      .filter((verb) => readPrReviewRepairLedger({ directory }).transitions
        .some(({ transition }) => transition === verb)),
    ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED', 'RESOLVED'],
  );
});

test('R1 merge gate consumes unresolved P1 and refuses an incomplete collector window', async () => {
  const adapter = createGitGhPrReviewThreadEffects({
    run: async () => graph(), readDisputeEvidence: async () => false,
  });
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
  const factory = readFactoryTelemetryLog({ directory });
  assert.equal(factory.events.filter(({ event }) => event === 'gate.passed').length, 7);
  assert.deepEqual(
    factory.events.filter(({ event }) => event === 'gate.passed').map(({ gate }) => gate),
    lifecycle,
    'every PR lifecycle fact reaches the canonical locked factory telemetry log',
  );
  const repeated = await synchronizePrReviewThreadDuckDb({
    directory, databasePath: join(directory, 'telemetry.duckdb'), openClient,
  });
  assert.equal(repeated.mirroredFactoryEvents, 0, 'replay is idempotent at the canonical seam');
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
  assert.ok(calls[0].some((argument) => argument === 'threadId=PRRT_thread_44'));
});
