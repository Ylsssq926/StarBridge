# 迭代规划（v0.1.0 → v1.0.0）

## 1. 产品目标

做一个**以国内模型为主、能接入 Kiro/Antigravity 等账号类上游、支持生图、且能长期跟上游更新**的 AI 网关成品。

成功标准：

1. 国内主流模型官方 API / Coding Plan 可直接接入并计费。
2. Kiro / Antigravity / Codex 等账号通过旁路服务接入，不污染 new-api 核心。
3. 图片/视频通过 new-api 内置 Task Plugin 或 OpenAI 兼容图片接口接入。
4. 私有补丁不超过 3 个小 patch，能在新上游 tag 上重放。
5. 每月可完成一次上游升级演练，构建、单测、核心链路不回归。

## 2. 当前基线 v0.1.0（已完成）

| 项 | 状态 | 证据 |
|---|---|---|
| 主项目从旧 fork 切换到上游 rc.46 | 完成 | 旧基线落后 841 commits |
| 日限额后端（选路/429/恢复） | 完成 | 真实请求 200 → 429 → 200 |
| 日限额前端 + 7 语言 | 完成 | 浏览器字段渲染 + 回显 123 |
| 三条旁路接入 | 完成 | AIClient2API / CLIProxyAPI / Sub2API 容器实测 |
| 生图主链路 | 完成 | OpenAI Images mock + 内置 Alibaba 插件 mock |
| compose 一键启动 | 完成 | 四服务 healthy + 容器网络验证 |
| 成品镜像 + 完整 compose | 完成 | `new-api-daily-limit:local` v0.1.0，Postgres/Redis/AIClient2API 全部 healthy |
| patch 跨版本重放 | 完成 | 纯净 rc.46 / main 均构建 + 单测通过 |

## 3. 路线图

### P1 · v0.2.0 国内模型生产接入（1–2 周）

目标：把“国内模型为主”从渠道列表变成真实可用。

任务：

- [ ] DeepSeek 官方 API（类型 43）
- [ ] Kimi / Moonshot 官方 API 或 Kimi Coding Plan
- [ ] 智谱 GLM Coding Plan（国内/国际）
- [ ] 豆包 / 火山方舟 Coding Plan
- [ ] 通义 / 百炼、MiniMax、百度千帆按需接入
- [ ] 建立分组：`official`、`coding-plan`、`subscription`、`image`
- [ ] 配置模型倍率、分组倍率、缓存计费
- [ ] 配置渠道优先级、权重、失败重试、自动禁用
- [ ] 为每个订阅类渠道设置 `daily_token_limit`
- [ ] 接入 Redis，保证多实例日限额一致
- [ ] 用真实 Key 复跑 `scripts/verify-channel-types.mjs`（目前 41/57/58/61 的必填项只有 mock 级别验证）
- [x] 生图/视频任务计入日限额：新增独立的 `daily_request_limit`（按请求条数计量，任务提交即计数），不改 token 语义、不做图片折算 token
- [x] 面板适配回归纳入发布流程：`node scripts/verify-channel-types.mjs` + `bunx vitest run src/features/channels`

验收：

- [ ] 至少 5 家国内上游真实调用成功
- [ ] 流式、工具调用、长上下文至少各验证 1 次
- [ ] 用量日志、计费、缓存命中数据正确
- [ ] 单渠道故障时能自动切换

依赖：真实厂商 Key / Coding Plan 订阅。

### P2 · v0.3.0 账号类旁路（1 周）

目标：Kiro / Antigravity / Codex 账号可稳定接入并可控。

任务：

- [ ] AIClient2API 接入 1 个 Kiro 账号、1 个 Antigravity 账号
- [ ] 验证 `/claude-kiro-oauth/v1/*` 与 `gemini-antigravity` 路由
- [ ] new-api 建立类型 58/59 渠道，配置模型映射
- [ ] 订阅账号一账号一渠道，不用多 Key 模式
- [ ] 配置渠道日限额、并发限制、失败切换
- [ ] 评估是否引入 Sub2API 作为账号池备选
- [ ] 评估 CLIProxyAPI 作为 MIT/Go 备选
- [ ] 记录账号失效、429、模型降级的处理流程

验收：

- [ ] Kiro/Antigravity 真实账号完成一次流式调用
- [ ] 账号 429/失效时能切换或明确报错
- [ ] 日限额能阻止单账号被跑穿
- [ ] 旁路重启后 new-api 渠道自动恢复

依赖：Kiro / Antigravity 账号凭据。

### P3 · v0.4.0 生图与任务（1 周）

目标：图片生成可用、可计费、可轮询。

任务：

- [ ] 阿里百炼 DashScope Key 接入 Wan / Qwen-Image
- [ ] 豆包 Ark Key 接入 Seedream 5.0 / 4.5 / 4.0
- [ ] 绑定 Alibaba / Doubao Task Plugin（类型 17/45）
- [ ] 验证 `/v1/images/generations`、`/v1/images/edits`
- [ ] 验证异步任务提交、轮询、产物下载
- [ ] 校验图片计费与 usage facts
- [ ] 评估 OpenAI GPT-Image / Gemini Imagen（类型 1/24）
- [ ] 可选：AIClient2API 图片接口作为补充

验收：

- [ ] 阿里、豆包各真实出图 1 张
- [ ] 图片任务计费与日志正确
- [ ] 失败任务能退款/不扣费
- [ ] 任务产物 URL 可访问

依赖：DashScope / Ark Key。

### P4 · v0.5.0 运维与可观测（1 周）

任务：

