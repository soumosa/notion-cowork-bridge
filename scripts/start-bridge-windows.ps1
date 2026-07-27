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

# The token is sealed with DPAPI, so only this user on this machine can read
# it back. There is no plaintext copy on disk.
$secure = Get-Content -LiteralPath $config.TokenFile | ConvertTo-SecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$env:MCP_AUTH_TOKEN = $token
$env:MCP_WORKSPACE_ROOT = $config.WorkspaceRoot
$env:MCP_ALLOWED_HOSTS = $config.AllowedHosts
$env:MCP_PORT = [string]$config.Port
$env:MCP_AUDIT_LOG = $config.AuditLog

& $config.NodeBin (Join-Path $config.RuntimeRoot 'src\server.js')
exit $LASTEXITCODE
