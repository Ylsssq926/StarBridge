#!/usr/bin/env bash
# Backup/restore rehearsal, Postgres flavour.
#
# It dumps the live application database, restores that dump into a throwaway
# database in the same container, and compares the two. The live database is
# only ever read; anything this script drops is name-guarded to nap_restore_*.
#
# SQLite and MySQL are not covered here: their end-to-end behaviour (including
# the SQLite WAL three-file copy) is exercised by
# scripts/verify-minimal-deployment.mjs, see docs/OPERATIONS.md §8.
#
#   ./scripts/backup-drill.sh                      # dump + restore + compare
#   BOOT_CHECK=1 ./scripts/backup-drill.sh         # also boot the app on the restored DB
#   KEEP=1 ./scripts/backup-drill.sh               # keep the dump and the side database
set -euo pipefail
# Git Bash rewrites container-side paths like /tmp/x.dump into Windows paths
# before they reach docker, so the container tries to open a path that only
# exists on the host. Turn that conversion off; it is a no-op on Linux.
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PG_CONTAINER="${PG_CONTAINER:-new-api-poc-postgres}"
PG_USER="${PG_USER:-newapi}"
PG_DB="${PG_DB:-new-api}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
TS="$(date +%Y%m%d-%H%M%S)"
RESTORE_DB="${RESTORE_DB:-nap_restore_$TS}"
KEEP="${KEEP:-0}"
BOOT_CHECK="${BOOT_CHECK:-0}"
BOOT_PORT="${BOOT_PORT:-3820}"
BOOT_IMAGE="${BOOT_IMAGE:-new-api-daily-limit:local}"
BOOT_CONTAINER="nap-restore-check"

# Guard first: this script must never be able to drop the application database.
case "$RESTORE_DB" in
  nap_restore_*) ;;
  *)
    echo "refusing to use a restore target not named nap_restore_*: $RESTORE_DB" >&2
    exit 2
    ;;
esac

failures=0
SIDE_DB_CREATED=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures + 1)); }

# A monthly script must not accumulate scratch databases when it breaks half
# way. On any non-zero exit, drop the side database (name-guarded above) and the
# boot container; KEEP=1 leaves both for inspection.
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$KEEP" != "1" ]; then
    docker rm -f "$BOOT_CONTAINER" >/dev/null 2>&1 || true
    if [ "$SIDE_DB_CREATED" = "1" ]; then
      docker exec "$PG_CONTAINER" dropdb -U "$PG_USER" --if-exists "$RESTORE_DB" >/dev/null 2>&1 || true
      echo "cleaned up after failure: $RESTORE_DB" >&2
    fi
  fi
}
trap on_exit EXIT

docker_pg() { docker exec "$PG_CONTAINER" "$@"; }

# One value per invocation; -At keeps it comparable with plain diff.
scalar() {
  local db="$1" sql="$2"
  docker_pg psql -U "$PG_USER" -d "$db" -At -c "$sql" | tr -d '\r'
}

if ! docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  echo "postgres container not running: $PG_CONTAINER" >&2
  exit 1
fi

DUMP="$BACKUP_DIR/$RESTORE_DB.dump"
mkdir -p "$BACKUP_DIR"

echo "==> source database: $PG_DB (container $PG_CONTAINER)"
TABLES="$(scalar postgres "select datname from pg_database where datname='$PG_DB'")"
if [ "$TABLES" != "$PG_DB" ]; then
  echo "database $PG_DB does not exist" >&2
  exit 1
fi

echo "==> dumping"
docker_pg pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$DUMP"
DUMP_BYTES=$(wc -c <"$DUMP" | tr -d ' ')
if [ "${DUMP_BYTES:-0}" -gt 0 ]; then
  pass "dump non-empty ($DUMP_BYTES bytes at $DUMP)"
else
  fail "dump is empty"
  exit 1
fi

echo "==> creating side database $RESTORE_DB"
docker_pg createdb -U "$PG_USER" -T template0 -E UTF8 "$RESTORE_DB"
SIDE_DB_CREATED=1

echo "==> restoring into $RESTORE_DB"
docker cp "$DUMP" "$PG_CONTAINER:/tmp/restore.dump" >/dev/null
docker_pg pg_restore -U "$PG_USER" -d "$RESTORE_DB" --no-owner --exit-on-error /tmp/restore.dump
docker_pg rm -f /tmp/restore.dump
pass "pg_restore finished without errors"

echo "==> comparing table-by-table row counts"
SRC_TABLES="$(scalar "$PG_DB" "select tablename from pg_tables where schemaname='public' order by 1")"
if [ -z "$SRC_TABLES" ]; then
  fail "no public tables found in $PG_DB"
