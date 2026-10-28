# 部署到服务器（最短可跑路径）

目标读者是"手上有一台 Linux 服务器，只想把它跑起来"的人。这一页的每条命令都在 2026-10-26
用**全新克隆 + 全新数据卷**实测过；实测结果记在 `docs/VERIFICATION.md` §24。

前提：Linux + Docker 24+ + compose v2。服务器上**不需要** Go / Bun（除非你选择在服务器上构建镜像）。

---

## 0. 拿到镜像（三选一）

**A. 本机构建后搬过去（推荐，已实测）**

```bash
# 在开发机（装了 Go 1.26+ / Bun 1.4+ / Docker）
./scripts/product.sh image                                  # 产物：new-api-daily-limit:0.11.0 等 4 个 tag
docker save new-api-daily-limit:0.11.0 -o newapi-0.11.0.tar   # 实测约 71 MB
# 在服务器
docker load -i newapi-0.11.0.tar
```

**B. 在服务器上构建**：装好 Go / Bun 后同样执行 `./scripts/product.sh image`。适合不方便传镜像的场景，
但服务器要能拉 npm 与 Go module。

**C. 用上游官方镜像**（不含本项目的日预算补丁）：把 `.env` 里的 `NEW_API_IMAGE` 指向
`calciumion/new-api:<tag>`。只建议做对照，不建议当成品。

## 1. 配置

```bash
cp .env.product.example .env
# 至少改这四个值：POSTGRES_PASSWORD、REDIS_PASSWORD、SESSION_SECRET、NEW_API_ADMIN_PASS
```

**不配置会直接拒绝启动**，并逐条告诉缺哪个变量——这是有意的（仓库里不存在默认口令）。
实测：没有 `.env` 时 `docker compose config` 退出码 1，报 `required variable POSTGRES_PASSWORD is missing a value: …`。

## 2. 起服务

```bash
docker compose -f docker-compose.poc.yml up -d
```

实测（全新克隆 + 随机密钥 + 全新卷）：约 60–100 秒后 `new-api-poc` 变 healthy，
`curl http://127.0.0.1:3800/api/status` 返回 `version: 0.11.0`，
`curl http://127.0.0.1:3800/api/setup` 返回 `{"status":false,"root_init":false,"database_type":"postgres"}`
——空库、待初始化，属于正常首次状态。

## 3. 首次初始化（务必先做这一步再对外）

浏览器打开 `http://<服务器IP>:3800/setup`，设置管理员账号与密码。
在完成它之前不要把这个端口暴露到公网。

## 4. 对外暴露

默认 `NEW_API_BIND_HOST=0.0.0.0`、`NEW_API_PORT=3800`。生产建议前面加反代（Nginx / Caddy）做 TLS，
只放行 80/443，并把 `.env` 里的 `NEW_API_BIND_HOST` 改成 `127.0.0.1`：

- 反代 → `127.0.0.1:3800`
- 旁路控制台（AIClient2API）默认只绑 `127.0.0.1:3100`，**不要**直接开公网
- 用了反代要按 `docs/authentication.md` 的「可信代理与 IP 限流」配可信代理，否则客户端 IP 会记成反代 IP

一台机器只跑一套：compose 里的 `container_name` 是固定的（`new-api-poc` / `new-api-poc-postgres` …）。
想同机跑两套（例如新旧版本对照），必须改 `container_name` 或拆文件，换 compose project 名不够。

## 5. 升级与回滚

- 升级：新上游 tag 出现后，开发机 `./scripts/upstream-sync.sh drill <新 tag>` → 按 `docs/UPSTREAM_SYNC.md`
  处理（通常只有 `model/channel_constraint.go` 的 1~2 处）→ 构建新版本镜像 → 服务器 `docker load`
  → 改 `.env` 的 `NEW_API_IMAGE` 到新 tag → `docker compose up -d`。
- 回滚：镜像 tag 不可变；保留上一版 tar，`docker load` 后把 `NEW_API_IMAGE` 指回去再 `up -d`。
- 数据在 named volume 里（compose project 名作为前缀）。**`docker compose down -v` 会删数据**，回滚不要带 `-v`。

## 6. 备份

```bash
docker exec new-api-poc-postgres pg_dump -U newapi -Fc new-api > backup-$(date +%F).dump
```

恢复演练用 `./scripts/backup-drill.sh`：只读生产库，写和删都限制在 `nap_restore_<时间戳>` 旁路库里，
逐表比行数；源库没有带日预算的渠道时它会**主动判失败**并告诉你怎么造一个，避免"0 == 0"的空跑绿灯。

## 7. 这一页证明了什么、没证明什么

**已实测**：全新克隆 → 示例 env + 随机密钥 → healthy → 版本自报 0.11.0 → `/setup` 未初始化；
镜像 `docker save`/`docker load` 往返；缺少 env 时拒绝启动；runbook 里的备份命令。

**未验证**（没有对应环境，别当承诺）：真实公网 TLS 反代、systemd/进程守护、多机或集群、
大流量下的连接池与限流参数、Windows 上的 Docker Desktop 生产部署。
