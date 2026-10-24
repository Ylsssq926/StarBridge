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
| 前端 lint | `bunx oxlint ...` | 0 warning / 0 error |
| 渠道组件测试 | `bunx vitest run ...` | 95 passed |
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

**SQLite 与首启初始化实测**（`scripts/verify-sqlite-setup.mjs`，10/10）：用交付镜像 `new-api-daily-limit:0.2.0` 起一次性容器，不带 `SQL_DSN` 也不带 Redis，即"最小可部署形态"，逐项实测：

| 检查 | 结果 |
|---|---|
| 空库首启 | `GET /api/setup` → `database_type=sqlite`、`root_init=false` |
| 初始化向导 | `POST /api/setup` 返回"System initialized successfully" |
| 向导账号权限 | 首个账号 `id=1 role=100`，可直接调用管理端接口（无需手工提权） |
| 两个日限额保存 | `{"daily_token_limit":10}` / `{"daily_request_limit":1}` 原样落库 |
| token 预算 | 数据库选路 + 进程内计数：200 → 429 `channel:daily_token_limit_exceeded` |
| 请求数预算 | 生图（无 token 回报）：200 → 429 `channel:daily_request_limit_exceeded` |

顺带查到一个运维要点：SQLite 以 WAL 模式运行，容器里主库文件只有 4KB、真实内容全在 `one-api.db-wal`（3MB）。只 `cp` 主库文件会得到一个"空库"，备份必须连 `-wal`/`-shm` 一起取，或先做 checkpoint。

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
11. **数据库兼容**：新增代码不含裸 SQL、不加列、不改 `model/main.go` 迁移，SQLite/MySQL/PostgreSQL 三库行为一致（PoC 实测 Postgres；回退路径实测无 Redis）。

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

## 12. 分支化与上游跟进机制加固（本轮）

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
| SQLite 最小部署形态 | `verify-sqlite-setup` 10/10：`/setup` 首启建管理员（role=100）、两个预算原样落库、数据库选路 + 进程内计数下都能 429 |
| CI 门禁落地 | 新增 `.github/workflows/product-gates.yml`（backend / frontend / sync-integrity）；YAML 解析通过，sync-integrity 的等价命令在本地演练通过（CI_SYNC_JOB_WOULD_PASS）。演练中发现 `go:embed web/dist` 会让没有前端产物的重放工作树编译失败，改为由 frontend job 产出 dist 供 replay 使用 |

自审发现的实现过程失误（同样记录，避免"只留成功叙事"）：

- 第一次 `git add` 混入了一个不存在的路径，导致该批 add 整体失败，功能提交只含 i18n 与脚本；靠提交后 `git status` 复查发现，补齐后合并进同一个功能提交。
- 给 `verify-daily-limit.mjs` 加辅助函数时重复声明了 `listChannels`，`node --check` 直接报 SyntaxError；说明脚本必须先过语法检查再跑。

自审发现的真实缺陷（均已修并留证）：

1. `daily_token_limit` 未登记进面板"其他设置"区块 → 编辑时配置区跳回 connection。
2. 只设日限额的渠道不显示"已配置"标记。
3. `.mjs` / `.cjs` / `.patch` 无 eol 规则 → Windows 全新检出得到 CRLF 脚本（升级当天才炸）。
4. `.gitattributes` 修复在 `git am` 的重放顺序下不追溯生效 → 重放末尾正规化工作区。
5. `patches/series/` 入库导致永久脏工作区（`[PATCH n/m]` 计数每次导出都变）→ 改为生成物，`apply` 缺失时自动导出。

仍未闭环（外部依赖，非机制问题）：真实 Kiro/Antigravity 账号、真实国内厂商 Key 与出图、生图/按次计费任务的日限额计量（迭代计划 P1，任务 #16）。
