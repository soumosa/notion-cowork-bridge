#Requires -Version 5.1
<#
.SYNOPSIS
  Single entry point on Windows. This is a thin router: install, doctor,
  token, rotate, and uninstall delegate straight to the per-verb script in
  this same directory. logs, audit, and set-workspace have no dedicated
  script of their own, so they're implemented here directly.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('install', 'doctor', 'token', 'rotate', 'uninstall', 'logs', 'audit', 'set-workspace')]
    [string]$Verb,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if (-not $Rest) { $Rest = @() }

function Get-BridgeConfig {
    $configFile = if ($env:NOTION_COWORK_CONFIG) {
        $env:NOTION_COWORK_CONFIG
    } else {
        Join-Path $env:APPDATA 'notion-cowork-bridge\bridge.json'
    }
    if (-not (Test-Path -LiteralPath $configFile)) {
        Write-Error "Missing bridge configuration: $configFile"
    }
    [pscustomobject]@{
        Path   = $configFile
        Config = (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json)
    }
}

switch ($Verb) {
    'install' {
        & (Join-Path $scriptDir 'install-windows.ps1') @Rest
        exit $LASTEXITCODE
    }
    'doctor' {
        & (Join-Path $scriptDir 'doctor-windows.ps1') @Rest
        exit $LASTEXITCODE
    }
    'token' {
        & (Join-Path $scriptDir 'show-token-windows.ps1') @Rest
        exit $LASTEXITCODE
    }
    'rotate' {
        & (Join-Path $scriptDir 'rotate-token-windows.ps1') @Rest
        exit $LASTEXITCODE
    }
    'uninstall' {
        & (Join-Path $scriptDir 'uninstall-windows.ps1') @Rest
        exit $LASTEXITCODE
    }
    'logs' {
        Write-Output 'Windows does not capture the bridge''s stdout to a file by default.'
        Write-Output "Check the 'NotionCoworkBridge' scheduled task history in Task Scheduler, or run 'bridge.ps1 audit' for the structured audit log."
    }
    'audit' {
        $result = Get-BridgeConfig
        if (-not $result.Config.AuditLog) {
            Write-Error 'No audit log configured.'
        }
        Get-Content -LiteralPath $result.Config.AuditLog -Wait -Tail 200
    }
    'set-workspace' {
        if ($Rest.Count -lt 1) {
            Write-Error 'Usage: bridge.ps1 set-workspace <absolute-path>'
        }
        $newWorkspace = $Rest[0]
        if (-not [System.IO.Path]::IsPathRooted($newWorkspace)) {
            Write-Error 'Workspace must be an absolute path.'
        }
        New-Item -ItemType Directory -Force -Path $newWorkspace | Out-Null
        $result = Get-BridgeConfig
        $config = $result.Config
        if ($config.PSObject.Properties.Name -contains 'WorkspaceRoot') {
            $config.WorkspaceRoot = $newWorkspace
        } else {
            $config | Add-Member -NotePropertyName WorkspaceRoot -NotePropertyValue $newWorkspace
        }
        $config | ConvertTo-Json | Set-Content -LiteralPath $result.Path -Encoding UTF8
        Stop-ScheduledTask -TaskName 'NotionCoworkBridge' -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName 'NotionCoworkBridge'
        Write-Output "Workspace set to $newWorkspace and the bridge restarted."
    }
}
