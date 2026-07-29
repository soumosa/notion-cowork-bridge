#!/usr/bin/env bash
set -euo pipefail

# Captured here because $0 inside a function expands to the function name in
# some shells.
script_name="$(basename "$0")"

usage() {
  echo "Usage: $script_name --host <assigned-domain.ngrok-free.dev> [options]"
  echo
  echo "Options:"
  echo "  --workspace <absolute-path>  Workspace exposed to file tools"
  echo "                               (default: \$HOME/notion-workspace)"
  echo "  --port <1-65535>             Local MCP port (default: 3210)"
  echo "  --traffic-policy-file <path> ngrok traffic policy file for the tunnel"
  echo "                               (default: \$NGROK_TRAFFIC_POLICY_FILE if set)"
  echo "  --dry-run                    Validate and print the plan, change nothing"
  echo "  -h, --help                   Show this help"
}

workspace_root="$HOME/notion-workspace"
public_host=""
mcp_port="3210"
traffic_policy_file="${NGROK_TRAFFIC_POLICY_FILE:-}"
dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace)
      [ $# -ge 2 ] || { echo "Missing value for --workspace" >&2; exit 2; }
      workspace_root="$2"; shift 2 ;;
    --host)
      [ $# -ge 2 ] || { echo "Missing value for --host" >&2; exit 2; }
      public_host="$2"; shift 2 ;;
    --port)
      [ $# -ge 2 ] || { echo "Missing value for --port" >&2; exit 2; }
      mcp_port="$2"; shift 2 ;;
    --traffic-policy-file)
      [ $# -ge 2 ] || { echo "Missing value for --traffic-policy-file" >&2; exit 2; }
      traffic_policy_file="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || {
  echo "This installer is for Linux. On macOS use scripts/install-macos.sh." >&2
  exit 1
}
[ -n "$public_host" ] || {
  echo "--host is required. Use the development domain assigned to your ngrok account." >&2
  exit 2
}

public_host="${public_host#https://}"
public_host="${public_host#http://}"
public_host="${public_host%/mcp}"
public_host="${public_host%/}"

