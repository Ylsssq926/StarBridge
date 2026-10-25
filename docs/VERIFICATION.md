# 验证记录

记录时间：2026-10-24
基线：new-api `v1.0.0-rc.46` / `main 33c61a24`

## 1. 上游差距

| 项 | 值 |
|---|---|
| 本地旧基线 | `20d3e737`（2026-05-20） |
| 旧 fork HEAD | `ac98d145`（2026-05-23） |
| 上游 main | `33c61a24`（2026-10-23） |
| 落后提交 | 841 |

结论：旧 fork 不再作为主项目，改从 rc.46/main 重建。

## 2. 构建与测试

| 验证 | 命令 | 结果 |
|---|---|---|
| 主模块构建 | `go build ./...` | 通过 |
| relaykit 独立构建 | `cd relaykit && GOWORK=off go build ./...` | 通过 |
| 日限额单测 | `go test ./common -run Daily` | 通过 |
| 选路/任务单测 | `go test ./model -run 'Daily|FilterCandidate|TaskPlugin'` | 通过 |
| 任务计费回归 | `go test ./service -run 'TestSettle_|TestTaskBilling|TestLogTaskConsumption|TestRecalculate'` | 通过 |
| 前端类型检查 | `cd web && bun run typecheck` | 通过 |
| 前端 lint（整树） | `bun run lint` → 66 warnings / 158 errors；**纯净 rc.46 基线用同一 oxlint 1.74.0 跑出完全相同的 66/158**，即上游既存状态，本项目未新增任何一条 |
| 前端 lint（本方改动文件） | 5 个文件（`channel-configuration.ts` / `channel-form.ts` / `types.ts` / `channel-mutate-drawer.tsx` / 其测试）→ **0 warning / 0 error**；该检查已作为 CI 步骤固定下来 |
| 渠道组件测试 | `bunx vitest run src/features/channels` | 358 passed（29 个文件） |
| 完整同步校验 | `./scripts/upstream-sync.sh check-full` | 前端构建 + typecheck + 后端回归通过 |
| 全量后端测试 | `go test ./common ./model ./service ./dto` | 仅 2 个既存失败（见下），其余通过 |
| relaykit 模块测试 | `cd relaykit && GOWORK=off go test ./...` | 9 个包全部通过 |
| 新鲜 worktree 全量校验 | `PATCH_FILES=patches/channel-daily-limit.patch ./scripts/upstream-sync.sh apply v1.0.0-rc.46` + `check-full <worktree>` | 补丁自动落地 → `bun install --frozen-lockfile` + `rsbuild build` + `tsgo -b` + `go build` + 定向回归全部通过 |
| 成品镜像与源码一致 | `./scripts/build-image.sh` 后重建容器 | 镜像层内容哈希不变（同一份源码 → 同一份二进制） |

已知既存失败（纯净 rc.46 同样失败，与补丁无关）：

- `TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode`
- `TestObserveChannelAffinityUsageCacheByRelayFormat_UnsupportedModeKeepsEmpty`

## 3. 补丁重放

| 验证 | 结果 |
|---|---|
| 应用到纯净 rc.46 | `git apply --check` 通过，构建 + 单测通过 |
| 直接应用到最新 main | 3 个文件冲突（上游新增 `FilterTaskPluginEndpoint`） |
| 三方合并后应用到 main | 冲突解决，`go build ./...` 通过 |
| 纯净 main 按序应用 `0001` + `0002` | 应用成功、构建成功、单测通过 |
| 纯净 tag 应用 rc.46 补丁（真实 tag，非本地分支） | `git worktree add` + `git apply --3way` 全部 clean，构建与单测通过 |
| **向前升级到最新 main（23 commits 超前）** | 20 个提交逐个 `git am -3` 重放：**只有 `model/channel_constraint.go` 两处冲突** —— ① `channelMatchesFilter` 的 switch 需要同时保留上游新增的 `FilterTaskPluginEndpoint` 分支与我们的 `FilterDailyTokenLimit` 分支；② 一处函数注释文案。其余 19 个提交全部自动合并 |
| 升级后功能正确性 | `go build ./...` 通过（需先准备 `web/dist`）、relaykit 独立构建通过、common/model/service 定向回归全绿；合并结果保留上游新过滤器、日预算仍走独立求值 |
| 演练暴露的两个自身缺陷 | ① `apply` 在 `git am` 冲突后仍继续并返回成功——`( … ) || { … }` 这个左侧上下文中 `set -e` 被抑制；已给每个可失败命令加显式 `|| exit 1`，回归验证 `APPLY_EXIT=1` 且不再打印 `created:`/`copied:`。② main 上 `web/package.json` 的 typecheck 入口变成 `bun check -b`，本地 bun 1.3.14 无 `check` 子命令 → 该 ref 上类型门实际不可用；`check` 已把"静默跳过 tsgo 缺失"改成响亮告警（该告警在下一轮又被收紧成硬门禁，见下面最后一轮） |

| 一键升级演练 `drill` | 成功路径：`drill v1.0.0-rc.46` 退出码 0，一条命令跑完"overlap 预估(0) → 重导 23 个 patch（74 个功能文件，commits == series）→ 自动丢弃上一轮干净的重放树并重建 → `git am -3` 23 个提交全部 Applying → renormalize → `go build` + relaykit + 三组回归 → 重放树内 `bun install`（1187 包 / 163s）→ `tsgo -b` 真跑（`==> typecheck: ran`）→ `DRILL OK`"。失败路径：`drill upstream/main` 退出码 1，把第一个阻塞点原样交回给人 —— `Patch failed at 0001`、冲突文件 `model/channel_constraint.go`（1 处标记块）、已应用 0 个提交，并打印 `am --continue` / `am --abort` + `worktree remove` 的具体命令；按打印步骤回退后 `git worktree list` 只剩主工作树，无残留 |
| 未知 ref / 未提交改动的拒绝路径 | `drill v9.9.9-does-not-exist`：overlap 打印 `skipped`，随后 fail-closed 覆盖率校验发现 `.github/workflows/product-gates.yml` 有未提交功能改动 → 拒绝导出 series，退出码 1，**不建任何 worktree、无残留目录**（`.github/` 属功能层，不在产品层白名单内，所以 CI 文件的改动也必须先进提交） |
| 全量冲突面演练（跑完 25 个 patch，不止第一个阻塞点） | 在 `upstream/main`（`e835b1bfc`，超前基线 23 个提交）上把 `drill` 卡住的两处依次解决后 `am --continue`：**25 个提交全部重放成功，只有 2 次人工介入，且都落在 `model/channel_constraint.go`** —— ① patch `0001`：上游新增的 `case dto.FilterTaskPluginEndpoint` 与我们的 `case dto.FilterDailyTokenLimit` 落在同一位置，取并集即可（同 patch 其余 6 个文件已自动合并）；② patch `0011`：一处函数注释文案（上游写 "first violated filter in filterEvalOrder"，我方改成 "first violated filter kind"，因为日预算已脱离 `filterEvalOrder`）→ 取我方。结果：升级树相对 main 领先 25 个提交、改动 64 个文件，`SKIP_TYPECHECK=1 check` 退出码 0（`go build ./...` + relaykit + common/model/service 三组回归全绿），演练树用文档给出的 `worktree remove --force` 清掉，无残留 |
| main 上的前端类型门仍不可用 | 该 ref 的 `web/package.json` 是 `"typecheck": "bun check -b"`，本地 bun 1.3.14 没有 `check` 子命令 → 升级树的前端类型门跑不了，本次显式 `SKIP_TYPECHECK=1` 跳过并留痕。跟 main 之前必须二选一：把 typecheck 入口改成可运行的命令，或把本地/CI 的 bun 升到支持 `bun check` 的版本。这正是 `check` 改成硬失败之后要暴露的那类问题（迭代计划 P5 未闭环项） |
| 定时演练 workflow | `.github/workflows/upstream-drill.yml`：两个 workflow 均通过 `yaml.parse`（jobs/triggers/`continue-on-error` 逐项核对），drill 与 summarise 两个 `run` 块抽出后 `bash -n` 通过；summarise 更拿**真实日志**跑过两遍——失败演练日志渲染出 `DRILL FAILED` + 冲突文件，成功演练日志渲染出 `DRILL OK` + `overlap … 0 file(s)`。**未验证**：该 workflow 还没在 GitHub runner 上真跑过（本地无 make/无 hosted runner），且 `schedule` 只在仓库默认分支生效 |
| 类型门不再"看似通过" | 演练首轮暴露：重放树没有 `web/node_modules`，旧 `check` 打一行"上游可能换了命令"的告警就继续，类型门其实一行没跑。改为缺依赖先 `bun install --frozen-lockfile`（实测 1187 包 / 178.7s）再跑类型门，依赖齐了却找不到类型入口则**判失败**并给出 `SKIP_TYPECHECK=1` 的显式退路 |
| 重叠面预估（先知道有多大再动手） | `status` 与 `drill` 开头新增一行 overlap：`upstream/main` 与本方 series 自 `v1.0.0-rc.46` 起**双向改动的文件 18 个**（`model/channel_constraint.go`、`dto/channel_constraints.go`、i18n 三个 yaml、`service/text_quota.go`/`task_polling.go`、面板 4 个文件、7 个前端 locale）。同一轮实测证明"overlap ≠ 冲突"：18 个里只有 `channel_constraint.go` 真冲突，其余全部 3-way 自动合并 —— 因此输出明确标注"风险区，不是冲突数" |