fi
mismatch=0
checked=0
while IFS= read -r table; do
  [ -n "$table" ] || continue
  checked=$((checked + 1))
  a="$(scalar "$PG_DB" "select count(*) from \"$table\"")"
  b="$(scalar "$RESTORE_DB" "select count(*) from \"$table\"")"
  if [ "$a" != "$b" ]; then
    echo "  row count differs: $table source=$a restored=$b" >&2
    mismatch=$((mismatch + 1))
  fi
done <<<"$SRC_TABLES"
if [ "$mismatch" -eq 0 ] && [ "$checked" -gt 0 ]; then
  pass "all $checked tables have identical row counts"
else
  fail "$mismatch of $checked tables differ (or source has no tables)"
fi

# The per-day budgets live inside a JSON column, so a structural restore alone
# does not prove they round-tripped.
if [ "$(scalar "$PG_DB" "select count(*) from information_schema.tables where table_name='channels'")" != "0" ]; then
  src_budgets="$(scalar "$PG_DB" "select count(*) from channels where setting like '%daily_token_limit%' or setting like '%daily_request_limit%'")"
  dst_budgets="$(scalar "$RESTORE_DB" "select count(*) from channels where setting like '%daily_token_limit%' or setting like '%daily_request_limit%'")"
  if [ "$src_budgets" = "$dst_budgets" ]; then
    if [ "$src_budgets" = "0" ] && [ "${ALLOW_VACUOUS:-0}" != "1" ]; then
      # 0 == 0 proves nothing about the JSON column surviving. Measured on the
      # 0.6.0 stack: the harness deletes its channels before this dump, so the
      # check passed vacuously while looking like a real PASS. Fail loudly and
      # say how to make it non-vacuous instead of reporting a green that isn't one.
      fail "no channel in the source carries a per-day budget: this check would be vacuous."
      echo "  seed one first: create a channel with daily_token_limit/daily_request_limit" >&2
      echo "  (panel, or node scripts/import-channels.mjs with a key in the environment)," >&2
      echo "  then re-run. Deliberately skipping it: ALLOW_VACUOUS=1 $0" >&2
      exit 1
    fi
    pass "channels carrying a per-day budget survived the round trip ($src_budgets)"
  else
    fail "per-day budget channels differ: source=$src_budgets restored=$dst_budgets"
  fi
fi

if [ "$BOOT_CHECK" = "1" ]; then
  echo "==> booting the app against $RESTORE_DB (no Redis, so counters start at zero)"
  # The password is only needed for the TCP connection from the app container;
  # psql/pg_dump over the socket inside the postgres image use trust auth.
  if [ -z "${POSTGRES_PASSWORD:-}" ] && [ -f .env ]; then
    POSTGRES_PASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | tail -1)"
  fi
  if [ -z "${POSTGRES_PASSWORD:-}" ]; then
    # No default password lives in this repo (GitGuardian flagged the old fallback
    # literal on 2026-10-26). Reading .env is the documented path; failing here is
    # better than booting the app against the restore DB with a guessed credential,
    # because that would look like a passing restore and actually prove nothing.
    echo "ERROR: POSTGRES_PASSWORD is unknown: set it in the environment or in .env" >&2
    echo "       (see .env.product.example). Deliberately skipping the boot check: BOOT_CHECK=0 $0" >&2
    exit 1
  fi
  pg_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PG_CONTAINER")"
  pg_net="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$PG_CONTAINER")"
  docker rm -f "$BOOT_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$BOOT_CONTAINER" \
    --network "$pg_net" \
    -p "127.0.0.1:$BOOT_PORT:3000" \
    -e "SQL_DSN=postgresql://$PG_USER:$POSTGRES_PASSWORD@$pg_ip:5432/$RESTORE_DB" \
    -e SESSION_SECRET=restore-check \
    "$BOOT_IMAGE" >/dev/null
  ok=""
  for _ in $(seq 1 30); do
    sleep 2
    if curl -fsS "http://127.0.0.1:$BOOT_PORT/api/status" | grep -q '"success":true'; then
      ok=1
      break
    fi
  done
  if [ -n "$ok" ]; then
    pass "restored database serves /api/status on port $BOOT_PORT"
  else
    fail "app did not become healthy against the restored database"
    docker logs --tail 20 "$BOOT_CONTAINER" >&2 || true
  fi
  docker rm -f "$BOOT_CONTAINER" >/dev/null 2>&1 || true
fi

if [ "$KEEP" = "1" ]; then
  echo "kept: $DUMP and database $RESTORE_DB"
else
  docker_pg dropdb -U "$PG_USER" "$RESTORE_DB"
  rm -f "$DUMP"
  echo "cleaned up side database and dump (KEEP=1 retains both)"
fi

if [ "$failures" -eq 0 ]; then
  echo "BACKUP DRILL OK"
else
  echo "BACKUP DRILL FAILED: $failures check(s)" >&2
  exit 1
fi
