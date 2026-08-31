/**
 * One bounded START_DRAFT tracer bullet over Gaia's existing durable machines.
 *
 * Portfolio drain owns the exclusive target/capacity reservation. First-evidence delivery owns
 * the GitHub intent, authority consumption, effect, and reconciliation. This module contributes
 * only a closed observation, one gate/action decision, and rebuildable projections.
 */

import { createHash } from 'node:crypto';

import {
  deliverFirstEvidenceDraftPr,
  projectFirstEvidenceLedgerSnapshot,
  readFirstEvidenceLedger,
} from './first-evidence-draft-pr-delivery.mjs';
import {
  planFirstEvidenceDraftPr,
  requireFirstEvidenceObservation,
} from './first-evidence-draft-pr.mjs';
import { isExactInstant } from './local-lane-observation.mjs';
import {
  appendPortfolioDrainReceipt,
  readPortfolioDrainLedger,
  tickPortfolioDrain,
} from './portfolio-drain-ledger.mjs';
import { buildPortfolioDrainReceipt, reconcilePortfolioDrain } from './portfolio-drain.mjs';

export const ENGINEERING_PUMP_OBSERVATION_SCHEMA = 'gaia-engineering-pump-observation/1';
export const ENGINEERING_PUMP_CHECKLIST_SCHEMA = 'gaia-engineering-pump-checklist/1';
export const ENGINEERING_PUMP_TRANSITION_SCHEMA = 'gaia-engineering-pump-transitions/1';

const SHA256 = /^[a-f0-9]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const OBSERVATION_FIELDS = Object.freeze([
  'schema', 'observedAt', 'repository', 'policyRevision', 'sourceRevision', 'capacity',
  'portfolio', 'subjects',
]);
const SEALED_FIELDS = Object.freeze([...OBSERVATION_FIELDS, 'observationRevision']);
const CAPACITY_FIELDS = Object.freeze(['writerSlots', 'providerSlots', 'ciSlots']);
const SUBJECT_FIELDS = Object.freeze(['readyItemId', 'subjectRevision', 'draftObservation']);
const MAX_AGE_MS = 300_000;

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export class EngineeringPumpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineeringPumpError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new EngineeringPumpError(code, message); };

function exactObject(value, fields, label, code = 'ObservationInvalid') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== fields.length
      || keys.some((key) => !fields.includes(key)
        || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    fail(code, `${label} must contain exactly its closed fields`);
  }
  return value;
}

function revision(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('ObservationInvalid', `${field} must be a lowercase SHA-256`);
  }
  return value;
}

function normalizeCapacity(value) {
  exactObject(value, CAPACITY_FIELDS, 'observation.capacity');
  const normalized = {};
  for (const field of CAPACITY_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0 || value[field] > 4) {
      fail('ObservationInvalid', `capacity.${field} must be an integer from zero to four`);
    }
    normalized[field] = value[field];
  }
  return normalized;
}

function normalizeBody(value) {
  exactObject(value, OBSERVATION_FIELDS, 'observation');
  if (value.schema !== ENGINEERING_PUMP_OBSERVATION_SCHEMA) {
    fail('ObservationInvalid', 'observation.schema is not this contract');
  }
  if (!isExactInstant(value.observedAt)) {
    fail('ObservationInvalid', 'observation.observedAt must be an exact instant');
  }
  if (typeof value.repository !== 'string' || !REPOSITORY.test(value.repository)) {
    fail('ObservationInvalid', 'observation.repository must be owner/name');
  }
  if (!Array.isArray(value.subjects)) fail('ObservationInvalid', 'subjects must be an array');
  const subjects = value.subjects.map((subject) => {
    exactObject(subject, SUBJECT_FIELDS, 'observation.subject');
    if (typeof subject.readyItemId !== 'string' || subject.readyItemId.length === 0) {
      fail('ObservationInvalid', 'subject.readyItemId must be present');
    }
    return {
      readyItemId: subject.readyItemId,
      subjectRevision: revision(subject.subjectRevision, 'subject.subjectRevision'),
      draftObservation: requireFirstEvidenceObservation(subject.draftObservation),
    };
  });
  return {
    schema: value.schema,
    observedAt: value.observedAt,
    repository: value.repository,
    policyRevision: revision(value.policyRevision, 'observation.policyRevision'),
    sourceRevision: revision(value.sourceRevision, 'observation.sourceRevision'),
    capacity: normalizeCapacity(value.capacity),
    portfolio: value.portfolio,
    subjects,
  };
}

