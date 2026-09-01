import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const TERMINAL = new Set(['CREATED', 'REUSED', 'REFUSED', 'CANCELLED']);
const EPOCH_STATES = new Set(['CLAIMED', 'INTENT', 'EFFECT_STARTED']);

export class DraftOperationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'DraftOperationError';
    this.code = code;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function contentRevision(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function closedObject(entries) {
  const value = Object.create(null);
  for (const [key, child] of entries) value[key] = child;
  return Object.freeze(value);
}

function deepOwnedFrozen(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(deepOwnedFrozen));
  const owned = Object.create(null);
  for (const key of Object.keys(value)) owned[key] = deepOwnedFrozen(value[key]);
  return Object.freeze(owned);
}

function ownDataKeys(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DraftOperationError(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new DraftOperationError(code);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw new DraftOperationError(code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new DraftOperationError(code);
    }
  }
  return keys;
}

function requireExactKeys(value, expected, code) {
  const keys = ownDataKeys(value, code).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new DraftOperationError(code);
  }
}

function requireString(value, code) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DraftOperationError(code);
  }
  return value;
}

function requireRevision(value, code = 'InvalidRevision') {
  if (!SHA256.test(value)) throw new DraftOperationError(code);
  return value;
}

function requireGitOid(value, code) {
  if (!GIT_OID.test(value)) throw new DraftOperationError(code);
  return value;
}

function validateSelector(selector) {
  const code = 'InvalidSelector';
  requireExactKeys(selector, ['repository', 'workItem'], code);
  requireExactKeys(selector.repository, ['owner', 'name'], code);
  requireExactKeys(selector.workItem, ['kind', 'number'], code);
  const owner = requireString(selector.repository.owner, code);
  const name = requireString(selector.repository.name, code);
  if (selector.workItem.kind !== 'ISSUE'
    || !Number.isSafeInteger(selector.workItem.number)
    || selector.workItem.number <= 0) throw new DraftOperationError(code);
  return closedObject([
    ['repository', closedObject([['owner', owner], ['name', name]])],
    ['workItem', closedObject([['kind', 'ISSUE'], ['number', selector.workItem.number]])],
  ]);
}

function validateEnvelope(input, selector) {
  const code = 'InvalidEnvelope';
  requireExactKeys(input, [
    'schema', 'repository', 'workItem', 'readyItem', 'observedSourceRevision',
    'generation', 'requestedEffect',
  ], code);
  if (input.schema !== 'GaiaDraftOperationEnvelopeV0' || input.requestedEffect !== 'CREATE_DRAFT') {
    throw new DraftOperationError(code);
  }

  requireExactKeys(input.repository, ['nodeId', 'owner', 'name'], code);
  const repository = closedObject([
    ['nodeId', requireString(input.repository.nodeId, code)],
    ['owner', requireString(input.repository.owner, code)],
    ['name', requireString(input.repository.name, code)],
  ]);

  requireExactKeys(input.workItem, ['kind', 'number'], code);
  if (input.workItem.kind !== 'ISSUE'
    || !Number.isSafeInteger(input.workItem.number)
    || input.workItem.number <= 0
    || input.workItem.number !== selector.workItem.number) throw new DraftOperationError(code);
  const workItem = closedObject([['kind', 'ISSUE'], ['number', input.workItem.number]]);

  requireExactKeys(input.readyItem, ['schema', 'queueReceiptRevision', 'occurrence', 'id'], code);
  if (input.readyItem.schema !== 'GaiaReadyItemIdentityV0'
    || !Number.isSafeInteger(input.readyItem.occurrence)
    || input.readyItem.occurrence <= 0) throw new DraftOperationError(code);
  const queueReceiptRevision = requireRevision(input.readyItem.queueReceiptRevision, code);
  const suppliedReadyItemId = requireRevision(input.readyItem.id, code);
  const observedSourceRevision = requireRevision(input.observedSourceRevision, code);

  requireExactKeys(input.generation, ['baseRef', 'headRef', 'headRevision', 'policyRevision'], code);
  const generation = closedObject([
    ['baseRef', requireString(input.generation.baseRef, code)],
    ['headRef', requireString(input.generation.headRef, code)],
    ['headRevision', requireGitOid(input.generation.headRevision, code)],
    ['policyRevision', requireGitOid(input.generation.policyRevision, code)],
  ]);

  const workKey = contentRevision({
    schema: 'GaiaDraftWorkKeyV0',
    repositoryNodeId: repository.nodeId,
    workItem,
    requestedEffect: 'CREATE_DRAFT',
  });
  const expectedReadyItemId = contentRevision({
    schema: 'GaiaReadyItemIdV0',
    workKey,
    queueReceiptRevision,
    occurrence: input.readyItem.occurrence,
    observedSourceRevision,
  });
  if (suppliedReadyItemId !== expectedReadyItemId) throw new DraftOperationError(code);
  const readyItem = closedObject([
    ['schema', 'GaiaReadyItemIdentityV0'],
    ['queueReceiptRevision', queueReceiptRevision],
    ['occurrence', input.readyItem.occurrence],
    ['id', suppliedReadyItemId],
  ]);
  const envelope = closedObject([
    ['schema', 'GaiaDraftOperationEnvelopeV0'],
    ['repository', repository],
    ['workItem', workItem],
    ['readyItem', readyItem],
    ['observedSourceRevision', observedSourceRevision],
    ['generation', generation],
    ['requestedEffect', 'CREATE_DRAFT'],
  ]);
  const generationKey = contentRevision({
    schema: 'GaiaDraftGenerationKeyV0', readyItemId: readyItem.id, generation,
  });
  const operationId = contentRevision({
    schema: 'GaiaDraftOperationIdV0', workKey, generationKey,
  });
  return { envelope, workKey, generationKey, operationId };
}

function validateExpectedRevision(value) {
  if (value !== 'NONE') requireRevision(value);
  return value;
}

function makeRecord(kind, priorCommittedRevision, identity, payload = {}) {
  const entries = [
    ['schema', 'GaiaDraftOperationReceiptV0'],
    ['priorCommittedRevision', priorCommittedRevision],
    ['kind', kind],
    ['workKey', identity.workKey],
  ];
  if (identity.generationKey) entries.push(['generationKey', identity.generationKey]);
  if (identity.operationId) entries.push(['operationId', identity.operationId]);
  for (const [key, value] of Object.entries(payload)) entries.push([key, value]);
  return closedObject(entries);
}

