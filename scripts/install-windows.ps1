#Requires -Version 5.1
<#
.SYNOPSIS
  Install the Notion Cowork Bridge as per-user scheduled tasks on Windows.
.NOTES
  The parameter is -PublicHost, not -Host: $Host is a PowerShell automatic
  variable and cannot be used as a parameter name.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PublicHost,

    [string]$Workspace = (Join-Path $env:USERPROFILE 'notion-workspace'),

    [ValidateRange(1, 65535)]
    [int]$Port = 3210,

    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BridgeTask = 'NotionCoworkBridge'
$TunnelTask = 'NotionCoworkBridgeTunnel'

function Get-Executable {
    param([string]$Name)
    $found = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { return $found.Source }
    return $null
}

$PublicHost = $PublicHost -replace '^https?://', ''
$PublicHost = $PublicHost -replace '/mcp$', ''
$PublicHost = $PublicHost.TrimEnd('/')

if ($PublicHost -notmatch '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$') {
    Write-Error "Invalid public hostname: $PublicHost"
    exit 2
}
if (-not [System.IO.Path]::IsPathRooted($Workspace)) {
    Write-Error '-Workspace must be an absolute path.'
    exit 2
}

$nodeBin = Get-Executable 'node'
$npmBin = Get-Executable 'npm'
$ngrokBin = Get-Executable 'ngrok'
if (-not $nodeBin) { Write-Error 'Node.js 20 or newer is required.'; exit 1 }
if (-not $npmBin) { Write-Error 'npm is required.'; exit 1 }
if (-not $ngrokBin) {
    Write-Error 'ngrok is required. Install it and run: ngrok config add-authtoken <token>'
    exit 1
}

$nodeMajor = [int](& $nodeBin -p 'Number(process.versions.node.split(".")[0])')
if ($nodeMajor -lt 20) {
    Write-Error "Node.js 20 or newer is required; found $(& $nodeBin --version)."
    exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'notion-cowork-bridge'
$configDir = Join-Path $env:APPDATA 'notion-cowork-bridge'
$configFile = Join-Path $configDir 'bridge.json'
$tokenFile = Join-Path $configDir 'token.dpapi'
$auditLog = Join-Path $runtimeRoot 'audit.jsonl'
$startScript = Join-Path $runtimeRoot 'scripts\start-bridge-windows.ps1'

Write-Output "Repository: $repoRoot"
Write-Output "Workspace: $Workspace"
Write-Output "Public MCP URL: https://$PublicHost/mcp"
Write-Output "Node: $nodeBin"
Write-Output "ngrok: $ngrokBin"
Write-Output "Token file: $tokenFile (DPAPI, this user only)"

if ($DryRun) {
    Write-Output 'Dry run complete; no files or tasks were changed.'
    exit 0
}

& $ngrokBin config check | Out-Null

foreach ($dir in @($Workspace, (Join-Path $runtimeRoot 'src'), (Join-Path $runtimeRoot 'scripts'), $configDir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

Copy-Item (Join-Path $repoRoot 'package.json') (Join-Path $runtimeRoot 'package.json') -Force
Copy-Item (Join-Path $repoRoot 'package-lock.json') (Join-Path $runtimeRoot 'package-lock.json') -Force
Copy-Item (Join-Path $repoRoot 'src\server.js') (Join-Path $runtimeRoot 'src\server.js') -Force
Copy-Item (Join-Path $repoRoot 'scripts\start-bridge-windows.ps1') $startScript -Force

Push-Location $runtimeRoot
try {
    & $npmBin ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $tokenFile)) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    ConvertTo-SecureString -String $token -AsPlainText -Force |
        ConvertFrom-SecureString |
        Set-Content -LiteralPath $tokenFile -Encoding ASCII
}

[pscustomobject]@{
    NodeBin       = $nodeBin
    NgrokBin      = $ngrokBin
    RuntimeRoot   = $runtimeRoot
    TokenFile     = $tokenFile
    WorkspaceRoot = $Workspace
    AllowedHosts  = $PublicHost
    Port          = $Port
    AuditLog      = $auditLog
} | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding UTF8

$taskSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$bridgeAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
Register-ScheduledTask -TaskName $BridgeTask -Action $bridgeAction -Trigger $trigger `
    -Settings $taskSettings -Force | Out-Null

$tunnelAction = New-ScheduledTaskAction `
    -Execute $ngrokBin `
    -Argument "http $Port --url https://$PublicHost --log stdout"
Register-ScheduledTask -TaskName $TunnelTask -Action $tunnelAction -Trigger $trigger `
    -Settings $taskSettings -Force | Out-Null

Start-ScheduledTask -TaskName $BridgeTask
Start-ScheduledTask -TaskName $TunnelTask

$healthy = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 `
            -Uri "http://127.0.0.1:$Port/health" | Out-Null
        $healthy = $true
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $healthy) {
    Write-Error "The bridge did not become healthy. Inspect the '$BridgeTask' scheduled task history."
    exit 1
}

Write-Output ''
Write-Output 'Installed successfully.'
Write-Output "MCP URL: https://$PublicHost/mcp"
Write-Output "Workspace: $Workspace"
Write-Output "Audit log: $auditLog"
Write-Output "Token: scripts\show-token-windows.ps1"
Write-Output "Health check: scripts\doctor-windows.ps1"
