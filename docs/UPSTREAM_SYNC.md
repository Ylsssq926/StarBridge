# 上游同步手册

## 1. 原则

- **主项目只跟上游**：`QuantumNous/new-api`。
- **私有改动以分支提交存在**：本地分支 `product/daily-limit`，`patches/series/` 是它的 `git format-patch` 导出。
- **重放用 `git am -3`**：保留每个改动的作者、说明与边界，冲突可 `git am --abort` 整体回退。
- **`patches/legacy/` 是 pre-commit 基线**：仅在 `USE_SERIES=0` 或需要单文件试重时参考。
- **旁路不合并**：Kiro/Antigravity/账号池全部放在 AIClient2API / CLIProxyAPI / Sub2API。
- **每次升级都从新 tag 建 worktree**，不直接在当前工作区 rebase，避免污染。
- **升级必须过构建 + 单测 + 冒烟**，不通过就回滚。

## 2. 补丁布局

| 路径 | 内容 | 基线 |
|---|---|---|
| `patches/series/00NN-*.patch` | **主机制**：分支提交序列（后端 / 前端 / 成品层 / gitattributes / 同步工具 / 品牌） | 由 `UPSTREAM_BASE`（默认 `v1.0.0-rc.46`）之上的提交生成 |
| `patches/legacy/0001-daily-limit-core.patch` | 后端：配置、过滤器、选路、计数、结算、任务计费 | main（历史） |
| `patches/legacy/0002-daily-limit-web.patch` | 前端：渠道表单 + 7 语言 | main（历史） |
| `patches/legacy/0003-console-block-adaptation.patch` | 前端：日限额登记进"其他设置"区块 | main + rc.46（历史） |
| `patches/legacy/channel-daily-limit*.patch` | 合并版工作区 diff | main / rc.46（历史） |

升级时用 series；单文件 patch 只在定位历史差异时用。

## 3. 标准升级流程

> **推荐入口：一条命令的演练。** `./scripts/upstream-sync.sh drill <ref>` 会把下面 3.2/3.4/3.5 的
> 机械步骤串起来：先从 `UPSTREAM_BASE..HEAD` 重新导出 series（顺带跑覆盖率校验），
> 再在 `../new-api-<ref>` 重放，最后跑门禁（build + 单测 + 前端 typecheck）。
> 退出码非 0 就是"这个上游版本不能直接跟"，并且会把**冲突文件清单**和
> `am --continue` / `am --abort` 的后续命令打出来，不需要人再去猜现场。
>
> ```bash
> ./scripts/upstream-sync.sh drill upstream/main      # 向前演练（不合并，只看能不能跟上）
> ./scripts/upstream-sync.sh drill v1.0.0-rc.46       # 基线自证（重放 + 门禁必须全绿）
> DRILL_SKIP_EXPORT=1 ./scripts/upstream-sync.sh drill <ref>   # 复用现有 series，不重新导出
> ```
>
> 它会改写生成物 `patches/series/`（已被 gitignore）并新建 worktree，**不会**动 product 分支；
> 端到端门禁（compose + 三个 `verify-*.mjs`）仍要按 3.5 和 `docs/VERIFICATION.md` 手工跑一次。
>
> `check` 这一段现在会把前端类型门当成真门禁：重放出来的 worktree 没有 `web/node_modules`，
> 脚本会先 `bun install --frozen-lockfile` 再跑 typecheck；若依赖装好了却找不到类型入口
> （上游换了命令），判定为**失败**而不是打一行警告。只想量冲突面、不关心类型门时显式跳过：
>
> ```bash
> SKIP_TYPECHECK=1 ./scripts/upstream-sync.sh drill upstream/main
> ```
>
> `status` 和 `drill` 都会先打一行 **overlap**：本方 series 改过的文件 ∩ 上游自基线以来改过的文件。
> 它是"先看一眼这个月有多大"的粗筛，**不是冲突数**——实测 `upstream/main` 有 18 个重叠文件，
> 真冲突只有 `model/channel_constraint.go` 一个，其余全部三方自动合并。overlap 为空则重放必然干净。

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
2. 创建 `../new-api-<tag>` worktree
3. `git am -3 --no-keep-cr patches/series/*.patch` 重放提交序列
4. 若重放用的是 file patch（`USE_SERIES=0`），再把产品层复制过去
5. 按最终的 `.gitattributes` 正规化工作区行尾
6. 打印后续命令

