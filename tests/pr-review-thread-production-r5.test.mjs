/** Forced R5 gates for stable provider windows and resumable late-authority operations. */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGitGhPrReviewThreadEffects } from '../src/git-gh-pr-review-thread-effects.mjs';
import { runPrReviewThreadSupervisorTick } from '../src/pr-review-thread-supervisor.mjs';

const AT = '2026-08-31T22:00:00.000Z';
const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);

const queryOf = (args) => String(args.find((entry) => entry.startsWith('query=')) ?? '');
const review = (id, state = 'APPROVED', head = MOVED) => ({
  id, state, submittedAt: AT, commit: { oid: head },
});
const reply = (index) => ({
  id: `AA_REPLY_${String(index).padStart(3, '0')}`,
  body: 'supporting reply', review: review(`PRR_REPLY_${index}`),
});
const root = {
  id: 'ZZ_ROOT', body: 'P1: originating review blocker.',
  review: review('PRR_ROOT', 'COMMENTED', HEAD),
};

function outerGraph({ head = HEAD } = {}) {
  return { data: { repository: { pullRequest: {
    id: 'PR_44', number: 44, baseRefName: 'main', headRefOid: head,
    reviewThreads: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        id: 'PRRT_R5', path: 'src/pump.mjs', line: 9,
        isResolved: false, isOutdated: false,
        comments: {
          totalCount: 101, pageInfo: { hasNextPage: true, endCursor: 'nested-100' },
          nodes: [root, ...Array.from({ length: 99 }, (_, index) => reply(index))],
        },
      }],
    },
  } } } };
}

const nestedGraph = {
  data: {
    repository: { pullRequest: { id: 'PR_44', number: 44, headRefOid: HEAD } },
    node: {
      id: 'PRRT_R5',
      comments: {
        totalCount: 101, pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [reply(99)],
      },
    },
  },
};

const disputeGraph = { data: { repository: { pullRequest: { comments: {
  totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [],
} } } } };

test('R5 a head move after nested pagination typed-refuses the collection before any claim', async () => {
  const calls = [];
  const adapter = createGitGhPrReviewThreadEffects({
    run: async (args) => {
      const query = queryOf(args); calls.push(query);
      if (query.includes('GaiaReviewThreadComments')) return nestedGraph;
      if (query.includes('GaiaReviewThreadDisputes')) return disputeGraph;
      if (query.includes('GaiaReviewThreadHead')) {
        return { data: { repository: { pullRequest: {
          id: 'PR_44', number: 44, headRefOid: MOVED,
        } } } };
      }
      return outerGraph();
    },
  });
  await assert.rejects(adapter.collectReviewThreads({
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: AT,
    run: { runId: 'review-r5-head', laneGeneration: 1 },
  }), (error) => error.code === 'CollectionHeadChanged');
  assert.equal(calls.some((query) => query.includes('GaiaReviewThreadHead')), true);
});

test('R5 nested dedupe preserves the originating review even when a reply id sorts first', async () => {
  const adapter = createGitGhPrReviewThreadEffects({
    run: async (args) => {
      const query = queryOf(args);
      if (query.includes('GaiaReviewThreadComments')) return nestedGraph;
      if (query.includes('GaiaReviewThreadDisputes')) return disputeGraph;
      if (query.includes('GaiaReviewThreadHead')) {
        return { data: { repository: { pullRequest: {
          id: 'PR_44', number: 44, headRefOid: HEAD,
        } } } };
      }
      return outerGraph();
    },
  });
  const collection = await adapter.collectReviewThreads({
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: AT,
    run: { runId: 'review-r5-root', laneGeneration: 1 },
  });
  const observation = collection.observations[0];
  assert.equal(observation.review.id, 'PRR_ROOT');
  assert.equal(observation.review.state, 'COMMENTED');
  assert.equal(observation.review.reviewedHeadOid, HEAD);
  assert.equal(observation.reviewThread.comments[0].id, 'ZZ_ROOT');
});

