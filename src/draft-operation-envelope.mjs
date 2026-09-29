import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const TERMINAL = new Set(['CREATED', 'REUSED', 'REFUSED', 'CANCELLED']);
const EPOCH_STATES = new Set(['CLAIMED', 'INTENT', 'EFFECT_STARTED']);
// The create call is reachable only after EFFECT_STARTED, so a refusal from these states never ran it.
const PRE_EFFECT_STATES = new Set(['ENQUEUED', 'CLAIMED', 'INTENT']);
const READMISSION_REASON_LIMIT = 500;
const REGISTRY_WRITE_ATTEMPTS = 3;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u;
const notInvokedWitnesses = new WeakMap();

/** Trusted preparation must be effect-free; invocation errors never attest non-invocation. */
export function guardDraftCreation({ prepare, invoke }) {
  if (typeof prepare !== 'function' || typeof invoke !== 'function') {
    throw new DraftOperationError('InvalidEffectBoundary');
  }
  return async request => {
    let prepared;
    try {
      prepared = await prepare(request);
    } catch (cause) {
      const code = typeof cause?.code === 'string' && /^[A-Za-z]{1,64}$/u.test(cause.code)
        ? cause.code : 'PreparationFailed';
      const error = new DraftOperationError(code);
      notInvokedWitnesses.set(error, { request, refusal: `BeforeProvider:${code}` });
      throw error;
    }
    try {
      return await invoke(request, prepared);
    } catch (error) {
      // A nested or replayed witness cannot escape a callback already invoked.
      notInvokedWitnesses.delete(error);
      throw error;
    }
  };
}

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

/**
 * The storage key of the chain that follows a re-admitted refusal.
 *
 * A first admission is stored under its work key. A successor is stored under a key derived from
 * the refused chain it follows, so one refused terminal can have at most one successor: admissions
 * form a line, never a fork. The key is storage only; records keep carrying the issue's work key.
 */
function successorAdmissionKey(predecessorAdmissionKey, predecessorTerminalRevision) {
  return contentRevision({
    schema: 'GaiaDraftSuccessorAdmissionKeyV0',
    predecessorAdmissionKey, predecessorTerminalRevision,
  });
}

/**
 * Whether a settled chain provably never reached the create call.
 *
 * The ledger grammar already rejects a REFUSED after EFFECT_STARTED that lacks the NOT_INVOKED
 * witness. This states the rule again on its own, so a later grammar change cannot widen
 * re-admission by accident.
 */
function isEffectFreeRefusal(terminal) {
  if (terminal?.outcome !== 'REFUSED') return false;
  if (PRE_EFFECT_STATES.has(terminal.refusedFrom)) return true;
  return terminal.refusedFrom === 'EFFECT_STARTED' && terminal.effectBoundary === 'NOT_INVOKED';
}

/**
 * The latest operation on an admission line: past each re-admitted refusal to the successor that
 * holds an operation. A successor opened but not yet enqueued holds none, so the refusal before it
 * stays the head.
 */
async function lineHead(snapshot, inspectAdmission) {
  let current = snapshot;
  while (current && isEffectFreeRefusal(current.terminal)) {
    const successor = await inspectAdmission(successorAdmissionKey(
      current.admission.key, current.terminal.committedRevision,
    ));
    if (successor.state !== 'PRESENT') break;
    current = successor.snapshot;
  }
  return current;
}

function firstAdmission(workKey) {
  return closedObject([['key', workKey], ['spentGenerationKeys', Object.freeze([])]]);
}

function validateReadmissionProvenance(input) {
  const code = 'InvalidReadmission';
  requireExactKeys(input, ['reason', 'runId', 'runAttempt', 'triggeringActor'], code);
  const reason = requireString(input.reason, code);
  if (reason.trim() !== reason || reason.length > READMISSION_REASON_LIMIT) {
    throw new DraftOperationError(code);
  }
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0
    || !Number.isSafeInteger(input.runAttempt) || input.runAttempt <= 0
    || typeof input.triggeringActor !== 'string'
    || !GITHUB_LOGIN.test(input.triggeringActor)) throw new DraftOperationError(code);
  return closedObject([
    ['reason', reason],
    ['runId', input.runId],
    ['runAttempt', input.runAttempt],
    ['triggeringActor', input.triggeringActor],
  ]);
}

