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
| main 上的前端类型门仍不可用 | 该 ref 的 `web/package.json` 是 `"typecheck": "bun check -b"`，本地 bun 1.3.14 没有 `check` 子命令 → 升级树的前端类型门跑不了，本次显式 `SKIP_TYPECHECK=1` 跳过并留痕。跟 main 之前必须二选一：把 typecheck 入口改成可运行的命令，或把本地/CI 的 bun 升到支持 `bun check` 的版本。这正是 `check` 改成硬失败之后要暴露的那类问题（迭代计划 P5 未闭环项）**（本行的"跑不了"已被 §20 末尾取代：本机 bun 升到 1.4.4 后 `bun check -b` 实测跑绿，`cmd_check` 也不再硬探 `tsgo`）** |
| 定时演练 workflow | `.github/workflows/upstream-drill.yml`：两个 workflow 均通过 `yaml.parse`（jobs/triggers/`continue-on-error` 逐项核对），drill 与 summarise 两个 `run` 块抽出后 `bash -n` 通过；summarise 更拿**真实日志**跑过两遍——失败演练日志渲染出 `DRILL FAILED` + 冲突文件，成功演练日志渲染出 `DRILL OK` + `overlap … 0 file(s)`。**未验证**：该 workflow 还没在 GitHub runner 上真跑过（本地无 make/无 hosted runner），且 `schedule` 只在仓库默认分支生效 **（本行的"未验证"已被 §19 关掉：真 runner 上跑过两次，并在那里暴露了日志位置缺陷）** |
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
| 类型入口这条已改成**按脚本判定**，不再硬探二进制 | 同一个缺陷被 rc.47 和 main 各撞一次：`cmd_check` 只看 `web/node_modules/.bin/tsgo` 在不在，于是"本机 bun 跑不了 `bun check -b`"被报成"上游改了入口，你自己去看 package.json"。契约本来就是那个 npm script，不是二进制。现在 entry 从 `web/package.json` 的 `scripts.typecheck` 读出来并打进日志，失败分两类报且**都非 0 退出**：`the type gate DID NOT RUN`（本机工具链不支持该入口，附本机 bun 版本，并说明 CI 用 `bun-version: latest` 覆盖它）/ `typecheck FAILED on real type errors`。三条证据分别覆盖两条路：rc.47 树上直接跑改后的判定块 → `entry=[bun check -b]`、抓到 `error: Script not found "check"`、归类正确；rc.46 主工作区 `bun run typecheck` 退出码 0（正向没被改坏）；CI run `40203120662` 在 Linux 上跑同一个函数 → 日志 `==> typecheck: bun run typecheck (entry: tsgo -b)` + `==> typecheck: ran`，三 job 全绿、56 patch == 56 commit。本机那次 `check ../new-api-v1.0.0-rc.47` 全量跑到 25 分钟仍卡在 Windows 的链接阶段，被我主动停掉——它要证的三点上面都已各自成立，不值得继续吃机器 |
| 上游节奏带来的机制改动 | 跟进单位不该是"每月"而是"每个 release"：建议 `upstream-drill.yml` 的 schedule 从每月 5 日改成每周，并在 `Product Gates` 的定时里带一句当前基线与最新 tag 的差距；真正的落地触发条件应该是"上游发了新 tag" |
| 重放成果已固化，不会被自动清理吃掉 | 这次解完冲突的 53 个提交留在工作树 `../new-api-v1.0.0-rc.47`，已 `git branch rehearsal-rc47` 并 checkout 成命名分支（本机实测：`git symbolic-ref --short HEAD` = `rehearsal-rc47`、`git rev-list --count v1.0.0-rc.47..HEAD` = 53、脏文件 0）。原因是 `upstream-sync.sh` 的 `is_stale_replay_worktree` 只自动丢弃**游离 HEAD** 的重放树，否则下次 `drill v1.0.0-rc.47` 会先把这份成果静默删掉再重放。副作用要记住：现在再跑 `drill v1.0.0-rc.47` 会被"工作树已存在且在用"挡住，要重做先 `git worktree remove` 或换个 ref 名 |
| 本机 bun 已升到 1.4.4，rc.47 的类型门**实测跑绿** | 用户授权后代为升级，走的是它原本的安装方式（`bun` 是 npm 全局包，不在 `~/.bun`）：`npm install -g bun@1.4.4`，`bun --version` = 1.4.4，`bun check --help` 确认该子命令存在。然后两个基线都复跑，避免"升级修好一个、弄坏另一个"：rc.47 树 `bun run typecheck` → `✓ No type errors in 1,407 files across 2 projects [23.82s]`（退出码 0）；我们自己的 rc.46 基线 `tsgo -b` → 退出码 0。C 盘反而多了约 5 GB（旧包被移除），这次升级没有以空间换功能 |
| 我没有做的决定 | 基线是否从 rc.46 搬到 rc.47 **仍未决定，但现在的原因变了**：不再是"本机跑不了"，而是**落地前置**——`UPSTREAM_BASE` 目前硬编码在两个 workflow 与文档里（都是 `v1.0.0-rc.46`），直接把 rc.47 基线的分支推上去会让 `export-series` 把上游自己的 rc.47 提交也算成"我方提交"，`commits == series` 立刻失真、门禁变红。所以要先把基线 ref 改成"每条分支一个来源"（脚本默认值 + workflow 读取），再推 `product/rc47`，看它 CI 全绿之后才谈默认分支切换。**这条前置已于本轮完成**：`upstream-sync.sh base` 成为唯一来源，`product-gates.yml` 两处 job env 改为运行时解析、`upstream-drill.yml` 那个从未被引用却写着旧字面量的 `env` 直接删掉、`OPERATIONS.md` 的 `BASE=` 也改成问脚本；实测 8 个 workflow 文件里 `v1.0.0-rc.46` 字面量计数全为 0。成品版本与镜像是否随 rc.47 一起跳，也还没定（①② 两步已完成并有 CI 背书，见 §21）|

## 21. 把 rc.47 真正落成一个可验证的分支（2026-10-26，① ② 已闭环）

大白话：以前"我们跟的是上游哪个版本"这句话抄在 6 个地方，换版本时漏抄一处，自动检查就会把
上游自己的新代码当成我们写的代码来算，报告看着绿、实际在量错的东西。现在只有 1 个地方。

| 验证 | 结果 |
|---|---|
| ① 唯一来源 | `scripts/upstream-sync.sh` 新增 `base` 子命令；`product-gates.yml` 两处改为运行时 `Resolve the upstream base`（空值 exit 1），`upstream-drill.yml` 那个从没被引用却写旧字面量的 `env` 删掉，`OPERATIONS.md` 的 `BASE=` 改成命令替换。本地实测 `base` → `v1.0.0-rc.46`、`bash -n` 通过、两个 YAML 可解析 |
| ① 在 runner 上生效 | run `40251915577`（基线仍是 rc.46）三 job 全绿，日志 `resolved base: v1.0.0-rc.46` |
| ② 用当前完整 series 重放到 rc.47 | 主分支此前的彩排只有 53 个提交（落后 6 个），所以重放的是**当前 59 个提交**：`apply v1.0.0-rc.47` 两次停在同一文件的同一两处（`0001` 的 switch 插入点取并集、`0011` 的函数注释取我方），解完 `am --continue` → `applied=59 unmerged=0 dirty=0` |
| ② 换基线只有一个动作 | 在 `product/rc47` 上把那一行改成 `v1.0.0-rc.47` 并提交（工作树内实测 `base=v1.0.0-rc.47`、`commits_above_base=60`），随后 `export-series` 报 **60 patches == 60 commits、87 个职能文件** —— 这正是重构前必然失真的一步，现在自洽 |
| ② CI 全绿（run `40252592779`，ref `product/rc47`） | `backend` / `frontend` / `sync-integrity` 三 job 全 `success`；日志逐条：`resolved base: v1.0.0-rc.47` → `series: patches/series (60 patches, base v1.0.0-rc.47)` + `export-series: OK (commits == series)`（export 与 verify 各一次）|
| **上游新类型入口首次被真跑** | 同一次 run 里 `==> typecheck: bun run typecheck (entry: bun check -b)` → `==> typecheck: ran`。即"上游改了类型检查命令"这件事，在我们的补丁树上、在 Linux runner 上，第一次拿到真实通过而不是跳过 |
| 分支现状 | `product/daily-limit`（rc.46 基线，仍是仓库默认分支）与 `product/rc47`（rc.47 基线，60 提交）并存；`rehearsal-rc47` 保留作 §20 那份早期彩排的证据。切换默认分支、以及成品版本要不要从 0.5.0 跳，**是你的决定**，我没有动 |
| 这一段不证明的事 | rc.47 一支没重跑端到端 PoC（harness 与备份演练依赖本机 Docker 栈，且镜像是按 rc.46 源码打的）；两条产品分支并存期间的文档同步靠人记（新文档提交先落在默认分支，另一支要靠重放带上）；上游 4~5 天一个 rc，意味着下一次 `drill` 大概率还会撞 `channel_constraint.go` 这两处 |