const draftStoreCapabilities = new WeakMap();

class MemoryDraftOperationStore {
  #work = new Map();
  #operations = new Map();
  #locks = new Map();
  #executors = new Map();

  constructor() {
    draftStoreCapabilities.set(this, Object.freeze({
      bootstrapAndEnqueue: this.#bootstrapAndEnqueue.bind(this),
      append: this.#append.bind(this),
      withExecutor: this.#withExecutor.bind(this),
      inspectByWork: this.#inspectByWork.bind(this),
      inspectByOperation: this.#inspectByOperation.bind(this),
      listUnsettled: this.#listUnsettled.bind(this),
    }));
  }

  async #exclusive(lockMap, key, action) {
    const prior = lockMap.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = prior.then(() => gate);
    lockMap.set(key, tail);
    await prior;
    try {
      return await action();
    } finally {
      release();
      if (lockMap.get(key) === tail) lockMap.delete(key);
    }
  }

  #withExecutor(workKey, action) {
    return this.#exclusive(this.#executors, workKey, action);
  }

  async #bootstrapAndEnqueue(identity, envelope, expectedCommittedRevision) {
    return this.#exclusive(this.#locks, identity.workKey, async () => {
      const current = this.#work.get(identity.workKey);
      if (current || expectedCommittedRevision !== 'NONE') {
        return { stale: true, currentCommittedRevision: current?.committedRevision ?? 'NONE' };
      }
      const rootBody = closedObject([
        ['schema', 'GaiaDraftWorkRootV0'],
        ['priorCommittedRevision', 'NONE'],
        ['kind', 'WORK_ROOT'],
        ['workKey', identity.workKey],
      ]);
      const rootRevision = contentRevision(rootBody);
      const enqueued = makeRecord('ENQUEUED', rootRevision, identity, { envelope });
      const committedRevision = contentRevision(enqueued);
      const storedIdentity = closedObject([
        ['workKey', identity.workKey],
        ['generationKey', identity.generationKey],
        ['operationId', identity.operationId],
      ]);
      const work = {
        identity: storedIdentity, envelope, records: [
          { body: rootBody, committedRevision: rootRevision },
          { body: enqueued, committedRevision },
        ],
        committedRevision,
        state: 'ENQUEUED',
        executorEpoch: null,
        terminal: null,
      };
      this.#work.set(identity.workKey, work);
      this.#operations.set(identity.operationId, identity.workKey);
      return { stale: false, committedRevision };
    });
  }

  async #inspectByWork(workKey) {
    return this.#exclusive(this.#locks, workKey, async () => this.#snapshot(this.#work.get(workKey)));
  }

  async #inspectByOperation(operationId) {
    const workKey = this.#operations.get(operationId);
    if (!workKey) return null;
    return this.#inspectByWork(workKey);
  }

  async #listUnsettled() {
    const unsettled = [];
    for (const workKey of [...this.#work.keys()].sort()) {
      const snapshot = await this.#inspectByWork(workKey);
      if (snapshot && !snapshot.terminal) unsettled.push(snapshot);
    }
    return Object.freeze(unsettled);
  }

  async inspectByWork(workKey) {
    return this.#inspectByWork(workKey);
  }

  async inspectByOperation(operationId) {
    return this.#inspectByOperation(operationId);
  }

  async #append(operationId, expectedCommittedRevision, kind, payload = {}) {
    const workKey = this.#operations.get(operationId);
    if (!workKey) throw new DraftOperationError('UnknownOperation');
    return this.#exclusive(this.#locks, workKey, async () => {
      const work = this.#work.get(workKey);
      if (work.committedRevision !== expectedCommittedRevision) {
        return { stale: true, current: this.#snapshot(work) };
      }
      const body = makeRecord(kind, expectedCommittedRevision, work.identity, payload);
      const committedRevision = contentRevision(body);
      work.records.push({ body, committedRevision });
      work.committedRevision = committedRevision;
      work.state = kind;
      if (EPOCH_STATES.has(kind)) work.executorEpoch = payload.executorEpoch;
      if (TERMINAL.has(kind)) work.terminal = { ...payload, outcome: kind, committedRevision };
      return { stale: false, current: this.#snapshot(work) };
    });
  }

  async readHead(workKey) {
    const snapshot = await this.#inspectByWork(workKey);
    if (!snapshot) return Object.freeze({ state: 'UNSEEN' });
    return Object.freeze({
      state: 'PRESENT', committedRevision: snapshot.committedRevision,
      recordKind: snapshot.state,
    });
  }

  #snapshot(work) {
    if (!work) return null;
    return deepOwnedFrozen({
      identity: work.identity,
      envelope: work.envelope,
      committedRevision: work.committedRevision,
      state: work.state,
      executorEpoch: work.executorEpoch,
      terminal: work.terminal,
    });
  }
}

const REGISTRY_REF = 'refs/heads/gaia-ledger/registry-v0';
const WORK_REF_PREFIX = 'refs/heads/gaia-ledger/draft-operations-v0/';

function validateGitDataRecord(record, priorCommittedRevision) {
  const code = 'LedgerCorrupt';
  ownDataKeys(record, code);
  const hasTransportMetadata = record?.body?.kind === 'CONFIRMED';
  requireExactKeys(record, hasTransportMetadata
    ? ['oid', 'body', 'committedRevision', 'transportMetadata']
    : ['oid', 'body', 'committedRevision'], code);
  requireGitOid(record.oid, code);
  requireRevision(record.committedRevision, code);
  ownDataKeys(record.body, code);
  if (hasTransportMetadata) {
    requireExactKeys(record.transportMetadata, ['workRootOid'], code);
    requireGitOid(record.transportMetadata.workRootOid, code);
  }
  if (record.body.priorCommittedRevision !== priorCommittedRevision
    || contentRevision(record.body) !== record.committedRevision) throw new DraftOperationError(code);
  return record;
}

