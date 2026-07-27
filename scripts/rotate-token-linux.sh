#!/usr/bin/env bash
set -euo pipefail

script_name="$(basename "$0")"

usage() {
  echo "Usage: $script_name [--force]"
  echo
  echo "Replaces the bearer token and restarts the bridge. The old token stops"
  echo "working immediately, so update the connection in Notion afterwards."
  echo
  echo "Options:"
  echo "  --force      Skip the confirmation prompt"
  echo "  -h, --help   Show this help"
}

force=0
case "${1:-}" in
  --force) force=1 ;;
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

config_file="${NOTION_COWORK_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/notion-cowork-bridge/bridge.env}"
if [ ! -r "$config_file" ]; then
  echo "Missing bridge configuration: $config_file" >&2
  echo "Run scripts/install-linux.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$config_file"

if [ "$force" -eq 0 ]; then
  echo "This invalidates the current token. The Notion connection will fail"
  echo "until you paste the new one into the agent's MCP settings."
  printf 'Rotate now? [y/N] '
  read -r reply
  case "$reply" in
    y|Y) ;;
    *) echo "Cancelled; nothing changed."; exit 0 ;;
  esac
fi

umask 077
if command -v openssl >/dev/null 2>&1; then
  openssl rand -hex 32 > "$TOKEN_FILE"
else
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

systemctl --user restart notion-cowork-bridge.service

healthy=0
attempt=0
while [ "$attempt" -lt 20 ]; do
  if curl -fsS --max-time 2 "http://127.0.0.1:$MCP_PORT/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$healthy" -eq 1 ] || {
  echo "The bridge did not come back up. Check: journalctl --user -u notion-cowork-bridge -n 50" >&2
  exit 1
}

echo "Token rotated and the bridge restarted."
echo "New token: scripts/show-token-linux.sh"
echo "Update the Custom MCP server connection in Notion now."