## 22. 切换成品主线到 rc.47 / 0.6.0，并把整套端到端重跑（2026-10-26）

上一节写的"rc.47 一支没重跑端到端 PoC"由本节关闭。用户决定"换"，所以这一步不只是重放，
而是把主线、版本、镜像、门禁与本地布局一起对齐。

| 事项 | 结果 |
|---|---|
| 主线切换 | 默认分支从 `product/daily-limit`(rc.46/0.5.0) 改为 `product/rc47`(rc.47/0.6.0)；新主线补开同款分支保护（`enforce_admins=true`、禁 force-push、禁删除、不要求 PR/必需检查，按 `GET /branches/product/rc47/protection` 回读确认）。`product/daily-limit` 冻结为历史 |
| **我在这一步犯了一次真错误** | 我想切默认分支，却用了 `gh api -X PATCH repos/... -f name=product/rc47` —— 这个字段改的是**仓库名**，不是默认分支。第一条命令实际生效并把仓库改名成 `product-rc47`，第二条才报 `name same name`。立刻用 `PATCH -f name=StarBridge` 还原，复核 `full_name=Ylsssq926/StarBridge`、URL 未变、默认分支为 `product/rc47`。正确命令是 `gh repo edit <repo> --default-branch <branch>`。写进文档是为了让下次（我或其他人）不重复：改仓库级设置前先确认字段语义 |
| 门禁跟着新主线跑 | `product-gates.yml` 的 push 触发从写死分支名改成 `'product/*'` 通配。证据：推送 `8eb648025` 自动起 run `40257162591`，三 job 全 `success`，日志 `resolved base: v1.0.0-rc.47` → `series: patches/series (62 patches, base v1.0.0-rc.47)` + `export-series: OK (commits == series)` → `==> typecheck: bun run typecheck (entry: bun check -b)` → `==> typecheck: ran` |
| 补丁规模（新口径重测） | 实现面 30 文件 `+889/-38`；含测试与 locale 43 文件 `+1430/-39`。同时修正旧口径的低报：原统计目录漏了 `controller` 与 `router`，等于把只读接口的实现排除在"补丁有多小"之外（旧数字 25/`+587/-38` 因此偏小，已写明原因） |
| 0.6.0 镜像 | `./scripts/build-image.sh` 退出码 0：前端 67447.8 kB 产物 → Linux 二进制（`-X common.Version=0.6.0`）→ 四个 tag `new-api-daily-limit:{local,0.6.0}`、`starbridge-gateway:{local,0.6.0}`，各 312MB。容器自报 `/api/status` 的 `version: 0.6.0` |
| 端到端复跑（0.6.0 栈） | `verify-compat` **8/8**、`verify-channel-types` 可路由类型到顶 429 **15/15**、`verify-daily-observability` **17/17**，退出码均 0 |
| **一个假红，以及我把它变成结构性防护** | 第一次跑 `verify-daily-limit` 只有 **7/15**，relay 全部 401，应用日志 `ValidateUserToken: failed to get token: record not found`。我没有先去改代码：先确认上游 rc.46→rc.47 **没有动过令牌存储**（`git log` 只改了任务超时与 Responses 流收尾），再确认同一栈上后跑的 harness 令牌是 200 —— 于是定位成"容器还在 `health: starting` 我就开跑"。栈热后重跑同一脚本：**15/15，退出码 0**。根因是 `docker compose up -d` 创建立即返回，所以给 `product.sh up` 加了 `wait_healthy`（轮询健康状态，`unhealthy` 直接打印容器日志并失败），实测第二次 `up` 以 `==> new-api healthy` 结束 **⚠ 本行的因果结论是错的，留在这里是因为"错在哪"本身是证据：真正根因见 §23——harness 从库里读令牌 key 时用了 `limit 1` 而没排除软删除的墓碑行，取到的是旧令牌的 key。`wait_healthy` 该加（契约上 `up` 就该返回"可用"），但它没有解决这个问题；我当时只凭"重跑一次就 15/15"就把归因写成冷启动，这正是单样本归因的陷阱。** |
| 备份演练在 0.6.0 上 | `backup-drill.sh`：dump 226043 bytes → `pg_restore` 无错 → **38 张表行数一致** → 退出码 0 `BACKUP DRILL OK` |
| **顺带抓到一处"看着 PASS 其实是空跑"** | 演练里"带日预算的渠道能否整轮存活"这项，在 harness 已清理渠道后是 `0 == 0` 也判 PASS（脚本自己只打印了一句 note）。改成**默认失败**并给补救步骤（先建一个带预算的渠道，或 `ALLOW_VACUOUS=1` 明确跳过）；实测两种路径：无种子时 `FAIL ... would be vacuous` + 退出码 1（且副库照常清理），我临时种一条渠道后 `PASS ... survived the round trip (1)` + 退出码 0 |
| 我自己造成的脏数据与善后 | 那个一次性种子脚本写错了：`--delete` 那次仍先创建（id 410）再删，于是把 409 留在 PoC 库里。用一次性容器挂原卷核对（角色是 `newapi` 不是 `postgres`，第一次连失败就是这个原因），`DELETE 1` 后 `select count(*) from channels` = **0**，随即停掉一次性容器并删掉脚本。要点：各 harness 的自清理本来就是把渠道数清到 0 的，是我这次多出来的 |
| 本地布局（这是个真陷阱） | 本会话默认目录 `F:\Project\new-api` 是**另一个克隆**，仍停在迁移前的 `feat/channel-daily-token-limit`（工作树干净，且已推到 `jonathan/feat/...`，没有丢失风险）；成品主线在 `F:\Project\new-api-v1.0.0-rc.47`（旧线在 `new-api-rc46`）。我没有删除那个克隆——它不是我的，也没有丢失风险，只把"哪儿是哪"写进 `docs/OPERATIONS.md` §10 **（本行已被 §27 取代：2026-10-27 三个目录已合并成 `F:\Project
ew-api` 一个）** |
| 收尾与未覆盖 | 用完 Docker 执行 `docker desktop stop`（实测 `✓ Stopping Docker Desktop`），不再留 `vmmem` 常驻；`meme-adventure` 与两个我判断不清归属的 `postgres`/`redis` 容器**没有动**。未覆盖：真实厂商 key 与真实账号（#9/#11）、GitHub Release 发布链（打 tag 会激活上游三条 workflow，见 §19）、以及 `product/daily-limit` 与 `product/rc47` 在切换点之后的文档分叉 |

## 23. 密钥扫描报警的处置，以及那条报警顺带挖出的真缺陷（2026-10-26）

