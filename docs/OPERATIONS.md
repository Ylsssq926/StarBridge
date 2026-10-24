# 上线后的操作面板（自服务接入模型与源）

结论：**有**。成品镜像自带 new-api Web 控制台，接入新的模型源、发令牌、定价、看用量、试调用、开关日限额全部在浏览器里完成，不需要改代码或重启容器。旁路（Kiro / Antigravity / Codex / Grok 账号池）各自的账号在旁路自己的控制台里加，new-api 只需要建一条渠道指过去。

## 1. 首次进入

| 步骤 | 地址 | 说明 |
|---|---|---|
| 初始化 | `http://<host>:3800/setup` | 空库首启会出现初始化向导，创建管理员账号并选择数据库状态；接口 `GET/POST /api/setup` |
| 登录 | `http://<host>:3800/sign-in` | 支持密码、OAuth、Passkey、两步验证（是否开启由系统设置决定） |
| 注册 | `http://<host>:3800/sign-up` | 默认开放注册，可在「系统设置 → 运营/安全」关闭或改为邀请码制 |

> PoC 栈当前管理员：用户名 `root`，密码 `rootpass123`（本次验证脚本设置的本地口令，正式部署请立刻在「个人设置」里改，或重建容器走 `/setup`）。

## 2. 面板地图

管理员登录后左侧可用的页面（对应仓库 `web/src/routes/_authenticated/`，实测渲染正常）：

| 路径 | 用来做什么 | 与「接模型/接源」的关系 |
|---|---|---|
| `/channels` | 渠道（=上游源）增删改查、批量、分组、标签、优先级/权重、代理、自动禁用、健康测试 | **接入新源的唯一入口** |
| `/keys` | 给自己/下游用户签发 API 令牌，可限模型、限分组、限额度、限 IP、限过期 | 决定谁能调用哪些模型 |
| `/models` | 模型元数据（供应商、能力、上下文窗口等）维护 | 定价页与前端选单的数据来源 |
| `/system-settings/models` | 模型倍率、补全倍率、按次价格、分组倍率、模型改名/映射 | 新模型接进来后必须在这里有价格，否则请求 400 `model_price_error` |
| `/system-settings/operations` | 自动禁用阈值、重试、并发、余额告警等运营开关 | 影响容错行为 |
| `/system-settings/request-policies` | 上游请求策略、路由与重试偏好 | 控制多源之间的切换 |
| `/system-settings/security` `/security` | 敏感操作、IP 白名单、审计 | 上线必查 |
| `/system-settings/site` `/content` `/auth` `/billing` | 站点信息、导航、公告、支付、登录方式 | 对外运营 |
| `/task-plugins` | 内置任务插件（生图/视频）绑定到渠道 | 国内生图走这里，无需旁路 |
| `/playground` | 浏览器里直接调模型 | 新渠道建完第一时间验证 |
| `/usage-logs` | 每次请求的模型、渠道、token、花费、错误码 | 排障与对账 |
| `/dashboard` | 汇总趋势 | 看整体负载 |
| `/users` `/redemption-codes` `/subscriptions` `/wallet` | 用户、兑换码、订阅、额度 | 运营 |
| `/system-info` | 版本、数据库/缓存状态、性能 | 确认补丁版本（成品显示 `0.1.0`） |
| `/pricing`（公开） | 对外价格页 | 客户端选型用 |

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
| AIClient2API | `http://127.0.0.1:3100` | 界面里逐个 provider 走 OAuth（回调端口 8086 / 1455 / 56121 / 19876-19880 已在 compose 里只绑 127.0.0.1） | 渠道 `58` 或 `59`，Base URL `http://aiclient2api:3000/v1`，Key 填旁路自己的 API Key |
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
| 建完渠道马上 503 `No available channel` | 内存缓存同步周期（PoC 设 `SYNC_FREQUENCY=5`） | 等 5~10s；或临时关掉 `MEMORY_CACHE_ENABLED` |
| 400 `model_price_error` | 模型没定价 | 去「系统设置 → 模型/运营」补倍率或按次价格 |
| 429 `channel:daily_token_limit_exceeded` | 该渠道当日 token 已到达上限 | 面板里调高限额或置 0；次日零点（容器本地时区）自动重置 |
| 429 `channel:daily_request_limit_exceeded` | 该渠道当日请求数已到达上限（生图/按次任务也算） | 同上；账号型上游建议两个预算都设 |
| 503 与 429 混淆 | 两者语义不同：503 = 没有候选渠道；429 = 候选都在日限额上 | 已实测区分，无需处理 |
| 刚发的请求没算进日限额 | 用量在响应发出后的结算阶段写入，瞬时并发可略微超限 | 与额度扣减同样的最终一致语义 |
| 令牌 Key 看不到了 | 接口只返回掩码 Key（安全设计） | 只能创建当次复制；必要时新建令牌 |
| 生图请求被上游拒 | 内置插件只覆盖阿里 `17`、豆包 `45/54` | 其它厂商用 `1`/`58` 渠道或旁路 |

## 8. 验证与运维护栏

```bash
./scripts/product.sh ps          # 容器与端口状态
./scripts/product.sh logs        # 跟踪 new-api 日志
./scripts/product.sh check       # 后端构建 + 定向回归
./scripts/product.sh check-full  # 再加前端构建与类型检查
./scripts/product.sh status      # 与上游 tag 的落后程度
node scripts/verify-daily-limit.mjs     # 日限额 10 项边界（需要 scripts/mock-upstream.cjs）
node scripts/verify-compat.mjs          # 协议/接线 7 项
node scripts/verify-channel-types.mjs   # 17 种渠道类型的面板适配 + 限额生效
```

改完代码要发布：`./scripts/build-image.sh` 会重新生成 `bin/new-api-linux` 并打 `new-api-daily-limit:local` + `new-api-daily-limit:$(cat PRODUCT_VERSION)` 两个 tag。
