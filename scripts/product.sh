#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_ENV="${COMPOSE_ENV:-.env}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.poc.yml}"

require_env() {
  if [ ! -f "$COMPOSE_ENV" ]; then
    echo "missing $COMPOSE_ENV; run: cp .env.product.example .env" >&2
    exit 1
  fi
  if grep -q 'change-me' "$COMPOSE_ENV"; then
    echo "WARNING: $COMPOSE_ENV still contains change-me secrets" >&2
  fi
}

usage() {
  cat >&2 <<'EOF'
usage: ./scripts/product.sh <command>

  image    build the patched product image
  up       start the compose stack (uses .env)
  down     stop the compose stack
  ps       show compose status
  logs     follow new-api logs
  status   show upstream sync status
  check    quick backend/patch checks (reuse web/dist)
  check-full  build frontend + typecheck + backend checks
EOF
  exit 2
}

case "${1:-}" in
  image) ./scripts/build-image.sh ;;
  up) require_env; docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" up -d ;;
  down) require_env; docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" down ;;
  ps) require_env; docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" ps ;;
  logs) require_env; docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" logs -f new-api ;;
  status) ./scripts/upstream-sync.sh status ;;
  check) ./scripts/upstream-sync.sh check ;;
  check-full) ./scripts/upstream-sync.sh check-full ;;
  *) usage ;;
esac