GitGuardian 发来说 `Ylsssq926/StarBridge` 泄露了一个 "Generic Password"。结论先说：**不是真凭据**，但顺着查下去挖出了两个该修的东西——一个是我们自己的写法，一个是让 §22 那个 7/15 反复出现的真根因。

| 事项 | 结果 |
|---|---|
| 报警命中的是什么 | 我们自己的**默认口令回退字面量**：5 个脚本写成 `process.env.NEW_API_ADMIN_PASS \|\| '<固定的本地口令>'`，`verify-minimal-deployment.mjs` 另有一个 `const ADMIN_PASS = '<固定值>'`，compose 与备份演练写成 `${POSTGRES_PASSWORD:-<固定>}` / `${REDIS_PASSWORD:-<固定>}`。`git grep` 定位到 7 个文件共 10 处，全部属于本项目的补丁层，不涉及任何真实服务凭据。文档里也不再复述这些字符串，否则文档本身就成了下一次报警的命中项 |
| 为什么这不只是"误报" | 危害不是扫描器烦人，而是行为本身：环境变量忘传时脚本会**悄悄用默认密码去连当前在跑的那套栈**，连上了就报"验证通过"。这类"看着正常其实测的是别的东西"正是本项目一直在消灭的失败模式 |
| 改法 | 新增 `scripts/poc-credentials.mjs`：凭据只从环境读，缺失时退出码 1 并打印该传什么、去哪看文档；5 个 harness 与 `import-channels.mjs` 统一改用它。compose 的默认值改成 `${VAR:?...}`（未设置就拒绝启动并说明），`backup-drill.sh` 缺口令直接失败而不是猜一个 |
| 实测 | ① `NEW_API_ADMIN_PASS` 不设时 `node scripts/verify-compat.mjs` → **真实退出码 1**（第一次我把它读成 0，因为管道拿的是 `head` 的码——同一个坑我一天内踩了两次）；② `cp .env.product.example .env` 后 `docker compose config --quiet` 通过（`${VAR:?}` 没有把 CI 那条 compose 校验打挂）；③ `node --check` 7 个 `.mjs` 全 OK；④ 凭据走 `.env` 后整套端到端复跑通过 |
| GitHub 自己还报了一条 `google_api_key` | alert #1，`state=open`，API 不返回位置。用固定前缀自查命中两处：`relaykit/relayconvert/kitutil/mask.go:102` 与 `mask_test.go:37`，内容是一串 `AIza…` 样例，用途是"错误信息里的密钥要打码"这个功能的测试夹具。**归属证明**：引入它们的提交是 `86ac0f77`/`19d435e7`（后者是上游 PR #7822），`git merge-base --is-ancestor … v1.0.0-rc.47` 均成立 → 上游自带内容，不是我们写的、也不是真实密钥。**我没有替谁关闭它**：关闭是仓库安全记录上的动作（虽然可用同一命令 reopen），要归档时执行 `gh api -X PATCH repos/Ylsssq926/StarBridge/secret-scanning/alerts/1 -f state=dismissed -f dismissal_reason=used_in_tests` |
| **顺带挖出的真根因** | §22 里那个反复出现的 `verify-daily-limit` 7/15（relay 全 401 `Invalid token`）不是冷启动：脚本用 `select key from tokens where name='verify-daily-limit' limit 1` 从库里读明文 key，而 **new-api 的令牌是软删除**（`deleted_at`）。实测该名字下 6 行**全部是墓碑、0 行活的**，不带排序的 `limit 1` 按堆序返回了旧行 `id=43`（`deleted_at is not null`）→ 拿已删除令牌的 key 去请求 → 必然 401。为什么另外两个 harness 一直"绿"：它们写了 `order by id desc`，在自己那次运行里恰好取到最新活行——**是运气不是正确** |
| 修复与确定性验证 | 5 处查询统一改为 `and deleted_at is null order by id desc limit 1`（Postgres 4 处 + SQLite `verify-minimal-deployment.mjs` 1 处，跨库都支持）。改完连跑：`verify-daily-limit` **15/15 → 15/15**（退出码 0/0）、`verify-daily-observability` **17/17**（0）——两次都过才算数，一次过只能说明没踩到那一行 |
| 这条教训归位 | §15 早就写过"数行数必须加 `deleted_at is null`，否则会把墓碑当成泄漏"，我自己也在 2026-10-25 因误读墓碑误报过一次。**规则存在 ≠ 规则被应用到所有读库的地方**：这次漏的正是我们自己 harness 里的 SELECT。§9 的自检因此新增两条扫描：`AIza` 前缀，以及 `\|\| 'xxx'` / `${VAR:-xxx}` 这种默认口令字面量 |
| 第一次正则写宽了，收紧后重测 | 最初那条把 `KEY: 'value'` 也算默认口令，实测误伤上游的 `web/src/lib/admin-permissions.ts:37` `SECRET_VIEW: 'secret_view'`；去掉 `:` 分支后**默认口令扫描 0 命中**，`AIza` 仍命中 2 处（上游夹具，属预期，已在 §9 写明怎么区分）。顺带这条扫描自己也踩了"文档命中文档"的坑，所以它同样带 `$EX` |
| 我用 sed 改文档把文件弄坏过一次 | 为了收紧那条正则，我用 `sed -i` 做替换；模式里的 `\|` 与引号在 shell 中被拆解，结果 256 行几乎每行都被插入那段文本（`git diff --stat` 显示 256 insertions / 247 deletions）。处理：`git checkout -- docs/OPERATIONS.md` 回到上次提交的干净版（247 行、10 个小节完整），再用编辑工具逐处重做未提交的三处改动。**教训：内容编辑一律用编辑工具，不用 sed 处理含正则与引号的替换；改完必须看行数与小节数是否还是预期的。** |
| 这一段不证明的事 | 生产环境用真实口令的人不会被这些改动保护（它只保证仓库里没有弱默认）；`.env` 里现在有本地 PoC 口令，靠 gitignore 保护而非加密；上游那两个 `AIza…` 夹具要不要修是上游的事，我们不改（改了会扩大每次重放的冲突面）；GitHub alert #1 仍 open，直到有人按上面命令归档 |


## 24. 全新克隆能否直接跑起来（部署路径实测，2026-10-26）

要回答的是"把仓库给一台服务器，它能不能跑"，而不是"我这台开发机能不能跑"。所以用**全新克隆 +
全新数据卷 + 随机生成的密钥**做，不借用任何本地状态；步骤写进 `docs/DEPLOY.md`。

| 事项 | 结果 |
|---|---|
| 环境准备 | `git clone --depth 1 file:///F:/Project/new-api-v1.0.0-rc.47 <临时目录>` → 分支 `product/rc47`、`PRODUCT_VERSION=0.6.0`、compose 与 `.env.product.example` 都在 |
| 忘配置时是否拒绝启动 | 不建 `.env` 直接 `docker compose config --quiet` → **退出码 1**，三条错误逐条点名变量：`required variable POSTGRES_PASSWORD is missing a value: POSTGRES_PASSWORD must be set in .env - cp .env.product.example .env`。这是把"弱默认"删掉后的预期行为 |
| 用服务器该有的配置 | `cp .env.product.example .env`，再用 `secrets.token_urlsafe(18)` 重写 `POSTGRES_PASSWORD`/`REDIS_PASSWORD`/`SESSION_SECRET`/`NEW_API_ADMIN_PASS` 四个值 → `docker compose config --quiet` 通过 |
| 起服务 | `docker compose -p deploycheck -f docker-compose.poc.yml up -d` → **100 秒后 `new-api-poc` healthy**（Windows 上的 Docker Desktop；Linux 一般更快），postgres/redis 先 healthy |
| 服务自证 | `GET /api/status` → `version=0.6.0`；`GET /api/setup` → `{"status":false,"root_init":false,"database_type":"postgres"}`（空库、待 `/setup`，符合首次部署预期）；`GET /` 返回 SPA HTML |
| 服务器没有 Go/Bun 时怎么拿镜像 | `docker save new-api-daily-limit:0.6.0 -o newapi-0.6.0.tar` → **71 MB**（实测 8 秒）；随后 `docker rmi` 该 tag 再 `docker load -i` → `Loaded image`，tag 复原。即"开发机构建、服务器 load"这条路可用 |
| 一条必须写清的部署限制 | compose 里 `container_name` 是固定的（`new-api-poc` 等）。实测即使换 `-p deploycheck` 另起 project，容器名仍相同 → **一台机器只能跑一套**；要新旧版本同机对照，必须改 `container_name` 或拆 compose 文件 |
| 清理 | `docker compose -p deploycheck down -v` 删掉该 project 的卷与网络（实测 `deploycheck_postgres_data`/`deploycheck_redis_data` 已移除），再删临时目录与 tar；没有触碰默认 PoC 栈的卷 |
| 这一段不证明的事 | 真实公网的 TLS 反代、systemd/进程守护、多机或集群、大流量下的连接池与限流参数、Windows Docker Desktop 当生产环境——这些都没有对应环境，`docs/DEPLOY.md` 里也是按"未验证"写的，不当承诺 |

