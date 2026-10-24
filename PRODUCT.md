# 星桥 StarBridge · New API 国内模型网关（成品说明 v0.2.0）

## 名称与来源

- **星桥 / StarBridge** 是本成品（发行版）的名称，只作用于发行物命名：镜像别名 `starbridge-gateway:<version>`。
- 代码主体的上游身份保持不变：模块路径 `github.com/QuantumNous/new-api`、`LICENSE`（AGPL-3.0）、`NOTICE` 与 `THIRD-PARTY-LICENSES.md` 均随镜像分发。
- 官方上游镜像仍写作 `calciumion/new-api`，PoC 可直接用它替换 `NEW_API_IMAGE`（此时不含本项目的私有补丁）。
- 旁路能力（Kiro / Antigravity / Codex / Grok 账号接入）由 AIClient2API、CLIProxyAPI、Sub2API **各自独立部署**后经渠道类型 58/59/60 接入；本项目不包含它们的源码，因此不改动本项目的许可证。

## 定位

以 **QuantumNous/new-api 最新上游**为主项目，做一套面向国内模型的聚合网关：

- 国内官方 API / Coding Plan 统一接入
- ChatGPT Codex 订阅原生接入
- Kiro / Antigravity / Claude / Copilot 等账号类上游通过旁路服务接入
- 生图 / 视频通过 new-api 的图片接口与 Task Plugin 接入
- 私有补丁保持很小，能持续跟随上游 release

本仓库不是旧 fork 的继续开发，而是 **从上游 release 重新承载私有补丁** 的成品基线。

## 目录

| 路径 | 说明 |
|---|---|
| `PRODUCT.md` | 本文档 |
| `PRODUCT_VERSION` | 成品版本 |
| `docs/ITERATION_PLAN.md` | 迭代规划与验收标准 |
| `docs/UPSTREAM_SYNC.md` | 上游跟进、patch 重放、回滚 |
| `docs/PROVIDER_MATRIX.md` | 国内模型 / 生图 / 旁路矩阵 |
| `docs/OPERATIONS.md` | 上线后的自服务操作面板：接模型、接源、发令牌、排错 |
| `docs/VERIFICATION.md` | 已完成的验证证据 |
| `docker-compose.poc.yml` | new-api + AIClient2API + Postgres + Redis |
| `.env.product.example` | compose 环境变量模板 |
| `Dockerfile.product` | 成品镜像（复制 Linux 二进制） |
| `Makefile.product` | 可选 make 入口（本机未安装 make 时用 product.sh） |
| `scripts/product.sh` | 统一入口：image / up / down / ps / logs / status / check |
| `scripts/build-image.sh` | 构建含私有补丁的成品镜像 |
| `scripts/upstream-sync.sh` | 上游状态 / 导出 / 重放 / 校验 |
| `scripts/mock-upstream.cjs` | 假上游（固定 usage），供端到端脚本使用 |
| `scripts/verify-daily-limit.mjs` | 日限额 10 项边界检查（缓存路径 / DB 路径 / 无 Redis 均可跑） |
| `scripts/verify-compat.mjs` | 协议与接线兼容检查（chat / messages / gemini / images / 错误语义） |
| `scripts/verify-channel-types.mjs` | 逐上游类型的面板适配与限额生效检查 |
| `patches/series/` | **主机制**：由分支提交生成的 patch series（`git am -3` 重放） |
| `patches/legacy/` | pre-commit 基线的手工 file patch，仅供 `USE_SERIES=0` 回退与历史对照 |

已构建镜像：`new-api-daily-limit:local` / `:0.2.0`，别名 `starbridge-gateway:local` / `:0.2.0`（约 312MB，含 `LICENSE`、`NOTICE`、`THIRD-PARTY-LICENSES.md`）。版本 tag 不可变：内容变化必须升 `PRODUCT_VERSION`。

## 快速启动

### 模式 A：成品镜像（含日限额补丁）

前置：Docker、Go 1.26+、Bun。

```bash
cp .env.product.example .env
# 修改 .env 中的密码和 SESSION_SECRET
./scripts/product.sh image
./scripts/product.sh up
```

等价的原始命令：

```bash
./scripts/build-image.sh
docker compose --env-file .env -f docker-compose.poc.yml up -d
```

如果本机有 make，也可以：

```bash
make -f Makefile.product image up
```

访问：

- New API：`http://localhost:3800`
- AIClient2API：`http://localhost:3100`

### 模式 B：快速 PoC（官方镜像，不含私有补丁）

```bash
cp .env.product.example .env
# 把 NEW_API_IMAGE 改为 calciumion/new-api:latest
docker compose -f docker-compose.poc.yml up -d
```

官方镜像用于验证旁路与渠道协议；成品功能（日限额）需要模式 A。

## 首次配置

> 面板里怎么操作、有哪些页面、接一个新源的完整步骤见 `docs/OPERATIONS.md`。

