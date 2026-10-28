# 上线后的操作面板（自服务接入模型与源）

结论：**有**。成品镜像自带 new-api Web 控制台，接入新的模型源、发令牌、定价、看用量、试调用、开关日限额全部在浏览器里完成，不需要改代码或重启容器。旁路（Kiro / Antigravity / Codex / Grok 账号池）各自的账号在旁路自己的控制台里加，new-api 只需要建一条渠道指过去。

## 1. 首次进入

| 步骤 | 地址 | 说明 |
|---|---|---|
| 初始化 | `http://<host>:3800/setup` | 空库首启会出现初始化向导，创建管理员账号并选择数据库状态；接口 `GET/POST /api/setup`。实测：向导建出的首个账号 `role=100` 直接是管理员，不需要手工提权 |
| 登录 | `http://<host>:3800/sign-in` | 支持密码、OAuth、Passkey、两步验证（是否开启由系统设置决定） |
| 注册 | `http://<host>:3800/sign-up` | 默认开放注册，可在「系统设置 → 运营/安全」关闭或改为邀请码制 |

> PoC 栈的管理员是你在 `/setup` 里自己设的那个账号密码；**仓库里不留任何默认口令字面量**（2026-10-26 起因旧的回退字面量被 GitGuardian 报过一次，已改成"环境变量缺失就报错并告诉你怎么传"）。跑验证脚本前把凭据放进 `.env` 并加载：`set -a; . ./.env; set +a`，键名是 `NEW_API_ADMIN_USER` / `NEW_API_ADMIN_PASS`。正式部署请立刻在「个人设置」里改密码。

## 2. 面板地图

管理员登录后左侧可用的页面（对应仓库 `web/src/routes/_authenticated/`，实测渲染正常）：

| 路径 | 用来做什么 | 与「接模型/接源」的关系 |
|---|---|---|
| `/channels` | 渠道（=上游源）增删改查、批量、分组、标签、优先级/权重、代理、自动禁用、健康测试、当日预算用量（已用/限额/今日被跳过的选路次数） | **接入新源的唯一入口** |
| `/keys` | 给自己/下游用户签发 API 令牌，可限模型、限分组、限额度、限 IP、限过期 | 决定谁能调用哪些模型 |
| `/models` | 模型清单，分 `metadata` / `vendors` / `deployments` 三段（元数据、供应商、部署） | 定价页与前端选单的数据来源 |
| `/system-settings/models` | 模型倍率、补全倍率、按次价格、分组倍率、模型改名/映射 | 新模型接进来后必须在这里有价格，否则请求 400 `model_price_error` |
| `/system-settings/operations` | 分节 `behavior`（自动禁用等行为）、`alerts`（余额/运行告警）、`email`、`worker`、`logs`、`performance`、`update-checker` | 影响容错与运维行为 |
| `/system-settings/request-policies` | 分节 `filtering`、`routing`、`health` | 控制多源之间的切换与渠道健康 |
| `/system-settings/security`、`/security` | 安全策略 + `request-limits` 分节（接口/令牌速率限制、SSRF 防护） | 上线必查；**速率限制与本项目新增的日预算是两回事**：限的是"多快"，日预算限的是"当天总量" |
| `/system-settings/site` `/content` `/auth` `/billing` | 站点信息、导航、公告、支付、登录方式 | 对外运营 |
| `/task-plugins` | 内置任务插件（生图/视频）绑定到渠道，含已注册插件清单 | 国内生图走这里，无需旁路 |
| `/playground` | 浏览器里直接调模型 | 新渠道建完第一时间验证 |
| `/usage-logs`、`/usage-logs/audit` | 每次请求的模型、渠道、token、花费、错误码；audit 页看管理端操作 | 排障与对账 |
| `/dashboard` | 汇总趋势（分节页） | 看整体负载 |
| `/users` `/redemption-codes` `/subscriptions` `/wallet` | 用户、兑换码、订阅、额度/支付 | 运营 |
| `/keys` 之外还有 `/profile` | 个人资料、密码、2FA、Passkey、OAuth 绑定 | 账号自助 |
| `/chat`、`/chat2link` | 内置会话与第三方客户端跳转配置 | 给使用者直接试 |
| `/system-info` | 版本、数据库/缓存状态、性能 | 确认补丁版本（成品 0.5.0 显示 `0.5.0`） |
| `/pricing`、`/pricing/<modelId>`、`/rankings`（公开） | 对外价格页与排行 | 客户端选型用 |

