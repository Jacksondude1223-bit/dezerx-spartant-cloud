#!/bin/sh
set -eu
cd /var/www/html
case "$APP_KEY" in base64:*) ;; *) exit 1 ;; esac
case "$APP_KEY" in *[!A-Za-z0-9+/=:]*) exit 1 ;; esac
umask 077
printf 'if ($http_x_spartan_ingress_key != "%s") { return 403; }\n' "$APP_KEY" > /etc/nginx/spartan-origin-auth.conf
chmod 600 /etc/nginx/spartan-origin-auth.conf
umask 022
mkdir -p storage/app/public storage/framework/cache/data storage/framework/sessions storage/framework/views storage/logs bootstrap/cache
chown -R www-data:www-data storage bootstrap/cache
rm -f bootstrap/cache/config.php bootstrap/cache/routes-*.php
case "$CLOUD_ROLE" in
  primary) RUN_MIGRATIONS=true ;;
  secondary) RUN_MIGRATIONS=false ;;
  *) exit 1 ;;
esac
export RUN_MIGRATIONS

# Octane pool. Four workers keep a slow request (an outbound API call, a large report)
# from stalling every other visitor; 10000 requests per worker means a cold boot of the
# encoded application is rare instead of every few hundred requests. Both are overridable
# through the tenant environment.
# Containers limited below 1.5 GiB keep two workers so four cannot run them out of memory.
case "${OCTANE_WORKERS:-}" in
  [1-9] | 1[0-6]) ;;
  *)
    OCTANE_WORKERS=4
    memory="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo max)"
    case "$memory" in
      '' | *[!0-9]*) ;;
      *) if [ "$memory" -lt 1610612736 ]; then OCTANE_WORKERS=2; fi ;;
    esac
    ;;
esac
case "${OCTANE_MAX_REQUESTS:-}" in
  '' | *[!0-9]* | 0*) OCTANE_MAX_REQUESTS=10000 ;;
esac
export OCTANE_WORKERS OCTANE_MAX_REQUESTS

# Redis holds the cache (and sessions outside the US-central database mode). Start it
# before cloud-init, because migrations, seeders and optimize:clear may touch the cache;
# supervisord takes it over once the application is ready.
mkdir -p storage/container/redis
chown www-data:www-data storage/container/redis
setpriv --reuid=www-data --regid=www-data --init-groups redis-server /etc/spartan/redis.conf --daemonize yes --pidfile /tmp/redis-init.pid --logfile /tmp/redis-init.log
ready=0
for _ in $(seq 1 50); do
  if redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG; then ready=1; break; fi
  sleep 0.2
done
if [ "$ready" != 1 ]; then
  echo '[cloud] Redis did not start' >&2
  cat /tmp/redis-init.log >&2 2>/dev/null || true
  exit 1
fi

/usr/local/bin/dezerx-entrypoint cloud-init
su -s /bin/sh www-data -c 'php artisan package:discover --ansi && php artisan config:cache'
# Compiled views are shared by every worker, so compile them once here instead of on the
# first visits after each start. A secondary (which serves visitors in the US-central
# database mode) tries too, but never fails its start over it.
if [ "$CLOUD_ROLE" = primary ]; then
  su -s /bin/sh www-data -c 'php artisan view:cache'
else
  su -s /bin/sh www-data -c 'php artisan view:cache' || echo '[cloud] view:cache failed on the secondary, views compile on first use' >&2
fi
test -L public/storage || ln -s /var/www/html/storage/app/public public/storage

# Hand Redis to supervisord: a clean shutdown flushes the append-only file first.
redis-cli -h 127.0.0.1 -p 6379 shutdown >/dev/null 2>&1 || true
for _ in $(seq 1 50); do
  redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1 || break
  sleep 0.2
done
exec supervisord -c /etc/supervisor/supervisord.conf
