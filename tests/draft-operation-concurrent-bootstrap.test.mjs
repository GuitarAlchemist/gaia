/**
 * Two runs bootstrapping the same admission at once, against one shared Git Data ledger.
 *
 * A labelled intake and a recovery intake sit in different concurrency groups, so both can admit
 * one issue together, and two operator dispatches can open one successor together. Each scenario
 * gates one run inside the other's bootstrap at the exact read where the window was: the registry
 * must end with one confirmation, the work ref with one ENQUEUED, and no run may report a
 * corruption that is not there.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  admissionRetryPauseMs,
  createDraftOperationPorts,
  createGitDataDraftOperationStore,
  enqueueDraft,
  guardDraftCreation,
  readmitDraft,
  reconcileDraft,
} from '../src/draft-operation-envelope.mjs';

const REGISTRY_REF = 'refs/heads/gaia-ledger/registry-v0';
const WORK_PREFIX = 'refs/heads/gaia-ledger/draft-operations-v0/';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const OID_A = '1'.repeat(40);
const OID_B = '2'.repeat(40);
const SELECTOR = {
  repository: { owner: 'GuitarAlchemist', name: 'gaia' },
  workItem: { kind: 'ISSUE', number: 176 },
};

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
  ).join(',')}}`;
}

const sha256 = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

const REPOSITORY = { nodeId: 'R_kgDOConcurrent', owner: 'GuitarAlchemist', name: 'gaia' };
const WORK_KEY = sha256({
  schema: 'GaiaDraftWorkKeyV0', repositoryNodeId: REPOSITORY.nodeId,
  workItem: SELECTOR.workItem, requestedEffect: 'CREATE_DRAFT',
});
const WORK_REF = `${WORK_PREFIX}${WORK_KEY}`;

function readyEvent(occurrence) {
  return {
    schema: 'GaiaDraftOperationEnvelopeV0', repository: REPOSITORY, workItem: SELECTOR.workItem,
    readyItem: {
      schema: 'GaiaReadyItemIdentityV0', queueReceiptRevision: SHA_A, occurrence,
      id: sha256({
        schema: 'GaiaReadyItemIdV0', workKey: WORK_KEY, queueReceiptRevision: SHA_A,
        occurrence, observedSourceRevision: SHA_B,
      }),
    },
    observedSourceRevision: SHA_B,
    generation: {
      baseRef: 'main', headRef: `gaia/issue-176-ready-${occurrence}`,
      headRevision: OID_B, policyRevision: OID_A,
    },
    requestedEffect: 'CREATE_DRAFT',
  };
}

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { open, opened };
}

/** One ledger, and one Git Data port per run, each port able to pause its run at a read or write. */
function sharedLedger() {
  const registryRoot = {
    schema: 'GaiaDraftRegistryRootV0', priorCommittedRevision: 'NONE', kind: 'REGISTRY_ROOT',
  };
  const refs = new Map([[REGISTRY_REF, [{
    oid: OID_A, body: registryRoot, committedRevision: sha256(registryRoot),
  }]]]);
  let nextOid = 3;
  const hooks = { beforeRead: async () => {}, beforeAppend: async () => {} };
  const port = (run) => Object.freeze({
    async verifyProtection() { return true; },
    async read(ref) {
      await hooks.beforeRead(run, ref);
      const records = refs.get(ref);
      return records ? { state: 'PRESENT', records: structuredClone(records) } : { state: 'UNSEEN' };
    },
    async readByOperation(operationId) {
      const matches = [...refs.values()].filter(
        (records) => records.some((record) => record.body.operationId === operationId),
      );
      return matches.length === 0 ? { state: 'UNSEEN' }
        : { state: 'PRESENT', records: structuredClone(matches[0]) };
    },
    async compareAndAppend(ref, expectedHeadOid, body, transportMetadata) {
      await hooks.beforeAppend(run, ref, body);
      const records = refs.get(ref) ?? [];
      const current = records.at(-1)?.oid ?? 'NONE';
      if (current !== expectedHeadOid) return { kind: 'STALE', currentHeadOid: current };
      const record = {
        oid: (nextOid++).toString(16).padStart(40, '0'),
        body: structuredClone(body), committedRevision: sha256(body),
      };
      if (transportMetadata !== undefined) record.transportMetadata = structuredClone(transportMetadata);
      refs.set(ref, [...records, record]);
      return { kind: 'APPENDED', ...structuredClone(record) };
    },
  });
  const config = { ledgerRegistryRootOid: OID_A, ledgerRegistryRootRevision: sha256(registryRoot) };
  let rivals = 0;
  return {
    hooks,
    /** Another issue's reservation lands on the shared registry. */
    rival() {
      const head = refs.get(REGISTRY_REF).at(-1);
      rivals += 1;
      const body = {
        schema: 'GaiaDraftRegistryReceiptV0', priorCommittedRevision: head.committedRevision,
        kind: 'RESERVED', workKey: sha256({ rival: rivals }),
      };
      refs.set(REGISTRY_REF, [...refs.get(REGISTRY_REF), {
        oid: (nextOid++).toString(16).padStart(40, '0'), body, committedRevision: sha256(body),
      }]);
    },
    store: (run) => createGitDataDraftOperationStore({ gitData: port(run), config }),
    kinds: (ref) => (refs.get(ref) ?? []).map((record) => record.body.kind),
    confirmations: (key) => (refs.get(REGISTRY_REF) ?? []).filter((record) => record.body.kind === 'CONFIRMED'
      && (record.body.admissionKey ?? record.body.workKey) === key).length,
  };
}