> 表格来自 `web/src/routes/` 的实际路由与各界面 `section-registry.tsx` 的分节 id，不是照抄上游 README；系统设置页大多带 `$section` 子路径，例如实测见过的 `/system-settings/request-policies/routing`。

## 3. 在 `/channels` 里能选到的源类型

渠道类型下拉是内置的（`constant/channel.go`），常用的有：

- 国内官方 API：`16` 智谱、`17` 阿里百炼、`25` Moonshot/Kimi、`43` DeepSeek、`45` 火山引擎、`54` 豆包、`23` 腾讯、`15` 百度、`35` MiniMax、`18` 讯飞、`38` Jina
- 海外官方 API：`1` OpenAI、`14` Anthropic/Claude、`24` Gemini、`41` VertexAI、`20` OpenRouter、`34` Cohere、`42` Mistral
- 订阅/账号型：`57` ChatGPT Subscription (Codex)
- 旁路与自建网关：`58` Advanced Custom（自定义路径规则）、`59` Sub2API、`60` New API（把另一个 new-api 当上游）
- 推理框架：`62` vLLM、`63` SGLang、`4` Ollama
- 生图/视频任务：`61` Task Plugin

「编码计划」类特殊 Base 也是内置的（`ChannelSpecialBases`）：`glm-coding-plan`、`glm-coding-plan-international`、`kimi-coding-plan`、`doubao-coding-plan`，每一条都同时带 OpenAI 兼容地址和 Claude 兼容地址，渠道里选到对应项即可，不用自己拼 URL。

补丁新增两个字段，都在渠道「其他设置」里，0 = 不限制：

| 字段 | key | 计量内容 | 到顶返回 |
|---|---|---|---|
| 每日 Token 限额 | `daily_token_limit` | 可计费的输入 + 输出 token（缓存不计入） | 429 `channel:daily_token_limit_exceeded` |
| 每日请求数限额 | `daily_request_limit` | 可计费的**请求条数**，包括生图/视频等不回报用量的按次任务 | 429 `channel:daily_request_limit_exceeded` |

两个预算互相独立：只设其中一个也能生效；到顶的渠道被跳过，同组其他渠道继续服务，次日零点（容器本地时区）自动重置。

## 4. 接一个新源的标准动作

1. `/channels` → 新建 → 选类型、填 Base URL + Key、填模型名（逗号分隔）、分组（如 `default`）。

批量接入不用手点，也不用写 curl：改一个 JSON 文件，跑一条命令。

```bash
cp channels.example.json channels.json   # 按需改类型/模型名/分组/两个日预算
export DEEPSEEK_API_KEY=... MOONSHOT_API_KEY=... AICLIENT2API_KEY=...
node scripts/import-channels.mjs channels.json --dry-run   # 先看会做什么
node scripts/import-channels.mjs channels.json             # 真正导入
```

规则：密钥只从环境变量取（`key_env`），文件里不写字面密钥，缺密钥的条目报 SKIP 而不会建成坏渠道；
同名渠道默认跳过，要覆盖加 `--update-existing`；`channels.example.json` 里已覆盖国内主流厂商
（DeepSeek / Kimi / 智谱 / 通义 / 豆包 / 文心 / 混元 / MiniMax / SiliconFlow）、旁路账号族
（Codex / Claude / Kiro / Gemini / Antigravity / GitHub Copilot / Grok / iFlow / Qwen）、
以及生图任务插件与自建 vLLM。
2. 需要限流就在「其他设置」里填「每日 Token 限额」和/或「每日请求数限额」。账号型上游建议两个都设：token 限额挡住文本刷量，请求数限额挡住生图/视频这类不回报 token 的消耗。
3. `/system-settings/models` 里确认这些模型有倍率或按次价格。
4. `/playground` 选该渠道对应的分组与模型，发一条测试。
5. `/usage-logs` 核对渠道 id、token 数与花费。
6. `/keys` 签发令牌给客户端。

命令行快速验证（把 `sk-xxx` 换成 `/keys` 里复制的令牌）：

