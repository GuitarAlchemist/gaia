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
    private const long AwaySeconds = 300;
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    public static long ElapsedSeconds(long tickCount, uint lastInputTick) {
        // GetLastInputInfo reports a 32-bit tick that wraps every 49.7 days, so the elapsed
        // milliseconds must be measured in the same unsigned 32-bit modular units.
        unchecked { return ((uint)tickCount - lastInputTick) / 1000; }
    }
    public static string Status(long idleSeconds) {
        if (idleSeconds < 0) return "unknown";
        return idleSeconds >= AwaySeconds ? "afk" : "present";
    }
    public static long Seconds() {
        var info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (!GetLastInputInfo(ref info)) return -1;
        return ElapsedSeconds(Environment.TickCount64, info.dwTime);
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
    $summary = [ordered]@{ success = 0; failure = 0; pending = 0; neutral = 0; total = 0 }
    foreach ($check in @($Rollup)) {
        if ($null -eq $check) { continue }
        $summary.total++
        if ($null -eq $check.status) {
            # StatusContext entries carry no run status; their state is already terminal or pending.
            if ($check.state -eq 'SUCCESS') { $summary.success++ }
            elseif ($check.state -in @('FAILURE', 'ERROR')) { $summary.failure++ }
            else { $summary.pending++ }
            continue
        }
        if ($check.status -ne 'COMPLETED') { $summary.pending++; continue }
        if ($check.conclusion -eq 'SUCCESS') { $summary.success++; continue }
        if ($check.conclusion -in @('FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE')) {
            $summary.failure++
            continue
        }
        if ($check.conclusion -in @('SKIPPED', 'NEUTRAL')) { $summary.neutral++; continue }
        # An unrecognised conclusion is never reported as settled work.
        $summary.pending++
    }
    return $summary
}

function Write-LiveState {
    $pages = Invoke-GhJson -Arguments @('api', '--paginate', '--slurp', "repos/$Repository/pulls?state=open&per_page=100")
    $drafts = @(foreach ($page in $pages) {
        foreach ($pull in $page) {
            if ($pull.draft) {
                Invoke-GhJson -Arguments @('pr', 'view', [string] $pull.number, '--repo', $Repository, '--json', 'number,title,isDraft,url,headRefName,createdAt,updatedAt,author,mergeStateStatus,statusCheckRollup')
            }
        }
    })
    $draftProjection = @($drafts | Where-Object isDraft | ForEach-Object {
        [ordered]@{
            number = $_.number
            title = $_.title
            url = $_.url
            branch = $_.headRefName
            author = $_.author.login
            createdAt = $_.createdAt
            updatedAt = $_.updatedAt
            mergeStateStatus = $_.mergeStateStatus
            checks = Get-CheckSummary $_.statusCheckRollup
        }
    })

    $repositoryParts = $Repository.Split('/')
    if ($repositoryParts.Count -ne 2) { throw 'Expected owner/repository' }
    $query = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount} ready:issues(states:OPEN,labels:["ready-for-agent"]){totalCount} pullRequests(states:OPEN){totalCount}}}'
    $countsResponse = Invoke-GhJson -Arguments @('api', 'graphql', '-f', "query=$query", '-f', "owner=$($repositoryParts[0])", '-f', "name=$($repositoryParts[1])")
    if ($countsResponse.errors -or -not $countsResponse.data.repository) { throw 'Backlog count query failed' }
    $counts = $countsResponse.data.repository
    $backlog = [ordered]@{ issuesOpen = $counts.issues.totalCount; issuesReady = $counts.ready.totalCount; prsOpen = $counts.pullRequests.totalCount }
    foreach ($count in $backlog.Values) {
        if (($count -isnot [long] -and $count -isnot [int]) -or $count -lt 0) { throw 'Invalid backlog count' }
    }
    if ($backlog.issuesReady -gt $backlog.issuesOpen) { throw 'Inconsistent issue counts' }
    $runs = Invoke-GhJson -Arguments @('run', 'list', '--repo', $Repository, '--workflow', 'Hosted Draft intake', '--json', 'databaseId,status,conclusion,url,createdAt,updatedAt', '--limit', '1')
    $latestRun = @($runs) | Select-Object -First 1
    $idleSeconds = [GaiaHostIdle]::Seconds()
    $state = [ordered]@{
        schema = 'GaiaNowLiveStateV0'
        observedAt = [DateTimeOffset]::UtcNow.ToString('o')
        digest = 'live-github'
        drafts = $draftProjection
        backlog = $backlog
        pump = if ($latestRun) { [ordered]@{
            runId = $latestRun.databaseId
            status = $latestRun.status
            conclusion = $latestRun.conclusion
            url = $latestRun.url
            createdAt = $latestRun.createdAt
            updatedAt = $latestRun.updatedAt
        }} else { $null }
        afk = [ordered]@{
            status = [GaiaHostIdle]::Status($idleSeconds)
            idleSeconds = if ($idleSeconds -ge 0) { $idleSeconds } else { $null }
        }
    }

    $resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
    $outputDirectory = [IO.Path]::GetDirectoryName($resolvedOutput)
    if (-not (Test-Path -LiteralPath $outputDirectory)) {
        throw "Output directory does not exist: $outputDirectory"
    }
    $temporary = "$resolvedOutput.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $json = ($state | ConvertTo-Json -Depth 8) -replace "`r`n", "`n"
        [IO.File]::WriteAllText($temporary, "$json`n", [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $resolvedOutput -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

do {
    try {
        Write-LiveState
    }
    catch {
        if (-not $Watch) { throw }
        Write-Warning "Gaia Now refresh failed; retrying after $IntervalSeconds seconds: $($_.Exception.Message)"
    }
    if ($Watch) { Start-Sleep -Seconds $IntervalSeconds }
} while ($Watch)
