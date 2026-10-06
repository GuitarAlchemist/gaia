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

function candidateNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('InvalidHostedDraftPump');
  return value;
}

function skipReason(error) {
  const code = error?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'OperationFailed';
}

function readyIssue(value) {
  if (value === null || typeof value !== 'object' || typeof value.body !== 'string'
      || !Number.isSafeInteger(value.openBlockers) || value.openBlockers < 0
      || !Number.isSafeInteger(value.subIssues) || value.subIssues < 0) {
    fail('InvalidHostedDraftPump');
  }
  return {
    number: candidateNumber(value.number), body: value.body,
    openBlockers: value.openBlockers, subIssues: value.subIssues,
  };
}

/** One issue's dependency facts, read through the per-issue port and bound to the number asked. */
async function readIssue(readIssueDependencies, repository, number) {
  if (typeof readIssueDependencies !== 'function') fail('InvalidHostedDraftPump');
  const issue = await readIssueDependencies({ repository, number });
  if (issue === null || typeof issue !== 'object' || issue.number !== number) {
    fail('InvalidHostedDraftPump');
  }
  return issue;
}

// A `Blocked by:` line, in prose or as the `Blocked-By:` trailer the issue audit writes.
const DECLARED_BLOCKERS = /^[\t >*-]*Blocked[ -]by[ \t]*:(.*)$/iu;
// `#n` or `owner/name#n`; a bare `name#n` is not a reference.
const ISSUE_REFERENCE = /(?<![\w./-])(?:([\w.-]+)\/([\w.-]+))?#([1-9]\d*)\b/gu;

/**
 * The issues a `Blocked by` line names, in the order they appear. A reference into another
 * repository cannot be read through this repository's port, so it is `null`: not proven closed.
 */
function declaredBlockers(body, repository) {
  const blockers = new Set();
  for (const line of body.split(/\r?\n/u)) {
    const declared = line.match(DECLARED_BLOCKERS);
    if (declared === null) continue;
    for (const [, owner, name, number] of declared[1].matchAll(ISSUE_REFERENCE)) {
      const local = owner === undefined
        || (owner.toLowerCase() === repository.owner.toLowerCase()
          && name.toLowerCase() === repository.name.toLowerCase());
      blockers.add(local ? Number(number) : null);
    }
  }
  return [...blockers];
}

/**
 * Why a ready issue is not on the frontier, as a closed skip reason, or null when it is.
 *
 * Only a blocker read as `CLOSED` releases the issue: any other state, or a reference this port
 * cannot read, keeps it waiting, because a blocker read as "no blocker" is the direction this
 * selection must never fail in.
 */
async function outsideFrontier(issue, repository, readIssueDependencies) {
  if (issue.subIssues > 0) return 'HasSubIssues';
  if (issue.openBlockers > 0) return 'NativeBlockerOpen';
  for (const number of declaredBlockers(issue.body, repository)) {
    if (number === null) return 'DeclaredBlockerOpen';
    const blocker = await readIssue(readIssueDependencies, repository, number);
    if (blocker.state !== 'CLOSED') return 'DeclaredBlockerOpen';
  }
  return null;
}

async function boundPorts(create, argument) {
  const ports = await create(argument);
  if (ports === null || typeof ports !== 'object') fail('InvalidHostedDraftPump');
  return ports;
}

/**
 * The closed intake receipt.
 *
 * `workItem` and `unsettledCount` are published because they are facts this run knows and nobody
 * downstream can recover: the issue a transition belongs to is requirement 7's binding, and the
 * count is what remained unsettled AFTER this run acted, not what it found before it. Publishing
 * the starting count would read a completed recovery as a stuck queue.
 *
 * The count is built from two reads rather than one. The projection over the pre-action snapshot
 * carries what this run did to its own operation, which a bare recount cannot attribute; the
 * post-action read carries what a concurrent lane did, which no projection can see. See
 * `concurrentlyAppeared`.
 */
function intakeReceipt(phase, binding, value, skipped) {
  return freeze({
    schema: 'GaiaHostedDraftIntakeReceiptV0',
    phase,
    operationId: binding.operationId,
    workKey: binding.workKey,
    committedRevision: binding.committedRevision,
    workItem: binding.workItem,
    unsettledCount: binding.unsettledCount,
    result: value,
    skipped,
  });
}

/** A settled operation is one that reached a terminal outcome; everything else is still open. */
function settledByThisRun(value) {
  return value.kind === 'Terminal';
}