## 25. 上游衔接实测（2026-10-26，基线 rc.47 + 最新 main）

回答"上游衔接是否稳固"这个问题，不靠感觉，靠一条能重复的命令：

```bash
./scripts/upstream-sync.sh drill upstream/main
```

| 事项 | 结果 |
|---|---|
| 当前位置 | `v1.0.0-rc.47` 仍是上游**最新 release**（`gh release list` 前三名：rc.47 / rc.46 / rc.45）；`upstream/main` 比它多 6 个提交 |
| 冲突面预估 | `overlap with upstream/main: 0 file(s) changed by both sides since v1.0.0-rc.47` —— 零重叠文件，预期可无冲突重放 |
| 重放 | **全部 67 个提交 `Applying` 成功**，`==> working tree renormalized`，无任何 `Patch failed` / `conflicted files` |
| 门禁 | `go build ./...` 通过；`common` **ok 4.357s**、`model` **ok 5.824s**、`service` **ok 5.658s**；`==> typecheck: bun run typecheck (entry: bun check -b)` → `==> typecheck: ran`；结论行 `DRILL OK: upstream/main + the current series builds and passes the gate suite`，退出码 0 |
| 与上一轮的区别 | rc.46 时代同一动作需要人工解 `model/channel_constraint.go` 的 2 处；rc.47 把上游那两处变动吸收进基线后，**main 上已不再冲突**。也就是说我们欠的"技术债"不是累积的，而是随每次基线抬升而清零 |
| 结论怎么用 | 上游发下一个 tag 时，跑同一条命令；出现 `Patch failed` 就按 `docs/UPSTREAM_SYNC.md` 解那 1~2 处，再 `am --continue`，然后 `check`。这条链在 rc.46→rc.47、rc.47→main 两次真实动作里都走通了 |
| 清理 | 演练工作树用完即删（`git worktree remove --force ../new-api-upstream-main && git worktree prune`），不留在本机占空间，也不让下一次 drill 撞上"工作树已存在" |

## 26. 发行标记：tag + Release，以及随之处理的上游发布工作流（2026-10-26/27）

成品需要一个不可变的落点，不能只靠"某个提交号"。这一节记录发行动作本身，以及为了让打 tag 不再
触发一串失败工作流所做的处理。

| 事项 | 结果 |
|---|---|
| 发行 tag | `starbridge-0.6.0`（**annotated**，打在成品主线 `product/rc47` 的成品提交上）；已推送。远端复核 `git ls-remote --tags starbridge` 同时返回 `refs/tags/starbridge-0.6.0` 与 `…^{}`（证明是 annotated 而非轻量 tag） |
| GitHub Release | 已发布：`https://github.com/Ylsssq926/StarBridge/releases/tag/starbridge-0.6.0`；API 复核 `draft=false`、`prerelease=false`。正文写的都是已验证数字，并显式列出"未验证"三项（真实厂商 Key/出图、真实 Kiro/Antigravity 账号、公网 TLS 与多机）与许可证归属（AGPL-3.0 + 上游身份保留） |
| 打 tag 前先关掉会误触发的上游工作流 | 继承自上游的 5 条都在 tag/手动时会用本仓 secrets 尝试推镜像或发 release：`Publish Docker image (Multi-arch)`、`Publish Docker image (manual branch)`、`Build Electron App`、`Release (Linux, macOS, Windows)`、`Sync Release to GitCode`。用 `gh api -X PUT .../actions/workflows/<id>/disable` 全部置为 `disabled_manually`，复核 5 条全 disabled；我们自己的 `Product Gates` / `Upstream Drill` 与上游测试 `CI` 仍 active |
| tag 推送后的实际触发情况 | 推 tag 后 `gh run list` 只有 `Product Gates`（来自同批文档提交的 push）与它自己的定时运行，**没有任何发布类运行**。说明"先 disable 再打 tag"的顺序是对的；反过来（先打 tag）会立刻产生几条红色记录 |
| 自动化是否真的活着 | `Product Gates` 的**每周定时**在 2026-10-26 08:41 UTC 自己跑过一次并 `success`（run `40293991567`）——不是只有手动才会跑。`Upstream Drill` 的 cron 是**每周日 03:00 UTC**，下一次 2026-11-01；到本节写成为止它只有两次手动记录，**尚未被定时触发过**，这句别写成"定时演练已稳定运行" |
| 这一节不证明的事 | tag 不产生可下载的二进制或镜像（没有 registry；成品走 `docs/DEPLOY.md` 的 save/load）；Release 里的数字是"当时实测"，不随代码自动更新；关掉那 5 条工作流意味着上游的发布链在本仓不可用，要恢复得逐条 enable |

## 27. 把三个本地目录合并成一个（2026-10-27）

用户反馈的原话是"同时创建出来三个文件夹……我甚至都无法知道你现在做的更新是否是在我们本体目录"。
这不是误报：目录确实有三个，而且是我造成的。这一节记录它们各自是什么、怎么合并的、删了什么。