/** The root of a successor chain, built from the refused snapshot it follows. */
function successorRoot(predecessor, readmission) {
  const admissionKey = successorAdmissionKey(
    predecessor.admission.key, predecessor.terminal.committedRevision,
  );
  return closedObject([
    ['schema', 'GaiaDraftWorkRootV1'],
    ['priorCommittedRevision', 'NONE'],
    ['kind', 'WORK_ROOT'],
    ['workKey', predecessor.identity.workKey],
    ['admissionKey', admissionKey],
    ['predecessor', closedObject([
      ['admissionKey', predecessor.admission.key],
      ['operationId', predecessor.identity.operationId],
      ['terminalCommittedRevision', predecessor.terminal.committedRevision],
      ['refusal', predecessor.terminal.refusal],
    ])],
    ['spentGenerationKeys', Object.freeze([
      ...predecessor.admission.spentGenerationKeys, predecessor.identity.generationKey,
    ])],
    ['readmission', readmission],
  ]);
}

/**
 * A work root read back from storage: V0 for a first admission, V1 for a successor.
 * Returns the base work key and the admission it opens, or throws LedgerCorrupt.
 */
function parseWorkRoot(body, admissionKey) {
  const code = 'LedgerCorrupt';
  if (body?.schema === 'GaiaDraftWorkRootV0') {
    requireExactKeys(body, ['schema', 'priorCommittedRevision', 'kind', 'workKey'], code);
    if (body.priorCommittedRevision !== 'NONE' || body.kind !== 'WORK_ROOT'
      || body.workKey !== admissionKey) throw new DraftOperationError(code);
    return { workKey: body.workKey, admission: firstAdmission(body.workKey) };
  }
  requireExactKeys(body, [
    'schema', 'priorCommittedRevision', 'kind', 'workKey', 'admissionKey', 'predecessor',
    'spentGenerationKeys', 'readmission',
  ], code);
  requireExactKeys(body.predecessor, [
    'admissionKey', 'operationId', 'terminalCommittedRevision', 'refusal',
  ], code);
  if (body.schema !== 'GaiaDraftWorkRootV1' || body.priorCommittedRevision !== 'NONE'
    || body.kind !== 'WORK_ROOT' || body.admissionKey !== admissionKey
    || body.admissionKey !== successorAdmissionKey(
      requireRevision(body.predecessor.admissionKey, code),
      requireRevision(body.predecessor.terminalCommittedRevision, code),
    )) throw new DraftOperationError(code);
  requireRevision(body.workKey, code);
  requireRevision(body.predecessor.operationId, code);
  requireString(body.predecessor.refusal, code);
  if (!Array.isArray(body.spentGenerationKeys) || body.spentGenerationKeys.length === 0
    || new Set(body.spentGenerationKeys).size !== body.spentGenerationKeys.length) {
    throw new DraftOperationError(code);
  }
  for (const key of body.spentGenerationKeys) requireRevision(key, code);
  // The refused operation spent the line's last generation, so its id is re-derivable here.
  if (body.predecessor.operationId !== contentRevision({
    schema: 'GaiaDraftOperationIdV0', workKey: body.workKey,
    generationKey: body.spentGenerationKeys.at(-1),
  })) throw new DraftOperationError(code);
  try {
    validateReadmissionProvenance(body.readmission);
  } catch {
    throw new DraftOperationError(code);
  }
  return {
    workKey: body.workKey,
    admission: closedObject([
      ['key', admissionKey],
      ['spentGenerationKeys', Object.freeze([...body.spentGenerationKeys])],
    ]),
  };
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
  // Chains are keyed by admission key: the work key for a first admission, a derived key after.
  #work = new Map();
  #operations = new Map();
  #openSuccessors = new Map();
  #locks = new Map();
  #executors = new Map();

  constructor() {
    draftStoreCapabilities.set(this, Object.freeze({
      bootstrapAndEnqueue: this.#bootstrapAndEnqueue.bind(this),
      append: this.#append.bind(this),
      withExecutor: this.#withExecutor.bind(this),
      inspectByWork: this.#inspectByAdmission.bind(this),
      inspectByOperation: this.#inspectByOperation.bind(this),
      listUnsettled: this.#listUnsettled.bind(this),
      inspectAdmission: this.#inspectAdmission.bind(this),
      openSuccessor: this.#openSuccessor.bind(this),
      enqueueSuccessor: this.#enqueueSuccessor.bind(this),
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
        identity: storedIdentity, envelope, admission: firstAdmission(identity.workKey), records: [
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

  async #inspectAdmission(admissionKey) {
    return this.#exclusive(this.#locks, admissionKey, async () => {
      const work = this.#work.get(admissionKey);
      if (work) return Object.freeze({ state: 'PRESENT', snapshot: this.#snapshot(work) });
      const open = this.#openSuccessors.get(admissionKey);
      if (open) {
        return Object.freeze({
          state: 'OPEN', workKey: open.workKey, admission: open.admission,
          committedRevision: open.committedRevision,
        });
      }
      return Object.freeze({ state: 'ABSENT' });
    });
  }

  async #openSuccessor(rootBody) {
    const admissionKey = rootBody.admissionKey;
    return this.#exclusive(this.#locks, admissionKey, async () => {
      if (this.#work.has(admissionKey) || this.#openSuccessors.has(admissionKey)) {
        return { opened: false };
      }
      const { workKey, admission } = parseWorkRoot(rootBody, admissionKey);
      const committedRevision = contentRevision(rootBody);
      this.#openSuccessors.set(admissionKey, {
        body: rootBody, committedRevision, workKey, admission,
      });
      return { opened: true, committedRevision };
    });
  }

  async #enqueueSuccessor(admissionKey, identity, envelope) {
    return this.#exclusive(this.#locks, admissionKey, async () => {
      const open = this.#openSuccessors.get(admissionKey);
      if (!open) {
        return {
          stale: true,
          currentCommittedRevision: this.#work.get(admissionKey)?.committedRevision ?? 'NONE',
        };
      }
      if (open.workKey !== identity.workKey) throw new DraftOperationError('LedgerCorrupt');
      if (open.admission.spentGenerationKeys.includes(identity.generationKey)
        || this.#operations.has(identity.operationId)) {
        return { stale: true, currentCommittedRevision: open.committedRevision };
      }
      const enqueued = makeRecord('ENQUEUED', open.committedRevision, identity, { envelope });
      const committedRevision = contentRevision(enqueued);
      this.#openSuccessors.delete(admissionKey);
      this.#work.set(admissionKey, {
        identity: closedObject([
          ['workKey', identity.workKey],
          ['generationKey', identity.generationKey],
          ['operationId', identity.operationId],
        ]),
        envelope,
        admission: open.admission,
        records: [
          { body: open.body, committedRevision: open.committedRevision },
          { body: enqueued, committedRevision },
        ],
        committedRevision,
        state: 'ENQUEUED',
        executorEpoch: null,
        terminal: null,
      });
      this.#operations.set(identity.operationId, admissionKey);
      return { stale: false, committedRevision };
    });
  }

  async #inspectByAdmission(admissionKey) {
    return this.#exclusive(
      this.#locks, admissionKey, async () => this.#snapshot(this.#work.get(admissionKey)),
    );
  }

  async #inspectByOperation(operationId) {
    const admissionKey = this.#operations.get(operationId);
    if (!admissionKey) return null;
    return this.#inspectByAdmission(admissionKey);
  }

  async #listUnsettled() {
    const unsettled = [];
    for (const admissionKey of [...this.#work.keys()].sort()) {
      const snapshot = await this.#inspectByAdmission(admissionKey);
      if (snapshot && !snapshot.terminal) unsettled.push(snapshot);
    }
    return Object.freeze(unsettled);
  }

  async inspectByWork(workKey) {
    return this.#inspectByAdmission(workKey);
  }

  async inspectByOperation(operationId) {
    return this.#inspectByOperation(operationId);
  }

  async #append(operationId, expectedCommittedRevision, kind, payload = {}) {
    const admissionKey = this.#operations.get(operationId);
    if (!admissionKey) throw new DraftOperationError('UnknownOperation');
    return this.#exclusive(this.#locks, admissionKey, async () => {
      const work = this.#work.get(admissionKey);
      if (work.committedRevision !== expectedCommittedRevision) {
        return { stale: true, current: this.#snapshot(work) };
      }
      const body = makeRecord(kind, expectedCommittedRevision, work.identity, payload);
      const committedRevision = contentRevision(body);
      const refusedFrom = work.state;
      work.records.push({ body, committedRevision });
      work.committedRevision = committedRevision;
      work.state = kind;
      if (EPOCH_STATES.has(kind)) work.executorEpoch = payload.executorEpoch;
      if (kind === 'REFUSED') {
        work.terminal = {
          outcome: kind, refusal: payload.refusal, refusedFrom,
          effectBoundary: payload.effectBoundary ?? null, committedRevision,
        };
      } else if (TERMINAL.has(kind)) {
        work.terminal = { ...payload, outcome: kind, committedRevision };
      }
      return { stale: false, current: this.#snapshot(work) };
    });
  }

  async readHead(workKey) {
    const snapshot = await lineHead(
      await this.#inspectByAdmission(workKey), this.#inspectAdmission.bind(this),
    );
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
      admission: work.admission,
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
    EFFECT_STARTED: new Set(['EFFECT_AMBIGUOUS', 'CREATED', 'REUSED', 'REFUSED']),
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
      body.pullRequest, providerRequest({ identity, envelope }), body.kind === 'REUSED',
    );
    if (!pullRequest) throw new DraftOperationError('LedgerCorrupt');
    return { outcome: body.kind, pullRequest, committedRevision: record.committedRevision };
  }
  if (body.kind === 'REFUSED') {
    requireExactKeys(body, [...common, 'refusal',
      ...(previous === 'EFFECT_STARTED' ? ['effectBoundary'] : [])], 'LedgerCorrupt');
    if (previous === 'EFFECT_STARTED'
      && (body.effectBoundary !== 'NOT_INVOKED'
        || !/^BeforeProvider:[A-Za-z]{1,64}$/u.test(body.refusal))) {
      throw new DraftOperationError('LedgerCorrupt');
    }
    return {
      outcome: 'REFUSED', refusal: requireString(body.refusal, 'LedgerCorrupt'),
      refusedFrom: previous, effectBoundary: body.effectBoundary ?? null,
      committedRevision: record.committedRevision,
    };
  }
  if (body.kind === 'CANCELLED') {
    requireExactKeys(body, common, 'LedgerCorrupt');
    return { outcome: 'CANCELLED', committedRevision: record.committedRevision };
  }
  throw new DraftOperationError('LedgerCorrupt');
}

