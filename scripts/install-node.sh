#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
[ "$(id -u)" -eq 0 ] || { printf 'Run with sudo.\n' >&2; exit 1; }
invocation_dir="$(pwd)"
cd "$(dirname "$0")/.."
location="${1:-}"
case "$location" in us|de) ;; *) printf 'Usage: sudo bash scripts/install-node.sh us|de [--env FILE] [--token FILE] [--non-interactive] [--skip-dependencies]\n' >&2; exit 1 ;; esac
shift
setup_args=()
skip_dependencies=false
skip_db_network=false
peer_ip=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-dependencies) skip_dependencies=true; shift ;;
    --skip-db-network) skip_db_network=true; shift ;;
    --peer-ip) [ "$#" -ge 2 ] || exit 1; peer_ip="$2"; shift 2 ;;
    --non-interactive) setup_args+=("$1"); shift ;;
    --env|--token)
      [ "$#" -ge 2 ] || exit 1
      input_file="$2"
      if [[ "$input_file" != /* ]]; then input_file="$invocation_dir/$input_file"; fi
      setup_args+=("$1" "$input_file")
      shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
if [ "$skip_db_network" = false ] && [ -z "$peer_ip" ] && [[ " ${setup_args[*]} " == *" --non-interactive "* ]] && [ ! -f /etc/spartan-cloud/database-network.json ] && ! grep -qs '^DATABASE_MODE="us-central"$' /etc/spartan-cloud/node.env; then
  printf 'Automatic database setup requires --peer-ip ADDRESS in non-interactive mode, or --skip-db-network.\n' >&2
  exit 1
fi
[ -d /run/systemd/system ] || { printf 'A systemd host is required.\n' >&2; exit 1; }
command -v flock >/dev/null || { apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y util-linux; }
exec 9>/run/spartan-install.lock
flock -n 9 || { printf 'Another node installation is running.\n' >&2; exit 1; }
if [ "$skip_dependencies" = false ]; then bash scripts/install-dependencies.sh; fi
printf 'Dependencies ready. Checking Docker daemon (30-second timeout).\n'
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
timeout 30s docker info >/dev/null || { printf 'Docker daemon readiness check failed or timed out. Check: sudo systemctl status docker\n' >&2; exit 1; }
command -v cloudflared >/dev/null
command -v mysqldump >/dev/null
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
printf 'Configuring %s node. Missing settings will be prompted below.\n' "$location"
interactive_setup=true
for setup_arg in "${setup_args[@]}"; do
  if [ "$setup_arg" = --non-interactive ]; then interactive_setup=false; fi
done
if [ "$interactive_setup" = true ] && [ -t 1 ] && [ -r /dev/tty ]; then
  node scripts/setup-node.mjs "$location" "${setup_args[@]}" --output "$staging" </dev/tty
else
  node scripts/setup-node.mjs "$location" "${setup_args[@]}" --output "$staging"
fi
image="$(cat "$staging/image")"
printf 'Checking Spartan image availability.\n'
export DOCKER_CONFIG=/etc/spartan-cloud/docker
install -d -m 700 "$DOCKER_CONFIG"
if [[ ! -e "$DOCKER_CONFIG/config.json" && -f /root/.docker/config.json && ! -L /root/.docker/config.json ]]; then
  install -m 600 /root/.docker/config.json "$DOCKER_CONFIG/config.json"
fi
docker pull "$image" || { printf 'Image pull failed. For private images run sudo docker --config /etc/spartan-cloud/docker login REGISTRY, then retry.\n' >&2; exit 1; }
install -d -m 700 /etc/spartan-cloud /srv/spartan-cloud /srv/spartan-backups
# Tenant containers reach MariaDB over its unix socket only, so it never listens on a
# public interface. Each Octane worker, queue worker and scheduler holds a connection,
# so the default 151 is far too low for a full node; MAX_USER_CONNECTIONS caps each tenant.
install -d -m 755 /etc/mysql/mariadb.conf.d
central_de=false
if node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8");process.exit(/^DATABASE_MODE="us-central"$/m.test(s)&&/^NODE_REGION="de"$/m.test(s)?0:1)' "$staging/node.env"; then central_de=true; fi
if [ "$central_de" = false ]; then
if ! node -e 'const fs=require("fs");process.exit(/^DATABASE_MODE="us-central"$/m.test(fs.readFileSync(process.argv[1],"utf8"))?0:1)' "$staging/node.env"; then
cat > /etc/mysql/mariadb.conf.d/99-spartan.cnf <<'CNF'
[mysqld]
bind-address = 127.0.0.1
max_connections = 500
CNF
chmod 644 /etc/mysql/mariadb.conf.d/99-spartan.cnf
fi
systemctl enable mariadb
systemctl restart mariadb
mysqladmin --protocol=socket -uroot ping
else
systemctl mask --now mariadb
fi
install -d -m 755 /opt/spartan-cloud
if [ -f /etc/spartan-cloud/node.env ]; then
  install -d -m 700 /etc/spartan-cloud/history
  previous="$(mktemp -d /etc/spartan-cloud/history/install.XXXXXXXX)"
  install -m 600 /etc/spartan-cloud/node.env "$previous/node.env"
  if [ -f /etc/spartan-cloud/tunnel-token ]; then install -m 600 /etc/spartan-cloud/tunnel-token "$previous/tunnel-token"; fi
fi
install -m 600 "$staging/node.env" /etc/spartan-cloud/node.env
install -m 600 "$staging/tunnel-token" /etc/spartan-cloud/tunnel-token
if [ ! -s /etc/spartan-cloud/laravel-env.json ]; then printf '{}\n' > /etc/spartan-cloud/laravel-env.json; fi
chmod 600 /etc/spartan-cloud/laravel-env.json
for module in node/*.mjs; do install -m 644 "$module" "/opt/spartan-cloud/$(basename "$module")"; done
install -m 755 scripts/backup.sh /opt/spartan-cloud/backup.sh
install -m 755 scripts/setup-db-network.py /opt/spartan-cloud/setup-db-network.py
cat > /usr/local/bin/spartan-db-network <<'NETWORK'
#!/usr/bin/env bash
set -euo pipefail
set +x
exec python3 /opt/spartan-cloud/setup-db-network.py "$@"
NETWORK
chmod 755 /usr/local/bin/spartan-db-network
node /opt/spartan-cloud/backup-crypto.mjs init
SPARTAN_INSTALL_LOCK_HELD=1 bash scripts/install-node-updates.sh
node_path="$(command -v node)"
cloudflared_path="$(command -v cloudflared)"
cat > /etc/systemd/system/spartan-agent.service <<EOF
[Unit]
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service
[Service]
Type=simple
EnvironmentFile=/etc/spartan-cloud/node.env
Environment=DOCKER_CONFIG=/etc/spartan-cloud/docker
ExecStart=$node_path /opt/spartan-cloud/agent.mjs
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
TimeoutStopSec=150
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/spartan-tunnel.service <<EOF
[Unit]
After=network-online.target spartan-agent.service
Wants=network-online.target
[Service]
Type=simple
ExecStart=$cloudflared_path tunnel --metrics 127.0.0.1:8789 --no-autoupdate run --token-file /etc/spartan-cloud/tunnel-token
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/spartan-backup.service <<'EOF'
[Unit]
After=docker.service
[Service]
Type=oneshot
EnvironmentFile=/etc/spartan-cloud/node.env
ExecStart=/opt/spartan-cloud/backup.sh
UMask=0077
EOF
cat > /etc/systemd/system/spartan-backup.timer <<'EOF'
[Unit]
[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=120
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable spartan-agent spartan-tunnel
systemctl restart spartan-agent spartan-tunnel
if [ "$central_de" = false ]; then
systemctl enable --now spartan-backup.timer
else
systemctl disable --now spartan-backup.timer
fi
node scripts/setup-node.mjs "$location" --check-health --env /etc/spartan-cloud/node.env
systemctl is-active --quiet spartan-tunnel
printf 'Installed %s node. Agent and tunnel start automatically; backups run hourly.\n' "$location"
printf 'Tunnel ingress must point to http://127.0.0.1:8788.\n'
printf 'View logs: journalctl -u spartan-agent -u spartan-tunnel -f\n'
flock -u 9
exec 9>&-
if [ "$skip_db_network" = false ]; then
  network_args=("$location" install)
  if [ -n "$peer_ip" ]; then network_args+=("$peer_ip"); fi
  if [ "$interactive_setup" = true ] && [ -r /dev/tty ]; then
    spartan-db-network "${network_args[@]}" </dev/tty
  else
    spartan-db-network "${network_args[@]}"
  fi
fi
