/**
 * hosted-draft-pump-producer.mjs — one hosted intake receipt to one sealed pump observation.
 *
 * `src/hosted-draft-pump-observation.mjs` is a closed read model with a content-addressed seal, and
 * until this module shipped it had no producer: nothing in the repository ever wrote a
 * `gaia-hosted-draft-pump/1` document, so issue #70's required tracer item 7 — "make the latest
 * verified pump transition visible in the Control Room" — was reachable only by a human
 * hand-authoring JSON and sealing it. Hand-reporting what the pump did is the exact labour issue
 * #70 exists to remove.
 *
 * This is the whole producer, and it is a pure function. It holds no clock, opens no file, spawns
 * nothing, reaches no ledger, and performs no effect; every instant and the sequence arrive as
 * arguments. The process boundary that actually runs the intake and reads a clock is
 * `scripts/hosted-draft-pump.mjs`, which hands its own receipt here. That is the same shape as
 * `src/local-lane-sensor.mjs` and for the same reason: a sealed observation must be re-derivable
 * from its inputs, and a function that reads a clock cannot be replayed.
 *
 * WHAT IT REFUSES RATHER THAN GUESSES
 * -----------------------------------
 * The receipt vocabularies are closed and read by exact equality. A `StaleRevision` result is a
 * compare-and-swap loser: this run performed no effect and does not know what the pump did, so it
 * publishes nothing and the winner's own run publishes the truth. An unrecognised refusal string
 * refuses the whole observation rather than degrading to blocker `NONE`, because a blocker read as
 * "no blocker" is the one direction this seam must never fail. A `CANCELLED` terminal refuses:
 * no shipped path calls `cancelDraft`, and the read model's fallthrough would publish it as a
 * healthy `REPLAYED`, which is not what a cancellation is.
 *
 * Skips are read only where they are the whole story. On `RESUME` and `ADMIT` the transition
 * describes the operation that actually moved and an incidental skip is not part of it. On
 * `EXPECTED_NONE` the skips ARE the run, so a `CrossGenerationIntent` skip publishes its typed
 * blocker and any unrecognised skip reason refuses — an unexplained empty admission must not read
 * as a healthy empty queue, which is issue #70's motivating defect restated.
 *
 * docs/hosted-draft-pump-producer.md is the normative contract.
 */

import {
  hostedDraftPumpRevision,
  requireHostedDraftPumpObservation,
  sealHostedDraftPumpObservation,
} from './hosted-draft-pump-observation.mjs';

/**
 * The exact receipt fields a transition is derived from.
 *
 * The content address is taken over these and nothing else, so it addresses the evidence that was
 * actually read rather than the document that happened to carry it. `telemetry` is diagnostic and
 * `observation` is written after this digest is taken, so neither may enter it.
 */
export const HOSTED_DRAFT_PUMP_RECEIPT_EVIDENCE_FIELDS = Object.freeze([
  'schema', 'command', 'trigger', 'phase', 'operationId', 'workKey', 'committedRevision',
  'workItem', 'unsettledCount', 'result', 'skipped',
]);

const RECEIPT_SCHEMA = 'GaiaHostedDraftPumpCliReceiptV0';
const RECEIPT_COMMAND = 'intake';

/** Null-prototype throughout, so `constructor` is not a trigger, an outcome or a refusal. */
const closedMap = (entries) => Object.freeze(Object.assign(Object.create(null), entries));

const TRIGGERS = closedMap({
  SCHEDULE: 'SCHEDULED_RECOVERY',
  ISSUES_LABELED: 'READY_LABEL',
});

const PHASES = Object.freeze(['RESUME', 'ADMIT', 'EXPECTED_NONE']);

/** The three terminal outcomes this producer can observe, each with the effect it implies. */
const TERMINAL_EFFECTS = closedMap({
  CREATED: 'CREATE_DRAFT',
  REUSED: 'NONE',
  REFUSED: 'NONE',
});

const REFUSAL_BLOCKERS = closedMap({
  ProviderUnavailable: 'PROVIDER_UNAVAILABLE',
  ProviderProtocolViolation: 'PROVIDER_PROTOCOL_VIOLATION',
  NoEffectCapacity: 'NO_EFFECT_CAPACITY',
});

