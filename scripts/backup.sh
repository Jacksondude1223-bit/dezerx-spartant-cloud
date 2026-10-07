#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/run/spartan-backup.lock
flock -n 9 || exit 0
data_root="${DATA_ROOT:-/srv/spartan-cloud}"
backup_root="${BACKUP_ROOT:-/srv/spartan-backups}"
mkdir -p "$backup_root"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
failed=0
persistent=/var/www/html/database/persistent
backup_tenant() {
  local name="$1" id="$2" dest="$3"
  local inside="$persistent/backup-$stamp.sqlite"
  local status=0
  mkdir -p "$dest" \
    && docker exec "$name" sqlite3 "$persistent/database.sqlite" ".timeout 10000" ".backup '$inside'" \
    && docker cp "$name:$inside" "$dest/database.sqlite" \
    && test "$(sqlite3 "$dest/database.sqlite" 'PRAGMA integrity_check;')" = ok \
    && tar -C "$data_root/$id" -czf "$dest/storage.tar.gz" storage \
    && cp "$data_root/$id/app.env" "$dest/app.env" \
    && cp "$data_root/$id/state.json" "$dest/state.json" \
    && touch "$dest/complete" || status=1
  docker exec "$name" rm -f "$inside" "$persistent/backup.sqlite" >/dev/null 2>&1 || true
  return "$status"
}
while read -r name; do
  [[ "$name" =~ ^spartan-t-[a-f0-9]{24}$ ]] || continue
  id="${name#spartan-}"
  dest="$backup_root/$id/$stamp"
  if ! backup_tenant "$name" "$id" "$dest"; then
    failed=$((failed + 1))
    rm -rf "$dest"
    printf 'backup_failed %s\n' "$id" >&2
  fi
done < <(docker ps --filter label=spartan.managed=true --filter label=spartan.role=primary --format '{{.Names}}')
[ "$failed" -eq 0 ] || exit 1
