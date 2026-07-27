#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$configFile = if ($env:NOTION_COWORK_CONFIG) {
    $env:NOTION_COWORK_CONFIG
} else {
    Join-Path $env:APPDATA 'notion-cowork-bridge\bridge.json'
}

if (-not (Test-Path -LiteralPath $configFile)) {
    Write-Error "Missing bridge configuration: $configFile"
    exit 1
}

$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$secure = Get-Content -LiteralPath $config.TokenFile | ConvertTo-SecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    Write-Output ([Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr))
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