/**
 * Durably unsettled work this run neither found before it acted nor admitted itself.
 *
 * Intake lanes no longer share one repository-wide concurrency queue: a labeled lane runs under
 * `gaia-draft-intake-issue-<N>` and scheduled recovery under `gaia-draft-intake-recovery`, so a
 * labeled lane can commit to the ledger while a recovery run is still selecting. The pre-action
 * snapshot cannot see that write, and a run that published the snapshot alone would render the
 * repository healthy over work it could have read. So the ledger is read once more, after this run
 * has acted, and anything new that is not this run's own operation is added to the count.
 *
 * Only ever added. A published count may be raised toward `UNSETTLED` and never lowered toward
 * `EXPECTED_NONE`, because a blocker read as "no blocker" is the one direction this seam must never
 * fail — so a read that lags or returns less than the projection cannot manufacture a false clear.
 * This narrows the window rather than closing it: a lane committing after this read is still
 * unobserved, and that residual is the ordinary staleness the freshness window already carries.
 */
async function concurrentlyAppeared(deps, observedBefore, ownWorkKey) {
  const listed = await deps.listUnsettledDrafts(deps.ledgerPorts);
  if (!Array.isArray(listed)) fail('InvalidUnsettledOperation');
  return listed
    .map(unsettled)
    .filter((record) => record.workKey !== ownWorkKey && !observedBefore.has(record.workKey))
    .length;
}

function settledRevision(value, fallback) {
  if (typeof value.committedRevision === 'string') return value.committedRevision;
  if (typeof value.currentCommittedRevision === 'string') return value.currentCommittedRevision;
  return fallback;
}

function unchangedAmbiguousRetry(value, record) {
  const observedRevision = typeof value.committedRevision === 'string'
    ? value.committedRevision
    : typeof value.currentCommittedRevision === 'string'
      ? value.currentCommittedRevision
      : null;
  return value.kind === 'Pending'
    && value.state === 'EFFECT_AMBIGUOUS'
    && value.effect === 'UNKNOWN'
    && value.providerError === 'ProviderAmbiguous'
    && observedRevision === record.committedRevision;
}

