import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const TERMINAL = new Set(['CREATED', 'REUSED', 'REFUSED', 'CANCELLED']);

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

const memoryStoreCapabilities = new WeakMap();

class MemoryDraftOperationStore {
  #work = new Map();
  #operations = new Map();
  #locks = new Map();
  #executors = new Map();

  constructor() {
    memoryStoreCapabilities.set(this, Object.freeze({
      bootstrapAndEnqueue: this.#bootstrapAndEnqueue.bind(this),
      append: this.#append.bind(this),
      withExecutor: this.#withExecutor.bind(this),
      inspectByWork: this.#inspectByWork.bind(this),
      inspectByOperation: this.#inspectByOperation.bind(this),
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
      terminal: work.terminal,
    });
  }
}

function memoryCapabilities(store) {
  const capabilities = memoryStoreCapabilities.get(store);
  if (!capabilities) throw new DraftOperationError('InvalidPorts');
  return capabilities;
}

export function createMemoryDraftOperationStore() {
  return new MemoryDraftOperationStore();
}

export function createMemoryDraftOperationPorts(options) {
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
    || !(store instanceof MemoryDraftOperationStore)) throw new DraftOperationError(code);
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
  const current = await memoryCapabilities(ports.store).inspectByWork(identity.workKey);
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
  const committed = await memoryCapabilities(ports.store).bootstrapAndEnqueue(
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
  const appended = await memoryCapabilities(ports.store).append(
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
  const capabilities = memoryCapabilities(ports.store);
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

    if (snapshot.state === 'CLAIMED') {
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
  const snapshot = await memoryCapabilities(ports.store).inspectByOperation(operationId);
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
