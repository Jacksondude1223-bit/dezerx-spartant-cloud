#!/bin/sh
set -eu
case "$(uname -m)" in
  x86_64) loader_arch=x86-64 ;;
  aarch64|arm64) loader_arch=aarch64 ;;
  *) printf '%s\n' 'unsupported_ioncube_architecture' >&2; exit 1 ;;
esac
loader_php="$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')"
loader_temp="$(mktemp -d)"
trap 'rm -rf "$loader_temp"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 2 "https://downloads.ioncube.com/loader_downloads/ioncube_loaders_lin_${loader_arch}.tar.gz" -o "$loader_temp/loaders.tar.gz"
if [ -n "${IONCUBE_SHA256:-}" ]; then
  printf '%s  %s\n' "$IONCUBE_SHA256" "$loader_temp/loaders.tar.gz" | sha256sum -c -
fi
tar -xzf "$loader_temp/loaders.tar.gz" -C "$loader_temp" "ioncube/ioncube_loader_lin_${loader_php}.so"
loader_target="$(php-config --extension-dir)/ioncube_loader_lin_${loader_php}.so"
install -m 0644 "$loader_temp/ioncube/ioncube_loader_lin_${loader_php}.so" "$loader_target"
printf 'zend_extension=%s\n' "$loader_target" > "$PHP_INI_DIR/conf.d/00-ioncube.ini"
php -r 'if (!function_exists("ioncube_loader_version")) { fwrite(STDERR, "ioncube_loader_unavailable\n"); exit(1); } echo ioncube_loader_version(), PHP_EOL;'
