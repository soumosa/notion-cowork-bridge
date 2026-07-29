#Requires -Version 5.1
<#
.SYNOPSIS
  Replace the bearer token and restart the bridge. The old token stops working
  immediately, so update the connection in Notion afterwards.
#>
[CmdletBinding()]
param([switch]$Force)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$configFile = if ($env:NOTION_COWORK_CONFIG) {
    $env:NOTION_COWORK_CONFIG
} else {
    Join-Path $env:APPDATA 'notion-cowork-bridge\bridge.json'
}

if (-not (Test-Path -LiteralPath $configFile)) {
    Write-Error "Missing bridge configuration: $configFile. Run scripts\install-windows.ps1 first."
    exit 1
}

$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json

if (-not $Force) {
    Write-Output 'This invalidates the current token. The Notion connection will fail'
    Write-Output "until you paste the new one into the agent's MCP settings."
    $reply = Read-Host 'Rotate now? [y/N]'
    if ($reply -notmatch '^[yY]$') {
        Write-Output 'Cancelled; nothing changed.'
        exit 0
    }
}

$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$token = -join ($bytes | ForEach-Object { $_.ToString('x2') })

ConvertTo-SecureString -String $token -AsPlainText -Force |
    ConvertFrom-SecureString |
    Set-Content -LiteralPath $config.TokenFile -Encoding ASCII

$tokenCreatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
if ($config.PSObject.Properties.Name -contains 'TokenCreatedAt') {
    $config.TokenCreatedAt = $tokenCreatedAt
} else {
    $config | Add-Member -NotePropertyName TokenCreatedAt -NotePropertyValue $tokenCreatedAt
}
$config | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding UTF8

Stop-ScheduledTask -TaskName 'NotionCoworkBridge' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'NotionCoworkBridge'

$healthy = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 `
            -Uri "http://127.0.0.1:$($config.Port)/health" | Out-Null
        $healthy = $true
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $healthy) {
    Write-Error "The bridge did not come back up. Inspect the 'NotionCoworkBridge' task history."
    exit 1
}

Write-Output 'Token rotated and the bridge restarted.'
Write-Output 'New token: scripts\show-token-windows.ps1'
Write-Output 'Update the Custom MCP server connection in Notion now.'
