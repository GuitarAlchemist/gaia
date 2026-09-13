import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openAutonomousFactoryStore } from '../src/autonomous-factory-store.mjs';
import { runAutonomousTick } from '../scripts/github-portfolio-autonomous.mjs';
import { runAutonomousFactory, reconcileAutonomousJob } from '../src/autonomous-factory.mjs';

function fixture() {
  const snapshot = { schema: 'gaia-github-read-snapshot/1', organization: 'Example',
    scope: 'all-repositories-visible-to-adapter', complete: true, repositories: [{
      id: 'repo', nameWithOwner: 'Example/app', archived: false, defaultBranchOid: 'a'.repeat(40),
      issues: [{ id: 'issue-1', number: 1, title: 'Fix behavior',
        updatedAt: '2026-09-12T12:00:00.000Z', labels: ['ready-for-agent'], dependencies: [], duplicateOf: null }],
      pullRequests: [],
    }] };
  let enabled = true;
  let launches = 0;
  let reads = 0;
  const jobs = new Map();
  let persisted = null;
  const store = {
    get: key => structuredClone(jobs.get(key) ?? null),
    start: ({ jobKey, intent, idempotencyKey }) => {
      if (!enabled) throw Object.assign(new Error('disabled'), { code: 'PolicyRevoked' });
      if (jobs.has(jobKey)) throw Object.assign(new Error('exists'), { code: 'JobExists' });
      jobs.set(jobKey, { jobKey, intent, idempotencyKey, state: 'STARTED', receipt: null });
      return { status: 'AUTHORIZED', grantId: jobKey, intentRevision: intent.intentRevision };
    },
    finish: ({ jobKey, receipt }) => { Object.assign(jobs.get(jobKey), { state: 'COMPLETED', receipt }); },
  };
  const args = { repository: 'Example/app', policyRevision: 'test-policy', store,
    githubRead: { read: async () => { reads++; return structuredClone(snapshot); } },
    draftAdmission: { target: async () => ({ repository: 'Example/app', itemKind: 'ISSUE', itemNumber: 1 }),
      read: async () => ({ number: 2, state: 'OPEN', isDraft: true, headRef: 'codex/fix', headRevision: 'b'.repeat(40) }) },
    execution: { execute: async ({ intent }) => {
      launches++;
      persisted = { schema: 'gaia-agent-factory-receipt/1', status: 'completed', task: intent.task,
        base: { head: 'b'.repeat(40) }, reviewer: { verdict: 'APPROVE' } };
      return persisted;
    }, findReceipt: async () => persisted },
  };
  return { args, jobs, snapshot, revoke: () => { enabled = false; },
    counts: () => ({ launches, reads }), persist: value => { persisted = value; } };
}

test('fresh admitted work runs without any human reader and replays byte-identically', async () => {
  const f = fixture();
  const result = await runAutonomousFactory(f.args);
  assert.equal(result.status, 'CANDIDATE_READY');
  assert.equal(f.counts().launches, 1);
  f.snapshot.repositories[0].issues[0].updatedAt = '2026-09-12T13:00:00.000Z';
  assert.equal(JSON.stringify(await runAutonomousFactory(f.args)), JSON.stringify(result));
  assert.equal(f.counts().launches, 1);
});

test('revocation during fresh admission refuses before provider launch', async () => {
  const f = fixture();
  const read = f.args.draftAdmission.read;
  let n = 0;
  f.args.draftAdmission.read = async () => { if (++n === 2) f.revoke(); return read(); };
  assert.equal((await runAutonomousFactory(f.args)).code, 'PolicyRevoked');
  assert.equal(f.counts().launches, 0);
});

test('changed admitted Draft between preview and consume refuses before starting', async () => {
  const f = fixture();
  const read = f.args.draftAdmission.read;
  let n = 0;
  f.args.draftAdmission.read = async () => ({ ...await read(), headRevision: (++n === 1 ? 'b' : 'c').repeat(40) });
  assert.equal((await runAutonomousFactory(f.args)).code, 'IntentChanged');
  assert.equal(f.counts().launches, 0);
});

test('concurrent duplicate calls have one provider winner', async () => {
  const f = fixture();
  const results = await Promise.all([runAutonomousFactory(f.args), runAutonomousFactory(f.args)]);
  assert.equal(results.filter(r => r.status === 'CANDIDATE_READY').length, 1);
  assert.equal(f.counts().launches, 1);
});

