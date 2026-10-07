#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/run/spartan-backup.lock
flock -n 9 || exit 0
data_root="${DATA_ROOT:-/srv/spartan-cloud}"
backup_root="${BACKUP_ROOT:-/srv/spartan-backups}"
socket="${MYSQL_SOCKET:-/run/mysqld/mysqld.sock}"
keep="${BACKUP_KEEP:-0}"
mkdir -p "$backup_root"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
failed=0
backup_tenant() {
  local name="$1" id="$2" dest="$3"
  local database="sp_${id#t-}"
  local status=0
  # --single-transaction takes a consistent InnoDB snapshot without locking the tenant
  # out. Each tenant is attempted independently so one failure cannot abort the sweep.
  mkdir -p "$dest" \
    && mysqldump --protocol=socket --socket="$socket" -uroot --single-transaction --quick \
         --routines --triggers --events --default-character-set=utf8mb4 "$database" \
         | gzip -c > "$dest/database.sql.gz" \
    && test -s "$dest/database.sql.gz" \
    && gzip -t "$dest/database.sql.gz" \
    && tar -C "$data_root/$id" -czf "$dest/storage.tar.gz" storage \
    && cp "$data_root/$id/app.env" "$dest/app.env" \
    && cp "$data_root/$id/state.json" "$dest/state.json" \
    && touch "$dest/complete" || status=1
  return "$status"
}
# Opt-in retention. Unset or 0 keeps everything, which is the previous behaviour.
prune_tenant() {
  local id="$1"
  [ "$keep" -gt 0 ] 2>/dev/null || return 0
  local completed
  completed="$(find "$backup_root/$id" -mindepth 2 -maxdepth 2 -name complete -printf '%h\n' 2>/dev/null | sort)"
  local total
  total="$(printf '%s\n' "$completed" | grep -c . || true)"
  [ "$total" -gt "$keep" ] || return 0
  printf '%s\n' "$completed" | head -n "$((total - keep))" | while read -r old; do
    [ -n "$old" ] && [ -f "$old/complete" ] && rm -rf "$old"
  done
}
while read -r name; do
  [[ "$name" =~ ^spartan-t-[a-f0-9]{24}$ ]] || continue
  id="${name#spartan-}"
  dest="$backup_root/$id/$stamp"
  if backup_tenant "$name" "$id" "$dest"; then
    prune_tenant "$id"
  else
    failed=$((failed + 1))
    rm -rf "$dest"
    printf 'backup_failed %s\n' "$id" >&2
  fi
done < <(docker ps --filter label=spartan.managed=true --filter label=spartan.role=primary --format '{{.Names}}')
[ "$failed" -eq 0 ] || exit 1