## 4. 日限额与兼容性端到端

脚本化验证（`scripts/mock-upstream.cjs` 提供固定 usage=5+5 的假上游，`scripts/verify-daily-limit.mjs` 与 `scripts/verify-compat.mjs` 跑完自动清理渠道）：

| 场景 | 期望 | 结果 |
|---|---|---|
| 限额=10，第一次请求（usage 10） | 200 | 通过 |
| 限额=10，usage 已达上限后 | 429 `channel:daily_token_limit_exceeded` | 通过 |
| 限额改回 0（不限制） | 连续两次 200 | 通过 |
| 已有超额用量后把限额调低 | 立即 429 | 通过 |
| 把限额调高 | 同步周期内恢复 200 | 通过 |
| `daily_request_limit=1` + 生图请求（无 token 回报） | 第一次 200，第二次 429 `channel:daily_request_limit_exceeded` | 通过 |
| 清空 `daily_request_limit` | 生图渠道恢复 200 | 通过 |
| `daily_request_limit=2` + 文本请求 | 200 / 200 / 429（请求数计量，与 token 无关） | 通过 |
| 内存缓存选路（`MEMORY_CACHE_ENABLED=true`） | 14/14 | 通过（0.2.0 镜像） |
| 数据库选路（`MEMORY_CACHE_ENABLED=false`） | 14/14 | 通过 |
| 未启用 Redis（进程内回退计数） | 14/14（协议兼容 7/7 同环境通过） | 通过 |

单元层：`go test ./common -run Daily`（token/request 两个计数器互不串扰）与 `go test ./model -run 'Daily|FilterCandidate'`（两个预算的过滤器归因、预算同时耗尽时优先报 token）均通过。

协议/接线兼容（`verify-compat.mjs`，7/7）：

| 检查 | 结果 |
|---|---|
| `/v1/chat/completions` 透传 | 200 |
| `/v1/messages`（Claude 格式走 OpenAI 渠道） | 200 |
| `/v1beta/models/...:generateContent`（Gemini 格式） | 200 |
| `/v1/images/generations` | 200，返回 `data[0].url` |
| 不存在的模型 | 503 `No available channel`（与日限额 429 明确区分） |
| 无效令牌 | 401 |
| 网关 → AIClient2API（docker 网络内） | 可达，返回旁路自身的鉴权/模型响应 |

`scripts/verify-compat.mjs` 覆盖的是"同一条 OpenAI 渠道能不能收这三种格式"。另外还按上游类型逐条验证了控制台的适配（`scripts/verify-channel-types.mjs`）：每种类型都建两条渠道（一条不带日限额字段、一条同时带 `daily_token_limit` 与 `daily_request_limit`），比较两者校验结果是否一致，再回读 `setting` 并做一次无关字段更新确认两个限额都不被覆盖。

| 类型 | 面板建渠道 | 限额保存/更新后仍在 | 请求可达 | 到顶返回 429 |
|---|---|---|---|---|
| 1 OpenAI | ok | ok | 200 | 是 |
| 14 Anthropic | ok | ok | 200 | 是 |
| 16 Zhipu | ok | ok | 假上游未实现该路径 | 未断言 |
| 17 Ali | ok | ok | 200 | 是 |
| 24 Gemini | ok | ok | 200 | 是 |
| 25 Moonshot | ok | ok | 200 | 是 |
| 41 VertexAI | 需 `deployment_region`（带/不带限额结果一致） | - | - | - |
| 43 DeepSeek | ok | ok | 200 | 是 |
| 45 VolcEngine | ok | ok | 200 | 是 |
| 54 Doubao | ok | ok | 200 | 是 |
| 57 Codex | 需 OAuth JSON key（带/不带限额结果一致） | - | - | - |
| 58 Advanced Custom | ok（附 `advanced_custom` 路由） | ok | 200 | 是 |
| 59 Sub2API | ok | ok | 200 | 是 |
| 60 New API | ok | ok | 200 | 是 |
| 61 Task Plugin | ok，`task_plugin_key=alibaba` 与两个日限额字段共存且不互相覆盖 | ok | 类型 61 不走 chat | 未断言（生图改由 §4 的请求数预算验证） |
| 62 vLLM | ok | ok | 200 | 是 |
| 63 SGLang | ok | ok | 200 | 是 |

结论：17/17 类型的校验结果不因补丁改变，15/15 可路由类型到顶即 429（含旁路常用的 58/59/60）。

顺带修掉两个控制台适配缺陷（`patches/0003-console-block-adaptation.patch`）：

1. `daily_token_limit` 没登记在 `CONFIGURATION_BLOCKS.extraSettings.fields` 里 → 编辑该字段时表单会把配置区跳回 "connection"，校验错误也被归到错误的区块。
2. `configured.extraSettings` 没把限额算作"已配置" → 只设了日限额的渠道，"其他设置"区块不显示已配置标记。

