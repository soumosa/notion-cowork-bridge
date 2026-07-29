#!/bin/zsh
set -euo pipefail

# Captured here because $0 inside a function expands to the function name.
script_name="${0:t}"

usage() {
  print "Usage: $script_name [--force]"
  print
  print "Replaces the bearer token in the Keychain and restarts the bridge."
  print "The old token stops working immediately, so update the connection in"
  print "Notion afterwards."
  print
  print "Options:"
  print "  --force      Skip the confirmation prompt"
  print "  -h, --help   Show this help"
}

force=0
case "${1:-}" in
  --force) force=1 ;;
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) print -u2 "Unknown option: $1"; usage >&2; exit 2 ;;
esac

config_file="${NOTION_COWORK_CONFIG:-$HOME/.config/notion-cowork-bridge/bridge.env}"
if [[ ! -r "$config_file" ]]; then
  print -u2 "Missing bridge configuration: $config_file"
  print -u2 "Run scripts/install-macos.sh first."
  exit 1
fi

source "$config_file"
security_bin="$(command -v security || print -r -- /usr/bin/security)"
launchctl_bin="$(command -v launchctl || print -r -- /bin/launchctl)"

if (( ! force )); then
  print "This invalidates the current token. The Notion connection will fail"
  print "until you paste the new one into the agent's MCP settings."
  print -n "Rotate now? [y/N] "
  read -r reply
  [[ "$reply" == [yY] ]] || { print "Cancelled; nothing changed."; exit 0; }
fi

new_token="$(/usr/bin/openssl rand -hex 32)"
"$security_bin" add-generic-password \
  -a "$KEYCHAIN_ACCOUNT" \
  -s "$KEYCHAIN_SERVICE" \
  -w "$new_token" \
  -U \
  >/dev/null

new_created_at="$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
if /usr/bin/grep -q '^TOKEN_CREATED_AT=' "$config_file"; then
  /usr/bin/sed -i '' "s/^TOKEN_CREATED_AT=.*/TOKEN_CREATED_AT=$new_created_at/" "$config_file"
else
  print -r -- "TOKEN_CREATED_AT=$new_created_at" >> "$config_file"
fi
/bin/chmod 0600 "$config_file"

"$launchctl_bin" kickstart -k \
  "gui/$(/usr/bin/id -u)/com.notion-cowork-bridge.mcp" \
  >/dev/null 2>&1 || {
  print -u2 "Stored the new token, but the bridge service was not running."
  print -u2 "Start it with: launchctl bootstrap \"gui/\$(id -u)\" \\"
  print -u2 "  \"\$HOME/Library/LaunchAgents/com.notion-cowork-bridge.mcp.plist\""
  exit 1
}

healthy=0
for _attempt in {1..20}; do
  if /usr/bin/curl -fsS --max-time 2 \
    "http://127.0.0.1:$MCP_PORT/health" \
    >/dev/null 2>&1; then
    healthy=1
    break
  fi
  /bin/sleep 1
done
(( healthy )) || {
  print -u2 "The bridge did not come back up. Check"
  print -u2 "$HOME/Library/Logs/notion-cowork-bridge/bridge.log"
  exit 1
}

print "Token rotated and the bridge restarted."
print "New token: scripts/show-token-macos.sh"
print "Update the Custom MCP server connection in Notion now."
