import { createHash } from 'node:crypto';

export const DRAFT_RECONCILIATION_SCHEMA = 'gaia-draft-reconciliation-receipt/1';
export const DRAFT_RECONCILIATION_STORE_SCHEMA = 'gaia-draft-reconciliation-store/1';

const SHA256 = /^[a-f0-9]{64}$/u;
const OID = /^[a-f0-9]{40}$/u;
const EFFECT = 'CREATE_DRAFT';

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

const clone = (value) => structuredClone(value);

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
};

export class DraftReconciliationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DraftReconciliationError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new DraftReconciliationError(code, message); };

const EMPTY_REVISION = sha256({ schema: DRAFT_RECONCILIATION_STORE_SCHEMA, records: [] });

export function createMemoryDraftReconciliationStore() {
  let revision = EMPTY_REVISION;
  const records = [];

  return freeze({
    async read() {
      return freeze({
        schema: DRAFT_RECONCILIATION_STORE_SCHEMA,
        revision,
        records: clone(records),
      });
    },

    async compareAndSetAppend(expectedRevision, candidate) {
      if (typeof expectedRevision !== 'string' || !SHA256.test(expectedRevision)) {
        fail('StoreRequestInvalid', 'expectedRevision must be a SHA-256');
      }
      if (expectedRevision !== revision) {
        fail('CasMismatch', 'the reconciliation store changed after it was observed');
      }
      if (!candidate || typeof candidate !== 'object'
          || !['INTENT', 'TERMINAL'].includes(candidate.kind)
          || typeof candidate.operationIdentity !== 'string'
          || !SHA256.test(candidate.operationIdentity)) {
        fail('StoreRecordInvalid', 'the reconciliation record is not canonical');
      }
      const body = freeze(clone(candidate));
      const nextRevision = sha256({ previousRevision: revision, record: body });
      records.push(freeze({ ...body, stateRevision: nextRevision }));
      revision = nextRevision;
      return this.read();
    },
  });
}

function exactInstant(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && new Date(value).toISOString() === value;
}

function requireObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'EvidenceInvalid';
  for (const field of [
    'organization', 'repository', 'workItem', 'readyItem', 'baseBranch', 'headBranch',
    'headBranchGeneration',
  ]) {
    if (typeof value[field] !== 'string' || value[field].trim() !== value[field]
        || value[field].length === 0) return 'EvidenceInvalid';
  }
  if (!OID.test(value.baseOid) || !OID.test(value.evidenceHeadOid)) return 'EvidenceInvalid';
  if (!SHA256.test(value.policyRevision) || !SHA256.test(value.sourceRevision)) {
    return 'EvidenceInvalid';
  }
  if (!Number.isSafeInteger(value.reconciliationGeneration)
      || value.reconciliationGeneration < 1) return 'EvidenceStale';
  if (value.requestedEffect !== EFFECT) return 'EffectMismatch';
  if (!exactInstant(value.observedAt) || !exactInstant(value.evaluatedAt)) return 'EvidenceInvalid';
  if (Date.parse(value.observedAt) > Date.parse(value.evaluatedAt)) return 'EvidenceFuture';
  if (typeof value.cancelled !== 'boolean') return 'EvidenceInvalid';
  if (!value.capacity || typeof value.capacity !== 'object') return 'EvidenceInvalid';
  for (const field of ['provider', 'ci', 'lanes']) {
    if (!Number.isSafeInteger(value.capacity[field]) || value.capacity[field] < 0) {
      return 'EvidenceInvalid';
    }
  }
  return null;
}

function identityBody(observation, { includeGeneration = true } = {}) {
  const body = {
    organization: observation.organization,
    repository: observation.repository,
    workItem: observation.workItem,
    readyItem: observation.readyItem,
    baseBranch: observation.baseBranch,
    baseOid: observation.baseOid,
    headBranch: observation.headBranch,
    headBranchGeneration: observation.headBranchGeneration,
    evidenceHeadOid: observation.evidenceHeadOid,
    policyRevision: observation.policyRevision,
    requestedEffect: observation.requestedEffect,
  };
  if (includeGeneration) body.reconciliationGeneration = observation.reconciliationGeneration;
  return body;
}

