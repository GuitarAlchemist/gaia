/**
 * portfolio-drain.mjs — pure state and one bounded pump decision for a GitHub portfolio.
 *
 * The portfolio snapshot says what GitHub currently reports. Drain receipts say what Gaia
 * already did. This module reconciles both into one content-addressed projection and proposes
 * only local, authority-free next decisions. It performs no I/O, owns no credentials, starts no
 * agent and mutates no repository. Persistence and execution are later adapters at separate
 * seams; text, labels and model output never become authority here.
 */

import { createHash } from 'node:crypto';

export const PORTFOLIO_DRAIN_RECEIPT_SCHEMA = 'gaia-portfolio-drain-receipt/1';
export const PORTFOLIO_DRAIN_PROJECTION_SCHEMA = 'gaia-portfolio-drain-projection/1';

const RECEIPT_EVENTS = Object.freeze([
  'CLAIMED',
  'STARTED',
  'CANDIDATE_READY',
  'CANDIDATE_REJECTED',
  'EXECUTION_FAILED',
  'PUBLISHED',
  'MERGED',
  'CLOSED',
]);

const SOURCE_STATES = Object.freeze({
  READY_WITH_UNKNOWN: 'BLOCKED_UNKNOWN',
  BLOCKED_DEPENDENCY: 'BLOCKED_DEPENDENCY',
  AWAITING_HUMAN: 'BLOCKED_HUMAN',
  DRAFT: 'BLOCKED_DRAFT',
  CHECKS_UNKNOWN: 'BLOCKED_EVIDENCE',
  REVIEW_UNKNOWN: 'BLOCKED_EVIDENCE',
  CHECKS_AND_REVIEW_UNKNOWN: 'BLOCKED_EVIDENCE',
  BLOCKED_REVIEW: 'BLOCKED_REVIEW',
  DUPLICATE: 'TERMINAL_DUPLICATE',
  ARCHIVED: 'TERMINAL_ARCHIVED',
  NEEDS_TRIAGE: 'BLOCKED_TRIAGE',
  EVIDENCE_UNKNOWN: 'BLOCKED_EVIDENCE',
});

const TRANSITIONS = Object.freeze({
  QUEUED: Object.freeze({ CLAIMED: 'CLAIMED' }),
  CLAIMED: Object.freeze({ STARTED: 'RUNNING' }),
  RUNNING: Object.freeze({
    CANDIDATE_READY: 'CANDIDATE_READY',
    CANDIDATE_REJECTED: 'TERMINAL_REJECTED',
    EXECUTION_FAILED: 'FAILED_AUTHORITY_CONSUMED',
  }),
  CANDIDATE_READY: Object.freeze({ PUBLISHED: 'PUBLISHED' }),
  PUBLISHED: Object.freeze({ MERGED: 'TERMINAL_MERGED', CLOSED: 'TERMINAL_CLOSED' }),
});

const ACTIVE_STATES = new Set(['CLAIMED', 'RUNNING']);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const ordinal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export class PortfolioDrainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortfolioDrainError';
    this.code = code;
  }
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function requireSha(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new PortfolioDrainError('InvalidRequest', `${field} must be a lowercase SHA-256`);
  }
  return value;
}

function requireItem(item) {
  if (!item || !['ISSUE', 'PULL_REQUEST'].includes(item.itemKind)
      || typeof item.repository !== 'string' || item.repository.length === 0
      || typeof item.itemId !== 'string' || item.itemId.length === 0
      || !Number.isSafeInteger(item.itemNumber) || item.itemNumber < 1
      || typeof item.state !== 'string'
      || typeof item.title !== 'string' || item.title.length === 0
      || typeof item.updatedAt !== 'string' || item.updatedAt.length === 0) {
    throw new PortfolioDrainError('InvalidPortfolio', 'work item identity or state is invalid');
  }
  return item;
}

function itemRevision(item) {
  return sha256(canonicalJson({
    ...itemIdentity(item),
    title: item.title,
    state: item.state,
    updatedAt: item.updatedAt,
  }));
}

function itemIdentity(item) {
  return {
    repository: item.repository,
    itemKind: item.itemKind,
    itemId: item.itemId,
    itemNumber: item.itemNumber,
  };
}

