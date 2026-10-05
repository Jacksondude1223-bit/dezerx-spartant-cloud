#!/bin/sh
set -eu
cd /var/www/html
mkdir -p storage/app/public storage/framework/cache/data storage/framework/sessions storage/framework/views storage/logs database/persistent bootstrap/cache
chown -R www-data:www-data storage database/persistent bootstrap/cache
test -f database/persistent/database.sqlite || install -o www-data -g www-data -m 600 /dev/null database/persistent/database.sqlite
rm -f bootstrap/cache/config.php bootstrap/cache/routes-*.php
if [ "$CLOUD_ROLE" = primary ]; then
  su -s /bin/sh www-data -c 'php artisan package:discover --ansi && php artisan migrate --force && php artisan config:cache && php artisan view:cache'
  sqlite3 database/persistent/database.sqlite 'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'
else
  su -s /bin/sh www-data -c 'php artisan package:discover --ansi && php artisan config:cache'
fi
test -L public/storage || ln -s /var/www/html/storage/app/public public/storage
exec supervisord -c /etc/supervisor/supervisord.conf
