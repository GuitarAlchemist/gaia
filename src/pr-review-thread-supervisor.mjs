/**
 * One production reconciliation tick for actionable GitHub PR review threads.
 *
 * GitHub is re-read every tick. The durable repair ledger owns claims; operation directories own
 * the intent-before-effect linearization for lane starts and checklist creation. An existing
 * intent without an externally reconcilable receipt is uncertain and never blindly retried.
 */

import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync,
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
  return join(operationRoot(directory), sha256({ kind, threadIdentity }));
}

function intentPath(path) { return `${path}.intent.json`; }
function receiptPath(path) { return `${path}.receipt.json`; }

function readReceipt(path, intent) {
  if (!existsSync(receiptPath(path))) return null;
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath(path), 'utf8')); } catch {
    fail('OperationReceiptCorrupt', 'operation receipt is not JSON');
  }
  const keys = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    ? Object.keys(receipt).sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify([
    'expectedRevision', 'idempotencyKey', 'intentDigest', 'operationIdentity', 'result', 'schema',
  ])
      || receipt.schema !== 'gaia-pr-review-thread-operation-receipt/2'
      || receipt.operationIdentity !== intent.operationIdentity
      || receipt.idempotencyKey !== intent.idempotencyKey
      || receipt.intentDigest !== sha256(intent)
      || receipt.expectedRevision !== intent.expectedRevision) {
    fail('OperationReceiptCorrupt', 'operation receipt does not bind its exact intent and revision');
  }
  return receipt.result;
}

function readIntent(path) {
  if (!existsSync(intentPath(path))) return null;
  return JSON.parse(readFileSync(intentPath(path), 'utf8'));
}

function resumeIntent(path, candidate) {
  const existing = readIntent(path);
  if (existing === null) return null;
  const rebound = { ...candidate, observedAt: existing.observedAt, expiresAt: existing.expiresAt };
  if (candidate.kind === 'LANE_START' && candidate.request && existing.request) {
    rebound.request = { ...candidate.request, observedAt: existing.request.observedAt };
  }
  if (JSON.stringify(existing) !== JSON.stringify(rebound)) {
    fail('OperationIntentCorrupt', 'operation intent does not bind its exact stable identity');
  }
  return existing;
}

