/** Forced R6 gate: observer time may advance without changing durable operation facts. */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGitGhPrReviewThreadEffects } from '../src/git-gh-pr-review-thread-effects.mjs';
import { runPrReviewThreadSupervisorTick } from '../src/pr-review-thread-supervisor.mjs';

const AT = '2026-08-31T23:00:00.000Z';
const HEAD = 'a'.repeat(40);

const graph = {
  data: { repository: { pullRequest: {
    number: 44, baseRefName: 'main', headRefOid: HEAD,
    reviewThreads: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        id: 'PRRT_R6', path: 'src/pump.mjs', line: 9,
        isResolved: false, isOutdated: false,
        comments: {
          totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: 'PRRC_R6', body: 'P1: observer clock must not wedge resumption.',
            review: {
              id: 'PRR_R6', state: 'COMMENTED', submittedAt: AT, commit: { oid: HEAD },
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

test('R6 real recollection resumes late lane and checklist grants across advancing observedAt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaia-r6-observer-clock-'));
  const provider = createGitGhPrReviewThreadEffects({
    readDisputeEvidence: async () => false,
    run: async (args) => String(args.find((value) => value.startsWith('query=')) ?? '')
      .includes('GaiaReviewThreadDisputes') ? disputes : graph,
  });
  const revisions = []; const instants = [];
  let checklist = null; let lane = null;
  const effects = { lanes: 0, checklists: 0 };
  const github = {
    ...provider,
    async collectReviewThreads(request) {
      const collection = await provider.collectReviewThreads(request);
      revisions.push(collection.sourceRevision);
      instants.push(collection.observations[0].observedAt);
      return collection;
    },
    async readRepairEvidence({ observation }) { return observation; },
    async findChecklist() { return checklist; },
    async createChecklist({ marker, body }) {
      effects.checklists += 1; checklist = { id: 'checklist-r6', marker, body }; return checklist;
    },
    async updateChecklist() { throw new Error('unexpected checklist update'); },
  };
  const lanes = {
    async findRepairLane() { return lane; },
    async startRepairLane({ idempotencyKey }) {
      effects.lanes += 1;
      lane = { id: 'lane-r6', idempotencyKey, status: 'running' };
      return lane;
    },
  };
  const granted = new Set();
  const acquireGrant = async (intent) => {
    if (!granted.has(intent.action)) {
      const error = new Error('grant pending'); error.code = 'WaitingAuthority'; throw error;
    }
    return { action: intent.action, intentRevision: intent.intentRevision };
  };
  const authority = { async consume({ grant, intent }) {
    assert.equal(grant.intentRevision, intent.intentRevision);
    return { status: 'AUTHORIZED', grantId: `grant-${intent.action}` };
  } };
  let tickNumber = 0;
  const tick = () => {
    const tickAt = new Date(Date.parse(AT) + tickNumber * 1_000); tickNumber += 1;
    return runPrReviewThreadSupervisorTick({
      directory, repository: 'GuitarAlchemist/gaia', pullRequest: 44,
      github, lanes, authority, acquireGrant,
      synchronizeTelemetry: async () => ({ schema: 'sync', rowCount: 0 }),
      now: () => tickAt, run: { runId: 'review-r6', laneGeneration: 1 },
    });
  };

  await tick();
  granted.add('CLAIM_REVIEW_THREAD');
  await tick();
  granted.add('UPSERT_REVIEW_THREAD_CHECKLIST');
  await tick();
  await tick();

  assert.equal(new Set(revisions).size, 1, 'identical GitHub facts retain one source revision');
  assert.equal(new Set(instants).size, 4, 'only the observer instant advances');
  assert.equal(effects.lanes, 1);
  assert.equal(effects.checklists, 1);
});