function operationIdentity(observation) {
  return sha256(identityBody(observation));
}

function baseIdentity(observation) {
  return sha256(identityBody(observation, { includeGeneration: false }));
}

function workIdentity(observation) {
  return sha256({
    organization: observation.organization,
    repository: observation.repository,
    workItem: observation.workItem,
    readyItem: observation.readyItem,
    requestedEffect: observation.requestedEffect,
  });
}

function receipt({
  outcome, refusal = null, effect = 'NONE', operation = null, sourceRevision = null,
  stateRevision = EMPTY_REVISION, pullRequest = null,
}) {
  return freeze({
    schema: DRAFT_RECONCILIATION_SCHEMA,
    outcome,
    refusal,
    effect,
    operationIdentity: operation,
    sourceRevision,
    pullRequest,
    stateRevision,
    actionRevision: stateRevision,
    checklistRevision: stateRevision,
    projectionRevision: stateRevision,
  });
}

function receiptFromTerminal(record) {
  return receipt({
    outcome: record.outcome,
    refusal: record.refusal,
    effect: record.effect,
    operation: record.operationIdentity,
    sourceRevision: record.sourceRevision,
    stateRevision: record.stateRevision,
    pullRequest: record.pullRequest,
  });
}

function exactDraft(candidate, operation) {
  return candidate && candidate.operationIdentity === operation
    && candidate.isDraft === true && candidate.state === 'OPEN'
    ? freeze(clone(candidate)) : null;
}

function activeIntent(records, operation) {
  const terminal = records.findLast(
    (record) => record.kind === 'TERMINAL' && record.operationIdentity === operation,
  );
  if (terminal) return null;
  return records.findLast(
    (record) => record.kind === 'INTENT' && record.operationIdentity === operation,
  ) ?? null;
}

function latestIntentForWork(records, work) {
  return records.findLast((record) => record.kind === 'INTENT' && record.workIdentity === work) ?? null;
}

async function appendOrRefuse(store, expectedRevision, record, refusal) {
  try {
    return await store.compareAndSetAppend(expectedRevision, record);
  } catch (error) {
    if (error instanceof DraftReconciliationError && error.code === 'CasMismatch') {
      return receipt({
        outcome: 'REFUSED', refusal, operation: record.operationIdentity,
        sourceRevision: record.sourceRevision, stateRevision: (await store.read()).revision,
      });
    }
    throw error;
  }
}

async function commitTerminal({
  store, expectedRevision, observation, operation, base, work, outcome, refusal = null,
  effect = 'NONE', pullRequest = null,
}) {
  const appended = await appendOrRefuse(store, expectedRevision, {
    kind: 'TERMINAL', operationIdentity: operation, baseIdentity: base, workIdentity: work,
    reconciliationGeneration: observation.reconciliationGeneration,
    sourceRevision: observation.sourceRevision, outcome, refusal, effect, pullRequest,
  }, 'StaleOwner');
  if (appended?.schema === DRAFT_RECONCILIATION_SCHEMA) return appended;
  const terminal = appended.records.at(-1);
  return receiptFromTerminal(terminal);
}

function requirePorts(ports) {
  if (!ports || typeof ports !== 'object'
      || typeof ports.store?.read !== 'function'
      || typeof ports.store?.compareAndSetAppend !== 'function'
      || typeof ports.provider?.lookupExact !== 'function'
      || typeof ports.provider?.createDraft !== 'function') {
    fail('AdapterInvalid', 'store and provider ports must implement the closed interface');
  }
}

