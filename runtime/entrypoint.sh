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
# Containers restart with the host (--restart unless-stopped), so MariaDB may not be
# accepting connections yet. Probed with PDO so the image needs no mysql client.
probe='try { new PDO("mysql:unix_socket=".getenv("DB_SOCKET").";dbname=".getenv("DB_DATABASE"), getenv("DB_USERNAME"), getenv("DB_PASSWORD")); } catch (Throwable $e) { exit(1); }'
waited=0
until php -r "$probe" 2>/dev/null; do
  waited=$((waited + 2))
  [ "$waited" -ge 120 ] && { echo 'database unreachable after 120s' >&2; exit 1; }
  sleep 2
done
if [ "$CLOUD_ROLE" = primary ]; then
  su -s /bin/sh www-data -c 'php artisan package:discover --ansi && php artisan migrate --force && php artisan config:cache && php artisan view:cache'
else
  su -s /bin/sh www-data -c 'php artisan package:discover --ansi && php artisan config:cache'
fi
test -L public/storage || ln -s /var/www/html/storage/app/public public/storage
exec supervisord -c /etc/supervisor/supervisord.conf
