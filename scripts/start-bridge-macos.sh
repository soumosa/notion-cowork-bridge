#!/bin/zsh
set -euo pipefail

config_file="${NOTION_COWORK_CONFIG:-$HOME/.config/notion-cowork-bridge/bridge.env}"
if [[ ! -r "$config_file" ]]; then
  print -u2 "Missing bridge configuration: $config_file"
  exit 1
fi

source "$config_file"

export PATH="$BRIDGE_PATH"
export SHELL="$COMMAND_SHELL"
export MCP_AUTH_TOKEN="$(
  /usr/bin/security find-generic-password \
    -a "$KEYCHAIN_ACCOUNT" \
    -s "$KEYCHAIN_SERVICE" \
    -w
)"
export MCP_WORKSPACE_ROOT
export MCP_ALLOWED_HOSTS
export MCP_PORT
export MCP_AUDIT_LOG

exec "$NODE_BIN" "$RUNTIME_ROOT/src/server.js"
