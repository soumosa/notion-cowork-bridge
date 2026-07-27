#!/usr/bin/env bash
set -euo pipefail

config_file="${NOTION_COWORK_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/notion-cowork-bridge/bridge.env}"
if [ ! -r "$config_file" ]; then
  echo "Missing bridge configuration: $config_file" >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$config_file"

MCP_AUTH_TOKEN="$(cat "$TOKEN_FILE")"
export MCP_AUTH_TOKEN
export MCP_WORKSPACE_ROOT
export MCP_ALLOWED_HOSTS
export MCP_PORT
export MCP_AUDIT_LOG

exec "$NODE_BIN" "$RUNTIME_ROOT/src/server.js"