export function sealEngineeringPumpObservation(value) {
  const body = normalizeBody(value);
  return deepFreeze({ ...body, observationRevision: sha256(body) });
}

function verifyObservation(value, now) {
  exactObject(value, SEALED_FIELDS, 'sealed observation', 'ObservationRevisionMismatch');
  const { observationRevision, ...supplied } = value;
  const sealed = sealEngineeringPumpObservation(supplied);
  if (observationRevision !== sealed.observationRevision) {
    fail('ObservationRevisionMismatch', 'observation content does not match its revision');
  }
  const observedMs = Date.parse(sealed.observedAt);
  const nowMs = now().getTime();
  if (!Number.isFinite(nowMs)) fail('ClockInvalid', 'now must return a valid Date');
  if (observedMs > nowMs) fail('ObservationFromFuture', 'observation is from the future');
  if (nowMs - observedMs > MAX_AGE_MS) fail('ObservationStale', 'observation is stale');
  return sealed;
}

function requireBindings(observed) {
  const items = new Map(observed.portfolio?.workItems?.map((item) => [item.itemId, item]) ?? []);
  const seen = new Set();
  for (const subject of observed.subjects) {
    const item = items.get(subject.readyItemId);
    const draft = subject.draftObservation;
    if (seen.has(subject.readyItemId) || !item
        || item.repository !== observed.repository
        || draft.repository !== observed.repository
        || item.itemKind !== draft.task.kind
        || item.itemNumber !== draft.task.number
        || draft.sourceRevision !== subject.subjectRevision) {
      fail('ObservationSubjectMismatch', 'subject does not bind an exact portfolio work item');
    }
    seen.add(subject.readyItemId);
  }
  for (const item of items.values()) {
    if (item.state === 'READY' && !seen.has(item.itemId)) {
      fail('ObservationSubjectMismatch', 'ready portfolio item has no exact subject observation');
    }
  }
}

const noAction = (state, reason) => deepFreeze({
  state, reason, nextAction: { kind: 'NONE' }, effect: 'NONE', authority: 'NONE',
});

function actionIdentity(observed, subject) {
  return sha256({
    schema: 'gaia-engineering-pump-action/1',
    repository: observed.repository.toLowerCase(),
    readyItemId: subject.readyItemId,
    subjectRevision: subject.subjectRevision,
    policyRevision: observed.policyRevision,
    action: 'START_DRAFT',
  });
}

function readyGate(observed, subject) {
  return deepFreeze({
    state: 'READY', reason: null,
    nextAction: {
      kind: 'START_DRAFT', readyItemId: subject.readyItemId,
      actionIdentity: actionIdentity(observed, subject),
    },
    effect: 'NONE', authority: 'NONE',
  });
}

function chooseSubject(observed, drainTick) {
  const active = drainTick.projection.items.find(
    ({ drainState }) => drainState === 'CLAIMED' || drainState === 'RUNNING',
  );
  const decision = drainTick.projection.decisions.find(
    ({ action }) => action === 'CLAIM_FACTORY_RUN',
  );
  const selectedId = active?.itemId ?? decision?.itemId ?? null;
  return selectedId === null
    ? { subject: null, item: null, needsClaim: false }
    : {
      subject: observed.subjects.find(({ readyItemId }) => readyItemId === selectedId) ?? null,
      item: observed.portfolio.workItems.find(({ itemId }) => itemId === selectedId) ?? null,
      needsClaim: active === undefined,
    };
}

