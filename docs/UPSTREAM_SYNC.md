# 上游同步手册

## 1. 原则

- **主项目只跟上游**：`QuantumNous/new-api`。
- **私有改动只以 patch 存在**：当前为 `patches/0001` + `0002` + `0003`。
- **旁路不合并**：Kiro/Antigravity/账号池全部放在 AIClient2API / CLIProxyAPI / Sub2API。
- **每次升级都从新 tag 建 worktree**，不直接在当前工作区 rebase，避免污染。
- **升级必须过构建 + 单测 + 冒烟**，不通过就回滚。

## 2. 补丁布局

| 文件 | 内容 | 基线 |
|---|---|---|
| `patches/0001-daily-limit-core.patch` | 后端：配置、过滤器、选路、计数、结算、任务计费 | main |
| `patches/0002-daily-limit-web.patch` | 前端：渠道表单 + 7 语言 | main |
| `patches/0003-console-block-adaptation.patch` | 前端：把 `daily_token_limit` 登记进"其他设置"区块（区块跳转/已配置标记） | main + rc.46（已在带 0001+0002 的 main 工作树 `git apply --check` 通过） |
| `patches/channel-daily-limit-main.patch` | 合并版，main 基线 | main |
| `patches/channel-daily-limit.patch` | 合并版，rc.46 基线 | rc.46 |

升级时优先用分段 patch：冲突更容易定位。

## 3. 标准升级流程

### 3.1 查看状态

```bash
./scripts/upstream-sync.sh status
```

输出当前 HEAD、上游 HEAD、落后/领先提交数、工作区差异。

### 3.2 在新 tag 上建 worktree 并应用补丁

```bash
./scripts/upstream-sync.sh apply v1.0.0-rc.47
```

脚本会：

1. fetch upstream tags
2. 创建 `../new-api-v1.0.0-rc.47` worktree
3. 依次 `git apply --3way` 默认的 main 分段 patch
4. 打印后续命令

补丁基线说明：

- 默认 `PATCH_FILES` 使用 `0001` + `0002` + `0003`（main 基线）。
- 如果目标是 `v1.0.0-rc.46` 这类旧基线，使用合并补丁：

```bash
PATCH_FILES="patches/channel-daily-limit.patch" \
  ./scripts/upstream-sync.sh apply v1.0.0-rc.46
```

### 3.3 解决冲突

如果 `git apply --3way` 留下冲突：

```bash
cd ../new-api-v1.0.0-rc.47
git status
# 编辑冲突文件，保留上游新逻辑 + 日限额过滤/结算钩子
git diff --check
```

已知冲突热点：

- `dto/channel_constraints.go`：上游可能新增 `ChannelFilterKind`
- `model/channel_constraint.go`：过滤器求值顺序、switch 分支
- `service/channel_select.go`：固定渠道/亲和/随机选路的错误映射
- `service/text_quota.go`、`service/quota.go`：结算钩子
- `service/task_polling.go`：任务完成结算
- `web/src/features/channels/lib/channel-form.ts`：表单 schema/默认值/序列化
- `web/src/features/channels/components/drawers/channel-mutate-drawer.tsx`：字段渲染

### 3.4 校验

快速检查（复用主工作区的 `web/dist`，不重建前端）：

```bash
./scripts/upstream-sync.sh check ../new-api-v1.0.0-rc.47
```

发布前完整检查（在 worktree 内真实构建前端 + typecheck + 后端回归）：

```bash
./scripts/upstream-sync.sh check-full ../new-api-v1.0.0-rc.47
```

`check` 包含：

- 如果 worktree 没有 `web/dist`，优先复用主工作区的 `web/dist`；没有才构建
- `go build ./...`
- relaykit 独立构建
- 日限额单测
- 任务计费回归
- 前端 `bun run typecheck`（仅在 `web/node_modules/.bin/tsgo` 存在时；缺失会跳过）
- 可用 `SKIP_TYPECHECK=1` 强制跳过

`check-full` 包含：

- worktree 内 `bun install --frozen-lockfile`
- `bun run build`
- `bun run typecheck`
- 再跑一遍后端构建、relaykit、日限额、任务计费回归

### 3.5 冒烟

至少验证：

- [ ] `/api/status` 正常
- [ ] 普通 OpenAI 兼容渠道 chat 200
- [ ] 类型 58/59 旁路转发正确
- [ ] `/v1/images/generations` 200（mock 或真实 Key）
- [ ] 日限额：第一次 200，第二次 429，调高后恢复

### 3.6 导出新基线 patch

在目标 worktree 中：

```bash
git add -N common/channel_daily_limit.go common/channel_daily_limit_test.go \
  model/channel_daily_limit.go model/channel_daily_limit_test.go \
  service/channel_daily_limit.go

git diff --binary HEAD -- common constant dto i18n model relaykit service \
  > ../new-api-rc46/patches/0001-daily-limit-core.patch

git diff --binary HEAD -- web/src \
  > ../new-api-rc46/patches/0002-daily-limit-web.patch

git diff --binary HEAD \
  > ../new-api-rc46/patches/channel-daily-limit-main.patch
```

### 3.7 发布

1. 先改 `PRODUCT_VERSION`（补丁级修复 +0.0.1，跟上游一次基线 +0.1.0），再构建镜像：`./scripts/build-image.sh`
2. **版本 tag 不可变**：`new-api-daily-limit:<version>` 一旦对外用过就不能重新构建覆盖；内容变了必须升版本。`local` 只是本机滚动 tag。
3. 发布前门禁：`./scripts/upstream-sync.sh export && ./scripts/upstream-sync.sh verify-patch`
   （`export` 已内嵌同一次校验；`verify-patch` 采用 fail-closed：任何非产品层、非构建产物的改动没进 patch 就报错）
4. 先升级旁路（AIClient2API / Sub2API），再升级 new-api
5. 小流量验证
6. 观察 24 小时
7. 全量切换

## 4. 回滚

- 镜像回滚：保留上一个 `new-api-daily-limit:<version>` 镜像，compose 切回旧 tag。
- 数据库：升级前备份 Postgres；new-api 迁移通常向前兼容，但仍需备份。
- 旁路：AIClient2API/Sub2API 使用固定版本 tag，不追 `latest`。
- patch：保留每个上游基线对应的 patch 文件，不覆盖历史。

## 5. 监控清单

每周：

- new-api releases/tags
- Task Plugin API 变更
- `ChannelSpecialBases` 是否新增 Coding Plan
- 上游 `ChannelFilterKind` / 选路 / 结算改动

每月：

- Sub2API / CLIProxyAPI / AIClient2API release
- Kiro / Antigravity 协议变化
- 国内厂商新模型/新端点/新 Coding Plan
- 生图模型清单与价格变化

## 6. CI 建议

最小 CI 门禁：

```bash
go build ./...
(cd relaykit && GOWORK=off go build ./...)
go test ./common -run Daily -count=1
go test ./model -run 'Daily|FilterCandidate|TaskPlugin' -count=1
go test ./service -run 'TestSettle_|TestTaskBilling|TestLogTaskConsumption|TestRecalculate' -count=1
(cd web && bun run typecheck)
docker compose -f docker-compose.poc.yml config --quiet
```

可选：

- `go test ./...`（注意上游已有少量既存失败）
- `bun run test`
- `bun run lint`

## 7. 升级判定

满足以下条件才算升级成功：

- 构建/单测/类型检查全绿（允许上游既存失败单独记录）
- 核心冒烟 5 项通过
- 私有补丁冲突已解决且未扩大
- 已导出新基线 patch
- 有回滚镜像和数据库备份