| 事项 | 事实 |
|---|---|
| 三个目录分别是什么 | ① `F:\Project\new-api`：用户早期自己克隆的仓库，停在迁移前的 `feat/channel-daily-token-limit`；② `F:\Project\new-api-rc46`：我 2026-10-25 迁移时新建的仓库本体（`.git` 在它里面）；③ `F:\Project\new-api-v1.0.0-rc.47`：**同一个仓库的 worktree**（第二份检出），当时为了把 rc.47 演练做在不影响主线的独立目录里，后来被我直接提成了主线。**Why 会这样**：`git worktree` 让一个仓库可以有多个工作目录，这在做"重放演练、不能弄脏主线"时是有用的；但我没有在使用完之后把它收敛回一个目录，也没有把"哪个才是主线"写在用户会看的地方——这是我的失误，不是 git 的 |
| 删除前做的安全核查 | 旧克隆：工作树干净（0 处 tracked 改动）、当前分支相对 `jonathan/feat/channel-daily-token-limit` **0 个未推送提交**；那个没跟踪远端的 `backup/vet-cleanups-included` 分支**先推到了用户自己的旧仓库**（`git push jonathan backup/vet-cleanups-included` → `[new branch]`），确保里面的 3 个中间版本提交不会因为删目录而消失。台账：HEAD 曾是 `ac98d145`，659 个 tag 均由上游可重新获取 |
| 合并动作 | ① 在仓库本体里 `git checkout product/rc47`；② `git worktree remove --force ../new-api-v1.0.0-rc.47` + `prune`（工作树里的 1.2 GB `node_modules` 本就是生成物，未保留）；③ 把旧克隆的内容清空（Qoder 会话的工作目录就是它，直接改名会 `Device or resource busy`，所以保留目录壳、清内容）；④ 把仓库本体的 `.git` 与工作文件整体搬进 `F:\Project\new-api`，删掉空的 `new-api-rc46`。本地 `.env`（含 PoC 凭据，gitignore）先备份再还原 |
| 合并后的自检 | `F:\Project\new-api` 是唯一目录；`git branch --show-current` = `product/rc47`；HEAD = `bced7a71d`；`PRODUCT_VERSION` = 0.6.0；`upstream-sync.sh base` = `v1.0.0-rc.47`；`export-series` → **71 patch == 71 提交、覆盖 89 个功能文件**；`git tag` 含 `starbridge-0.6.0`；`git worktree list` 只有它自己；`git status` 无未跟踪非忽略文件；两个远端都在（`origin`=上游、`starbridge`=公开仓） |
| 历史分支仍然可用 | 同一仓库里保留 `product/daily-limit`（rc.46 冻结线，只作证据落点）与 `rehearsal-rc47`（早期 53 提交彩排）。它们是**分支**，不占目录，需要对比时 `git checkout` 即可 |
| 以后怎么避免再乱 | 规则写进 `docs/OPERATIONS.md` §10 与项目备忘：**日常只用 `F:\Project\new-api` 一个目录**；需要演练新上游版本时由 `drill` 自己在 `../new-api-<tag>` 建临时工作树，用完 `git worktree remove` + `prune`。不要手工再开第二份长期检出 |
| 这一段不证明的事 | 合并只发生在本地目录层面，没有改动任何远端分支或 tag；GitHub 上的 `product/rc47`、`product/daily-limit`、`starbridge-0.6.0` 与合并前完全一致（本节未推送任何代码改动，只提交了文档） |

## 28. 对外仓库清空重传：单提交快照（2026-10-27）

用户的要求是"远端仓库直接清空重新传、不需要之前的记录，完全准备好部署"。这带来一个冲突：
`drill` / `export-series` 依赖**本地的上游祖先链**才能把补丁重放到新 tag 上；如果连本地也压成
单提交，跟上游的能力就断了。因此采用**双线**：

- 本地 `dev`：开发线，保留完整历史（含上游祖先链），所有门禁与 drill 在它上面跑；
- 远端 `main`：**对外快照线**，从零开始、首个快照就是一个根提交，只含"能直接部署的成品"；
- 发布脚本 `scripts/publish-snapshot.sh`：把 `dev` 的树压成一个快照提交，**追加**到 `main` 并
  fast-forward 推送（不是强推，所以 `main` 可以一直开着分支保护），必要时打 `v<版本>` tag。

本次重建执行的动作（可复核）：

| 步骤 | 内容 |
|---|---|
| 1 | 本地 `product/rc47` 改名 `dev`；CI 的 push 触发条件从 `product/*` 改为 `main` + `dev` |
| 2 | 生成首个快照：`dev` 的树 → 根提交 → 本地 `main`；校验 `main^{tree} == dev^{tree}` |
| 3 | 删除远端所有旧分支（`product/rc47`、`product/daily-limit`、5 条 dependabot 分支）与旧 tag `starbridge-0.6.0`、旧 Release |
| 4 | 推送 `main`（首个快照、无父提交）；把默认分支设为 `main`；对 `main` 开保护（禁 force/删除、对 admin 生效） |
| 5 | 推 `starbridge-0.6.0`（annotated，指向快照提交）；按快照内容发 Release |
| 6 | 验收：远端分支只有 `main`、tag 只有 `starbridge-0.6.0`、`main` 只有 1 个提交且树与本地 `dev` 一致、CI 在 `main` 上全绿、从远端全新克隆能起服务 |

验收判据（不满足就不算完成）：分支/tag 数量与名字精确匹配；`main` 的树哈希等于 `dev` 的树哈希；
`gh run list --branch main` 最新一次三 job success；全新克隆后 `docker compose up -d` 能 healthy
且 `/api/status` 自报 `0.6.0`。本次执行的实测结果记在 Release 说明与当次交付汇报里；
若后续再发布，同样按上表第 2/4/5/6 步复核。

**§28 补充（2026-10-27，CI 在 main 上实测暴露的一条规则）**：快照分支不适合跑"补丁重放"类校验。
现象：`main` 首个快照推送后，`sync-integrity` 报 `series: 1 patches` 且 `NOT COVERED by series: …`（列出全部我方文件）。
根因：快照提交是**根提交**，`git format-patch v1.0.0-rc.47..HEAD` 在无祖先关系时把整棵树（实测 2703 个功能文件）
当成一个补丁，而 `verify-series` 比对的是"基线之上的真实改动集"（89 个文件），两者必然不一致；
`status` 也会打印"Behind upstream: 6625 commits"这种对快照无意义的数字。
处理：`product-gates.yml` 里给 `sync-integrity` 加 `if: github.ref_name != 'main'`——**重放正确性由 `dev` 与每周 drill 保证，
`main` 上只由 backend + frontend 证明"这棵树能构建、测试能过"**。实测：`main` 上 backend/frontend 两个 job 是通过的。
这条属于"不许用错模型去验错的对象的典型"：门禁本身没错，错在把它指向了一个不满足前提的分支。

## 29. 用户级与分组级日预算（0.7.0，2026-10-28）

需求是"把每日预算从渠道扩到人/团队"。这一节记录设计边界、端到端证据，以及过程中被测试抓出来的问题。

| 事项 | 结果 |
|---|---|
| 数据存哪（不改表结构） | 用户预算写进既有的 `users.setting` JSON（`daily_token_limit` / `daily_request_limit`），写入是"读 JSON → 改两个字段 → 写回"，不会覆盖同一列里的通知/webhook 偏好；分组预算写进 options 的 `GroupDailyBudget`（JSON map），按原始字符串缓存，改完立即生效 |
| 计数 | 把渠道日计数器泛化成"字符串主体"，渠道键仍然是 `channel_daily_tokens:<id>:<date>`（输出未变），用户是 `<userID>`、分组是 `<group>`；Redis + 进程内回退、本地零点过期、"Redis 写失败仍本地计数"的行为全部继承 |
| 拦截点 | `middleware.Distribute()` 里、选路之前；顺序固定：用户 → 分组、token → 请求数。429 + 四个错误码 `user:daily_token_limit_exceeded` / `user:daily_request_limit_exceeded` / `group:*`，i18n 三语各 4 条 |
| 累加点 | 与渠道计数同一时刻：文本 relay 两处、`text_quota`、任务提交、任务轮询、Midjourney；请求预算只在"计一次请求"的地方 +1，异步任务不重复计 |
| 管理接口 | `GET/PUT /api/user/:id/daily_budget`、`GET/PUT /api/group/daily_budget`（都需 AdminAuth）。四个路由都补进 `access_token_routes.go` 的 `user:read`/`user:write` 声明——**router 里"每个面板路由都必须有归类"的测试当场抓到了这次遗漏**，否则会静默少一条规则 |
| 端到端（真实栈 + mock 上游，0.7.0 镜像） | `verify-daily-limit` 扩到 **20/20**：用户预算先 200 再 429（`user:daily_request_limit_exceeded`）、清零恢复 200；分组预算同理（`group:...`）；最后核对 `/api/user/:id/daily_budget` 报的用量与拦截读的是同一组计数器（`requests_used` 从 19 涨到 23） |
| 两次红灯都是 harness 自己的问题 | ① 分组列表接口只返回"已配置"的分组，未配置时读到 0，把限额设成 1 → 第一次请求就 429；修法：先设成不限再读基线。② 结算在响应之后落盘，读计数器前要等 2 秒。两条都写进用例注释，避免下次再犯 |
| 面板（浏览器实测） | 用户列表 → 行菜单 →「每日预算」：弹窗显示"今日已用 Token: 194 · 今日已用请求数: 23"（与 API 一致）；改 5000/7 保存 → toast「已保存」→ 重开读回 5000/7；改回 0/0 → API 复核 `limits=0/0, used=194/23`。顶部「分组每日预算」列出已配置分组与用量 |
| 一处环境限制（照实写） | 本会话的内置浏览器 `visibilityState=hidden`，退出动画不会完成，所以"保存后弹窗是否消失"只能断言它进入 `data-closed` 状态（应用确实关闭了），无法观察 DOM 卸载；有可见窗口时正常消失 |
| 质量门 | `go build ./...`、`common` 日限额用例、`model`/`service` 两套回归、`router` 全套测试、`tsgo -b`（1,409 文件）、oxlint 对新改 5 个文件 0/0 —— 全绿 |
| 这一段不证明的事 | 只验证了"按请求数"的用户/分组预算；"按 token"走同一条代码路径（同一组计数函数、同一处拦截）但没有单独的端到端用例；没有验证多实例下无 Redis 的降级（沿用渠道预算的既有结论：不一致但单机仍生效）；真实账号/真实厂商 Key 仍未验证 |

