#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/run/spartan-backup.lock
flock -n 9 || exit 0
data_root="${DATA_ROOT:-/srv/spartan-cloud}"
backup_root="${BACKUP_ROOT:-/srv/spartan-backups}"
mkdir -p "$backup_root"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
while read -r name; do
  [[ "$name" =~ ^spartan-t-[a-f0-9]{24}$ ]] || continue
  id="${name#spartan-}"
  dest="$backup_root/$id/$stamp"
  mkdir -p "$dest"
  docker exec "$name" sqlite3 /var/www/html/database/persistent/database.sqlite ".timeout 10000" ".backup '/var/www/html/database/persistent/backup.sqlite'"
  docker cp "$name:/var/www/html/database/persistent/backup.sqlite" "$dest/database.sqlite"
  test "$(sqlite3 "$dest/database.sqlite" 'PRAGMA integrity_check;')" = ok
  tar -C "$data_root/$id" -czf "$dest/storage.tar.gz" storage
  cp "$data_root/$id/app.env" "$dest/app.env"
  cp "$data_root/$id/state.json" "$dest/state.json"
  touch "$dest/complete"
done < <(docker ps --filter label=spartan.managed=true --filter label=spartan.role=primary --format '{{.Names}}')
