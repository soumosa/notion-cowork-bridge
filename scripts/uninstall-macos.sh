#!/bin/zsh
set -euo pipefail

purge=0
if [[ "${1:-}" == "--purge" ]]; then
  purge=1
elif (( $# > 0 )); then
  print -u2 "Usage: $0 [--purge]"
  exit 2
fi

uid_value="$(/usr/bin/id -u)"
bridge_plist="$HOME/Library/LaunchAgents/com.notion-cowork-bridge.mcp.plist"
tunnel_plist="$HOME/Library/LaunchAgents/com.notion-cowork-bridge.tunnel.plist"
runtime_root="$HOME/.local/share/notion-cowork-bridge"
config_dir="$HOME/.config/notion-cowork-bridge"
log_dir="$HOME/Library/Logs/notion-cowork-bridge"
keychain_service="dev.notion-cowork-bridge.mcp"
keychain_account="$(/usr/bin/id -un)"

/bin/launchctl bootout \
  "gui/$uid_value/com.notion-cowork-bridge.mcp" \
  >/dev/null 2>&1 || true
/bin/launchctl bootout \
  "gui/$uid_value/com.notion-cowork-bridge.tunnel" \
  >/dev/null 2>&1 || true

/bin/rm -f "$bridge_plist" "$tunnel_plist"
print "Stopped and removed the bridge launch services."

if (( purge )); then
  [[ "$runtime_root" == "$HOME/.local/share/notion-cowork-bridge" ]]
  [[ "$config_dir" == "$HOME/.config/notion-cowork-bridge" ]]
  [[ "$log_dir" == "$HOME/Library/Logs/notion-cowork-bridge" ]]
  /usr/bin/security delete-generic-password \
    -a "$keychain_account" \
    -s "$keychain_service" \
    >/dev/null 2>&1 || true
  /bin/rm -rf "$runtime_root" "$config_dir" "$log_dir"
  print "Purged the installed runtime, configuration, logs, and Keychain token."
fi

print "The workspace itself was not deleted."