function validateGitDataSnapshot(snapshot) {
  const code = 'LedgerCorrupt';
  if (snapshot?.state === 'UNSEEN') {
    requireExactKeys(snapshot, ['state'], code);
    return { state: 'UNSEEN' };
  }
  requireExactKeys(snapshot, ['state', 'records'], code);
  if (snapshot.state !== 'PRESENT' || !Array.isArray(snapshot.records)
    || snapshot.records.length === 0) throw new DraftOperationError(code);
  let prior = 'NONE';
  const records = snapshot.records.map((record) => {
    const validated = validateGitDataRecord(record, prior);
    prior = validated.committedRevision;
    return validated;
  });
  return {
    state: 'PRESENT', records,
    headOid: records.at(-1).oid, committedRevision: records.at(-1).committedRevision,
  };
}

function validateLedgerTransition(previous, next) {
  const allowed = {
    ENQUEUED: new Set(['CLAIMED', 'REUSED', 'REFUSED', 'CANCELLED']),
    CLAIMED: new Set(['CLAIMED', 'INTENT', 'REUSED', 'REFUSED', 'CANCELLED']),
    INTENT: new Set(['CLAIMED', 'INTENT', 'EFFECT_STARTED', 'REUSED', 'REFUSED', 'CANCELLED']),
    EFFECT_STARTED: new Set(['EFFECT_AMBIGUOUS', 'CREATED', 'REUSED']),
    EFFECT_AMBIGUOUS: new Set(['REUSED']),
  };
  if (!allowed[previous]?.has(next)) throw new DraftOperationError('LedgerCorrupt');
}

function validateLedgerEpoch(value) {
  requireExactKeys(value, ['runId', 'runAttempt'], 'LedgerCorrupt');
  if (!Number.isSafeInteger(value.runId) || value.runId <= 0
    || !Number.isSafeInteger(value.runAttempt) || value.runAttempt <= 0) {
    throw new DraftOperationError('LedgerCorrupt');
  }
}

function sameLedgerEpoch(left, right) {
  return left?.runId === right?.runId && left?.runAttempt === right?.runAttempt;
}

function isSuccessorLedgerEpoch(next, previous) {
  return next.runId > previous.runId
    || next.runId === previous.runId && next.runAttempt > previous.runAttempt;
}

function validateOperationRecord(record, identity, envelope, previous) {
  const common = [
    'schema', 'priorCommittedRevision', 'kind', 'workKey', 'generationKey', 'operationId',
  ];
  const { body } = record;
  if (body.schema !== 'GaiaDraftOperationReceiptV0'
    || body.workKey !== identity.workKey
    || body.generationKey !== identity.generationKey
    || body.operationId !== identity.operationId) throw new DraftOperationError('LedgerCorrupt');
  validateLedgerTransition(previous, body.kind);
  if (['CLAIMED', 'INTENT', 'EFFECT_STARTED'].includes(body.kind)) {
    requireExactKeys(body, [...common, 'executorEpoch'], 'LedgerCorrupt');
    validateLedgerEpoch(body.executorEpoch);
    return null;
  }
  if (body.kind === 'EFFECT_AMBIGUOUS') {
    requireExactKeys(body, [...common, 'providerError'], 'LedgerCorrupt');
    if (body.providerError !== 'ProviderAmbiguous') throw new DraftOperationError('LedgerCorrupt');
    return null;
  }
  if (body.kind === 'CREATED' || body.kind === 'REUSED') {
    requireExactKeys(body, [...common, 'pullRequest'], 'LedgerCorrupt');
    const pullRequest = sanitizeExactDraft(
      body.pullRequest, providerRequest({ identity, envelope }),
    );
    if (!pullRequest) throw new DraftOperationError('LedgerCorrupt');
    return { outcome: body.kind, pullRequest, committedRevision: record.committedRevision };
  }
  if (body.kind === 'REFUSED') {
    requireExactKeys(body, [...common, 'refusal'], 'LedgerCorrupt');
    return {
      outcome: 'REFUSED', refusal: requireString(body.refusal, 'LedgerCorrupt'),
      committedRevision: record.committedRevision,
    };
  }
  if (body.kind === 'CANCELLED') {
    requireExactKeys(body, common, 'LedgerCorrupt');
    return { outcome: 'CANCELLED', committedRevision: record.committedRevision };
  }
  throw new DraftOperationError('LedgerCorrupt');
}

class GitDataDraftOperationStore {
  #gitData;
  #config;
  #locks = new Map();
  #executors = new Map();

