#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" -eq 0
cd "$(dirname "$0")/.."
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
docker info >/dev/null
command -v cloudflared >/dev/null
command -v sqlite3 >/dev/null
command -v flock >/dev/null
location="${1:?}"
case "$location" in us|de) ;; *) exit 1 ;; esac
install -d -m 700 /etc/spartan-cloud /srv/spartan-cloud /srv/spartan-backups
install -d -m 755 /opt/spartan-cloud
install -m 600 "generated/$location.env" /etc/spartan-cloud/node.env
install -m 600 "generated/$location.tunnel-token" /etc/spartan-cloud/tunnel-token
test -f /etc/spartan-cloud/laravel-env.json || install -m 600 /dev/null /etc/spartan-cloud/laravel-env.json
test -s /etc/spartan-cloud/laravel-env.json || printf '{}\n' > /etc/spartan-cloud/laravel-env.json
install -m 644 node/agent.mjs /opt/spartan-cloud/agent.mjs
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
ExecStart=$cloudflared_path tunnel --no-autoupdate run --token-file /etc/spartan-cloud/tunnel-token
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
systemctl enable --now spartan-agent spartan-tunnel spartan-backup.timer