function reserve(path, intent) {
  let descriptor;
  try {
    descriptor = openSync(intentPath(path), 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(intent)}\n`, 'utf8');
    fsyncSync(descriptor);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function settle(path, intent, result) {
  if (!result || typeof result !== 'object') fail('ProviderResultInvalid', 'effect returned no receipt');
  const target = receiptPath(path);
  if (!existsSync(target)) {
    const descriptor = openSync(target, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify({
        schema: 'gaia-pr-review-thread-operation-receipt/2',
        operationIdentity: intent.operationIdentity,
        idempotencyKey: intent.idempotencyKey,
        intentDigest: sha256(intent),
        expectedRevision: intent.expectedRevision,
        result,
      })}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  return readReceipt(path, intent);
}

function authorityIntent({ action, observation, intentRevision }) {
  return Object.freeze({
    intentRevision, action, repository: observation.repository,
    itemKind: 'PULL_REQUEST', itemId: `pull-request-${observation.pullRequest.number}`,
    itemNumber: observation.pullRequest.number, snapshotRevision: observation.sourceRevision,
  });
}

async function authorize({ authority, acquireGrant, intent }) {
  const grant = await acquireGrant(intent);
  const result = await authority.consume({ grant, intent });
  if (result?.status !== 'AUTHORIZED') {
    fail('AuthorityRefused', 'authority did not authorize the exact operation intent');
  }
  return result;
}

async function ensureLane({
  directory, lanes, observation, threadIdentity, observedAt, authority, acquireGrant,
}) {
  const idempotencyKey = sha256({ kind: 'lane', threadIdentity });
  const path = operationPath(directory, 'lane', threadIdentity);
  const request = {
    threadIdentity,
    idempotencyKey,
    repository: observation.repository,
    pullRequest: observation.pullRequest.number,
    reviewThreadId: observation.reviewThread.id,
    reviewedHeadOid: observation.review.reviewedHeadOid,
    anchorPath: observation.reviewThread.path,
    actionableCommentIds: planPrReviewThreadRepair({ observation, history: [] }).actionableCommentIds,
    sourceRevision: observation.sourceRevision,
    observedAt: observation.observedAt,
  };
  const intent = {
    schema: 'gaia-pr-review-thread-operation-intent/1',
    operationIdentity: sha256({ kind: 'lane', threadIdentity }), kind: 'LANE_START',
    threadIdentity, idempotencyKey, expectedRevision: observation.sourceRevision, request,
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 120_000).toISOString(),
  };
  let operationIntent = resumeIntent(path, intent);
  const durable = operationIntent === null ? null : readReceipt(path, operationIntent);
  if (durable) return durable;
  const found = await lanes.findRepairLane(request);
  if (found) {
    if (operationIntent === null) {
      if (reserve(path, intent)) operationIntent = intent;
      else operationIntent = resumeIntent(path, intent);
    }
    return settle(path, operationIntent, found);
  }
  if (operationIntent === null) {
    if (reserve(path, intent)) operationIntent = intent;
    else operationIntent = resumeIntent(path, intent);
  } else {
    const reconciled = await lanes.findRepairLane(request);
    if (reconciled) return settle(path, operationIntent, reconciled);
    if (Date.parse(observedAt) >= Date.parse(operationIntent.expiresAt)) {
      fail('LaneStartUncertain', 'lane start remains ambiguous after its bounded lease');
    }
    // A prior tick may have stopped only because its exact grant was not present. Re-enter the
    // same authorization/effect path with the same operation identity. The single-use authority
    // consumption admits one actor; every actor reconciles the provider before reaching it.
  }
  try {
    await authorize({
      authority, acquireGrant,
      intent: authorityIntent({
        action: 'CLAIM_REVIEW_THREAD', observation,
        intentRevision: operationIntent.operationIdentity,
      }),
    });
  } catch (error) {
    if (error?.code === 'WaitingAuthority') {
      return Object.freeze({ state: 'WAITING_AUTHORITY', idempotencyKey });
    }
    throw error;
  }
  try {
    return settle(path, operationIntent, await lanes.startRepairLane(request));
  } catch {
    // The request may have arrived. Preserve the durable intent; the next tick reconciles first.
    fail('LaneStartFailed', 'lane start failed after durable intent; reconciliation is required');
  }
}

async function ensureChecklist({
  directory, github, observation, threadIdentity, body, observedAt, authority, acquireGrant,
}) {
  const marker = `${PR_REVIEW_CHECKLIST_MARKER_PREFIX}${threadIdentity}`;
  const bodyDigest = sha256({ body });
  const path = operationPath(directory, `checklist-${bodyDigest}`, threadIdentity);
  const intent = {
    schema: 'gaia-pr-review-thread-operation-intent/1',
    operationIdentity: sha256({ kind: `checklist-${bodyDigest}`, threadIdentity }),
    kind: 'CHECKLIST_UPSERT', threadIdentity, marker, bodyDigest,
    idempotencyKey: sha256({ kind: 'checklist', threadIdentity, bodyDigest }),
    expectedRevision: observation.sourceRevision, observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 120_000).toISOString(),
  };
  let operationIntent = resumeIntent(path, intent);
  const durable = operationIntent === null ? null : readReceipt(path, operationIntent);
  if (durable) return durable;
  let found = await github.findChecklist({
    repository: observation.repository, pullRequest: observation.pullRequest.number, marker,
  });
  if (operationIntent === null) {
    if (reserve(path, intent)) operationIntent = intent;
    else operationIntent = resumeIntent(path, intent);
  } else {
    const reconciled = await github.findChecklist({
      repository: observation.repository, pullRequest: observation.pullRequest.number, marker,
    });
    if (reconciled?.body === body) return settle(path, operationIntent, reconciled);
    if (Date.parse(observedAt) >= Date.parse(operationIntent.expiresAt)) {
      fail('ChecklistUncertain', 'checklist upsert remains ambiguous after its bounded lease');
    }
    found = reconciled ?? found;
  }
  if (found) {
    if (found.body === body) return settle(path, intent, found);
    try {
      await authorize({
        authority, acquireGrant,
        intent: authorityIntent({
          action: 'UPSERT_REVIEW_THREAD_CHECKLIST', observation,
          intentRevision: operationIntent.operationIdentity,
        }),
      });
    } catch (error) {
      if (error?.code === 'WaitingAuthority') return Object.freeze({ state: 'WAITING_AUTHORITY', marker });
      throw error;
    }
    const updated = await github.updateChecklist({
      repository: observation.repository, pullRequest: observation.pullRequest.number,
      commentId: found.id, marker, body,
    });
    return settle(path, operationIntent, updated ?? found);
  }
  try {
    await authorize({
      authority, acquireGrant,
      intent: authorityIntent({
        action: 'UPSERT_REVIEW_THREAD_CHECKLIST', observation,
        intentRevision: operationIntent.operationIdentity,
      }),
    });
  } catch (error) {
    if (error?.code === 'WaitingAuthority') return Object.freeze({ state: 'WAITING_AUTHORITY', marker });
    throw error;
  }
  try {
    return settle(path, operationIntent, await github.createChecklist({
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
  const normalize = (idempotencyKey, result) => result === null ? null : Object.freeze({
    id: result.threadIdentity ?? idempotencyKey,
    idempotencyKey,
    status: result.status,
    changeSetIdentity: result.changeSet?.identity ?? result.changeSetIdentity ?? null,
    addressedCommentIds: result.addressedCommentIds ?? [],
  });
  return Object.freeze({
    async findRepairLane(request) {
      const { idempotencyKey } = request;
      if (typeof execution.findReceipt !== 'function') return null;
      const intent = {
        action: 'RUN_FACTORY_AGENT', repository: request.repository,
        task: [
          `Repair review thread ${request.reviewThreadId} on ${request.repository}#${request.pullRequest}.`,
          `Reviewed head: ${request.reviewedHeadOid}.`,
          `Anchor path: ${request.anchorPath}.`,
          `Address exactly comment ids: ${request.actionableCommentIds.join(',')}.`,
        ].join(' '),
        reviewThreadEvidence: {
          threadIdentity: request.threadIdentity, reviewThreadId: request.reviewThreadId,
          anchorPath: request.anchorPath, addressedCommentIds: request.actionableCommentIds,
          sourceRevision: request.sourceRevision, observedAt: request.observedAt,
        },
      };
      return normalize(idempotencyKey, await execution.findReceipt({ idempotencyKey, intent }));
    },
    async startRepairLane(request) {
      const task = [
        `Repair review thread ${request.reviewThreadId} on ${request.repository}#${request.pullRequest}.`,
        `Reviewed head: ${request.reviewedHeadOid}.`,
        `Anchor path: ${request.anchorPath}.`,
        `Address exactly comment ids: ${request.actionableCommentIds.join(',')}.`,
      ].join(' ');
      const result = await execution.execute({
        intent: {
          action: 'RUN_FACTORY_AGENT', repository: request.repository, task,
          reviewThreadEvidence: {
            threadIdentity: request.threadIdentity,
            reviewThreadId: request.reviewThreadId,
            anchorPath: request.anchorPath,
            addressedCommentIds: request.actionableCommentIds,
            sourceRevision: request.sourceRevision,
            observedAt: request.observedAt,
          },
        },
        idempotencyKey: request.idempotencyKey,
      });
      return Object.freeze({
        ...normalize(request.idempotencyKey, result), id: request.threadIdentity,
        addressedCommentIds: result.status === 'completed'
          && result.changeSet?.files?.some(({ path }) => path === request.anchorPath)
          ? request.actionableCommentIds : [],
      });
    },
  });
}