- [ ] Postgres + Redis 生产化（备份、连接池、监控）
- [ ] 日志、错误告警、渠道健康看板
- [ ] 日限额指标（当前用量/限额/拒绝次数）
- [x] 备份与恢复演练：`scripts/backup-drill.sh`（Postgres）—— 转储→旁路库恢复→38 张表逐表行数比对→用恢复库真起容器探活，全绿；失败路径实测不会误删同名库。SQLite/MySQL 的等价实测仍走 `verify-minimal-deployment.mjs`（2026-10-25）
- [ ] 灰度升级流程（先旁路，再 new-api）
- [ ] 安全：管理员权限、OAuth 凭据加密、代理访问控制

验收：

- [x] 备份可恢复（Postgres 已实测：转储→旁路库→逐表行数一致→恢复库能起服务并 `/api/status` 通过；SQLite/MySQL 由最小部署形态实测覆盖，尚未做同等演练）
- [ ] 关键告警可触达
- [ ] 升级/回滚演练通过

### P5 · v1.0.0 上游同步与 CI（持续）

任务：

- [x] 每月检查 new-api release/tag：收敛成一条 `./scripts/upstream-sync.sh drill upstream/main`，输出 overlap 预估 + 重放结果 + 门禁结果，非 0 即代表要人工处理（2026-10-25）
- [x] 用 `scripts/upstream-sync.sh apply <ref>` 重放 series（tag 或 `upstream/main` 均可），两条路径都实测过（2026-10-25）
- [x] 向前升级演练：20 个提交重放到超前 rc.46 23 个提交的 `upstream/main`，只有 `model/channel_constraint.go` 冲突两处，其余自动合并，构建与回归全绿（2026-10-24）
- [x] 解决已知冲突热点：在 `upstream/main` 上完整跑通 25 个提交的重放，人工介入 2 处（`model/channel_constraint.go` 的 switch 取并集、一行注释取我方），升级树构建与回归全绿（2026-10-25，清单见 `docs/UPSTREAM_SYNC.md` §3.3）
- [ ] 升级前确认上游 typecheck 入口与 CI 的 bun 版本匹配（main 上已变为 `bun check -b`，bun 1.3.14 不支持）
- [x] 跑构建、单测、前端类型检查（`drill` 的 `check` 段现在会在重放树里先装依赖再跑 `tsgo -b`，类型入口缺失判失败而不是告警；`main.go` 的 `go:embed web/dist` 由脚本自动复用或构建）（2026-10-25）
- [ ] 跑 compose 烟测与逐类型/三库最小部署实测
- [ ] `export-series` + `verify-series` 导出并校验新基线序列
- [ ] 灰度发布 + 回滚预案

验收：

- [ ] 连续 3 个上游 tag 重放成功
- [ ] 私有补丁仍小于 3 个、总量可控
- [ ] 核心链路无回归

## 4. 上游跟进策略

### 4.1 基线选择

- 主基线：最新稳定 release tag（当前 `v1.0.0-rc.46`）
- 预演基线：`upstream/main`
- 禁止：继续在 2026-05 的旧 fork 上开发

### 4.2 补丁边界

只保留三类私有改动：

1. 渠道级日 Token 限额（当前）
2. 必要的配置/UI 字段（当前）
3. 明确的运维钩子（未来按需）

不把以下内容合入核心：

- Kiro / Antigravity OAuth
- 账号池调度
- 厂商逆向协议
- 支付/商业化逻辑

这些全部放旁路。

### 4.3 冲突热点

上游经常改、patch 容易冲突的文件：

- `dto/channel_constraints.go`
- `model/channel_constraint.go`
- `service/channel_select.go`
- `service/text_quota.go`
- `service/quota.go`
- `service/task_polling.go`
- `web/src/features/channels/lib/channel-form.ts`
- `web/src/features/channels/components/drawers/channel-mutate-drawer.tsx`

升级时优先检查这些文件。

## 5. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 上游重构选路/计费 | patch 冲突 | 保持补丁小；按过滤器/结算钩子接入；每月演练 |
| 上游改前端表单结构 | UI 补丁冲突 | 只加字段，不改表单框架；组件测试 |
| 旁路协议变化 | Kiro/Antigravity 失效 | 旁路独立升级；new-api 只认 OpenAI/Claude 兼容接口 |
| 订阅账号失效/429 | 请求失败 | 一账号一渠道、日限额、优先级/权重、失败切换 |
| 真实厂商 Key 缺失 | 无法完成真实链路 | 先用 mock 验证协议；拿到 Key 后按 P1/P3 验收 |
| 多实例日限额不一致 | 限额失效 | 生产必须启用 Redis；无 Redis 仅单实例 |
| 日限额语义/任务覆盖有限 | 误判限额 | 只统计可计费输入+输出；任务仅覆盖 token 重算路径；文档写明边界 |
| PoC 安全未生产化 | 凭据/流量暴露 | 反向代理 + TLS + 非 root + 密钥管理 + 内网旁路 |

## 6. 完成定义（Definition of Done）

一个阶段完成必须同时满足：

1. 代码/配置已落地。
2. 构建、单测、前端类型检查通过。
3. 至少一条真实或可控 mock 的端到端链路通过。
4. 文档/操作步骤已更新。
5. 上游 patch 仍可重放。
6. 有回滚方案。

## 7. 明确不做

- 不把旁路项目代码整体 merge 进 new-api 核心。
- 不在旧 fork 上继续堆功能。
- 不为未验证的“未来需求”提前抽象。
- 不把商业支付/合规能力放进当前 v0.x 范围。
