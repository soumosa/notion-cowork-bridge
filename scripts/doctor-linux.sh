#!/usr/bin/env bash
set -uo pipefail

config_file="${NOTION_COWORK_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/notion-cowork-bridge/bridge.env}"
if [ ! -r "$config_file" ]; then
  echo "FAIL: missing bridge configuration at $config_file" >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$config_file"

# MCP_ALLOWED_HOSTS may hold several hostnames; the tunnel serves the first.
public_host="${MCP_ALLOWED_HOSTS%%,*}"
failed=0

check() {
  label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS: $label"
  else
    echo "FAIL: $label"
    failed=1
  fi
}

check "Node executable" test -x "$NODE_BIN"
check "ngrok executable" test -x "$NGROK_BIN"
check "workspace directory" test -d "$MCP_WORKSPACE_ROOT"
check "token file" test -s "$TOKEN_FILE"
check "bridge service" systemctl --user is-active notion-cowork-bridge.service
check "tunnel service" systemctl --user is-active notion-cowork-bridge-tunnel.service
check "local health endpoint" curl -fsS --max-time 5 \
  "http://127.0.0.1:$MCP_PORT/health"
check "public health endpoint" curl -fsS --max-time 10 \
  "https://$public_host/health"

token_mode="$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null || echo unknown)"
if [ "$token_mode" = "600" ]; then
  echo "PASS: token file permissions (600)"
else
  echo "FAIL: token file permissions are $token_mode, expected 600"
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

# Token age is a warning, not a failure: an old token still works, it is
# just overdue for rotation.
if [ -n "${TOKEN_CREATED_AT:-}" ]; then
  created_epoch=$(date -d "$TOKEN_CREATED_AT" +%s 2>/dev/null || echo 0)
  if [ "$created_epoch" -gt 0 ]; then
    age_days=$(( ($(date +%s) - created_epoch) / 86400 ))
    if [ "$age_days" -gt 90 ]; then
      echo "WARN: token is $age_days days old; rotate it with scripts/rotate-token-linux.sh"
    fi
  fi
else
  echo "WARN: token age unknown (installed before age tracking); rotate to start tracking"
fi

echo "Bridge URL: https://$public_host/mcp"
echo "Workspace: $MCP_WORKSPACE_ROOT"
echo "Audit log: ${MCP_AUDIT_LOG:-<unset>}"
