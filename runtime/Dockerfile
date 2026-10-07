ARG ROADRUNNER_IMAGE=ghcr.io/roadrunner-server/roadrunner:2025.1.15
FROM ${ROADRUNNER_IMAGE} AS roadrunner
FROM node:24-bookworm-slim AS assets
WORKDIR /build
COPY app/ ./
RUN if [ -f package.json ]; then test -f package-lock.json && npm ci --no-audit --no-fund && npm run build; fi
FROM php:8.4-cli-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends nginx supervisor python3 libzip-dev libicu-dev libonig-dev libsqlite3-dev libpng-dev libjpeg62-turbo-dev libfreetype6-dev libxml2-dev libcurl4-openssl-dev unzip curl ca-certificates && docker-php-ext-configure gd --with-freetype --with-jpeg && docker-php-ext-install gd curl pdo_mysql exif pdo_sqlite bcmath intl mbstring zip opcache pcntl sockets && rm -rf /var/lib/apt/lists/*
COPY runtime/install-ioncube.sh /usr/local/bin/cloud-install-ioncube
ARG IONCUBE_SHA256
RUN IONCUBE_SHA256="$IONCUBE_SHA256" sh /usr/local/bin/cloud-install-ioncube && rm /usr/local/bin/cloud-install-ioncube
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /var/www/html
COPY app/ ./
COPY --from=assets /build/public/ ./public/
RUN test -f artisan && test -f composer.lock && test -f public/index.php && rm -f .env && composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader --no-scripts && mkdir -p storage bootstrap/cache && chown -R www-data:www-data storage bootstrap/cache
RUN php -r 'require "vendor/autoload.php"; if (!class_exists(Laravel\Octane\OctaneServiceProvider::class) || !class_exists(Spiral\RoadRunner\Http\PSR7Worker::class) || !is_file("vendor/bin/roadrunner-worker")) { fwrite(STDERR, "Octane and RoadRunner must be installed in composer.lock as production dependencies.\n"); exit(1); }'
COPY --from=roadrunner /usr/bin/rr /var/www/html/rr
COPY runtime/rr.yaml /etc/spartan/rr.yaml
COPY runtime/SpartanCloudServiceProvider.php /usr/local/lib/spartan-cloud/SpartanCloudServiceProvider.php
COPY runtime/bootstrap.php /usr/local/lib/spartan-cloud/bootstrap.php
RUN test ! -e bootstrap/spartan-app.php && mv bootstrap/app.php bootstrap/spartan-app.php && cp /usr/local/lib/spartan-cloud/bootstrap.php bootstrap/app.php && php -l bootstrap/app.php && php -l /usr/local/lib/spartan-cloud/SpartanCloudServiceProvider.php && ./rr --version
COPY tests/runtime_octane_test.php /tmp/runtime_octane_test.php
RUN php /tmp/runtime_octane_test.php && rm /tmp/runtime_octane_test.php
COPY runtime/nginx.conf /etc/nginx/nginx.conf
COPY runtime/octane-proxy.conf /etc/nginx/octane-proxy.conf
COPY runtime/supervisord.conf /etc/supervisor/supervisord.conf
COPY runtime/entrypoint.sh /usr/local/bin/cloud-entrypoint
COPY runtime/create-admin.py /usr/local/bin/cloud-create-admin
COPY runtime/admin-state.php /usr/local/bin/cloud-admin-state.php
RUN chmod 755 /usr/local/bin/cloud-entrypoint && printf 'if ($http_x_spartan_ingress_key != "build-test") { return 403; }\n' > /etc/nginx/spartan-origin-auth.conf && nginx -t && rm /etc/nginx/spartan-origin-auth.conf
ENV OCTANE_SERVER=roadrunner OCTANE_HTTPS=true
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cloud-entrypoint"]
