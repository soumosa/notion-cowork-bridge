#Requires -Version 5.1
<#
.SYNOPSIS
  Runs a target installer script with Register-ScheduledTask (and the task
  lifecycle cmdlets around it) shadowed by fakes that record their
  arguments instead of touching the real Task Scheduler.
.NOTES
  PowerShell resolves functions before cmdlets in the same session
  regardless of which script file a call appears in, so defining these as
  global functions here is enough to intercept calls made inside
  $TargetScript without needing to modify that script at all.
  New-ScheduledTaskAction/-Trigger/-SettingsSet are left as the real
  cmdlets: they only build objects in memory and have no side effects.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetScript,

    [string[]]$TargetArgs = @(),

    [Parameter(Mandatory = $true)]
    [string]$ArgvLog
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-StubCall {
    param([string]$Name, [hashtable]$Args)
    $record = [pscustomobject]@{ name = $Name; args = $Args }
    Add-Content -LiteralPath $ArgvLog -Value ($record | ConvertTo-Json -Compress -Depth 5)
}

function global:Register-ScheduledTask {
    param(
        [string]$TaskName,
        $Action,
        $Trigger,
        $Settings,
        [switch]$Force
    )
    Write-StubCall -Name 'Register-ScheduledTask' -Args @{
        TaskName  = $TaskName
        Execute   = $Action.Execute
        Arguments = $Action.Arguments
    }
    return $null
}

function global:Start-ScheduledTask {
    param([string]$TaskName)
    Write-StubCall -Name 'Start-ScheduledTask' -Args @{ TaskName = $TaskName }
}

function global:Stop-ScheduledTask {
    param([string]$TaskName, [string]$ErrorAction)
    Write-StubCall -Name 'Stop-ScheduledTask' -Args @{ TaskName = $TaskName }
}

function global:Unregister-ScheduledTask {
    param([string]$TaskName, [switch]$Confirm, [string]$ErrorAction)
    Write-StubCall -Name 'Unregister-ScheduledTask' -Args @{ TaskName = $TaskName }
}

function global:Get-ScheduledTask {
    param([string]$TaskName, [string]$ErrorAction)
    Write-StubCall -Name 'Get-ScheduledTask' -Args @{ TaskName = $TaskName }
    [pscustomobject]@{ TaskName = $TaskName; State = 'Ready' }
}

& $TargetScript @TargetArgs
exit $LASTEXITCODE