```bash
curl http://<host>:3800/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" -H 'content-type: application/json' \
  -d '{"model":"<model>","messages":[{"role":"user","content":"hi"}]}'
```

## 5. 旁路源（Kiro / Antigravity / Codex / Grok）的账号面板

账号本身不在 new-api 里管理，在旁路容器里管理，然后再建一条 new-api 渠道指过去：

| 旁路 | 自带控制台 | 加账号方式 | 在 new-api 里怎么接 |
|---|---|---|---|
| AIClient2API | `http://127.0.0.1:3100` | 界面里逐个 provider 走 OAuth（容器内 `src/ui-modules/provider-api.js`、`oauth-api.js` 含 kiro/antigravity 相关模块；回调端口 8086 / 1455 / 56121 / 19876-19880 已在 compose 里只绑 127.0.0.1） | 渠道 `58` 或 `59`，Base URL `http://aiclient2api:3000/v1`，Key 填旁路自己的 API Key |
| CLIProxyAPI | `http://127.0.0.1:8317` | 配置文件 `access.api-keys` + 各 provider 登录 | 渠道 `58`，Base URL 指向 8317 |
| Sub2API | `http://127.0.0.1:8080` | 自带账号池与计费面板 | 渠道 `59`，填 Sub2API 颁发的 Key |

> 这三个控制台都不该直接暴露公网；远程管理用 SSH 隧道：`ssh -L 3100:127.0.0.1:3100 <server>`。

## 6. 各上游类型在面板里的适配

`scripts/verify-channel-types.mjs` 已按类型逐条验证（17 种类型 17/17 适配，15 种可路由类型到顶全部 429）：

| 类型 | 面板要求 | 日限额表现 |
|---|---|---|
| 1 / 14 / 17 / 24 / 25 / 43 / 45 / 54 / 59 / 60 / 62 / 63 | 直接可建 | 保存、更新后保留，到顶 429 |
| 58 Advanced Custom | 必须填 `advanced_custom` 路由（面板里有专门表单） | 与限额共存，到顶 429 |
| 61 Task Plugin | 必须选已注册插件 key（本机内置 `alibaba`，可在 `/task-plugins` 或 `GET /api/plugin/task` 查） | `task_plugin_key` 与两个日限额字段共存互不覆盖；生图任务不回报 token，但**会计入每日请求数限额** |
| 41 VertexAI | 必须填 Deployment Region | 未单独跑通，与不带限额时校验结果一致 |
| 57 Codex | 必须粘贴 OAuth JSON Key | 同上 |
| 16 Zhipu | 直接可建 | 限额本身正常，只是假上游没实现智谱路径，未断言 |

要点：

- 日限额字段对所有渠道类型都可见、可保存，改别的字段不会丢它。
- 生图/视频类渠道（61，以及按次计费的图片任务）不回报 token，因此**不受 `daily_token_limit` 约束**，但要设 `daily_request_limit` —— 它按请求条数计量，正好覆盖这类消耗。
- 想复跑这套检查：`node scripts/verify-channel-types.mjs`，它会自建自清理渠道。

## 7. 边界与排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 建完渠道马上 503 `model_not_found` | 内存缓存还没同步（PoC `SYNC_FREQUENCY=5`） | 实测：建完立即请求 503，等 7s 同一请求 200；要即时生效可关 `MEMORY_CACHE_ENABLED` 走数据库选路 |
| 400 `model_price_error` | 模型没定价 | 去「系统设置 → 模型/运营」补倍率或按次价格 |
| 429 `channel:daily_token_limit_exceeded` | 该渠道当日 token 已到达上限 | 面板里调高限额或置 0；次日零点（容器本地时区）自动重置 |
| 429 `channel:daily_request_limit_exceeded` | 该渠道当日请求数已到达上限（生图/视频/按次任务也算） | 同上；账号型上游建议两个预算都设 |

