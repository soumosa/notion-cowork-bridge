#!/bin/zsh
set -euo pipefail

config_file="${NOTION_COWORK_CONFIG:-$HOME/.config/notion-cowork-bridge/bridge.env}"
if [[ ! -r "$config_file" ]]; then
  print -u2 "Missing bridge configuration: $config_file"
  exit 1
fi

source "$config_file"
security_bin="$(command -v security || print -r -- /usr/bin/security)"
"$security_bin" find-generic-password \
  -a "$KEYCHAIN_ACCOUNT" \
  -s "$KEYCHAIN_SERVICE" \
  -w
