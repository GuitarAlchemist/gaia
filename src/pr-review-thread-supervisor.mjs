/**
 * One production reconciliation tick for actionable GitHub PR review threads.
 *
 * GitHub is re-read every tick. The durable repair ledger owns claims; operation directories own
 * the intent-before-effect linearization for lane starts and checklist creation. An existing
 * intent without an externally reconcilable receipt is uncertain and never blindly retried.
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  estimateRepairEta,
  planPrReviewThreadRepair,
  prReviewThreadIdentity,
  renderRepairChecklist,
} from './pr-review-thread.mjs';
import {
  PrReviewRepairError,
  projectPrReviewRepairLedger,
  readPrReviewRepairLedger,
  runPrReviewThreadRepairPump,
} from './pr-review-thread-repair.mjs';
import { PR_REVIEW_CHECKLIST_MARKER_PREFIX } from './git-gh-pr-review-thread-effects.mjs';

const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class PrReviewThreadSupervisorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrReviewThreadSupervisorError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new PrReviewThreadSupervisorError(code, message); };

function identityOf(observation) {
  return prReviewThreadIdentity({
    repository: observation.repository,
    pullRequestNumber: observation.pullRequest.number,
    reviewThreadId: observation.reviewThread.id,
    reviewedHeadOid: observation.review.reviewedHeadOid,
  });
}

function historyOf(directory, threadIdentity) {
  const seen = new Set(readPrReviewRepairLedger({ directory }).transitions
    .filter((entry) => entry.threadIdentity === threadIdentity)
    .map((entry) => entry.transition));
  return ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED', 'RESOLVED', 'REFUSED']
    .filter((verb) => seen.has(verb));
}

/** The merge/control-room consumer: an incomplete read is a blocker, never readiness. */
export function derivePrReviewThreadMergeGate(collection) {
  if (!collection || collection.schema !== 'gaia-pr-review-thread-collection/1'
      || !Array.isArray(collection.observations)) {
    fail('CollectionInvalid', 'a closed review-thread collection is required');
  }
  if (collection.complete !== true) {
    return Object.freeze({
      schema: 'gaia-pr-review-thread-merge-gate/1', state: 'UNKNOWN', blocksMerge: true,
      blockingThreadIds: [], sourceRevision: collection.sourceRevision ?? 'UNKNOWN',
      reason: 'COLLECTION_INCOMPLETE', effect: 'NONE', authority: 'NONE',
    });
  }
  const blockingThreadIds = collection.observations
    .filter((observation) => planPrReviewThreadRepair({ observation, history: [] }).blocksMerge)
    .map((observation) => observation.reviewThread.id)
    .sort();
  return Object.freeze({
    schema: 'gaia-pr-review-thread-merge-gate/1',
    state: blockingThreadIds.length === 0 ? 'READY' : 'BLOCKED',
    blocksMerge: blockingThreadIds.length > 0,
    blockingThreadIds,
    sourceRevision: collection.sourceRevision,
    reason: blockingThreadIds.length === 0 ? 'NONE' : 'ACTIONABLE_REVIEW_THREAD',
    effect: 'NONE', authority: 'NONE',
  });
}

function operationRoot(directory) {
  const root = join(resolve(directory), 'pr-review-thread-operations');
  mkdirSync(root, { recursive: true });
  return root;
}

function operationPath(directory, kind, threadIdentity) {
  return join(operationRoot(directory), `${kind}-${threadIdentity}`);
}

function receiptPath(path) { return join(path, 'receipt.json'); }

function readReceipt(path) {
  if (!existsSync(receiptPath(path))) return null;
  return JSON.parse(readFileSync(receiptPath(path), 'utf8'));
}

