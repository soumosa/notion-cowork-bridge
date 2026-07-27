#!/usr/bin/env bash
set -euo pipefail

purge=0
if [ "${1:-}" = "--purge" ]; then
  purge=1
elif [ $# -gt 0 ]; then
  echo "Usage: $(basename "$0") [--purge]" >&2
  exit 2
fi

runtime_root="$HOME/.local/share/notion-cowork-bridge"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/notion-cowork-bridge"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/notion-cowork-bridge"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

systemctl --user disable --now notion-cowork-bridge-tunnel.service >/dev/null 2>&1 || true
systemctl --user disable --now notion-cowork-bridge.service >/dev/null 2>&1 || true
rm -f \
  "$unit_dir/notion-cowork-bridge.service" \
  "$unit_dir/notion-cowork-bridge-tunnel.service"
systemctl --user daemon-reload >/dev/null 2>&1 || true
echo "Stopped and removed the bridge user services."

if [ "$purge" -eq 1 ]; then
  [ "$runtime_root" = "$HOME/.local/share/notion-cowork-bridge" ] || exit 1
  rm -rf "$runtime_root" "$config_dir" "$state_dir"
  echo "Purged the installed runtime, configuration, token, and audit log."
fi

echo "The workspace itself was not deleted."
