param(
    [Parameter(Mandatory = $true)]
    [string] $OutputPath,

    [string] $Repository = 'GuitarAlchemist/gaia',

    [ValidateRange(5, 300)]
    [int] $IntervalSeconds = 15,

    [switch] $Watch
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GaiaHostIdle {
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    public static long Seconds() {
        var info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (!GetLastInputInfo(ref info)) return -1;
        return (Environment.TickCount64 - info.dwTime) / 1000;
    }
}
'@

function Invoke-GhJson {
    param([string[]] $Arguments)
    $json = & gh @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "gh failed with exit code $LASTEXITCODE"
    }
    return ($json | ConvertFrom-Json)
}

function Get-CheckSummary {
    param($Rollup)
    $summary = [ordered]@{ success = 0; failure = 0; pending = 0; total = 0 }
    foreach ($check in @($Rollup)) {
        $summary.total++
        if ($check.status -ne 'COMPLETED') { $summary.pending++; continue }
        if ($check.conclusion -eq 'SUCCESS') { $summary.success++; continue }
        $summary.failure++
    }
    return $summary
}

function Write-LiveState {
    $drafts = Invoke-GhJson -Arguments @('pr', 'list', '--repo', $Repository, '--state', 'open', '--json', 'number,title,isDraft,url,headRefName,createdAt,updatedAt,author,statusCheckRollup', '--limit', '50')
    $draftProjection = @($drafts | Where-Object isDraft | ForEach-Object {
        [ordered]@{
            number = $_.number
            title = $_.title
            url = $_.url
            branch = $_.headRefName
            author = $_.author.login
            createdAt = $_.createdAt
            updatedAt = $_.updatedAt
            checks = Get-CheckSummary $_.statusCheckRollup
        }
    })

    $runs = Invoke-GhJson -Arguments @('run', 'list', '--repo', $Repository, '--workflow', 'Hosted Draft intake', '--json', 'databaseId,status,conclusion,url,createdAt,updatedAt', '--limit', '1')
    $latestRun = @($runs) | Select-Object -First 1
    $idleSeconds = [GaiaHostIdle]::Seconds()
    $state = [ordered]@{
        schema = 'GaiaNowLiveStateV0'
        observedAt = [DateTimeOffset]::UtcNow.ToString('o')
        digest = 'live-github'
        drafts = $draftProjection
        pump = if ($latestRun) { [ordered]@{
            runId = $latestRun.databaseId
            status = $latestRun.status
            conclusion = $latestRun.conclusion
            url = $latestRun.url
            createdAt = $latestRun.createdAt
            updatedAt = $latestRun.updatedAt
        }} else { $null }
        afk = [ordered]@{
            status = if ($idleSeconds -ge 300) { 'afk' } elseif ($idleSeconds -ge 0) { 'present' } else { 'unknown' }
            idleSeconds = if ($idleSeconds -ge 0) { $idleSeconds } else { $null }
        }
    }

    $resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
    $outputDirectory = [IO.Path]::GetDirectoryName($resolvedOutput)
    if (-not (Test-Path -LiteralPath $outputDirectory)) {
        throw "Output directory does not exist: $outputDirectory"
    }
    $temporary = "$resolvedOutput.tmp"
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $resolvedOutput -Force
}

do {
    try {
        Write-LiveState
    }
    catch {
        Write-Error $_
        if (-not $Watch) { throw }
    }
    if ($Watch) { Start-Sleep -Seconds $IntervalSeconds }
} while ($Watch)