function sameItem(left, right) {
  return left.repository === right.repository
    && left.itemKind === right.itemKind
    && left.itemId === right.itemId
    && left.itemNumber === right.itemNumber;
}

function sourceDrainState(item) {
  if (item.state === 'READY') {
    return item.itemKind === 'ISSUE' ? 'QUEUED' : 'AWAITING_MERGE_AUTHORITY';
  }
  const mapped = SOURCE_STATES[item.state];
  if (!mapped) {
    throw new PortfolioDrainError(
      'InvalidPortfolio', `unsupported portfolio state ${item.state}`,
    );
  }
  return mapped;
}

/**
 * Build one immutable event receipt. Semantic transition validity is checked during replay,
 * where the whole chain is available; this function binds identity and predecessor exactly.
 */
export function buildPortfolioDrainReceipt({
  portfolioRevision, item, previous, event, evidenceRevision,
}) {
  requireSha(portfolioRevision, 'portfolioRevision');
  requireItem(item);
  requireSha(evidenceRevision, 'evidenceRevision');
  if (!RECEIPT_EVENTS.includes(event)) {
    throw new PortfolioDrainError('InvalidRequest', `unsupported drain event ${event}`);
  }
  if (previous !== null) {
    try {
      verifyReceipt(previous);
    } catch {
      throw new PortfolioDrainError('InvalidRequest', 'previous receipt must be valid');
    }
    if (!sameItem(previous, item)) {
      throw new PortfolioDrainError('InvalidRequest', 'previous receipt must bind the same item');
    }
  }
  const body = {
    schema: PORTFOLIO_DRAIN_RECEIPT_SCHEMA,
    portfolioRevision,
    ...itemIdentity(item),
    sourceTitle: item.title,
    sourceState: item.state,
    sourceUpdatedAt: item.updatedAt,
    itemRevision: itemRevision(item),
    ordinal: previous === null ? 0 : previous.ordinal + 1,
    previousRevision: previous === null ? null : previous.revision,
    event,
    evidenceRevision,
  };
  return deepFreeze({ ...body, revision: sha256(canonicalJson(body)) });
}

function verifyReceipt(receipt) {
  if (!receipt || receipt.schema !== PORTFOLIO_DRAIN_RECEIPT_SCHEMA) {
    throw new PortfolioDrainError('ReceiptInvalid', 'unsupported drain receipt');
  }
  requireSha(receipt.portfolioRevision, 'receipt.portfolioRevision');
  requireSha(receipt.evidenceRevision, 'receipt.evidenceRevision');
  const { revision, ...body } = receipt;
  requireSha(revision, 'receipt.revision');
  if (sha256(canonicalJson(body)) !== revision) {
    throw new PortfolioDrainError('ReceiptInvalid', 'receipt content does not match its revision');
  }
  if (!RECEIPT_EVENTS.includes(receipt.event)
      || !Number.isSafeInteger(receipt.ordinal) || receipt.ordinal < 0
      || (receipt.previousRevision !== null
        && !/^[a-f0-9]{64}$/u.test(receipt.previousRevision ?? ''))) {
    throw new PortfolioDrainError('ReceiptInvalid', 'receipt event or chain fields are invalid');
  }
  const observedItem = {
    repository: receipt.repository,
    itemKind: receipt.itemKind,
    itemId: receipt.itemId,
    itemNumber: receipt.itemNumber,
    title: receipt.sourceTitle,
    state: receipt.sourceState,
    updatedAt: receipt.sourceUpdatedAt,
  };
  requireItem(observedItem);
  if (receipt.itemRevision !== itemRevision(observedItem)) {
    throw new PortfolioDrainError('ReceiptInvalid', 'receipt item observation is not exact');
  }
  return receipt;
}