function reserve(path) {
  try {
    mkdirSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

function settle(path, receipt) {
  if (!receipt || typeof receipt !== 'object') fail('ProviderResultInvalid', 'effect returned no receipt');
  const target = receiptPath(path);
  if (!existsSync(target)) writeFileSync(target, `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
  return readReceipt(path);
}

async function ensureLane({ directory, lanes, observation, threadIdentity }) {
  const idempotencyKey = sha256({ kind: 'lane', threadIdentity });
  const path = operationPath(directory, 'lane', threadIdentity);
  const durable = readReceipt(path);
  if (durable) return durable;
  const found = await lanes.findRepairLane({ threadIdentity, idempotencyKey });
  if (found) {
    if (!existsSync(path)) reserve(path);
    return settle(path, found);
  }
  if (!reserve(path)) {
    const reconciled = await lanes.findRepairLane({ threadIdentity, idempotencyKey });
    if (reconciled) return settle(path, reconciled);
    // A concurrent owner may still be inside the provider call. The durable intent is already
    // the linearization point, so this observer performs no effect and reports pending rather
    // than either failing the whole tick or issuing a second start.
    return Object.freeze({ state: 'PENDING', idempotencyKey });
  }
  try {
    return settle(path, await lanes.startRepairLane({
      threadIdentity,
      idempotencyKey,
      repository: observation.repository,
      pullRequest: observation.pullRequest.number,
      reviewThreadId: observation.reviewThread.id,
      reviewedHeadOid: observation.review.reviewedHeadOid,
      anchorPath: observation.reviewThread.path,
      actionableCommentIds: planPrReviewThreadRepair({ observation, history: [] }).actionableCommentIds,
    }));
  } catch {
    // The request may have arrived. Preserve the durable intent; the next tick reconciles first.
    fail('LaneStartFailed', 'lane start failed after durable intent; reconciliation is required');
  }
}

async function ensureChecklist({ directory, github, observation, threadIdentity, body }) {
  const marker = `${PR_REVIEW_CHECKLIST_MARKER_PREFIX}${threadIdentity}`;
  const path = operationPath(directory, 'checklist', threadIdentity);
  const found = await github.findChecklist({
    repository: observation.repository, pullRequest: observation.pullRequest.number, marker,
  });
  if (found) {
    if (!existsSync(path)) reserve(path);
    const updated = await github.updateChecklist({
      repository: observation.repository, pullRequest: observation.pullRequest.number,
      commentId: found.id, marker, body,
    });
    return settle(path, updated ?? found);
  }
  if (!reserve(path)) {
    // Another supervisor owns the durable intent. It may still be inside the provider call; this
    // tick performs no effect and the next reconciliation will either adopt the marker or report
    // the still-uncertain intent. Waiting or blindly retrying here would create the race.
    return Object.freeze({ state: 'PENDING', marker });
  }
  try {
    return settle(path, await github.createChecklist({
      repository: observation.repository, pullRequest: observation.pullRequest.number, marker, body,
    }));
  } catch {
    fail('ChecklistFailed', 'checklist creation failed after durable intent; reconciliation is required');
  }
}

/**
 * Compose the existing bounded factory execution port into an actual lane-start effect.
 * The execution Adapter owns its own content-addressed evidence reservation as a second guard.
 */
export function createBoundedRepairLaneEffects({ execution }) {
  if (!execution || typeof execution.execute !== 'function') fail('InvalidAdapter', 'execution port required');
  const receipts = new Map();
  return Object.freeze({
    async findRepairLane({ idempotencyKey }) { return receipts.get(idempotencyKey) ?? null; },
    async startRepairLane(request) {
      const task = [
        `Repair review thread ${request.reviewThreadId} on ${request.repository}#${request.pullRequest}.`,
        `Reviewed head: ${request.reviewedHeadOid}.`,
        `Anchor path: ${request.anchorPath}.`,
        `Address exactly comment ids: ${request.actionableCommentIds.join(',')}.`,
      ].join(' ');
      const result = await execution.execute({
        intent: { action: 'RUN_FACTORY_AGENT', repository: request.repository, task },
        idempotencyKey: request.idempotencyKey,
      });
      const receipt = Object.freeze({
        id: request.threadIdentity, idempotencyKey: request.idempotencyKey,
        status: result.status, changeSetIdentity: result.changeSet?.identity ?? null,
      });
      receipts.set(request.idempotencyKey, receipt);
      return receipt;
    },
  });
}

/** Re-read GitHub, reconcile every exact identity, perform bounded effects, sync analytics. */
export async function runPrReviewThreadSupervisorTick({
  directory, repository, pullRequest, github, lanes, authority, grant,
  synchronizeTelemetry, now = () => new Date(), run = { runId: `review-${pullRequest}`, laneGeneration: 1 },
}) {
  if (!github || typeof github.collectReviewThreads !== 'function'
      || typeof github.findChecklist !== 'function' || typeof github.createChecklist !== 'function'
      || typeof github.updateChecklist !== 'function'
      || !lanes || typeof lanes.findRepairLane !== 'function'
      || typeof lanes.startRepairLane !== 'function'
      || typeof synchronizeTelemetry !== 'function') {
    fail('InvalidAdapter', 'GitHub, lane and telemetry ports are required');
  }
  const observedAt = now().toISOString();
  const collection = await github.collectReviewThreads({
    repository, pullRequest, observedAt, run,
  });
  const gate = derivePrReviewThreadMergeGate(collection);
  const results = [];
  for (const observation of collection.observations) {
    const threadIdentity = identityOf(observation);
    let result = null;
    try {
      result = await runPrReviewThreadRepairPump({
        directory, observation, grant, authority, effects: github, now,
      });
    } catch (error) {
      if (!(error instanceof PrReviewRepairError)
          || !['RepairRaceLost', 'RepairInFlight'].includes(error.code)) throw error;
    }
    const history = historyOf(directory, threadIdentity);
    if (history.includes('CLAIMED') && !history.includes('REFUSED') && !history.includes('RESOLVED')) {
      const lane = await ensureLane({ directory, lanes, observation, threadIdentity });
      const plan = planPrReviewThreadRepair({ observation, history });
      const peers = projectPrReviewRepairLedger({ directory }).projection.lanes
        .filter((candidate) => candidate.threadIdentity !== threadIdentity);
      const checklist = renderRepairChecklist({
        reading: plan, observation, eta: estimateRepairEta(peers), history,
      }) + `\n\n${PR_REVIEW_CHECKLIST_MARKER_PREFIX}${threadIdentity}`;
      await ensureChecklist({ directory, github, observation, threadIdentity, body: checklist });
      results.push({ threadIdentity, result, lane });
    } else {
      results.push({ threadIdentity, result, lane: null });
    }
  }
  const telemetry = await synchronizeTelemetry({ directory });
  return Object.freeze({
    schema: 'gaia-pr-review-thread-supervisor-tick/1', observedAt,
    collectionRevision: collection.sourceRevision, gate, results, telemetry,
    effect: 'BOUNDED_REPAIR_ORCHESTRATION', authority: 'EXISTING_PORTS_ONLY',
  });
}