回归：`tsgo -b` 通过，渠道特性单测 358 项全通过（29 个文件）。其中新增一条面板回归：编辑渠道时两个日限额字段都要从 `setting` 回读、可编辑，且编辑后仍停在"其他设置"页签（正是上面第 1、2 条缺陷的守护测试）。

**三库与首启初始化实测**（`scripts/verify-minimal-deployment.mjs`，每种引擎 10/10）：用交付镜像起一次性容器，不带 Redis、不开内存缓存，即"最小可部署形态"，逐项实测：

| 检查 | SQLite | MySQL 8.4 |
|---|---|---|
| 空库首启 | `database_type=sqlite`、`root_init=false` | `database_type=mysql`、`root_init=false` |
| 初始化向导 | `POST /api/setup` 成功 | 同 |
| 向导账号权限 | 首个账号 `id=1 role=100`，可调管理端 | 同 |
| 两个日限额保存 | `{"daily_token_limit":10}` / `{"daily_request_limit":1}` 原样落库 | 同 |
| token 预算 | 200 → 429 `channel:daily_token_limit_exceeded` | 同 |
| 请求数预算 | 生图（无 token 回报）200 → 429 `channel:daily_request_limit_exceeded` | 同 |

PostgreSQL 由常驻 PoC 栈覆盖（同一套断言在 14 项端到端脚本里通过）。

顺带查到的三条运维要点：

1. SQLite 以 WAL 模式运行，容器里主库文件只有 4KB、真实内容全在 `one-api.db-wal`（3MB）。只 `cp` 主库文件会得到"空库"，备份必须连 `-wal`/`-shm` 一起取，或先 checkpoint。
2. `mysql:8` 现在是 8.4.x，`--default-authentication-plugin` 已被移除，带上它初始化直接失败（`unknown variable`）；去掉该参数即可，驱动侧 caching_sha2_password 无需额外配置。
3. 默认 bridge 网络下容器互访被拒（`connection refused`），要用用户自定义网络（compose 本来就会建），不要用 `--link` 或裸容器 IP。

## 5. 旁路容器

| 旁路 | 实测 | 结论 |
|---|---|---|
| AIClient2API | `/health` healthy；类型 59 转发后返回 `No healthy provider found` | 转发成立，缺账号 |
| CLIProxyAPI | v8.0.41，8317；类型 58 转发后返回 `unknown provider for model gpt-test` | 转发成立，缺账号 |
| Sub2API | `/health` `{"status":"ok"}`；类型 59 转发后返回 `Invalid API key` | 转发成立，缺有效 Key/账号 |

## 6. 生图

| 验证 | 结果 |
|---|---|
| 类型 1 + mock `/v1/images/generations` | 200，返回图片 URL |
| 类型 17 + 内置 Alibaba 插件 + mock 厂商 | 200，`data[0].url` 正常 |
| 插件实际请求 | `POST /api/v1/services/aigc/multimodal-generation/generation` |
| 响应解析 | `output.choices[].message.content[].image` 正常 |

## 7. compose

| 验证 | 结果 |
|---|---|
| `docker compose config --quiet` | 通过 |
| 四服务启动 | new-api / AIClient2API / Postgres / Redis 全部 healthy |
| 容器网络 | new-api 容器内访问 `http://aiclient2api:3000/health` 成功 |
| 类型 59 转发 | 收到 AIClient2API 的 provider 错误，转发成立 |
| 修复 | 宿主 3000 冲突改为默认 3800；PoC 用 5 秒同步 |

## 8. 成品镜像与完整 compose

| 验证 | 结果 |
|---|---|
| `scripts/build-image.sh` | exit 0 |
| 镜像 | `new-api-daily-limit:local` 与 `new-api-daily-limit:0.1.0`，约 312MB |
| 版本 | `docker run --rm new-api-daily-limit:0.1.0 --version` → `0.1.0` |
| 许可证 | 镜像内包含 LICENSE、NOTICE、THIRD-PARTY-LICENSES.md |
| 直接运行（默认 SQLite） | `/api/status` 200 |
| 完整 compose（成品镜像 + Postgres + Redis + AIClient2API） | 四服务 healthy |
| 端口安全 | new-api `0.0.0.0:3800`；AIClient2API 及其 OAuth 回调仅 `127.0.0.1` |
| new-api 日志 | `using PostgreSQL as database`、`New API 0.1.0 started`、`memory cache enabled` |
| 前端 | 通过 `/api/status` 与页面访问验证 |

注意：直接 `docker run` 使用 SQLite 时不要设置裸的 `SQLITE_PATH=/data/new-api.db`（在当前环境会报 unable to open database file）；省略该变量使用默认 `one-api.db` 即可。compose 默认走 Postgres，不受影响。

## 9. 已知边界

1. **日限额计数语义**：`daily_token_limit` 只统计可计费的输入 + 输出 token（缓存命中与缓存创建不计入）；`daily_request_limit` 统计可计费的请求条数。两者都是渠道级，不是模型级。
2. **按次/任务计量覆盖**：文本、音频、WebSocket 与任务提交都会计入请求数；生图/视频等不回报 token 的任务只计入请求数，因此这类渠道要设 `daily_request_limit` 才有效。token 预算仍只覆盖“返回 token 用量”的路径。
3. **多实例一致性**：日限额依赖 Redis；未启用 Redis 时退化为进程内计数，多实例会不一致。
4. **性能**：候选渠道过滤会解析一次 `setting` JSON；渠道数量很大时应增加 `channelID -> daily limit` 缓存。
5. **PoC 安全边界**：compose 是验证环境，镜像默认 root、未启用 TLS、`SESSION_COOKIE_SECURE` 未开；生产需加反向代理、TLS、非 root、密钥管理和备份。
6. **旁路安全**：AIClient2API/Sub2API 的 OAuth 凭据价值高，UI 不应直接暴露公网；compose 已默认将 AIClient2API 端口绑定到 `127.0.0.1`，远程使用请走 SSH 隧道或带认证的反向代理。
7. **真实上游**：Kiro/Antigravity 账号、国内厂商 Key 尚未接入，属于外部凭据依赖。
8. **限额生效时机**：用量在“响应发出之后”的结算阶段写入，因此同一瞬间的并发请求可能略微超出上限（与自动禁用、额度扣减同样的最终一致语义）。验证脚本为此在两次请求间留 2s，实盘无需处理。
9. **空数据库首启**：全新库里不会自动出现 `root/12345`，需要先走 `/setup` 初始化向导（或注册后用角色提升为管理员）。SQLite 实例实测：`POST /api/setup` 成功后首个账号即 `role=100`，可直接调用管理端接口，无需手工提权；`GET /api/setup` 在初始化完成后会提前返回，`root_init`/`database_type` 不再回填。
10. **令牌 Key 不可回显**：`/api/token/` 的创建与查询只返回掩码 Key，脚本或运维要拿到明文 Key 只能在创建当次由界面复制，不能事后再取。
11. **数据库兼容**：新增代码不含裸 SQL、不加列、不改 `model/main.go` 迁移；SQLite、MySQL、PostgreSQL 三种引擎都按"最小部署形态"实测过（各 10/10，Postgres 由常驻 PoC 栈覆盖），Redis 关闭时的进程内回退也已实测。

## 10. 未验证（需要外部凭据）