两个日预算计数器都按容器本地时区的"次日零点"过期：实测 `channel_daily_requests:<id>:<date>` 在当天 00:22 时剩余 TTL 85079s（≈23.6h），即零点整清空。
| 503 与 429 混淆 | 两者语义不同：503 = 没有候选渠道；429 = 候选都在日限额上 | 已实测区分，无需处理 |
| 刚发的请求没算进日限额 | 用量在响应发出后的结算阶段写入，瞬时并发可略微超限 | 与额度扣减同样的最终一致语义 |
| 令牌 Key 看不到了 | 接口只返回掩码 Key（安全设计） | 只能创建当次复制；必要时新建令牌 |
| 生图请求被上游拒 | 内置插件只覆盖阿里 `17`、豆包 `45/54` | 其它厂商用 `1`/`58` 渠道或旁路 |

## 7.5 每日预算设在哪（0.7.0）

| 想管谁 | 操作 | 看到的数字 |
|---|---|---|
| 渠道（上游） | 渠道列表 → 编辑 → 「其它设置」 | 今日 Token / 请求数 / 被跳过 |
| 某个用户 | 用户列表 → 该行「打开菜单」→「每日预算」 | 今日已用 Token / 请求数 + 两个限额输入 |
| 某个分组 | 用户页顶部「分组每日预算」→ 点一行填入表单 | 每个分组的用量与限额 |
| 多 key 渠道里的每把 key | 渠道抽屉 →「其它设置」→ 每日预算面板 →「密钥」区 | 每把 key 的今日 Token/请求数（带进度条）、每分钟请求上限、限额与禁用原因；「编辑每把 key 的预算」可直接改并保存；「Test」只对这一把 key 发一次最小请求，不计费、不改状态 |

三处都是 0 = 不限；保存立刻生效，不需要重启或等缓存。单把 key 的限额写在渠道 setting 的
`key_daily_token_limits` / `key_daily_request_limits` / `key_rpm_limits` 里（按 key 索引，JSON），面板通过
`PUT /api/channel/:id/key_daily_limits` 整体替换这三张表：不存在的 key 索引与负数会被拒绝，留空表示该 key 不限。
被上游判定失效的 key 会被自动停用（沿用上游的自动禁用），冷却后自动恢复：冷却时长由选项
`MultiKeyAutoRecoverMinutes` 控制（默认 30 分钟，<= 0 表示不自动恢复、等人工处理）。被拦时的响应是 429，
`error.code` 会带 `channel:` / `user:` / `group:` 前缀，客户端据此区分"上游满了"和"你自己超了"。

## 7.6 防封与账号保护：网关管什么、旁路管什么

订阅型上游的封号风险主要来自**请求形态**与**账号身份**，这两件事不在同一层。把责任写清楚，避免在网关里
做无效的"防封"配置：

| 层 | 它负责 | 配置入口 |
|---|---|---|
| 网关（本项目） | **节奏**：每把 key 的每分钟请求上限（`key_rpm_limits`）、上游 429 后短冷却（`KeyRateLimitCooldownSeconds`，默认 60 秒，上限 600）、整池被限流时返回 `429 channel:key_rate_limited`；**稳定**：同一客户端粘在同一把 key（`KeyAffinityTTLSeconds`，默认 600 秒，0 关闭）；**收敛**：失效 key 冷却后自动恢复，但同一 key 每天最多恢复 `MultiKeyAutoRecoverDailyLimit` 次（默认 5，0 不限），到顶转人工 |
| 旁路容器（AIClient2API / CLIProxyAPI / Kiro-Go 等） | **身份**：User-Agent / 客户端版本、上游域名与区域、每账号出口 IP（代理）、设备标识一致性；**凭据**：token 刷新、账号级 429 / 额度耗尽的换号与月度额度恢复 | 各旁路自己的配置文件/面板，网关无法代替 |

网关侧的三条原则：

1. **429 不等于坏 key**：只做短冷却并换 key，不写渠道禁用状态；永久失效（401/403 等）才走自动摘除。
2. **不做无限重试**：默认 `RetryTimes=0`，上游限流时把 `Retry-After` 语义留给客户端；要重试也应小于冷却时间。
   上游 429 若带 `Retry-After`，冷却直接采用该值（上限 600 秒），否则用 `KeyRateLimitCooldownSeconds`。
3. **一次请求只打一把 key**：池内跳过靠"节流 + 冷却 + 预算"，不是并发轰炸后看谁先成功。

