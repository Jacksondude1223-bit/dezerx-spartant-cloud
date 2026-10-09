#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source .env
set +a
if [ "${DEPLOY_PROVISIONING_WORKER:-false}" = true ]; then
  npx wrangler deploy --config workers/wrangler.provisioning.toml
  npx wrangler secret bulk generated/provisioning.secrets.json --config workers/wrangler.provisioning.toml
fi
node workers/deploy.mjs
npx wrangler secret bulk generated/routing.secrets.json --config workers/wrangler.toml
