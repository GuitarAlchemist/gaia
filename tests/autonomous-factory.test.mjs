import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openAutonomousFactoryStore } from '../src/autonomous-factory-store.mjs';
import { runAutonomousHostTick, runAutonomousTick } from '../scripts/github-portfolio-autonomous.mjs';
import { runAutonomousFactory, reconcileAutonomousJob } from '../src/autonomous-factory.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
function factoryReceipt(intent, status = 'completed') {
  const files = [{ path: 'candidate.txt', state: 'present', bytes: 9, sha256: 'c'.repeat(64) }];
  const body = { baseHead: intent.draft.headRevision, statusBytes: 1, statusSha256: 'd'.repeat(64),
    patchBytes: 2, patchSha256: 'e'.repeat(64), files };
  const evidence = role => ({ role, path: `/evidence/${role}.txt`, bytes: 3,
    sha256: 'f'.repeat(64), mediaType: 'text/plain; charset=utf-8',
    policy: 'local-sensitive-content-addressed' });
  const identity = sha256(`${JSON.stringify(body)}\n`);
  return { schema: 'gaia-agent-factory-receipt/1', status, task: intent.task,
    base: { head: intent.draft.headRevision, isolation: 'caller-supplied-linked-git-worktree',
      executionBoundary: 'host-user-process' },
    worker: { provider: 'fixture-worker', evidence: evidence('worker'), authority: 'host-user-process',
      requestedScope: 'linked-worktree-only', observedScope: 'git-candidate-and-worktree-tree' },
    changeSet: { ...body, identity },
    reviewer: { provider: 'fixture-reviewer', evidence: evidence('reviewer'),
      authority: 'sandbox-requested-read-only',
      verifiedPostcondition: 'git-head-index-and-worktree-tree-unchanged',
      verdict: status === 'completed' ? 'APPROVE' : 'REQUEST_CHANGES' },
    verification: { schema: 'gaia-factory-verification/1', authority: 'host-user-process',
      command: 'node --test --test-reporter=spec', runtime: { version: 'v26.8.1', pinned: '26.8.1' },
      candidateIdentity: identity, termination: 'exit', exitCode: 0,
      counts: { tests: 1, pass: 1, fail: 0 }, passed: true, evidence: evidence('verification') } };
}

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
      persisted = factoryReceipt(intent);
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

