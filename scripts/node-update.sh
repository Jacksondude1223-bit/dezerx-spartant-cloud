#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
[ "$(id -u)" -eq 0 ] || { printf 'Run with sudo.\n' >&2; exit 1; }
exec 9>/run/spartan-install.lock
flock -n 9 || { printf 'Another node install or update is running.\n' >&2; exit 1; }
if [ "${1:-}" = auth ]; then
  [ "$#" -eq 1 ] || exit 1
  read -r -s -p 'GitHub read-only update token (hidden): ' update_token </dev/tty
  printf '\n' >&2
  printf '%s\n' "$update_token" | node /opt/spartan-cloud/update-system.mjs auth
  unset update_token
else
  exec node /opt/spartan-cloud/update-system.mjs "$@"
fi
