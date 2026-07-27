#!/bin/zsh
set -euo pipefail

config_file="${NOTION_COWORK_CONFIG:-$HOME/.config/notion-cowork-bridge/bridge.env}"
if [[ ! -r "$config_file" ]]; then
  print -u2 "FAIL: missing bridge configuration at $config_file"
  exit 1
fi

source "$config_file"
uid_value="$(/usr/bin/id -u)"
# MCP_ALLOWED_HOSTS may hold several hostnames; the tunnel serves the first.
public_host="${MCP_ALLOWED_HOSTS%%,*}"
failed=0

check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    print "PASS: $label"
  else
    print "FAIL: $label"
    failed=1
  fi
}

check "Node executable" test -x "$NODE_BIN"
check "ngrok executable" test -x "$NGROK_BIN"
check "workspace directory" test -d "$MCP_WORKSPACE_ROOT"
check "Keychain token" /usr/bin/security find-generic-password \
  -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE"
check "bridge launch service" /bin/launchctl print \
  "gui/$uid_value/com.notion-cowork-bridge.mcp"
check "tunnel launch service" /bin/launchctl print \
  "gui/$uid_value/com.notion-cowork-bridge.tunnel"
check "local health endpoint" /usr/bin/curl -fsS --max-time 5 \
  "http://127.0.0.1:$MCP_PORT/health"
check "public health endpoint" /usr/bin/curl -fsS --max-time 10 \
  "https://$public_host/health"

if (( failed )); then
  exit 1
fi

print "Bridge URL: https://$public_host/mcp"
print "Workspace: $MCP_WORKSPACE_ROOT"
print "Audit log: ${MCP_AUDIT_LOG:-<unset>}"
