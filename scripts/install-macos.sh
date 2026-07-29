#!/bin/zsh
set -euo pipefail

# Captured here because $0 inside a function expands to the function name.
script_name="${0:t}"

usage() {
  print "Usage: $script_name --host <assigned-domain.ngrok-free.dev> [options]"
  print
  print "Options:"
  print "  --workspace <absolute-path>  Workspace exposed to file tools"
  print "                               (default: \$HOME/Desktop/notion-workspace)"
  print "  --port <1-65535>             Local MCP port (default: 3210)"
  print "  --traffic-policy-file <path> ngrok traffic policy file for the tunnel"
  print "                               (default: \$NGROK_TRAFFIC_POLICY_FILE if set)"
  print "  --migrate-legacy            Replace the old notion-local-mcp services"
  print "  --dry-run                    Validate and print the plan without changing anything"
  print "  -h, --help                   Show this help"
}

workspace_root="$HOME/Desktop/notion-workspace"
public_host=""
mcp_port="3210"
traffic_policy_file="${NGROK_TRAFFIC_POLICY_FILE:-}"
dry_run=0
migrate_legacy=0

while (( $# > 0 )); do
  case "$1" in
    --workspace)
      (( $# >= 2 )) || { print -u2 "Missing value for --workspace"; exit 2; }
      workspace_root="$2"
      shift 2
      ;;
    --host)
      (( $# >= 2 )) || { print -u2 "Missing value for --host"; exit 2; }
      public_host="$2"
      shift 2
      ;;
    --port)
      (( $# >= 2 )) || { print -u2 "Missing value for --port"; exit 2; }
      mcp_port="$2"
      shift 2
      ;;
    --traffic-policy-file)
      (( $# >= 2 )) || { print -u2 "Missing value for --traffic-policy-file"; exit 2; }
      traffic_policy_file="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --migrate-legacy)
      migrate_legacy=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      print -u2 "Unknown option: $1"
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$(/usr/bin/uname -s)" == "Darwin" ]] || {
  print -u2 "This installer currently supports macOS only."
  exit 1
}
[[ -n "$public_host" ]] || {
  print -u2 "--host is required. Use the development domain assigned to your ngrok account."
  exit 2
}

public_host="${public_host#https://}"
public_host="${public_host#http://}"
public_host="${public_host%/mcp}"
public_host="${public_host%/}"

print -r -- "$public_host" | /usr/bin/grep -Eq \
  '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$' || {
  print -u2 "Invalid public hostname: $public_host"
  exit 2
}
[[ "$workspace_root" == /* ]] || {
  print -u2 "--workspace must be an absolute path."
  exit 2
}
[[ "$mcp_port" == <1-65535> ]] || {
  print -u2 "--port must be an integer from 1 to 65535."
  exit 2
}
[[ -z "$traffic_policy_file" || -r "$traffic_policy_file" ]] || {
  print -u2 "Traffic policy file is not readable: $traffic_policy_file"
  exit 2
}

node_bin="$(command -v node || true)"
npm_bin="$(command -v npm || true)"
ngrok_bin="$(command -v ngrok || true)"
# Resolved the same way as the binaries above (rather than hardcoded) so a
# test harness can put stand-ins earlier on PATH; command -v still lands on
# the real /usr/bin/security and /bin/launchctl on a normal machine.
security_bin="$(command -v security || print -r -- /usr/bin/security)"
launchctl_bin="$(command -v launchctl || print -r -- /bin/launchctl)"
[[ -x "$node_bin" ]] || {
  print -u2 "Node.js 20 or newer is required."
  exit 1
}
[[ -x "$npm_bin" ]] || {
  print -u2 "npm is required."
  exit 1
}
[[ -x "$ngrok_bin" ]] || {
  print -u2 "ngrok is required. Install it and run: ngrok config add-authtoken <token>"
  exit 1
}

node_major="$("$node_bin" -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 20 )) || {
  print -u2 "Node.js 20 or newer is required; found $("$node_bin" --version)."
  exit 1
}

repo_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
runtime_root="$HOME/.local/share/notion-cowork-bridge"
config_dir="$HOME/.config/notion-cowork-bridge"
log_dir="$HOME/Library/Logs/notion-cowork-bridge"
launch_agent_dir="$HOME/Library/LaunchAgents"
config_file="$config_dir/bridge.env"
bridge_plist="$launch_agent_dir/com.notion-cowork-bridge.mcp.plist"
tunnel_plist="$launch_agent_dir/com.notion-cowork-bridge.tunnel.plist"
legacy_bridge_plist="$launch_agent_dir/com.abcom.notion-mcp.bridge.plist"
legacy_gateway_plist="$launch_agent_dir/com.abcom.notion-mcp.gateway.plist"
legacy_tunnel_plist="$launch_agent_dir/com.abcom.webterm.ngrok.plist"
keychain_service="dev.notion-cowork-bridge.mcp"
legacy_keychain_service="com.openai.codex.notion-local-mcp.notionDirect"
keychain_account="$(/usr/bin/id -un)"
uid_value="$(/usr/bin/id -u)"
command_shell="${SHELL:-/bin/zsh}"
bridge_path="$PATH"

print "Repository: $repo_root"
print "Workspace: $workspace_root"
print "Public MCP URL: https://$public_host/mcp"
print "Node: $node_bin"
print "ngrok: $ngrok_bin"

legacy_detected=0
[[ -e "$legacy_bridge_plist" || -e "$legacy_gateway_plist" || -e "$legacy_tunnel_plist" ]] && legacy_detected=1
if (( legacy_detected && ! migrate_legacy )); then
  print -u2 "Legacy notion-local-mcp services were found. Re-run with --migrate-legacy to avoid duplicate bridges."
  exit 2
fi

if (( dry_run )); then
  print "Dry run complete; no files or services were changed."
  exit 0
fi

"$ngrok_bin" config check >/dev/null

/bin/mkdir -p \
  "$workspace_root" \
  "$runtime_root/scripts" \
  "$config_dir" \
  "$log_dir" \
  "$launch_agent_dir"

/usr/bin/install -m 0644 "$repo_root/package.json" "$runtime_root/package.json"
/usr/bin/install -m 0644 "$repo_root/package-lock.json" "$runtime_root/package-lock.json"
/bin/rm -rf "$runtime_root/src"
/bin/cp -R "$repo_root/src" "$runtime_root/src"
/usr/bin/find "$runtime_root/src" -type d -exec /bin/chmod 0755 {} +
/usr/bin/find "$runtime_root/src" -type f -exec /bin/chmod 0644 {} +
/usr/bin/install -m 0755 \
  "$repo_root/scripts/start-bridge-macos.sh" \
  "$runtime_root/scripts/start-bridge-macos.sh"

(
  cd "$runtime_root"
  "$npm_bin" ci --omit=dev --ignore-scripts
)

# Preserve token age across a re-run of this installer; only a freshly
# created token resets the clock.
token_created_at=""
if [[ -r "$config_file" ]]; then
  token_created_at="$(source "$config_file" 2>/dev/null; print -r -- "${TOKEN_CREATED_AT:-}")"
fi

if ! "$security_bin" find-generic-password \
  -a "$keychain_account" \
  -s "$keychain_service" \
  >/dev/null 2>&1; then
  auth_token=""
  if (( migrate_legacy )); then
    auth_token="$("$security_bin" find-generic-password \
      -a "$keychain_account" \
      -s "$legacy_keychain_service" \
      -w 2>/dev/null || true)"
  fi
  [[ -n "$auth_token" ]] || auth_token="$(/usr/bin/openssl rand -hex 32)"
  "$security_bin" add-generic-password \
    -a "$keychain_account" \
    -s "$keychain_service" \
    -w "$auth_token" \
    -U \
    >/dev/null
  token_created_at="$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

{
  printf 'NODE_BIN=%q\n' "$node_bin"
  printf 'NGROK_BIN=%q\n' "$ngrok_bin"
  printf 'RUNTIME_ROOT=%q\n' "$runtime_root"
  printf 'BRIDGE_PATH=%q\n' "$bridge_path"
  printf 'COMMAND_SHELL=%q\n' "$command_shell"
  printf 'KEYCHAIN_ACCOUNT=%q\n' "$keychain_account"
  printf 'KEYCHAIN_SERVICE=%q\n' "$keychain_service"
  printf 'TOKEN_CREATED_AT=%q\n' "$token_created_at"
  printf 'MCP_WORKSPACE_ROOT=%q\n' "$workspace_root"
  printf 'MCP_ALLOWED_HOSTS=%q\n' "$public_host"
  printf 'MCP_PORT=%q\n' "$mcp_port"
  printf 'MCP_AUDIT_LOG=%q\n' "$log_dir/audit.jsonl"
} > "$config_file"
/bin/chmod 0600 "$config_file"

xml_escape() {
  print -rn -- "$1" |
    /usr/bin/sed \
      -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g' \
      -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' \
      -e "s/'/\&apos;/g"
}

escaped_start_script="$(xml_escape "$runtime_root/scripts/start-bridge-macos.sh")"
escaped_ngrok="$(xml_escape "$ngrok_bin")"
escaped_port="$(xml_escape "$mcp_port")"
escaped_url="$(xml_escape "https://$public_host")"
escaped_log_dir="$(xml_escape "$log_dir")"

{
  print '<?xml version="1.0" encoding="UTF-8"?>'
  print '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'
  print '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  print '<plist version="1.0"><dict>'
  print '  <key>Label</key><string>com.notion-cowork-bridge.mcp</string>'
  print '  <key>ProgramArguments</key><array>'
  print "    <string>$escaped_start_script</string>"
  print '  </array>'
  print '  <key>EnvironmentVariables</key><dict>'
  print '    <key>NODE_ENV</key><string>production</string>'
  print '  </dict>'
  print '  <key>RunAtLoad</key><true/>'
  print '  <key>KeepAlive</key><true/>'
  print "  <key>StandardOutPath</key><string>$escaped_log_dir/bridge.log</string>"
  print "  <key>StandardErrorPath</key><string>$escaped_log_dir/bridge.log</string>"
  print '</dict></plist>'
} > "$bridge_plist"

{
  print '<?xml version="1.0" encoding="UTF-8"?>'
  print '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'
  print '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  print '<plist version="1.0"><dict>'
  print '  <key>Label</key><string>com.notion-cowork-bridge.tunnel</string>'
  print '  <key>ProgramArguments</key><array>'
  print "    <string>$escaped_ngrok</string>"
  print '    <string>http</string>'
  print "    <string>$escaped_port</string>"
  print '    <string>--url</string>'
  print "    <string>$escaped_url</string>"
  if [[ -n "$traffic_policy_file" ]]; then
    print '    <string>--traffic-policy-file</string>'
    print "    <string>$(xml_escape "$traffic_policy_file")</string>"
  fi
  print '  </array>'
  print '  <key>RunAtLoad</key><true/>'
  print '  <key>KeepAlive</key><true/>'
  print "  <key>StandardOutPath</key><string>$escaped_log_dir/tunnel.log</string>"
  print "  <key>StandardErrorPath</key><string>$escaped_log_dir/tunnel.log</string>"
  print '</dict></plist>'
} > "$tunnel_plist"

/bin/chmod 0644 "$bridge_plist" "$tunnel_plist"
/usr/bin/plutil -lint "$bridge_plist" "$tunnel_plist"

"$launchctl_bin" bootout \
  "gui/$uid_value/com.notion-cowork-bridge.mcp" \
  >/dev/null 2>&1 || true
"$launchctl_bin" bootout \
  "gui/$uid_value/com.notion-cowork-bridge.tunnel" \
  >/dev/null 2>&1 || true
if (( migrate_legacy )); then
  "$launchctl_bin" bootout "gui/$uid_value/com.abcom.webterm.ngrok" >/dev/null 2>&1 || true
  "$launchctl_bin" bootout "gui/$uid_value/com.abcom.notion-mcp.gateway" >/dev/null 2>&1 || true
  "$launchctl_bin" bootout "gui/$uid_value/com.abcom.notion-mcp.bridge" >/dev/null 2>&1 || true
fi
"$launchctl_bin" bootstrap "gui/$uid_value" "$bridge_plist"
"$launchctl_bin" bootstrap "gui/$uid_value" "$tunnel_plist"

healthy=0
for _attempt in {1..20}; do
  if /usr/bin/curl -fsS --max-time 2 \
    "http://127.0.0.1:$mcp_port/health" \
    >/dev/null 2>&1; then
    healthy=1
    break
  fi
  /bin/sleep 1
done
(( healthy )) || {
  print -u2 "The bridge did not become healthy. Check $log_dir/bridge.log"
  exit 1
}

print
print "Installed successfully."
print "MCP URL: https://$public_host/mcp"
print "Workspace: $workspace_root"
print "Token: $repo_root/scripts/show-token-macos.sh"
print "Health check: $repo_root/scripts/doctor-macos.sh"
