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
/usr/local/bin/dezerx-entrypoint cloud-init
mkdir -p storage/container/redis
chown www-data:www-data storage/container/redis
if [ "$CLOUD_ROLE" = primary ]; then
  su -s /bin/sh www-data -c 'php artisan package:discover --ansi && php artisan config:cache && php artisan view:cache'
else
  su -s /bin/sh www-data -c 'php artisan package:discover --ansi && php artisan config:cache'
fi
test -L public/storage || ln -s /var/www/html/storage/app/public public/storage
exec supervisord -c /etc/supervisor/supervisord.conf