## 30. 多 key 渠道的每把 key 独立预算（0.8.0，2026-10-28）

"账号池治理"的第一半：把预算下沉到**每一把 key**（一条多 key 渠道背后通常就是一组账号），
并用同一组计数器把用量显示出来。自动摘除（连续失败禁用 + 冷却恢复）是下一半，尚未做。

| 事项 | 结果 |
|---|---|
| 存储 | 渠道 `setting` 新增 `key_daily_token_limits` / `key_daily_request_limits`（按 key 索引的 JSON map，0/缺省 = 不限）；仍然叠加在渠道级预算之上，**未改表结构** |
| 计数 | 复用"字符串主体"日计数器，主体为 `channelID:keyIndex`；Redis + 进程内回退、本地零点、写失败仍本地计数全部继承 |
| 选 key | `NextKeyWithinDailyBudget`：跳过已打满的 key（随机模式下最多尝试 2×key 数），整池打满返回 **429 `channel:key_daily_limit_exceeded`**；单 key 渠道行为不变 |
| 累加 | 三条文本 relay 路径在结算时按 `relayInfo.ChannelMultiKeyIndex` 记到对应 key；异步任务不携带 key 索引，故不计 per-key（已知边界） |
| 可见性 | `GET /api/channel/daily_usage/:id` 在多 key 渠道返回 `keys[]`（索引、掩码尾号、状态、禁用原因/时间、限额、今日用量）；渠道抽屉的每日预算面板新增「密钥」区。只回掩码尾号，不回密钥本体 |
| **顺带修掉的上游缺陷** | `Distribute` 调 `SetupContextForSelectedChannel` 时**丢弃了返回的错误**，于是"取不到 key / 池子打满"在客户端表现为 **500 `do_request_failed`**（实测复现）。现在按错误自身状态码与错误码响应：池满 → 429 + `channel:key_daily_limit_exceeded` |
| 端到端 | harness 扩到 **22/22**：先清掉同模型的其他渠道（否则选路会绕过它，这也是第一次跑红的原因），再打三次 → `200/200/429`，接口返回两把 key 各 1 次、尾号掩码正确 |
| 浏览器实测 | 渠道抽屉「其它设置」的面板显示「密钥」区：`#0 ***1111`（请求数 `0 / 5`，正是配置的每把 key 限额）与 `#1 ***2222`（无限制） |
| 质量门 | `go build ./...`、`router`/`common` 测试、`tsgo -b` 1,409 文件、`vitest run src/features/channels` **368/368**、oxlint 改动文件 0/0 |
| 这一段不证明的事 | 自动摘除/冷却还没做；per-key 预算只覆盖文本 relay（不覆盖任务提交与轮询）；没有 UI 编辑 per-key 限额（只能改渠道 setting JSON）；无 Redis 时多实例计数不一致（沿用渠道预算的既有结论） |

## 31. 失效 key 自动摘除与冷却恢复（0.9.0，2026-10-28）

"账号池治理"的第二半。上游其实**已经会**在失败时禁用"出错的那把 key"（
`UpdateChannelStatus(channelId, usingKey, …)` 会按 key 写状态、原因、时间），但禁用是**永久**的：
一次瞬时 401/429 就永久少一把 key，只能人工放开。这一节记录补上的冷却恢复与端到端证据。

| 事项 | 结果 |
|---|---|
| 配置 | 选项 `MultiKeyAutoRecoverMinutes`（默认 30，`<= 0` 关闭自动恢复，回到"等人工"的上游行为）；可通过既有的 `/api/option/` 热改，实测设置后立刻读回 |
| 决策 | 抽成纯函数 `keyCooldownElapsed`：只对状态=自动禁用生效；手动禁用永不自动恢复；没有禁用时间的 key 一律不动。单表测试覆盖 6 种组合 |
| 触发路径 | ① 选路时惰性恢复（渠道还在服务）；② 每分钟后台任务扫"整条渠道因 key 全禁而停用"的渠道——它们不会被选路，惰性路径够不着。恢复复用 `UpdateChannelStatus(..., enabled)`，状态/abilities/缓存一次写对 |
| 端到端（真实栈 + mock 上游） | harness **25/25**：mock 对含 `bad` 的 key 首次返回 401 → 该 key 状态变 3、`disabled_reason=status_code=401, invalid api key (mock)`，健康 key 继续 200；把冷却设为 1 分钟、等 65 秒发一次请求 → key 状态回到 1 且请求 200 |
| 三个踩坑（都已记进用例注释） | ① **自动禁用是 opt-in**：`AutomaticDisableChannelEnabled` 默认 `false`，不显式打开则禁用与恢复都不会发生；② 第一版断言只看探针状态，但"永久 401 的 key 刚恢复就再次失败"是**正确行为**，改成让 mock 只失败一次，断言才对应"恢复且可用"；③ 旧 mock 进程一直占着 3999、新 mock 启动失败，导致前两次改动**根本没生效**——`netstat` 找到监听 PID 后清掉才复现出正确结果 |
| 质量门 | `go build ./...`、`model`（含新增 `TestKeyCooldownElapsed`）/`common`/`router` 测试通过；前端未改（本版无 UI 变更） |
| 这一段不证明的事 | 恢复只按时间判断，不看失败次数或失败类型；"每分钟扫一次"意味着全渠道停用后的恢复最多延迟约 1 分钟；旁路容器里的账号状态仍未接进来（账号池治理的第三段）；真实上游的限流/风控语义（例如 429 是否需要更长冷却）没有实测 |

## 32. 每把 key 的预算可在面板里编辑（0.10.0，2026-10-28）

0.8.0 给了多 key 渠道"每把 key 独立日预算 + 用量"，但限额只能写渠道 setting 的 JSON；
0.9.0 补了自动摘除与冷却。这一版把最后一环补上：**在面板里直接改每把 key 的预算**，
并让任务类请求（生图/视频插件）也按 key 记账。同时修掉三个只有真跑才会暴露的缺口。

