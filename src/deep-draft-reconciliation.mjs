import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
} from 'node:fs';
import { mkdir as mkdirAsync, rm as rmAsync } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  CorruptLogError, LOCK_RM_OPTIONS, LOCK_STALE_MS, LOCK_TIMEOUT_MS, LockTimeoutError,
  parseEventLog,
} from './event-log.mjs';

export const DRAFT_RECONCILIATION_SCHEMA = 'gaia-draft-reconciliation-receipt/1';
export const DRAFT_RECONCILIATION_STORE_SCHEMA = 'gaia-draft-reconciliation-store/1';
export const DRAFT_RECONCILIATION_RECORD_SCHEMA = 'gaia-draft-reconciliation-record/1';

const SHA256 = /^[a-f0-9]{64}$/u;
const OID = /^[a-f0-9]{40}$/u;
const EFFECT = 'CREATE_DRAFT';
const STORE_FIELDS = Object.freeze([
  'kind', 'operationIdentity', 'baseIdentity', 'workIdentity', 'reconciliationGeneration',
  'sourceRevision', 'outcome', 'refusal', 'effect', 'pullRequest',
]);
const TERMINAL_OUTCOMES = Object.freeze(['CREATED', 'SATISFIED', 'REFUSED']);

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

function requireStoreCandidate(candidate) {
  const keys = candidate && typeof candidate === 'object' ? Object.keys(candidate) : [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || keys.length !== STORE_FIELDS.length || keys.some((key) => !STORE_FIELDS.includes(key))
      || !['INTENT', 'TERMINAL'].includes(candidate.kind)
      || typeof candidate.operationIdentity !== 'string'
      || !SHA256.test(candidate.operationIdentity)
      || typeof candidate.baseIdentity !== 'string' || !SHA256.test(candidate.baseIdentity)
      || typeof candidate.workIdentity !== 'string' || !SHA256.test(candidate.workIdentity)
      || !Number.isSafeInteger(candidate.reconciliationGeneration)
      || candidate.reconciliationGeneration < 1
      || typeof candidate.sourceRevision !== 'string' || !SHA256.test(candidate.sourceRevision)) {
    fail('StoreRecordInvalid', 'the reconciliation record is not canonical');
  }
  const intentValid = candidate.kind === 'INTENT'
    && candidate.outcome === null && candidate.refusal === null
    && candidate.effect === EFFECT && candidate.pullRequest === null;
  const hasExactDraft = candidate.pullRequest !== null && exactDraft(
    candidate.pullRequest, candidate.operationIdentity,
  );
  const createdValid = candidate.outcome === 'CREATED' && candidate.refusal === null
    && candidate.effect === EFFECT && hasExactDraft;
  const satisfiedValid = candidate.outcome === 'SATISFIED' && candidate.refusal === null
    && candidate.effect === 'NONE' && hasExactDraft;
  const refusedValid = candidate.outcome === 'REFUSED' && typeof candidate.refusal === 'string'
    && candidate.effect === 'NONE' && candidate.pullRequest === null;
  const terminalValid = candidate.kind === 'TERMINAL'
    && TERMINAL_OUTCOMES.includes(candidate.outcome)
    && (createdValid || satisfiedValid || refusedValid);
  if (!intentValid && !terminalValid) {
    fail('StoreRecordInvalid', 'the reconciliation transition fields are incoherent');
  }
  return freeze(clone(candidate));
}