function portsFor(store, envelope, provider, pause = async () => {}) {
  return createDraftOperationPorts({
    collector: { async collect() { return structuredClone(envelope); } },
    provider: provider ?? {
      async lookupExact() { return null; },
      async createDraft() { assert.fail('no Draft is created here'); },
    },
    admission: { async reserveEffect() { return 'AVAILABLE'; } },
    executorEpoch: { runId: 7201, runAttempt: 1 },
    telemetry: { async append() {} },
    store,
    pause,
  });
}

const enqueue = (store, pause) => enqueueDraft(
  SELECTOR, 'NONE', portsFor(store, readyEvent(1), undefined, pause),
);
const outcome = (promise) => promise.then((result) => result.kind, (error) => error.code ?? error.message);

test('a run resuming a bootstrap adopts the confirmation that lands meanwhile, never writes a second', async () => {
  const ledger = sharedLedger();
  const rooted = gate();
  const releaseConfirm = gate();
  const confirmed = gate();
  const releaseEnqueue = gate();
  let resumerWorkReads = 0;
  ledger.hooks.beforeAppend = async (run, _ref, body) => {
    if (run !== 'first') return;
    if (body.kind === 'CONFIRMED') { rooted.open(); await releaseConfirm.opened; }
    if (body.kind === 'ENQUEUED') { confirmed.open(); await releaseEnqueue.opened; }
  };
  ledger.hooks.beforeRead = async (run, ref) => {
    // The resumer's second read of the work ref is its bootstrap reading the first run's root; the
    // first run's confirmation lands before the resumer reads the registry again.
    if (run === 'resumer' && ref === WORK_REF && ++resumerWorkReads === 2) {
      releaseConfirm.open();
      await confirmed.opened;
    }
  };

  const first = outcome(enqueue(ledger.store('first')));
  await rooted.opened;
  const resumer = await outcome(enqueue(ledger.store('resumer')));
  releaseEnqueue.open();

  assert.deepEqual([await first, resumer].sort(), ['Enqueued', 'StaleRevision']);
  assert.equal(ledger.confirmations(WORK_KEY), 1, 'one confirmation, adopted by the resumer');
  assert.deepEqual(ledger.kinds(WORK_REF), ['WORK_ROOT', 'ENQUEUED']);
  ledger.hooks.beforeAppend = async () => {};
  ledger.hooks.beforeRead = async () => {};
  assert.equal(await outcome(enqueue(ledger.store('later'))), 'StaleRevision',
    'the registry stays readable for every later intake');
});

test('a run that reads the registry before a whole rival admission lands reports it stale, not corrupt', async () => {
  // Read 1 is the admission-line inspection, read 2 the bootstrap: the rival completes between the
  // registry read and the work-ref read of each.
  for (const window of [1, 2]) {
    const ledger = sharedLedger();
    let lateWorkReads = 0;
    let rival;
    ledger.hooks.beforeRead = async (run, ref) => {
      if (run === 'late' && ref === WORK_REF && ++lateWorkReads === window) {
        rival = await outcome(enqueue(ledger.store('rival')));
      }
    };
    const late = await outcome(enqueue(ledger.store('late')));
    assert.equal(rival, 'Enqueued', `window ${window}`);
    assert.equal(late, 'StaleRevision', `window ${window}`);
    assert.equal(ledger.confirmations(WORK_KEY), 1, `window ${window}`);
    assert.deepEqual(ledger.kinds(WORK_REF), ['WORK_ROOT', 'ENQUEUED'], `window ${window}`);
  }
});

