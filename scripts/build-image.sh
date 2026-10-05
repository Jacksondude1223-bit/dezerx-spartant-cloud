#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -f app/artisan
test -f app/composer.lock
: "${SPARTAN_IMAGE_TAG:?}"
docker build --pull -f runtime/Dockerfile -t "$SPARTAN_IMAGE_TAG" .
docker push "$SPARTAN_IMAGE_TAG"
docker inspect --format '{{index .RepoDigests 0}}' "$SPARTAN_IMAGE_TAG"
