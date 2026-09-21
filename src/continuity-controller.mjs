import {
  PORTABLE_RECEIPT_SCHEMA,
  canonicalContinuityJson,
  continuityRequestDigest,
  digestContinuityValue,
  isContinuityDigest,
  isContinuityIdentifier,
  isContinuityMediaType,
  portableReceiptDigest,
  refuse,
  requireExactObjectKeys,
  validatePortableReceipt,
} from './continuity-contract.mjs';
import { isBusEvidenceCursor } from './bus-evidence-contract.mjs';

const parse = value => JSON.parse(value);
const withRevision = state => state?.revision ?? 0;

function requireKeys(value, keys) {
  requireExactObjectKeys(value, keys);
}

function requireInteger(value, min, max, code = 'INVALID_REQUEST') {
  if (!Number.isSafeInteger(value) || value < min || value > max) refuse(code);
}
function requireDigest(value) { if (!isContinuityDigest(value)) refuse('INVALID_REQUEST'); }
function requireIdentifier(value) { if (!isContinuityIdentifier(value)) refuse('INVALID_REQUEST'); }
function requireRevision(state, expected) {
  requireInteger(expected, 0, 12);
  if (withRevision(state) !== expected) refuse('STALE_REVISION');
}
function requireSession(state, input) {
  requireInteger(input.sessionGeneration, 0, 1);
  if (state.session.sessionGeneration !== input.sessionGeneration) refuse('STALE_SESSION_GENERATION');
  if (state.session.actorRef !== input.actorRef || state.session.sessionRef !== input.sessionRef
    || state.session.capabilityDigest !== input.capabilityDigest) refuse('SESSION_BINDING_MISMATCH');
}
function requireBusCursor(cursor) { if (!isBusEvidenceCursor(cursor)) refuse('INVALID_REQUEST'); }
function event(type, operationId, timeReceipt) {
  return { type, operationId, timeReceipt };
}

