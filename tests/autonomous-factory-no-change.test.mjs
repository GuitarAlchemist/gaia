import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openAutonomousFactoryStore } from '../src/autonomous-factory-store.mjs';
import { createAgentFactoryExecutionAdapter } from '../src/github-portfolio-execution.mjs';
import { runAutonomousTick } from '../scripts/github-portfolio-autonomous.mjs';
import { executeAgentFactory } from '../src/factory-agent.mjs';

for (const loseResponse of [false, true]) test(`a measured no-change worker terminates without approval or rerun (lost response: ${loseResponse})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-no-change-'));
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  let store;
  try {
    const repo = join(root, 'repo');
    const worktree = join(root, 'candidate');
    const evidenceRoot = join(root, 'evidence');
    mkdirSync(repo); mkdirSync(evidenceRoot);
    git(repo, 'init', '--initial-branch=main');
    git(repo, 'config', 'user.name', 'Gaia Test');
    git(repo, 'config', 'user.email', 'gaia@example.invalid');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/Example/app.git');
    writeFileSync(join(repo, 'candidate.txt'), 'already implemented\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
    git(repo, 'worktree', 'add', '--detach', worktree, 'HEAD');
    const head = git(worktree, 'rev-parse', 'HEAD');
    const dbPath = join(root, 'authority.sqlite');
    store = openAutonomousFactoryStore({ path: dbPath });
    store.configure({ repository: 'Example/app', maxRuns: 3 });
    let workers = 0;
    const observed = {};
    const execution = createAgentFactoryExecutionAdapter({
      expectedRepository: 'Example/app', worktree, evidenceRoot,
      executeFactory: async options => {
        try {
          const receipt = await executeAgentFactory(options);
          observed.factoryStatus = receipt.status;
          return receipt;
        } catch (error) { observed.error = error.code; throw error; }
      },
      runWorker: async () => { workers++; return { provider: 'fixture-worker', output: 'Already implemented' }; },
      runReviewer: async () => assert.fail('no candidate is not a reviewable change'),
      runRepair: async () => assert.fail('no repair or retry for a no-change result'),
    });
    const args = {
      store, execution: { ...execution, execute: async request => {
        const receipt = await execution.execute(request);
        if (loseResponse) throw new Error('lost response after durable receipt');
        return receipt;
      } },
      collect: () => ({ entries: [{ runId: 1, expectation: { workItem: { number: 108 }, number: 156 } }], refusals: [] }),
      admission: () => ({
        target: async () => ({ repository: 'Example/app', itemKind: 'ISSUE', itemNumber: 108 }),
        read: async () => ({ number: 156, state: 'OPEN', isDraft: true, headRef: 'codex/fixture', headRevision: head }),
      }),
      githubRead: { read: async () => ({ schema: 'gaia-github-read-snapshot/1', organization: 'Example',
        scope: 'all-repositories-visible-to-adapter', complete: true, repositories: [{
          id: 'repo', nameWithOwner: 'Example/app', archived: false, defaultBranchOid: head,
          issues: [{ id: 'issue-108', number: 108, title: 'Implement the existing gate',
            updatedAt: '2026-09-25T12:00:00.000Z', labels: ['ready-for-agent'], dependencies: [], duplicateOf: null }],
          pullRequests: [],
        }] }) },
    };
    let result = await runAutonomousTick(args);
    if (loseResponse) {
      assert.equal(result.status, 'RECONCILIATION_REQUIRED');
      assert.notEqual(store.status().activeJobKey, null);
      result = await runAutonomousTick(args);
    }
    assert.equal(result.status, 'NO_CANDIDATE', JSON.stringify(observed));
    assert.equal(store.status().activeJobKey, null, 'the sole slot must not remain STARTED');
    assert.equal(store.status().usedRuns, 1, 'the run budget is not refunded');
    const job = store.status().jobs[0];
    assert.deepEqual(await execution.findReceipt({ intent: job.intent, idempotencyKey: job.idempotencyKey }), result.factory);
    store.close(); store = openAutonomousFactoryStore({ path: dbPath });
    assert.deepEqual(store.status().jobs[0].receipt, result, 'durable restart preserves the terminal truth');
    assert.equal((await runAutonomousTick({ ...args, store })).status, 'NO_NEW_CANDIDATE');
    assert.equal(workers, 1);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