  constructor({ gitData, config }) {
    const code = 'InvalidLedgerPorts';
    requireExactKeys({ gitData, config }, ['gitData', 'config'], code);
    requireExactKeys(config, ['ledgerRegistryRootOid', 'ledgerRegistryRootRevision'], code);
    if (typeof gitData?.verifyProtection !== 'function'
      || typeof gitData?.read !== 'function'
      || typeof gitData?.readByOperation !== 'function'
      || typeof gitData?.compareAndAppend !== 'function') throw new DraftOperationError(code);
    this.#gitData = gitData;
    this.#config = Object.freeze({
      ledgerRegistryRootOid: requireGitOid(config.ledgerRegistryRootOid, code),
      ledgerRegistryRootRevision: requireRevision(config.ledgerRegistryRootRevision, code),
    });
    draftStoreCapabilities.set(this, Object.freeze({
      bootstrapAndEnqueue: this.#bootstrapAndEnqueue.bind(this),
      inspectByWork: this.#inspectByWork.bind(this),
      append: this.#appendOperation.bind(this),
      withExecutor: this.#withExecutor.bind(this),
      inspectByOperation: this.#inspectByOperation.bind(this),
      listUnsettled: this.#listUnsettled.bind(this),
    }));
  }

  #withExecutor(workKey, action) {
    return this.#exclusiveMap(this.#executors, workKey, action);
  }

  #exclusiveMap(map, key, action) {
    const prior = map.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = prior.then(() => gate);
    map.set(key, tail);
    return prior.then(async () => {
      try {
        return await action();
      } finally {
        release();
        if (map.get(key) === tail) map.delete(key);
      }
    });
  }

  async #exclusive(key, action) {
    return this.#exclusiveMap(this.#locks, key, action);
  }

  async #registry() {
    const snapshot = validateGitDataSnapshot(await this.#gitData.read(REGISTRY_REF));
    if (snapshot.state !== 'PRESENT') throw new DraftOperationError('LedgerRegistryMissing');
    const root = snapshot.records[0];
    requireExactKeys(root.body, ['schema', 'priorCommittedRevision', 'kind'], 'LedgerCorrupt');
    if (root.oid !== this.#config.ledgerRegistryRootOid
      || root.committedRevision !== this.#config.ledgerRegistryRootRevision
      || root.body.schema !== 'GaiaDraftRegistryRootV0'
      || root.body.kind !== 'REGISTRY_ROOT') throw new DraftOperationError('LedgerRegistryMismatch');
    const entries = new Map();
    for (const record of snapshot.records.slice(1)) {
      if (record.body.kind === 'RESERVED') {
        requireExactKeys(record.body, [
          'schema', 'priorCommittedRevision', 'kind', 'workKey',
        ], 'LedgerCorrupt');
        requireRevision(record.body.workKey, 'LedgerCorrupt');
        if (entries.has(record.body.workKey)) throw new DraftOperationError('LedgerCorrupt');
        entries.set(record.body.workKey, { state: 'RESERVED' });
      } else if (record.body.kind === 'CONFIRMED') {
        requireExactKeys(record.body, [
          'schema', 'priorCommittedRevision', 'kind', 'workKey',
          'bootstrapCommittedRevision',
        ], 'LedgerCorrupt');
        requireRevision(record.body.workKey, 'LedgerCorrupt');
        requireRevision(record.body.bootstrapCommittedRevision, 'LedgerCorrupt');
        if (entries.get(record.body.workKey)?.state !== 'RESERVED') {
          throw new DraftOperationError('LedgerCorrupt');
        }
        entries.set(record.body.workKey, {
          state: 'CONFIRMED',
          bootstrapCommittedRevision: record.body.bootstrapCommittedRevision,
          bootstrapOid: record.transportMetadata.workRootOid,
        });
      } else {
        throw new DraftOperationError('LedgerCorrupt');
      }
    }
    return { ...snapshot, entries };
  }

  #parseWorkSnapshot(workKey, snapshotInput) {
    const snapshot = validateGitDataSnapshot(snapshotInput);
    if (snapshot.state === 'UNSEEN') return null;
    const root = snapshot.records[0];
    requireExactKeys(root.body, [
      'schema', 'priorCommittedRevision', 'kind', 'workKey',
    ], 'LedgerCorrupt');
    if (root.body.schema !== 'GaiaDraftWorkRootV0' || root.body.kind !== 'WORK_ROOT'
      || root.body.workKey !== workKey) throw new DraftOperationError('LedgerCorrupt');
    const enqueued = snapshot.records[1];
    if (!enqueued) throw new DraftOperationError('LedgerCorrupt');
    requireExactKeys(enqueued.body, [
      'schema', 'priorCommittedRevision', 'kind', 'workKey',
      'generationKey', 'operationId', 'envelope',
    ], 'LedgerCorrupt');
    if (enqueued.body.schema !== 'GaiaDraftOperationReceiptV0'
      || enqueued.body.kind !== 'ENQUEUED'
      || enqueued.body.workKey !== workKey) throw new DraftOperationError('LedgerCorrupt');
    const selector = {
      repository: {
        owner: enqueued.body.envelope.repository.owner,
        name: enqueued.body.envelope.repository.name,
      },
      workItem: {
        kind: enqueued.body.envelope.workItem.kind,
        number: enqueued.body.envelope.workItem.number,
      },
    };
    const identity = validateEnvelope(enqueued.body.envelope, validateSelector(selector));
    if (identity.workKey !== workKey
      || identity.generationKey !== enqueued.body.generationKey
      || identity.operationId !== enqueued.body.operationId) throw new DraftOperationError('LedgerCorrupt');
    let state = 'ENQUEUED';
    let executorEpoch = null;
    let terminal = null;
    for (const record of snapshot.records.slice(2)) {
      if (terminal) throw new DraftOperationError('LedgerCorrupt');
      terminal = validateOperationRecord(record, identity, identity.envelope, state);
      if (EPOCH_STATES.has(record.body.kind)) {
        if (EPOCH_STATES.has(state)) {
          const validEpoch = state === record.body.kind
            ? isSuccessorLedgerEpoch(record.body.executorEpoch, executorEpoch)
            : state === 'INTENT' && record.body.kind === 'CLAIMED'
              ? isSuccessorLedgerEpoch(record.body.executorEpoch, executorEpoch)
              : sameLedgerEpoch(record.body.executorEpoch, executorEpoch);
          if (!validEpoch) throw new DraftOperationError('LedgerCorrupt');
        }
        executorEpoch = record.body.executorEpoch;
      }
      state = record.body.kind;
    }
    return {
      identity: {
        workKey: identity.workKey,
        generationKey: identity.generationKey,
        operationId: identity.operationId,
      },
      envelope: identity.envelope,
      bootstrapCommittedRevision: root.committedRevision,
      bootstrapOid: root.oid,
      headOid: snapshot.headOid,
      committedRevision: snapshot.committedRevision,
      state,
      executorEpoch,
      terminal,
    };
  }

  async #readWork(workKey) {
    return this.#parseWorkSnapshot(
      workKey, await this.#gitData.read(`${WORK_REF_PREFIX}${workKey}`),
    );
  }

  async #readBootstrapRoot(workKey) {
    const snapshot = validateGitDataSnapshot(
      await this.#gitData.read(`${WORK_REF_PREFIX}${workKey}`),
    );
    if (snapshot.state === 'UNSEEN') return null;
    const root = snapshot.records[0];
    requireExactKeys(root.body, [
      'schema', 'priorCommittedRevision', 'kind', 'workKey',
    ], 'LedgerCorrupt');
    if (root.body.schema !== 'GaiaDraftWorkRootV0'
      || root.body.priorCommittedRevision !== 'NONE'
      || root.body.kind !== 'WORK_ROOT'
      || root.body.workKey !== workKey) throw new DraftOperationError('LedgerCorrupt');
    return {
      oid: root.oid,
      committedRevision: root.committedRevision,
      rootOnly: snapshot.records.length === 1,
    };
  }

  #snapshot(work) {
    if (!work) return null;
    return deepOwnedFrozen({
      identity: work.identity,
      envelope: work.envelope,
      committedRevision: work.committedRevision,
      state: work.state,
      executorEpoch: work.executorEpoch,
      terminal: work.terminal,
    });
  }

  async #stateByWork(workKey) {
    const [registry, work] = await Promise.all([this.#registry(), this.#readWork(workKey)]);
    const entry = registry.entries.get(workKey);
    if (!work && entry) throw new DraftOperationError('LedgerWorkMissing');
    if (work && entry?.state !== 'CONFIRMED') throw new DraftOperationError('LedgerCorrupt');
    if (work && entry.bootstrapCommittedRevision !== work.bootstrapCommittedRevision) {
      throw new DraftOperationError('LedgerCorrupt');
    }
    if (work && entry.bootstrapOid !== work.bootstrapOid) {
      throw new DraftOperationError('LedgerCorrupt');
    }
    return work;
  }

  #validateRegisteredWork(registry, work) {
    if (!work) return null;
    const entry = registry.entries.get(work.identity.workKey);
    if (entry?.state !== 'CONFIRMED'
      || entry.bootstrapCommittedRevision !== work.bootstrapCommittedRevision
      || entry.bootstrapOid !== work.bootstrapOid) {
      throw new DraftOperationError('LedgerCorrupt');
    }
    return work;
  }

  async #inspectByWork(workKey) {
    const registry = await this.#registry();
    const entry = registry.entries.get(workKey);
    if (entry?.state === 'RESERVED') {
      const root = await this.#readBootstrapRoot(workKey);
      if (root && !root.rootOnly) throw new DraftOperationError('LedgerCorrupt');
      return null;
    }
    if (entry?.state === 'CONFIRMED') {
      const root = await this.#readBootstrapRoot(workKey);
      if (root?.rootOnly) {
        if (entry.bootstrapCommittedRevision !== root.committedRevision) {
          throw new DraftOperationError('LedgerCorrupt');
        }
        if (entry.bootstrapOid !== root.oid) throw new DraftOperationError('LedgerCorrupt');
        return null;
      }
    }
    return this.#snapshot(await this.#stateByWork(workKey));
  }

  async #inspectByOperation(operationId) {
    return this.#snapshot(await this.#stateByOperation(operationId));
  }

  async #listUnsettled() {
    const registry = await this.#registry();
    const unsettled = [];
    for (const workKey of [...registry.entries.keys()].sort()) {
      const snapshot = await this.#inspectByWork(workKey);
      if (snapshot && !snapshot.terminal) unsettled.push(snapshot);
    }
    return Object.freeze(unsettled);
  }

  async #stateByOperation(operationId) {
    const observed = await this.#gitData.readByOperation(operationId);
    const located = validateGitDataSnapshot(observed);
    if (located.state === 'UNSEEN') return null;
    const workKey = located.records[0]?.body?.workKey;
    requireRevision(workKey, 'LedgerCorrupt');
    const work = this.#parseWorkSnapshot(workKey, observed);
    if (work.identity.operationId !== operationId) throw new DraftOperationError('LedgerCorrupt');
    return this.#validateRegisteredWork(await this.#registry(), work);
  }

  async #append(ref, expectedHeadOid, body, transportMetadata) {
    const protectedRefs = await this.#gitData.verifyProtection({
      prefix: 'refs/heads/gaia-ledger/',
      registryRootOid: this.#config.ledgerRegistryRootOid,
    });
    if (protectedRefs !== true) throw new DraftOperationError('LedgerProtectionMissing');
    const result = await this.#gitData.compareAndAppend(
      ref, expectedHeadOid, body, transportMetadata,
    );
    if (result?.kind === 'STALE') return { stale: true };
    requireExactKeys(result, transportMetadata === undefined
      ? ['kind', 'oid', 'body', 'committedRevision']
      : ['kind', 'oid', 'body', 'committedRevision', 'transportMetadata'], 'LedgerCorrupt');
    if (result.kind !== 'APPENDED'
      || result.committedRevision !== contentRevision(body)) throw new DraftOperationError('LedgerCorrupt');
    if (transportMetadata !== undefined
      && result.transportMetadata?.workRootOid !== transportMetadata.workRootOid) {
      throw new DraftOperationError('LedgerCorrupt');
    }
    const record = {
      oid: result.oid, body: result.body, committedRevision: result.committedRevision,
    };
    if (transportMetadata !== undefined) record.transportMetadata = result.transportMetadata;
    validateGitDataRecord(record, body.priorCommittedRevision);
    return { stale: false, ...result };
  }

  async #appendOperation(operationId, expectedCommittedRevision, kind, payload = {}) {
    requireRevision(operationId, 'InvalidOperationId');
    requireRevision(expectedCommittedRevision);
    const located = await this.#stateByOperation(operationId);
    if (!located) throw new DraftOperationError('UnknownOperation');
    const workKey = located.identity.workKey;
    return this.#exclusive(workKey, async () => {
      const work = await this.#stateByWork(workKey);
      if (work.committedRevision !== expectedCommittedRevision) {
        return { stale: true, current: this.#snapshot(work) };
      }
      const body = makeRecord(kind, expectedCommittedRevision, work.identity, payload);
      const appended = await this.#append(
        `${WORK_REF_PREFIX}${workKey}`, work.headOid, body,
      );
      if (appended.stale) {
        return { stale: true, current: this.#snapshot(await this.#stateByWork(workKey)) };
      }
      return { stale: false, current: this.#snapshot(await this.#stateByWork(workKey)) };
    });
  }

  async #bootstrapAndEnqueue(identity, envelope, expectedCommittedRevision) {
    return this.#exclusive(identity.workKey, async () => {
      if (expectedCommittedRevision !== 'NONE') {
        return { stale: true, currentCommittedRevision: 'NONE' };
      }
      let registry = await this.#registry();
      let entry = registry.entries.get(identity.workKey);
      const rootBody = closedObject([
        ['schema', 'GaiaDraftWorkRootV0'],
        ['priorCommittedRevision', 'NONE'],
        ['kind', 'WORK_ROOT'],
        ['workKey', identity.workKey],
      ]);
      const workRef = `${WORK_REF_PREFIX}${identity.workKey}`;
      let root = await this.#readBootstrapRoot(identity.workKey);
      if (!entry) {
        if (root) throw new DraftOperationError('LedgerCorrupt');
        const reservedBody = closedObject([
          ['schema', 'GaiaDraftRegistryReceiptV0'],
          ['priorCommittedRevision', registry.committedRevision],
          ['kind', 'RESERVED'],
          ['workKey', identity.workKey],
        ]);
        const reserved = await this.#append(REGISTRY_REF, registry.headOid, reservedBody);
        if (reserved.stale) return { stale: true, currentCommittedRevision: 'NONE' };
        registry = await this.#registry();
        entry = registry.entries.get(identity.workKey);
      }
      if (entry.state === 'RESERVED') {
        if (!root) {
          const appendedRoot = await this.#append(workRef, 'NONE', rootBody);
          if (appendedRoot.stale) root = await this.#readBootstrapRoot(identity.workKey);
          else root = {
            oid: appendedRoot.oid,
            committedRevision: appendedRoot.committedRevision,
            rootOnly: true,
          };
        }
        if (!root?.rootOnly || root.committedRevision !== contentRevision(rootBody)) {
          throw new DraftOperationError('LedgerCorrupt');
        }
        registry = await this.#registry();
        const confirmedBody = closedObject([
          ['schema', 'GaiaDraftRegistryReceiptV0'],
          ['priorCommittedRevision', registry.committedRevision],
          ['kind', 'CONFIRMED'],
          ['workKey', identity.workKey],
          ['bootstrapCommittedRevision', root.committedRevision],
        ]);
        const confirmed = await this.#append(
          REGISTRY_REF, registry.headOid, confirmedBody,
          closedObject([['workRootOid', root.oid]]),
        );
        if (confirmed.stale) {
          return { stale: true, currentCommittedRevision: root.committedRevision };
        }
        entry = {
          state: 'CONFIRMED',
          bootstrapCommittedRevision: root.committedRevision,
          bootstrapOid: root.oid,
        };
      }
      if (entry.state !== 'CONFIRMED' || !root
        || entry.bootstrapCommittedRevision !== root.committedRevision
        || entry.bootstrapOid !== root.oid) {
        throw new DraftOperationError('LedgerCorrupt');
      }
      if (!root.rootOnly) {
        const current = await this.#readWork(identity.workKey);
        return { stale: true, currentCommittedRevision: current.committedRevision };
      }
      const enqueuedBody = makeRecord('ENQUEUED', root.committedRevision, identity, { envelope });
      const enqueued = await this.#append(workRef, root.oid, enqueuedBody);
      if (enqueued.stale) return { stale: true, currentCommittedRevision: root.committedRevision };
      return { stale: false, committedRevision: enqueued.committedRevision };
    });
  }

  async readHead(workKey) {
    requireRevision(workKey, 'InvalidWorkKey');
    const work = await this.#inspectByWork(workKey);
    if (!work) return Object.freeze({ state: 'UNSEEN' });
    return Object.freeze({
      state: 'PRESENT', committedRevision: work.committedRevision, recordKind: work.state,
    });
  }
}

