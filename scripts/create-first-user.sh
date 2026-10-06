#!/usr/bin/env bash
set -euo pipefail
tenant_id="${1:?}"
[[ "$tenant_id" =~ ^t-[a-f0-9]{24}$ ]] || exit 1
data_root="${DATA_ROOT:-/srv/spartan-cloud}"
container_name="spartan-$tenant_id"
test -d "$data_root/$tenant_id/database"
exec 9>"$data_root/$tenant_id/.first-user-setup.lock"
flock -n 9
role="$(docker inspect --format '{{ index .Config.Labels "spartan.role" }}' "$container_name")"
test "$role" = primary
managed_tenant="$(docker inspect --format '{{ index .Config.Labels "spartan.tenant" }}' "$container_name")"
test "$managed_tenant" = "$tenant_id"
marker="$data_root/$tenant_id/database/.cloud-first-user-created"
test ! -f "$marker" || exit 0
docker exec --user www-data --workdir /var/www/html "$container_name" php -r 'try { require "vendor/autoload.php"; $app = require "bootstrap/app.php"; $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap(); $model = config("auth.providers.users.model"); if (!is_string($model) || !is_subclass_of($model, Illuminate\Database\Eloquent\Model::class)) { exit(20); } if ((new $model)->newQuery()->exists()) { exit(10); } } catch (Throwable $error) { exit(20); }'
test -t 0
test -t 1
docker exec -it --user www-data --workdir /var/www/html "$container_name" php artisan dx:user:create
docker exec --user www-data --workdir /var/www/html "$container_name" php -r 'try { require "vendor/autoload.php"; $app = require "bootstrap/app.php"; $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap(); $model = config("auth.providers.users.model"); if (!is_string($model) || !is_subclass_of($model, Illuminate\Database\Eloquent\Model::class)) { exit(20); } if (!(new $model)->newQuery()->exists()) { exit(10); } } catch (Throwable $error) { exit(20); }'
umask 077
printf '%s\n' "$(date -u +%FT%TZ)" > "$marker"