export function createContinuityController({ store, wakeEvidencePort = null }) {
  if (!store || typeof store.runOperation !== 'function' || typeof store.status !== 'function'
    || typeof store.close !== 'function') refuse('INVALID_STORE');
  if (wakeEvidencePort !== null
    && (typeof wakeEvidencePort !== 'object'
      || typeof wakeEvidencePort.captureCheckpoint !== 'function'
      || typeof wakeEvidencePort.commitAndReconcile !== 'function')) refuse('INVALID_STORE');

  function executeBytes(action, input, transition, operationClass = 'lifecycle',
    reservationOwner = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('INVALID_REQUEST');
    requireIdentifier(input.operationId);
    const requestDigest = continuityRequestDigest(action, input);
    return store.runOperation({ operationId: input.operationId, requestDigest, operationClass,
      reservationOwner,
      transition: context => transition(context, requestDigest) }).responseBytes;
  }
  const execute = (action, input, transition, operationClass, reservationOwner) =>
    parse(executeBytes(action, input, transition, operationClass, reservationOwner));

  function acceptTransition(input, requestDigest) {
    requireKeys(input, ['operationId', 'expectedRevision', 'workIdentity', 'workGeneration',
      'successorSlot', 'actorRef', 'sessionRef', 'sessionGeneration', 'capabilityDigest',
      'commitmentDigest', 'incomingReviewDigest']);
    requireInteger(input.expectedRevision, 0, 0);
    requireDigest(input.workIdentity);
    requireInteger(input.workGeneration, 0, 0);
    if (input.successorSlot !== 'review-successor') refuse('INVALID_REQUEST');
    requireIdentifier(input.actorRef); requireIdentifier(input.sessionRef);
    requireInteger(input.sessionGeneration, 0, 0);
    requireDigest(input.capabilityDigest); requireDigest(input.commitmentDigest);
    requireDigest(input.incomingReviewDigest);
    return ({ state, mintTime }) => {
      requireRevision(state, input.expectedRevision);
      if (state) refuse('WORK_EXISTS');
      const timeReceipt = mintTime();
      const next = {
        revision: 1, workIdentity: input.workIdentity, workGeneration: 0,
        successorSlot: input.successorSlot, commitmentDigest: input.commitmentDigest,
        incomingReviewDigest: input.incomingReviewDigest, status: 'ACTIVE',
        acceptedAt: timeReceipt,
        session: { actorRef: input.actorRef, sessionRef: input.sessionRef,
          sessionGeneration: 0, capabilityDigest: input.capabilityDigest },
        sessionHistory: [{ actorRef: input.actorRef, sessionRef: input.sessionRef,
          sessionGeneration: 0, capabilityDigest: input.capabilityDigest, fenced: false }],
      };
      const response = { schema: 'continuity.operation-result/1', operationId: input.operationId,
        requestDigest, event: 'GENERATION_ACCEPTED', revision: 1, state: next, timeReceipt };
      return { state: next, response, event: event('GENERATION_ACCEPTED', input.operationId, timeReceipt) };
    };
  }

  function replaceTransition(input, requestDigest) {
    requireKeys(input, ['operationId', 'expectedRevision', 'sessionGeneration', 'actorRef',
      'sessionRef', 'capabilityDigest', 'replacement']);
    requireIdentifier(input.actorRef); requireIdentifier(input.sessionRef);
    requireDigest(input.capabilityDigest);
    if (!input.replacement || typeof input.replacement !== 'object') refuse('INVALID_REQUEST');
    requireKeys(input.replacement, ['actorRef', 'sessionRef', 'sessionGeneration', 'capabilityDigest']);
    requireIdentifier(input.replacement.actorRef); requireIdentifier(input.replacement.sessionRef);
    requireInteger(input.replacement.sessionGeneration, 1, 1);
    requireDigest(input.replacement.capabilityDigest);
    return ({ state, mintTime }) => {
      requireRevision(state, input.expectedRevision);
      if (!state) refuse('NOT_FOUND');
      requireSession(state, input);
      if (state.status !== 'ACTIVE' || state.session.sessionGeneration !== 0) refuse('INVALID_TRANSITION');
      const timeReceipt = mintTime();
      const replacementSession = { ...input.replacement };
      const next = { ...state, revision: state.revision + 1, session: replacementSession,
        sessionHistory: [
          { ...state.sessionHistory[0], fenced: true },
          { ...replacementSession, fenced: false },
        ], replacementAt: timeReceipt };
      const response = { schema: 'continuity.operation-result/1', operationId: input.operationId,
        requestDigest, event: 'GENERATION_REPLACED', revision: next.revision,
        state: next, timeReceipt };
      return { state: next, response, event: event('GENERATION_REPLACED', input.operationId, timeReceipt) };
    };
  }

  function decisionTransition(input, requestDigest) {
    requireKeys(input, ['operationId', 'expectedRevision', 'sessionGeneration', 'actorRef',
      'sessionRef', 'capabilityDigest', 'decision', 'incomingReviewDigest', 'outputArtifact']);
    requireIdentifier(input.actorRef); requireIdentifier(input.sessionRef);
    requireDigest(input.capabilityDigest); requireDigest(input.incomingReviewDigest);
    if (input.decision !== 'ACCEPTED_FOR_NEXT_STAGE') refuse('INVALID_REQUEST');
    requireKeys(input.outputArtifact, ['mediaType', 'sha256', 'bytes']);
    if (!input.outputArtifact || !isContinuityMediaType(input.outputArtifact.mediaType)
      || !isContinuityDigest(input.outputArtifact.sha256)) refuse('INVALID_REQUEST');
    requireInteger(input.outputArtifact.bytes, 1, 65_536);
    return ({ state, mintTime }) => {
      requireRevision(state, input.expectedRevision);
      if (!state) refuse('NOT_FOUND');
      requireSession(state, input);
      if (state.status === 'CANCELLED') refuse('CANCELLED');
      if (state.status === 'DECIDED') refuse('DECISION_ALREADY_COMMITTED');
      if (state.status === 'CONSUMED') refuse('ALREADY_CONSUMED');
      if (state.session.sessionGeneration !== 1) refuse('REPLACEMENT_REQUIRED');
      if (state.wake?.status !== 'DELIVERED') refuse('WAKE_REQUIRED');
      if (input.incomingReviewDigest !== state.incomingReviewDigest) refuse('REVIEW_DIGEST_MISMATCH');
      const timeReceipt = mintTime();
      const decisionFact = { decision: input.decision,
        incomingReviewDigest: input.incomingReviewDigest, outputArtifact: input.outputArtifact,
        successor: { actorRef: state.session.actorRef, sessionRef: state.session.sessionRef,
          sessionGeneration: state.session.sessionGeneration }, timeReceipt };
      const decisionDigest = digestContinuityValue('continuity.successor-decision/1', decisionFact);
      const next = { ...state, revision: state.revision + 1, status: 'DECIDED',
        decision: { ...decisionFact, digest: decisionDigest } };
      const response = { schema: 'continuity.operation-result/1', operationId: input.operationId,
        requestDigest, event: 'DECISION_COMMITTED', revision: next.revision,
        decisionDigest, state: next, timeReceipt };
      return { state: next, response, event: event('DECISION_COMMITTED', input.operationId, timeReceipt) };
    };
  }

  function wakeIntentTransition(input, requestDigest) {
    requireKeys(input, ['operationId', 'checkpointOperationId', 'deliveredOperationId',
      'expectedRevision', 'sessionGeneration', 'actorRef', 'sessionRef', 'capabilityDigest',
      'senderActorRef']);
    requireIdentifier(input.checkpointOperationId);
    requireIdentifier(input.deliveredOperationId);
    requireIdentifier(input.senderActorRef);
    return ({ state, mintTime, reserveOperationIds }) => {
      requireRevision(state, input.expectedRevision);
      if (!state) refuse('NOT_FOUND');
      requireSession(state, input);
      if (state.status !== 'ACTIVE' || state.session.sessionGeneration !== 1) {
        refuse('INVALID_TRANSITION');
      }
      if (state.wake) refuse('WAKE_ALREADY_COMMITTED');
      reserveOperationIds([input.checkpointOperationId, input.deliveredOperationId]);
      const timeReceipt = mintTime();
      const correlationId = `continuity-${state.workIdentity.slice(0, 32)}`;
      const command = {
        type: 'send', at: timeReceipt.candidateUtc, from: input.senderActorRef,
        to: state.session.actorRef,
        text: `continuity wake work=${state.workIdentity} commitment=${state.commitmentDigest} review=${state.incomingReviewDigest}`,
        kind: 'continuity-wake', correlationId, expectsReply: false, requestedAuthority: [],
      };
      const next = { ...state, revision: state.revision + 1,
        wake: { status: 'INTENT_COMMITTED', command,
          commandDigest: digestContinuityValue('continuity.wake-command/1', command),
          adapterInput: {
            intentOperationId: input.operationId,
            checkpointOperationId: input.checkpointOperationId,
            deliveredOperationId: input.deliveredOperationId,
            expectedRevision: input.expectedRevision,
            sessionGeneration: input.sessionGeneration,
            actorRef: input.actorRef,
            sessionRef: input.sessionRef,
            capabilityDigest: input.capabilityDigest,
            senderActorRef: input.senderActorRef,
          },
          intentTimeReceipt: timeReceipt } };
      const response = { schema: 'continuity.operation-result/1', operationId: input.operationId,
        requestDigest, event: 'WAKE_INTENT_COMMITTED', revision: next.revision,
        state: next, timeReceipt };
      return { state: next, response, event: event('WAKE_INTENT_COMMITTED', input.operationId, timeReceipt) };
    };
  }

  function wakeCheckpointTransition(input, requestDigest) {
    requireKeys(input, ['operationId', 'expectedRevision', 'cursor']);
    requireBusCursor(input.cursor);
    return ({ state, mintTime }) => {
      requireRevision(state, input.expectedRevision);
      if (!state) refuse('NOT_FOUND');
      if (state.status !== 'ACTIVE' || state.wake?.status !== 'INTENT_COMMITTED') {
        refuse('INVALID_TRANSITION');
      }
      const timeReceipt = mintTime();
      const next = { ...state, revision: state.revision + 1,
        wake: { ...state.wake, status: 'CHECKPOINTED', checkpoint: input.cursor,
          checkpointTimeReceipt: timeReceipt } };
      const response = { schema: 'continuity.operation-result/1', operationId: input.operationId,
        requestDigest, event: 'WAKE_CURSOR_CHECKPOINTED', revision: next.revision,
        state: next, timeReceipt };
      return { state: next, response,
        event: event('WAKE_CURSOR_CHECKPOINTED', input.operationId, timeReceipt) };
    };
  }

  function wakeDeliveredTransition(input, requestDigest) {
    requireKeys(input, ['operationId', 'expectedRevision', 'recordDigest', 'postCursor']);
    requireDigest(input.recordDigest);
    requireBusCursor(input.postCursor);
    return ({ state, mintTime }) => {
      requireRevision(state, input.expectedRevision);
      if (!state) refuse('NOT_FOUND');
      if (state.status !== 'ACTIVE' || state.wake?.status !== 'CHECKPOINTED') {
        refuse('INVALID_TRANSITION');
      }
      if (input.postCursor.instanceId !== state.wake.checkpoint.instanceId
        || input.postCursor.recordCount <= state.wake.checkpoint.recordCount
        || input.postCursor.byteOffset <= state.wake.checkpoint.byteOffset) {
        refuse('INVALID_BUS_EVIDENCE');
      }
      const timeReceipt = mintTime();
      const next = { ...state, revision: state.revision + 1,
        wake: { ...state.wake, status: 'DELIVERED', recordDigest: input.recordDigest,
          postCursor: input.postCursor, deliveredExpectedRevision: input.expectedRevision,
          adapterInput: { ...state.wake.adapterInput, deliveredOperationId: input.operationId },
          deliveredTimeReceipt: timeReceipt } };
      const response = { schema: 'continuity.operation-result/1', operationId: input.operationId,
        requestDigest, event: 'WAKE_DELIVERED', revision: next.revision,
        state: next, timeReceipt };
      return { state: next, response, event: event('WAKE_DELIVERED', input.operationId, timeReceipt) };
    };
  }

  function cancelTransition(input, requestDigest) {
    requireKeys(input, ['operationId', 'expectedRevision', 'sessionGeneration', 'actorRef',
      'sessionRef', 'capabilityDigest']);
    requireIdentifier(input.actorRef); requireIdentifier(input.sessionRef);
    requireDigest(input.capabilityDigest);
    return ({ state, mintTime }) => {
      requireRevision(state, input.expectedRevision);
      if (!state) refuse('NOT_FOUND');
      requireSession(state, input);
      if (state.status === 'CONSUMED') refuse('ALREADY_CONSUMED');
      if (state.status === 'DECIDED') refuse('DECISION_ALREADY_COMMITTED');
      if (state.status === 'CANCELLED') refuse('ALREADY_CANCELLED');
      if (['INTENT_COMMITTED', 'CHECKPOINTED'].includes(state.wake?.status)) {
        refuse('WAKE_DELIVERY_IN_PROGRESS');
      }
      const timeReceipt = mintTime();
      const next = { ...state, revision: state.revision + 1, status: 'CANCELLED',
        sessionHistory: state.sessionHistory.map(session => ({ ...session, fenced: true })),
        cancelledAt: timeReceipt };
      const response = { schema: 'continuity.operation-result/1', operationId: input.operationId,
        requestDigest, event: 'CANCELLED', revision: next.revision, state: next, timeReceipt };
      return { state: next, response, event: event('CANCELLED', input.operationId, timeReceipt) };
    };
  }

  function consumeTransition(input, requestDigest) {
    requireKeys(input, ['operationId', 'expectedRevision', 'sessionGeneration', 'actorRef',
      'sessionRef', 'capabilityDigest', 'consumerIdentity', 'ordinal']);
    requireIdentifier(input.actorRef); requireIdentifier(input.sessionRef);
    requireDigest(input.capabilityDigest); requireIdentifier(input.consumerIdentity);
    requireInteger(input.ordinal, 0, 0);
    return ({ state, mintTime }) => {
      requireRevision(state, input.expectedRevision);
      if (!state) refuse('NOT_FOUND');
      requireSession(state, input);
      if (state.status === 'CONSUMED') refuse('ALREADY_CONSUMED');
      if (state.status !== 'DECIDED') refuse('DECISION_NOT_COMMITTED');
      const timeReceipt = mintTime();
      const consumptionFact = { decisionDigest: state.decision.digest,
        consumerIdentity: input.consumerIdentity, consumedAtRef: timeReceipt.head,
        ordinal: 0, timeReceipt };
      const consumptionDigest = digestContinuityValue('continuity.successor-consumption/1', consumptionFact);
      const next = { ...state, revision: state.revision + 1, status: 'CONSUMED',
        consumption: { ...consumptionFact, digest: consumptionDigest } };
      const response = { schema: 'continuity.operation-result/1', operationId: input.operationId,
        requestDigest, event: 'DECISION_CONSUMED', revision: next.revision,
        consumptionDigest, state: next, timeReceipt };
      return { state: next, response, event: event('DECISION_CONSUMED', input.operationId, timeReceipt) };
    };
  }

  function inspectTransition(input, requestDigest) {
    requireKeys(input, ['operationId', 'workIdentity']);
    requireDigest(input.workIdentity);
    return ({ state, mintTime }) => {
      const timeReceipt = mintTime();
      if (!state || state.workIdentity !== input.workIdentity) {
        return { response: { schema: 'continuity.inspect-result/1', operationId: input.operationId,
          requestDigest, status: 'NOT_FOUND', timeReceipt } };
      }
      const ageMilliseconds = Math.max(0,
        Date.parse(timeReceipt.candidateUtc) - Date.parse(state.acceptedAt.candidateUtc));
      const phase = ageMilliseconds >= 120 * 60_000 ? 'STALLED'
        : ageMilliseconds >= 30 * 60_000 ? 'AT_RISK' : 'ADVANCING';
      return { response: { schema: 'continuity.inspect-result/1', operationId: input.operationId,
        requestDigest, status: 'FOUND', phase, revision: state.revision, state, timeReceipt } };
    };
  }

  function normalizeWakeInput(input) {
    requireKeys(input, ['intentOperationId', 'checkpointOperationId', 'deliveredOperationId',
      'expectedRevision', 'sessionGeneration', 'actorRef', 'sessionRef', 'capabilityDigest',
      'senderActorRef']);
    for (const key of ['intentOperationId', 'checkpointOperationId', 'deliveredOperationId']) {
      requireIdentifier(input[key]);
    }
    return {
      intentOperationId: input.intentOperationId,
      checkpointOperationId: input.checkpointOperationId,
      deliveredOperationId: input.deliveredOperationId,
      expectedRevision: input.expectedRevision,
      sessionGeneration: input.sessionGeneration,
      actorRef: input.actorRef,
      sessionRef: input.sessionRef,
      capabilityDigest: input.capabilityDigest,
      senderActorRef: input.senderActorRef,
    };
  }

  const intentRequest = input => ({
    operationId: input.intentOperationId,
    checkpointOperationId: input.checkpointOperationId,
    deliveredOperationId: input.deliveredOperationId,
    expectedRevision: input.expectedRevision,
    sessionGeneration: input.sessionGeneration,
    actorRef: input.actorRef,
    sessionRef: input.sessionRef,
    capabilityDigest: input.capabilityDigest,
    senderActorRef: input.senderActorRef,
  });

  function deliverWake(rawInput) {
    const input = normalizeWakeInput(rawInput);
    let state = store.status();
    if (state?.wake) {
      const exactInput = canonicalContinuityJson(state.wake.adapterInput)
        === canonicalContinuityJson(input);
      const correctedDeliveryInput = state.wake.status === 'CHECKPOINTED'
        && canonicalContinuityJson({ ...state.wake.adapterInput,
          deliveredOperationId: input.deliveredOperationId }) === canonicalContinuityJson(input);
      if (!exactInput && !correctedDeliveryInput) refuse('OPERATION_CONFLICT');
    }
    if (!state?.wake) {
      const request = intentRequest(input);
      state = execute('commit-wake-intent', request,
        (context, digest) => wakeIntentTransition(request, digest)(context)).state;
    }
    if (state.wake.status === 'DELIVERED') {
      const request = {
        operationId: state.wake.adapterInput.deliveredOperationId,
        expectedRevision: state.wake.deliveredExpectedRevision,
        recordDigest: state.wake.recordDigest,
        postCursor: state.wake.postCursor,
      };
      const replayed = execute('commit-wake-delivered', request,
        (context, digest) => wakeDeliveredTransition(request, digest)(context),
        'lifecycle', input.intentOperationId);
      return Object.freeze({ state: replayed.state, replayed: true });
    }
    if (wakeEvidencePort === null) refuse('WAKE_EVIDENCE_UNAVAILABLE');
    if (state.wake.status === 'INTENT_COMMITTED') {
      const checkpoint = wakeEvidencePort.captureCheckpoint();
      if (!isBusEvidenceCursor(checkpoint)) refuse('INVALID_BUS_EVIDENCE');
      state = execute('checkpoint-wake-cursor', {
        operationId: input.checkpointOperationId, expectedRevision: state.revision, cursor: checkpoint,
      }, (context, digest) => wakeCheckpointTransition({
        operationId: input.checkpointOperationId, expectedRevision: state.revision, cursor: checkpoint,
      }, digest)(context), 'lifecycle', input.intentOperationId).state;
    }
    if (state.wake.status !== 'CHECKPOINTED') refuse('INVALID_TRANSITION');
    const evidence = wakeEvidencePort.commitAndReconcile({
      checkpoint: state.wake.checkpoint, command: state.wake.command,
    });
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || !['APPENDED', 'EXISTING'].includes(evidence.status)
      || !evidence.record || typeof evidence.record !== 'object' || Array.isArray(evidence.record)) {
      refuse('INVALID_BUS_EVIDENCE');
    }
    if (!isBusEvidenceCursor(evidence.cursor)) refuse('INVALID_BUS_EVIDENCE');
    const recordDigest = digestContinuityValue('continuity.bus-message-record/1', evidence.record);
    const request = {
      operationId: input.deliveredOperationId,
      expectedRevision: state.revision,
      recordDigest,
      postCursor: evidence.cursor,
    };
    const result = execute('commit-wake-delivered', request,
      (context, digest) => wakeDeliveredTransition(request, digest)(context),
      'lifecycle', input.intentOperationId);
    return Object.freeze({ state: result.state, replayed: false });
  }

  function exportPortableReceipt() {
    const state = store.status();
    if (!state || state.status !== 'CONSUMED') refuse('NOT_CONSUMED');
    const receipt = {
      schema: PORTABLE_RECEIPT_SCHEMA,
      workIdentity: state.workIdentity,
      workGeneration: state.workGeneration,
      successorSlot: state.successorSlot,
      successor: { actorRef: state.session.actorRef, sessionRef: state.session.sessionRef,
        sessionGeneration: state.session.sessionGeneration },
      commitmentDigest: state.commitmentDigest,
      incomingReviewDigest: state.incomingReviewDigest,
      decisionDigest: state.decision.digest,
      decision: state.decision.decision,
      outputArtifact: state.decision.outputArtifact,
      consumptionDigest: state.consumption.digest,
      consumption: { consumerIdentity: state.consumption.consumerIdentity,
        consumedAtRef: state.consumption.consumedAtRef, ordinal: state.consumption.ordinal },
      authority: { effects: [] },
    };
    const complete = { ...receipt, receiptDigest: portableReceiptDigest(receipt) };
    validatePortableReceipt(complete);
    return complete;
  }

  return Object.freeze({
    acceptGeneration0: input => execute('accept-generation-0', input,
      (context, digest) => acceptTransition(input, digest)(context)),
    acceptGeneration0Bytes: input => executeBytes('accept-generation-0', input,
      (context, digest) => acceptTransition(input, digest)(context)),
    replaceGeneration0: input => execute('replace-generation-0', input,
      (context, digest) => replaceTransition(input, digest)(context)),
    deliverWake,
    commitDecision: input => execute('commit-decision', input,
      (context, digest) => decisionTransition(input, digest)(context)),
    cancel: input => execute('cancel', input,
      (context, digest) => cancelTransition(input, digest)(context)),
    consumeDecision: input => execute('consume-decision', input,
      (context, digest) => consumeTransition(input, digest)(context)),
    inspect: input => execute('inspect', input,
      (context, digest) => inspectTransition(input, digest)(context), 'inspection'),
    inspectBytes: input => executeBytes('inspect', input,
      (context, digest) => inspectTransition(input, digest)(context), 'inspection'),
    exportPortableReceipt,
    status: () => store.status(),
    canonicalStatus: () => canonicalContinuityJson(store.status()),
    close: () => store.close(),
  });
}
