#!/usr/bin/env bash
# Installs the Spartan Cloud operator dashboard (dashboard/) as a systemd service that
# listens on 127.0.0.1:8790. Run from a checkout of this repository on one node:
#
#   sudo bash scripts/install-dashboard.sh              install or update the dashboard
#   sudo bash scripts/install-dashboard.sh node-secret  set ADMIN_API_SECRET on this node only
#   sudo bash scripts/install-dashboard.sh password     change the dashboard password
set -euo pipefail
set +x
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
[ "$(id -u)" -eq 0 ] || { printf 'Run with sudo.\n' >&2; exit 1; }
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
node_env=/etc/spartan-cloud/node.env
dash_env=/etc/spartan-cloud/dashboard.env
install_dir=/opt/spartan-dashboard
port=8790

command -v node >/dev/null || { printf 'Node.js 20 or newer is required.\n' >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { printf 'Node.js 20 or newer is required.\n' >&2; exit 1; }
[ -f "$repo/dashboard/server.mjs" ] || { printf 'Run this from a checkout of the repository.\n' >&2; exit 1; }

# Prints KEY's value from an env file written by setup-node.mjs (KEY="value").
env_value() {
  [ -f "$1" ] || return 0
  sed -nE "s/^$2=\"?([^\"]*)\"?$/\1/p" "$1" | head -n 1
}
valid_secret() { [[ "$1" =~ ^[A-Za-z0-9_.-]{32,512}$ ]]; }

# Writes or replaces ADMIN_API_SECRET in node.env and restarts the agent.
set_node_secret() {
  local secret="$1" temp
  [ -f "$node_env" ] || { printf '%s not found; this is not a node.\n' "$node_env" >&2; return 1; }
  [ "$secret" != "$(env_value "$node_env" ORIGIN_SECRET)" ] || { printf 'ADMIN_API_SECRET must differ from ORIGIN_SECRET.\n' >&2; return 1; }
  temp="$(mktemp /etc/spartan-cloud/node.env.XXXXXX)"
  grep -v '^ADMIN_API_SECRET=' "$node_env" > "$temp" || true
  printf 'ADMIN_API_SECRET="%s"\n' "$secret" >> "$temp"
  chmod 600 "$temp"
  mv -f "$temp" "$node_env"
  systemctl restart spartan-agent
  for _ in $(seq 1 30); do
    if journalctl -u spartan-agent --since '20 seconds ago' --no-pager 2>/dev/null | grep -q admin_api_disabled; then
      printf 'The agent rejected ADMIN_API_SECRET; see journalctl -u spartan-agent.\n' >&2; return 1
    fi
    # Any HTTP answer means the agent is listening again; no credential on the command line.
    [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/ 2>/dev/null)" = 404 ] && { printf 'Admin API enabled on this node.\n'; return 0; }
    sleep 1
  done
  printf 'spartan-agent did not come back; run journalctl -u spartan-agent.\n' >&2
  return 1
}

read_password() {
  local first second
  while true; do
    read -r -s -p 'Dashboard password (12+ characters, hidden): ' first </dev/tty; printf '\n' >&2
    [ "${#first}" -ge 12 ] || { printf 'Use at least 12 characters.\n' >&2; continue; }
    read -r -s -p 'Repeat password: ' second </dev/tty; printf '\n' >&2
    [ "$first" = "$second" ] && break
    printf 'Passwords did not match.\n' >&2
  done
  printf '%s\n' "$first" | node "$repo/dashboard/server.mjs" hash-password
}

write_dash_env() {
  local temp
  temp="$(mktemp /etc/spartan-cloud/dashboard.env.XXXXXX)"
  printf '%s\n' "$@" > "$temp"
  chmod 600 "$temp"
  mv -f "$temp" "$dash_env"
}

case "${1:-install}" in
  node-secret)
    read -r -s -p 'ADMIN_API_SECRET (paste the same value used on the other node, hidden): ' secret </dev/tty; printf '\n' >&2
    valid_secret "$secret" || { printf 'Use 32 to 512 letters, digits, _ . or -.\n' >&2; exit 1; }
    set_node_secret "$secret"
    unset secret
    exit 0 ;;
  password)
    [ -f "$dash_env" ] || { printf 'Install the dashboard first.\n' >&2; exit 1; }
    hash="$(read_password)"
    mapfile -t lines < <(grep -v '^DASHBOARD_PASSWORD_HASH=' "$dash_env")
    write_dash_env "${lines[@]}" "DASHBOARD_PASSWORD_HASH=$hash"
    systemctl restart spartan-dashboard
    printf 'Password changed. Existing sessions were signed out.\n'
    exit 0 ;;
  install) ;;
  *) printf 'Usage: install-dashboard.sh [install|node-secret|password]\n' >&2; exit 1 ;;
