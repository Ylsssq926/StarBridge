#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/QuantumNous/new-api.git}"
PATCH_DIR="${PATCH_DIR:-patches}"
PATCH_FILE="${PATCH_FILE:-$PATCH_DIR/channel-daily-limit.patch}"
# main-based series by default. For rc.46 use:
#   PATCH_FILES="patches/channel-daily-limit.patch" ./scripts/upstream-sync.sh apply v1.0.0-rc.46
PATCH_FILES="${PATCH_FILES:-$PATCH_DIR/0001-daily-limit-core.patch $PATCH_DIR/0002-daily-limit-web.patch $PATCH_DIR/0003-console-block-adaptation.patch}"
WORKTREE_ROOT="${WORKTREE_ROOT:-$(dirname "$ROOT")}"

ensure_remote() {
  if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  fi
  git fetch "$UPSTREAM_REMOTE" \
    "+refs/heads/$UPSTREAM_BRANCH:refs/remotes/$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" \
    --tags --prune
}

cmd_status() {
  ensure_remote
  local upstream_ref="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
  echo "HEAD: $(git rev-parse --short HEAD) $(git log -1 --format=%ad --date=short)"
  if git rev-parse --verify --quiet "$upstream_ref" >/dev/null; then
    echo "Upstream: $upstream_ref $(git rev-parse --short "$upstream_ref")"
    echo "Behind upstream: $(git rev-list --count "HEAD..$upstream_ref" 2>/dev/null || echo "n/a") commits"
    echo "Custom commits: $(git rev-list --count "$upstream_ref..HEAD" 2>/dev/null || echo "n/a")"
  else
    echo "Upstream: $upstream_ref (not fetched)"
  fi
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
    echo "(shallow clone: commit counts may be incomplete; run git fetch --unshallow)"
  fi
  echo "--- working tree ---"
  git diff --stat
  echo "--- untracked ---"
  git status --short | grep '^??' || true
}

# The guard is fail-closed: every change must be in the patch unless it is part
# of the product layer or a build artifact listed here.
FUNCTIONAL_DIRS="${FUNCTIONAL_DIRS:-common constant dto i18n model relaykit service web/src}"

# Product layer copied into a new worktree on upgrade. `docs/` is upstream-owned,
# so only these files are copied; `scripts/` and `patches/` do not exist upstream.
TOOLING_FILES="${TOOLING_FILES:-PRODUCT.md PRODUCT_VERSION Dockerfile.product Makefile.product .env.product.example docker-compose.poc.yml docs/ITERATION_PLAN.md docs/UPSTREAM_SYNC.md docs/PROVIDER_MATRIX.md docs/VERIFICATION.md docs/OPERATIONS.md}"
TOOLING_DIRS="${TOOLING_DIRS:-scripts patches}"
# Build output that must never be part of a source patch.
ARTIFACT_DIRS="${ARTIFACT_DIRS:-bin data logs web/dist web/node_modules}"