function replayItem(item, receipts) {
  if (receipts.length === 0) {
    return { drainState: sourceDrainState(item), observedPortfolioRevision: null };
  }
  const ordered = [...receipts].sort((left, right) => left.ordinal - right.ordinal);
  const firstObservation = {
    repository: ordered[0].repository,
    itemKind: ordered[0].itemKind,
    itemId: ordered[0].itemId,
    itemNumber: ordered[0].itemNumber,
    title: ordered[0].sourceTitle,
    state: ordered[0].sourceState,
    updatedAt: ordered[0].sourceUpdatedAt,
  };
  let state = sourceDrainState(firstObservation);
  let previousRevision = null;
  let observationDrift = false;
  for (let index = 0; index < ordered.length; index += 1) {
    const receipt = ordered[index];
    if (!sameItem(receipt, ordered[0])) {
      throw new PortfolioDrainError(
        'ReceiptItemMismatch', `receipt identity changed for ${ordered[0].itemId}`,
      );
    }
    if (receipt.itemRevision !== ordered[0].itemRevision) observationDrift = true;
    if (receipt.ordinal !== index || receipt.previousRevision !== previousRevision) {
      throw new PortfolioDrainError('ReceiptChainBroken', `receipt chain broke for ${item.itemId}`);
    }
    const next = TRANSITIONS[state]?.[receipt.event];
    if (!next) {
      throw new PortfolioDrainError(
        'TransitionInvalid', `${receipt.event} cannot follow ${state} for ${item.itemId}`,
      );
    }
    state = next;
    previousRevision = receipt.revision;
  }
  const terminal = state.startsWith('TERMINAL_') || state === 'FAILED_AUTHORITY_CONSUMED';
  const latest = ordered.at(-1);
  const currentRevision = item === null ? null : itemRevision(item);
  if (observationDrift
      || (item !== null && currentRevision !== latest.itemRevision)
      || (item === null && !terminal)) state = 'RECONCILE_REQUIRED';
  return { drainState: state, observedPortfolioRevision: latest.portfolioRevision };
}

/**
 * Reconcile one exact portfolio and an unordered set of persisted receipts. The result is a
 * pure projection and at most `capacity - occupied` factory claims, one per repository.
 */