1. 打开 New API，完成管理员初始化。
2. 添加上游渠道：

   | 上游 | 渠道类型 | Base URL / Key |
   |---|---|---|
   | DeepSeek | 43 | `https://api.deepseek.com` + 官方 Key |
   | 智谱 GLM Coding Plan | 26 | `glm-coding-plan` 或官方端点 + Coding Plan Key |
   | Kimi Coding Plan | 25 | `kimi-coding-plan` 或官方端点 + Key |
   | 豆包 Coding Plan | 45 | `doubao-coding-plan` + Ark Key |
   | AIClient2API（Kiro/Antigravity/Codex/Grok） | 59 | `http://aiclient2api:3000` + 旁路 API Key |
   | CLIProxyAPI（备选） | 58 | `http://<host>:8317` + 旁路 API Key |
   | 阿里百炼生图 | 17 + Alibaba 插件 | `https://dashscope.aliyuncs.com` + DashScope Key |
   | 豆包 Seedream | 45/54 + Doubao 插件 | `https://ark.cn-beijing.volces.com` + Ark Key |
   | OpenAI/GPT-Image | 1 | 官方或兼容 Base URL + Key |

3. AIClient2API 首次启动后，在 `http://localhost:3100` 添加 Kiro/Antigravity 账号。
4. 给订阅类渠道设置“每日 Token 限额”和“每日请求数限额”：前者挡文本刷量，后者挡生图/视频等不回报用量的按次消耗，避免单账号被跑穿。

## 设计原则

1. **核心不合并旁路代码**：账号池/OAuth 刷新放在 AIClient2API / CLIProxyAPI / Sub2API，通过 58/59/60 渠道接入。
2. **私有补丁保持小**：当前只有日限额一个特性，约 500 行；改的是过滤器 + 结算钩子，不重写选路核心。
3. **跟上游优先**：每次升级从新 tag 建 worktree，重放 `patches/0001`、`0002`，跑 `scripts/upstream-sync.sh check`。
4. **国内模型优先**：DeepSeek、Kimi、智谱、通义、MiniMax、火山、百度、腾讯等使用 new-api 原生渠道。
5. **生图走官方扩展点**：优先用 new-api 内置 Task Plugin（阿里 Wan/Qwen-Image、豆包 Seedream），不修改核心。

## 许可证与分发

本项目基于 new-api（AGPL-3.0）。对外分发镜像/二进制时，需按 AGPL-3.0 提供对应源码；成品镜像保留 `LICENSE`、`NOTICE`、`THIRD-PARTY-LICENSES.md`。AIClient2API、Sub2API、CLIProxyAPI 各自遵循其独立许可证，使用前请分别确认。

镜像默认使用 `latest` 便于快速验证；生产部署建议在 `.env` 中 pin digest（`.env.product.example` 已给出 AIClient2API 的快照 digest 注释）。

生产前至少完成：修改所有默认密码、启用 TLS/反向代理、配置 Postgres 备份、启用 Redis（多实例日限额）、设置 `SESSION_COOKIE_SECURE`、评估非 root 运行。compose 已默认把 AIClient2API 的 OAuth 管理面绑定到 `127.0.0.1`；远程使用请走 SSH 隧道或带认证的反向代理。

## 迭代规划

详见 [docs/ITERATION_PLAN.md](docs/ITERATION_PLAN.md)。当前 v0.1.0 已完成：

- 上游基线重建
- 日限额后端 + 前端 + 测试
- 三条旁路容器验证
- 内置阿里图片插件 mock 验证
- compose 起停与容器网络验证
- patch 跨 rc.46 / main 重放验证

## 上游更新

详见 [docs/UPSTREAM_SYNC.md](docs/UPSTREAM_SYNC.md)。核心命令：

```bash
./scripts/upstream-sync.sh status
./scripts/upstream-sync.sh export-series v1.0.0-rc.46   # 分支提交 → patches/series + fail-closed 校验
./scripts/upstream-sync.sh apply v1.0.0-rc.47           # 新 tag 上 git am -3 重放 series
./scripts/upstream-sync.sh check ../new-api-v1.0.0-rc.47
# 发布前完整校验（worktree 内构建前端 + typecheck + 后端回归）
./scripts/upstream-sync.sh check-full ../new-api-v1.0.0-rc.47
```

## 验证

详见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。所有证据均来自实际构建、测试、容器或浏览器操作。

本轮自洽性验证结论（可重复执行）：

- 新鲜 worktree 从上游 tag `v1.0.0-rc.46` 重放补丁 → 前端构建 + 类型检查 + 后端回归全通过。
- 日限额 10 项边界检查在三种运行形态下均 10/10：内存缓存选路、数据库选路、未启用 Redis（进程内回退）。
- 协议/接线兼容 7 项全通过：OpenAI、Claude、Gemini 三种入站格式 + 生图 + 错误语义（503 与 429 区分）+ 无效令牌 + 旁路可达。
- 新增代码不含裸 SQL、不加列、不改迁移，因此 SQLite/MySQL/PostgreSQL 行为一致（实测 Postgres，回退路径实测无 Redis）。

上线后的自服务操作面板见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。真实 Kiro/Antigravity 账号与真实国内厂商 Key 仍未接入，属于外部凭据依赖。