esac

install -d -m 700 /etc/spartan-cloud
if [ -f "$dash_env" ]; then
  printf 'Keeping the existing %s. Updating the dashboard code only.\n' "$dash_env"
else
  secret="$(env_value "$node_env" ADMIN_API_SECRET)"
  if [ -z "$secret" ]; then
    printf 'The admin API needs one secret shared by both nodes and this dashboard.\n'
    read -r -s -p 'Paste ADMIN_API_SECRET from your other node, or press Enter to generate one (hidden): ' secret </dev/tty; printf '\n' >&2
    generated=false
    if [ -z "$secret" ]; then secret="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"; generated=true; fi
    valid_secret "$secret" || { printf 'Use 32 to 512 letters, digits, _ . or -.\n' >&2; exit 1; }
    if [ -f "$node_env" ]; then set_node_secret "$secret"; fi
    if [ "$generated" = true ]; then
      printf '\nNew ADMIN_API_SECRET (shown once; set the same value on your other node):\n\n  %s\n\n' "$secret"
      printf 'On the other node run:  sudo bash scripts/install-dashboard.sh node-secret\n\n'
    fi
  fi
  region="$(env_value "$node_env" NODE_REGION)"
  us="$(env_value "$node_env" US_ORIGIN)"; de="$(env_value "$node_env" DE_ORIGIN)"
  [ -n "$us" ] || read -r -p 'US node origin (https://node-us.example.com, blank for none): ' us </dev/tty
  [ -n "$de" ] || read -r -p 'Germany node origin (https://node-de.example.com, blank for none): ' de </dev/tty
  # This node's own agent is reached on loopback, skipping Cloudflare entirely.
  [ "$region" = us ] && us=http://127.0.0.1:8788
  [ "$region" = de ] && de=http://127.0.0.1:8788
  read -r -p 'Dashboard username [admin]: ' user </dev/tty
  user="${user:-admin}"
  [[ "$user" =~ ^[a-zA-Z0-9_.@-]{1,64}$ ]] || { printf 'Use letters, digits, _ . @ or -.\n' >&2; exit 1; }
  hash="$(read_password)"
  lines=("ADMIN_API_SECRET=$secret" "DASHBOARD_USER=$user" "DASHBOARD_PASSWORD_HASH=$hash" "DASHBOARD_HOST=127.0.0.1" "DASHBOARD_PORT=$port")
  [ -n "$us" ] && lines+=("US_ORIGIN=$us")
  [ -n "$de" ] && lines+=("DE_ORIGIN=$de")
  write_dash_env "${lines[@]}"
  unset secret hash
fi

install -d -m 755 "$install_dir" "$install_dir/public"
install -m 644 "$repo/dashboard/server.mjs" "$install_dir/server.mjs"
for file in index.html app.js styles.css favicon.svg; do install -m 644 "$repo/dashboard/public/$file" "$install_dir/public/$file"; done
node_path="$(command -v node)"
cat > /etc/systemd/system/spartan-dashboard.service <<EOF
[Unit]
Description=Spartan Cloud operator dashboard
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
EnvironmentFile=$dash_env
ExecStart=$node_path $install_dir/server.mjs
Restart=always
RestartSec=3
DynamicUser=yes
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
[Install]
WantedBy=multi-user.target
EOF
chmod 644 /etc/systemd/system/spartan-dashboard.service
systemctl daemon-reload
systemctl enable spartan-dashboard >/dev/null
systemctl restart spartan-dashboard
for _ in $(seq 1 20); do curl -fsS -o /dev/null "http://127.0.0.1:$port/api/session" 2>/dev/null && break; sleep 0.5; done
curl -fsS -o /dev/null "http://127.0.0.1:$port/api/session" || { printf 'The dashboard did not start; run journalctl -u spartan-dashboard.\n' >&2; exit 1; }
cat <<EOF
Dashboard running on 127.0.0.1:$port (not reachable from the internet).

Open it with an SSH tunnel from your computer:
  ssh -L $port:127.0.0.1:$port root@THIS_SERVER   then visit http://localhost:$port

Or publish it on this node's Cloudflare Tunnel (for example panel.yourdomain.com
-> http://127.0.0.1:$port) and protect that hostname with a Cloudflare Access policy.
Never put Access on the node-us/node-de hostnames themselves.
Logs: journalctl -u spartan-dashboard -f
EOF