**不采纳**的做法：通过重置设备/机器码、伪造客户端版本对抗厂商设备管控。这类做法把风险转移到账号本身，
也不是网关能验证的能力。参考 `ZyphrZero/kiro.rs`（MIT）时只借鉴了它的调度语义：账号级 429 冷却换号、
会话粘性、自愈要有间隔与上限；其"能力自足"的客户端身份由旁路负责。

## 8. 验证与运维护栏

渠道用量可见性：`/channels` → 某渠道「编辑」→「其他设置」页签，底部「每日预算用量」块显示
今日 Token（已用/限额）、今日请求数（已用/限额）、今日被跳过的选路次数，带「刷新」按钮；
两个限额都没配的渠道不显示这一块。数据来自执行层正在读的同一组计数器（接口
`GET /api/channel/daily_usage/:id`），不是另一套账。

备份提示：SQLite 走 WAL 模式，热备份必须把 `one-api.db`、`one-api.db-wal`、`one-api.db-shm` 一起取走，或先执行 `PRAGMA wal_checkpoint(TRUNCATE)`；只拷主库文件会得到一个几乎为空的库（实测见过 4KB 主库 + 3MB WAL）。

```bash
./scripts/product.sh ps          # 容器与端口状态
./scripts/product.sh logs        # 跟踪 new-api 日志
./scripts/product.sh check       # 后端构建 + 定向回归
./scripts/product.sh check-full  # 再加前端构建与类型检查
./scripts/product.sh status      # 与上游的落后程度 + 双向改动文件重叠面
./scripts/product.sh drill upstream/main   # 每月一次：重放 series + 构建/回归/类型门（非 0 就要人工处理）
./scripts/linux-gate.sh       # 跨平台门禁：在 node/golang 容器里重跑 shell+harness+后端回归（本机是 Windows，CI 是 Linux）
# 日预算可观测（只读，Admin/渠道读权限）
curl -s -H "Authorization: Bearer <admin-token>" -H "New-Api-User: 1" \
  http://localhost:3800/api/channel/daily_usage          # 所有有预算或用量的渠道
curl -s -H "Authorization: Bearer <admin-token>" -H "New-Api-User: 1" \
  http://localhost:3800/api/channel/daily_usage/<id>     # 单渠道：限额/已用/今日被跳过次数
# 计数字段叫 reject_selection_attempts_today，不是"被拒请求数"：一个被挡的请求会做
# 默认配置实测一个被挡请求做 2 次选路尝试，每次发现该渠道超额都计 1 次。
# 接口同时返回 retry_times 供参考，但不要用 retry_times+1 去换算请求数：那条推断已被实测证伪
# （默认 RetryTimes=0 下一个被挡请求计 2 次）。要请求级数字请看该渠道的 429 出现次数。

# harness 收尾约定（三个常驻栈上的脚本都遵守）：跑完把自己造的渠道和 token 删掉。
# token 列表接口是分页的 {page,page_size,total,items}，所以要先 /api/token/search?keyword=
# 拿 id 再 DELETE /api/token/:id；注意那是软删除（tokens.deleted_at），数活着的行要加
# deleted_at is null，否则会把墓碑当成泄漏。
# 端到端门禁：需要 compose 栈在跑，外加 node scripts/mock-upstream.cjs
node scripts/verify-daily-limit.mjs     # 日限额边界端到端（含无 Redis、出图不计 token 等形态）
node scripts/verify-compat.mjs          # 协议/接线
node scripts/verify-channel-types.mjs   # 逐渠道类型的面板适配 + 限额生效

# 最小部署形态实测（/setup 首启 + 两个日限额，无 Redis、无内存缓存）
# SQLite（默认，直接读库文件取明文 key）
docker run -d --name nap-sqlite -p 127.0.0.1:3811:3000 new-api-daily-limit:<version>
node scripts/verify-minimal-deployment.mjs
docker rm -f nap-sqlite
# MySQL / 其它引擎：用 KEY_CMD 指向一个打印明文 key 的脚本文件
# （KEY_CMD 会经过 bash -lc，内联反引号会被当成命令替换，务必放文件里）
EXPECT_DB=mysql KEY_CMD=/tmp/nap-mysql-key.sh node scripts/verify-minimal-deployment.mjs http://localhost:3812 nap-mysqlapp
```

### 8.1 备份恢复演练（Postgres）

