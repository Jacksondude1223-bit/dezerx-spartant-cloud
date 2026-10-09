#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/var/www/html
APP_USER=www-data
STATE_DIR="$APP_DIR/storage/container"
SYNC_ENV=/usr/local/lib/dezerx/sync-env.php
IMAGE_BUILD_FILE=/etc/dezerx-image-build
OCTANE_PORT=8000
OCTANE_RPC_PORT=6001
DEFAULT_QUEUES=critical,high,medium,default,low
PERSISTED_DIRS=(public/meta public/images/profiles resources/views/emails Modules Themes)
PERSISTED_FILES=(public/favicon.ico public/favicon.svg)

log() {
    printf '[dezerx] %s\n' "$*" >&2
}

is_root() {
    [ "$(id -u)" = 0 ]
}

as_app() {
    if is_root; then
        setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups env HOME=/tmp "$@"
    else
        "$@"
    fi
}

exec_as_app() {
    if is_root; then
        exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups env HOME=/tmp "$@"
    fi

    exec "$@"
}

artisan() {
    as_app php "$APP_DIR/artisan" --no-interaction "$@"
}

setting() {
    local key="$1" default="${2:-}" value="${!1:-}"

    if [ -z "$value" ] && [ -f "$APP_DIR/.env" ]; then
        value="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*[\"']\{0,1\}\([^\"'[:space:]#]*\).*/\1/p" "$APP_DIR/.env" | tail -n 1)"
    fi

    printf '%s' "${value:-$default}"
}

is_false() {
    case "${1,,}" in
        0 | false | no | off) return 0 ;;
        *) return 1 ;;
    esac
}

prepare_storage() {
    if is_root && [ "$(stat -c %U "$APP_DIR/storage")" != "$APP_USER" ]; then
        log "Fixing ownership of storage/"
        chown -R "$APP_USER:$APP_USER" "$APP_DIR/storage"
    fi

    if ! as_app test -w "$APP_DIR/storage"; then
        log "storage/ is not writable by uid $(id -u "$APP_USER"). Run: chown -R 33:33 on the volume, or start the container once as root."
        exit 1
    fi

    as_app mkdir -p \
        "$APP_DIR/storage/app/public" \
        "$APP_DIR/storage/app/private" \
        "$APP_DIR/storage/framework/cache/data" \
        "$APP_DIR/storage/framework/sessions" \
        "$APP_DIR/storage/framework/views" \
        "$APP_DIR/storage/logs" \
        "$STATE_DIR"
}

link_to_state() {
    local live="$APP_DIR/$1" kept="$STATE_DIR/$1"

    if [ "$(readlink "$live" 2>/dev/null)" != "$kept" ]; then
        as_app rm -rf "$live"
        as_app ln -s "$kept" "$live"
    fi
}

persist_dir() {
    local live="$APP_DIR/$1" kept="$STATE_DIR/$1"

    mountpoint -q "$live" 2>/dev/null && return 0

    as_app mkdir -p "$kept"

    if [ -d "$live" ] && [ ! -L "$live" ] && ! as_app cp -an "$live/." "$kept/"; then
        log "Could not copy $1 into storage/container, using the copy in the image"
        return 0
    fi

    link_to_state "$1"
}

persist_file() {
    local live="$APP_DIR/$1" kept="$STATE_DIR/$1"

    mountpoint -q "$live" 2>/dev/null && return 0

    as_app mkdir -p "$(dirname "$kept")"

    if [ ! -e "$kept" ]; then
        [ -f "$live" ] && [ ! -L "$live" ] || return 0
        as_app cp -a "$live" "$kept"
    fi

    link_to_state "$1"
}

with_env_lock() {
    as_app flock "$STATE_DIR/.env.lock" "$@"
}

prepare_env_file() {
    local live="$APP_DIR/.env" kept="$STATE_DIR/.env"

    if mountpoint -q "$live" 2>/dev/null; then
        log "Using the .env file mounted at $live as-is"
        return 0
    fi

    if [ ! -e "$kept" ]; then
        if [ -f "$live" ] && [ ! -L "$live" ]; then
            as_app cp -a "$live" "$kept"
        else
            log "Creating storage/container/.env from .env.example"
            as_app cp -n "$APP_DIR/.env.example" "$kept"
            with_env_lock php -n "$SYNC_ENV" "$kept" --default APP_ENV=production --default APP_DEBUG=false
        fi
    fi

    link_to_state .env
    with_env_lock php -n "$SYNC_ENV" "$kept" "$APP_DIR/.env.example"
}

