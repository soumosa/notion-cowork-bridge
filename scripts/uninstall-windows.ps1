#Requires -Version 5.1
<#
.SYNOPSIS
  Remove the bridge scheduled tasks. Add -Purge to also delete the runtime,
  configuration, token, and audit log. The workspace is never deleted.
#>
[CmdletBinding()]
param([switch]$Purge)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

foreach ($task in @('NotionCoworkBridgeTunnel', 'NotionCoworkBridge')) {
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
}
Write-Output 'Stopped and removed the bridge scheduled tasks.'

if ($Purge) {
    $runtimeRoot = Join-Path $env:LOCALAPPDATA 'notion-cowork-bridge'
    $configDir = Join-Path $env:APPDATA 'notion-cowork-bridge'
    foreach ($dir in @($runtimeRoot, $configDir)) {
        if (Test-Path -LiteralPath $dir) {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Output 'Purged the installed runtime, configuration, token, and audit log.'
}

Write-Output 'The workspace itself was not deleted.'