test('an admission that loses every attempt is contended, unless its own work key landed', async () => {
  for (const lastRivalIsThisIssue of [false, true]) {
    const ledger = sharedLedger();
    let reservations = 0;
    ledger.hooks.beforeAppend = async (run, ref, body) => {
      if (run !== 'contended' || ref !== REGISTRY_REF || body.kind !== 'RESERVED') return;
      reservations += 1;
      // Before each of this run's reservations, a rival lands on the registry first. The last
      // rival is either another issue or another intake of this same issue.
      if (reservations === 3 && lastRivalIsThisIssue) {
        assert.equal(await outcome(enqueue(ledger.store('rival'))), 'Enqueued');
      } else {
        ledger.rival();
      }
    };
    const waited = [];
    const result = await enqueue(ledger.store('contended'), async (ms) => { waited.push(ms); });
    assert.equal(reservations, 3, 'three attempts in all');
    assert.deepEqual(waited, [admissionRetryPauseMs(WORK_KEY, 1), admissionRetryPauseMs(WORK_KEY, 2)],
      'a pause before each retry, none once the last attempt is lost');
    if (lastRivalIsThisIssue) {
      assert.equal(result.kind, 'StaleRevision', 'an issue admitted meanwhile is settled');
      assert.deepEqual(ledger.kinds(WORK_REF), ['WORK_ROOT', 'ENQUEUED']);
    } else {
      assert.deepEqual(result, { kind: 'AdmissionContended', workKey: WORK_KEY },
        'an issue never admitted is not reported as settled');
      assert.deepEqual(ledger.kinds(WORK_REF), []);
      ledger.hooks.beforeAppend = async () => {};
      assert.equal(await outcome(enqueue(ledger.store('next'))), 'Enqueued', 'the next run admits it');
    }
    assert.equal(ledger.confirmations(WORK_KEY), 1);
  }
});

test('two operator dispatches opening one successor leave one confirmation', async () => {
  const ledger = sharedLedger();
  const setup = ledger.store('setup');
  const expired = {
    async lookupExact() { return null; },
    createDraft: guardDraftCreation({
      prepare: async () => { throw Object.assign(new Error('expired'), { code: 'NormalPolicyExpired' }); },
      invoke: async () => assert.fail('the create call must not run'),
    }),
  };
  const accepted = await enqueueDraft(SELECTOR, 'NONE', portsFor(setup, readyEvent(1), expired));
  const refused = await reconcileDraft(accepted.operationId, accepted.committedRevision,
    portsFor(setup, readyEvent(1), expired));
  assert.equal(refused.kind, 'Terminal');
  const successorKey = sha256({
    schema: 'GaiaDraftSuccessorAdmissionKeyV0',
    predecessorAdmissionKey: WORK_KEY, predecessorTerminalRevision: refused.committedRevision,
  });
  const successorRef = `${WORK_PREFIX}${successorKey}`;
  const provenance = (runId) => ({
    reason: 'Refused before the provider; the create call never ran.',
    runId, runAttempt: 1, triggeringActor: 'spareilleux',
  });

  const rooted = gate();
  const releaseConfirm = gate();
  const confirmed = gate();
  let secondSuccessorReads = 0;
  ledger.hooks.beforeAppend = async (run, _ref, body) => {
    if (run === 'first' && body.kind === 'CONFIRMED') { rooted.open(); await releaseConfirm.opened; }
  };
  ledger.hooks.beforeRead = async (run, ref) => {
    // The second dispatch's second read of the successor ref is its opening reading the first
    // dispatch's root; the first dispatch confirms before the second reads the registry again.
    if (run === 'second' && ref === successorRef && ++secondSuccessorReads === 2) {
      releaseConfirm.open();
      await confirmed.opened;
    }
  };
  const firstRun = readmitDraft(accepted.operationId, refused.committedRevision, provenance(7301),
    { store: ledger.store('first') }, { apply: true })
    .then((result) => { confirmed.open(); return result.kind; });
  await rooted.opened;
  const second = await outcome(readmitDraft(accepted.operationId, refused.committedRevision,
    provenance(7302), { store: ledger.store('second') }, { apply: true }));

  assert.equal(await firstRun, 'Readmitted');
  assert.equal(second, 'AlreadyReadmitted');
  assert.equal(ledger.confirmations(successorKey), 1);
  assert.deepEqual(ledger.kinds(successorRef), ['WORK_ROOT']);
});