const UNSETTLED_INSPECTION_CONCURRENCY = 8;

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
      inspectByWork: this.#inspectByAdmission.bind(this),
      append: this.#appendOperation.bind(this),
      withExecutor: this.#withExecutor.bind(this),
      inspectByOperation: this.#inspectByOperation.bind(this),
      listUnsettled: this.#listUnsettled.bind(this),
      inspectAdmission: this.#inspectAdmission.bind(this),
      openSuccessor: this.#openSuccessor.bind(this),
      enqueueSuccessor: this.#enqueueSuccessor.bind(this),
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
    // Entries are keyed by admission key. A first admission's receipt names only its work key,
    // which is its admission key; a successor's receipt also names the admission key it opens.
    const entries = new Map();
    const admissionKeyOf = (body) => {
      const successor = Object.hasOwn(body, 'admissionKey');
      requireRevision(body.workKey, 'LedgerCorrupt');
      return successor ? requireRevision(body.admissionKey, 'LedgerCorrupt') : body.workKey;
    };
    for (const record of snapshot.records.slice(1)) {
      const successor = Object.hasOwn(record.body, 'admissionKey');
      if (record.body.kind === 'RESERVED') {
        requireExactKeys(record.body, [
          'schema', 'priorCommittedRevision', 'kind', 'workKey',
          ...(successor ? ['admissionKey'] : []),
        ], 'LedgerCorrupt');
        const admissionKey = admissionKeyOf(record.body);
        if (entries.has(admissionKey)) throw new DraftOperationError('LedgerCorrupt');
        entries.set(admissionKey, { state: 'RESERVED', workKey: record.body.workKey });
      } else if (record.body.kind === 'CONFIRMED') {
        requireExactKeys(record.body, [
          'schema', 'priorCommittedRevision', 'kind', 'workKey',
          ...(successor ? ['admissionKey'] : []), 'bootstrapCommittedRevision',
        ], 'LedgerCorrupt');
        const admissionKey = admissionKeyOf(record.body);
        requireRevision(record.body.bootstrapCommittedRevision, 'LedgerCorrupt');
        const reserved = entries.get(admissionKey);
        if (reserved?.state !== 'RESERVED' || reserved.workKey !== record.body.workKey) {
          throw new DraftOperationError('LedgerCorrupt');
        }
        entries.set(admissionKey, {
          state: 'CONFIRMED',
          workKey: record.body.workKey,
          bootstrapCommittedRevision: record.body.bootstrapCommittedRevision,
          bootstrapOid: record.transportMetadata.workRootOid,
        });
      } else {
        throw new DraftOperationError('LedgerCorrupt');
      }
    }
    return { ...snapshot, entries };
  }

  #parseWorkSnapshot(admissionKey, snapshotInput) {
    const snapshot = validateGitDataSnapshot(snapshotInput);
    if (snapshot.state === 'UNSEEN') return null;
    const root = snapshot.records[0];
    const { workKey, admission } = parseWorkRoot(root.body, admissionKey);
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
      || identity.operationId !== enqueued.body.operationId
      || admission.spentGenerationKeys.includes(identity.generationKey)) {
      throw new DraftOperationError('LedgerCorrupt');
    }
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
      admission,
      bootstrapCommittedRevision: root.committedRevision,
      bootstrapOid: root.oid,
      headOid: snapshot.headOid,
      committedRevision: snapshot.committedRevision,
      state,
      executorEpoch,
      terminal,
    };
  }

  async #readWork(admissionKey) {
    return this.#parseWorkSnapshot(
      admissionKey, await this.#gitData.read(`${WORK_REF_PREFIX}${admissionKey}`),
    );
  }

  async #readBootstrapRoot(admissionKey) {
    const snapshot = validateGitDataSnapshot(
      await this.#gitData.read(`${WORK_REF_PREFIX}${admissionKey}`),
    );
    if (snapshot.state === 'UNSEEN') return null;
    const root = snapshot.records[0];
    const { workKey, admission } = parseWorkRoot(root.body, admissionKey);
    return {
      oid: root.oid,
      committedRevision: root.committedRevision,
      rootOnly: snapshot.records.length === 1,
      successor: root.body.schema === 'GaiaDraftWorkRootV1',
      workKey,
      admission,
    };
  }

  #snapshot(work) {
    if (!work) return null;
    return deepOwnedFrozen({
      identity: work.identity,
      envelope: work.envelope,
      admission: work.admission,
      committedRevision: work.committedRevision,
      state: work.state,
      executorEpoch: work.executorEpoch,
      terminal: work.terminal,
    });
  }

  async #stateByAdmission(admissionKey) {
    const [registry, work] = await Promise.all([
      this.#registry(), this.#readWork(admissionKey),
    ]);
    const entry = registry.entries.get(admissionKey);
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
    const entry = registry.entries.get(work.admission.key);
    if (entry?.state !== 'CONFIRMED'
      || entry.bootstrapCommittedRevision !== work.bootstrapCommittedRevision
      || entry.bootstrapOid !== work.bootstrapOid) {
      throw new DraftOperationError('LedgerCorrupt');
    }
    return work;
  }

  async #inspectByAdmission(admissionKey) {
    const registry = await this.#registry();
    const entry = registry.entries.get(admissionKey);
    if (entry?.state === 'RESERVED') {
      const root = await this.#readBootstrapRoot(admissionKey);
      if (root && !root.rootOnly) throw new DraftOperationError('LedgerCorrupt');
      return null;
    }
    if (entry?.state === 'CONFIRMED') {
      const root = await this.#readBootstrapRoot(admissionKey);
      if (root?.rootOnly) {
        if (entry.bootstrapCommittedRevision !== root.committedRevision) {
          throw new DraftOperationError('LedgerCorrupt');
        }
        if (entry.bootstrapOid !== root.oid) throw new DraftOperationError('LedgerCorrupt');
        return null;
      }
    }
    return this.#snapshot(await this.#stateByAdmission(admissionKey));
  }

  async #inspectByOperation(operationId) {
    return this.#snapshot(await this.#stateByOperation(operationId));
  }

  async #listUnsettled() {
    const registry = await this.#registry();
    // Every registered admission key is re-read on each listing, terminal ones included, so the
    // cost grows with the ledger. The inspections are independent reads over immutable objects;
    // bounded fan-out keeps a growing ledger inside the intake's admission window. The result
    // keeps the sorted admission-key order, and any failed inspection still fails the listing.
    const admissionKeys = [...registry.entries.keys()].sort();
    const snapshots = new Array(admissionKeys.length);
    let next = 0;
    const lane = async () => {
      while (next < admissionKeys.length) {
        const index = next++;
        snapshots[index] = await this.#inspectByAdmission(admissionKeys[index]);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(UNSETTLED_INSPECTION_CONCURRENCY, admissionKeys.length) }, lane,
    ));
    return Object.freeze(snapshots.filter((snapshot) => snapshot && !snapshot.terminal));
  }

  async #stateByOperation(operationId) {
    const observed = await this.#gitData.readByOperation(operationId);
    const located = validateGitDataSnapshot(observed);
    if (located.state === 'UNSEEN') return null;
    const rootBody = located.records[0]?.body;
    const admissionKey = rootBody?.schema === 'GaiaDraftWorkRootV1'
      ? rootBody.admissionKey : rootBody?.workKey;
    requireRevision(admissionKey, 'LedgerCorrupt');
    const work = this.#parseWorkSnapshot(admissionKey, observed);
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
    const admissionKey = located.admission.key;
    return this.#exclusive(admissionKey, async () => {
      const work = await this.#stateByAdmission(admissionKey);
      if (work.committedRevision !== expectedCommittedRevision) {
        return { stale: true, current: this.#snapshot(work) };
      }
      const body = makeRecord(kind, expectedCommittedRevision, work.identity, payload);
      const appended = await this.#append(
        `${WORK_REF_PREFIX}${admissionKey}`, work.headOid, body,
      );
      if (appended.stale) {
        return { stale: true, current: this.#snapshot(await this.#stateByAdmission(admissionKey)) };
      }
      return { stale: false, current: this.#snapshot(await this.#stateByAdmission(admissionKey)) };
    });
  }

  /** Where a successor stands: never opened, half-opened, open for a generation, or in use. */
  async #inspectAdmission(admissionKey) {
    // The registry is read before the work ref, so a writer landing between the two reads (an
    // operator opening this successor, or intake enqueueing on it) can leave the work ref ahead
    // of the registry that was read. Every work-ref write follows the registry write that allows
    // it, so a registry read after the work ref closes that gap; one that survives is corruption.
    let registry = await this.#registry();
    const root = await this.#readBootstrapRoot(admissionKey);
    const ahead = (entry) => (!entry && root)
      || (entry?.state === 'RESERVED' && root && !root.rootOnly);
    if (ahead(registry.entries.get(admissionKey))) registry = await this.#registry();
    const entry = registry.entries.get(admissionKey);
    if (ahead(entry)) throw new DraftOperationError('LedgerCorrupt');
    if (!entry) return Object.freeze({ state: 'ABSENT' });
    if (root && (!root.successor || root.workKey !== entry.workKey)) {
      throw new DraftOperationError('LedgerCorrupt');
    }
    if (entry.state === 'RESERVED') return Object.freeze({ state: 'PENDING' });
    if (!root) throw new DraftOperationError('LedgerWorkMissing');
    if (entry.bootstrapCommittedRevision !== root.committedRevision
      || entry.bootstrapOid !== root.oid) throw new DraftOperationError('LedgerCorrupt');
    if (root.rootOnly) {
      return Object.freeze({
        state: 'OPEN', workKey: root.workKey, admission: root.admission,
        committedRevision: root.committedRevision,
      });
    }
    return Object.freeze({
      state: 'PRESENT', snapshot: this.#snapshot(await this.#stateByAdmission(admissionKey)),
    });
  }

  /**
   * Reserve, root and confirm one successor: the same resumable protocol as a first admission.
   * A root left by an earlier interrupted run for the same predecessor is confirmed as it stands,
   * so the first dispatcher stays the recorded one.
   */
  async #openSuccessor(rootBody) {
    const admissionKey = rootBody.admissionKey;
    const workRef = `${WORK_REF_PREFIX}${admissionKey}`;
    return this.#exclusive(admissionKey, async () => {
      let registry = await this.#registry();
      let entry = registry.entries.get(admissionKey);
      let root = await this.#readBootstrapRoot(admissionKey);
      if (entry?.state === 'CONFIRMED') return { opened: false };
      if (!entry) {
        if (root) throw new DraftOperationError('LedgerCorrupt');
        const reserved = await this.#append(REGISTRY_REF, registry.headOid, closedObject([
          ['schema', 'GaiaDraftRegistryReceiptV0'],
          ['priorCommittedRevision', registry.committedRevision],
          ['kind', 'RESERVED'],
          ['workKey', rootBody.workKey],
          ['admissionKey', admissionKey],
        ]));
        if (reserved.stale) return { stale: true };
        registry = await this.#registry();
        entry = registry.entries.get(admissionKey);
      }
      if (entry?.state !== 'RESERVED' || entry.workKey !== rootBody.workKey) {
        throw new DraftOperationError('LedgerCorrupt');
      }
      if (!root) {
        const appendedRoot = await this.#append(workRef, 'NONE', rootBody);
        root = appendedRoot.stale ? await this.#readBootstrapRoot(admissionKey) : {
          oid: appendedRoot.oid, committedRevision: appendedRoot.committedRevision,
          rootOnly: true, successor: true, workKey: rootBody.workKey,
        };
      }
      if (!root?.rootOnly || !root.successor || root.workKey !== rootBody.workKey) {
        throw new DraftOperationError('LedgerCorrupt');
      }
      registry = await this.#registry();
      const confirmed = await this.#append(REGISTRY_REF, registry.headOid, closedObject([
        ['schema', 'GaiaDraftRegistryReceiptV0'],
        ['priorCommittedRevision', registry.committedRevision],
        ['kind', 'CONFIRMED'],
        ['workKey', rootBody.workKey],
        ['admissionKey', admissionKey],
        ['bootstrapCommittedRevision', root.committedRevision],
      ]), closedObject([['workRootOid', root.oid]]));
      if (confirmed.stale) return { stale: true };
      return { opened: true, committedRevision: root.committedRevision };
    });
  }

  async #enqueueSuccessor(admissionKey, identity, envelope) {
    return this.#exclusive(admissionKey, async () => {
      const opened = await this.#inspectAdmission(admissionKey);
      if (opened.state === 'PRESENT') {
        return { stale: true, currentCommittedRevision: opened.snapshot.committedRevision };
      }
      if (opened.state !== 'OPEN') return { stale: true, currentCommittedRevision: 'NONE' };
      if (opened.workKey !== identity.workKey) throw new DraftOperationError('LedgerCorrupt');
      if (opened.admission.spentGenerationKeys.includes(identity.generationKey)) {
        return { stale: true, currentCommittedRevision: opened.committedRevision };
      }
      const root = await this.#readBootstrapRoot(admissionKey);
      const enqueuedBody = makeRecord('ENQUEUED', root.committedRevision, identity, { envelope });
      const enqueued = await this.#append(
        `${WORK_REF_PREFIX}${admissionKey}`, root.oid, enqueuedBody,
      );
      if (enqueued.stale) return { stale: true, currentCommittedRevision: root.committedRevision };
      return { stale: false, committedRevision: enqueued.committedRevision };
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

  async inspectByOperation(operationId) {
    requireRevision(operationId, 'InvalidOperationId');
    const work = await this.#stateByOperation(operationId);
    return work ? this.#snapshot(work) : null;
  }

  async readHead(workKey) {
    requireRevision(workKey, 'InvalidWorkKey');
    const work = await lineHead(
      await this.#inspectByAdmission(workKey), this.#inspectAdmission.bind(this),
    );
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
  const capabilities = storeCapabilities(ports.store);
  // A first admission writes the registry that every other first admission writes too, so a lost
  // compare-and-swap there usually means another issue was admitted in the same moment: labelling
  // several issues at once starts one intake per issue. The line is read again before each retry,
  // so a work key that did land meanwhile still answers StaleRevision and is never enqueued twice.
  for (let attempt = 1; ; attempt += 1) {
    let current = await capabilities.inspectByWork(identity.workKey);
    // Walk the admission line: past each re-admitted refusal to the chain an operator opened after
    // it. A refusal nobody re-admitted ends the walk, and the answer stays StaleRevision.
    while (current && isEffectFreeRefusal(current.terminal)) {
      const admissionKey = successorAdmissionKey(
        current.admission.key, current.terminal.committedRevision,
      );
      const successor = await capabilities.inspectAdmission(admissionKey);
      if (successor.state === 'OPEN') {
        if (expectedCommittedRevision !== 'NONE') return stale(current);
        const committed = await capabilities.enqueueSuccessor(
          admissionKey, identity, identity.envelope,
        );
        if (committed.stale) return stale({ committedRevision: committed.currentCommittedRevision });
        await emit(ports, { kind: 'ENQUEUED', operationId: identity.operationId });
        return {
          kind: 'Enqueued', operationId: identity.operationId, workKey: identity.workKey,
          generationKey: identity.generationKey, committedRevision: committed.committedRevision,
        };
      }
      if (successor.state !== 'PRESENT') break;
      current = successor.snapshot;
    }
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
    const committed = await capabilities.bootstrapAndEnqueue(
      identity, identity.envelope, expectedCommittedRevision,
    );
    if (committed.stale) {
      if (expectedCommittedRevision === 'NONE' && attempt < REGISTRY_WRITE_ATTEMPTS) continue;
      return stale({ committedRevision: committed.currentCommittedRevision });
    }
    await emit(ports, { kind: 'ENQUEUED', operationId: identity.operationId });
    return {
      kind: 'Enqueued', operationId: identity.operationId, workKey: identity.workKey,
      generationKey: identity.generationKey, committedRevision: committed.committedRevision,
    };
  }
}

