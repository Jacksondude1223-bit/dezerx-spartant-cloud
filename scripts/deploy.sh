#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source .env
set +a
npx wrangler deploy --config generated/provisioning.json
npx wrangler secret bulk generated/provisioning.secrets.json --config generated/provisioning.json
npx wrangler deploy --config generated/routing.json
npx wrangler secret bulk generated/routing.secrets.json --config generated/routing.json
