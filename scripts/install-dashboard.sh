#!/usr/bin/env bash
# Installs the Spartan Cloud operator dashboard (dashboard/) as a systemd service on
# 127.0.0.1:8790 and, if chosen, publishes it at https://<this node's hostname>/panel/
# through the agent. Run from a checkout of this repository:
#
#   sudo bash scripts/install-dashboard.sh              install or update the dashboard
#   sudo bash scripts/install-dashboard.sh node-secret  set ADMIN_API_SECRET on this node only
#   sudo bash scripts/install-dashboard.sh public       serve it at https://<node hostname>/panel/
#   sudo bash scripts/install-dashboard.sh totp         set up or replace the authenticator code
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
ask_yes() { local answer; read -r -p "$1 [Y/n]: " answer </dev/tty; [[ ! "$answer" =~ ^[Nn] ]]; }

# Replaces KEY in an env file atomically, keeping every other line.
set_value() {
  local file="$1" key="$2" value="$3" quote="$4" temp
  temp="$(mktemp "$file.XXXXXX")"
  { grep -v "^$key=" "$file" 2>/dev/null || true; if [ "$quote" = quoted ]; then printf '%s="%s"\n' "$key" "$value"; else printf '%s=%s\n' "$key" "$value"; fi; } > "$temp"
  chmod 600 "$temp"
  mv -f "$temp" "$file"
}

restart_agent() {
  systemctl restart spartan-agent
  for _ in $(seq 1 30); do
    if journalctl -u spartan-agent --since '20 seconds ago' --no-pager 2>/dev/null | grep -qE 'admin_api_disabled|dashboard_proxy_disabled'; then
      printf 'The agent rejected a setting; see journalctl -u spartan-agent.\n' >&2; return 1
    fi
    # 401 without credentials means the agent is listening again; no secret on the command line.
    [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/__cloud_node_health 2>/dev/null)" = 401 ] && return 0
    sleep 1
  done
  printf 'spartan-agent did not come back; run journalctl -u spartan-agent.\n' >&2
  return 1
}

set_node_secret() {
  local secret="$1"
  [ -f "$node_env" ] || { printf '%s not found; this is not a node.\n' "$node_env" >&2; return 1; }
  [ "$secret" != "$(env_value "$node_env" ORIGIN_SECRET)" ] || { printf 'ADMIN_API_SECRET must differ from ORIGIN_SECRET.\n' >&2; return 1; }
  set_value "$node_env" ADMIN_API_SECRET "$secret" quoted
  restart_agent && printf 'Admin API enabled on this node.\n'
}

# The public URL of this node, from node.env.
node_url() {
  local region; region="$(env_value "$node_env" NODE_REGION)"
  [ "$region" = us ] && env_value "$node_env" US_ORIGIN | sed 's:/*$::'
  [ "$region" = de ] && env_value "$node_env" DE_ORIGIN | sed 's:/*$::'
  return 0
}

enable_public() {
  [ -f "$node_env" ] || { printf 'Publishing on a node hostname needs a node (%s).\n' "$node_env" >&2; return 1; }
  set_value "$dash_env" DASHBOARD_BASE_PATH /panel plain
  set_value "$node_env" DASHBOARD_PROXY_PORT "$port" quoted
  restart_agent
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

# Creates an authenticator secret, shows it as a QR code, and only saves it after
# the operator proves their app produces matching codes.
setup_totp() {
  local secret user label uri code
  secret="$(node "$repo/dashboard/server.mjs" totp-secret)"
  user="$(env_value "$dash_env" DASHBOARD_USER)"
  label="$(node_url | sed -E 's#^https?://##')"
  uri="otpauth://totp/Spartan%20Cloud:${user:-admin}%40${label:-dashboard}?secret=${secret}&issuer=Spartan%20Cloud&digits=6&period=30"
  if ! command -v qrencode >/dev/null && command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq qrencode >/dev/null 2>&1 || true
  fi
  printf '\nScan this with Google Authenticator, 1Password, Authy or similar:\n\n'
  if command -v qrencode >/dev/null; then qrencode -t ansiutf8 "$uri"; fi
  printf '\nOr enter this key manually (time-based, 6 digits):\n\n  %s\n\n' "$secret"
  while true; do
    read -r -p 'Type the 6-digit code your app shows now (blank to cancel): ' code </dev/tty
    [ -n "$code" ] || { printf 'Two-factor sign-in was not changed.\n'; return 0; }
    if printf '%s %s\n' "$secret" "$code" | node "$repo/dashboard/server.mjs" totp-check; then break; fi
    printf 'That code did not match. Check the phone clock and try the next code.\n' >&2
  done
  set_value "$dash_env" DASHBOARD_TOTP_SECRET "$secret" plain
  printf 'Two-factor sign-in enabled.\n'
}

case "${1:-install}" in
  node-secret)
    read -r -s -p 'ADMIN_API_SECRET (paste the same value used on the other node, hidden): ' secret </dev/tty; printf '\n' >&2
    valid_secret "$secret" || { printf 'Use 32 to 512 letters, digits, _ . or -.\n' >&2; exit 1; }
    set_node_secret "$secret"
    unset secret
    exit 0 ;;
  password|totp|public)
    [ -f "$dash_env" ] || { printf 'Install the dashboard first.\n' >&2; exit 1; }
    case "$1" in
      password) set_value "$dash_env" DASHBOARD_PASSWORD_HASH "$(read_password)" plain ;;
      totp) setup_totp ;;
      public) enable_public ;;
    esac
    systemctl restart spartan-dashboard
    printf 'Done. Existing sessions were signed out.\n'
    [ "$1" = public ] && printf 'Open %s/panel/\n' "$(node_url)"
    exit 0 ;;
  install) ;;
  *) printf 'Usage: install-dashboard.sh [install|node-secret|public|totp|password]\n' >&2; exit 1 ;;