drop_empty_app_variables() {
    local key

    while IFS= read -r key; do
        if [[ -v "$key" && -z "${!key}" ]]; then
            unset "$key"
        fi
    done < <(sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\1/p' "$APP_DIR/.env.example" "$APP_DIR/.env" | sort -u)
}

prepare_container() {
    if is_root; then
        chown --no-dereference "$APP_USER:$APP_USER" "$APP_DIR"
    fi
    prepare_storage

    local path
    for path in "${PERSISTED_DIRS[@]}"; do
        persist_dir "$path"
    done
    for path in "${PERSISTED_FILES[@]}"; do
        persist_file "$path"
    done

    prepare_env_file
    drop_empty_app_variables
}

wait_for_database() {
    local timeout waited=0 error
    timeout="$(setting DB_WAIT_TIMEOUT 120)"

    until error="$(as_app php -r '
        require "vendor/autoload.php";
        $app = require "bootstrap/app.php";
        $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
        Illuminate\Support\Facades\DB::connection()->getPdo();
    ' 2>&1)"; do
        if [ "$waited" -ge "$timeout" ]; then
            log "Database still unreachable after ${timeout}s: ${error}"
            return 1
        fi

        [ "$waited" = 0 ] && log "Waiting for the database..."
        sleep 3
        waited=$((waited + 3))
    done
}

wait_for_app_key() {
    local waited=0

    until [ -n "$(setting APP_KEY)" ]; do
        if [ "$waited" -ge 120 ]; then
            log "APP_KEY is still empty. Start the web container first, or set APP_KEY."
            return 1
        fi

        [ "$waited" = 0 ] && log "Waiting for the web container to generate APP_KEY..."
        sleep 3
        waited=$((waited + 3))
    done
}

ensure_app_key() {
    if [ -z "$(setting APP_KEY)" ]; then
        log "Generating APP_KEY"
        with_env_lock php "$APP_DIR/artisan" --no-interaction key:generate --force
    fi
}

migrations_enabled() {
    ! is_false "$(setting RUN_MIGRATIONS true)"
}

run_migrations() {
    if ! migrations_enabled; then
        log "RUN_MIGRATIONS is off, skipping migrations"
        return 0
    fi

    log "Running migrations"
    artisan migrate --force
}

finish_image_upgrade() {
    local current previous marker="$STATE_DIR/.image-build"
    current="$(cat "$IMAGE_BUILD_FILE" 2>/dev/null || echo unknown)"
    previous="$(cat "$marker" 2>/dev/null || true)"

    [ "$current" = "$previous" ] && return 0

    log "First start of image build ${current}"

    if migrations_enabled; then
        artisan db:seed --force || log "db:seed failed, continuing"
    fi

    artisan optimize:clear || log "optimize:clear failed, continuing"
    as_app sh -c 'printf "%s\n" "$1" > "$2"' sh "$current" "$marker"
}

supervise() {
    local child=0 stopping=0

    trap 'stopping=1; [ "$child" -gt 0 ] && kill -TERM "$child" 2>/dev/null' TERM INT

    while [ "$stopping" = 0 ]; do
        exec_as_app "$@" &
        child=$!
        wait "$child" || true

        if [ "$stopping" = 1 ]; then
            wait "$child" 2>/dev/null || true
            break
        fi

        sleep 1
    done
}

run_web() {
    wait_for_database
    ensure_app_key
    run_migrations
    finish_image_upgrade

    rm -f "${OCTANE_STATE_FILE:-/tmp/octane-server-state.json}"

    log "Starting Octane (RoadRunner) on :${OCTANE_PORT}"
    exec_as_app php "$APP_DIR/artisan" octane:start \
        --server=roadrunner \
        --host=0.0.0.0 \
        --port="$OCTANE_PORT" \
        --rpc-host=127.0.0.1 \
        --rpc-port="$OCTANE_RPC_PORT" \
        --workers="$(setting OCTANE_WORKERS auto)" \
        --max-requests="$(setting OCTANE_MAX_REQUESTS 10000)"
}

run_queue() {
    wait_for_app_key
    wait_for_database

    local queues
    queues="$(setting QUEUE_NAMES "$DEFAULT_QUEUES")"

    log "Starting queue worker for ${queues}"
    supervise php "$APP_DIR/artisan" queue:work \
        --queue="$queues" \
        --sleep=3 \
        --tries=3 \
        --max-time=3600
}

run_scheduler() {
    wait_for_app_key
    wait_for_database

    log "Starting the scheduler"
    exec_as_app php "$APP_DIR/artisan" schedule:work
}

cd "$APP_DIR"

role="${1:-web}"
printf '%s\n' "$role" > /tmp/dezerx-role 2>/dev/null || true

prepare_container

case "$role" in
    cloud-init)
        wait_for_database
        ensure_app_key
        run_migrations
        finish_image_upgrade
        ;;
    web) run_web ;;
    queue | worker) run_queue ;;
    scheduler | schedule | cron) run_scheduler ;;
    artisan)
        shift
        exec_as_app php "$APP_DIR/artisan" "$@"
        ;;
    *) exec_as_app "$@" ;;
esac