```bash
./scripts/backup-drill.sh                # dump → 恢复到一次性库 → 逐表行数比对 → 清理
BOOT_CHECK=1 ./scripts/backup-drill.sh   # 再用恢复出来的库真起一个应用容器并探活
KEEP=1 ./scripts/backup-drill.sh         # 保留 dumps/ 备份文件与旁路库以便查看
```

一条硬规则先说清：**"带日预算的渠道是否整轮存活"这项，在源库里没有带预算渠道时是 `0 == 0`，等于空跑，所以脚本默认判失败**（0.6.0 上实测：无种子时 `FAIL ... would be vacuous`、退出码 1，且旁路库照常清理；先建一条带 `daily_token_limit`/`daily_request_limit` 的渠道再跑 → `PASS ... survived the round trip (1)`、退出码 0）。确实只想验证结构往返时用 `ALLOW_VACUOUS=1` 明确跳过。逐表行数比的是全量表（当前 38 张），不是抽样。

脚本只会读生产库，写和删都限制在名字形如 `nap_restore_<时间戳>` 的旁路库里（其它名字直接拒绝，
`createdb` 撞到已存在的库时也**不会**去 drop 它——这条已经实测过）。真出事要恢复时，
把 `pg_restore` 的目标换成应用库本身，并先停应用容器：

```bash
docker stop new-api-poc
docker cp backups/<name>.dump new-api-poc-postgres:/tmp/r.dump
docker exec new-api-poc-postgres pg_restore -U newapi -d new-api --no-owner --exit-on-error /tmp/r.dump
docker start new-api-poc
```

一条必须知道的边界：**两个日限额的当日计数器不是账本**。它们存在 Redis（或进程内回退），
不在数据库转储里；恢复数据库而不恢复 Redis，等于把当天已用额度清零——渠道只是重新开始消耗当天预算，
不会算错钱（计费看 `logs`/`quota_data`，那些在转储里）。所以恢复后如果预算保护很重要，
手工确认一次当天用量即可。

改完代码要发布：`./scripts/build-image.sh` 会重新生成 `bin/new-api-linux` 并打 `new-api-daily-limit:local` + `new-api-daily-limit:$(cat PRODUCT_VERSION)` 两个 tag。

## 9. 公开前自检（每次准备推到公开仓库之前跑一遍）

```bash
# 这些扫描命令本身写在本文档里，会和自己的文本撞上（本次实测就撞了两次），
# 所以统一排除本文档；否则一条真泄漏会被淹没在"文档命中文档"的噪声里。
EX=':(exclude)docs/OPERATIONS.md'
BASE=$(./scripts/upstream-sync.sh base)   # 基线只有一个来源，别在这里抄字面量
git rev-list --count "$BASE"..HEAD          # 私有提交数，以输出为准，别把本文里的数字当常量
git log -p "$BASE"..HEAD -- . "$EX" | grep -inE "sk-[A-Za-z0-9]{16,}|ghp_|gho_|-----BEGIN|AKIA[0-9A-Z]{16}" | head
git grep -ln "Jonathan\|C:/Users" -- . "$EX"   # 本地路径/用户名
git grep -l "^\.env$\|backups/" ; git ls-files | grep -iE "\.env$|\.pem$|id_rsa"   # 密钥与备份产物是否被跟踪
git remote -v | grep -iE "ghp_|gho_|:[^/]*@"   # remote URL 里的 token

# 2026-10-26 加的两条，都是密钥扫描报警之后补的：
# 1) 密钥形状。Google API key 有固定前缀，扫它才能把"上游测试夹具"和真凭据分开。
git grep -nE "AIza[0-9A-Za-z_-]{30,}" -- . "$EX"
# 2) 默认口令字面量：`X || 'xxx'` / `X = 'xxx'` 与 `${VAR:-xxx}` 这类"缺了就悄悄用默认值"
#    的写法——既会被判成 Generic Password，也会让脚本连到错误的栈上还显示通过。
#    正则里不收 `KEY: 'value'` 这种对象字面量：实测会误伤上游的 `SECRET_VIEW: 'secret_view'`。
git grep -nE "(ADMIN_PASS|PASSWD|PASSWORD|SECRET)[A-Za-z_]*(\|\||=) *'[^']{6,}'|\\$\{[A-Z_]+:-[^}]+\\}" -- . "$EX"
```

