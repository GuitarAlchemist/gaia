/**
 * factory-drain-telemetry.mjs - the one arm that binds a real drain transition to the spine.
 *
 * This is the whole loop in a single bounded step:
 *
 *   sensors            read the portfolio snapshot and the durable drain ledger
 *   durable state      replay those receipts into one exact projection
 *   pump decision      build the single candidate receipt for the requested transition
 *   minimum authority  attempt exactly one compare-and-swap append, or explicitly do nothing
 *   receipt/feedback   record what happened as passive telemetry the control room can read
 *
 * The arm holds no authority of its own. Its only durable effect is at most one drain receipt,
 * written through the existing ledger adapter under its existing single-writer protocol. It
 * launches no worker, calls no provider, retries nothing and publishes nothing. When the
 * requested transition is not permitted it does exactly nothing and says so, which is the
 * honest no-op the control room then shows as a named blockage rather than as motion.
 */

import { randomUUID } from 'node:crypto';

import {
  appendFactoryTelemetryEvent,
  readFactoryTelemetryLog,
} from './factory-telemetry-log.mjs';
import { buildFactoryTelemetryEvent } from './factory-telemetry.mjs';
import {
  appendPortfolioDrainReceipt,
  readPortfolioDrainLedger,
} from './portfolio-drain-ledger.mjs';
import {
  buildPortfolioDrainReceipt,
  reconcilePortfolioDrain,
} from './portfolio-drain.mjs';

export const DRAIN_TELEMETRY_STEP_SCHEMA = 'gaia-drain-telemetry-step/1';

const TOKEN = /^[A-Z][A-Z0-9_]{0,31}$/u;
const REFUSABLE = new Set(['PortfolioDrainError', 'PortfolioDrainLedgerError']);

export class DrainTelemetryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DrainTelemetryError';
    this.code = code;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Name a refusal with the interpreter's own diagnostic, never with prose. An unrecognizable
 * code becomes the honest sentinel rather than a guess.
 */
function blockerToken(error) {
  const token = String(error?.code ?? '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toUpperCase();
  return TOKEN.test(token) ? token : 'UNKNOWN';
}

function requireStep(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DrainTelemetryError('StepRequestInvalid', `${field} must be explicit`);
  }
  return value;
}

/** Run exactly one instrumented, bounded portfolio-drain transition. */
export function runInstrumentedDrainTransition({
  ledgerDirectory,
  telemetryDirectory,
  portfolio,
  itemId,
  event,
  lane = 'UNKNOWN',
  agent = 'UNKNOWN',
  runId = randomUUID(),
  evidenceRevision,
  capacity = 4,
  holds = [],
  now = () => new Date(),
  observe = () => {},
  lockOptions,
}) {
  requireStep(ledgerDirectory, 'ledgerDirectory');
  requireStep(telemetryDirectory, 'telemetryDirectory');
  requireStep(itemId, 'itemId');
  requireStep(event, 'event');
  if (typeof now !== 'function' || typeof observe !== 'function') {
    throw new DrainTelemetryError('StepRequestInvalid', 'now and observe must be functions');
  }

  const ledger = readPortfolioDrainLedger({ directory: ledgerDirectory, lockOptions });
  const before = reconcilePortfolioDrain({
    portfolio, receipts: ledger.receipts, holds, capacity,
  });
  const projected = before.items.find((candidate) => candidate.itemId === itemId);
  const workItem = portfolio.workItems.find((candidate) => candidate?.itemId === itemId);
  if (!projected || !workItem) {
    throw new DrainTelemetryError(
      'ItemUnobserved', `item ${itemId} is absent from the observed portfolio`,
    );
  }

  const priorReceipts = ledger.receipts
    .filter((receipt) => receipt.itemId === itemId)
    .sort((left, right) => left.ordinal - right.ordinal);
  let candidate;
  try {
    candidate = buildPortfolioDrainReceipt({
      portfolioRevision: portfolio.revision,
      item: workItem,
      previous: priorReceipts.at(-1) ?? null,
      event,
      evidenceRevision: evidenceRevision ?? ledger.revision,
    });
  } catch (error) {
    throw new DrainTelemetryError(
      'StepRequestInvalid', `the requested drain transition is not expressible: ${error.message}`,
    );
  }

  const subject = {
    repository: workItem.repository,
    itemId,
    itemNumber: workItem.itemNumber,
    lane,
    agent,
    itemRevision: candidate.itemRevision,
  };
  let telemetryHead = readFactoryTelemetryLog({
    directory: telemetryDirectory, lockOptions,
  }).revision;
  let previousEvent = null;
  const emit = (step) => {
    const observedAt = now().toISOString();
    previousEvent = buildFactoryTelemetryEvent({ runId, subject, previous: previousEvent, ...step, observedAt });
    const result = appendFactoryTelemetryEvent({
      directory: telemetryDirectory,
      event: previousEvent,
      expectedLogRevision: telemetryHead,
      notAfter: observedAt,
      lockOptions,
    });
    telemetryHead = result.log.revision;
    try {
      observe({ event: previousEvent, log: result.log });
    } catch {
      // Observation is never an execution dependency, in either direction.
    }
  };

  emit({ event: 'run.started', evidenceRevision: ledger.revision });
  emit({ event: 'run.heartbeat' });
  emit({ event: 'gate.entered', gate: event });

  let after = null;
  let refusal = null;
  try {
    after = appendPortfolioDrainReceipt({
      directory: ledgerDirectory,
      portfolio,
      receipt: candidate,
      expectedLedgerRevision: ledger.revision,
      lockOptions,
    });
  } catch (error) {
    // Only the drain interpreter's own refusals are a bounded no-op. A lock timeout or a
    // corrupted log is an infrastructure failure and must not be recorded as a blocked run.
    if (!REFUSABLE.has(error?.name)) throw error;
    refusal = error;
  }

  const ledgerRevisionAfter = after?.revision ?? ledger.revision;
  if (refusal === null) {
    emit({ event: 'gate.passed', gate: event, evidenceRevision: ledgerRevisionAfter });
    emit({ event: 'run.completed', evidenceRevision: ledgerRevisionAfter });
  } else {
    emit({ event: 'gate.failed', gate: event, evidenceRevision: ledger.revision });
    emit({ event: 'run.blocked', blocker: blockerToken(refusal) });
  }

  const settled = refusal === null
    ? reconcilePortfolioDrain({ portfolio, receipts: after.receipts, holds, capacity })
    : before;
  return deepFreeze({
    schema: DRAIN_TELEMETRY_STEP_SCHEMA,
    runId,
    repository: workItem.repository,
    itemId,
    event,
    outcome: refusal === null ? 'TRANSITION_RECORDED' : 'TRANSITION_REFUSED',
    blocker: refusal === null ? null : blockerToken(refusal),
    drainStateBefore: projected.drainState,
    drainStateAfter: settled.items.find(
      (item) => item.itemId === itemId,
    )?.drainState ?? 'UNKNOWN',
    ledgerRevisionBefore: ledger.revision,
    ledgerRevisionAfter,
    receiptRevision: refusal === null ? candidate.revision : null,
    telemetryLogRevision: telemetryHead,
    effect: refusal === null ? 'LOCAL_LEDGER_APPEND' : 'NONE',
    authority: 'NONE',
  });
}
