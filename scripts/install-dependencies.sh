#!/usr/bin/env bash
set -euo pipefail
umask 022
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export DEBIAN_FRONTEND=noninteractive
[ "$(id -u)" -eq 0 ] || { printf 'Run with sudo.\n' >&2; exit 1; }
[ -d /run/systemd/system ] || { printf 'A systemd host is required.\n' >&2; exit 1; }
source /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) ;;
  *) printf 'Supported systems: Ubuntu 22.04/24.04/26.04 or Debian 12/13.\n' >&2; exit 1 ;;
esac
architecture="$(dpkg --print-architecture)"
case "$architecture" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) printf 'amd64 or arm64 is required.\n' >&2; exit 1 ;; esac
apt-get update
apt-get install -y ca-certificates curl tar xz-utils sqlite3 util-linux
if ! command -v docker >/dev/null; then
  for package in docker.io podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      printf 'Conflicting package %s is installed. Resolve it before retrying.\n' "$package" >&2
      exit 1
    fi
  done
  install -d -m 755 /etc/apt/keyrings
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod 644 /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/spartan-docker.sources <<APT
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $VERSION_CODENAME
Components: stable
Architectures: $architecture
Signed-By: /etc/apt/keyrings/docker.asc
APT
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
docker info >/dev/null
if ! command -v cloudflared >/dev/null; then
  install -d -m 755 /usr/share/keyrings
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  chmod 644 /usr/share/keyrings/cloudflare-main.gpg
  printf 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main\n' > /etc/apt/sources.list.d/spartan-cloudflared.list
  apt-get update
  apt-get install -y cloudflared
fi
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  download_dir="$(mktemp -d)"
  trap 'rm -rf "$download_dir"' EXIT
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$download_dir/SHASUMS256.txt"
  archive="$(awk -v arch="$node_arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$download_dir/SHASUMS256.txt")"
  [[ "$archive" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { printf 'Unable to select Node.js archive.\n' >&2; exit 1; }
  release="${archive%%-linux-*}"
  release="${release#node-}"
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 "https://nodejs.org/dist/$release/$archive" -o "$download_dir/$archive"
  (cd "$download_dir" && awk -v name="$archive" '$2 == name' SHASUMS256.txt | sha256sum --check --status)
  install -d -m 755 /opt/spartan-nodejs
  tar -xJf "$download_dir/$archive" -C /opt/spartan-nodejs
  ln -sfn "/opt/spartan-nodejs/${archive%.tar.xz}/bin/node" /usr/local/bin/node
fi
node --version
docker --version
cloudflared --version