2026-10-26 复跑（65 个私有提交）：高熵凭据、本地路径、被跟踪的 `.env`/私钥、remote URL token 四类均 **0 命中**；新增两条按预期各有结果——`AIza` 命中 2 处且都在上游自带的 `relaykit/.../mask.go`、`mask_test.go` 测试夹具里（归属用 `git merge-base --is-ancestor` 证过，见 `docs/VERIFICATION.md` §23），默认口令字面量 **0 命中**（本轮把 6 个文件里的 9 处全部清除，改成环境必填 + 缺失即失败）。

**2026-10-26 起本仓库不再有默认口令字面量。** 之前 5 个 harness 写成 `process.env.NEW_API_ADMIN_PASS || '<固定的本地口令>'`、`verify-minimal-deployment.mjs` 写成 `const ADMIN_PASS = '<固定值>'`、compose 与备份演练写成 `${POSTGRES_PASSWORD:-<固定用户>}` / `${REDIS_PASSWORD:-<固定值>}`，这类"缺了就悄悄用默认值"的写法有两个真实危害：扫描器会一直报警（GitGuardian 就是为它发的通知），以及脚本可能连到另一套栈上"验证通过"。现在 harness 统一走 `scripts/poc-credentials.mjs`（缺凭据就退出码 1 并打印该传什么），首启类脚本改成每次随机生成凭据（它本来就是在自己创建的临时库里设管理员），compose 用 `${VAR:?...}`，演练脚本缺口令直接失败。连文档里都不再复述那些字符串——否则文档本身就会成为扫描器的命中项。

报警怎么读：GitGuardian 的 "Generic Password" 命中的就是上面那些**本地默认口令字面量**（我们自己的脚本，不是凭据）；GitHub 密钥扫描另报了一条 `google_api_key`（alert #1，open），实测定位到 `relaykit/relayconvert/kitutil/mask.go` 与 `mask_test.go` 里的 `AIza…` 样例串，用途是"错误信息里的密钥要打码"这个功能的测试夹具；引入它们的提交（`86ac0f77`、`19d435e7`＝上游 PR #7822）都是 `v1.0.0-rc.47` 的祖先——**上游自带、非真实凭据**。我没有替谁关闭那条 alert（关闭是仓库安全记录上的动作，可 reopen），要归档时执行 `gh api -X PATCH repos/Ylsssq926/StarBridge/secret-scanning/alerts/1 -f state=dismissed -f dismissal_reason=used_in_tests`。

## 10. 公开仓库自身的运维（不是网关的运维）

这一节管的是仓库、门禁与依赖机器人；上一节管的是"推之前查什么"。

