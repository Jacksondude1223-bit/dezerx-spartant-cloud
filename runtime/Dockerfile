ARG PHP_VERSION=8.4
ARG NODE_VERSION=22
ARG RR_VERSION=2025.1.15

FROM ghcr.io/roadrunner-server/roadrunner:${RR_VERSION} AS roadrunner

FROM composer:2 AS composer

FROM php:${PHP_VERSION}-cli-bookworm AS php-base

COPY --from=mlocati/php-extension-installer:2 /usr/bin/install-php-extensions /usr/local/bin/

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl tini util-linux; \
    install-php-extensions bcmath curl exif gd imap intl mbstring opcache pcntl pdo_mysql redis sockets zip; \
    rm -rf /var/lib/apt/lists/* /tmp/*

COPY runtime/install-ioncube.sh /usr/local/bin/cloud-install-ioncube
ARG IONCUBE_SHA256
RUN IONCUBE_SHA256="$IONCUBE_SHA256" sh /usr/local/bin/cloud-install-ioncube && rm /usr/local/bin/cloud-install-ioncube

RUN cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY runtime/dezerx.ini $PHP_INI_DIR/conf.d/zz-dezerx.ini

WORKDIR /var/www/html


FROM php-base AS vendor

COPY --from=composer /usr/bin/composer /usr/bin/composer

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git unzip; \
    rm -rf /var/lib/apt/lists/*

COPY app/composer.json app/composer.lock ./
COPY app/Modules ./Modules

RUN --mount=type=cache,target=/root/.composer/cache \
    COMPOSER_ALLOW_SUPERUSER=1 composer install \
        --no-dev \
        --no-interaction \
        --no-progress \
        --no-scripts \
        --no-autoloader \
        --prefer-dist


FROM node:${NODE_VERSION}-bookworm-slim AS assets

WORKDIR /var/www/html

COPY app/package.json app/package-lock.json app/.npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY app/vite.config.ts app/vite-module-loader.js app/tsconfig.json app/components.json app/modules_statuses.json ./
COPY app/resources ./resources
COPY app/Modules ./Modules
COPY --from=vendor /var/www/html/vendor/tightenco/ziggy ./vendor/tightenco/ziggy
COPY --from=vendor /var/www/html/vendor/laravel/framework/src/Illuminate/Pagination/resources/views ./vendor/laravel/framework/src/Illuminate/Pagination/resources/views

ARG VITE_APP_NAME=DezerX
ARG NODE_BUILD_MEMORY_MB=4096
RUN VITE_APP_NAME="$VITE_APP_NAME" NODE_OPTIONS="--max-old-space-size=${NODE_BUILD_MEMORY_MB}" npx vite build


FROM php-base AS runtime

COPY --from=composer /usr/bin/composer /usr/bin/composer

ENV DEZERX_CONTAINER=1 \
    OCTANE_STATE_FILE=/tmp/octane-server-state.json \
    COMPOSER_HOME=/tmp/composer

COPY --chown=www-data:www-data app/ ./
COPY --chown=www-data:www-data --from=vendor /var/www/html/vendor ./vendor
COPY --chown=www-data:www-data --from=assets /var/www/html/public/build ./public/build
COPY --chown=www-data:www-data --from=roadrunner /usr/bin/rr ./rr
COPY runtime/vendor-entrypoint.sh /usr/local/bin/dezerx-entrypoint
COPY runtime/healthcheck.sh /usr/local/bin/dezerx-healthcheck
COPY runtime/sync-env.php /usr/local/lib/dezerx/sync-env.php

RUN set -eux; \
    install -d -o www-data -g www-data /tmp/opcache /tmp/composer; \
    mkdir -p \
        storage/app/public \
        storage/app/private \
        storage/framework/cache/data \
        storage/framework/sessions \
        storage/framework/views \
        storage/logs \
        bootstrap/cache; \
    chown -R www-data:www-data storage bootstrap/cache; \
    ln -sfn ../storage/app/public public/storage; \
    chown -h www-data:www-data public/storage; \
    date -u +%Y%m%d%H%M%S > /etc/dezerx-image-build

USER www-data

RUN set -eux; \
    composer dump-autoload --no-dev --optimize --no-interaction --no-scripts; \
    rm -f storage/logs/*.log

USER root
RUN apt-get update && apt-get install -y --no-install-recommends nginx supervisor python3 redis-server && rm -rf /var/lib/apt/lists/*
COPY runtime/rr.yaml /etc/spartan/rr.yaml
COPY runtime/SpartanCloudServiceProvider.php /usr/local/lib/spartan-cloud/SpartanCloudServiceProvider.php
COPY runtime/domain-context.php /usr/local/lib/spartan-cloud/domain-context.php
COPY runtime/bootstrap.php /usr/local/lib/spartan-cloud/bootstrap.php
RUN test ! -e bootstrap/spartan-app.php && mv bootstrap/app.php bootstrap/spartan-app.php && cp /usr/local/lib/spartan-cloud/bootstrap.php bootstrap/app.php && rm -f .env bootstrap/cache/config.php bootstrap/cache/packages.php bootstrap/cache/services.php && php -l bootstrap/app.php && php -l /usr/local/lib/spartan-cloud/domain-context.php && php -l /usr/local/lib/spartan-cloud/SpartanCloudServiceProvider.php && ./rr --version
COPY tests/runtime_domain_test.php /tmp/runtime_domain_test.php
RUN php /tmp/runtime_domain_test.php && rm /tmp/runtime_domain_test.php
COPY tests/runtime_octane_test.php /tmp/runtime_octane_test.php
RUN php /tmp/runtime_octane_test.php && rm /tmp/runtime_octane_test.php
COPY runtime/nginx.conf /etc/nginx/nginx.conf
COPY runtime/octane-proxy.conf /etc/nginx/octane-proxy.conf
COPY runtime/supervisord.conf /etc/supervisor/supervisord.conf
COPY runtime/redis.conf /etc/spartan/redis.conf
COPY runtime/entrypoint.sh /usr/local/bin/cloud-entrypoint
COPY runtime/create-admin.py /usr/local/bin/cloud-create-admin
COPY runtime/admin-state.php /usr/local/bin/cloud-admin-state.php
RUN chmod 755 /usr/local/bin/cloud-entrypoint /usr/local/bin/dezerx-entrypoint /usr/local/bin/dezerx-healthcheck && printf 'if ($http_x_spartan_ingress_key != "build-test") { return 403; }\n' > /etc/nginx/spartan-origin-auth.conf && nginx -t && rm /etc/nginx/spartan-origin-auth.conf
ENV OCTANE_SERVER=roadrunner OCTANE_HTTPS=true REDIS_HOST=127.0.0.1 REDIS_PORT=6379
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=10s --start-period=300s --retries=3 CMD ["dezerx-healthcheck"]
ENTRYPOINT ["tini", "--", "cloud-entrypoint"]
