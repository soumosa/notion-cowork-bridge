#!/bin/zsh
set -euo pipefail

config_file="${NOTION_COWORK_CONFIG:-$HOME/.config/notion-cowork-bridge/bridge.env}"
if [[ ! -r "$config_file" ]]; then
  print -u2 "Missing bridge configuration: $config_file"
  exit 1
fi

source "$config_file"

security_bin="$(command -v security || print -r -- /usr/bin/security)"

export PATH="$BRIDGE_PATH"
export SHELL="$COMMAND_SHELL"
export NODE_ENV="production"
export MCP_AUTH_TOKEN="$(
  "$security_bin" find-generic-password \
    -a "$KEYCHAIN_ACCOUNT" \
    -s "$KEYCHAIN_SERVICE" \
    -w
)"
export MCP_WORKSPACE_ROOT
export MCP_ALLOWED_HOSTS
export MCP_PORT
export MCP_AUDIT_LOG
export MCP_NGROK_PREVIEW_URL

exec "$NODE_BIN" "$RUNTIME_ROOT/src/server.js"