| 事项 | 现状与操作 |
|---|---|
| 本地目录（**只有一个**） | `F:\Project\new-api` 是唯一目录，当前检出 `dev`（开发线，带完整历史，成品 0.12.0）。历史分支 `product/daily-limit`（rc.46 冻结线）与 `rehearsal-rc47` 只作为分支存在，不占目录。**不要手工 `git worktree add` 第二份长期检出**（2026-10-27 就因为这样出现过三个同名目录，见 `docs/VERIFICATION.md` §27）；演练新 tag 时 `drill` 自己建 `../new-api-<tag>` 临时工作树，用完删掉。判断自己在哪：`git branch --show-current` + `./scripts/upstream-sync.sh base` |
| 远端与分支（**对外只有 main**） | `starbridge` = 公开仓库，默认分支 **`main`**：**单提交起始的快照线**，只放"能直接部署的最终版"，没有开发历史。开发线 `dev` **不推送到远端**（`drill`/`export-series` 依赖它的上游祖先链）。发布只需 `./scripts/publish-snapshot.sh`：把 dev 的树压成一个快照提交，追加在 main 上并 push（fast-forward，不需要强推），必要时打 `v<版本>` tag。`origin` 仍指上游 `QuantumNous/new-api`，**永远不要往它推** |
| 发行 tag | 最新 **`starbridge-0.12.0`**（annotated，指向 main 的快照提交）。上游的 `v1.0.0-rc.*` 不往本仓复制：重放基线由同步脚本从 upstream remote 取，所以 CI 不能假设检出自带 tag（见 `docs/VERIFICATION.md` §19）。查看：`git ls-remote --tags starbridge` |
| 分支保护（**只保护 main**） | `main` 上已开：禁 force-push、禁删除分支、对 admin 生效；**不**要求 PR、**不**要求必需状态检查。因为发布是"追加提交"而不是强推，保护不会挡住 `publish-snapshot.sh`。开：`gh api -X PUT repos/Ylsssq926/StarBridge/branches/main/protection` 传 `{"required_status_checks":null,"enforce_admins":true,"required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}`；回退：同路径 `DELETE`；查看：同路径 `GET` |
| 门禁怎么跑 | 只有 `.github/workflows/product-gates.yml` 是我们自己的门：`backend` / `frontend` 在每个分支都跑；`sync-integrity`（补丁重放+覆盖校验）**只在 `dev` 跑**，因为 `main` 是根提交快照、没有上游祖先，series 模型对它不成立（实测 main 上会导出 1 patch / 2703 文件而必然报错）；上游 `ci.yml` 的 `CI` 也会跑，两边互补。它的 push 触发条件是 **`product/*` 通配**，所以换基线开新分支不需要再改 workflow（写死分支名的话，新主线上的推送会静默不跑门）。手动触发：`gh workflow run product-gates.yml --repo Ylsssq926/StarBridge --ref <分支>`（注意用**文件名**不是显示名，并显式给 `--repo`，否则 `gh` 会解析到 `origin`） |
| 上游那 5 条发布类工作流已禁用 | `Publish Docker image (Multi-arch)`、`Publish Docker image (manual branch)`、`Build Electron App`、`Release (Linux, macOS, Windows)`、`Sync Release to GitCode` 都继承自上游，在 tag 或手动触发时会尝试用**本仓**的 secrets 推镜像 / 发 release。我们不用它们（成品走 `docker save` 的 tar，见 `docs/DEPLOY.md`），2026-10-26 已用 `gh api -X PUT repos/Ylsssq926/StarBridge/actions/workflows/<id>/disable` 全部置为 `disabled_manually`，实测复核 5 条全为 disabled、我们自己的三条仍 active。**恢复**用同路径的 `/enable`。文件仍留在树里（不扩大重放冲突面），但 GitHub 不执行；注意它们占着 tag 触发的"坑位"，如果哪天启用了再打 tag，会立刻跑 |
| Dependabot | 上游带来的 `.github/dependabot.yml`（每周对 `/web` 开依赖升级 PR）**已删除**：对外 `main` 是生成出来的快照分支，合进去的依赖改动会被下一次发布覆盖，PR 只会制造噪声（2026-10-27 清空远端时 5 个 PR 被连带关闭，机器人还发了一条"不再提醒"的自动评论）。依赖升级改在开发线手动做：`cd web && bun update <pkg>` → 本地门禁 → 提交到 `dev` → 发布快照。仓库层面的**安全告警**（secret scanning / 依赖漏洞）不受影响，仍会用默认分支扫描；恢复版本升级就恢复该文件（注意它会再次对 `main` 开 PR） |
| 定时演练 | `upstream-drill.yml`（**每周日 03:00 UTC**，不是每月——上游实测 4~5 天一个 rc；`continue-on-error: true`，结论写进 job summary 与 `drill-log` 产物）。注册时机很反直觉：**只有推一个改动该文件的提交，GitHub 才把它列进 `GET /actions/workflows`**——第一次推送后它才出现并可 `gh workflow run`。已实测两次（run `40191317746` 暴露日志位置错误、`40191784310` 正常报告 `overlap 19 file(s)` 与 `conflicted files: model/channel_constraint.go`）。看结论不要看 job 颜色（它按设计永远绿），看 `drill_exit=` 与 summary 里的 `DRILL OK/FAILED` |
| 演练产物怎么读 | `gh run download <id> --repo Ylsssq926/StarBridge -n drill-log --dir <目录>`，再看 `grep -E 'overlap with|Patch failed|conflicted files:|drill_exit=' drill.log` 后面跟的缩进文件清单。冲突清单就是"跟上游这一步要人工处理的范围"，通常只有 1 个文件（现在就是 `model/channel_constraint.go` 的注释 hunk） |