is_product_layer_path() {
  local path="$1" item
  for item in $TOOLING_FILES; do
    [ "$path" = "$item" ] && return 0
  done
  for item in $TOOLING_DIRS $ARTIFACT_DIRS; do
    case "$path" in
      "$item"/*) return 0 ;;
    esac
  done
  return 1
}

is_functional_path() {
  # Fail closed: anything that is neither product layer nor build artifact has
  # to be represented in the source patch, including tracked root files such as
  # .gitignore.
  local path="$1"
  is_product_layer_path "$path" && return 1
  return 0
}

# Intent-to-add every untracked non-product file, so an added file can never be
# silently left out of the patch (the previous hardcoded list could rot).
stage_functional_untracked() {
  local path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if is_functional_path "$path"; then
      git add -N "$path"
    fi
  done < <(git status --porcelain | sed -n 's/^?? //p')
}

working_tree_functional_files() {
  # Read-only on purpose: untracked paths are listed straight from status, so a
  # verification run never mutates the index (only cmd_export stages).
  {
    git diff --name-only HEAD
    git status --porcelain | sed -n 's/^?? //p'
  } | sort -u | while IFS= read -r path; do
    [ -n "$path" ] || continue
    is_functional_path "$path" && echo "$path"
  done
}

patch_files() {
  grep -E '^diff --git a/' "$1" | sed -E 's|^diff --git a/[^ ]+ b/||'
}

cmd_verify_patch() {
  local file="${1:-$PATCH_FILE}"
  if [ ! -f "$file" ]; then
    echo "missing patch: $file" >&2
    return 1
  fi
  local missing="" extra="" covered tree
  covered="$(patch_files "$file" | sort -u)"
  tree="$(working_tree_functional_files)"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if ! echo "$covered" | grep -qxF "$path"; then
      missing="$missing $path"
    fi
  done <<< "$tree"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    is_functional_path "$path" || continue
    if ! echo "$tree" | grep -qxF "$path"; then
      extra="$extra $path"
    fi
  done <<< "$covered"
  echo "patch: $file"
  echo "functional files covered: $(echo "$covered" | grep -c . )"
  if [ -n "$missing" ]; then
    echo "NOT COVERED by patch:$missing" >&2
    return 1
  fi
  if [ -n "$extra" ]; then
    echo "patch contains files with no working-tree change:$extra" >&2
    return 1
  fi
  echo "verify-patch: OK (working tree == patch)"
}

cmd_tooling() {
  local dir="${1:-}"
  if [ -z "$dir" ]; then
    echo "usage: $0 tooling <worktree-dir>" >&2
    exit 2
  fi
  if [ ! -d "$dir" ]; then
    echo "not a directory: $dir" >&2
    return 1
  fi
  local item
  for item in $TOOLING_FILES; do
    if [ ! -f "$ROOT/$item" ]; then
      echo "skip missing: $item" >&2
      continue
    fi
    mkdir -p "$(dirname "$dir/$item")"
    cp "$ROOT/$item" "$dir/$item"
    echo "copied: $item"
  done
  for item in $TOOLING_DIRS; do
    if [ ! -d "$ROOT/$item" ]; then
      echo "skip missing: $item" >&2
      continue
    fi
    if [ -e "$dir/$item" ]; then
      echo "refusing to overwrite existing $dir/$item (copy manually)" >&2
      continue
    fi
    cp -R "$ROOT/$item" "$dir/$item"
    echo "copied: $item/"
  done
}

cmd_export() {
  mkdir -p "$PATCH_DIR"
  stage_functional_untracked
  git diff --binary HEAD > "$PATCH_FILE"
  echo "wrote $PATCH_FILE"
  git apply --stat "$PATCH_FILE" | tail -3
  cmd_verify_patch "$PATCH_FILE"
}

cmd_check() {
  local dir="${1:-$ROOT}"
  (
    cd "$dir"
    if [ ! -f web/dist/index.html ]; then
      if [ -f "$ROOT/web/dist/index.html" ]; then
        echo "==> copying web/dist from $ROOT"
        mkdir -p web/dist
        cp -R "$ROOT/web/dist/." web/dist/
      else
        echo "==> web/dist missing, building frontend"
        (cd web && bun install --frozen-lockfile && bun run build)
      fi
    fi
    go build ./...
    (cd relaykit && GOWORK=off go build ./...)
    go test ./common -run Daily -count=1
    go test ./model -run 'Daily|FilterCandidate|TaskPlugin' -count=1
    go test ./service -run 'TestSettle_|TestTaskBilling|TestLogTaskConsumption|TestRecalculate' -count=1
    if [ "${SKIP_TYPECHECK:-0}" = "1" ]; then
      echo "==> skip typecheck (SKIP_TYPECHECK=1)"
    elif [ -e web/node_modules/.bin/tsgo ]; then
      (cd web && bun run typecheck)
    else
      echo "==> skip typecheck: tsgo missing (run bun install first)"
    fi
  )
}

cmd_check_full() {
  local dir="${1:-$ROOT}"
  (
    cd "$dir/web"
    bun install --frozen-lockfile
    bun run build
    bun run typecheck
  )
  # Frontend is verified above; keep backend checks without a second typecheck.
  SKIP_TYPECHECK=1 cmd_check "$dir"
}

cmd_apply() {
  local tag="${1:-}"
  if [ -z "$tag" ]; then
    echo "usage: $0 apply <tag>" >&2
    exit 2
  fi
  ensure_remote
  local target="$WORKTREE_ROOT/new-api-$tag"
  if [ -e "$target" ]; then
    echo "target already exists: $target" >&2
    exit 1
  fi
  git worktree add "$target" "$tag"
  (
    cd "$target"
    for patch in $PATCH_FILES; do
      echo "applying $patch"
      git apply --3way "$ROOT/$patch"
    done
  ) || {
    echo "patch apply needs manual conflict resolution in: $target" >&2
    exit 1
  }
  echo "created: $target"
  if [ "${COPY_TOOLING:-1}" = "1" ]; then
    echo "==> copying product layer"
    cmd_tooling "$target"
  fi
  echo "next: $0 check $target"
}

case "${1:-status}" in
  status) cmd_status ;;
  export) cmd_export ;;
  verify-patch) cmd_verify_patch "${2:-}" ;;
  tooling) cmd_tooling "${2:-}" ;;
  check) cmd_check "${2:-$ROOT}" ;;
  check-full) cmd_check_full "${2:-$ROOT}" ;;
  apply) cmd_apply "${2:-}" ;;
  *)
    echo "usage: $0 {status|export|verify-patch [file]|tooling <dir>|check [dir]|check-full [dir]|apply <tag>}" >&2
    echo "  PATCH_FILES overrides the patch list (default: main series)" >&2
    echo "  COPY_TOOLING=0 skips copying the product layer into a new worktree" >&2
    exit 2
    ;;
esac
