import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runFactoryAgentCli } from '../scripts/factory-agent.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'factory-agent.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'gaia-factory-agent-cli-'));

test.after(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('requires the bounded worktree, task, and receipt arguments', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing --worktree/i);
});

test('the public CLI composition wires one bounded repair with the same timeout', async () => {
  const worktree = join(scratch, 'repair-composition-worktree');
  const out = join(scratch, 'repair-composition-receipt.json');
  mkdirSync(worktree);
  const seen = { worker: [], reviewer: [], repair: [] };
  let reviewRound = 0;

  const receipt = await runFactoryAgentCli([
    '--worktree', worktree,
    '--task', 'repair after review',
    '--out', out,
    '--timeout-ms', '4321',
  ], {
    executeFactory: async ({ runWorker, runReviewer, runRepair }) => {
      await runWorker({ role: 'worker' });
      const initial = await runReviewer({ role: 'initial-review' });
      assert.equal(initial.verdict, 'REQUEST_CHANGES');
      await runRepair({ role: 'repair' });
      const final = await runReviewer({ role: 'final-review' });
      assert.equal(final.verdict, 'APPROVE');
      return {
        schema: 'gaia-agent-factory-receipt/1',
        status: 'completed',
        task: 'repair after review',
      };
    },
    runWorker: async (context, options) => {
      seen.worker.push({ context, options });
      return { provider: 'fixture-worker', output: 'worker' };
    },
    runReviewer: async (context, options) => {
      reviewRound += 1;
      seen.reviewer.push({ context, options });
      return {
        provider: `fixture-reviewer-${reviewRound}`,
        verdict: reviewRound === 1 ? 'REQUEST_CHANGES' : 'APPROVE',
        output: `review-${reviewRound}`,
      };
    },
    runRepair: async (context, options) => {
      seen.repair.push({ context, options });
      return { provider: 'fixture-repair', output: 'repair' };
    },
  });

  assert.equal(receipt.status, 'completed');
  assert.equal(seen.worker.length, 1);
  assert.equal(seen.reviewer.length, 2);
  assert.equal(seen.repair.length, 1);
  for (const call of [...seen.worker, ...seen.reviewer, ...seen.repair]) {
    assert.deepEqual(call.options, { timeoutMs: 4321 });
  }
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).status, 'completed');
});

test('refuses a receipt path inside the candidate before launching an agent', () => {
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--worktree', ROOT,
    '--task', 'must not run',
    '--out', join(ROOT, 'forbidden-agent-receipt.json'),
  ], { cwd: scratch, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the candidate worktree/i);
});

test('refuses a receipt path physically inside the candidate through a junction', () => {
  const repo = join(scratch, 'junction-repo');
  const worktree = join(scratch, 'junction-worktree');
  const alias = join(scratch, 'junction-alias');
  git(scratch, 'init', repo);
  git(repo, 'config', 'user.name', 'Gaia Test');
  git(repo, 'config', 'user.email', 'gaia@example.invalid');
  writeFileSync(join(repo, 'candidate.txt'), 'before\n', 'utf8');
  git(repo, 'add', 'candidate.txt');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', 'gaia-junction', worktree, 'HEAD');
  symlinkSync(worktree, alias, 'junction');

  const physicalReceipt = join(worktree, 'receipt.json');
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--worktree', worktree,
    '--task', 'must not run',
    '--out', join(alias, 'receipt.json'),
  ], { cwd: scratch, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /physically outside the candidate worktree/i);
  assert.equal(existsSync(physicalReceipt), false);
});
