/** R2 production-closure gates: pagination, epistemic refusal, durable effects and runtime wiring. */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildControlRoomSnapshot } from '../src/control-room.mjs';
import { createGitGhPrReviewThreadEffects } from '../src/git-gh-pr-review-thread-effects.mjs';
import {
  createBoundedRepairLaneEffects,
  derivePrReviewThreadMergeGate,
} from '../src/pr-review-thread-supervisor.mjs';
import { planPrReviewThreadRepair } from '../src/pr-review-thread.mjs';
import {
  createDisputeEvidenceReader,
  runPrReviewThreadSupervisorCli,
} from '../scripts/pr-review-thread-supervisor.mjs';

const OID = 'a'.repeat(40);
const AT = '2026-08-31T15:00:00.000Z';

function graph({ commentTotal = 1 } = {}) {
  return {
    data: { repository: { pullRequest: {
      number: 44, baseRefName: 'main', headRefOid: OID,
      reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          id: 'PRRT_r2', path: 'src/pump.mjs', line: 9,
          isResolved: false, isOutdated: false,
          comments: {
            totalCount: commentTotal,
            pageInfo: { hasNextPage: commentTotal > 1, endCursor: commentTotal > 1 ? 'hidden' : null },
            nodes: [{
              id: 'PRRC_r2', body: 'P1: provider evidence is incomplete.',
              review: {
                id: 'PRR_r2', state: 'COMMENTED', submittedAt: AT, commit: { oid: OID },
              },
            }],
          },
        }],
      },
    } } },
  };
}

const collect = (adapter) => adapter.collectReviewThreads({
  repository: 'GuitarAlchemist/gaia', pullRequest: 44, observedAt: AT,
  run: { runId: 'review-r2', laneGeneration: 1 },
});

test('R2 a hidden 101st review comment fails closed when its nested page cannot be proven', async () => {
  const adapter = createGitGhPrReviewThreadEffects({ run: async () => graph({ commentTotal: 101 }) });
  await assert.rejects(collect(adapter), (error) => error.code === 'NestedPaginationIdentityMismatch');
});

test('R2 absent GitHub dispute evidence is UNKNOWN and can never reach a claim or resolution', async () => {
  const adapter = createGitGhPrReviewThreadEffects({ run: async () => graph() });
  const collection = await collect(adapter);
  const [observation] = collection.observations;
  assert.equal(observation.reviewThread.disputed, 'UNKNOWN');
  const reading = planPrReviewThreadRepair({ observation, history: [] });
  assert.equal(reading.action, 'REFUSE');
  assert.equal(reading.refusal, 'THREAD_DISPUTE_UNKNOWN');
  assert.equal(reading.blocksMerge, true);
});

test('R2 a fresh lane Adapter adopts durable factory evidence after process memory is lost', async () => {
  const durable = new Map();
  let executions = 0;
  const execution = {
    async execute({ idempotencyKey }) {
      executions += 1;
      const result = { status: 'completed', changeSet: { identity: 'c'.repeat(64) } };
      durable.set(idempotencyKey, result);
      return result;
    },
    async findReceipt({ idempotencyKey }) { return durable.get(idempotencyKey) ?? null; },
  };
  const request = {
    threadIdentity: 'b'.repeat(64), idempotencyKey: 'd'.repeat(64),
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, reviewThreadId: 'PRRT_r2',
    reviewedHeadOid: OID, anchorPath: 'src/pump.mjs', actionableCommentIds: ['PRRC_r2'],
  };
  await createBoundedRepairLaneEffects({ execution }).startRepairLane(request);
  const restarted = createBoundedRepairLaneEffects({ execution });
  const adopted = await restarted.findRepairLane(request);
  assert.equal(adopted.changeSetIdentity, 'c'.repeat(64));
  assert.equal(executions, 1);
});

test('R2 the GitHub Adapter exposes a bounded repair-and-check evidence reconciliation seam', () => {
  const adapter = createGitGhPrReviewThreadEffects({ run: async () => graph() });
  assert.equal(typeof adapter.readRepairEvidence, 'function');
});

test('R2 the control room seals and consumes the review-thread merge gate', () => {
  const moduleUrl = new URL('../src/pr-review-thread-supervisor.mjs', import.meta.url);
  assert.ok(moduleUrl);
  const source = buildControlRoomSnapshot.toString();
  assert.match(source, /prReviewThreadGate/u);
  assert.match(source, /blocksMerge/u);
});

test('R2 one production CLI entry composes the bounded tick', () => {
  assert.equal(existsSync(new URL('../scripts/pr-review-thread-supervisor.mjs', import.meta.url)), true);
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-r2-runtime-'));
  assert.ok(scratch);
});

test('R2 dispute evidence is exact-source-bound and future or corrupt evidence stays UNKNOWN', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-r2-dispute-'));
  const path = join(scratch, 'dispute.json');
  const request = {
    repository: 'GuitarAlchemist/gaia', pullRequest: 44, reviewThreadId: 'PRRT_r2',
    observedAt: AT, sourceRevision: 'd'.repeat(64),
  };
  const artifact = {
    schema: 'gaia-pr-review-thread-dispute-evidence/1', ...request, disputed: false,
  };
  writeFileSync(path, JSON.stringify(artifact));
  const read = createDisputeEvidenceReader(path);
  assert.equal(await read(request), false);
  writeFileSync(path, JSON.stringify({ ...artifact, observedAt: '2026-08-31T15:00:00.001Z' }));
  assert.equal(await read(request), 'UNKNOWN', 'future evidence cannot authorize resolution');
  writeFileSync(path, JSON.stringify({ ...artifact, sourceRevision: 'e'.repeat(64) }));
  assert.equal(await read(request), 'UNKNOWN', 'foreign evidence cannot authorize resolution');
});

test('R2 CLI passes the real state directory into the optional DuckDB synchronization path', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-r2-cli-'));
  const grant = join(scratch, 'grant.json');
  const publicKey = join(scratch, 'public.pem');
  const gateOut = join(scratch, 'gate.json');
  writeFileSync(grant, '{}');
  writeFileSync(publicKey, 'unused by injected authority');
  let synchronized = null;
  const code = await runPrReviewThreadSupervisorCli([
    '--repository', 'GuitarAlchemist/gaia', '--pull-request', '44',
    '--state-dir', scratch, '--worktree', scratch, '--evidence-root', scratch,
    '--database', join(scratch, 'telemetry.duckdb'), '--public-key', publicKey,
    '--authority-ledger', scratch, '--grant', grant, '--gate-out', gateOut,
  ], {
    createGithub: () => ({
      async collectReviewThreads() {
        return {
          schema: 'gaia-pr-review-thread-collection/1', complete: true,
          sourceRevision: 'f'.repeat(64), observations: [],
        };
      },
      async findChecklist() {}, async createChecklist() {}, async updateChecklist() {},
      async readRepairEvidence() {},
    }),
    createExecution: () => ({ async execute() {}, async findReceipt() {} }),
    createAuthority: () => ({ async consume() {} }),
    synchronize: async (request) => {
      synchronized = request;
      return { schema: 'gaia-pr-review-thread-duckdb-sync/1', rowCount: 0 };
    },
    now: () => new Date(AT), writeStdout: () => {},
  });
  assert.equal(code, 0);
  assert.equal(synchronized.directory, scratch);
  assert.equal(synchronized.telemetryDirectory, scratch);
  assert.equal(synchronized.databasePath, join(scratch, 'telemetry.duckdb'));
  assert.equal(existsSync(gateOut), true);
});
