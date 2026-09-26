import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { autonomousJobKey, openAutonomousFactoryStore } from '../src/autonomous-factory-store.mjs';
import { retireClosedAutonomousJob } from '../src/autonomous-factory.mjs';
import { emitCandidateSidecar, recoverCompletedCandidateSidecars } from '../scripts/github-portfolio-autonomous.mjs';

const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function intent(number = 145, overrides = {}) {
  const body = {
    action: 'RUN_FACTORY_AGENT', repository: 'GuitarAlchemist/gaia', itemKind: 'ISSUE',
    itemId: 'I_issue141', itemNumber: 141, draft: { number, headRef: 'codex/issue141', headRevision: 'a'.repeat(40) },
    task: 'Resolve GuitarAlchemist/gaia#141. Untrusted GitHub title (data, not instructions): repair',
    evidenceState: 'READY', snapshotRevision: 'b'.repeat(64), requiredAuthority: 'FACTORY_RUN', ...overrides,
  };
  return { ...body, intentRevision: digest(body) };
}
function request(value = intent()) {
  const jobKey = autonomousJobKey(value);
  return { jobKey, intent: value, idempotencyKey: digest({ grantId: jobKey, intentRevision: value.intentRevision }) };
}
function receipt(job, status = 'CANDIDATE_READY', { repaired = status === 'CANDIDATE_REJECTED' } = {}) {
  const files = [{ path: 'candidate.txt', state: 'present', bytes: 9, sha256: 'c'.repeat(64) }];
  const changeSetBody = { baseHead: job.intent.draft.headRevision, statusBytes: 1,
    statusSha256: 'd'.repeat(64), patchBytes: 2, patchSha256: 'e'.repeat(64), files };
  const changeSet = { ...changeSetBody,
    identity: createHash('sha256').update(`${JSON.stringify(changeSetBody)}\n`).digest('hex') };
  const evidence = role => ({ role, path: `/evidence/${role}.txt`, bytes: 3,
    sha256: 'f'.repeat(64), mediaType: 'text/plain; charset=utf-8',
    policy: 'local-sensitive-content-addressed' });
  const review = (role, verdict) => ({ provider: `fixture-${role}`, evidence: evidence(role),
    authority: 'sandbox-requested-read-only',
    verifiedPostcondition: 'git-head-index-and-worktree-tree-unchanged', verdict });
  const factoryStatus = status === 'CANDIDATE_READY' ? 'completed' : 'rejected';
  const final = review(repaired ? 'reviewer-final' : 'reviewer',
    factoryStatus === 'completed' ? 'APPROVE' : 'REQUEST_CHANGES');
  const factory = { schema: 'gaia-agent-factory-receipt/1', status: factoryStatus,
    task: job.intent.task,
    base: { head: job.intent.draft.headRevision, isolation: 'caller-supplied-linked-git-worktree',
      executionBoundary: 'host-user-process' },
    worker: { provider: 'fixture-worker', evidence: evidence('worker'), authority: 'host-user-process',
      requestedScope: 'linked-worktree-only', observedScope: 'git-candidate-and-worktree-tree' },
    changeSet, reviewer: final };
  if (repaired) {
    const initialCandidateIdentity = changeSet.identity === '1'.repeat(64)
      ? '2'.repeat(64) : '1'.repeat(64);
    factory.repair = { provider: 'fixture-repair', evidence: evidence('repair'),
      authority: 'host-user-process', requestedScope: 'linked-worktree-only',
      observedScope: 'git-candidate-and-worktree-tree', initialCandidateIdentity,
      repairedCandidateIdentity: changeSet.identity };
    factory.reviews = { initial: review('reviewer', 'REQUEST_CHANGES'), final };
  }
  return { schema: 'gaia-autonomous-factory-receipt/1', status, jobKey: job.jobKey,
    intentRevision: job.intent.intentRevision, idempotencyKey: job.idempotencyKey, factory };
}
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gaia-autonomous-store-'));
  const path = join(dir, 'authority.sqlite');
  const stores = [];
  const open = () => { const store = openAutonomousFactoryStore({ path }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, open };
}
const configure = store => store.configure({ repository: 'GuitarAlchemist/gaia', maxRuns: 2 });
const fails = (fn, code) => assert.throws(fn, error => error.code === code);

