#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
[ "$(id -u)" -eq 0 ] || { printf 'Run with sudo.\n' >&2; exit 1; }
location="${1:-}"
if [ -z "$location" ]; then
  read -r -p 'Node region (us/de): ' location </dev/tty
  set -- "$location"
fi
case "$location" in us|de) ;; *) printf 'Use us or de.\n' >&2; exit 1 ;; esac
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$script_root/scripts/install-node.sh" ]; then
  exec bash "$script_root/scripts/install-node.sh" "$@"
fi
[ -d /run/systemd/system ] || { printf 'A systemd host is required.\n' >&2; exit 1; }
if ! command -v curl >/dev/null || ! command -v tar >/dev/null; then
  command -v apt-get >/dev/null || { printf 'Ubuntu or Debian is required.\n' >&2; exit 1; }
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl tar
fi
checkout="$(mktemp -d)"
trap 'rm -rf "$checkout"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL --retry 3 https://github.com/Jacksondude1223-bit/dezerx-spartant-cloud/archive/refs/heads/main.tar.gz -o "$checkout/source.tar.gz"
tar -xzf "$checkout/source.tar.gz" -C "$checkout"
bash "$checkout/dezerx-spartant-cloud-main/scripts/install-node.sh" "$@"