export async function runEngineeringPumpSupervisorTick({
  directory, observation, grant, authority, effects, now = () => new Date(), owner, leaseMs,
  lockOptions,
}) {
  const observed = verifyObservation(observation, now);
  // Every gate, including a capacity early return, is a conclusion over the exact nested source.
  reconcilePortfolioDrain({ portfolio: observed.portfolio, capacity: 1 });
  requireBindings(observed);
  if (observed.capacity.providerSlots === 0) {
    return deepFreeze({ gate: noAction('PROVIDER_SATURATED', 'NO_PROVIDER_SLOT'), delivery: null,
      checklist: projectEngineeringPumpChecklist({ directory }) });
  }
  if (observed.capacity.ciSlots === 0) {
    return deepFreeze({ gate: noAction('CI_SATURATED', 'NO_CI_SLOT'), delivery: null,
      checklist: projectEngineeringPumpChecklist({ directory }) });
  }
  if (observed.capacity.writerSlots === 0) {
    return deepFreeze({ gate: noAction('CAPACITY_FULL', 'NO_WRITER_SLOT'), delivery: null,
      checklist: projectEngineeringPumpChecklist({ directory }) });
  }
  if (observed.portfolio.workItems.length === 0) {
    return deepFreeze({ gate: noAction('EXPECTED_NONE', 'NO_READY_WORK'), delivery: null,
      checklist: projectEngineeringPumpChecklist({ directory }) });
  }

  let drainTick = tickPortfolioDrain({
    directory, portfolio: observed.portfolio,
    capacity: Math.min(4, observed.capacity.writerSlots), lockOptions,
  });
  let { subject, item, needsClaim } = chooseSubject(observed, drainTick);
  if (!subject || !item) {
    return deepFreeze({ gate: noAction('EXPECTED_NONE', 'NO_ELIGIBLE_WORK'), delivery: null,
      checklist: projectEngineeringPumpChecklist({ directory }) });
  }
  const desiredActionIdentity = actionIdentity(observed, subject);
  if (!needsClaim) {
    const activeReceipt = readPortfolioDrainLedger({ directory, lockOptions }).receipts
      .filter(({ itemId }) => itemId === subject.readyItemId).at(-1);
    if (activeReceipt?.evidenceRevision !== desiredActionIdentity) {
      fail(
        'ReservationBindingMismatch',
        'active reservation does not bind this exact subject and policy action',
      );
    }
  }
  const draftPlan = planFirstEvidenceDraftPr({ observation: subject.draftObservation });
  if (!['CREATE_OR_REUSE', 'NONE'].includes(draftPlan.action)) {
    fail('DraftPlanRefused', 'first-evidence plan refused this subject');
  }
  if (draftPlan.action === 'NONE' && draftPlan.state === 'DRAFT_OPEN') {
    const priorIntent = readFirstEvidenceLedger({ directory, lockOptions }).transitions.some(
      (entry) => entry.operationIdentity === draftPlan.operationIdentity
        && entry.transition === 'INTENT',
    );
    if (!priorIntent) {
      return deepFreeze({ gate: noAction('EXPECTED_NONE', 'DRAFT_ALREADY_VISIBLE'), delivery: null,
        checklist: projectEngineeringPumpChecklist({ directory, lockOptions }) });
    }
  }
  if (draftPlan.action === 'NONE' && draftPlan.state !== 'DRAFT_OPEN') {
    return deepFreeze({ gate: noAction(draftPlan.state, 'NO_DRAFT_ACTION'), delivery: null,
      checklist: projectEngineeringPumpChecklist({ directory }) });
  }

  if (needsClaim) {
    const receipt = buildPortfolioDrainReceipt({
      portfolioRevision: observed.portfolio.revision,
      item,
      previous: null,
      event: 'CLAIMED',
      evidenceRevision: desiredActionIdentity,
    });
    try {
      appendPortfolioDrainReceipt({
        directory, portfolio: observed.portfolio, receipt,
        expectedLedgerRevision: drainTick.ledgerRevision, lockOptions,
      });
    } catch (error) {
      if (error?.code === 'LedgerCasMismatch') {
        fail('ReservationRaceLost', 'another tick reserved capacity first');
      }
      throw error;
    }
    drainTick = tickPortfolioDrain({
      directory, portfolio: observed.portfolio,
      capacity: Math.min(4, observed.capacity.writerSlots), lockOptions,
    });
    ({ subject, item, needsClaim } = chooseSubject(observed, drainTick));
    if (!subject || needsClaim) fail('ReservationLost', 'durable reservation did not reconcile');
  }

  const gate = readyGate(observed, subject);
  const delivery = await deliverFirstEvidenceDraftPr({
    directory, observation: subject.draftObservation, grant, authority, effects,
    now, owner, leaseMs, lockOptions,
  });
  return deepFreeze({
    gate, delivery, checklist: projectEngineeringPumpChecklist({ directory, lockOptions }),
  });
}