export function createMemoryDraftReconciliationStore() {
  let revision = EMPTY_REVISION;
  const records = [];
  let tail = Promise.resolve();

  const withMutex = async (operation) => {
    const prior = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const snapshot = () => freeze({
    schema: DRAFT_RECONCILIATION_STORE_SCHEMA,
    revision,
    records: clone(records),
  });

  const append = (candidate) => {
    const body = requireStoreCandidate(candidate);
    const nextRevision = sha256({ previousRevision: revision, record: body });
    records.push(freeze({ ...body, stateRevision: nextRevision }));
    revision = nextRevision;
    return snapshot();
  };

  return freeze({
    async read() {
      return withMutex(snapshot);
    },

    async compareAndSetAppend(expectedRevision, candidate) {
      if (typeof expectedRevision !== 'string' || !SHA256.test(expectedRevision)) {
        fail('StoreRequestInvalid', 'expectedRevision must be a SHA-256');
      }
      return withMutex(() => {
        if (expectedRevision !== revision) {
          fail('CasMismatch', 'the reconciliation store changed after it was observed');
        }
        return append(candidate);
      });
    },

    async runExclusive(expectedRevision, operation) {
      if (typeof expectedRevision !== 'string' || !SHA256.test(expectedRevision)
          || typeof operation !== 'function') {
        fail('StoreRequestInvalid', 'runExclusive requires a revision and operation');
      }
      return withMutex(async () => {
        if (expectedRevision !== revision) {
          fail('CasMismatch', 'the reconciliation store changed after it was observed');
        }
        let appended = false;
        return operation(freeze({
          snapshot: snapshot(),
          append(candidate) {
            if (appended) fail('StoreRequestInvalid', 'an exclusive transaction appends once');
            appended = true;
            return append(candidate);
          },
        }));
      });
    },
  });
}

function requireDirectory(directory) {
  if (typeof directory !== 'string' || directory.trim() !== directory || directory.length === 0) {
    fail('StorePathInvalid', 'directory must be explicit');
  }
  return resolve(directory);
}

export function draftReconciliationLogPath(directory) {
  return join(requireDirectory(directory), 'draft-reconciliation.jsonl');
}

export function draftReconciliationLockPath(directory) {
  return join(requireDirectory(directory), 'draft-reconciliation.lock');
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function withStoreLock(directory, operation, {
  timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS,
} = {}) {
  const root = requireDirectory(directory);
  const lock = draftReconciliationLockPath(root);
  mkdirSync(root, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdirAsync(lock);
      break;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          `could not acquire ${lock} within ${timeoutMs}ms; refusing to access the Draft `
          + `reconciliation store without its lock (fail closed; stale threshold ${staleMs}ms)`,
        );
      }
      await delay(15);
    }
  }
  try {
    return await operation();
  } finally {
    await rmAsync(lock, LOCK_RM_OPTIONS);
  }
}

function verifyDurableRecord(record, ordinal, previousRevision) {
  const fields = ['type', 'schema', 'ordinal', 'previousRevision', 'body', 'stateRevision'];
  const keys = record && typeof record === 'object' ? Object.keys(record) : [];
  if (!record || record.type !== 'gaia.draft-reconciliation.record'
      || record.schema !== DRAFT_RECONCILIATION_RECORD_SCHEMA
      || keys.length !== fields.length || keys.some((key) => !fields.includes(key))
      || record.ordinal !== ordinal || record.previousRevision !== previousRevision) {
    throw new CorruptLogError('Draft reconciliation store contains a non-contiguous record');
  }
  const body = requireStoreCandidate(record.body);
  const stateRevision = sha256({ previousRevision, record: body });
  if (record.stateRevision !== stateRevision) {
    throw new CorruptLogError('Draft reconciliation record revision does not match its content');
  }
  return freeze({ ...body, stateRevision });
}

function readDurableRecordsUnlocked(directory) {
  const path = draftReconciliationLogPath(directory);
  if (!existsSync(path)) return [];
  const envelopes = parseEventLog(readFileSync(path, 'utf8'), { source: path });
  const records = [];
  let previousRevision = EMPTY_REVISION;
  for (const [ordinal, envelope] of envelopes.entries()) {
    const record = verifyDurableRecord(envelope, ordinal, previousRevision);
    records.push(record);
    previousRevision = record.stateRevision;
  }
  return records;
}

function storeSnapshot(records) {
  return freeze({
    schema: DRAFT_RECONCILIATION_STORE_SCHEMA,
    revision: records.at(-1)?.stateRevision ?? EMPTY_REVISION,
    records: clone(records),
  });
}