esac

install -d -m 700 /etc/spartan-cloud
fresh=false
if [ -f "$dash_env" ]; then
  printf 'Keeping the existing %s. Updating the dashboard code only.\n' "$dash_env"
else
  fresh=true
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
  : > "$dash_env"; chmod 600 "$dash_env"
  for line in "ADMIN_API_SECRET=$secret" "DASHBOARD_USER=$user" "DASHBOARD_PASSWORD_HASH=$hash" "DASHBOARD_HOST=127.0.0.1" "DASHBOARD_PORT=$port"; do printf '%s\n' "$line" >> "$dash_env"; done
  [ -n "$us" ] && printf 'US_ORIGIN=%s\n' "$us" >> "$dash_env"
  [ -n "$de" ] && printf 'DE_ORIGIN=%s\n' "$de" >> "$dash_env"
  unset secret hash
fi

install -d -m 755 "$install_dir" "$install_dir/public"
install -m 644 "$repo/dashboard/server.mjs" "$install_dir/server.mjs"
rm -f "$install_dir/public/favicon.svg"
for file in index.html app.js styles.css favicon.png logo.png; do install -m 644 "$repo/dashboard/public/$file" "$install_dir/public/$file"; done
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

if [ "$fresh" = true ]; then
  public=false
  if [ -f "$node_env" ] && ask_yes "Serve the dashboard at $(node_url)/panel/?"; then enable_public; public=true; fi
  if [ "$public" = true ]; then
    printf 'The dashboard will be reachable from the internet, so a second sign-in factor is strongly recommended.\n'
    ask_yes 'Require an authenticator-app code at sign-in?' && setup_totp
  fi
fi

systemctl daemon-reload
systemctl enable spartan-dashboard >/dev/null
systemctl restart spartan-dashboard
for _ in $(seq 1 20); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null)" != 000 ] && break; sleep 0.5; done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null)" != 000 ] || { printf 'The dashboard did not start; run journalctl -u spartan-dashboard.\n' >&2; exit 1; }

if [ -n "$(env_value "$dash_env" DASHBOARD_BASE_PATH)" ]; then
  cat <<EOF

Dashboard ready at $(node_url)/panel/  (also $(node_url)/ redirects there)

Optional extra lock: in Cloudflare Zero Trust, add an Access application for
$(node_url | sed -E 's#^https?://##')/panel only. Never protect the whole node hostname; the routing
Worker and master website need /control, /admin and /tenant on it.
Logs: journalctl -u spartan-dashboard -f
EOF
else
  cat <<EOF

Dashboard running on 127.0.0.1:$port (not reachable from the internet).
Open it with an SSH tunnel:  ssh -L $port:127.0.0.1:$port root@THIS_SERVER  then http://localhost:$port
To serve it at $(node_url)/panel/ instead:  sudo bash scripts/install-dashboard.sh public
Logs: journalctl -u spartan-dashboard -f
EOF
fi