const unknown = (reason) => deepFreeze({ value: null, reason });
const executionProfile = () => deepFreeze({
  complexity: unknown('NO_COMPLEXITY_EVIDENCE'),
  uncertainty: unknown('NO_UNCERTAINTY_EVIDENCE'),
  estimatedTokens: unknown('NO_TOKEN_ESTIMATE_EVIDENCE'),
  parallelismCeiling: unknown('NO_ROUTING_EVIDENCE'),
  missingCapabilities: unknown('NO_CAPABILITY_EVIDENCE'),
  constraints: unknown('NO_CONSTRAINT_EVIDENCE'),
  externalServices: unknown('NO_DEPENDENCY_EVIDENCE'),
  risk: unknown('NO_RISK_EVIDENCE'),
});

function observedTelemetry(operation) {
  return deepFreeze({
    actualTokens: unknown('NO_PROVIDER_TOKEN_EVIDENCE'),
    agentWallTimeMs: unknown('NO_AGENT_BOUNDARY_EVIDENCE'),
    ciWallTimeMs: unknown('NO_CI_TRANSITION_EVIDENCE'),
    retries: { value: operation === null ? 0 : Math.max(0, operation.intents - 1), reason: null },
    queueDelayMs: unknown('NO_QUEUE_TIMESTAMP_EVIDENCE'),
    blockers: {
      value: operation?.refusal === null || operation?.refusal === undefined
        ? [] : [operation.refusal],
      reason: null,
    },
    estimateVariance: unknown('NO_COMPARABLE_ESTIMATE_EVIDENCE'),
  });
}

const DEFAULT_SOURCE_READERS = Object.freeze({
  readDrain: readPortfolioDrainLedger,
  readDraft: readFirstEvidenceLedger,
});

function stablePumpSourceSnapshot({
  directory, lockOptions, sourceReaders = DEFAULT_SOURCE_READERS, maxAttempts = 4,
}) {
  if (!sourceReaders || typeof sourceReaders.readDrain !== 'function'
      || typeof sourceReaders.readDraft !== 'function') {
    fail('ProjectionAdapterInvalid', 'both exact pump ledger readers are required');
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const leftDrain = sourceReaders.readDrain({ directory, lockOptions });
    const leftDraft = sourceReaders.readDraft({ directory, lockOptions });
    const rightDrain = sourceReaders.readDrain({ directory, lockOptions });
    const rightDraft = sourceReaders.readDraft({ directory, lockOptions });
    if (leftDrain.revision === rightDrain.revision
        && leftDraft.revision === rightDraft.revision) {
      return deepFreeze({ drain: rightDrain, draft: rightDraft });
    }
  }
  fail('ProjectionSnapshotUnstable', 'pump source ledgers changed throughout the bounded read window');
}

function operationForClaim(claim, operations) {
  if (claim === null) return null;
  return operations.filter((operation) => operation.repository === claim.repository
    && operation.task?.kind === claim.itemKind
    && operation.task?.number === claim.itemNumber).at(-1) ?? null;
}