function appendDurableRecord(directory, envelope) {
  const path = draftReconciliationLogPath(directory);
  appendFileSync(path, `${canonicalJson(envelope)}\n`, 'utf8');
  const descriptor = openSync(path, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function createAppendOnlyDraftReconciliationStore({ directory, lockOptions } = {}) {
  const root = requireDirectory(directory);
  const appendUnderLock = (records, candidate) => {
    const body = requireStoreCandidate(candidate);
    const before = storeSnapshot(records);
    const stateRevision = sha256({ previousRevision: before.revision, record: body });
    const envelope = freeze({
      type: 'gaia.draft-reconciliation.record',
      schema: DRAFT_RECONCILIATION_RECORD_SCHEMA,
      ordinal: records.length,
      previousRevision: before.revision,
      body,
      stateRevision,
    });
    appendDurableRecord(root, envelope);
    records.push(freeze({ ...body, stateRevision }));
    return storeSnapshot(records);
  };

  return freeze({
    async read() {
      if (!existsSync(root)) return storeSnapshot([]);
      return withStoreLock(root, () => storeSnapshot(readDurableRecordsUnlocked(root)), lockOptions);
    },

    async compareAndSetAppend(expectedRevision, candidate) {
      if (typeof expectedRevision !== 'string' || !SHA256.test(expectedRevision)) {
        fail('StoreRequestInvalid', 'expectedRevision must be a SHA-256');
      }
      const body = requireStoreCandidate(candidate);
      return withStoreLock(root, () => {
        const records = readDurableRecordsUnlocked(root);
        const before = storeSnapshot(records);
        if (before.revision !== expectedRevision) {
          fail('CasMismatch', 'the reconciliation store changed after it was observed');
        }
        return appendUnderLock(records, body);
      }, lockOptions);
    },

    async runExclusive(expectedRevision, operation) {
      if (typeof expectedRevision !== 'string' || !SHA256.test(expectedRevision)
          || typeof operation !== 'function') {
        fail('StoreRequestInvalid', 'runExclusive requires a revision and operation');
      }
      return withStoreLock(root, async () => {
        const records = readDurableRecordsUnlocked(root);
        const before = storeSnapshot(records);
        if (before.revision !== expectedRevision) {
          fail('CasMismatch', 'the reconciliation store changed after it was observed');
        }
        let appended = false;
        return operation(freeze({
          snapshot: before,
          append(candidate) {
            if (appended) fail('StoreRequestInvalid', 'an exclusive transaction appends once');
            appended = true;
            return appendUnderLock(records, candidate);
          },
        }));
      }, lockOptions);
    },
  });
}

function githubOperationMarker(operationIdentity) {
  return `<!-- gaia-draft-operation:${operationIdentity} -->`;
}

function githubResultBody(result) {
  return result && typeof result === 'object' && 'data' in result ? result.data : result;
}

function exactGitHubDraft(candidate, operationIdentity, observation) {
  const marker = githubOperationMarker(operationIdentity);
  if (!candidate || typeof candidate !== 'object'
      || !Number.isSafeInteger(candidate.number) || candidate.number < 1
      || candidate.draft !== true || candidate.state !== 'open'
      || candidate.head?.ref !== observation.headBranch
      || candidate.head?.sha !== observation.evidenceHeadOid
      || candidate.base?.ref !== observation.baseBranch
      || typeof candidate.body !== 'string'
      || !candidate.body.split(/\r?\n/u).includes(marker)) return null;
  return freeze({
    number: candidate.number,
    url: typeof candidate.html_url === 'string' ? candidate.html_url : null,
    isDraft: true,
    state: 'OPEN',
    operationIdentity,
  });
}

/**
 * Production-shaped GitHub adapter. The injected request function is the only transport seam.
 * A 422 is ambiguous, never proof of duplicate serialization: it is reconciled by exact identity
 * instead of being retried. Provider serialization remains a promotion gate documented by R0.
 */
export function createGitHubDraftProvider({ request } = {}) {
  if (typeof request !== 'function') {
    fail('AdapterInvalid', 'the GitHub adapter requires one request function');
  }

  const lookupExact = async ({ operationIdentity, observation }) => {
    if (!SHA256.test(operationIdentity) || requireObservation(observation)) {
      fail('ProviderRequestInvalid', 'GitHub lookup requires canonical operation evidence');
    }
    const repositoryPath = `/repos/${encodeURIComponent(observation.organization)}`
      + `/${encodeURIComponent(observation.repository)}/pulls`;
    const response = githubResultBody(await request({
      method: 'GET',
      path: repositoryPath,
      query: {
        state: 'open', base: observation.baseBranch,
        head: `${observation.organization}:${observation.headBranch}`,
      },
    }));
    if (!Array.isArray(response)) {
      fail('ProviderResultInvalid', 'GitHub pull lookup did not return a list');
    }
    const exact = response
      .map((candidate) => exactGitHubDraft(candidate, operationIdentity, observation))
      .filter(Boolean);
    if (exact.length > 1) {
      fail('ProviderEvidenceAmbiguous', 'GitHub returned more than one exact Draft');
    }
    return exact[0] ?? null;
  };

  return freeze({
    lookupExact,

    async createDraft({ operationIdentity, observation }) {
      if (!SHA256.test(operationIdentity) || requireObservation(observation)) {
        fail('ProviderRequestInvalid', 'GitHub create requires canonical operation evidence');
      }
      const repositoryPath = `/repos/${encodeURIComponent(observation.organization)}`
        + `/${encodeURIComponent(observation.repository)}/pulls`;
      const marker = githubOperationMarker(operationIdentity);
      try {
        const response = githubResultBody(await request({
          method: 'POST',
          path: repositoryPath,
          body: {
            title: `Draft: ${observation.workItem}`,
            head: observation.headBranch,
            base: observation.baseBranch,
            draft: true,
            body: `${marker}\n\nManaged by Gaia reconciliation for ${observation.workItem}.`,
          },
        }));
        const exact = exactGitHubDraft(response, operationIdentity, observation);
        if (!exact) fail('ProviderResultInvalid', 'GitHub created a non-exact Draft');
        return exact;
      } catch (error) {
        if (error?.status !== 422) throw error;
        const reconciled = await lookupExact({ operationIdentity, observation });
        if (reconciled) return reconciled;
        fail('AmbiguousProviderResponse',
          'GitHub refused Draft creation but no exact operation is observable');
      }
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
    && Number.isSafeInteger(candidate.number) && candidate.number > 0
    && candidate.isDraft === true && candidate.state === 'OPEN'
    && (candidate.url === undefined || candidate.url === null || typeof candidate.url === 'string')
    ? freeze({
      number: candidate.number,
      url: candidate.url ?? null,
      isDraft: true,
      state: 'OPEN',
      operationIdentity: operation,
    }) : null;
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
      || typeof ports.store?.runExclusive !== 'function'
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
  const priorTerminalForWork = snapshot.records.findLast(
    (record) => record.kind === 'TERMINAL' && record.workIdentity === work,
  );
  if (priorTerminalForWork && priorTerminalForWork.operationIdentity !== operation) {
    return receipt({
      outcome: 'REFUSED', refusal: 'CrossGenerationIntent', operation,
      sourceRevision: observation.sourceRevision, stateRevision: snapshot.revision,
    });
  }
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

  let result;
  try {
    result = await store.runExclusive(withIntent.revision, async (transaction) => {
      const latestForWork = latestIntentForWork(transaction.snapshot.records, work);
      if (!latestForWork || latestForWork.operationIdentity !== operation) {
        return receipt({
          outcome: 'REFUSED', refusal: 'StaleOwner', operation,
          sourceRevision: observation.sourceRevision,
          stateRevision: transaction.snapshot.revision,
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
            sourceRevision: observation.sourceRevision,
            stateRevision: transaction.snapshot.revision,
          });
        }
        created = reconciled;
      }

      const appended = transaction.append({
        kind: 'TERMINAL', operationIdentity: operation, baseIdentity: base, workIdentity: work,
        reconciliationGeneration: observation.reconciliationGeneration,
        sourceRevision: observation.sourceRevision, outcome: 'CREATED', refusal: null,
        effect: EFFECT, pullRequest: created,
      });
      return receiptFromTerminal(appended.records.at(-1));
    });
  } catch (error) {
    if (error?.code === 'CasMismatch') {
      const current = await store.read();
      const completed = current.records.findLast(
        (record) => record.kind === 'TERMINAL' && record.operationIdentity === operation,
      );
      if (completed) return receiptFromTerminal(completed);
      return receipt({
        outcome: 'REFUSED', refusal: 'StaleOwner', operation,
        sourceRevision: observation.sourceRevision, stateRevision: current.revision,
      });
    }
    throw error;
  }
  if (result.outcome !== 'REFUSED' && typeof telemetry?.append === 'function') {
    try {
      await telemetry.append({
        type: 'gaia.draft-reconciliation', operationIdentity: operation,
        outcome: result.outcome, stateRevision: result.stateRevision,
      });
    } catch {
      // Telemetry is observational. Durable reconciliation has already completed.
    }
  }
  return result;
}