export function createGitDataDraftOperationStore(options) {
  return new GitDataDraftOperationStore(options);
}

function storeCapabilities(store) {
  const capabilities = draftStoreCapabilities.get(store);
  if (!capabilities) throw new DraftOperationError('InvalidPorts');
  return capabilities;
}

export function createMemoryDraftOperationStore() {
  return new MemoryDraftOperationStore();
}

function createOperationPorts(options, memoryOnly) {
  const code = 'InvalidPorts';
  const keys = ownDataKeys(options, code).sort();
  const withoutStore = ['admission', 'collector', 'executorEpoch', 'provider', 'telemetry'];
  const withStore = [...withoutStore, 'store'].sort();
  const allowed = keys.length === withoutStore.length
    && keys.every((key, index) => key === withoutStore[index])
    || keys.length === withStore.length
    && keys.every((key, index) => key === withStore[index]);
  if (!allowed) throw new DraftOperationError(code);
  const store = options.store ?? createMemoryDraftOperationStore();
  if (typeof options.collector?.collect !== 'function'
    || typeof options.provider?.lookupExact !== 'function'
    || typeof options.provider?.createDraft !== 'function'
    || typeof options.admission?.reserveEffect !== 'function'
    || typeof options.telemetry?.append !== 'function'
    || !draftStoreCapabilities.has(store)
    || memoryOnly && !(store instanceof MemoryDraftOperationStore)) {
    throw new DraftOperationError(code);
  }
  requireExactKeys(options.executorEpoch, ['runId', 'runAttempt'], code);
  if (!Number.isSafeInteger(options.executorEpoch.runId) || options.executorEpoch.runId <= 0
    || !Number.isSafeInteger(options.executorEpoch.runAttempt) || options.executorEpoch.runAttempt <= 0) {
    throw new DraftOperationError(code);
  }
  return Object.freeze({
    collector: options.collector,
    provider: options.provider,
    admission: options.admission,
    executorEpoch: closedObject([
      ['runId', options.executorEpoch.runId], ['runAttempt', options.executorEpoch.runAttempt],
    ]),
    telemetry: options.telemetry,
    store,
  });
}