- Kiro / Antigravity 真实账号登录与真实模型调用
- DeepSeek / GLM / Kimi / 豆包 / 阿里真实 Key
- 阿里 Wan/Qwen-Image、豆包 Seedream 真实出图
- Sub2API 有效 API Key + 真实账号池

这些不影响协议/架构结论，但属于上线前必须完成的真实链路验证。

## 11. 复现

```bash
# 1. 构建
go build ./...
(cd relaykit && GOWORK=off go build ./...)
(cd web && bun run typecheck)

# 2. 日限额单测
go test ./common -run Daily -count=1
go test ./model -run 'Daily|FilterCandidate|TaskPlugin' -count=1

# 3. compose 校验
docker compose -f docker-compose.poc.yml config --quiet

# 4. 补丁重放
./scripts/upstream-sync.sh apply v1.0.0-rc.47
./scripts/upstream-sync.sh check ../new-api-v1.0.0-rc.47

# 5. 端到端边界与兼容（需要 compose 栈 + 假上游）
./scripts/product.sh up
node scripts/mock-upstream.cjs &            # 监听 3999，usage 固定 5+5
node scripts/verify-daily-limit.mjs          # 10 项日限额边界
node scripts/verify-compat.mjs               # 7 项协议/接线兼容
node scripts/verify-channel-types.mjs        # 17 种渠道类型面板适配 + 限额生效
# 切换选路或关闭 Redis 复跑：
printf 'services:\n  new-api:\n    environment:\n      - MEMORY_CACHE_ENABLED=false\n' > docker-compose.poc.override.yml
docker compose -f docker-compose.poc.yml up -d --force-recreate new-api
node scripts/verify-daily-limit.mjs
rm docker-compose.poc.override.yml

# 6. 上游重放（series 是生成物，缺失时 apply 会自动导出）
./scripts/upstream-sync.sh export-series v1.0.0-rc.46
./scripts/upstream-sync.sh verify-series
./scripts/upstream-sync.sh apply v1.0.0-rc.47
./scripts/upstream-sync.sh check ../new-api-v1.0.0-rc.47
```

## 12. 文档主张 vs 证据审计

对 `PRODUCT.md` / `docs/OPERATIONS.md` 逐条核对，凡是写进文档的说法都要有实测或源码依据。本轮挑出并修掉 7 处：

| 主张 | 审计结果 |
|---|---|
| "建完渠道马上 503，等 5~10s" | 措辞含糊 → 实测成数字：立即请求 503 `model_not_found`，等 7s 同一请求 200 |
| "次日零点自动重置" | 请求数计数器实测 TTL 85079s（当天 00:22 时），确为容器本地时区零点 |
| 面板地图（页面清单与职责） | 原表按记忆写，缺 `/profile`、`/usage-logs/audit`、`/chat`、`/rankings`；`/models`、`/system-settings/operations`、`/security` 的分节名与源码 `section-registry.tsx` 不一致 → 按路由与分节 id 重写 |
| "速率限制"与日限额的关系 | 文档没区分：上游内置的是速率限制（多快），本项目新增的是当日总量（多少）→ 明确写进表里 |
| "AIClient2API 控制台可加 Kiro/Antigravity" | 根 HTML 里搜不到 provider（SPA），改以容器内 `src/ui-modules/provider-api.js`、`oauth-api.js` 含相关模块为证 |
| 镜像内含许可证 | 在 0.2.0 容器内确认 `/licenses/{LICENSE,NOTICE,THIRD-PARTY-LICENSES.md}`，`/new-api --version` → `0.2.0` |
| "私有补丁约 500 行"、"成品显示 0.1.0" | 数字过期 → 按 `git diff` 实测改写 |
| "32 个实现文件 `+622/-38`，另有 4 个测试文件 `+307`"（`PRODUCT.md` 设计原则 2） | 再次过期，且当时的过滤口径不可复现 → 换成一条可重跑的命令与结果：实现改动 25 文件 `+587/-38`，含测试与前端 locale 共 36 文件 `+929/-39`；命令写进同一条主张里，下次过期能自己被发现 |

未能用实测支撑、已改为明确标注外部依赖的说法：真实 Kiro/Antigravity 账号调用、真实国内厂商 Key 与出图（见 §10）。

## 13. 分支化与同步机制加固（分轮记录）

| 验证 | 结果 |
|---|---|
| 私有改动落在本地分支 | `product/daily-limit`，基线 `v1.0.0-rc.46` 之上 9 个提交（后端 / 前端 / 成品层 / gitattributes / 同步机制 / 品牌别名 / 行尾正规化 / series 生成物化） |
| `export-series` | 9 个 patch、68 个功能文件；提交范围与 series 覆盖一致 |
| `verify-series` 负向 | 故意留一处未提交功能改动 → `rc=1` 并指名 `model/channel_daily_limit.go`；还原后 `rc=0` |
| 干净树重放（无 series 目录） | `apply v1.0.0-rc.46` 自动导出 → `git am -3` 9 个提交全部 Applying 成功 → `==> working tree renormalized` |
| 重放后行尾 | `verify-compat.mjs` / `mock-upstream.cjs` / `verify-channel-types.mjs` CR=0（修复前 180 / 78 / 249） |
| 重放 worktree 构建 | `go build ./...` + relaykit + 日限额/选路/任务计费回归通过 |
| 成品 0.1.2 | `new-api-daily-limit:{local,0.1.2}` + 别名 `starbridge-gateway:{local,0.1.2}`；三套件复跑 10/10、7/7、15/15 |
| 版本 tag 纪律 | 0.1.0 曾被同 tag 重建覆盖（如实记录）；此后策略写入 `docs/UPSTREAM_SYNC.md` §3.7：内容变化必须升 `PRODUCT_VERSION` |
| 0.2.0 请求数预算重放 | 12 个提交在纯净 rc.46 worktree 上 `git am -3` 全部成功 → renormalize → `go build` + common/model/service 回归通过（REHEARSAL_020_OK） |
| 0.2.0 端到端 | `verify-daily-limit` 14/14（三种运行形态）、`verify-compat` 7/7、`verify-channel-types` 17/17 适配 + 15/15 到顶 429 |
| 三库最小部署形态 | `verify-minimal-deployment`：SQLite 10/10、MySQL 8.4 10/10（`/setup` 首启建管理员 role=100、两个预算原样落库、无 Redis 也能 429）；Postgres 由常驻 PoC 栈的 14 项端到端覆盖 |
| `apply` 的陈旧重放树处理 | 五条路径逐条实测：首次创建 ✓；再次 apply 自动删除干净的 detached 重放树并重建 ✓；有未提交跟踪改动时拒绝且**改动完整保留** ✓；检出分支时拒绝 ✓；`REPLAY_CLEANUP=0` 时保持拒绝 ✓ |
| 冲突热点清单 | `docs/UPSTREAM_SYNC.md` 已按重构后的结构重写（日预算与 `filterEvalOrder` 解耦、双计数落点、面板登记表、`.gitattributes`/CI 文件） |
| CI 门禁落地 | 新增 `.github/workflows/product-gates.yml`（backend / frontend / sync-integrity）；YAML 解析通过，sync-integrity 的等价命令在本地演练通过（CI_SYNC_JOB_WOULD_PASS）。演练中发现 `go:embed web/dist` 会让没有前端产物的重放工作树编译失败，改为由 frontend job 产出 dist 供 replay 使用 |
| 每月上游跟进收敛成一条命令 | `drill <ref>` = overlap 预估 + `export-series`（含覆盖率校验）+ `apply` + `check`；`cmd_apply` 里剩余的可失败路径统一从 `exit` 改为 `return`，让它能被上层组合而不炸掉调用方。`DRILL_SKIP_EXPORT=1` 复用现有 series。见 `docs/UPSTREAM_SYNC.md` §3 开头的推荐入口 |
| 本轮自审修掉的文档失真 | ①"重放告警=上游换了命令"的措辞掩盖了"依赖没装"这个真实原因；②`§13` 末句仍把"生图/按次计费任务的日限额计量"列为未闭环，而该能力已由 `daily_request_limit` 实现并被 §4 用例覆盖 → 改为只留外部凭据两项 |

