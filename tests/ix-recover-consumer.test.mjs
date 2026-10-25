import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IxRecoverError, runRecoverableStats } from '../src/ix-recover-consumer.mjs';

const SUMMARY = {
  path: 'ix.yaml',
  total_duration_ms: 0,
  cache_hits: 0,
  stages: { s: { duration_ms: 0, cache_hit: false, output: { mean: 2.5, count: 4 } } },
};

function store(runId, attemptId) {
  const runsDir = mkdtempSync(join(tmpdir(), 'gaia-ix-recover-'));
  if (attemptId) {
    mkdirSync(join(runsDir, runId));
    writeFileSync(join(runsDir, runId, 'receipt.json'), JSON.stringify({
      schema: 'ix-recover-receipt/0',
      run_id: runId,
      attempt_id: attemptId,
      bindings_sha256: 'sha256:00',
      manifest_sha256: 'sha256:11',
    }));
  }
  return runsDir;
}

function request(runsDir, overrides = {}) {
  return {
    executable: 'C:\\tools\\ix.exe',
    governanceDir: 'C:\\ix\\governance\\demerzel',
    specFile: join(runsDir, 'ix.yaml'),
    runId: 'gaia-stats-a',
    runsDir,
    params: { nums: [1, 2, 3, 4] },
    ...overrides,
  };
}

const ix = (status, stderr, stdout = '') => () => ({ status, stderr, stdout });

test('Gaia consumes a published stats run with its run and attempt identity', () => {
  const runsDir = store('gaia-stats-a', 'att-1a2b-42-0');
  let observed;
  const result = runRecoverableStats(request(runsDir), {
    env: { OPENAI_API_KEY: 'must-not-pass', IX_RECOVER_PAUSE: 'committed|m|60', PATH: 'p' },
    runInvocation: (invocation) => {
      observed = invocation;
      return {
        status: 0,
        stderr: 'run gaia-stats-a: published attempt att-1a2b-42-0\n',
        stdout: `${JSON.stringify(SUMMARY)}\n`,
      };
    },
  });

  assert.equal(observed.command, 'C:\\tools\\ix.exe');
  assert.deepEqual(observed.args, [
    '--format', 'json', 'pipeline', 'run', '--file', join(runsDir, 'ix.yaml'),
    '--run-id', 'gaia-stats-a', '--runs-dir', runsDir, '--param', 'nums=[1,2,3,4]',
  ]);
  assert.equal(observed.env.OPENAI_API_KEY, undefined);
  assert.equal(observed.env.IX_RECOVER_PAUSE, undefined);
  assert.equal(observed.env.IX_GOVERNANCE_DIR, 'C:\\ix\\governance\\demerzel');
  assert.equal(observed.env.PATH, 'p');
  assert.deepEqual(result, {
    runId: 'gaia-stats-a',
    attemptId: 'att-1a2b-42-0',
    outcome: 'published',
    summary: SUMMARY,
  });
});

test('Gaia takes a replay or a repaired receipt as the attempt already published', () => {
  const runsDir = store('gaia-stats-a', 'att-1a2b-42-0');
  const stdout = JSON.stringify(SUMMARY);
  const cases = [
    ['run gaia-stats-a: replayed attempt att-1a2b-42-0; nothing executed\n', 'replayed'],
    ['run gaia-stats-a: receipt repaired, replayed attempt att-1a2b-42-0; nothing executed\n', 'repaired'],
  ];
  for (const [stderr, outcome] of cases) {
    const result = runRecoverableStats(request(runsDir), { env: {}, runInvocation: ix(0, stderr, stdout) });
    assert.equal(result.outcome, outcome);
    assert.equal(result.attemptId, 'att-1a2b-42-0');
    assert.deepEqual(result.summary, SUMMARY);
  }
});

test('Gaia refuses an input that conflicts with the run already recorded and consumes nothing', () => {
  const runsDir = store('gaia-stats-a', 'att-1a2b-42-0');
  const cases = [
    ['ix: run gaia-stats-a: conflict: run "gaia-stats-a" was first used with other bindings: spec_sha256\n',
      'RUN_CONFLICT'],
    ['ix: run gaia-stats-a: --run-id runs only stages whose skill is audited as pure (distance, stats); refused: q (fft)\n',
      'STAGE_REFUSED'],
    ['ix: run gaia-stats-a: unknown: run "gaia-stats-a" is held by another owner\n', 'RUN_HELD'],
    ['ix: run gaia-stats-a: corrupt: the receipt does not match the commit\n', 'RUN_CORRUPT'],
    ['ix: execution: something else\n', 'IX_FAILED'],
  ];
  for (const [stderr, code] of cases) {
    assert.throws(
      () => runRecoverableStats(request(runsDir), { env: {}, runInvocation: ix(1, stderr) }),
      (error) => error instanceof IxRecoverError && error.code === code && error.ixExit === 1,
    );
  }
});

test('Gaia refuses an output whose receipt does not name the announced attempt', () => {
  const stdout = JSON.stringify(SUMMARY);
  const announced = 'run gaia-stats-a: published attempt att-1a2b-42-0\n';
  for (const runsDir of [store('gaia-stats-a', 'att-ffff-7-0'), store('gaia-stats-a', null)]) {
    assert.throws(
      () => runRecoverableStats(request(runsDir), { env: {}, runInvocation: ix(0, announced, stdout) }),
      (error) => error instanceof IxRecoverError && error.code === 'IX_PROTOCOL_INVALID',
    );
  }
  const runsDir = store('gaia-stats-a', 'att-1a2b-42-0');
  for (const [stderr, out] of [['', stdout], [announced, 'not json'], [`${announced}${announced}`, stdout]]) {
    assert.throws(
      () => runRecoverableStats(request(runsDir), { env: {}, runInvocation: ix(0, stderr, out) }),
      (error) => error instanceof IxRecoverError && error.code === 'IX_PROTOCOL_INVALID',
    );
  }
});

test('Gaia refuses an unsafe request before it starts IX', () => {
  const runsDir = store('gaia-stats-a', null);
  const unsafe = [
    { runId: '../escape' }, { runId: 'NUL' }, { runId: 'ends.' }, { runId: '' },
    { runsDir: join('relative', 'runs') }, { specFile: 'ix.yaml' }, { params: { 'n=1': 2 } },
  ];
  for (const overrides of unsafe) {
    assert.throws(
      () => runRecoverableStats(request(runsDir, overrides), {
        env: {}, runInvocation: () => assert.fail('IX must not start'),
      }),
      (error) => error instanceof IxRecoverError && error.code === 'REQUEST_INVALID',
    );
  }
});