echo "$public_host" | grep -Eq \
  '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' || {
  echo "Invalid public hostname: $public_host" >&2
  exit 2
}
case "$workspace_root" in
  /*) ;;
  *) echo "--workspace must be an absolute path." >&2; exit 2 ;;
esac
case "$mcp_port" in
  ''|*[!0-9]*) echo "--port must be an integer from 1 to 65535." >&2; exit 2 ;;
  *) [ "$mcp_port" -ge 1 ] && [ "$mcp_port" -le 65535 ] || {
       echo "--port must be an integer from 1 to 65535." >&2; exit 2; } ;;
esac
if [ -n "$traffic_policy_file" ] && [ ! -r "$traffic_policy_file" ]; then
  echo "Traffic policy file is not readable: $traffic_policy_file" >&2
  exit 2
fi

node_bin="$(command -v node || true)"
npm_bin="$(command -v npm || true)"
ngrok_bin="$(command -v ngrok || true)"
[ -x "$node_bin" ] || { echo "Node.js 20 or newer is required." >&2; exit 1; }
[ -x "$npm_bin" ] || { echo "npm is required." >&2; exit 1; }
[ -x "$ngrok_bin" ] || {
  echo "ngrok is required. Install it and run: ngrok config add-authtoken <token>" >&2
  exit 1
}
command -v systemctl >/dev/null 2>&1 || {
  echo "systemd is required; this installer registers user services." >&2
  exit 1
}

node_major="$("$node_bin" -p 'Number(process.versions.node.split(".")[0])')"
[ "$node_major" -ge 20 ] || {
  echo "Node.js 20 or newer is required; found $("$node_bin" --version)." >&2
  exit 1
}

repo_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
runtime_root="$HOME/.local/share/notion-cowork-bridge"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/notion-cowork-bridge"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/notion-cowork-bridge"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
config_file="$config_dir/bridge.env"
token_file="$config_dir/token"

echo "Repository: $repo_root"
echo "Workspace: $workspace_root"
echo "Public MCP URL: https://$public_host/mcp"
echo "Node: $node_bin"
echo "ngrok: $ngrok_bin"
echo "Token file: $token_file (0600)"

if [ "$dry_run" -eq 1 ]; then
  echo "Dry run complete; no files or services were changed."
  exit 0
fi

"$ngrok_bin" config check >/dev/null

mkdir -p \
  "$workspace_root" \
  "$runtime_root/scripts" \
  "$config_dir" \
  "$state_dir" \
  "$unit_dir"
chmod 700 "$config_dir"

install -m 0644 "$repo_root/package.json" "$runtime_root/package.json"
install -m 0644 "$repo_root/package-lock.json" "$runtime_root/package-lock.json"
rm -rf "$runtime_root/src"
cp -R "$repo_root/src" "$runtime_root/src"
find "$runtime_root/src" -type d -exec chmod 0755 {} +
find "$runtime_root/src" -type f -exec chmod 0644 {} +
install -m 0755 "$repo_root/scripts/start-bridge-linux.sh" \
  "$runtime_root/scripts/start-bridge-linux.sh"

( cd "$runtime_root" && "$npm_bin" ci --omit=dev --ignore-scripts )

# Preserve token age across a re-run of this installer; only a freshly
# created token resets the clock.
token_created_at=""
preview_url=""
if [ -r "$config_file" ]; then
  # shellcheck disable=SC1090
  token_created_at="$(. "$config_file" 2>/dev/null; echo "${TOKEN_CREATED_AT:-}")"
  # shellcheck disable=SC1090
  preview_url="$(. "$config_file" 2>/dev/null; echo "${MCP_NGROK_PREVIEW_URL:-}")"
fi

# Linux has no equivalent of the macOS Keychain that a user service can rely
# on: a desktop keyring is often locked when the service starts. A 0600 file
# owned by this user is the honest, reliable choice here.
if [ ! -s "$token_file" ]; then
  umask 077
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$token_file"
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$token_file"
  fi
  chmod 600 "$token_file"
  token_created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

umask 077
cat > "$config_file" <<EOF
NODE_BIN=$node_bin
NGROK_BIN=$ngrok_bin
RUNTIME_ROOT=$runtime_root
TOKEN_FILE=$token_file
TOKEN_CREATED_AT=$token_created_at
MCP_WORKSPACE_ROOT=$workspace_root
MCP_ALLOWED_HOSTS=$public_host
MCP_PORT=$mcp_port
MCP_AUDIT_LOG=$state_dir/audit.jsonl
MCP_NGROK_PREVIEW_URL=$preview_url
EOF
chmod 600 "$config_file"

cat > "$unit_dir/notion-cowork-bridge.service" <<EOF
[Unit]
Description=Notion Cowork Bridge MCP server
After=network-online.target

[Service]
Type=simple
Environment=NODE_ENV=production
ExecStart=$runtime_root/scripts/start-bridge-linux.sh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

tunnel_exec_start="$ngrok_bin http $mcp_port --url https://$public_host --log stdout"
if [ -n "$traffic_policy_file" ]; then
  tunnel_exec_start="$tunnel_exec_start --traffic-policy-file $traffic_policy_file"
fi

cat > "$unit_dir/notion-cowork-bridge-tunnel.service" <<EOF
[Unit]
Description=Notion Cowork Bridge ngrok tunnel
After=notion-cowork-bridge.service
Wants=notion-cowork-bridge.service

[Service]
Type=simple
ExecStart=$tunnel_exec_start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

# Without lingering, user services stop the moment you log out.
loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || \
  echo "Could not enable lingering; services will stop when you log out." >&2

systemctl --user daemon-reload
systemctl --user enable --now notion-cowork-bridge.service
systemctl --user enable --now notion-cowork-bridge-tunnel.service

healthy=0
attempt=0
while [ "$attempt" -lt 20 ]; do
  if curl -fsS --max-time 2 "http://127.0.0.1:$mcp_port/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$healthy" -eq 1 ] || {
  echo "The bridge did not become healthy. Check: journalctl --user -u notion-cowork-bridge -n 50" >&2
  exit 1
}

echo
echo "Installed successfully."
echo "MCP URL: https://$public_host/mcp"
echo "Workspace: $workspace_root"
echo "Audit log: $state_dir/audit.jsonl"
echo "Token: $repo_root/scripts/show-token-linux.sh"
echo "Health check: $repo_root/scripts/doctor-linux.sh"
