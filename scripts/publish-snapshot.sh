#!/usr/bin/env bash
# 把 dev 的当前树压成一个快照提交到 main 并推送。
#
# 为什么这样分：
#   - 对外仓库（用户的 GitHub）只需要"能部署的最终版"，不需要开发过程记录；
#   - 但本地 dev 必须保留完整历史：drill / export-series 依赖它把补丁重放到上游新 tag 上。
# 所以 main 是一个"快照分支"（每次发布一个提交，父提交是上一个快照），dev 是真正的开发线。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEV="${DEV:-dev}"
PUB="${PUB:-main}"
REMOTE="${REMOTE:-starbridge}"
VERSION="$(tr -d '[:space:]' < PRODUCT_VERSION)"
BASE="$(./scripts/upstream-sync.sh base)"

current="$(git branch --show-current)"
if [ "$current" != "$DEV" ]; then
  echo "ERROR: 必须在 $DEV 上运行（当前是 $current）。快照只能从开发线生成。" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: 工作树不干净，先提交或清理：" >&2
  git status --short >&2
  exit 1
fi

tree="$(git rev-parse "$DEV^{tree}")"
msg="$(printf '星桥 StarBridge %s（上游基线 %s）\n\n由 dev 快照生成：对外仓库只放可部署的成品，不含开发历史。\n完整历史与上游祖先链在本地 dev 分支，drill 依赖它重放新 tag。' "$VERSION" "$BASE")"

# 以远端 main 的最新提交为父，保证 fast-forward（main 受保护、禁止 force-push）。
# 首个快照没有父提交，因此对外历史从这一条开始——正是"清空重传"要的效果。
parent=""
if [ "${SNAPSHOT_ROOT:-0}" = "1" ]; then
  # 清空重建：显式要求本次快照是根提交（对外历史从此开始）。用它会改动远端历史，
  # 所以远端 main 必须先临时解除保护，推完再恢复。
  echo "==> SNAPSHOT_ROOT=1：本次生成根提交"
elif git fetch --quiet "$REMOTE" "$PUB" 2>/dev/null; then
  parent="$(git rev-parse FETCH_HEAD)"
fi
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "==> 远端 $PUB 的内容已经和 $DEV 一致（$VERSION），无需发布"
else
  commit="$(printf '%s' "$msg" | git commit-tree "$tree" ${parent:+-p "$parent"})"
  git branch -f "$PUB" "$commit"
  echo "==> 快照 $PUB = $(git rev-parse --short "$commit")（$VERSION / $BASE，父=${parent:-无，根提交}）"
fi

if [ "${SNAPSHOT_ROOT:-0}" = "1" ]; then
  echo "==> 推送 $PUB 到 $REMOTE（根提交重建：必须强推，先确保远端保护已临时解除）"
  git push --force "$REMOTE" "$PUB:$PUB"
else
  echo "==> 推送 $PUB 到 $REMOTE（fast-forward，不需要强推）"
  git push "$REMOTE" "$PUB:$PUB"
fi

tag="starbridge-$VERSION"   # 带上品牌前缀：裸 v<版本> 会和上游自己的历史 tag 撞名
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "==> tag $tag 已存在，指向 $(git rev-parse --short "refs/tags/$tag")"
else
  git tag -a "$tag" -m "星桥 StarBridge $VERSION（上游基线 $BASE）" "$PUB"
  git push "$REMOTE" "$tag"
fi

echo "==> 完成：远端 $PUB 已更新为 $VERSION"
echo "    下一步（发 Release 时）：gh release create $tag --repo <owner>/<repo> --notes-file <notes>"
