#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/QuantumNous/new-api.git}"
PATCH_DIR="${PATCH_DIR:-patches}"
LEGACY_DIR="${LEGACY_DIR:-patches/legacy}"
PATCH_FILE="${PATCH_FILE:-$LEGACY_DIR/channel-daily-limit.working-tree.patch}"
# The branch/commit series (patches/series) is the primary mechanism; these
# file patches are the pre-commit baseline kept for reference and for
# USE_SERIES=0 replays.
PATCH_FILES="${PATCH_FILES:-$LEGACY_DIR/0001-daily-limit-core.patch $LEGACY_DIR/0002-daily-limit-web.patch $LEGACY_DIR/0003-console-block-adaptation.patch}"
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

# Commit-derived series: the durable form now that the product layer lives on a
# branch. format-patch keeps author/date per change, so an upgrade replays the
# same history instead of one opaque working-tree diff.
UPSTREAM_BASE="${UPSTREAM_BASE:-v1.0.0-rc.46}"
SERIES_DIR="${SERIES_DIR:-$PATCH_DIR/series}"

series_change_files() {
  local base="${1:-$UPSTREAM_BASE}"
  git diff --name-only "$base"..HEAD | while IFS= read -r path; do
    [ -n "$path" ] || continue
    is_functional_path "$path" && echo "$path"
  done
}