export async function reconcileDraft(observation, expectedRevision, ports) {
  requirePorts(ports);
  const { store, provider, telemetry } = ports;
  const snapshot = await store.read();
  const invalid = requireObservation(observation);
  if (invalid) {
    return receipt({ outcome: 'REFUSED', refusal: invalid, stateRevision: snapshot.revision });
  }

  const operation = operationIdentity(observation);
  const base = baseIdentity(observation);
  const work = workIdentity(observation);
  const terminal = snapshot.records.findLast(
    (record) => record.kind === 'TERMINAL' && record.operationIdentity === operation,
  );
  if (terminal) return receiptFromTerminal(terminal);

  if (observation.cancelled) {
    return commitTerminal({
      store, expectedRevision, observation, operation, base, work,
      outcome: 'REFUSED', refusal: 'Cancelled',
    });
  }

  const priorForWork = latestIntentForWork(snapshot.records, work);
  if (priorForWork && priorForWork.baseIdentity !== base) {
    return receipt({
      outcome: 'REFUSED', refusal: 'CrossGenerationIntent', operation,
      sourceRevision: observation.sourceRevision, stateRevision: snapshot.revision,
    });
  }
  if (priorForWork && priorForWork.baseIdentity === base
      && priorForWork.reconciliationGeneration > observation.reconciliationGeneration) {
    return receipt({
      outcome: 'REFUSED', refusal: 'StaleOwner', operation,
      sourceRevision: observation.sourceRevision, stateRevision: snapshot.revision,
    });
  }

  const adopted = exactDraft(await provider.lookupExact({ operationIdentity: operation, observation }), operation);
  if (adopted) {
    return commitTerminal({
      store, expectedRevision: snapshot.revision, observation, operation, base, work,
      outcome: 'SATISFIED', pullRequest: adopted,
    });
  }

  const existingIntent = activeIntent(snapshot.records, operation);
  if (existingIntent) {
    return receipt({
      outcome: 'NEEDS_RECONCILIATION', operation,
      sourceRevision: observation.sourceRevision, stateRevision: snapshot.revision,
    });
  }

  if (Object.values(observation.capacity).some((available) => available === 0)) {
    return receipt({
      outcome: 'BLOCKED', refusal: 'CapacityUnavailable', operation,
      sourceRevision: observation.sourceRevision, stateRevision: snapshot.revision,
    });
  }
  if (expectedRevision !== snapshot.revision) {
    return receipt({
      outcome: 'REFUSED', refusal: 'StaleRevision', operation,
      sourceRevision: observation.sourceRevision, stateRevision: snapshot.revision,
    });
  }

  const withIntent = await appendOrRefuse(store, expectedRevision, {
    kind: 'INTENT', operationIdentity: operation, baseIdentity: base, workIdentity: work,
    reconciliationGeneration: observation.reconciliationGeneration,
    sourceRevision: observation.sourceRevision, outcome: null, refusal: null,
    effect: EFFECT, pullRequest: null,
  }, 'StaleRevision');
  if (withIntent?.schema === DRAFT_RECONCILIATION_SCHEMA) return withIntent;

  const fenced = await store.read();
  const latestForWork = latestIntentForWork(fenced.records, work);
  if (!latestForWork || latestForWork.operationIdentity !== operation) {
    return receipt({
      outcome: 'REFUSED', refusal: 'StaleOwner', operation,
      sourceRevision: observation.sourceRevision, stateRevision: fenced.revision,
    });
  }

  let created;
  try {
    created = exactDraft(await provider.createDraft({
      operationIdentity: operation, observation,
    }), operation);
    if (!created) fail('ProviderResultInvalid', 'provider returned a non-exact Draft');
  } catch (error) {
    if (error?.code !== 'AmbiguousProviderResponse') throw error;
    const reconciled = exactDraft(
      await provider.lookupExact({ operationIdentity: operation, observation }), operation,
    );
    if (!reconciled) {
      return receipt({
        outcome: 'NEEDS_RECONCILIATION', operation,
        sourceRevision: observation.sourceRevision, stateRevision: fenced.revision,
      });
    }
    created = reconciled;
  }

  const result = await commitTerminal({
    store, expectedRevision: fenced.revision, observation, operation, base, work,
    outcome: 'CREATED', effect: EFFECT, pullRequest: created,
  });
  if (result.outcome !== 'REFUSED') telemetry?.append?.({
    type: 'gaia.draft-reconciliation', operationIdentity: operation,
    outcome: result.outcome, stateRevision: result.stateRevision,
  });
  return result;
}