function actionableObservation() {
  return {
    schema: 'gaia-pr-review-thread-observation/1', observedAt: AT,
    repository: 'GuitarAlchemist/gaia', pullRequest: { number: 44, baseBranch: 'main' },
    review: { id: 'PRR_R5', state: 'COMMENTED', submittedAt: AT, reviewedHeadOid: HEAD },
    reviewThread: {
      id: 'PRRT_R5_LATE', path: 'src/pump.mjs', line: 9,
      isResolved: false, isOutdated: false, disputed: false,
      comments: [{ id: 'PRRC_R5', body: 'P1: resumable late authority.' }],
    },
    currentHeadOid: HEAD,
    applicability: { anchorDigestAtReview: 'UNKNOWN', anchorDigestAtCurrentHead: 'UNKNOWN' },
    repair: null, checks: null,
    run: { runId: 'review-r5-late', laneGeneration: 1 }, sourceRevision: '5'.repeat(64),
  };
}

test('R5 later lane and checklist grants resume their durable intents exactly once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaia-r5-late-authority-'));
  const observation = actionableObservation();
  const granted = new Set(); const requested = [];
  const effects = { laneStarts: 0, checklistCreates: 0 };
  const acquireGrant = async (intent) => {
    requested.push(intent);
    if (!granted.has(intent.action)) {
      const error = new Error('not yet granted'); error.code = 'WaitingAuthority'; throw error;
    }
    return { action: intent.action, intentRevision: intent.intentRevision };
  };
  const authority = { async consume({ grant, intent }) {
    assert.equal(grant.intentRevision, intent.intentRevision);
    return { status: 'AUTHORIZED', grantId: `grant-${intent.action}` };
  } };
  let checklist = null; let lane = null;
  const github = {
    async collectReviewThreads() {
      return {
        schema: 'gaia-pr-review-thread-collection/1', repository: observation.repository,
        pullRequest: 44, observedAt: AT, complete: true,
        sourceRevision: observation.sourceRevision, observations: [observation],
      };
    },
    async readRepairEvidence() { return observation; },
    async readReviewThread() { return { isResolved: false, comments: [] }; },
    async postReviewThreadComment() { throw new Error('not reached'); },
    async resolveReviewThread() { throw new Error('not reached'); },
    async findChecklist() { return checklist; },
    async createChecklist({ marker, body }) {
      effects.checklistCreates += 1; checklist = { id: 'checklist-r5', marker, body }; return checklist;
    },
    async updateChecklist() { throw new Error('unexpected checklist update'); },
  };
  const lanes = {
    async findRepairLane() { return lane; },
    async startRepairLane({ idempotencyKey }) {
      effects.laneStarts += 1;
      lane = { id: 'lane-r5', idempotencyKey, status: 'running' };
      return lane;
    },
  };
  let tickNumber = 0;
  const tick = () => {
    const tickAt = new Date(Date.parse(AT) + tickNumber * 1_000); tickNumber += 1;
    return runPrReviewThreadSupervisorTick({
      directory, repository: observation.repository, pullRequest: 44,
      github, lanes, authority, acquireGrant,
      synchronizeTelemetry: async () => ({ schema: 'sync', rowCount: 0 }),
      now: () => tickAt, run: observation.run,
    });
  };

  await tick();
  assert.equal(effects.laneStarts, 0); assert.equal(effects.checklistCreates, 0);
  assert.ok(requested.some(({ action }) => action === 'CLAIM_REVIEW_THREAD'));
  assert.ok(requested.some(({ action }) => action === 'UPSERT_REVIEW_THREAD_CHECKLIST'));

  granted.add('CLAIM_REVIEW_THREAD');
  await tick();
  assert.equal(effects.laneStarts, 1); assert.equal(effects.checklistCreates, 0);

  granted.add('UPSERT_REVIEW_THREAD_CHECKLIST');
  await tick();
  await tick();
  assert.equal(effects.laneStarts, 1); assert.equal(effects.checklistCreates, 1);
});