| 事项 | 结果 |
|---|---|
| 新接口 | `PUT /api/channel/:id/key_daily_limits`（`ChannelWrite`）。只对多 key 渠道生效；按 key 索引整体替换 `key_daily_token_limits` / `key_daily_request_limits`；**不存在的索引与负数直接拒绝**；留空表示该 key 不限。只写 `setting` 一列（`UpdateChannelSettingOnly`），因为处理器读渠道时不带 key，整行 `Updates` 会把 key 列表写空。缓存里的渠道同步更新，保存即时生效 |
| 面板 | 渠道抽屉 →「其它设置」→「每日预算用量」→「密钥」区多了「编辑每把 key 的预算」：每把 key 两行（已用 / 输入框），保存后 toast 并刷新；空值或 0 表示不限，不写进 setting。7 个语言文件补齐 4 个新 key（`missing=0`，新增项 `untranslated=0`） |
| 任务路径按 key 记账 | 任务创建时把 key 索引写进 `TaskPrivateData.ChannelKeyIndex`（仅多 key 渠道）；请求数在 `LogTaskConsumption` 记到该 key，token 在轮询结算时按同一索引累加。同步对话路径本来就走 `IncreaseKeyDailyUsage` |
| 抓到的回归 1（上游交互） | 我为了不再吞掉选路错误，把 `SetupContextForSelectedChannel` 的返回错误改成上抛，结果 `GET /v1/videos/:task_id` 直接 500 `get_channel_failed`：**任务查询路径本来就没有渠道**（`channel == nil` 是正常态，上游一直忽略该返回值）。用 `v1.0.0-rc.47` 的临时工作树对照确认这是我们的回归后，改为"只有真的选到渠道才设置上下文"；`go test ./router/` 从 FAIL 回到 ok |
| 抓到的回归 2（面板不可达） | 面板只在"渠道或 key 已有预算"时渲染，而设置预算的入口恰好在面板里——新渠道永远没有入口。改为"多 key 渠道只要有 key 就渲染"。组件测试从 6 条加到 7 条（新增"预算全为 0 时仍显示编辑入口"） |
| 抓到的回归 3（缓存未命中） | 单渠道用量接口在缓存未命中时用 `selectAll=false` 回退，读不到 key 列表 → 刚创建的渠道面板空白。改为单渠道回退也带 key（只回传 `***尾4位`），列表接口保持无 key 读取 |
| 端到端（真实栈 + mock 上游） | 最终镜像上连跑两次 harness，均为 **27/27**（清理无关格式化改动、重建镜像后再跑一次仍 27/27）。新增两条：① 越界索引与负数都被拒（`index=false negative=false`）；② 每把 key 限额经该接口写入后生效（两个 key 各 1 次请求 → `200/200/429 channel:key_daily_limit_exceeded`） |
| 浏览器实测 | 真实 Chrome（headless）：登录 → 渠道列表切表格视图 → 编辑 `verify-ui-per-key` →「其它设置」→「每日预算用量」→ 编辑 key#0 填 500 / 3 → 保存 → toast「每把 key 的每日预算已保存」→ 重开编辑器读回 **500 / 3**；同一时刻接口返回 `daily_token_limit=500, daily_request_limit=3`。截图用完即删 |
| harness 可重复性 | mock 的"失效一次"凭据是进程内存状态，第二次跑就不再失效 → 给 mock 加 `POST /__reset`，harness 开跑前复位（已连跑两次验证）；harness 结束时注销自己的管理员会话——此前每跑一次留一个，累计 50 个把 `AUTH_SESSION_LIMIT` 打满，下一次登录 409（另有一次连发登录触发 `CRITICAL_RATE_LIMIT` 20 次/20 分钟，429 且无 body；这是上游的预期保护，本地验证时清 `rateLimit:v2:ip:CT:*` 或等窗口） |
| 质量门 | `go build ./...`；`go test ./router/`（全包）、`./model`（Daily/FilterCandidate/TaskPlugin/Recovery）、`./service`（Settle/TaskBilling/LogTaskConsumption/Recalculate/Daily）、`./common -run Daily` 全通过；前端 `tsgo -b` 无错、vitest 7/7、oxlint 改动文件 0 错、oxfmt 改动文件格式一致（整仓 `format:check` 在本机因一个无关文件的 Windows `UNKNOWN` 读错误中断，非格式问题） |
| 镜像 | `new-api-daily-limit:{0.10.0,local}`、`starbridge-gateway:{0.10.0,local}`，306MB；容器 `/api/status` 自报 `version: 0.10.0` |
| 这一段不证明的事 | 任务类请求的**每把 key** 记账只做到代码与构建级验证：harness 的生图用例验证的是渠道级请求预算，没有在多 key 渠道上真实跑一次任务插件结算；前端只在 Chromium 下验证（未跑 Safari/Firefox）；每把 key 限额的并发保存没有做（整体替换语义，后写覆盖先写，与面板单管理员场景匹配） |

## 33. 账号保护：每把 key 的 RPM、429 冷却、粘性与恢复上限（0.11.0，2026-10-28）

用户对 kiro.rs 的评价是"反代成熟、不太封号"，要求重点参考。读它的发布记录后，真正能搬进**网关层**的是
节奏与故障处理语义（账号级 429 冷却换号、会话粘性、自愈有间隔与上限）；客户端身份（UA/域名/每账号出口 IP/
设备标识）在旁路容器里，网关代替不了。这一版把网关能管的部分做完，并把责任边界写进 `docs/OPERATIONS.md` §7.6。

| 事项 | 结果 |
|---|---|
| 每把 key 的 RPM | 渠道 setting 新增 `key_rpm_limits`（按 key 索引，0=不限）。选 key 时按 60 秒窗口原子计数，打满的 key 跳过；**整池都在限流**时返回 429 `channel:key_rate_limited`，与"日预算打满"区分。Redis 用 INCR+过期（多实例共享同一窗口），无 Redis 时退回进程内滑动窗口。面板的每把 key 编辑区多了"每分钟请求上限" |
| 上游 429 冷却 | 多 key 渠道收到上游 429 时，把**这一把 key**放进短冷却（选项 `KeyRateLimitCooldownSeconds`，默认 60，上限 600），**不写渠道禁用状态**；冷却自过期，选路自动跳过，其他 key 继续服务。冷却剩余秒数在用量接口与面板显示 |
| 客户端粘性 | 成功请求后把 `token + 渠道 + 模型` 绑定到实际服务的 key（`KeyAffinityTTLSeconds`，默认 600，0 关闭）；下一次请求优先同一把 key，key 不可用/冷却/超预算/超 RPM 时自动回退到正常选路。绑定在**响应发出后**写入，紧接着的请求可能读不到（测试里用 700ms 等待说明这一点） |
| 恢复上限 | 新增 `MultiKeyAutoRecoverDailyLimit`（默认 5，0 不限）：同一把 key 一天内被自动恢复到达上限后不再自动启用，留给人处理，避免"恢复→再失败→再恢复"无限循环。纯函数 `keyRecoveryAllowed` + 单表测试 |
| 抓到的上游缺陷（真 bug） | **自动恢复只改了缓存、没落库**：渠道整体仍是启用状态时，`UpdateChannelStatus` 在"目标状态 == 当前状态"处提前返回，per-key 的恢复写不进去；下一次缓存重建又变回禁用（harness 偶发 `probe=200 badKeyStatus=3` 就是它）。修复：多 key + 指定 key 的更新即使渠道状态不变也要持久化；新增 `TestUpdateChannelStatusPersistsMultiKeyRecovery`（禁用→恢复→直接读库断言条目已删）。这个缺陷 0.9.0 就存在，只是当时断言读的是缓存 |
| harness 隔离缺陷 | 上一轮残留的同名 auto 渠道和新渠道服务同一模型，请求被分流，状态断言读到另一个渠道。用例开始时现在删除**所有**同名渠道；顺带把 RPM 用例避开分钟边界、把异步状态改成轮询，消除偶发 |
| 端到端（真实栈 + mock 上游） | 最终镜像连跑两次 **32/32**。新增 5 条：RPM 打满与整池 429、清空 RPM 立即恢复、上游 429 冷却且另一把 key 继续服务、冷却到期后原 key 重新可用、客户端粘性（两次请求都落在 key0） |
| 浏览器实测 | 真实 Chrome（headless）：编辑渠道 →「其它设置」→ 每日预算用量 → 编辑每把 key 的预算 → key#0 的"每分钟请求上限"填 30 → 保存 → 直接查数据库 setting 含 `"key_rpm_limits":{"0":30}`、用量接口返回 `rpm_limit=30`、重开编辑器输入框读回 30 |
| 质量门 | `go build ./...`；`go test ./model`（新增恢复持久化与恢复上限用例）、`./router` 全包、`./service` 定向、`./common -run Daily|Key` 全通过；`relaykit` 在 `GOWORK=off` 下独立构建通过；前端 `tsgo -b` 无错、组件测试 8/8、oxlint 改动文件 0 错 |
| 镜像 | `new-api-daily-limit:{0.11.0,local}`、`starbridge-gateway:{0.11.0,local}`；容器 `/api/status` 自报 `version: 0.11.0` |
| 这一段不证明的事 | 多实例下的 RPM/冷却只做了代码路径（Redis）与单实例实测，没有起第二个网关实例对打；粘性 TTL 到期、恢复上限"到顶转人工"没有端到端跑（前者靠 TTL 语义，后者靠单表测试）；冷却时长没有读取上游 `Retry-After`，是固定选项（kiro.rs 会优先采用上游值）；旁路容器的 UA/域名/出口 IP/设备标识完全没动，所以"不太封号"仍取决于旁路配置与真实账号行为，本版只保证网关侧不主动制造封号诱因（突发、重复打限流账号、账号频繁切换） |