export function createMemoryDraftOperationPorts(options) {
  return createOperationPorts(options, true);
}

export function createDraftOperationPorts(options) {
  return createOperationPorts(options, false);
}

function projectUnsettled(snapshot) {
  return closedObject([
    ['operationId', snapshot.identity.operationId],
    ['workKey', snapshot.identity.workKey],
    ['committedRevision', snapshot.committedRevision],
    ['selector', closedObject([
      ['repository', closedObject([
        ['owner', snapshot.envelope.repository.owner],
        ['name', snapshot.envelope.repository.name],
      ])],
      ['workItem', closedObject([
        ['kind', snapshot.envelope.workItem.kind],
        ['number', snapshot.envelope.workItem.number],
      ])],
    ])],
  ]);
}

export async function listUnsettledDrafts(ports) {
  const snapshots = await storeCapabilities(ports?.store).listUnsettled();
  return Object.freeze(snapshots
    .map(projectUnsettled)
    .sort((left, right) => left.workKey.localeCompare(right.workKey)));
}

function stale(current) {
  return { kind: 'StaleRevision', currentCommittedRevision: current?.committedRevision ?? 'NONE' };
}

async function emit(ports, event) {
  try {
    await ports.telemetry.append(event);
  } catch {
    // Observability cannot alter the durable result.
  }
}

