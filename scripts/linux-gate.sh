#!/usr/bin/env bash
# Cross-platform gate: re-run the tooling and backend checks inside Linux
# containers, because the repository is developed on Windows + Git Bash while
# CI and production are Linux. Two platform-specific traps are already baked in:
#
#   * Git Bash rewrites docker arguments that look like POSIX paths
#     (-w /repo becomes C:/Program Files/Git/repo) -> MSYS_NO_PATHCONV=1
#   * in the golang image `bash -lc` resets PATH, so `go` is not found -> use
#     `bash -c` and export /usr/local/go/bin
#
# Read-only against the working tree: it never commits, never rewrites files,
# and leaves no containers behind.
#
#   ./scripts/linux-gate.sh              # shell + node + sync status + go gates
#   SKIP_GO=1 ./scripts/linux-gate.sh    # only the Node/shell layer
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm}"
GO_IMAGE="${GO_IMAGE:-golang:1.26-bookworm}"

echo "==> mounting $ROOT into $NODE_IMAGE"
docker run --rm -v "$ROOT:/repo" -w /repo "$NODE_IMAGE" bash -c '
set -e
git config --global --add safe.directory /repo
echo "node: $(node --version)  OS: $(uname -sr)"
bash -n scripts/upstream-sync.sh
bash -n scripts/product.sh
bash -n scripts/backup-drill.sh
bash -n scripts/build-image.sh
echo "SHELL_SYNTAX_OK_LINUX"
for f in scripts/*.mjs; do node --check "$f"; done
echo "NODE_CHECK_OK_LINUX: $(ls scripts/*.mjs | wc -l) harnesses"
./scripts/upstream-sync.sh status | grep -E "^(HEAD|Upstream|Behind|Custom|overlap with)"
'

if [ "${SKIP_GO:-0}" != "1" ]; then
  echo "==> mounting $ROOT into $GO_IMAGE"
  docker run --rm -v "$ROOT:/repo" -w /repo "$GO_IMAGE" bash -c '
set -e
export PATH=/usr/local/go/bin:$PATH
export CGO_ENABLED=0
git config --global --add safe.directory /repo
echo "go: $(go version)"
go build ./...
(cd relaykit && GOWORK=off go build ./...)
echo "GO_BUILD_OK_LINUX (main + relaykit)"
go test ./common -run Daily -count=1
go test ./model -run "Daily|FilterCandidate|TaskPlugin" -count=1
go test ./service -run "TestSettle_|TestTaskBilling|TestLogTaskConsumption|TestRecalculate" -count=1
'
fi

echo "LINUX GATE OK"
echo "not covered here: GitHub hosted runner, frontend typecheck/vitest on Linux, compose stack rebuild"