自审发现的实现过程失误（同样记录，避免"只留成功叙事"）：

- 第一次 `git add` 混入了一个不存在的路径，导致该批 add 整体失败，功能提交只含 i18n 与脚本；靠提交后 `git status` 复查发现，补齐后合并进同一个功能提交。
- 给 `verify-daily-limit.mjs` 加辅助函数时重复声明了 `listChannels`，`node --check` 直接报 SyntaxError；说明脚本必须先过语法检查再跑。
- MySQL 复跑时把取 key 的命令内联进 `KEY_CMD`，反引号标识符被 `bash -lc` 当成命令替换执行（`key: command not found`）；改为脚本文件传参并写进用法注释。
- 用 `--default-authentication-plugin` 起 `mysql:8` 直接初始化失败（8.4 已移除该参数）；照官方默认参数重来即可。
- 三次犯同一个测量错误：用 `cmd | tail -n` 之后读 `$?`，拿到的是 `tail` 的退出码，于是把失败读成了成功（`go build`、`bun run typecheck`、`apply` 各一次）。规则：**判断退出码必须绕开管道**（写文件后再 `echo $?`，或用 `set -o pipefail`）。文档里"绿色"结论若来自带管道的命令，一律重测。
- 把应用容器留在默认 bridge 网络上按容器 IP 连 MySQL 得到 `connection refused`；换用户自定义网络（compose 的默认行为）后即通。

自审发现的真实缺陷（均已修并留证）：

1. `daily_token_limit` 未登记进面板"其他设置"区块 → 编辑时配置区跳回 connection。
2. 只设日限额的渠道不显示"已配置"标记。
3. `.mjs` / `.cjs` / `.patch` 无 eol 规则 → Windows 全新检出得到 CRLF 脚本（升级当天才炸）。
4. `.gitattributes` 修复在 `git am` 的重放顺序下不追溯生效 → 重放末尾正规化工作区。
5. `patches/series/` 入库导致永久脏工作区（`[PATCH n/m]` 计数每次导出都变）→ 改为生成物，`apply` 缺失时自动导出。

仍未闭环（外部依赖，非机制问题）：真实 Kiro/Antigravity 账号、真实国内厂商 Key 与真实出图。
生图/按次计费任务的日限额计量已经实现（`daily_request_limit`，提交时计数）并由
`verify-daily-limit` 的"出图不产生 token 也照样占用预算"用例覆盖（§4），不再算未闭环项。

## 14. 备份与恢复演练（Postgres）

`scripts/backup-drill.sh`（只读生产库；写与删都限定在 `nap_restore_*` 命名的旁路库）：

| 检查 | 实测 |
|---|---|
| 转储非空 | `pg_dump -Fc` → 194,835 字节 |
| 结构可恢复 | `pg_restore --no-owner --exit-on-error` 进入一次性库，**无错误退出**（`--exit-on-error` 是关键：默认模式下部分语句失败也会返回 0） |
| 逐表行数一致 | public schema 下 **38 张表全部一致**（`abilities`/`channels`/`logs`/`quota_data`/`users` 等） |
| 两个日预算原样回来 | 3 条带 `daily_token_limit` + `daily_request_limit` 的渠道在旁路库里计数相同（设置存在 JSON 列里，结构恢复成功不等于内容 round-trip，所以单独查） |
| 恢复出来的库能真跑 | `BOOT_CHECK=1` 用恢复库另起一个应用容器（**不接 Redis**）→ `/api/status` 返回 `"success":true` |
| 失败不留垃圾 | 预置同名旁路库后再跑：`createdb` 失败 → 退出码 1，且**没有** drop 那个已存在的库（`SIDE_DB_CREATED` 守卫，实测库仍在） |
| 边界：计数器不在库里 | public schema 下不存在任何 `*daily*` / `*usage*` 表 → 当日额度只在 Redis/进程内；恢复库但不恢复 Redis 会把当天已用量清零（只影响预算保护，不影响计费，计费看 `logs`/`quota_data`） |

SQLite 与 MySQL 的等价实测在 §4 的 `verify-minimal-deployment.mjs`（含 WAL 三文件拷贝的坑）。
演练结束后旁路库与转储都已清理；演练期间种下的 3 条带预算渠道在后续 observability 端到端跑完后一并清掉，
当前 PoC 库 `channels` 为空，这不影响上面任何一条结论（比对是"源库 vs 恢复库"，两边同一时刻快照）。

## 15. 日预算可观测（用量 / 限额 / 拒绝次数）