/** Probing forward past a settled work key is the designed behaviour, not an obstruction. */
const BENIGN_SKIP_REASON = 'StaleRevision';
const CROSS_GENERATION_SKIP_REASON = 'CrossGenerationIntent';

export class HostedDraftPumpProducerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'HostedDraftPumpProducerError';
    this.code = code;
  }
}

/** Malformed, mismatched, or carrying a token no closed vocabulary declares. */
function invalid(detail) {
  throw new HostedDraftPumpProducerError('InvalidHostedDraftPumpReceipt', detail);
}

/**
 * Well formed, and still not something this run may publish a reading from.
 *
 * The distinction matters to an operator: `Invalid` means someone handed the producer the wrong
 * document, `Unobservable` means the run genuinely does not know what the pump did.
 */
function unobservable(detail) {
  throw new HostedDraftPumpProducerError('UnobservableHostedDraftPumpReceipt', detail);
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value;
}

function sameBinding(carried, derived, label) {
  if (carried !== derived) {
    invalid(`the receipt ${label} does not match the result it reports`);
  }
  return derived;
}

function nullableText(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') invalid(`${label} must be a digest or null`);
  return value;
}

export function hostedDraftPumpReceiptRevision(receipt) {
  const evidence = plainObject(receipt, 'the hosted Draft pump receipt');
  const named = {};
  for (const field of HOSTED_DRAFT_PUMP_RECEIPT_EVIDENCE_FIELDS) {
    named[field] = Object.hasOwn(evidence, field) ? evidence[field] : null;
  }
  return hostedDraftPumpRevision(named);
}

/** Three named reads. Nothing here spreads the provider's pull request into the observation. */
function projectPullRequest(value) {
  if (value === null || value === undefined) return null;
  const pullRequest = plainObject(value, 'the reported pull request');
  return {
    number: pullRequest.number,
    isDraft: pullRequest.isDraft,
    state: pullRequest.state,
  };
}

function requireWorkItem(value) {
  const workItem = plainObject(value, 'the receipt work item');
  if (workItem.kind !== 'ISSUE' || !Number.isSafeInteger(workItem.number) || workItem.number < 1) {
    invalid('the receipt work item must be a positive ISSUE number');
  }
  return { kind: 'ISSUE', number: workItem.number };
}

function refusalBlocker(refusal) {
  if (typeof refusal !== 'string' || !Object.hasOwn(REFUSAL_BLOCKERS, refusal)) {
    invalid(`the envelope refusal is not a recognised blocker: ${String(refusal)}`);
  }
  return REFUSAL_BLOCKERS[refusal];
}

/**
 * The blocker an empty admission is allowed to publish.
 *
 * `EXPECTED_NONE` beside an unexplained skip would be the single most reassuring wrong reading
 * this section can produce, so only the two reasons whose meaning is settled may pass.
 */
function emptyAdmissionBlocker(skipped) {
  if (!Array.isArray(skipped)) invalid('the receipt skip list must be an array');
  let blocker = 'NONE';
  for (const entry of skipped) {
    const skip = plainObject(entry, 'a receipt skip entry');
    if (typeof skip.reason !== 'string') invalid('a receipt skip entry must carry a reason');
    if (skip.reason === BENIGN_SKIP_REASON) continue;
    if (skip.reason === CROSS_GENERATION_SKIP_REASON) {
      blocker = 'CROSS_GENERATION_INTENT';
      continue;
    }
    unobservable(
      `a tick that admitted nothing skipped #${String(skip.number)} for ${skip.reason}; `
      + 'an unexplained empty admission may not be published as a healthy empty queue',
    );
  }
  return blocker;
}

function actedTransition(receipt) {
  const result = plainObject(receipt.result, 'the receipt result');
  if (result.kind === 'Pending') {
    return {
      outcome: 'PENDING',
      effect: 'UNKNOWN',
      blocker: 'EFFECT_AMBIGUOUS',
      pullRequest: null,
    };
  }
  if (result.kind !== 'Terminal') {
    unobservable(
      `a ${String(result.kind)} result performed no effect and reports no transition this run `
      + 'may publish',
    );
  }
  if (result.outcome === 'CANCELLED') {
    unobservable('a cancelled operation is not a pump transition this producer may publish');
  }
  if (typeof result.outcome !== 'string' || !Object.hasOwn(TERMINAL_EFFECTS, result.outcome)) {
    invalid(`the terminal outcome is not a recognised token: ${String(result.outcome)}`);
  }
  const effect = TERMINAL_EFFECTS[result.outcome];
  if (result.effect !== effect) {
    invalid(`a ${result.outcome} terminal must report effect ${effect}`);
  }
  if (result.outcome !== 'REFUSED' && result.refusal !== null && result.refusal !== undefined) {
    invalid(`a ${result.outcome} terminal must carry no refusal`);
  }
  return {
    outcome: result.outcome,
    effect,
    blocker: result.outcome === 'REFUSED' ? refusalBlocker(result.refusal) : 'NONE',
    pullRequest: projectPullRequest(result.pullRequest),
  };
}