export async function runHostedDraftIntake({
  repository, candidates = null, limit = 5,
} = {}, {
  ledgerPorts,
  operationPortsFor,
  operationPortsForSelector,
  listReadyIssues = null,
  readIssueDependencies = null,
  listUnsettledDrafts = listUnsettledDraftsCore,
  enqueueDraft = enqueueDraftCore,
  reconcileDraft = reconcileDraftCore,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) fail('InvalidHostedDraftPump');
  const deps = dependencies({
    ledgerPorts, operationPortsFor, operationPortsForSelector,
    listUnsettledDrafts, enqueueDraft, reconcileDraft,
  }, [
    'ledgerPorts', 'operationPortsFor', 'operationPortsForSelector',
    'listUnsettledDrafts', 'enqueueDraft', 'reconcileDraft',
  ]);
  const { repository: canonicalRepository } = selector({
    repository, workItem: { kind: 'ISSUE', number: 1 },
  });

  let explicitNumbers = null;
  if (candidates !== null) {
    if (!Array.isArray(candidates)) fail('InvalidHostedDraftPump');
    explicitNumbers = candidates.map(candidateNumber);
  }

  const listed = await deps.listUnsettledDrafts(deps.ledgerPorts);
  if (!Array.isArray(listed)) fail('InvalidUnsettledOperation');
  const allRecords = listed.map(unsettled).sort(
    (left, right) => left.workKey.localeCompare(right.workKey, 'en'),
  );
  const observedBefore = new Set(allRecords.map((record) => record.workKey));
  const explicitIssueNumbers = explicitNumbers === null ? null : new Set(explicitNumbers);
  const records = explicitIssueNumbers === null
    ? allRecords
    : allRecords.filter((record) => explicitIssueNumbers.has(record.selector.workItem.number));
  const skipped = [];
  if (records.length > 0) {
    for (const record of records.slice(0, limit)) {
      const ports = await boundPorts(
        deps.operationPortsFor, freeze(ownedClone(record, 'InvalidUnsettledOperation')),
      );
      const reconciled = result(await deps.reconcileDraft(
        record.operationId, record.committedRevision, ports,
      ));
      // A scheduled retry that remains ambiguous at the exact same durable revision performed no
      // new effect. Quarantine it for this tick so one poison message cannot block the queue. An
      // issue-scoped run remains fail-closed, and any changed revision stops here for observation.
      if (explicitIssueNumbers === null && unchangedAmbiguousRetry(reconciled, record)) {
        skipped.push({ number: record.selector.workItem.number, reason: 'EFFECT_AMBIGUOUS' });
        continue;
      }
      const appeared = await concurrentlyAppeared(deps, observedBefore, record.workKey);
      return intakeReceipt('RESUME', {
        operationId: record.operationId,
        workKey: record.workKey,
        committedRevision: settledRevision(reconciled, record.committedRevision),
        workItem: record.selector.workItem,
        unsettledCount: allRecords.length - (settledByThisRun(reconciled) ? 1 : 0) + appeared,
      }, reconciled, skipped);
    }
  }

  let numbers;
  let readyIssues = null;
  if (candidates === null) {
    if (typeof listReadyIssues !== 'function') fail('InvalidHostedDraftPump');
    const rows = await listReadyIssues({ repository: canonicalRepository });
    if (!Array.isArray(rows)) fail('InvalidHostedDraftPump');
    readyIssues = new Map(rows.map(readyIssue).map((issue) => [issue.number, issue]));
    numbers = [...readyIssues.keys()];
  } else {
    numbers = explicitNumbers;
  }
  const ordered = [...new Set(numbers)].sort((left, right) => left - right);

  // The limit bounds Draft probes, so only frontier issues count against it: an issue waiting on
  // a blocker or a spec costs no probe and cannot starve the frontier behind it.
  let probes = 0;
  for (const number of ordered) {
    if (probes === limit) break;
    let frontierRefusal;
    try {
      // A labeled lane names its candidate without listing it, so it reads that issue's facts.
      const issue = readyIssues === null
        ? readyIssue(await readIssue(readIssueDependencies, canonicalRepository, number))
        : readyIssues.get(number);
      frontierRefusal = await outsideFrontier(issue, canonicalRepository, readIssueDependencies);
    } catch (error) {
      // An unreadable blocker keeps its own issue waiting, not every issue behind it.
      if (error?.code === 'GitHubRateLimited') throw error;
      skipped.push({ number, reason: skipReason(error) });
      continue;
    }
    if (frontierRefusal !== null) {
      skipped.push({ number, reason: frontierRefusal });
      continue;
    }
    probes += 1;
    const canonicalSelector = selector({
      repository: canonicalRepository, workItem: { kind: 'ISSUE', number },
    });
    let enqueued;
    try {
      const enqueuePorts = await boundPorts(
        deps.operationPortsForSelector, freeze(ownedClone(canonicalSelector, 'InvalidHostedDraftPump')),
      );
      enqueued = result(await deps.enqueueDraft(canonicalSelector, 'NONE', enqueuePorts));
    } catch (error) {
      // Every later candidate would spend the same exhausted quota, so a rate limit ends the tick.
      if (error?.code === 'GitHubRateLimited') throw error;
      skipped.push({ number, reason: skipReason(error) });
      continue;
    }
    if (enqueued.kind !== 'Enqueued') {
      skipped.push({ number, reason: enqueued.kind });
      continue;
    }
    const operationId = revision(enqueued.operationId, 'InvalidHostedDraftResult');
    const workKey = revision(enqueued.workKey, 'InvalidHostedDraftResult');
    const committedRevision = revision(enqueued.committedRevision, 'InvalidHostedDraftResult');
    const ports = await boundPorts(deps.operationPortsFor, freeze({
      operationId, workKey, committedRevision, selector: canonicalSelector,
    }));
    const reconciled = result(await deps.reconcileDraft(operationId, committedRevision, ports));
    const appeared = await concurrentlyAppeared(deps, observedBefore, workKey);
    return intakeReceipt('ADMIT', {
      operationId, workKey, committedRevision: settledRevision(reconciled, committedRevision),
      workItem: canonicalSelector.workItem,
      unsettledCount: allRecords.length + (settledByThisRun(reconciled) ? 0 : 1) + appeared,
    }, reconciled, skipped);
  }

  return intakeReceipt(
    'EXPECTED_NONE',
    {
      operationId: null, workKey: null, committedRevision: null,
      workItem: null,
      unsettledCount: allRecords.length
        + await concurrentlyAppeared(deps, observedBefore, null),
    },
    null,
    skipped,
  );
}