| 验证 | 结果 |
|---|---|
| 拒绝次数为何要自己计数 | 实测 `logs` 里 263 行（203 条消费 + 60 条错误）中**没有一行**与日限额有关 → 预算拒绝不落日志，想给运维看就必须自己计数 |
| 计数落点 | 唯一决策点 `model.channelDailyLimitViolation`：缓存选路、候选集预筛、数据库选路都汇入这里，所以只加 1 处调用就覆盖三条路径，不需要动上游日志/错误处理 |
| 计数器互不污染 | `TestChannelDailyRejectCounterDoesNotMoveUsage`：拒绝计数 2 次后 `tokens_used`/`requests_used` 仍为 0；id≤0 为 no-op（nil 渠道不会污染 key） |
| 只读接口 | `GET /api/channel/daily_usage/:id` 与 `GET /api/channel/daily_usage`（`authz.ChannelRead`），返回限额 / 当日已用 / 当日被跳过次数，数据就是执行层正在读的那几个计数器，没有第二套真相 |
| 端到端（0.3.0 镜像 + Postgres + Redis + mock 上游） | `node scripts/verify-daily-observability.mjs`：预算 1 次请求的渠道第一次 200、第二次 **429 daily_request_limit_exceeded**；快照返回 `requests_used=1`、`reject_selection_attempts_today=2`、`daily_request_limit=1`；聚合列表含该渠道且 **payload 不含上游 key** |
| "2 而不是 1"追到根因 | 不是重复计数：默认 `RetryTimes=0` 时一个被挡的请求会做 **2 次选路尝试**（同一请求在两行相同的 distributor `No available channel ... (distributor)` 错误日志里可见），每次尝试发现该渠道超额都计 1 次。字段因此改名为 `reject_selection_attempts_today`（单位是选路尝试），接口一并返回 `retry_times` 供参考。我最初推断倍率是 `retry_times+1`，harness 的断言把它证伪了（预测 1、实测 2），所以最终改成"钉住实测值 2、变了就红"而不是写公式——不要拿未验证的换算骗运维 |
| 密钥卫生 | 聚合分支走 `GetAllChannels(0, -1, selectAll=false, ...)`，即 GORM `Omit("key")` 路径，密钥连内存都不加载；`Limit(-1)` 表示不分页而不是写死魔法数 |
| 版本纪律 | 新增接口属内容变化 → `PRODUCT_VERSION` 0.2.0 → **0.3.0**，镜像重打为 `new-api-daily-limit:0.3.0` 与别名 `starbridge-gateway:0.3.0`（同一 tag 不覆盖内容）；`.gitattributes` 补 `PRODUCT_VERSION text eol=lf`，避免 Windows 检出 CRLF 把版本号读成带 `\r` 的 tag |
| §9 结算竞态：从推断升级为复现 | 加结算等待后连跑两次均 **16/16**；加等待之前，第二次连跑实测出现"第二个请求 status=200、requests_used=2、rejects=0"——文本 relay 用量在响应后结算，紧接的下一次请求可抢在结算前通过选路。§9 写的边界现在有复现输出，不只是文字 |
| harness 会自我阻塞（会话限制） | PoC 限制单会话：上一次运行不 logout，下一次登录直接 `AUTH_SESSION_LIMIT / Conflict`（实测撞到过）。harness 末尾补 best-effort 退出后，连跑两次均可登录 |
| harness 收尾：搜索式删除有效，但 token 是**软删除** | `GET /api/token/` 与 `/api/token/search?keyword=` 返回 `{page,page_size,total,items}`；按 keyword 找到 id 后 `DELETE /api/token/:id` 返回 `success:true`，两个 harness 各自断言 `left=0` 且连跑后 app 可见 token 只剩 2 条空名行（非 harness 造）。但表里有 `deleted_at`：实测 3 条 harness token 全部 `soft_deleted=t`。**数行数必须加 `deleted_at is null`**，否则会把墓碑当成泄漏——我自己就先误报了一次"库里还有 3 条" |
| 我先前那条"分页导致删不掉"的诊断不完整 | 当时表里只有 4 行，列表接口其实能返回它。有效做法是 keyword 搜索 + DELETE + 复查，这条已实测；旧结论写在提交信息里作为过程记录，但以本行为准 |

## 16. 跨平台门禁（Linux 容器，2026-10-25）

本机是 Windows + Git Bash，而 CI 与生产都在 Linux。之前所有"绿"都只在 Windows 上取过证，
所以把工具层与后端层放进容器重跑一遍（挂载同一份工作树，只读证据，不改仓库）：

| 层 | 命令 | 结果 |
|---|---|---|
| shell 语法 | `bash -n` × 4（`upstream-sync.sh` / `product.sh` / `backup-drill.sh` / `build-image.sh`），`node:24-bookworm` | `BASH_SYNTAX_OK_LINUX` |
| harness 语法 | `node --check` × 5 个 `.mjs` | `NODE_CHECK_OK_LINUX` |
| 同步脚本 | `./scripts/upstream-sync.sh status` | 与 Windows 输出一致：落后 23、自有 36、**overlap 18 个文件**（`comm`/`sort` 无平台差异） |
| 后端 | `golang:1.26-bookworm`，`go1.26.10 linux/amd64`：`go build ./...`、`relaykit` 独立构建、`go test ./common -run Daily`、`go test ./model -run 'Daily\|FilterCandidate\|TaskPlugin'` | 全绿（退出码 0） |

两个只有跨平台才暴露的坑（都已写进用法）：

- Git Bash 会把 `docker run -w /repo` 的参数改写成 `C:/Program Files/Git/repo`，必须 `MSYS_NO_PATHCONV=1`。
  这与 `backup-drill.sh` 里 `pg_dump --file=/tmp/...` 被改写成 Windows 路径是同一类问题。
- `golang` 镜像里用 `bash -lc` 会重置 PATH，`go` 反而找不到（实测退出码 127），要用 `bash -c` 并显式带上 `/usr/local/go/bin`。

**这一段不证明的事**：没在 GitHub hosted runner 上跑过 workflow（缓存、setup 版本、artifact 传递仍是未验证项）；
前端 `typecheck`/`vitest` 与 compose 全栈仍只在 Windows 上验过；`verify-*.mjs` 端到端依赖本机已起的 PoC 栈，未在 Linux 里重建。

## 17. 面板接入：日预算用量（0.4.0）

| 验证 | 结果 |
|---|---|
| 代码位置 | 新组件 `web/src/features/channels/components/drawers/channel-daily-usage.tsx`，插在渠道抽屉「其他设置」页签内；数据走 `GET /api/channel/daily_usage/:id`，前端只读、不新增写路径 |
| 补丁面 | 只改 3 个既有文件（`features/channels/api.ts` 加一个函数与类型、`lib/channel-actions.ts` 加一个 query key、抽屉加一次渲染）+ 新增 2 个文件 + 每个 locale 恰好 6 行；`git diff --stat` 可复核 |
| i18n | 7 个 locale 各新增同样 6 个 key，全部落在既有命名空间内。`bun run i18n:sync` 被否决：它把新 key 追加到命名空间**外面**（i18next 读不到），还顺手改了无关的 `"0 means unlimited"` 并把受 Rule 5 保护的署名 key `footer.new\u0061pi.*` 重新转义 → 改为纯文本插入，`git diff` 对 i18n 只有 42 行新增、0 行删除，署名 key 未出现在 diff 中 |
| 静态门 | `bun run typecheck` 退出码 0；`vitest run src/features/channels` **361/361**；`oxlint 1.74.0` 只跑本次改动的 5 个文件：0 warnings / 0 errors |
| 浏览器实测（不是单测代理） | 0.4.0 镜像 + 真实流量：渠道 322 连跑 2 次 chat 后，面板显示 今日 Token `20 / 50,000`、今日请求数 `2 / 7`、被跳过 `0`；点「刷新」数字随之更新——证明读的是活计数器而不是快照 |
| 被拦路径的数据 | 渠道 323 限额 1 次请求：第 1 次 200、第 2 次 **429 `channel:daily_request_limit_exceeded`**，接口快照 `reject_selection_attempts_today=2`、`requests_used=1`。这一条是接口层取证；面板上对 323 的同一渲染路径已在 322 上验证过，未再逐一截图 |
| 自己发现的实现缺陷（已修） | 组件最初直接读 `requireServerSuccess()` 的返回值，而它返回的是**整个服务端信封**，于是渲染成 `- · Unlimited` 这种"看起来正常其实全空"的界面；改为 `data.data` 并加数值守卫。同时承认先前两条断言是弱测试（该 bug 下也能通过），已改成断言具体数字 |
| 版本纪律 | 前端内容变化 → `PRODUCT_VERSION` 0.3.0 → **0.4.0**，镜像重打 `new-api-daily-limit:0.4.0` / 别名 `starbridge-gateway:0.4.0`；PoC 头部显示「当前版本：0.4.0」 |
| 未覆盖 | 7 个 locale 的翻译由我直写，未经母语者校对；「被跳过」计数精确到请求级仍未做；看板页面级汇总（列出所有渠道预算水位）没有做，目前只有单渠道视图 |
| 试过并**已回退**的请求级计数 | 做法是在 `service.dailyLimitExceededError` 里给对应渠道 +1，单测与类型门都过。端到端实测：429 真的发生了，`blocked_requests_today` 却是 **0** —— 因为「该模型/分组下所有候选都超额」这条最常见路径调用时 `channel` 是 `nil`（组级归因，我当时特意选择「不归属到某个渠道」），于是字段在主场景恒为 0，属于"看着正常其实不工作"的计数器。处理：整体回退（`grep blocked_requests_today` 在源码里为 0 处；镜像按回退后的源码重打，容器自报 0.4.0；harness 回到 17/17），不是留着让它显示 0。要做对需要请求作用域去重：把 request id 带进过滤器层，或在 service 层收集"本轮被预算挡掉的渠道 id"后统一计一次 —— 列入 P4，且明确它比看上去贵 |
| 升级机制仍然成立 | 加完前端后重跑 `drill v1.0.0-rc.46`：overlap 0 → 重导 **40 个 patch（85 个功能文件，commits == series）** → 纯净 tag 上 `git am -3` 全部 Applying → renormalize → 构建 + common/model/service 回归 → 重放树内装依赖并 **`tsgo -b` 真跑** → `DRILL OK`（退出码 0）。即前端新增文件与三个被改的自有文件在纯净 rc.46 上也能重放并通过类型门 |
| 面板改动后的全套复跑（0.4.0，2026-10-25） | `verify-daily-limit` **15/15**、`verify-compat` **8/8**、`verify-channel-types` 限额生效 **15/15 类型**，三者退出码均 0；跑完清掉 PoC 演示数据（`channels` 归 0、活 token 归 0），不给下一次演练留脏状态 |

