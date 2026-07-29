#!/bin/zsh
set -euo pipefail

config_file="${NOTION_COWORK_CONFIG:-$HOME/.config/notion-cowork-bridge/bridge.env}"
if [[ ! -r "$config_file" ]]; then
  print -u2 "FAIL: missing bridge configuration at $config_file"
  exit 1
fi

source "$config_file"
uid_value="$(/usr/bin/id -u)"
security_bin="$(command -v security || print -r -- /usr/bin/security)"
launchctl_bin="$(command -v launchctl || print -r -- /bin/launchctl)"
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
check "Keychain token" "$security_bin" find-generic-password \
  -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE"
check "bridge launch service" "$launchctl_bin" print \
  "gui/$uid_value/com.notion-cowork-bridge.mcp"
check "tunnel launch service" "$launchctl_bin" print \
  "gui/$uid_value/com.notion-cowork-bridge.tunnel"
check "local health endpoint" /usr/bin/curl -fsS --max-time 5 \
  "http://127.0.0.1:$MCP_PORT/health"
check "public health endpoint" /usr/bin/curl -fsS --max-time 10 \
  "https://$public_host/health"

if (( failed )); then
  exit 1
fi

# Token age is a warning, not a failure: an old token still works, it is
# just overdue for rotation.
if [[ -n "${TOKEN_CREATED_AT:-}" ]]; then
  created_epoch="$(/bin/date -j -f '%Y-%m-%dT%H:%M:%SZ' "$TOKEN_CREATED_AT" +%s 2>/dev/null || print 0)"
  if (( created_epoch > 0 )); then
    age_days=$(( ($(/bin/date +%s) - created_epoch) / 86400 ))
    (( age_days > 90 )) && print "WARN: token is $age_days days old; rotate it with scripts/rotate-token-macos.sh"
  fi
else
  print "WARN: token age unknown (installed before age tracking); rotate to start tracking"
fi

print "Bridge URL: https://$public_host/mcp"
print "Workspace: $MCP_WORKSPACE_ROOT"
print "Audit log: ${MCP_AUDIT_LOG:-<unset>}"