目标目录已存在时的处理（让演练可以无人值守重复，同时不误删在制品）：

- 只有"本仓库注册的、detached HEAD、无未提交跟踪改动、且以该 tag 为祖先"的重放树才会被自动删除重建（`--force` 只为清掉 `web/dist`、`node_modules` 这类生成物）
- 检出着分支、或有未提交跟踪改动 → 拒绝并保留现场，退出码 1
- `REPLAY_CLEANUP=0` 可关掉自动清理

失败时：

```bash
cd ../new-api-v1.0.0-rc.47
git am --abort          # 整体退回干净的 tag 状态
```

重放模式说明：

- 默认走 series（`UPSTREAM_BASE` 决定 series 的基线，默认 `v1.0.0-rc.46`）。
- 需要退回 pre-commit 的 file patch 时：

```bash
USE_SERIES=0 \
PATCH_FILES="patches/legacy/channel-daily-limit.patch" \
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

已知冲突热点（按本轮重构后的实际结构）：

> 实测锚点（2026-10-24）：把当时 20 个提交重放到比 rc.46 超前 23 个提交的 `upstream/main`，只有
> `model/channel_constraint.go` 冲突两处（`channelMatchesFilter` 的 switch、一个函数注释），
> 其余 19 个提交自动合并。解决原则：上游新增的过滤器分支原样保留，日预算继续走独立求值。
> 同一 `upstream/main`（`e835b1bfc`）上用 `drill` 复测 25 个提交的 series：阻塞点仍是 patch `0001`
> 的同一个文件。把两处热点依次解决后跑完整重放（`am --continue`）：**25 个提交全部落地，人工介入只有 2 次**
> —— `0001` 是 switch 里两个 `case` 取并集，`0011` 是一行函数注释取我方；升级树 `go build` + relaykit +
> 三组回归全绿。所以 `drill` 报第一个冲突后，按本节改完再 `am --continue`，通常不需要额外介入。
> 同一对热点在 `v1.0.0-rc.47`（53 个提交）上再次成立：人工介入仍是 2 次、仍在 `model/channel_constraint.go`
> 的两个位置（`0001` 的 switch 新增 `case` 取并集、`0011` 的函数注释取我方），见 `docs/VERIFICATION.md` §20。
> 唯一的非功能性阻塞：main 与 rc.47 的 `web/package.json` 都把 typecheck 入口改成了 `bun check -b`，
> 本地 bun 1.3.14 没有该子命令。`cmd_check` 因此**读 `web/package.json` 的 `typecheck` 脚本来决定跑什么**，
> 并分开报两种失败：`the type gate DID NOT RUN`（本机工具链跑不了这个入口，CI 用 `bun-version: latest` 覆盖它）
> 与 `typecheck FAILED`（真实类型错误）。只想量冲突面时用 `SKIP_TYPECHECK=1` 明确跳过，别把它当"验过了"。
> `apply` 现在接受任意 ref（`./scripts/upstream-sync.sh apply upstream/main` → 目录名里的斜杠会被换成连字符）。

- `common/channel_daily_limit.go`：多指标计数（tokens / requests）与 Redis 不可用时的回退
- `dto/channel_constraints.go`：上游可能新增 `ChannelFilterKind`
- `model/channel_constraint.go`：**日预算已从 `filterEvalOrder` 解耦**，单独在 `ChannelSatisfiesFilters` 与 `filterCandidateIDs` 开头求值；上游若重排该列表，保持"日预算先于请求过滤器"即可
- `model/channel_daily_limit.go`：`channelDailyLimitViolation` / `IsDailyLimitKind` / 两个哨兵错误
- `model/ability.go`：数据库选路的 `filterAbilitiesByConstraints` 归因与 `GetChannel` 哨兵
- `model/channel_cache.go`：内存缓存选路的 `dailyEmptiedBy`
- `service/channel_select.go`：固定渠道 / 亲和 / 随机选路三处的 429 映射（`dailyLimitExceededError` 按 kind 选码）
- `service/text_quota.go`、`service/quota.go`：结算钩子（token 与 request 两个计数）
- `service/task_billing.go`、`service/midjourney.go`：**任务提交即计入请求数**（不依赖 token 回报）
- `service/task_polling.go`：任务完成结算的 token 累加
- `web/src/features/channels/lib/channel-form.ts`：表单 schema/默认值/序列化
- `web/src/features/channels/lib/channel-configuration.ts`：新字段必须登记进 `extraSettings.fields` 与 configured 判定，否则面板行为回归
- `web/src/features/channels/components/drawers/channel-mutate-drawer.tsx`：字段渲染 + 一次「每日预算用量」只读块的挂载（`channelId` 有效时渲染）
- `web/src/features/channels/api.ts`：`getChannelDailyUsage()` 与 `ChannelDailyUsage` 类型（上游改响应封装时要跟着看）
- `web/src/features/channels/lib/channel-actions.ts`：`channelsQueryKeys.dailyUsage(id)`；上游若重排 query keys 需保持互不覆盖
- `web/src/features/channels/components/drawers/channel-daily-usage.tsx`：新增组件，上游不会改，但升级后要确认 `requireServerSuccess` 仍返回整个信封（组件按 `data.data` 取值）
- `web/src/i18n/locales/*.json`：7 个 locale 各 6 个 key，位置在 `Daily Token Limit` 同层。加 key 只能用文本插入——`bun run i18n:sync` 会把 key 追加到命名空间外、重排文件并重新转义受 Rule 5 保护的 `footer.newapi.*` 署名 key
- `.gitattributes`、`.github/workflows/product-gates.yml`：行尾规则与门禁清单

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
- 前端 `bun run typecheck`：worktree 里没有 `web/node_modules` 时先 `bun install --frozen-lockfile` 再跑（实测 1187 包 / 178s）。跑什么由 `web/package.json` 里的 `typecheck` 脚本决定（rc.46 是 `tsgo -b`，rc.47/main 是 `bun check -b`），**不认具体二进制**；失败分两类报：入口在本机不可用 → `the type gate DID NOT RUN`，真实类型错误 → `typecheck FAILED`。两类都是非 0 退出，绝不"缺失即跳过"
- 可用 `SKIP_TYPECHECK=1` 强制跳过（只量冲突面时用），跳过时会打印 `typecheck: skipped`

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

### 3.6 导出新基线 series

在新 worktree 里把提交落到分支后（或直接在主工作区）：

```bash
# 基线 tag 变了就传新的
./scripts/upstream-sync.sh export-series v1.0.0-rc.47
# 只校验不重写
./scripts/upstream-sync.sh verify-series v1.0.0-rc.47
```

`export-series` 做三件事：`git format-patch --binary` 生成 `patches/series/`、比对提交范围与
series 覆盖的文件集合（fail-closed：任何非产品层、非构建产物的改动没进 series 就报错）、
并拒绝在有未提交功能改动的状态下导出。

旧的 `export` / `verify-patch`（工作区 diff）仍在，只用于 pre-commit 场景。

### 3.7 发布

1. 先改 `PRODUCT_VERSION`：补丁级修复 `+0.0.1`，新增用户可见功能 `+0.1.0`，跟一次上游基线 `+0.x.0` 后视情况进位。然后构建镜像：`./scripts/build-image.sh`
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
- 重放：`git am --abort` 让 worktree 回到干净 tag；`patches/series/` 按基线目录保留，不覆盖历史。

## 5. 监控清单

每周：

- new-api releases/tags
- Task Plugin API 变更
- `ChannelSpecialBases` 是否新增 Coding Plan
- 上游 `ChannelFilterKind` / 选路 / 结算改动

每周（不是每月——上游 rc.44/45/46/47 分别发在 10-12/10-17/10-21/10-25，实测间隔 4~5 天，
按月跑会把一个月的上游改动积累成一次大冲突，见 `docs/VERIFICATION.md` §20）：

- `./scripts/upstream-sync.sh drill upstream/main`：上游可跟性演练（冲突面 + 构建 + 回归 + 类型门），非 0 退出即代表"这一版要人工处理"，输出里直接给出冲突文件清单
- Sub2API / CLIProxyAPI / AIClient2API release
- Kiro / Antigravity 协议变化
- 国内厂商新模型/新端点/新 Coding Plan
- 生图模型清单与价格变化

## 6. CI 建议

最小 CI 门禁：

```bash
./scripts/upstream-sync.sh verify-series        # 提交范围 == patches/series（fail-closed）
go build ./...
(cd relaykit && GOWORK=off go build ./...)
go test ./common -run Daily -count=1
go test ./model -run 'Daily|FilterCandidate|TaskPlugin' -count=1
go test ./service -run 'TestSettle_|TestTaskBilling|TestLogTaskConsumption|TestRecalculate' -count=1
(cd web && bun run typecheck)
docker compose -f docker-compose.poc.yml config --quiet
```

以上清单已落地为 `.github/workflows/product-gates.yml`（独立于上游 `ci.yml`，避免扩大冲突面），三个 job：

- `backend`：主模块 + relaykit 构建，日限额 / 选路 / 任务计费回归
- `frontend`：`bun install --frozen-lockfile` + `typecheck` + 渠道单测，并保留 `web/dist` 产物
- `sync-integrity`：`status`（含 overlap）→ `export-series` → `verify-series` → 把 series 重放到基线 tag 的工作树 → 在该工作树里调用**同一个** `upstream-sync.sh check`（build + relaykit + 三组回归 + 类型门）→ 用示例 env 校验 compose

  这里刻意让 CI 调脚本、而不是在 YAML 里重抄一遍 `go build`/`go test`：两边的门禁定义只有一份，
  本地 `drill` 绿什么，CI 就绿什么。重放树需要 `bun`（`check` 会装依赖跑类型门），所以 job 里显式 `setup-bun`。

CI 与 `drill` 的分工：CI 只在**基线 tag** 上重放（那一路必然干净，验证的是"补丁与分支一致"）；
`drill <更新的上游 ref>` 是本机才做的事——它回答"下一版上游能不能跟、要改哪几处"，CI 不跑那个 ref，
也不该跑（失败是预期结果，会把门禁刷红）。

另有一个 `.github/workflows/upstream-drill.yml`：每周日 03:00 UTC 把 series 重放到最新
`upstream/main` 并跑门禁，`continue-on-error` + 把 overlap / `DRILL OK|FAILED` / 冲突文件写进
step summary 与日志产物。它是**信号不是红绿灯**（失败也整绿，⚠ 在步骤上）。
两个实操前提：`schedule` 只在仓库**默认分支**生效（`product/daily-limit` 已是默认分支）；
而且 GitHub **只有在你推一个改动该文件的提交之后**才把它列进 `GET /actions/workflows`，
在那之前 `workflow_dispatch` 都会 404。演练结论仍要有人看，别把它当成"跑过了就没事"。

一条只有 CI 演练才暴露的规则：`main.go` 用 `go:embed web/dist`，**重放出的工作树若没有前端产物，`go build ./...` 会直接失败**。`upstream-sync.sh check` 会自动复用或构建 `web/dist`；CI 的 `sync-integrity` job 与上游 `ci.yml` 一样自建一个占位 `web/dist/index.html`（不再跨 job 传 artifact——第一版传的是一个根本没构建过的空目录，runner 上直接 `Artifact not found`，见 `docs/VERIFICATION.md` §19）；手工在新工作树里跑 `go build` 也要先准备它。

端到端门禁（需要 compose 栈 + `node scripts/mock-upstream.cjs`，发布前手工执行）：

```bash
node scripts/verify-daily-limit.mjs      # 日限额 14 项边界（两个预算）
node scripts/verify-compat.mjs           # 协议/接线 7 项
node scripts/verify-channel-types.mjs    # 17 种渠道类型的面板适配
docker run -d --name nap-sqlite -p 127.0.0.1:3811:3000 new-api-daily-limit:<version>
node scripts/verify-minimal-deployment.mjs   # SQLite 最小部署形态 10 项
docker rm -f nap-sqlite
EXPECT_DB=mysql KEY_CMD=/tmp/nap-mysql-key.sh \
  node scripts/verify-minimal-deployment.mjs http://localhost:3812 nap-mysqlapp  # 换引擎复跑
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
- 已导出并校验新基线 series（`verify-series` 通过，提交范围与 patches/series 一致）
- 有回滚镜像和数据库备份