function transitionFor(receipt, tickAt, observedSourceRevision) {
  if (receipt.schema !== RECEIPT_SCHEMA) {
    invalid(`the receipt schema is not ${RECEIPT_SCHEMA}: ${String(receipt.schema)}`);
  }
  if (receipt.command !== RECEIPT_COMMAND) {
    invalid(`only an ${RECEIPT_COMMAND} receipt reports a pump transition`);
  }
  if (typeof receipt.trigger !== 'string' || !Object.hasOwn(TRIGGERS, receipt.trigger)) {
    invalid(`the receipt trigger is not a recognised token: ${String(receipt.trigger)}`);
  }
  if (typeof receipt.phase !== 'string' || !PHASES.includes(receipt.phase)) {
    invalid(`the receipt phase is not a recognised token: ${String(receipt.phase)}`);
  }
  const trigger = TRIGGERS[receipt.trigger];

  if (receipt.phase === 'EXPECTED_NONE') {
    if (receipt.result !== null && receipt.result !== undefined) {
      invalid('a tick that admitted nothing reports no result');
    }
    for (const field of ['operationId', 'workKey', 'committedRevision', 'workItem']) {
      if (receipt[field] !== null && receipt[field] !== undefined) {
        invalid(`a tick that admitted nothing carries no ${field}`);
      }
    }
    return {
      tickAt,
      trigger,
      outcome: 'EXPECTED_NONE',
      effect: 'NONE',
      operationId: null,
      workKey: null,
      generationKey: null,
      committedRevision: null,
      observedSourceRevision,
      workItem: null,
      pullRequest: null,
      blocker: emptyAdmissionBlocker(receipt.skipped ?? []),
    };
  }

  const acted = actedTransition(receipt);
  const result = receipt.result;
  const committedRevision = nullableText(result.committedRevision, 'the result committed revision');
  return {
    tickAt,
    trigger,
    outcome: acted.outcome,
    effect: acted.effect,
    operationId: sameBinding(receipt.operationId, result.operationId ?? null, 'operation identity'),
    workKey: sameBinding(receipt.workKey, result.workKey ?? null, 'work key'),
    generationKey: nullableText(result.generationKey, 'the result generation key'),
    committedRevision: committedRevision === null
      ? nullableText(receipt.committedRevision, 'the receipt committed revision')
      : sameBinding(receipt.committedRevision, committedRevision, 'committed revision'),
    observedSourceRevision,
    workItem: requireWorkItem(receipt.workItem),
    pullRequest: acted.pullRequest,
    blocker: acted.blocker,
  };
}

/**
 * One hosted intake receipt, plus the identity and the instants the run observed, to one sealed
 * and immediately re-verified observation.
 *
 * Re-verifying what was just sealed is not ceremony: it is the only place the monotonicity refusal
 * against the previously published reading can run, and it proves the producer emits exactly what
 * the read model accepts rather than something adjacent to it.
 */
export function produceHostedDraftPumpObservation({
  receipt,
  repository,
  repositoryNodeId,
  ledgerRootOid,
  ledgerRootRevision,
  sequence,
  windowStartedAt,
  tickAt,
  observedAt,
  priorObservation = null,
} = {}) {
  const evidence = plainObject(receipt, 'the hosted Draft pump receipt');
  const sealed = sealHostedDraftPumpObservation({
    observedAt,
    windowStartedAt,
    sequence,
    repository,
    repositoryNodeId,
    ledgerRootOid,
    ledgerRootRevision,
    unsettledCount: evidence.unsettledCount,
    transition: transitionFor(evidence, tickAt, hostedDraftPumpReceiptRevision(evidence)),
  });
  return requireHostedDraftPumpObservation(sealed, { priorObservation });
}