series_covered_files() {
  cat "$SERIES_DIR"/*.patch | grep -E '^diff --git a/' | sed -E 's|^diff --git a/[^ ]+ b/||' | sort -u
}

cmd_export_series() {
  local base="${1:-$UPSTREAM_BASE}"
  if ! git rev-parse --verify --quiet "$base" >/dev/null; then
    echo "unknown base ref: $base (set UPSTREAM_BASE)" >&2
    return 1
  fi
  if [ -z "$(git status --porcelain)" ] && [ "$(git log --oneline "$base"..HEAD | wc -l)" -eq 0 ]; then
    echo "no commits above $base" >&2
    return 1
  fi
  mkdir -p "$PATCH_DIR"
  rm -rf "${SERIES_DIR:?}"
  mkdir -p "$SERIES_DIR"
  git format-patch --binary "$base"..HEAD -o "$SERIES_DIR"
  cmd_verify_series "$base"
}

cmd_verify_series() {
  local base="${1:-$UPSTREAM_BASE}"
  if [ ! -d "$SERIES_DIR" ] || ! ls "$SERIES_DIR"/*.patch >/dev/null 2>&1; then
    echo "no series found in $SERIES_DIR; run: $0 export-series [$base]" >&2
    return 1
  fi
  local covered want missing="" extra=""
  covered="$(series_covered_files)"
  want="$(series_change_files "$base")"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    echo "$covered" | grep -qxF "$path" || missing="$missing $path"
  done <<< "$want"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    is_functional_path "$path" || continue
    echo "$want" | grep -qxF "$path" || extra="$extra $path"
  done <<< "$covered"
  echo "series: $SERIES_DIR ($(ls "$SERIES_DIR"/*.patch | wc -l) patches, base $base)"
  echo "functional files covered: $(echo "$covered" | grep -c .)"
  if [ -n "$missing" ]; then
    echo "NOT COVERED by series:$missing" >&2
    return 1
  fi
  if [ -n "$extra" ]; then
    echo "series contains files outside the commit range:$extra" >&2
    return 1
  fi
  dirty=""
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    is_functional_path "$path" && dirty="$dirty $path"
  done < <(git status --porcelain | sed -E 's/^.{3}//' | sed -E 's/^.* -> //')
  if [ -n "$dirty" ]; then
    echo "uncommitted functional changes:$dirty" >&2
    echo "commit them before exporting, or the series will not match the branch" >&2
    return 1
  fi
  echo "export-series: OK (commits == series)"
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

# Is this directory a detached, fully committed replay worktree that a previous
# drill left behind? Only then may apply drop it automatically: a checked-out
# branch or any uncommitted tracked change means someone is working there.
is_stale_replay_worktree() {
  local dir="$1" tag="$2"
  [ -f "$dir/.git" ] || return 1
  grep -qiF ".git/worktrees/$(basename "$dir")" "$dir/.git" || return 1
  git -C "$dir" symbolic-ref -q HEAD >/dev/null && return 1
  [ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ] || return 1
  git -C "$dir" merge-base --is-ancestor "$tag" HEAD >/dev/null 2>&1 || return 1
  return 0
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
    if [ "${REPLAY_CLEANUP:-1}" = "1" ] && is_stale_replay_worktree "$target" "$tag"; then
      # --force only clears generated leftovers (web/dist, node_modules); the
      # predicate above already proved there is no uncommitted tracked change.
      echo "==> dropping stale replay worktree: $target"
      git worktree remove --force "$target" || {
        echo "failed to remove stale replay worktree: $target" >&2
        exit 1
      }
      git worktree prune
    else
      echo "target exists but is not a clean detached replay of $tag: $target" >&2
      echo "  inspect it yourself; REPLAY_CLEANUP=0 keeps this refusal behaviour explicit" >&2
      exit 1
    fi
  fi
  git worktree add "$target" "$tag"
  # patches/series is generated, not tracked: build it from the branch if absent.
  if [ "${USE_SERIES:-1}" = "1" ] && ! ls "$ROOT/$SERIES_DIR"/*.patch >/dev/null 2>&1; then
    echo "==> no series found, exporting from $UPSTREAM_BASE"
    (cd "$ROOT" && cmd_export_series "$UPSTREAM_BASE") || exit 1
  fi
  (
    cd "$target"
    if [ "${USE_SERIES:-1}" = "1" ] && ls "$ROOT/$SERIES_DIR"/*.patch >/dev/null 2>&1; then
      echo "applying commit series from $SERIES_DIR with git am -3"
      git am -3 --no-keep-cr "$ROOT/$SERIES_DIR"/*.patch
    else
      for patch in $PATCH_FILES; do
        echo "applying $patch"
        git apply --3way "$ROOT/$patch"
      done
    fi
    # Renormalize the working tree: line-ending rules introduced by a later
    # commit do not retroactively convert files written by an earlier one, so a
    # replay can leave CRLF scripts that fail to run. Safe only on a freshly
    # replayed worktree, so refuse when anything is uncommitted.
    if [ -z "$(git status --porcelain)" ]; then
      git rm -r --cached -q . && git reset --hard -q
      echo "==> working tree renormalized"
    else
      echo "skip renormalize: worktree not clean" >&2
    fi
  ) || {
    echo "replay failed; resolve in: $target" >&2
    echo "  series mode: git am --abort to back out, or USE_SERIES=0 for file patches" >&2
    exit 1
  }
  echo "created: $target"
  # A commit series already carries the product layer; only fill it in when the
  # replay used file patches (or the target lacks the layer).
  if [ "${COPY_TOOLING:-1}" = "1" ] && [ ! -e "$target/scripts/upstream-sync.sh" ]; then
    echo "==> copying product layer"
    cmd_tooling "$target"
  fi
  echo "next: $0 check $target"
}

case "${1:-status}" in
  status) cmd_status ;;
  export) cmd_export ;;
  export-series) cmd_export_series "${2:-}" ;;
  verify-series) cmd_verify_series "${2:-}" ;;
  verify-patch) cmd_verify_patch "${2:-}" ;;
  tooling) cmd_tooling "${2:-}" ;;
  check) cmd_check "${2:-$ROOT}" ;;
  check-full) cmd_check_full "${2:-$ROOT}" ;;
  apply) cmd_apply "${2:-}" ;;
  *)
    echo "usage: $0 {status|export|export-series [base]|verify-series [base]|verify-patch [file]|tooling <dir>|check [dir]|check-full [dir]|apply <tag>}" >&2
    echo "  apply replays patches/series with git am -3 by default (base: UPSTREAM_BASE)" >&2
    echo "  USE_SERIES=0 falls back to PATCH_FILES; PATCH_FILES overrides the file-patch list" >&2
    echo "  COPY_TOOLING=0 skips copying the product layer into a new worktree" >&2
    exit 2
    ;;
esac
