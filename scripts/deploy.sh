#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source .env
set +a
npx wrangler deploy --config workers/wrangler.toml
npx wrangler secret bulk generated/provisioning.secrets.json --config workers/wrangler.toml
npx wrangler deploy --config workers/wrangler.routing.toml
npx wrangler secret bulk generated/routing.secrets.json --config workers/wrangler.routing.toml
