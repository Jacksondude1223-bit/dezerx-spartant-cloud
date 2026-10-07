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
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-dependencies) skip_dependencies=true; shift ;;
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
[ -d /run/systemd/system ] || { printf 'A systemd host is required.\n' >&2; exit 1; }
command -v flock >/dev/null || { apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y util-linux; }
exec 9>/run/spartan-install.lock
flock -n 9 || { printf 'Another node installation is running.\n' >&2; exit 1; }
if [ "$skip_dependencies" = false ]; then bash scripts/install-dependencies.sh; fi
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
docker info >/dev/null
command -v cloudflared >/dev/null
command -v mysqldump >/dev/null
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
node scripts/setup-node.mjs "$location" "${setup_args[@]}" --output "$staging"
image="$(cat "$staging/image")"
printf 'Checking Spartan image availability.\n'
docker pull "$image" || { printf 'Image pull failed. For private images run sudo docker login REGISTRY, then retry.\n' >&2; exit 1; }
install -d -m 700 /etc/spartan-cloud /srv/spartan-cloud /srv/spartan-backups
# Tenant containers reach MariaDB over its unix socket only, so it never listens on a
# public interface. Each Octane worker, queue worker and scheduler holds a connection,
# so the default 151 is far too low for a full node; MAX_USER_CONNECTIONS caps each tenant.
install -d -m 755 /etc/mysql/mariadb.conf.d
cat > /etc/mysql/mariadb.conf.d/99-spartan.cnf <<'CNF'
[mysqld]
bind-address = 127.0.0.1
max_connections = 500
CNF
chmod 644 /etc/mysql/mariadb.conf.d/99-spartan.cnf
systemctl enable mariadb
systemctl restart mariadb
mysqladmin --protocol=socket -uroot ping
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
ExecStart=$node_path /opt/spartan-cloud/agent.mjs
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
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
systemctl enable spartan-agent spartan-tunnel spartan-backup.timer
systemctl restart spartan-agent spartan-tunnel
systemctl start spartan-backup.timer
node scripts/setup-node.mjs "$location" --check-health --env /etc/spartan-cloud/node.env
systemctl is-active --quiet spartan-tunnel
printf 'Installed %s node. Agent and tunnel start automatically; backups run hourly.\n' "$location"
printf 'Tunnel ingress must point to http://127.0.0.1:8788.\n'
printf 'View logs: journalctl -u spartan-agent -u spartan-tunnel -f\n'