/**
 * Open one successor admission after an effect-free refusal. Dry run unless `apply` is true.
 *
 * The refused chain is never touched: nothing is appended after a terminal record. The operator's
 * written reason and the dispatch that carried it become the successor root's content. The only
 * caller is an operator-dispatched run; intake has no path that reaches this function.
 */
export async function readmitDraft(operationId, expectedCommittedRevision, provenance, ports,
  { apply = false } = {}) {
  requireRevision(operationId, 'InvalidOperationId');
  requireRevision(expectedCommittedRevision);
  const readmission = validateReadmissionProvenance(provenance);
  if (typeof apply !== 'boolean') throw new DraftOperationError('InvalidReadmission');
  const capabilities = storeCapabilities(ports?.store);
  const snapshot = await capabilities.inspectByOperation(operationId);
  if (!snapshot) throw new DraftOperationError('UnknownOperation');
  if (snapshot.committedRevision !== expectedCommittedRevision) return stale(snapshot);
  if (!isEffectFreeRefusal(snapshot.terminal)) {
    return {
      kind: 'NotReadmissible', operationId, state: snapshot.state,
      outcome: snapshot.terminal?.outcome ?? null, committedRevision: snapshot.committedRevision,
    };
  }
  const root = successorRoot(snapshot, readmission);
  const planned = {
    operationId, workKey: snapshot.identity.workKey, refusal: snapshot.terminal.refusal,
    committedRevision: snapshot.committedRevision, admissionKey: root.admissionKey,
  };
  const existing = await capabilities.inspectAdmission(root.admissionKey);
  if (existing.state === 'OPEN' || existing.state === 'PRESENT') {
    return { kind: 'AlreadyReadmitted', ...planned };
  }
  if (!apply) return { kind: 'ReadmissionPlanned', ...planned };
  // The refused chain is terminal and cannot move, so a stale write here only means another
  // admission moved the shared registry first. Opening resumes from whatever landed, so it is
  // retried a bounded number of times before the run reports the contention.
  let opened;
  for (let attempt = 1; attempt <= REGISTRY_WRITE_ATTEMPTS; attempt += 1) {
    opened = await capabilities.openSuccessor(root);
    if (!opened.stale) break;
  }
  if (opened.stale) return { kind: 'ReadmissionContended', ...planned };
  if (!opened.opened) return { kind: 'AlreadyReadmitted', ...planned };
  await emit(ports, { kind: 'READMITTED', operationId, admissionKey: root.admissionKey });
  return { kind: 'Readmitted', ...planned, successorRootRevision: opened.committedRevision };
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
    ['workItem', closedObject([
      ['kind', envelope.workItem.kind],
      ['number', envelope.workItem.number],
    ])],
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

function sanitizeExactDraft(candidate, request, allowMerged = false) {
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
  let mergedEvidence = null;
  if (allowMerged && state === 'MERGED' && isDraft === false) {
    const evidence = readProviderFieldOnce(candidate, 'mergedEvidence');
    requireExactKeys(evidence, [
      'generationHeadRevision', 'headRevision', 'mergeCommit', 'mergedAt', 'comparison',
    ], 'ProviderProtocolViolation');
    const values = Object.fromEntries(Object.keys(evidence).map(key => [key, readProviderFieldOnce(evidence, key)]));
    const validInstant = typeof values.mergedAt === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(values.mergedAt)
      && Number.isFinite(Date.parse(values.mergedAt))
      && new Date(values.mergedAt).toISOString().replace('.000Z', 'Z') === values.mergedAt;
    if (values.generationHeadRevision !== request.headRevision || values.headRevision !== headRevision
      || typeof headRevision !== 'string' || !/^[a-f0-9]{40}$/.test(headRevision)
      || typeof values.mergeCommit !== 'string' || !/^[a-f0-9]{40}$/.test(values.mergeCommit)
      || !validInstant || !['ahead', 'identical'].includes(values.comparison)
      || (values.comparison === 'identical') !== (headRevision === request.headRevision)) {
      throw new DraftOperationError('ProviderProtocolViolation');
    }
    mergedEvidence = closedObject(Object.entries(values));
  }
  const repository = {
    nodeId: readProviderFieldOnce(repositoryCandidate, 'nodeId'),
    owner: readProviderFieldOnce(repositoryCandidate, 'owner'),
    name: readProviderFieldOnce(repositoryCandidate, 'name'),
  };
  if (!Number.isSafeInteger(number) || number <= 0
    || typeof url !== 'string' || url.length === 0 || /[\u0000-\u001f\u007f]/u.test(url)
    || (mergedEvidence === null && (isDraft !== true || state !== 'OPEN'))
    || operationMarker !== request.operationMarker
    || baseRef !== request.baseRef
    || headRef !== request.headRef
    || (mergedEvidence === null && headRevision !== request.headRevision)
    || repository.nodeId !== request.repository.nodeId
    || repository.owner !== request.repository.owner
    || repository.name !== request.repository.name) {
    throw new DraftOperationError('ProviderProtocolViolation');
  }
  return closedObject([
    ['number', number],
    ['url', url],
    ['isDraft', isDraft],
    ['state', state],
    ['operationMarker', request.operationMarker],
    ['repository', request.repository],
    ['baseRef', request.baseRef],
    ['headRef', request.headRef],
    ['headRevision', headRevision],
    ...(mergedEvidence === null ? [] : [['mergedEvidence', mergedEvidence]]),
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
      existing = sanitizeExactDraft(await ports.provider.lookupExact(request), request, true);
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
    } catch (error) {
      const witness = notInvokedWitnesses.get(error);
      notInvokedWitnesses.delete(error);
      if (witness?.request === request) {
        const appended = await appendOrCurrent(ports, operationId, snapshot.committedRevision,
          'REFUSED', { refusal: witness.refusal, effectBoundary: 'NOT_INVOKED' });
        if (!appended.ok) return appended.result;
        await emit(ports, { kind: 'REFUSED', operationId, refusal: witness.refusal });
        return terminalResult(appended.snapshot);
      }
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