## 18. JSON 批量导入与账号类型口径（0.5.0）

| 验证 | 结果 |
|---|---|
| 为什么是 JSON 而不是接口演练 | 用户反馈"接口我自己验不动，接入不都是 JSON 导的吗"。后端 `controller/channel.go:788` 的 `mode` 只支持 `single`/`batch`(同一模板多密钥)/`multi_to_single`，**没有**异构渠道列表导入接口；所以补的是 `scripts/import-channels.mjs`：读 JSON 数组，逐个走面板 API `POST /api/channel/`，密钥一律从 `key_env` 取 |
| 导入正确性 | `channels.example.json`（15 条）在无任何环境密钥时 `--dry-run` 输出 `0 imported, 15 skipped, 0 failed`——缺密钥的条目被跳过而不是建成坏渠道；两条真实条目导入后 `2 imported, 0 failed`，且 `4242/9`、`/5` 两个预算原样落库 |
| 顺带修掉自己接口的一个真缺陷 | `GET /api/channel/daily_usage/:id` 原本只读渠道缓存，而缓存有几秒同步延迟：刚导入的渠道立刻查会返回 `channel #N no longer exists`（实测复现）。改为缓存未命中回源 `model.GetChannelById(id, false)`（`false` 继续保证不把上游密钥读进内存）；重建 0.5.0 后**导入后立刻查** `success=true`、`limits=4242/9` 与 `0/5` |
| Windows 退出码坑（影响可信度） | 脚本以 `process.exit()` 收尾时，Windows 上会在句柄未排空时触发 libuv 断言并把退出码污染成 127（明明 `2 imported, 0 failed`）。改为设置 `process.exitCode`，同一命令 `IMPORT_EXIT=0`。CI 在 Linux 上不受影响，但本机复跑不能再信退出码 |
| 账号类型口径纠正 | 之前只写"Codex、Grok、Gemini、Kimi、MiniMax"，把旁路说窄了。按容器内源码补全并逐条给路径：Codex `auth/codex-oauth.js`、Claude `providers/claude/`、**Kiro** `providers/claude/claude-kiro.js` + `auth/kiro-oauth.js`、Gemini `providers/gemini/gemini-core.js`、**Antigravity** `providers/gemini/antigravity-core.js`、**GitHub Copilot** `providers/github/github-copilot-core.js`、Grok `auth/grok-auth.js`/`grok-cli-oauth.js`、iFlow `auth/iflow-oauth.js`、Qwen `auth/qwen-oauth.js`。渠道侧形状用 PoC 实测过的类型 1/14（`verify-compat` 8/8），不夸称 24 已验证 |
| 回归 | 面板 + 导入器 + 缓存回源之后：`verify-daily-observability` **17/17**、Go 主模块与 relaykit 构建通过、PoC 自报 `0.5.0`、healthy |

## 19. 发布到公开仓库与真实 runner 门禁（0.5.0，2026-10-25）

之前所有"绿"都来自本机（Windows + Git Bash + 本地容器）。§16 明确把"没在 GitHub hosted
runner 上跑过 workflow"列为未验证项；本轮推上公开仓库后，runner 连着把三个只有它才能发现的
问题顶了出来。

