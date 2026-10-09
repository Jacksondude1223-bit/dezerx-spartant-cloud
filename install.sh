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
shift
private=false
token_file=""
install_args=("$location")
while [ "$#" -gt 0 ]; do
  case "$1" in
    --private) private=true; shift ;;
    --github-token-file)
      [ "$#" -ge 2 ] || { printf 'Missing GitHub token file.\n' >&2; exit 1; }
      token_file="$2"; private=true; shift 2 ;;
    --env|--token)
      [ "$#" -ge 2 ] || { printf 'Missing option value.\n' >&2; exit 1; }
      install_args+=("$1" "$2"); shift 2 ;;
    --non-interactive|--skip-dependencies) install_args+=("$1"); shift ;;
    *) printf 'Unknown installer option.\n' >&2; exit 1 ;;
  esac
done
script_root=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$script_root" ] && [ -f "$script_root/scripts/install-node.sh" ]; then
  exec bash "$script_root/scripts/install-node.sh" "${install_args[@]}"
fi
[ -d /run/systemd/system ] || { printf 'A systemd host is required.\n' >&2; exit 1; }
if ! command -v git >/dev/null; then
  command -v apt-get >/dev/null || { printf 'Ubuntu or Debian is required.\n' >&2; exit 1; }
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates git
fi
checkout="$(mktemp -d)"
trap 'rm -rf "$checkout"' EXIT
if [ "$private" = true ]; then
  if [ -n "$token_file" ]; then
    [ -f "$token_file" ] && [ ! -L "$token_file" ] || { printf 'Invalid GitHub token file.\n' >&2; exit 1; }
    [ "$(stat -c %u "$token_file")" = "$(id -u)" ] && [ "$(stat -c %a "$token_file")" = 600 ] || { printf 'GitHub token file must be owned by root with mode 600.\n' >&2; exit 1; }
    github_token="$(cat -- "$token_file")"
  else
    read -r -s -p 'GitHub access token (hidden): ' github_token </dev/tty
    printf '\n' >&2
  fi
  case "$github_token" in ''|*[!a-zA-Z0-9_.-]*) printf 'Invalid GitHub access token.\n' >&2; exit 1 ;; esac
  printf '%s\n' "$github_token" > "$checkout/github-token"
  unset github_token
  cat > "$checkout/askpass" <<'ASKPASS'
#!/usr/bin/env bash
set +x
case "$1" in
  "Username for 'https://github.com': "*) printf 'x-access-token\n' ;;
  "Password for 'https://x-access-token@github.com': "*) cat -- "$SPARTAN_GITHUB_TOKEN_FILE" ;;
  *) exit 1 ;;
esac
ASKPASS
  chmod 700 "$checkout/askpass"
  export GIT_ASKPASS="$checkout/askpass" SPARTAN_GITHUB_TOKEN_FILE="$checkout/github-token"
fi
unset GIT_TRACE GIT_TRACE_PACKET GIT_TRACE_CURL GIT_CURL_VERBOSE GIT_TRACE_CURL_NO_DATA GIT_TRACE2 GIT_TRACE2_EVENT GIT_TRACE2_PERF
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
if ! LC_ALL=C git -c credential.helper= -c http.followRedirects=false clone --depth 1 --single-branch --branch main https://github.com/Jacksondude1223-bit/dezerx-spartant-cloud.git "$checkout/source"; then
  printf 'Repository download failed. For a private repository retry with --private or --github-token-file FILE. The token needs access to this repository with Contents: Read-only.\n' >&2
  exit 1
fi
rm -f "$checkout/askpass" "$checkout/github-token"
unset GIT_ASKPASS SPARTAN_GITHUB_TOKEN_FILE GIT_TERMINAL_PROMPT GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
bash "$checkout/source/scripts/install-node.sh" "${install_args[@]}"