test('lost provider response reconciles its durable receipt without another launch', async () => {
  const f = fixture();
  const execute = f.args.execution.execute;
  f.args.execution.execute = async request => { await execute(request); throw new Error('lost response'); };
  const first = await runAutonomousFactory(f.args);
  assert.equal(first.status, 'RECONCILIATION_REQUIRED');
  const result = await reconcileAutonomousJob({ store: f.args.store, execution: f.args.execution, jobKey: first.jobKey });
  assert.equal(result.status, 'CANDIDATE_READY');
  assert.equal(f.counts().launches, 1);
});

test('crash without receipt and corrupt or foreign receipt never permits a retry', async () => {
  const f = fixture();
  f.args.execution.execute = async () => { throw new Error('uncertain'); };
  const first = await runAutonomousFactory(f.args);
  for (const value of [null, { schema: 'wrong' }, { schema: 'gaia-agent-factory-receipt/1', status: 'completed', task: 'foreign' }]) {
    f.persist(value);
    assert.equal((await reconcileAutonomousJob({ store: f.args.store, execution: f.args.execution, jobKey: first.jobKey })).status,
      'RECONCILIATION_REQUIRED');
    assert.equal(f.jobs.get(first.jobKey).state, 'STARTED');
  }
});

test('not-ready and missing admission cannot acquire authority', async () => {
  const f = fixture();
  f.snapshot.repositories[0].issues[0].labels = ['ready-for-human'];
  assert.equal((await runAutonomousFactory(f.args)).status, 'REFUSED');
  assert.equal(f.jobs.size, 0);
  assert.equal((await runAutonomousFactory({ ...f.args, draftAdmission: undefined })).code, 'DraftAdmissionRequired');
});

test('production SQLite and actual tick compose to one candidate with byte-identical replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-auto-app-'));
  const store = openAutonomousFactoryStore({ path: join(root, 'policy.sqlite') });
  try {
    store.configure({ repository: 'Example/app', maxRuns: 3 });
    const f = fixture(); f.args.store = store;
    const args = { store, execution: f.args.execution, githubRead: f.args.githubRead,
      collect: () => ({ entries: [{ runId: 1, expectation: { workItem: { number: 1 }, number: 2 } }], refusals: [] }),
      admission: () => f.args.draftAdmission };
    const first = await runAutonomousTick(args);
    assert.equal(first.status, 'CANDIDATE_READY');
    assert.equal((await runAutonomousTick(args)).status, 'NO_NEW_CANDIDATE');
    assert.equal(JSON.stringify(await runAutonomousFactory(f.args)), JSON.stringify(first));
    assert.equal(f.counts().launches, 1);
    assert.equal(store.status().usedRuns, 1);
    store.revoke();
    assert.equal((await runAutonomousTick({ ...args, collect: () => assert.fail('must not poll after revoke') })).code, 'PolicyDisabled');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('shipped CLI provisions once and revokes with closed non-TTY stdin', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-auto-cli-'));
  const cli = fileURLToPath(new URL('../scripts/github-portfolio-autonomous.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args, '--state', root], { encoding: 'utf8', windowsHide: true, input: '' });
  try {
    const enabled = run(['enable', '--repository', 'Example/app', '--max-runs', '2']);
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(JSON.parse(enabled.stdout).enabled, true);
    assert.equal(run(['enable', '--repository', 'Example/app']).status, 1);
    assert.equal(JSON.parse(run(['revoke']).stdout).enabled, false);
    assert.equal(JSON.parse(run(['status']).stdout).enabled, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI rejects state inside a clone even when its child name starts with two dots', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-auto-containment-'));
  const cli = fileURLToPath(new URL('../scripts/github-portfolio-autonomous.mjs', import.meta.url));
  try {
    for (const child of ['state', '..state']) {
      const state = join(root, child); mkdirSync(state);
      const enabled = spawnSync(process.execPath, [cli, 'enable', '--state', state, '--repository', 'Example/app'], { encoding: 'utf8' });
      assert.equal(enabled.status, 0, enabled.stderr);
      // Invalid timeout prevents network access even in the broken containment implementation.
      const tick = spawnSync(process.execPath, [cli, 'tick', '--state', state, '--clone', root, '--timeout-ms', '0'], { encoding: 'utf8' });
      assert.equal(tick.status, 1);
      assert.equal(tick.stderr.trim(), 'StateInsideClone');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