export function projectEngineeringPumpChecklist({ directory, lockOptions, sourceReaders } = {}) {
  const { drain, draft } = stablePumpSourceSnapshot({ directory, lockOptions, sourceReaders });
  const delivery = projectFirstEvidenceLedgerSnapshot(draft);
  const claim = drain.receipts.at(-1) ?? null;
  const operation = operationForClaim(claim, delivery.projection.operations);
  const profile = executionProfile();
  const telemetry = observedTelemetry(operation);
  const currentGate = ['CREATED', 'REUSED'].includes(operation?.outcome) ? 'DRAFT_OPEN'
    : (claim === null ? 'EXPECTED_NONE' : 'START_DRAFT');
  const next = currentGate === 'DRAFT_OPEN' ? 'REVIEW' : 'START_DRAFT';
  const updatedAt = operation?.recordedAt ?? claim?.sourceUpdatedAt ?? null;
  const marker = operation?.operationIdentity ?? claim?.revision ?? drain.revision;
  const issueBody = {
    outcome: 'Open one evidence-bound Draft pull request for one ready issue.',
    why: 'Keep the engineering pump supplied with visible, reviewable work.',
    forWhom: 'Gaia operator and the next bounded delivery lane.',
    owner: operation?.owner ?? 'UNASSIGNED',
    reportsTo: 'GAIA_PUMP',
    scope: ['START_DRAFT tracer bullet'],
    exclusions: ['merge', 'ready-for-review', 'adaptive fanout', 'provider scheduling'],
    plan: ['observe', 'reserve', 'open-or-reconcile Draft', 'project evidence'],
    deliverables: ['one Draft pull request or a typed refusal'],
    doneWhen: ['durable CREATED or REUSED receipt binds the exact evidence head'],
    where: [claim?.repository ?? operation?.repository ?? 'UNKNOWN'],
    withWhat: ['portfolio drain ledger', 'first-evidence delivery journal', 'GitHub effect port'],
    authorityBoundary: 'OPEN_DRAFT_PULL_REQUEST exact grant only',
    evidenceLinks: operation?.pullRequest?.url ? [operation.pullRequest.url] : [],
    ifFailure: 'Stop without retry and surface the typed refusal or reconciliation gate.',
    executionProfile: profile,
  };
  const statusComment = [
    `<!-- gaia:pump-status:${marker} -->`,
    `State: ${operation?.outcome ?? (claim === null ? 'IDLE' : 'CLAIMED')}`,
    `Current gate: ${currentGate}`,
    `- [${claim === null ? ' ' : 'x'}] Observe`,
    `- [${claim === null ? ' ' : 'x'}] Claim`,
    `- [${currentGate === 'DRAFT_OPEN' ? 'x' : ' '}] Open Draft`,
    `Next: ${next}`,
    'ETA: UNKNOWN (low confidence)',
    'ETA reason: NO_DURATION_MODEL_EVIDENCE',
    `Latest evidence: ${operation?.operationIdentity ?? claim?.evidenceRevision ?? 'UNKNOWN'}`,
    `Retries: ${telemetry.retries.value}`,
    'Origin: GAIA PUMP',
    `updatedAt: ${updatedAt ?? 'UNKNOWN'}`,
  ].join('\n');
  const body = {
    schema: ENGINEERING_PUMP_CHECKLIST_SCHEMA,
    origin: 'GAIA PUMP', currentGate, issueBody, statusComment,
    observedTelemetry: telemetry,
    sourceRevisions: { portfolioDrain: drain.revision, draftDelivery: delivery.ledgerRevision },
  };
  return deepFreeze({ ...body, revision: sha256(body) });
}

export function projectEngineeringPumpTransitions({ directory, lockOptions, sourceReaders } = {}) {
  const { drain, draft } = stablePumpSourceSnapshot({ directory, lockOptions, sourceReaders });
  const profile = executionProfile();
  const operations = projectFirstEvidenceLedgerSnapshot(draft).projection.operations;
  const byIdentity = new Map(operations.map((operation) => [operation.operationIdentity, operation]));
  const rows = [
    ...drain.receipts.map((receipt, ordinal) => ({
      source: 'PORTFOLIO_DRAIN', ordinal, transition: receipt.event,
      revision: receipt.revision, repository: receipt.repository, itemId: receipt.itemId,
      itemNumber: receipt.itemNumber, operationIdentity: null,
      recordedAt: receipt.sourceUpdatedAt, executionProfile: profile,
      observedTelemetry: observedTelemetry(null),
    })),
    ...draft.transitions.map((transition, ordinal) => ({
      source: 'FIRST_EVIDENCE', ordinal, transition: transition.transition,
      revision: transition.revision, repository: transition.repository,
      itemId: `${transition.task.kind.toLowerCase()}-${transition.task.number}`,
      itemNumber: transition.task.number, operationIdentity: transition.operationIdentity,
      recordedAt: transition.recordedAt, executionProfile: profile,
      observedTelemetry: observedTelemetry(byIdentity.get(transition.operationIdentity) ?? null),
    })),
  ];
  const body = {
    schema: ENGINEERING_PUMP_TRANSITION_SCHEMA,
    sourceRevisions: { portfolioDrain: drain.revision, draftDelivery: draft.revision },
    rows,
    effect: 'NONE', authority: 'NONE',
  };
  return deepFreeze({ ...body, revision: sha256(body) });
}
