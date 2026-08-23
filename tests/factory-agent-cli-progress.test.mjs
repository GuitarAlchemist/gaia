import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runFactoryAgentCli } from '../scripts/factory-agent.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-factory-progress-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
test.afterEach(() => {
  process.exitCode = 0;
});

function clock(stepMs = 7) {
  let value = 1_000;
  return () => {
    const observed = value;
    value += stepMs;
    return observed;
  };
}

function parseProgress(chunks) {
  return chunks.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function runScenario(name, {
  verdicts = ['APPROVE'],
  failAt = null,
  task = 'safe task',
  writeProgress,
} = {}) {
  const worktree = join(scratch, `${name}-worktree`);
  const out = join(scratch, `${name}-receipt.json`);
  mkdirSync(worktree);
  const stdout = [];
  const stderr = [];
  let review = 0;

  const dependencies = {
    nowMs: clock(),
    writeStdout: (chunk) => stdout.push(chunk),
    writeProgress: writeProgress ?? ((chunk) => stderr.push(chunk)),
    executeFactory: async ({ runWorker, runReviewer, runRepair }) => {
      await runWorker({ task, cwd: worktree });
      const initial = await runReviewer({ task, cwd: worktree });
      if (initial.verdict === 'REQUEST_CHANGES') {
        await runRepair({ task, findings: 'provider secret output', cwd: worktree });
        await runReviewer({ task, cwd: worktree });
      }
      return {
        schema: 'gaia-agent-factory-receipt/1',
        status: verdicts.at(-1) === 'APPROVE' ? 'completed' : 'rejected',
      };
    },
    runWorker: async () => {
      if (failAt === 'worker') throw new Error('provider leaked C:\\secret\\worker.txt');
      return { provider: 'fixture-worker', output: 'private worker output' };
    },
    runReviewer: async () => {
      if (failAt === 'reviewer') throw new Error('reviewer secret output');
      const verdict = verdicts[review];
      review += 1;
      return { provider: 'fixture-reviewer', verdict, output: 'provider secret output' };
    },
    runRepair: async () => {
      if (failAt === 'repair') throw new Error('repair secret output');
      return { provider: 'fixture-repair', output: 'private repair output' };
    },
  };

  const promise = runFactoryAgentCli([
    '--worktree', worktree,
    '--task', task,
    '--out', out,
    '--timeout-ms', '1000',
  ], dependencies);
  return { promise, out, stdout, stderr };
}

test('approve progress is ordered on stderr while stdout remains exactly the final JSON', async () => {
  const run = await runScenario('approve');
  await run.promise;

  const persisted = readFileSync(run.out, 'utf8');
  assert.equal(run.stdout.join(''), persisted);
  const progress = parseProgress(run.stderr);
  assert.deepEqual(progress.map(({ stage }) => stage), [
    'validating',
    'authorized_execution',
    'worker_running',
    'worker_completed',
    'initial_review_running',
    'initial_review_verdict',
    'terminal_outcome',
  ]);
  assert.equal(progress.at(-2).verdict, 'APPROVE');
  assert.equal(progress.at(-1).outcome, 'COMPLETED');
});

test('repair progress exposes the bounded repair and fresh final review in order', async () => {
  const run = await runScenario('repair', { verdicts: ['REQUEST_CHANGES', 'APPROVE'] });
  await run.promise;

  const progress = parseProgress(run.stderr);
  assert.deepEqual(progress.map(({ stage }) => stage), [
    'validating',
    'authorized_execution',
    'worker_running',
    'worker_completed',
    'initial_review_running',
    'initial_review_verdict',
    'repair_running',
    'repair_completed',
    'final_review_running',
    'final_review_verdict',
    'terminal_outcome',
  ]);
  assert.deepEqual(progress.filter(({ verdict }) => verdict).map(({ verdict }) => verdict), [
    'REQUEST_CHANGES', 'APPROVE',
  ]);
  assert.equal(progress.at(-1).outcome, 'COMPLETED');
});

test('rejection and provider failure each end with a truthful terminal outcome', async () => {
  const rejected = await runScenario('rejected', {
    verdicts: ['REQUEST_CHANGES', 'REQUEST_CHANGES'],
  });
  await rejected.promise;
  assert.equal(parseProgress(rejected.stderr).at(-1).outcome, 'REJECTED');

  const failed = await runScenario('failed', { failAt: 'worker' });
  await assert.rejects(failed.promise, /provider leaked/u);
  const progress = parseProgress(failed.stderr);
  assert.deepEqual(progress.map(({ stage }) => stage), [
    'validating', 'authorized_execution', 'worker_running', 'terminal_outcome',
  ]);
  assert.equal(progress.at(-1).outcome, 'FAILED');
  assert.equal(failed.stdout.join(''), '');
});

test('remaining provider-time bound is monotone, caller-derived, and never presented as ETA', async () => {
  const run = await runScenario('bound', { verdicts: ['REQUEST_CHANGES', 'APPROVE'] });
  await run.promise;
  const progress = parseProgress(run.stderr);
  assert.deepEqual(progress.map(({ remainingProviderTimeUpperBoundMs }) =>
    remainingProviderTimeUpperBoundMs), [4000, 4000, 4000, 3000, 3000, 2000, 2000, 1000, 1000, 0, 0]);
  assert.ok(progress.every(({ elapsedMs }, index) => index === 0
    || elapsedMs >= progress[index - 1].elapsedMs));
  assert.ok(!run.stderr.join('').match(/\beta\b|predict|estimate/iu));
});

test('progress is redacted and a failing progress writer cannot corrupt the result', async () => {
  const task = 'token=hunter2 C:\\private\\task.txt';
  const chunks = [];
  const visible = await runScenario('redacted', {
    task,
    verdicts: ['REQUEST_CHANGES', 'APPROVE'],
    writeProgress: (chunk) => chunks.push(chunk),
  });
  await visible.promise;
  const text = chunks.join('');
  for (const forbidden of [task, 'hunter2', 'private', 'provider secret output', visible.out]) {
    assert.ok(!text.includes(forbidden), `progress excludes ${forbidden}`);
  }

  let writes = 0;
  const broken = await runScenario('broken-writer', {
    writeProgress: () => {
      writes += 1;
      throw new Error('stderr unavailable');
    },
  });
  const receipt = await broken.promise;
  assert.equal(receipt.status, 'completed');
  assert.ok(writes > 0);
  assert.equal(broken.stdout.join(''), readFileSync(broken.out, 'utf8'));
});
