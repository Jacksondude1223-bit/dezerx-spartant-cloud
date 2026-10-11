#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
cd "$(dirname "$0")"
wrangler=node_modules/.bin/wrangler
[ -x "$wrangler" ] || { printf 'Run npm install first.\n' >&2; exit 1; }
read -r -s -p 'Node ADMIN_API_SECRET (hidden): ' value </dev/tty
printf '\n' >&2
[ "${#value}" -ge 32 ] || exit 1
printf '%s' "$value" | "$wrangler" secret put ADMIN_API_SECRET
unset value
read -r -s -p 'Shared ORIGIN_SECRET (hidden): ' value </dev/tty
printf '\n' >&2
[ "${#value}" -ge 32 ] || exit 1
printf '%s' "$value" | "$wrangler" secret put ORIGIN_SECRET
unset value
read -r -s -p 'New dashboard password (12+ characters, hidden): ' password </dev/tty
printf '\n' >&2
read -r -s -p 'Confirm password (hidden): ' confirmation </dev/tty
printf '\n' >&2
[ "$password" = "$confirmation" ] || { printf 'Passwords differ.\n' >&2; exit 1; }
printf '%s' "$password" | node credentials.mjs password | "$wrangler" secret put DASHBOARD_PASSWORD_HASH
unset password confirmation
existing="$("$wrangler" secret list)"
if [[ "$existing" != *'"DASHBOARD_DATA_KEY"'* ]]; then
  if [ ! -e .dashboard-data-key ]; then node credentials.mjs key > .dashboard-data-key; fi
  node -e 'const s=require("fs").lstatSync(".dashboard-data-key");if(!s.isFile()||(s.mode&0o077))process.exit(1)' || { printf 'Encryption key backup must be a regular file with mode 600.\n' >&2; exit 1; }
  "$wrangler" secret put DASHBOARD_DATA_KEY < .dashboard-data-key
fi
unset existing
printf 'Secrets installed. Preserve .dashboard-data-key securely; existing remote encryption keys were retained. Configure DASHBOARD_TOTP_SECRET separately if required.\n'