| 验证 | 结果 |
|---|---|
| 发布形态 | 远端 `starbridge` = `https://github.com/Ylsssq926/StarBridge.git`，公开，默认分支 `product/daily-limit`。推的是分支本体（含上游完整历史与全部署名/`LICENSE`/`NOTICE`），**一条 tag 都没推**：`git ls-remote --tags starbridge` 返回 0 条。这条事实后来直接决定了 CI 的一处修法 |
| runner 暴露差异 ①：`go:embed` | `main.go:44:12: pattern web/dist: no matching files found` —— `web/dist` 是 gitignore 的产物，干净检出里没有。按上游 `ci.yml` 同样做法先建占位再 `go build`（commit `cf30bea32`） |
| runner 暴露差异 ②：可执行位 | `Permission denied` / 退出码 126。Windows 上 git 不记录 `chmod +x`，5 个 `.sh` 全以 `100644` 入库。用 `git update-index --chmod=+x` 索引进 `100755`（commit `5270aa195`），本地 `git ls-files -s` 复核 |
| **两处静默失效**（只有 runner 能发现） | 「按我们改过的文件 lint」这道门**从写下到本次一次也没跑过**：(a) 浅克隆没有 `v1.0.0-rc.46`，`git diff` 报 `fatal: bad revision` 却被行尾 `|| true` 吞掉，于是打印 `no frontend files changed` 并绿；(b) pathspec 相对当前目录，而 `working-directory` 已是 `web`，`'web/src'` 实指 `web/web/src`，永远为空。修法：checkout 加 `fetch-depth: 0`；基线 ref 复用同步脚本的 upstream remote（不在 CI 里另抄上游 URL）；pathspec 改 `:/web/src` 锚到仓库根；拿不到基线就 `exit 1` 而不是跳过 |
| 跨 job 的 artifact 是假的 | `sync-integrity` 报 `Artifact not found: web-dist`：frontend job 根本没有构建步骤，上传的 `web/dist` 是空目录（annotate 早写了 `No files were found with the provided path`）。重放树只需要一个非空 embed 目录 → 自建占位，并删掉 `needs: frontend`，三个 job 并行 |
| 补一道上游没有的门 | 上游 `ci.yml` 前端只做 typecheck + test，生产包要到镜像构建才第一次被编译。新增 `bun run build` 并断言 `dist/index.html` 存在（本地与 runner 均退出码 0；产物 67411.1 kB / gzip 20727.6 kB） |
| 三 job 全绿（run `40190182183`→ 修复后 `40190561094`，push 触发） | `backend` 30s、`frontend` 2m32s、`sync-integrity` 1m19s。**按日志逐条确认它们真做了事**：`linting 9 file(s) we touched` → `Found 0 warnings and 0 errors`；`rsbuild build` 产出 `dist/index.html`；重放树里 `==> typecheck: ran`；`export-series: OK (commits == series)`（49 patch / 87 功能文件）；`docker compose config --quiet` 通过 |
| Dependabot PR 上的红是有效信号，不是噪声 | PR #5（jsdom 29→30）在我们 `vitest run src/features/channels` 里挂在 `priority-order.test.tsx:687`，即**上游既存测试**被这次升级打挂；同一 run 里上游自己的 backend job 是绿的。这条门拦下了一次不该合的升级 |
| 分支保护 | 已开：`allow_force_pushes=false`、`allow_deletions=false`、`enforce_admins=true`；`required_status_checks=null`、`required_pull_request_reviews=null`（仍能直接推分支，只是不能覆盖历史/删分支）。按 `GET /branches/…/protection` 回读确认；**没有**用真实 force-push 去"试"——那会真把已发布历史覆盖掉。回退：`gh api -X DELETE repos/Ylsssq926/StarBridge/branches/product/daily-limit/protection`。保护生效后仍实测了一次普通 `git push` 成功（commit `09759865e`、`fd1945a0c`），所以它没有把我们的直推工作流堵死 |
| Upstream Drill 的第一次真实触发（run `40191317746`） | 2 秒就 `drill_exit=1`，原因是它把日志写在仓库根：`export-series` 的 fail-closed 守卫报 `uncommitted functional changes: drill.log`。守卫是对的，放错位置的是 workflow。本地按同一命令复现并确认改法：根目录建 `drill.log` → 被点名；改放 `logs/drill.log`（`logs` 在 `.gitignore` 第 13 行，也已声明进 `ARTIFACT_DIRS`）→ 不再点名。修复 commit `fd1945a0c` |
| 第二次真实触发（run `40191784310`）：演练给出了它该给的答案 | 越过守卫后真的重放到 `upstream/main`：`overlap with upstream/main: 19 file(s)`，第 1 个 patch 就停住，`conflicted files: model/channel_constraint.go`（`Patch failed at 0001 feat(channel-daily-limit): cap billable tokens per channel per day`，0/51 应用）。按设计 job 仍是绿的——演练失败是"这轮要人工处理"的信号，不是门禁红；结论进了 summary 与 `drill-log` 产物 |
| 这一条把"跟 main 之前要先解决"从文字变成了可执行清单 | 唯一冲突点就是 `model/channel_constraint.go` 里 `ChannelSatisfiesFilters` 的注释与函数头部同一 hunk（上游改了归因注释的措辞，我们的补丁也在改那段注释）。跟 main 时先解这一处，再跑 `make drill REF=upstream/main`；其余 18 个 overlap 文件当前不冲突，属于"要看但不用改" |
| 这一段不证明的事 | 演练只证明"能如实报告冲突"，不证明冲突可自动解决；`Product Gates` 绿的是基线 tag 上的重放，不是 main 上的重放；self-hosted / ARM runner、发布链（GitHub Release、镜像推送）都未走——且打 tag 会立刻激活上游继承的 `docker-build.yml` / `release.yml` / `electron-build.yml`（三条都在 `on: push: tags` 上），本仓当前无 tag 故它们尚未注册；Dependabot 其余 4 个 PR 还没在新版本 workflow 下重跑 |

## 20. 跟进 v1.0.0-rc.47 的重放实测（2026-10-25，**未落地**）

上游在 2026-10-25 09:04 UTC 发布 `v1.0.0-rc.47`（我们基线 rc.46 是 10-21 发的）。
`gh release list` 看到的节奏是 rc.44=10-12、rc.45=10-17、rc.46=10-21、rc.47=10-25，
**间隔 4~5 天**，所以"每月跟进一次"这个假设已被上游事实否掉（`ITERATION_PLAN` §0 已改）。

| 验证 | 结果 |
|---|---|
| 冲突范围 | `overlap with v1.0.0-rc.47: 19 file(s)`，但真正停下来的只有 1 个文件、2 处，都在 `model/channel_constraint.go` |
| 冲突 1（patch 0001） | 上游在 `switch kind` 里新增 `case dto.FilterTaskPluginEndpoint`，正好落在我们要插入 `case dto.FilterDailyTokenLimit` 的位置。两者语义不相干 → 保留双方（上游 case 在前，我们的紧随其后）。Go 的 `switch` 分支顺序不影响正确性，归因顺序由 `dto.filterEvalOrder` 决定，那是另一处 |
| 冲突 2（patch 0011） | `ChannelSatisfiesFilters` 的文档注释：上游写"first violated filter in filterEvalOrder"，我们改成"first violated filter kind"。我们的改动是必须的——日预算检查现在发生在 `filterEvalOrder` 循环**之前**，上游那句已不准确。合并结果保留我们的语义并补一句说明 |
| 重放结果 | 两处解完后 `git am --continue` 一路应用到底：**53/53 patch 落在 rc.47 上**，`git rev-list --count v1.0.0-rc.47..HEAD` = 53，无残留 unmerged 文件 |
| rc.47 树上的门禁 | `go build ./...` 通过；`go test ./common -run Daily` **ok 5.742s**、`./model -run 'Daily\|FilterCandidate\|TaskPlugin'` **ok 6.304s**、`./service -run 'TestSettle_\|TestTaskBilling\|TestLogTaskConsumption\|TestRecalculate'` **ok 6.066s** |
| **类型门按设计拒绝，没有假装通过** | `cmd_check` 报 `ERROR: dependencies are installed but web/node_modules/.bin/tsgo is missing` → 退出码 1。根因是上游把入口从 `tsgo -b` 换成 `bun check -b`（`web/package.json` 实测 `"typecheck": "bun check -b"`），而本机 `bun 1.3.14` 没有该子命令（实测 `error: Script not found "check"`）。这正是当初把这里写成硬失败而不是"提示后跳过"的理由 |
| 跟 rc.47 之前必须先做的两件事 | ① 本机 bun 升级（CI 用 `bun-version: latest`，所以只有本机受影响）；② `cmd_check` 的探针不能只认 `tsgo` 二进制——改成"跑 `bun run typecheck`，并区分'入口不存在'与'类型不过'"，否则以后上游每次换入口都会误报成门禁故障 |
| 上游节奏带来的机制改动 | 跟进单位不该是"每月"而是"每个 release"：建议 `upstream-drill.yml` 的 schedule 从每月 5 日改成每周，并在 `Product Gates` 的定时里带一句当前基线与最新 tag 的差距；真正的落地触发条件应该是"上游发了新 tag" |
| 我没有做的决定 | 没有升级本机 bun（会往 C: 写），没有改 `cmd_check` 的入口判定（机制改动，需你确认），**也没有把 `product/daily-limit` 的基线挪到 rc.47**：落地方式两种且不可兼得——开 `product/rc47` 新分支（加性、不动已发布历史），或改写现有分支基线（要 force-push，而分支保护现在会拒绝它）。成品版本与镜像是否随 rc.47 一起跳，也还没定 |