test('policy, snapshot, target, and intent casing share one GitHub repository identity', async () => {
  const f = fixture();
  f.args.repository = 'example/app';
  f.args.draftAdmission.target = async () => (
    { repository: 'EXAMPLE/APP', itemKind: 'ISSUE', itemNumber: 1 }
  );
  const result = await runAutonomousFactory(f.args);
  assert.equal(result.status, 'CANDIDATE_READY');
  assert.equal(f.counts().launches, 1);
  assert.equal(f.jobs.size, 1);
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

test('host tick rebuilds a missing completed sidecar without relaunching its worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-auto-sidecar-replay-'));
  const evidenceRoot = join(root, 'evidence'); mkdirSync(evidenceRoot);
  const store = openAutonomousFactoryStore({ path: join(root, 'policy.sqlite') });
  try {
    store.configure({ repository: 'Example/app', maxRuns: 3 });
    const f = fixture(); f.args.store = store;
    const args = { store, execution: f.args.execution, githubRead: f.args.githubRead,
      collect: () => ({ entries: [{ runId: 1, expectation: { workItem: { number: 1 }, number: 2 } }], refusals: [] }),
      admission: () => f.args.draftAdmission };
    const first = await runAutonomousTick(args);
    const evidenceDir = join(evidenceRoot, first.idempotencyKey); mkdirSync(evidenceDir);
    writeFileSync(join(evidenceDir, 'receipt.json'), `${JSON.stringify(first.factory)}\n`);
    assert.equal(existsSync(join(evidenceDir, 'artifact-chain.json')), false);

    const replay = await runAutonomousHostTick({ store, evidenceRoot, tick: () => runAutonomousTick(args) });
    assert.equal(replay.status, 'NO_NEW_CANDIDATE');
    assert.deepEqual(replay.artifactChainRecovery.map(({ jobKey, status }) => ({ jobKey, status })),
      [{ jobKey: first.jobKey, status: 'WRITTEN' }]);
    assert.equal(existsSync(join(evidenceDir, 'artifact-chain.json')), true);
    assert.equal(f.counts().launches, 1);

    const unchanged = await runAutonomousHostTick({ store, evidenceRoot, tick: () => runAutonomousTick(args) });
    assert.equal(Object.hasOwn(unchanged, 'artifactChainRecovery'), false);
    assert.equal(f.counts().launches, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const gate of ['revoked policy', 'exhausted budget']) {
  test(`completed sidecar recovery precedes ${gate} refusal`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gaia-auto-sidecar-gate-'));
    const evidenceRoot = join(root, 'evidence'); mkdirSync(evidenceRoot);
    const store = openAutonomousFactoryStore({ path: join(root, 'policy.sqlite') });
    try {
      store.configure({ repository: 'Example/app', maxRuns: 1 });
      const f = fixture(); f.args.store = store;
      const args = { store, execution: f.args.execution, githubRead: f.args.githubRead,
        collect: () => ({ entries: [{ runId: 1, expectation: { workItem: { number: 1 }, number: 2 } }], refusals: [] }),
        admission: () => f.args.draftAdmission };
      const first = await runAutonomousTick(args);
      const evidenceDir = join(evidenceRoot, first.idempotencyKey); mkdirSync(evidenceDir);
      writeFileSync(join(evidenceDir, 'receipt.json'), `${JSON.stringify(first.factory)}\n`);
      if (gate === 'revoked policy') store.revoke();
      const replay = await runAutonomousHostTick({ store, evidenceRoot,
        tick: () => runAutonomousTick({ ...args, collect: () => assert.fail('gate must refuse before discovery') }) });
      assert.equal(replay.code, gate === 'revoked policy' ? 'PolicyDisabled' : 'BudgetExhausted');
      assert.equal(replay.artifactChainRecovery[0].status, 'WRITTEN');
      assert.equal(f.counts().launches, 1);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('a failed completed-sidecar replay does not block unrelated eligible work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-auto-sidecar-isolation-'));
  const evidenceRoot = join(root, 'evidence'); mkdirSync(evidenceRoot);
  const store = openAutonomousFactoryStore({ path: join(root, 'policy.sqlite') });
  try {
    store.configure({ repository: 'Example/app', maxRuns: 3 });
    const first = fixture(); first.args.store = store;
    const oldArgs = { store, execution: first.args.execution, githubRead: first.args.githubRead,
      collect: () => ({ entries: [{ runId: 1, expectation: { workItem: { number: 1 }, number: 2 } }], refusals: [] }),
      admission: () => first.args.draftAdmission };
    const old = await runAutonomousTick(oldArgs);

    const next = fixture(); next.args.store = store;
    next.snapshot.repositories[0].issues[0].id = 'issue-2';
    next.snapshot.repositories[0].issues[0].number = 2;
    next.args.draftAdmission.target = async () => ({ repository: 'Example/app', itemKind: 'ISSUE', itemNumber: 2 });
    next.args.draftAdmission.read = async () => ({ number: 3, state: 'OPEN', isDraft: true,
      headRef: 'codex/next', headRevision: 'b'.repeat(40) });
    const nextArgs = { store, execution: next.args.execution, githubRead: next.args.githubRead,
      collect: () => ({ entries: [{ runId: 2, expectation: { workItem: { number: 2 }, number: 3 } }], refusals: [] }),
      admission: () => next.args.draftAdmission };
    const result = await runAutonomousHostTick({ store, evidenceRoot, tick: () => runAutonomousTick(nextArgs) });
    assert.equal(result.status, 'CANDIDATE_READY');
    assert.equal(result.artifactChainRecovery[0].jobKey, old.jobKey);
    assert.equal(result.artifactChainRecovery[0].status, 'FAILED');
    assert.equal(next.counts().launches, 1);
    assert.equal(first.counts().launches, 1);

    const nextEvidence = join(evidenceRoot, result.idempotencyKey); mkdirSync(nextEvidence);
    writeFileSync(join(nextEvidence, 'receipt.json'), `${JSON.stringify(result.factory)}\n`);
    const projections = await runAutonomousHostTick({ store, evidenceRoot,
      tick: async () => ({ status: 'NO_INTAKE_RECEIPTS' }) });
    assert.deepEqual(projections.artifactChainRecovery.map(({ jobKey, status }) => ({ jobKey, status })), [
      { jobKey: old.jobKey, status: 'FAILED' },
      { jobKey: result.jobKey, status: 'WRITTEN' },
    ]);
    assert.equal(next.counts().launches, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('shipped CLI provisions once and revokes with closed non-TTY stdin', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-auto-cli-'));
  const cli = fileURLToPath(new URL('../scripts/github-portfolio-autonomous.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args, '--state', root], { encoding: 'utf8', windowsHide: true, input: '' });
  try {
    const enabled = run(['enable', '--repository', 'Owner/.github', '--max-runs', '2']);
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(JSON.parse(enabled.stdout).enabled, true);
    assert.equal(JSON.parse(enabled.stdout).repository, 'Owner/.github');
    assert.equal(run(['enable', '--repository', 'Owner/.github']).status, 1);
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
