import {
  enqueueDraft as enqueueDraftCore,
  listUnsettledDrafts as listUnsettledDraftsCore,
  reconcileDraft as reconcileDraftCore,
} from './draft-operation-envelope.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;

export class HostedDraftPumpError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'HostedDraftPumpError';
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new HostedDraftPumpError(code, message);
}

function ownData(value, code, expectedKeys = null) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string'
      || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail(code);
  if (expectedKeys !== null) {
    const actual = [...keys].sort();
    const expected = [...expectedKeys].sort();
    if (actual.length !== expected.length
        || actual.some((key, index) => key !== expected[index])) fail(code);
  }
  return value;
}

function revision(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

function selector(value) {
  const code = 'InvalidHostedDraftPump';
  ownData(value, code, ['repository', 'workItem']);
  ownData(value.repository, code, ['owner', 'name']);
  ownData(value.workItem, code, ['kind', 'number']);
  if (typeof value.repository.owner !== 'string' || value.repository.owner.length === 0
      || typeof value.repository.name !== 'string' || value.repository.name.length === 0
      || value.workItem.kind !== 'ISSUE'
      || !Number.isSafeInteger(value.workItem.number) || value.workItem.number < 1) fail(code);
  return {
    repository: { owner: value.repository.owner, name: value.repository.name },
    workItem: { kind: 'ISSUE', number: value.workItem.number },
  };
}

function ownedClone(value, code) {
  try {
    return structuredClone(value);
  } catch {
    fail(code);
  }
}

function freeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function dependencies(value, names) {
  ownData(value, 'InvalidHostedDraftPump');
  for (const name of names) {
    if (name === 'operationPorts' || name === 'ledgerPorts') {
      if (value[name] === null || typeof value[name] !== 'object') fail('InvalidHostedDraftPump');
    } else if (typeof value[name] !== 'function') fail('InvalidHostedDraftPump');
  }
  return value;
}

function result(value) {
  ownData(value, 'InvalidHostedDraftResult');
  if (typeof value.kind !== 'string' || value.kind.length === 0) fail('InvalidHostedDraftResult');
  return ownedClone(value, 'InvalidHostedDraftResult');
}

function unsettled(value) {
  ownData(value, 'InvalidUnsettledOperation', [
    'operationId', 'workKey', 'committedRevision', 'selector',
  ]);
  return {
    operationId: revision(value.operationId, 'InvalidUnsettledOperation'),
    workKey: revision(value.workKey, 'InvalidUnsettledOperation'),
    committedRevision: revision(value.committedRevision, 'InvalidUnsettledOperation'),
    selector: selector(value.selector),
  };
}

export async function runHostedDraftPump({ selector: selectorInput }, {
  operationPorts,
  enqueueDraft = enqueueDraftCore,
  reconcileDraft = reconcileDraftCore,
} = {}) {
  const deps = dependencies(
    { operationPorts, enqueueDraft, reconcileDraft },
    ['operationPorts', 'enqueueDraft', 'reconcileDraft'],
  );
  const canonicalSelector = selector(selectorInput);
  const enqueued = result(await deps.enqueueDraft(canonicalSelector, 'NONE', deps.operationPorts));
  if (enqueued.kind !== 'Enqueued') {
    return freeze({
      schema: 'GaiaHostedDraftPumpReceiptV0', action: 'START',
      selector: canonicalSelector, operationId: null, result: enqueued,
    });
  }
  const operationId = revision(enqueued.operationId, 'InvalidHostedDraftResult');
  const committedRevision = revision(enqueued.committedRevision, 'InvalidHostedDraftResult');
  const reconciled = result(await deps.reconcileDraft(
    operationId, committedRevision, deps.operationPorts,
  ));
  return freeze({
    schema: 'GaiaHostedDraftPumpReceiptV0', action: 'START',
    selector: canonicalSelector, operationId, result: reconciled,
  });
}

export async function runHostedDraftSupervisor({ limit = 1 } = {}, {
  ledgerPorts,
  operationPortsFor,
  listUnsettledDrafts = listUnsettledDraftsCore,
  reconcileDraft = reconcileDraftCore,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) fail('InvalidHostedDraftPump');
  const deps = dependencies(
    { ledgerPorts, operationPortsFor, listUnsettledDrafts, reconcileDraft },
    ['ledgerPorts', 'operationPortsFor', 'listUnsettledDrafts', 'reconcileDraft'],
  );
  const listed = await deps.listUnsettledDrafts(deps.ledgerPorts);
  if (!Array.isArray(listed)) fail('InvalidUnsettledOperation');
  const records = listed.map(unsettled).sort(
    (left, right) => left.operationId.localeCompare(right.operationId, 'en'),
  );
  const results = [];
  for (const record of records.slice(0, limit)) {
    const operationPorts = await deps.operationPortsFor(freeze(ownedClone(
      record, 'InvalidUnsettledOperation',
    )));
    if (operationPorts === null || typeof operationPorts !== 'object') {
      fail('InvalidHostedDraftPump');
    }
    const reconciled = result(await deps.reconcileDraft(
      record.operationId, record.committedRevision, operationPorts,
    ));
    results.push({ operationId: record.operationId, result: reconciled });
  }
  return freeze({
    schema: 'GaiaHostedDraftSupervisorReceiptV0',
    discovered: records.length,
    attempted: results.length,
    results,
  });
}