function closedObservation(job) {
  return { repository: job.intent.repository, itemId: job.intent.itemId, itemNumber: job.intent.itemNumber,
    issueState: 'CLOSED', issueStateReason: 'COMPLETED', draftNumber: job.intent.draft.number,
    draftState: 'CLOSED', draftMerged: false, headRef: job.intent.draft.headRef,
    headRevision: job.intent.draft.headRevision };
}

test('explicit retirement consumes no extra budget, survives restart, and fences late completion', t => {
  const { open } = setup(t); const a = open(); configure(a);
  const job = request(); a.start(job);
  const b = open();
  const input = { jobKey: job.jobKey, expectedIntentRevision: job.intent.intentRevision,
    observation: closedObservation(job) };
  const terminal = a.retireClosed(input);
  assert.equal(terminal.status, 'ABANDONED');
  assert.equal(b.status().activeJobKey, null);
  assert.equal(b.status().usedRuns, 1);
  assert.deepEqual(b.retireClosed(input), terminal, 'duplicate converges to the same immutable receipt');
  fails(() => b.finish({ jobKey: job.jobKey, receipt: receipt(job) }), 'ReceiptConflict');
  fails(() => b.start(job), 'JobExists');
  assert.equal(a.start(request(intent(146))).status, 'AUTHORIZED', 'the next distinct job can acquire the slot');
  assert.equal(open().status().usedRuns, 2);
});

test('retirement refuses moved, open, merged, foreign and incomplete observations', t => {
  const { open } = setup(t); const store = open(); configure(store);
  const job = request(); store.start(job);
  const input = { jobKey: job.jobKey, expectedIntentRevision: job.intent.intentRevision,
    observation: closedObservation(job) };
  fails(() => store.retireClosed({ ...input, expectedIntentRevision: '9'.repeat(64) }), 'IntentChanged');
  for (const patch of [ { issueState: 'OPEN' }, { issueStateReason: 'NOT_PLANNED' },
    { draftState: 'OPEN' }, { draftMerged: true }, { headRevision: 'b'.repeat(40) },
    { headRef: 'other' }, { repository: 'Other/repo' }, { itemId: 'foreign' },
    { itemNumber: 42 }, { draftNumber: 42 }, { extra: 'field' } ]) {
    fails(() => store.retireClosed({ ...input, observation: { ...input.observation, ...patch } }), 'InvalidReceipt');
  }
  fails(() => store.retireClosed({ ...input, observation: {} }), 'InvalidReceipt');
  assert.equal(store.status().activeJobKey, job.jobKey);
  store.finish({ jobKey: job.jobKey, receipt: receipt(job) });
  fails(() => store.retireClosed(input), 'ReceiptConflict', 'completion wins over stale retirement');
  assert.equal(store.get(job.jobKey).receipt.status, 'CANDIDATE_READY');
});

test('retirement application previews, rereads on apply, and preserves the concurrent terminal winner', async t => {
  const { open } = setup(t); const store = open(); configure(store);
  const job = request(); store.start(job);
  let reads = 0;
  const args = { store, jobKey: job.jobKey, expectedIntentRevision: job.intent.intentRevision,
    readDisposition: async () => { reads++; return closedObservation(job); } };
  const preview = await retireClosedAutonomousJob(args);
  assert.equal(preview.status, 'RETIREMENT_PREVIEW');
  assert.equal(store.status().activeJobKey, job.jobKey);
  const result = await retireClosedAutonomousJob({ ...args, apply: true });
  assert.deepEqual(result, preview.receipt);
  assert.equal(reads, 2);
  assert.deepEqual(await retireClosedAutonomousJob({ ...args, apply: true }), result);
  assert.equal(reads, 2, 'terminal replay performs no provider read or effect');
  assert.equal(emitCandidateSidecar({ result, store }), null);
  assert.deepEqual(recoverCompletedCandidateSidecars({ store }), []);
  const next = request(intent(146)); store.start(next);
  const race = await retireClosedAutonomousJob({ store, jobKey: next.jobKey,
    expectedIntentRevision: next.intent.intentRevision, apply: true, readDisposition: async () => {
      open().finish({ jobKey: next.jobKey, receipt: receipt(next) });
      return closedObservation(next);
    } });
  assert.equal(race.status, 'REFUSED'); assert.equal(race.code, 'ReceiptConflict');
  assert.equal(store.get(next.jobKey).receipt.status, 'CANDIDATE_READY');
});

