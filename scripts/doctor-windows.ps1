#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$configFile = if ($env:NOTION_COWORK_CONFIG) {
    $env:NOTION_COWORK_CONFIG
} else {
    Join-Path $env:APPDATA 'notion-cowork-bridge\bridge.json'
}

if (-not (Test-Path -LiteralPath $configFile)) {
    Write-Output "FAIL: missing bridge configuration at $configFile"
    exit 1
}

$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
# AllowedHosts may hold several hostnames; the tunnel serves the first.
$publicHost = ($config.AllowedHosts -split ',')[0].Trim()
$failed = $false

function Test-Item {
    param([string]$Label, [scriptblock]$Check)
    try {
        if (& $Check) {
            Write-Output "PASS: $Label"
        } else {
            Write-Output "FAIL: $Label"
            $script:failed = $true
        }
    } catch {
        Write-Output "FAIL: $Label"
        $script:failed = $true
    }
}

Test-Item 'Node executable' { Test-Path -LiteralPath $config.NodeBin }
Test-Item 'ngrok executable' { Test-Path -LiteralPath $config.NgrokBin }
Test-Item 'workspace directory' { Test-Path -LiteralPath $config.WorkspaceRoot }
Test-Item 'token file' { Test-Path -LiteralPath $config.TokenFile }
Test-Item 'bridge scheduled task' {
    (Get-ScheduledTask -TaskName 'NotionCoworkBridge' -ErrorAction Stop).State -ne 'Disabled'
}
Test-Item 'tunnel scheduled task' {
    (Get-ScheduledTask -TaskName 'NotionCoworkBridgeTunnel' -ErrorAction Stop).State -ne 'Disabled'
}
Test-Item 'local health endpoint' {
    $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 `
        -Uri "http://127.0.0.1:$($config.Port)/health"
    $true
}
Test-Item 'public health endpoint' {
    $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 `
        -Uri "https://$publicHost/health"
    $true
}

if ($failed) { exit 1 }

# Token age is a warning, not a failure: an old token still works, it is
# just overdue for rotation.
if ($config.PSObject.Properties.Name -contains 'TokenCreatedAt' -and $config.TokenCreatedAt) {
    try {
        $createdAt = [datetime]::Parse(
            $config.TokenCreatedAt, $null,
            [System.Globalization.DateTimeStyles]::RoundtripKind -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
        $ageDays = [int]((Get-Date).ToUniversalTime() - $createdAt.ToUniversalTime()).TotalDays
        if ($ageDays -gt 90) {
            Write-Output "WARN: token is $ageDays days old; rotate it with scripts\rotate-token-windows.ps1"
        }
    } catch {
        Write-Output 'WARN: token age unknown (could not parse TokenCreatedAt); rotate to start tracking'
    }
} else {
    Write-Output 'WARN: token age unknown (installed before age tracking); rotate to start tracking'
}

Write-Output "Bridge URL: https://$publicHost/mcp"
Write-Output "Workspace: $($config.WorkspaceRoot)"
Write-Output "Audit log: $($config.AuditLog)"