export function reconcilePortfolioDrain({ portfolio, receipts = [], holds = [], capacity = 4 }) {
  if (!portfolio || portfolio.schema !== 'gaia-github-portfolio/1'
      || !Array.isArray(portfolio.workItems)) {
    throw new PortfolioDrainError('InvalidPortfolio', 'a GitHub portfolio is required');
  }
  requireSha(portfolio.revision, 'portfolio.revision');
  const { revision: portfolioRevision, ...portfolioBody } = portfolio;
  if (sha256(canonicalJson(portfolioBody)) !== portfolioRevision) {
    throw new PortfolioDrainError(
      'PortfolioMismatch', 'portfolio content does not match its pinned revision',
    );
  }
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4) {
    throw new PortfolioDrainError('InvalidRequest', 'capacity must be an integer from 1 to 4');
  }
  if (!Array.isArray(receipts)) {
    throw new PortfolioDrainError('InvalidRequest', 'receipts must be an array');
  }
  if (!Array.isArray(holds)) {
    throw new PortfolioDrainError('InvalidRequest', 'holds must be an array');
  }

  const workItems = [...portfolio.workItems].map(requireItem).sort(
    (left, right) => ordinal(left.repository, right.repository)
      || ordinal(left.itemKind, right.itemKind)
      || left.itemNumber - right.itemNumber,
  );
  const itemsById = new Map();
  for (const item of workItems) {
    if (itemsById.has(item.itemId)) {
      throw new PortfolioDrainError('InvalidPortfolio', `duplicate item ${item.itemId}`);
    }
    itemsById.set(item.itemId, item);
  }

  const receiptsByItem = new Map();
  const revisions = new Set();
  for (const candidate of receipts) {
    const receipt = verifyReceipt(candidate);
    if (revisions.has(receipt.revision)) {
      throw new PortfolioDrainError('ReceiptDuplicate', `duplicate receipt ${receipt.revision}`);
    }
    revisions.add(receipt.revision);
    const item = itemsById.get(receipt.itemId);
    if (item && !sameItem(receipt, item)) {
      throw new PortfolioDrainError('ReceiptItemMismatch', `receipt item ${receipt.itemId} changed identity`);
    }
    const itemReceipts = receiptsByItem.get(receipt.itemId) ?? [];
    itemReceipts.push(receipt);
    receiptsByItem.set(receipt.itemId, itemReceipts);
  }

  const receiptOnlyItems = [...receiptsByItem.entries()]
    .filter(([itemId]) => !itemsById.has(itemId))
    .map(([, itemReceipts]) => {
      const first = [...itemReceipts].sort((left, right) => left.ordinal - right.ordinal)[0];
      return {
        repository: first.repository,
        itemKind: first.itemKind,
        itemId: first.itemId,
        itemNumber: first.itemNumber,
        title: first.sourceTitle,
        state: 'MISSING_FROM_OPEN_SNAPSHOT',
        updatedAt: first.sourceUpdatedAt,
      };
    });
  const projectedInputs = [...workItems, ...receiptOnlyItems].sort(
    (left, right) => ordinal(left.repository, right.repository)
      || ordinal(left.itemKind, right.itemKind)
      || left.itemNumber - right.itemNumber,
  );
  const projectedIds = new Set(projectedInputs.map(({ itemId }) => itemId));
  const holdsByItem = new Map();
  for (const hold of holds) {
    if (!hold || typeof hold !== 'object' || Array.isArray(hold)
        || typeof hold.itemId !== 'string' || hold.itemId.length === 0
        || typeof hold.reason !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(hold.reason)) {
      throw new PortfolioDrainError('HoldInvalid', 'hold identity and reason must be canonical');
    }
    try {
      requireSha(hold.evidenceRevision, 'hold.evidenceRevision');
    } catch {
      throw new PortfolioDrainError('HoldInvalid', 'hold evidence revision must be exact');
    }
    if (!projectedIds.has(hold.itemId)) {
      throw new PortfolioDrainError('HoldItemUnknown', `hold item ${hold.itemId} is absent`);
    }
    if (holdsByItem.has(hold.itemId)) {
      throw new PortfolioDrainError('HoldDuplicate', `duplicate hold for ${hold.itemId}`);
    }
    holdsByItem.set(hold.itemId, deepFreeze({
      itemId: hold.itemId,
      reason: hold.reason,
      evidenceRevision: hold.evidenceRevision,
    }));
  }
  const items = projectedInputs.map((item) => {
    const current = item.state === 'MISSING_FROM_OPEN_SNAPSHOT' ? null : item;
    const replayed = replayItem(current, receiptsByItem.get(item.itemId) ?? []);
    const hold = holdsByItem.get(item.itemId) ?? null;
    let { drainState } = replayed;
    if (hold) {
      if (ACTIVE_STATES.has(drainState)) drainState = 'RECONCILE_REQUIRED';
      else if (['QUEUED', 'AWAITING_MERGE_AUTHORITY', 'CANDIDATE_READY'].includes(drainState)) {
        drainState = 'BLOCKED_POLICY';
      }
    }
    return {
      ...itemIdentity(item),
      title: item.title,
      sourceState: item.state,
      ...replayed,
      drainState,
      hold,
    };
  });
  const occupied = items.filter(({ drainState }) => ACTIVE_STATES.has(drainState)).length;
  const available = Math.max(0, capacity - occupied);
  const decisions = [];

  // Preparing an intent is a deterministic local projection and consumes no lane or authority.
  for (const item of items.filter(({ drainState }) => drainState === 'CANDIDATE_READY')) {
    decisions.push({
      action: 'PREPARE_PUBLICATION_INTENT',
      ...itemIdentity(item),
      effect: 'NONE',
      requiredAuthority: 'NONE',
    });
  }

  const selectedRepositories = new Set(items.filter(
    ({ drainState }) => ACTIVE_STATES.has(drainState),
  ).map(({ repository }) => repository));
  let claims = 0;
  for (const item of items.filter(({ drainState }) => drainState === 'QUEUED')) {
    if (claims === available) break;
    if (selectedRepositories.has(item.repository)) continue;
    selectedRepositories.add(item.repository);
    claims += 1;
    decisions.push({
      action: 'CLAIM_FACTORY_RUN',
      ...itemIdentity(item),
      effect: 'NONE',
      requiredAuthority: 'FACTORY_RUN',
    });
  }

  const body = {
    schema: PORTFOLIO_DRAIN_PROJECTION_SCHEMA,
    portfolioRevision: portfolio.revision,
    effect: 'NONE',
    authority: 'NONE',
    capacity,
    counts: { occupied, available },
    items,
    decisions,
  };
  return deepFreeze({ ...body, revision: sha256(canonicalJson(body)) });
}