export async function enqueueDraft(selectorInput, expectedCommittedRevision, ports) {
  const selector = validateSelector(selectorInput);
  validateExpectedRevision(expectedCommittedRevision);
  const observed = await ports.collector.collect(selector);
  const identity = validateEnvelope(observed, selector);
  const current = await storeCapabilities(ports.store).inspectByWork(identity.workKey);
  if (current) {
    if (expectedCommittedRevision === 'NONE'
      || expectedCommittedRevision !== current.committedRevision) return stale(current);
    if (current.identity.generationKey !== identity.generationKey && !current.terminal) {
      return {
        kind: 'CrossGenerationIntent', workKey: identity.workKey,
        currentOperationId: current.identity.operationId,
        currentCommittedRevision: current.committedRevision,
      };
    }
    return stale(current);
  }
  const committed = await storeCapabilities(ports.store).bootstrapAndEnqueue(
    identity, identity.envelope, expectedCommittedRevision,
  );
  if (committed.stale) return stale({ committedRevision: committed.currentCommittedRevision });
  await emit(ports, { kind: 'ENQUEUED', operationId: identity.operationId });
  return {
    kind: 'Enqueued', operationId: identity.operationId, workKey: identity.workKey,
    generationKey: identity.generationKey, committedRevision: committed.committedRevision,
  };
}

function providerRequest(snapshot) {
  const { envelope, identity } = snapshot;
  return closedObject([
    ['repository', closedObject([
      ['nodeId', envelope.repository.nodeId],
      ['owner', envelope.repository.owner],
      ['name', envelope.repository.name],
    ])],
    ['baseRef', envelope.generation.baseRef],
    ['headRef', envelope.generation.headRef],
    ['headRevision', envelope.generation.headRevision],
    ['operationMarker', identity.operationId],
  ]);
}

function readProviderFieldOnce(value, key) {
  if (value === null || typeof value !== 'object') {
    throw new DraftOperationError('ProviderProtocolViolation');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DraftOperationError('ProviderProtocolViolation');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable) throw new DraftOperationError('ProviderProtocolViolation');
  if (Object.hasOwn(descriptor, 'value')) return descriptor.value;
  if (typeof descriptor.get !== 'function') throw new DraftOperationError('ProviderProtocolViolation');
  try {
    return Reflect.apply(descriptor.get, value, []);
  } catch {
    throw new DraftOperationError('ProviderProtocolViolation');
  }
}

function sanitizeExactDraft(candidate, request) {
  if (candidate === null || candidate === undefined) return null;
  const number = readProviderFieldOnce(candidate, 'number');
  const url = readProviderFieldOnce(candidate, 'url');
  const isDraft = readProviderFieldOnce(candidate, 'isDraft');
  const state = readProviderFieldOnce(candidate, 'state');
  const operationMarker = readProviderFieldOnce(candidate, 'operationMarker');
  const repositoryCandidate = readProviderFieldOnce(candidate, 'repository');
  const baseRef = readProviderFieldOnce(candidate, 'baseRef');
  const headRef = readProviderFieldOnce(candidate, 'headRef');
  const headRevision = readProviderFieldOnce(candidate, 'headRevision');
  const repository = {
    nodeId: readProviderFieldOnce(repositoryCandidate, 'nodeId'),
    owner: readProviderFieldOnce(repositoryCandidate, 'owner'),
    name: readProviderFieldOnce(repositoryCandidate, 'name'),
  };
  if (!Number.isSafeInteger(number) || number <= 0
    || typeof url !== 'string' || url.length === 0 || /[\u0000-\u001f\u007f]/u.test(url)
    || isDraft !== true || state !== 'OPEN'
    || operationMarker !== request.operationMarker
    || baseRef !== request.baseRef
    || headRef !== request.headRef
    || headRevision !== request.headRevision
    || repository.nodeId !== request.repository.nodeId
    || repository.owner !== request.repository.owner
    || repository.name !== request.repository.name) {
    throw new DraftOperationError('ProviderProtocolViolation');
  }
  return closedObject([
    ['number', number],
    ['url', url],
    ['isDraft', true],
    ['state', 'OPEN'],
    ['operationMarker', request.operationMarker],
    ['repository', request.repository],
    ['baseRef', request.baseRef],
    ['headRef', request.headRef],
    ['headRevision', request.headRevision],
  ]);
}

function terminalResult(snapshot) {
  const { terminal, identity, envelope, committedRevision } = snapshot;
  const outcome = terminal.outcome;
  const effect = outcome === 'CREATED' ? 'CREATE_DRAFT' : 'NONE';
  return {
    kind: 'Terminal', outcome, effect,
    operationId: identity.operationId,
    workKey: identity.workKey,
    generationKey: identity.generationKey,
    generation: structuredClone(envelope.generation),
    observedSourceRevision: envelope.observedSourceRevision,
    pullRequest: terminal.pullRequest ?? null,
    refusal: terminal.refusal ?? null,
    committedRevision,
    actionRevision: committedRevision,
    checklistRevision: committedRevision,
    sourceRevision: committedRevision,
  };
}

function pendingResult(snapshot) {
  return {
    kind: 'Pending', state: 'EFFECT_AMBIGUOUS', effect: 'UNKNOWN',
    operationId: snapshot.identity.operationId,
    workKey: snapshot.identity.workKey,
    generationKey: snapshot.identity.generationKey,
    providerError: 'ProviderAmbiguous',
    committedRevision: snapshot.committedRevision,
  };
}

function currentResult(snapshot) {
  if (snapshot.terminal) return terminalResult(snapshot);
  if (snapshot.state === 'EFFECT_AMBIGUOUS') return pendingResult(snapshot);
  return stale(snapshot);
}

async function appendOrCurrent(ports, operationId, expected, kind, payload = {}) {
  const appended = await storeCapabilities(ports.store).append(
    operationId, expected, kind, payload,
  );
  return appended.stale ? { ok: false, result: currentResult(appended.current) }
    : { ok: true, snapshot: appended.current };
}

async function refuse(ports, snapshot, refusal) {
  const appended = await appendOrCurrent(
    ports, snapshot.identity.operationId, snapshot.committedRevision, 'REFUSED', { refusal },
  );
  if (!appended.ok) return appended.result;
  await emit(ports, { kind: 'REFUSED', operationId: snapshot.identity.operationId, refusal });
  return terminalResult(appended.snapshot);
}

async function adopt(ports, snapshot, pullRequest, outcome) {
  const appended = await appendOrCurrent(
    ports, snapshot.identity.operationId, snapshot.committedRevision, outcome, { pullRequest },
  );
  if (!appended.ok) return appended.result;
  await emit(ports, { kind: outcome, operationId: snapshot.identity.operationId });
  return terminalResult(appended.snapshot);
}

