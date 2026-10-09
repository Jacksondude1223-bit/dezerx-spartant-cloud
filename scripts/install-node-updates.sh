#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
[ "$(id -u)" -eq 0 ] || { printf 'Run with sudo.\n' >&2; exit 1; }
[ -d /run/systemd/system ] && [ -f /opt/spartan-cloud/agent.mjs ] || { printf 'Install the node first.\n' >&2; exit 1; }
if [ "${SPARTAN_INSTALL_LOCK_HELD:-}" != 1 ]; then
  exec 9>/run/spartan-install.lock
  flock -n 9 || { printf 'Another node installation or update is running.\n' >&2; exit 1; }
fi
cd "$(dirname "$0")/.."
install -d -m 700 /var/lib/spartan-cloud /opt/spartan-cloud-releases
install -m 644 node/update-system.mjs /opt/spartan-cloud/update-system.mjs
install -m 644 scripts/setup-node.mjs /opt/spartan-cloud/setup-node.mjs
install -m 755 scripts/node-update.sh /usr/local/sbin/spartan-node-update
cat > /etc/systemd/system/spartan-update-check.service <<EOF2
[Unit]
Description=Check for Spartan node code updates
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/spartan-node-update check
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/spartan-cloud /run
TimeoutStartSec=90
MemoryMax=128M
Nice=10
EOF2
cat > /etc/systemd/system/spartan-update-check.timer <<'EOF2'
[Unit]
Description=Weekly Spartan node update check
[Timer]
OnCalendar=Mon *-*-* 09:00:00 UTC
Persistent=true
RandomizedDelaySec=1h
Unit=spartan-update-check.service
[Install]
WantedBy=timers.target
EOF2
systemctl daemon-reload
systemctl enable --now spartan-update-check.timer
printf 'Weekly node update checks installed. Run: sudo spartan-node-update check\n'
