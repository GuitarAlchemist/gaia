/** Forced R8 gate: an advancing observer clock cannot corrupt checklist adoption. */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGitGhPrReviewThreadEffects } from '../src/git-gh-pr-review-thread-effects.mjs';
import { runPrReviewThreadSupervisorTick } from '../src/pr-review-thread-supervisor.mjs';

const AT = '2026-09-01T02:00:00.000Z';
const HEAD = 'a'.repeat(40);

const graph = {
  data: { repository: { pullRequest: {
    number: 44, baseRefName: 'main', headRefOid: HEAD,
    reviewThreads: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        id: 'PRRT_R8', path: 'src/pump.mjs', line: 9,
        isResolved: false, isOutdated: false,
        comments: {
          totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: 'PRRC_R8', body: 'P1: checklist adoption must bind the durable intent.',
            review: {
              id: 'PRR_R8', state: 'COMMENTED', submittedAt: AT, commit: { oid: HEAD },
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

function collector() {
  return createGitGhPrReviewThreadEffects({
    readDisputeEvidence: async () => false,
    run: async (args) => String(args.find((value) => value.startsWith('query=')) ?? '')
      .includes('GaiaReviewThreadDisputes') ? disputes : graph,
  });
}

async function exerciseLostChecklistResponse(supervisor, { expectCorruption = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gaia-r8-checklist-'));
  const source = collector(); let checklist = null; let creates = 0;
  let phase = 'CREATE'; let adoptionReads = 0;
  const github = {
    ...source,
    async readRepairEvidence({ observation }) { return observation; },
    async findChecklist() {
      if (phase === 'ADOPT') {
        adoptionReads += 1;
        return adoptionReads === 1 ? checklist : null;
      }
      return checklist;
    },
    async createChecklist({ marker, body }) {
      creates += 1; checklist = { id: 'checklist-r8', marker, body };
      throw new Error('provider response lost after durable checklist success');
    },
    async updateChecklist() { throw new Error('exact adoption must not update or duplicate'); },
  };
  let lane = null;
  const lanes = {
    async findRepairLane() { return lane; },
    async startRepairLane({ idempotencyKey }) {
      lane = { id: 'lane-r8', idempotencyKey, status: 'running' }; return lane;
    },
  };
  let tickNumber = 0;
  const tick = () => supervisor({
    directory, repository: 'GuitarAlchemist/gaia', pullRequest: 44,
    github, lanes,
    authority: { async consume() { return { status: 'AUTHORIZED' }; } },
    grant: null, synchronizeTelemetry: async () => ({ rowCount: 0 }),
    now: () => new Date(Date.parse(AT) + tickNumber++ * 1_000),
    run: { runId: 'review-r8', laneGeneration: 1 },
  });

  await assert.rejects(tick(), { code: 'ChecklistFailed' });
  phase = 'ADOPT';
  await tick();
  phase = 'STEADY';
  if (expectCorruption) await assert.rejects(tick(), { code: 'OperationReceiptCorrupt' });
  else await tick();
  assert.equal(creates, 1, 'restart adopts exactly one provider checklist');
}

test('R8 advancing-clock lost checklist response adopts one exact durable receipt across restart', async () => {
  await exerciseLostChecklistResponse(runPrReviewThreadSupervisorTick);
});

test('R8 MECHANISM REVERT: fresh-tick checklist settlement corrupts the next reconciliation', async () => {
  const sourcePath = new URL('../src/pr-review-thread-supervisor.mjs', import.meta.url);
  const mutantPath = new URL('../src/.r8-checklist-bind-mutant.mjs', import.meta.url);
  const source = readFileSync(sourcePath, 'utf8');
  const mutant = source.replace(
    'if (found.body === body) return settle(path, operationIntent, found);',
    'if (found.body === body) return settle(path, intent, found);',
  );
  assert.notEqual(mutant, source);
  writeFileSync(mutantPath, mutant);
  try {
    const module = await import(`${mutantPath.href}?r8=checklist-binding`);
    await exerciseLostChecklistResponse(module.runPrReviewThreadSupervisorTick, {
      expectCorruption: true,
    });
  } finally {
    rmSync(mutantPath, { force: true });
  }
});
