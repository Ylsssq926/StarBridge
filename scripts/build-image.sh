#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${IMAGE:-new-api-daily-limit:local}"
GOARCH="${GOARCH:-amd64}"
VERSION="$(cat PRODUCT_VERSION 2>/dev/null | tr -d '[:space:]')"
VERSION="${VERSION:-0.1.0}"
VERSION_IMAGE="${VERSION_IMAGE:-new-api-daily-limit:$VERSION}"
# Distribution alias. The code keeps its upstream identity (module paths,
# LICENSE, NOTICE); this tag only names our re-distributable build.
BRAND_IMAGE="${BRAND_IMAGE:-starbridge-gateway}"

for cmd in go bun docker; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required command: $cmd" >&2
    exit 1
  fi
done

echo "==> build frontend"
(cd web && bun install --frozen-lockfile && bun run build)

echo "==> build linux binary (version=$VERSION arch=$GOARCH)"
mkdir -p bin
CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" \
  go build -trimpath \
  -ldflags "-s -w -X 'github.com/QuantumNous/new-api/common.Version=$VERSION'" \
  -o bin/new-api-linux .

echo "==> build image $IMAGE (also $VERSION_IMAGE and $BRAND_IMAGE)"
docker build -f Dockerfile.product \
  -t "$IMAGE" -t "$VERSION_IMAGE" \
  -t "$BRAND_IMAGE:local" -t "$BRAND_IMAGE:$VERSION" \
  .

echo "done: $IMAGE, $VERSION_IMAGE, $BRAND_IMAGE:local, $BRAND_IMAGE:$VERSION"