function noCandidateReceipt(job) {
  const value = receipt(job);
  value.status = 'NO_CANDIDATE'; value.factory.status = 'no-change';
  value.factory.reason = 'NoCandidateChange'; delete value.factory.reviewer;
  const empty = createHash('sha256').update('').digest('hex');
  const body = { baseHead: job.intent.draft.headRevision, statusBytes: 0, statusSha256: empty,
    patchBytes: 0, patchSha256: empty, files: [] };
  value.factory.changeSet = { ...body, identity: createHash('sha256').update(`${JSON.stringify(body)}\n`).digest('hex') };
  return value;
}

test('NO_CANDIDATE admits only measured empty receipts and never weakens candidate review', t => {
  const { open } = setup(t); const store = open(); configure(store);
  const job = request(); store.start(job); const valid = noCandidateReceipt(job);
  const mutations = [
    value => { value.factory.reason = 'AlreadyImplemented'; },
    value => { value.factory.base.head = 'b'.repeat(40); },
    value => { value.factory.changeSet.statusBytes = 1; },
    value => { value.factory.changeSet.patchBytes = 1; },
    value => { value.factory.changeSet.patchSha256 = '9'.repeat(64); },
    value => { value.factory.changeSet.files = receipt(job).factory.changeSet.files; },
    value => { value.factory.reviewer = receipt(job).factory.reviewer; },
    value => { value.factory.worker = {}; },
    value => { value.status = 'CANDIDATE_READY'; value.factory.status = 'completed'; },
    value => { value.idempotencyKey = 'f'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(valid); mutate(bad);
    fails(() => store.finish({ jobKey: job.jobKey, receipt: bad }), 'InvalidReceipt');
    assert.equal(store.status().activeJobKey, job.jobKey);
  }
  store.finish({ jobKey: job.jobKey, receipt: valid });
  assert.equal(store.status().activeJobKey, null);
  assert.equal(store.status().usedRuns, 1);
  assert.equal(emitCandidateSidecar({ result: valid, store }), null);
  assert.deepEqual(recoverCompletedCandidateSidecars({ store }), []);
  assert.deepEqual(open().get(job.jobKey).receipt, valid);
});

test('standing policy persists and cannot be reset, including after revocation', t => {
  const { open } = setup(t); const a = open();
  assert.equal(a.status().enabled, false);
  fails(() => a.start(request()), 'PolicyDisabled');
  configure(a); const b = open();
  assert.deepEqual(b.status(), { configured: true, enabled: true, repository: 'GuitarAlchemist/gaia', maxRuns: 2, usedRuns: 0, activeJobKey: null, jobs: [] });
  fails(() => configure(b), 'PolicyExists');
  b.revoke(); assert.equal(a.status().enabled, false);
  fails(() => a.start(request()), 'PolicyDisabled');
  fails(() => configure(a), 'PolicyExists');
});

test('case-only restart and legacy-schema redelivery retain one durable GitHub authority', t => {
  const { path, open } = setup(t);
  const capturedIntent = intent();
  const legacyJobKey = digest({ repository: capturedIntent.repository, itemId: capturedIntent.itemId,
    draftNumber: capturedIntent.draft.number });
  const legacy = { jobKey: legacyJobKey, intent: capturedIntent,
    idempotencyKey: digest({ grantId: legacyJobKey, intentRevision: capturedIntent.intentRevision }) };
  const development = new DatabaseSync(path);
  development.exec(`CREATE TABLE autonomous_policy (
    id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1),
    repository TEXT NOT NULL, max_runs INTEGER NOT NULL CHECK(max_runs BETWEEN 1 AND 1000),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;
    CREATE TABLE autonomous_jobs (
    job_key TEXT PRIMARY KEY, repository TEXT NOT NULL, item_id TEXT NOT NULL,
    draft_number INTEGER NOT NULL, intent_json TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('STARTED','COMPLETED')), receipt_json TEXT,
    UNIQUE(repository,item_id,draft_number),
    CHECK((state='STARTED' AND receipt_json IS NULL) OR (state='COMPLETED' AND receipt_json IS NOT NULL))) STRICT;`);
  development.prepare('INSERT INTO autonomous_policy VALUES (1,1,?,?,1)')
    .run('GUITARALCHEMIST/GAIA', 2);
  development.prepare("INSERT INTO autonomous_jobs VALUES (?,?,?,?,?,?,'STARTED',NULL)").run(
    legacy.jobKey, capturedIntent.repository, capturedIntent.itemId, capturedIntent.draft.number,
    JSON.stringify(capturedIntent), legacy.idempotencyKey);
  development.close();

  const first = open();
  const redelivered = request(intent(145, { repository: 'guitaralchemist/GAIA' }));
  assert.equal(redelivered.jobKey, autonomousJobKey(capturedIntent),
    'new job identity folds GitHub repository casing');
  assert.deepEqual(first.get(redelivered.jobKey), { ...legacy, state: 'STARTED', receipt: null },
    'the new key aliases captured development evidence without rewriting it');
  fails(() => first.start(redelivered), 'JobExists');
  const capturedReceipt = receipt(legacy);
  first.finish({ jobKey: redelivered.jobKey, receipt: capturedReceipt });
  assert.equal(first.get(redelivered.jobKey).jobKey, legacy.jobKey,
    'completion through the folded alias retains the captured evidence identity');
  const external = new DatabaseSync(path);
  assert.throws(() => external.prepare(
    "INSERT INTO autonomous_jobs VALUES (?,?,?,?,?,?,'STARTED',NULL)",
  ).run('9'.repeat(64), 'guitaralchemist/gaia', capturedIntent.itemId,
    capturedIntent.draft.number, JSON.stringify(redelivered.intent), '8'.repeat(64)),
  /UNIQUE constraint failed/iu, 'SQLite enforces provider identity independently of application keys');
  external.close();
  first.close();

  const restarted = open();
  assert.equal(restarted.status().repository, 'GUITARALCHEMIST/GAIA', 'policy spelling is preserved');
  assert.deepEqual(restarted.get(redelivered.jobKey),
    { ...legacy, state: 'COMPLETED', receipt: capturedReceipt });
  fails(() => restarted.start(redelivered), 'JobExists');
});

test('two connections serialize duplicate and other-job admission; budget survives completion and restart', t => {
  const { open } = setup(t); const a = open(); const b = open(); configure(a);
  const first = request();
  assert.deepEqual(a.start(first), { status: 'AUTHORIZED', grantId: first.jobKey, intentRevision: first.intent.intentRevision });
  fails(() => b.start(first), 'JobExists');
  fails(() => b.start(request(intent(146))), 'HostBusy');
  assert.deepEqual(b.get(first.jobKey), { ...first, state: 'STARTED', receipt: null });
  const terminal = receipt(first); b.finish({ jobKey: first.jobKey, receipt: terminal });
  a.finish({ jobKey: first.jobKey, receipt: terminal });
  fails(() => a.finish({ jobKey: first.jobKey, receipt: receipt(first, 'CANDIDATE_REJECTED') }), 'ReceiptConflict');
  const second = request(intent(146)); b.start(second); b.finish({ jobKey: second.jobKey, receipt: receipt(second) });
  const restarted = open(); assert.equal(restarted.status().usedRuns, 2);
  fails(() => restarted.start(request(intent(147))), 'BudgetExhausted');
  assert.deepEqual(restarted.get(first.jobKey).receipt, terminal);
});

test('revocation after STARTED prevents subsequent admission but permits bound completion', t => {
  const { open } = setup(t); const a = open(); configure(a); const b = open(); const job = request();
  a.start(job); b.revoke(); b.finish({ jobKey: job.jobKey, receipt: receipt(job) });
  assert.equal(a.get(job.jobKey).state, 'COMPLETED');
  fails(() => a.start(request(intent(146))), 'PolicyDisabled');
});

test('unrepaired and repaired producer forms fail closed, including persisted replay corruption', t => {
  const { path, open } = setup(t); const store = open();
  store.configure({ repository: 'GuitarAlchemist/gaia', maxRuns: 3 });
  const direct = request(); store.start(direct);
  for (const mutation of [
    value => { value.factory.base.head = 'c'.repeat(40); },
    value => { value.factory.reviewer.verdict = 'REQUEST_CHANGES'; },
    value => { delete value.factory.base; },
    value => { delete value.factory.worker; },
    value => { delete value.factory.changeSet; },
    value => { delete value.factory.reviewer.evidence; },
    value => { value.factory.changeSet.identity = '0'.repeat(64); },
    value => { value.factory.repair = receipt(direct, 'CANDIDATE_READY', { repaired: true }).factory.repair; },
  ]) {
    const bad = receipt(direct); mutation(bad);
    fails(() => store.finish({ jobKey: direct.jobKey, receipt: bad }), 'InvalidReceipt');
    assert.equal(store.get(direct.jobKey).state, 'STARTED');
  }
  store.finish({ jobKey: direct.jobKey, receipt: receipt(direct) });

  const repaired = request(intent(146)); store.start(repaired);
  for (const mutation of [
    value => { delete value.factory.repair; },
    value => { delete value.factory.reviews; },
    value => { value.factory.repair.authority = 'sandbox-requested-read-only'; },
    value => { value.factory.repair.evidence.role = 'worker'; },
    value => { value.factory.repair.initialCandidateIdentity = value.factory.repair.repairedCandidateIdentity; },
    value => { value.factory.repair.repairedCandidateIdentity = '0'.repeat(64); },
    value => { value.factory.reviews.initial.verdict = 'APPROVE'; },
    value => { value.factory.reviews.initial.evidence.role = 'reviewer-final'; },
    value => { value.factory.reviews.final.evidence.role = 'reviewer'; },
    value => { value.factory.reviewer = value.factory.reviews.initial; },
    value => { value.factory.reviewer = { ...value.factory.reviewer,
      provider: 'different-final-review' }; },
    value => { value.factory.reviews.final.verdict = 'APPROVE'; },
  ]) {
    const bad = receipt(repaired, 'CANDIDATE_REJECTED'); mutation(bad);
    fails(() => store.finish({ jobKey: repaired.jobKey, receipt: bad }), 'InvalidReceipt');
    assert.equal(store.get(repaired.jobKey).state, 'STARTED');
  }
  const terminal = receipt(repaired, 'CANDIDATE_REJECTED');
  store.finish({ jobKey: repaired.jobKey, receipt: terminal });
  assert.deepEqual(store.get(repaired.jobKey).receipt, terminal);
  const repairedApproval = request(intent(147));
  store.start(repairedApproval);
  const approved = receipt(repairedApproval, 'CANDIDATE_READY', { repaired: true });
  store.finish({ jobKey: repairedApproval.jobKey, receipt: approved });
  assert.deepEqual(store.get(repairedApproval.jobKey).receipt, approved,
    'a final approval, not the initial request for changes, controls repaired terminal status');

  const bad = receipt(repaired, 'CANDIDATE_REJECTED');
  bad.factory.reviews.initial.verdict = 'APPROVE';
  const external = new DatabaseSync(path);
  external.prepare('UPDATE autonomous_jobs SET receipt_json=? WHERE job_key=?')
    .run(JSON.stringify(bad), repaired.jobKey);
  external.close();
  fails(() => store.get(repaired.jobKey), 'StoreCorrupt');
  fails(() => open(), 'StoreCorrupt');
});

test('restart with unresolved STARTED retains host slot and original intent even if source changes', t => {
  const { open } = setup(t); const a = open(); configure(a); const job = request(); a.start(job); a.close();
  const b = open(); fails(() => b.start(request(intent(146))), 'HostBusy');
  const moved = request(intent(145, { snapshotRevision: 'c'.repeat(64) }));
  assert.equal(moved.jobKey, job.jobKey); fails(() => b.start(moved), 'JobExists');
  assert.deepEqual(b.get(job.jobKey).intent, job.intent);
});

test('invalid policy, intent, identity and nonterminal or unbound receipts fail closed', t => {
  const { open } = setup(t); const store = open();
  for (const maxRuns of [0, 1001, 1.5]) fails(() => store.configure({ repository: 'GuitarAlchemist/gaia', maxRuns }), 'InvalidPolicy');
  fails(() => store.configure({ repository: '../gaia', maxRuns: 2 }), 'InvalidPolicy');
  configure(store);
  for (const value of [intent(145, { action: 'MERGE' }), intent(145, { itemKind: 'PULL_REQUEST' }), intent(0), intent(145, { requiredAuthority: 'OTHER' })]) {
    fails(() => store.start({ jobKey: 'a'.repeat(64), intent: value, idempotencyKey: 'b'.repeat(64) }), 'InvalidIntent');
  }
  fails(() => store.start(request(intent(145, { repository: 'Other/repo' }))), 'RepositoryMismatch');
  const job = request();
  fails(() => store.start({ ...job, jobKey: 'a'.repeat(64) }), 'InvalidJob');
  fails(() => store.start({ ...job, idempotencyKey: 'b'.repeat(64) }), 'InvalidJob');
  fails(() => store.start({ ...job, intent: { ...job.intent, task: 'changed' } }), 'InvalidIntent');
  assert.equal(store.status().usedRuns, 0); store.start(job);
  for (const bad of [{ ...receipt(job), jobKey: 'a'.repeat(64) }, { ...receipt(job), status: 'EXECUTION_FAILED' }, { ...receipt(job), factory: { ...receipt(job).factory, task: 'foreign' } }]) {
    fails(() => store.finish({ jobKey: job.jobKey, receipt: bad }), 'InvalidReceipt');
  }
  assert.equal(store.get(job.jobKey).state, 'STARTED');
});

test('database corruption and stored identity mismatches block all subsequent admissions', t => {
  const { path, open } = setup(t); const store = open(); configure(store); const job = request(); store.start(job);
  const external = new DatabaseSync(path);
  external.prepare('UPDATE autonomous_jobs SET intent_json = ? WHERE job_key = ?').run(JSON.stringify({ ...job.intent, task: 'tampered' }), job.jobKey);
  external.close();
  fails(() => store.get(job.jobKey), 'StoreCorrupt');
  fails(() => store.start(request(intent(146))), 'StoreCorrupt');
  fails(() => open(), 'StoreCorrupt');
});

test('barrier-released independent SQLite workers admit exactly one duplicate or competing job', async t => {
  for (const duplicate of [true, false]) {
    const { open, path } = setup(t); const owner = open(); configure(owner);
    const barrier = new SharedArrayBuffer(4);
    const launch = job => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { openAutonomousFactoryStore } = await import(workerData.module);
          const store = openAutonomousFactoryStore({path: workerData.path});
          parentPort.postMessage('ready');
          Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
          try { store.start(workerData.job); parentPort.postMessage('AUTHORIZED'); }
          catch(error) { parentPort.postMessage(error.code); }
          finally { store.close(); }
        })().catch(error => { throw error; });
      `, { eval: true, workerData: { module: new URL('../src/autonomous-factory-store.mjs', import.meta.url).href, path, barrier, job } });
      const ready = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', resolve); });
      const result = new Promise((resolve, reject) => { worker.on('error', reject); worker.on('message', value => { if (value !== 'ready') resolve(value); }); });
      t.after(() => worker.terminate());
      return { ready, result };
    };
    const workers = [launch(request()), launch(request(intent(duplicate ? 145 : 146)))];
    assert.deepEqual(await Promise.all(workers.map(worker => worker.ready)), ['ready', 'ready']);
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    assert.deepEqual((await Promise.all(workers.map(worker => worker.result))).sort(), ['AUTHORIZED', duplicate ? 'JobExists' : 'HostBusy'].sort());
    assert.equal(owner.status().usedRuns, 1);
    assert.equal(owner.status().jobs[0].state, 'STARTED');
  }
});

test('returned job objects cannot mutate the durable authority or receipt', t => {
  const { open } = setup(t); const store = open(); configure(store); const job = request(); store.start(job);
  const shown = store.status(); shown.jobs[0].intent.task = 'changed'; shown.enabled = false;
  assert.deepEqual(store.get(job.jobKey).intent, job.intent);
  const terminal = receipt(job); store.finish({ jobKey: job.jobKey, receipt: terminal }); terminal.factory.task = 'changed';
  assert.equal(store.get(job.jobKey).receipt.factory.task, job.intent.task);
});

test('only existing real local parents and file databases are admitted', t => {
  const { dir } = setup(t);
  fails(() => openAutonomousFactoryStore({ path: ':memory:' }), 'InvalidPath');
  fails(() => openAutonomousFactoryStore({ path: join(dir, 'missing', 'a.sqlite') }), 'InvalidPath');
  fails(() => openAutonomousFactoryStore({ path: '//server/share/a.sqlite' }), 'InvalidPath');
  writeFileSync(join(dir, 'bad.sqlite'), 'corrupt');
  fails(() => openAutonomousFactoryStore({ path: join(dir, 'bad.sqlite') }), 'StoreCorrupt');
  const unknown = new DatabaseSync(join(dir, 'unknown.sqlite')); unknown.close();
  fails(() => openAutonomousFactoryStore({ path: join(dir, 'unknown.sqlite') }), 'StoreCorrupt');
  const alias = join(dir, 'alias');
  symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fails(() => openAutonomousFactoryStore({ path: join(alias, 'a.sqlite') }), 'InvalidPath');
});
