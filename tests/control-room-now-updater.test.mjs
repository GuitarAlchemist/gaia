import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('Gaia NOW updater collects later-page drafts and retains output on collection failure', {
  skip: process.platform !== 'win32' && 'The updater observes Windows host idle state',
}, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-now-updater-'));
  try {
    const fixturePath = join(scratch, 'github.json');
    const outputPath = join(scratch, 'state.json');
    const wrapperPath = join(scratch, 'run.ps1');
    const scriptPath = fileURLToPath(new URL('../scripts/update-gaia-now-state.ps1', import.meta.url));
    writeFileSync(wrapperPath, `
param($FixturePath, $OutputPath, $ScriptPath)
$fixture = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
function gh {
  $global:LASTEXITCODE = 0
  if ($args[0] -eq 'api' -and $args[1] -eq 'graphql') {
    if ($fixture.failure -eq 'counts') { $global:LASTEXITCODE = 1; return }
    return '{"data":{"repository":{"issues":{"totalCount":38},"ready":{"totalCount":1},"pullRequests":{"totalCount":101}}}}'
  }
  if ($args[0] -eq 'api') {
    if ($fixture.failure -eq 'page') {
      $global:LASTEXITCODE = 1
      return ConvertTo-Json -InputObject @($fixture.pages[0]) -Depth 20
    }
    if ($args -contains '--paginate' -and $args -contains '--slurp' -and ($args -join ' ') -match 'pulls\\?state=open&per_page=100') {
      return ConvertTo-Json -InputObject $fixture.pages -Depth 20
    }
    return ConvertTo-Json -InputObject @($fixture.pages[0]) -Depth 20
  }
  if ($args[0] -eq 'pr' -and $args[1] -eq 'list') {
    return ConvertTo-Json -InputObject @($fixture.pages[0] | Select-Object -First 50) -Depth 20
  }
  if ($args[0] -eq 'pr' -and $args[1] -eq 'view') {
    if ($fixture.failure -eq 'detail') { $global:LASTEXITCODE = 1; return }
    return ConvertTo-Json -InputObject $fixture.details.PSObject.Properties[$args[2]].Value -Depth 20
  }
  if ($args[0] -eq 'run' -and $args[1] -eq 'list') { return '[]' }
  throw 'Unexpected GitHub command'
}
& $ScriptPath -OutputPath $OutputPath
`, 'utf8');

    const detail = {
      number: 101, title: 'Later-page draft', isDraft: true,
      url: 'https://github.com/GuitarAlchemist/gaia/pull/101', headRefName: 'later-draft',
      author: { login: 'witness' }, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z',
      mergeStateStatus: 'DIRTY', statusCheckRollup: [
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
        { status: 'IN_PROGRESS', conclusion: null },
      ],
    };
    const fixture = {
      pages: [Array.from({ length: 100 }, (_, index) => ({ number: index + 1, draft: false, isDraft: false })), [{ number: 101, draft: true }]],
      details: { 101: detail }, failure: null,
    };
    function run() {
      writeFileSync(fixturePath, JSON.stringify(fixture));
      return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', wrapperPath,
        '-FixturePath', fixturePath, '-OutputPath', outputPath, '-ScriptPath', scriptPath], { encoding: 'utf8', timeout: 30000 });
    }
    const result = run();
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const state = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.deepEqual(state.backlog, { issuesOpen: 38, issuesReady: 1, prsOpen: 101 });
    assert.deepEqual(state.drafts, [{
      number: 101, title: detail.title, url: detail.url, branch: detail.headRefName, author: 'witness',
      createdAt: detail.createdAt, updatedAt: detail.updatedAt, mergeStateStatus: 'DIRTY',
      checks: { success: 1, failure: 1, pending: 1, neutral: 0, total: 3 },
    }]);
    const retained = readFileSync(outputPath, 'utf8');
    for (const failure of ['page', 'detail', 'counts']) {
      fixture.failure = failure;
      const failed = run();
      assert.notEqual(failed.status, 0, `${failure} failure must reject the refresh`);
      assert.equal(readFileSync(outputPath, 'utf8'), retained, `${failure} failure must preserve previous JSON`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('Gaia NOW updater measures host idle time in wrapping tick units', {
  skip: process.platform !== 'win32' && 'The updater observes Windows host idle state',
}, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-now-idle-'));
  try {
    const probePath = join(scratch, 'probe.ps1');
    const scriptPath = fileURLToPath(new URL('../scripts/update-gaia-now-state.ps1', import.meta.url));
    // The updater's public idle calculation is loaded by running the updater itself; the stubbed
    // gh rejects the refresh so only the production idle type survives to answer the literal cases.
    writeFileSync(probePath, `
param($OutputPath, $ScriptPath)
function gh { $global:LASTEXITCODE = 1 }
try { & $ScriptPath -OutputPath $OutputPath } catch { }
$wrap = 4294967296
[ordered]@{
  ordinary = [GaiaHostIdle]::ElapsedSeconds(10000000, 9995000)
  wrapped = [GaiaHostIdle]::ElapsedSeconds($wrap + 2000, $wrap - 3000)
  pastOneWrap = [GaiaHostIdle]::ElapsedSeconds((2 * $wrap) + 2000, $wrap - 3000)
  threshold = [GaiaHostIdle]::ElapsedSeconds($wrap + 310000, 10000)
  belowThreshold = [GaiaHostIdle]::ElapsedSeconds($wrap + 309999, 10000)
  thresholdStatus = [GaiaHostIdle]::Status([GaiaHostIdle]::ElapsedSeconds($wrap + 310000, 10000))
  belowThresholdStatus = [GaiaHostIdle]::Status([GaiaHostIdle]::ElapsedSeconds($wrap + 309999, 10000))
  failedStatus = [GaiaHostIdle]::Status(-1)
} | ConvertTo-Json -Compress
`, 'utf8');

    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', probePath,
      '-OutputPath', join(scratch, 'state.json'), '-ScriptPath', scriptPath], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), {
      ordinary: 5,
      wrapped: 5,
      pastOneWrap: 5,
      threshold: 300,
      belowThreshold: 299,
      thresholdStatus: 'afk',
      belowThresholdStatus: 'present',
      failedStatus: 'unknown',
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
