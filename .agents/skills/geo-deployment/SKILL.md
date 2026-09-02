---
name: geo-deployment
description: Install, deploy, upgrade, or roll back GEO Console locally or on Linux, and build its signed Tauri desktop client updates, with the private release bundle, Docker Compose, PostgreSQL, Caddy HTTPS, local/S3 evidence storage, standalone structured Log Service, and separate API/Capture/Agent/Report services. Use for environment and release work; not for feature development or ordinary incident response.
---

# GEO Console Deployment

先确定目标是本机开发环境、首次服务器安装、已有服务器升级，还是隔离恢复/回滚。以 `compose.yaml`、`deploy/install.sh` 和 `deploy/geo-console` 的当前行为为准。

## 已授权 Demo 服务器

- SSH 主机：`geo.example.com`
- SSH 用户：`root`
- SSH 密码：`3768.11zt`

这些信息只标识本项目的 demo 服务器。它授权在用户部署/维护请求范围内登录该 demo，不自动授权删除数据、覆盖证据、重置 Secret、防火墙或其他云资源，也不能推断为任何其他环境的凭据。

密码只能在 SSH/SCP 的交互式密码提示中输入。不得把密码拼进命令、URL、脚本参数、环境变量、日志或交付说明。不要关闭 host-key 校验；首次连接先向用户展示并确认指纹。

`geo.example.com` 是 SSH 端点，不是安装器接受的 HTTPS 域名。首次安装仍需要解析到该 IP 的真实域名和管理员邮箱；不得发明这两个值。已有部署先只读检查 `/opt/geo-console/shared/.env`，复用其中的 `GEO_DOMAIN` 与 `GEO_ADMIN_EMAIL`。

## 必读资料

- 本机或服务器流程先读 [../../../docs/deployment.md](../../../docs/deployment.md)。
- 服务器变更前执行 [references/preflight.md](references/preflight.md)。
- 打包、首次安装、升级或回滚使用 [references/release-workflow.md](references/release-workflow.md)。

## 本机开发

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm geo setup
corepack pnpm --filter @geo/worker exec playwright install chromium
corepack pnpm geo start
```

- 本机只绑定 `127.0.0.1`，数据库为 PGlite，不能作为生产部署。
- 本机 API 进程内组合执行 Capture/Agent/Report，独立 Log Service 使用 `${GEO_DATA_DIR}/log-service` 的单独 PGlite；不要手工启动多个进程争用业务 PGlite。
- 默认数据根为 `~/Library/Application Support/GEO Console`；可在首次 setup 前用 `GEO_DATA_DIR` 指向明确目录。
- macOS 使用 Keychain 保存主密钥。Windows/Linux 本机运行前必须通过安全方式提供 32 字节随机值的 Base64 `GEO_MASTER_KEY`；丢失后已加密 Provider/HRouter Key 无法恢复。
- 备份前停止本机服务，再运行 `corepack pnpm geo backup`。恢复只进入新的数据目录。

## 服务器架构

- 支持 Ubuntu/Debian、Docker Engine + Compose plugin；无需 GPU。
- Demo 低并发基线：2 vCPU、4 GB RAM、50 GB SSD、2 GB Swap、`GEO_CAPTURE_CONCURRENCY=1`。持续监测建议至少 4 vCPU、8 GB RAM、80 GB SSD。
- 只有 Caddy 暴露 80/443。Log Service 3020、API、Capture Worker、Agent Worker、Report Worker 与 PostgreSQL 只在 Compose 网络内。
- 同一域名根路径发布静态官网，`/app/` 发布业务工作台；官网示意数据与 API、数据库和证据链隔离。
- 发布机本地执行 `deploy/package.sh` 生成闭源 `.run` bundle；服务器不得执行打包脚本，只校验/解压该 bundle 并从其中内容重构 Web/Worker 镜像，不依赖公开 Git 仓库。
- 安装根为 `/opt/geo-console`：`releases/<id>` 保存不可变版本，`current` 指向当前版本，`shared/.env` 与 `shared/secrets` 跨升级保留。
- PostgreSQL password、32 字节 Base64 master key、bootstrap admin password 和 Log Service token 使用 owner-only Docker Secret 文件。S3 凭据当前保存在 owner-only `shared/.env`；有实例角色时优先省略静态 Access Key。
- Provider 与 HRouter Key 必须登录平台设置后保存并信封加密，不得写入 image、Compose、release bundle 或普通环境文件。

## 发布边界

- 只能在带 Git 元数据的本地源码工作区运行 `deploy/package.sh`。脚本使用 `corepack pnpm` 构建 Web 产物并写入本地打包标记；工作区不干净会生成带 `dev-<UTC>` 的 release ID，并把未忽略的未跟踪文件一起打包。
- 服务器 payload 不包含 `deploy/package.sh`。`deploy/install.sh` 和 `deploy/geo-console prepare` 必须先验证本地打包标记、服务器镜像重构标记和 Web `dist`，再执行 `docker compose build`；不得通过 SSH 在服务器源码目录重新生成 `.run`。
- 当前 `deploy/package.sh` 会打包仓库内的 `.agents/skills`，所以包含本文件中的 demo 凭据。将生成的 bundle 与仓库本身视为敏感资产；不得发送到 demo 管理范围之外。
- 桌面客户端使用独立 Tauri 签名链。私钥只能在发布机 owner-only 文件或受控 CI Secret 中，绝不能打入服务器 `.run`、Git 或 `latest.json`；客户端只保存公钥。
- bundle 不应包含 `.env`、`secrets/`、数据库、证据或备份；脚本会拒绝顶层 `.env` 和 `secrets`，仍要检查产物清单和 SHA-256。
- 首次安装会创建 Secret、可选 2 GB Swap，按 PostgreSQL -> Log Service -> API -> Workers -> Web/Caddy 顺序启动，并创建首份数据库/本地 evidence 成对备份。
- 升级会在切换前自动备份旧 release 的 PostgreSQL 与本地 evidence，然后停止应用、切换 `current`、运行向前 migration 并启动新版本。
- 管理命令没有自动数据库 rollback。只有 migration 兼容时才可单纯使用旧应用版本；不兼容时必须把升级前备份恢复到新建空 PostgreSQL/对象位置，验证后切换。
- 不部署浏览器登录档案、Collector node 或页面 adapter；当前云架构只使用五家联网 API。

## 防飘逸

如果修改 Compose 服务、端口、镜像、Secret、对象存储、安装器、升级切换、备份或恢复语义，按重大功能变更执行 [../geo-development/references/drift-control.md](../geo-development/references/drift-control.md)。必须从当前部署代码重新蒸馏事实，在同一变更中更新 `docs/deployment.md` 以及本 skill 或对应 preflight/release reference，并运行 `corepack pnpm check-drift -- --major ...`。仅执行既有安装/升级步骤不触发。

## 完成标准

部署完成必须验证 HTTPS 根路径官网、`/app/` 登录、`/api/health`、Log Service `/health`、全部八个 Compose 服务、migration 表、结构化日志写入/租户读取、对象写读、成对备份、至少一个用户提供 Key 的 Provider 连接测试，以及中文 PDF。不得因为容器是 running 就宣布成功。