export async function reconcileDraft(operationId, expectedCommittedRevision, ports) {
  requireRevision(operationId, 'InvalidOperationId');
  requireRevision(expectedCommittedRevision);
  const capabilities = storeCapabilities(ports.store);
  const initial = await capabilities.inspectByOperation(operationId);
  if (!initial) throw new DraftOperationError('UnknownOperation');
  return capabilities.withExecutor(initial.identity.workKey, async () => {
    let snapshot = await capabilities.inspectByOperation(operationId);
    if (snapshot.committedRevision !== expectedCommittedRevision) return stale(snapshot);
    if (snapshot.terminal) return terminalResult(snapshot);

    const request = providerRequest(snapshot);
    let existing;
    try {
      existing = sanitizeExactDraft(await ports.provider.lookupExact(request), request);
    } catch (error) {
      if (snapshot.state === 'EFFECT_STARTED' || snapshot.state === 'EFFECT_AMBIGUOUS') {
        return snapshot.state === 'EFFECT_AMBIGUOUS' ? pendingResult(snapshot)
          : pendingAfterAmbiguity(ports, snapshot);
      }
      const refusal = error instanceof DraftOperationError
        && error.code === 'ProviderProtocolViolation'
        ? 'ProviderProtocolViolation' : 'ProviderUnavailable';
      return refuse(ports, snapshot, refusal);
    }
    if (existing) return adopt(ports, snapshot, existing, 'REUSED');
    if (snapshot.state === 'EFFECT_AMBIGUOUS') return pendingResult(snapshot);
    if (snapshot.state === 'EFFECT_STARTED') return pendingAfterAmbiguity(ports, snapshot);

    if (snapshot.state === 'ENQUEUED') {
      const claimed = await appendOrCurrent(
        ports, operationId, snapshot.committedRevision, 'CLAIMED',
        { executorEpoch: ports.executorEpoch },
      );
      if (!claimed.ok) return claimed.result;
      snapshot = claimed.snapshot;
    }

    if (snapshot.state === 'CLAIMED'
      && !sameLedgerEpoch(snapshot.executorEpoch, ports.executorEpoch)) {
      if (!isSuccessorLedgerEpoch(ports.executorEpoch, snapshot.executorEpoch)) {
        return stale(snapshot);
      }
      const claimed = await appendOrCurrent(
        ports, operationId, snapshot.committedRevision, 'CLAIMED',
        { executorEpoch: ports.executorEpoch },
      );
      if (!claimed.ok) return claimed.result;
      snapshot = claimed.snapshot;
    }

    if (snapshot.state === 'INTENT'
      && !sameLedgerEpoch(snapshot.executorEpoch, ports.executorEpoch)) {
      if (!isSuccessorLedgerEpoch(ports.executorEpoch, snapshot.executorEpoch)) {
        return stale(snapshot);
      }
      const claimed = await appendOrCurrent(
        ports, operationId, snapshot.committedRevision, 'CLAIMED',
        { executorEpoch: ports.executorEpoch },
      );
      if (!claimed.ok) return claimed.result;
      snapshot = claimed.snapshot;
    }

    if (snapshot.state === 'CLAIMED') {
      let capacity;
      try {
        capacity = await ports.admission.reserveEffect(closedObject([
          ['workKey', snapshot.identity.workKey],
          ['operationId', operationId],
          ['executorEpoch', ports.executorEpoch],
          ['claimedRevision', snapshot.committedRevision],
        ]));
      } catch {
        capacity = 'ZERO';
      }
      if (capacity === 'ZERO') return refuse(ports, snapshot, 'NoEffectCapacity');
      if (capacity !== 'AVAILABLE') throw new DraftOperationError('InvalidAdmission');
      const intent = await appendOrCurrent(
        ports, operationId, snapshot.committedRevision, 'INTENT',
        { executorEpoch: ports.executorEpoch },
      );
      if (!intent.ok) return intent.result;
      snapshot = intent.snapshot;
    }
    if (snapshot.state === 'INTENT') {
      const started = await appendOrCurrent(
        ports, operationId, snapshot.committedRevision, 'EFFECT_STARTED',
        { executorEpoch: ports.executorEpoch },
      );
      if (!started.ok) return started.result;
      snapshot = started.snapshot;
    }

    try {
      const created = sanitizeExactDraft(await ports.provider.createDraft(request), request);
      if (!created) return pendingAfterAmbiguity(ports, snapshot);
      return adopt(ports, snapshot, created, 'CREATED');
    } catch {
      return pendingAfterAmbiguity(ports, snapshot);
    }
  });
}

async function pendingAfterAmbiguity(ports, snapshot) {
  if (snapshot.state === 'EFFECT_AMBIGUOUS') return pendingResult(snapshot);
  const appended = await appendOrCurrent(
    ports, snapshot.identity.operationId, snapshot.committedRevision,
    'EFFECT_AMBIGUOUS', { providerError: 'ProviderAmbiguous' },
  );
  if (!appended.ok) return appended.result;
  await emit(ports, {
    kind: 'EFFECT_AMBIGUOUS', operationId: snapshot.identity.operationId,
    providerError: 'ProviderAmbiguous',
  });
  return pendingResult(appended.snapshot);
}

export async function cancelDraft(operationId, expectedCommittedRevision, ports) {
  requireRevision(operationId, 'InvalidOperationId');
  requireRevision(expectedCommittedRevision);
  const snapshot = await storeCapabilities(ports.store).inspectByOperation(operationId);
  if (!snapshot) throw new DraftOperationError('UnknownOperation');
  if (snapshot.committedRevision !== expectedCommittedRevision) return stale(snapshot);
  if (snapshot.terminal) return terminalResult(snapshot);
  if (snapshot.state === 'EFFECT_STARTED' || snapshot.state === 'EFFECT_AMBIGUOUS') {
    return {
      kind: 'CancellationDeferred', state: snapshot.state,
      operationId, committedRevision: snapshot.committedRevision,
    };
  }
  const cancelled = await appendOrCurrent(
    ports, operationId, snapshot.committedRevision, 'CANCELLED', {},
  );
  if (!cancelled.ok) return cancelled.result;
  await emit(ports, { kind: 'CANCELLED', operationId });
  return terminalResult(cancelled.snapshot);
}