/** Re-read GitHub, reconcile every exact identity, perform bounded effects, sync analytics. */
export async function runPrReviewThreadSupervisorTick({
  directory, repository, pullRequest, github, lanes, authority, grant,
  acquireGrant = async () => grant,
  synchronizeTelemetry, now = () => new Date(), run = { runId: `review-${pullRequest}`, laneGeneration: 1 },
}) {
  if (!github || typeof github.collectReviewThreads !== 'function'
      || typeof github.findChecklist !== 'function' || typeof github.createChecklist !== 'function'
      || typeof github.updateChecklist !== 'function'
      || typeof github.readRepairEvidence !== 'function'
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
    const owner = sha256({ kind: 'review-thread-supervisor', threadIdentity }).slice(0, 32);
    let result = null;
    try {
      result = await runPrReviewThreadRepairPump({
        directory, observation, acquireGrant, authority, effects: github, now, owner,
      });
    } catch (error) {
      if (!(error instanceof PrReviewRepairError)
          || !['RepairRaceLost', 'RepairInFlight'].includes(error.code)) throw error;
    }
    const history = historyOf(directory, threadIdentity);
    if (history.includes('CLAIMED') && !history.includes('REFUSED') && !history.includes('RESOLVED')) {
      const lane = await ensureLane({
        directory, lanes, observation, threadIdentity, observedAt, authority, acquireGrant,
      });
      let currentObservation = observation;
      if (!['PENDING', 'WAITING_AUTHORITY'].includes(lane.state)) {
        currentObservation = await github.readRepairEvidence({ observation, laneReceipt: lane });
        try {
          result = await runPrReviewThreadRepairPump({
            directory, observation: currentObservation, acquireGrant,
            authority, effects: github, now, owner,
          });
        } catch (error) {
          if (!(error instanceof PrReviewRepairError)
              || !['RepairRaceLost', 'RepairInFlight'].includes(error.code)) throw error;
        }
      }
      const finalHistory = historyOf(directory, threadIdentity);
      const plan = planPrReviewThreadRepair({ observation: currentObservation, history: finalHistory });
      const peers = projectPrReviewRepairLedger({ directory }).projection.lanes
        .filter((candidate) => candidate.threadIdentity !== threadIdentity);
      const checklist = renderRepairChecklist({
        reading: plan, observation: currentObservation, eta: estimateRepairEta(peers), history: finalHistory,
      }) + `\n\n${PR_REVIEW_CHECKLIST_MARKER_PREFIX}${threadIdentity}`;
      await ensureChecklist({
        directory, github, observation, threadIdentity, body: checklist, observedAt,
        authority, acquireGrant,
      });
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
