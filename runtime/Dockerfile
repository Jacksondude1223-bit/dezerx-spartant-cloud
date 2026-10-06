FROM php:8.3-fpm-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends nginx supervisor sqlite3 python3 libzip-dev libicu-dev libonig-dev libsqlite3-dev unzip curl ca-certificates && docker-php-ext-install pdo_sqlite bcmath intl mbstring zip opcache && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /var/www/html
COPY app/ ./
RUN test -f artisan && test -f composer.lock && test -f public/index.php && rm -f .env && composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader --no-scripts && mkdir -p storage bootstrap/cache && chown -R www-data:www-data storage bootstrap/cache
COPY runtime/nginx.conf /etc/nginx/nginx.conf
COPY runtime/supervisord.conf /etc/supervisor/supervisord.conf
COPY runtime/entrypoint.sh /usr/local/bin/cloud-entrypoint
COPY runtime/create-admin.py /usr/local/bin/cloud-create-admin
COPY runtime/admin-state.php /usr/local/bin/cloud-admin-state.php
COPY runtime/health.php /var/www/html/public/__cloud_health.php
RUN chmod 755 /usr/local/bin/cloud-entrypoint && printf 'if ($http_x_spartan_ingress_key != "build-test") { return 403; }\n' > /etc/nginx/spartan-origin-auth.conf && nginx -t && rm /etc/nginx/spartan-origin-auth.conf
RUN printf '[www]\nclear_env = no\n' > /usr/local/etc/php-fpm.d/zz-cloud.conf
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cloud-entrypoint"]
