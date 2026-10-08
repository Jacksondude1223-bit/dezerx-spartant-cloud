#!/usr/bin/env bash
set -euo pipefail
: "${APP_URL:?}"
host="${APP_URL#https://}"
host="${host%/}"
status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: $host" -H 'X-Forwarded-Proto: https' http://127.0.0.1:8080/__cloud_health)"
case "$status" in
    2[0-9][0-9]) exit 0 ;;
    *) exit 1 ;;
esac
