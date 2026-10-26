import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function scenario(mode) {
  const parent = mkdtempSync(join(tmpdir(), 'gaia-ix-scenario-contract-'));
  const work = join(parent, 'work');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'IX_RECOVER_PAUSE']
      .includes(key.toUpperCase())));
  Object.assign(env, { GAIA_SCENARIO_MODE: mode, GAIA_SCENARIO_WORK: work,
    OpenAi_Api_Key: 'fixture-only', anthropic_api_key: 'fixture-only',
    Gemini_Api_Key: 'fixture-only', google_api_key: 'fixture-only', Ix_Recover_Pause: 'fixture-only' });
  const result = spawnSync(process.execPath, ['--import',
    new URL('./fixtures/ix-recover-scenario-preload.mjs', import.meta.url).href,
    fileURLToPath(new URL('../scripts/ix-recover-scenario.mjs', import.meta.url)),
    '--ix', process.execPath, '--governance', parent, '--work', work], {
    env, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  const journal = existsSync(join(work, 'journal.jsonl'))
    ? readFileSync(join(work, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { ...result, work, journal };
}

test('the scenario refuses a concurrently claimed work directory without overwriting evidence', () => {
  const result = scenario('directory-race');
  assert.equal(readFileSync(join(result.work, 'ix.yaml'), 'utf8'), 'existing evidence\n');
  assert.equal(result.status, 2);
  assert.equal(existsSync(join(result.work, 'ix-unaudited.yaml')), false);
});

test('the scenario scrubs case variants and accepts confirmed process-kill recovery', () => {
  const result = scenario('success');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const environments = readFileSync(join(result.work, 'env.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const { kind, keys } of environments) {
    for (const key of keys) {
      assert.ok(!['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'].includes(key.toUpperCase()));
      if (key.toUpperCase() === 'IX_RECOVER_PAUSE') assert.ok(kind === 'interrupt' && key === 'IX_RECOVER_PAUSE');
    }
  }
  assert.equal(result.journal.filter(row => row.check && row.ok).length, 7);
  const killed = result.journal.filter(row => row.stop === 'killed');
  assert.equal(killed.length, 2);
  assert.ok(killed.every(row => row.killRequested === true && row.ixExit === null && row.signal === 'SIGTERM'));
});

test('the scenario never treats failed kills or natural exits as interruption evidence', () => {
  for (const mode of ['kill-false', 'natural-exit', 'marker-mismatch', 'marker-unreadable']) {
    const result = scenario(mode);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.journal.some(row => row.stop === 'killed'), false);
    assert.ok(result.journal.some(row => row.stop === 'unconfirmed'));
  }
});