## 34. 冷却采用上游 Retry-After、单 key 探测、用量进度条（0.12.0，2026-10-28）

0.11.0 把账号保护的骨架搭好后，这一版补三个"operator 手感"上的缺口：限流时长听上游的、
坏 key 不用整池禁用就能单独验证、面板能看到每把 key 用了多少。

| 事项 | 结果 |
|---|---|
| 冷却采用上游 `Retry-After` | `RelayErrorHandler` 现在把 429 响应的 `Retry-After` 挂在错误上（支持 delay-seconds 与 HTTP-date），`MarkKeyRateLimited` 优先使用它，缺失才回退到 `KeyRateLimitCooldownSeconds`；仍统一夹在 1..600 秒。单测覆盖 `"2"` / `"0"` / 负数 / 乱码 / 空值；harness 中 mock 发 `Retry-After: 2`、选项故意设为 60，实测 `cooldown=2` |
| 单把 key 探测 | 新接口 `POST /api/channel/:id/test_key`（`ChannelOperate`）：把渠道复制成"单 key"副本交给现有 `testChannel`，不发账单、不改 key/渠道状态；返回 `{success,time,index,key_tail,error_code}`，形状与渠道测试一致。面板每把 key 旁有「Test」按钮，成功 toast 显示尾号与耗时 |
| 用量进度条 | 每行"已用 / 限额"下面加了 `role="progressbar"` 的细条（`aria-valuenow`），达到 100% 变色；未设限额不显示。浏览器里实测多 key 面板出现 4 条（2 key × 2 维度） |
| 端到端 | 最终镜像连跑两次 **33/33**（新增单 key 探测用例：永久 401 的 key 测试失败、健康 key 成功且两把 key 状态都保持 1）。浏览器：真实 Chrome 打开面板 → 4 条进度条 → 点第一把 key 的「Test」→ toast「Key #0（***ey-a）响应耗时 0.11 秒」 |
| 启动踩坑 | 有一次 harness 全量 500 `do_request_failed`：旧 mock 进程仍占着 3999，新 mock `EADDRINUSE` 退出，而 `curl /__reset` 命中的是旧进程（它当然返回 ok）。确认方式：直接打 mock、看 `mock=000` 与 mock 日志的 `address: '0.0.0.0', port: 3999`。清掉监听进程重启后 33/33。以后起 mock 必须先确认端口空 |
| 质量门 | `go build ./...`；`router` 全包（新路由需要写进权限表，访问令牌 scope 由权限自动派生，重复声明会被 `declared twice` 测试抓住）；`service` 单测（Retry-After 解析与错误携带）；`relaykit` 独立构建；前端类型检查、组件测试 9/9、lint/格式（改动文件） |
| 镜像 | `new-api-daily-limit:{0.12.0,local}`、`starbridge-gateway:{0.12.0,local}`；容器 `/api/status` 自报 `version: 0.12.0` |
| 这一段不证明的事 | `Retry-After` 的 HTTP-date 形式只有单测，mock 只发秒数；探测对 embedding/图像/流式模型没有专门用例（走的是同一条 `testChannel`，但未逐一实测）；进度条只在 Chromium 下看过；冷却上限 600 秒没有端到端触发 |

## 35. 旁路账号状态接入、每把 key 失败数、容量 429 不冷却（0.13.0，2026-10-28）

0.11 的账号保护只依赖网关自己观察到的信号（429、401、预算）。这一版补上"账号侧的事实"：
旁路知道某个账号额度用尽/被封禁，网关需要被告知；同时区分"账号被限流"与"模型过载"，
并把每把 key 今天失败了几次摆到面板上。

| 事项 | 结果 |
|---|---|
| 外部账号状态契约 | 新接口 `PUT /api/channel/:id/key_state`（`ChannelWrite`），body `{index,state,reason,until}`；`state` 支持 `quota` / `suspended` / `invalid` / `normal`（清除），`until` 是 unix 秒，**0 表示直到手工清除**。状态写进渠道 setting 的 `key_external_states`（不新增表）；选路跳过被阻塞的 key，到期自动恢复可选路（惰性判断）；整池都被阻塞时返回 `503 channel:key_unavailable`，与"限流 429 / 日预算 429"区分。`docs/OPERATIONS.md` §7.6 给了 curl 示例与"网关不轮询旁路"的理由 |
| 面板 | 每把 key 显示外部状态（额度用尽/账号被封禁/凭据失效）、原因与到期时间；今日失败数 > 0 时显示。浏览器实测：「账号状态：额度用尽: monthly quota exhausted (直到 2026/10/29 01:33:53)」 |
| 每把 key 失败数 | 新增日计数器 `key_daily_failures`，`ProcessChannelError` 里按实际服务的 key 累加；用量接口与面板展示。用来回答"哪把 key 在拖后腿"，不用翻日志库 |
| 容量 429 不冷却 | 429 正文命中容量类标记（`MODEL_TEMPORARILY_UNAVAILABLE`、`overloaded`、`insufficient_model_capacity` 等）时**不冷却 key**——账号没错，是模型忙；失败数照记。初版只匹配下划线形式，mock 的 `"model temporarily unavailable"` 没命中（实测 `cooldown=1`），补上带空格短语后通过 |
| 端到端 | 最终镜像连跑两次 **36/36**。新增 3 条：① 外部额度状态让 key0 被跳过（key0 用量 0 / key1 用量 1）；② 清除状态后 key0 重新被选中（用量 1）；③ 容量 429 后 `cooldown=0`、`failures=1`、下一次请求由另一把 key 服务 |
| 测试自身的一个坑 | 外部状态用例第一版失败：成功请求写入了客户端粘性，第二次请求仍然回到 key1。说明"粘性优先于轮询"，用例里把 `KeyAffinityTTLSeconds` 设为 0 并写明原因 |
| 质量门 | `go build ./...`；`router` 全包（新路由）；`service` 单测；`relaykit` 独立构建；前端类型检查、组件测试 10/10、lint/格式（改动文件） |
| 镜像 | `new-api-daily-limit:{0.13.0,local}`、`starbridge-gateway:{0.13.0,local}`；容器 `/api/status` 自报 `version: 0.13.0` |
| 这一段不证明的事 | **没有**随附任何旁路适配器：真实 AIClient2API/CLIProxyAPI/Kiro-Go 的账号状态怎么映射成 `quota`/`suspended`/`invalid`、什么时候推，需要按各家接口单独写（契约只定义了一次）；容量类标记是**厂商文案启发式**，遇到没覆盖的说法会退回普通 429 冷却；外部状态到期没有任何定时任务，只在下次选路/查询时生效；被外部状态阻塞时的 503 没有 `Retry-After` |
