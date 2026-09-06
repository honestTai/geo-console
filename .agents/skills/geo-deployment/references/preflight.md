# GEO Console Deployment Preflight

发布完整回答辅助解读须同步 API/Web 和 migration 0023（新建/明确授权库），确认 Semantic Worker 可消费 `answer_analysis`。不新增生产 Python、端口或 Compose 服务；Python 仅为可选离线评测。备份包含 answer_analysis_runs/attempts；回滚前停止新建并排空在途任务，保留新增表，旧版不处理该 job。见 `docs/answer-analysis.md`。

## 目标与授权

- 确认是 local、demo 还是另一个明确命名的服务器。
- 首次安装确认 HTTPS domain、DNS A/AAAA、管理员邮箱、备份目的地、对象存储模式。
- 已有部署确认当前 release、`/opt/geo-console/current`、共享配置、备份和维护窗口。
- SSH 登录权限不等于授权修改云安全组、DNS、对象存储、外部 PostgreSQL 或删除数据。

## 主机

- Linux 为受支持的 Ubuntu/Debian，root/sudo 可用。
- Docker Engine、Buildx 与 Compose plugin 已安装，或允许安装器从 Docker 官方 APT 仓库安装。
- Demo 至少 2 CPU、约 4 GB RAM、30 GB 可用空间；目标为 50 GB SSD。没有 Swap 时确认是否允许创建 `/swapfile` 2 GB。
- 系统时间同步；云安全组只开放 80/443，SSH 只允许管理来源；3010 与 5432 不映射公网。
- domain 已解析到目标 IP，80/443 未被其他服务占用，Caddy 可访问 ACME。

## 配置与 Secret

- `GEO_DOMAIN` 是域名而不是 IP；`GEO_ADMIN_EMAIL` 已确认，该首次账号将成为系统超管。
- Demo 的 capture concurrency 保持 1；只有容量和 Provider 配额明确时才提高。
- `GEO_BACKUP_DIR` 是绝对、安全、容量充足且有异机同步策略的目录。
- `shared/secrets/postgres_password`、`master_key`、`admin_password`、`log_service_token` 权限为 600，目录为 700；master key 解码后必须恰好 32 字节。
- 主密钥有离线副本；不要打印、提交或在聊天中回显任何 Secret。
- Provider/HRouter 环境变量或 Secret 文件只允许作为默认机构 bootstrap fallback。确认每个新增租户将在其活动机构内保存独立加密凭据，不共享默认机构密钥。
- local object mode 确认 evidence volume 与备份同盘风险；S3 mode 确认 private bucket、versioning、encryption、endpoint、region、path style、恢复负责人和实例角色/Key。

## 本地 Server Artifact 与 Release

- 发布机可为 Windows、macOS 或 Linux，但必须有 Git、Node/corepack pnpm 和支持目标平台的 Docker Buildx。Demo 目标固定为 `linux/amd64`。
- 仅 Web/landing 变化时可用 `GEO_REUSE_SERVER_BUNDLE` 复用同 commit 已验证 release 的 server artifact；必须有相邻 `.sha256`，且打包器确认 runtime 输入未改、源 bundle 与内层 artifact 哈希、平台、Worker base 全匹配。
- 本地先执行四项检查，再运行 `deploy/package.sh`；Docker artifact builder 在本地 Linux 容器内执行锁定依赖安装，不能把 Windows/macOS `node_modules` 直接打包。
- manifest 必须包含 `PACKAGE_MODE=local-server-artifacts`、`SERVER_IMAGE_ACTION=reconstruct`、目标平台、`server-runtime.tar` SHA-256 和批准的 Worker base image。
- release 必须包含 server artifact、Web dist、landing、Compose/Caddy、安装器和服务器 Dockerfile；服务器 Dockerfile 只能 `FROM`/`ADD`/`COPY`，不得有 `RUN` 或远程 ADD。
- release 不得包含 `.agents`、Demo 凭据、Git、desktop、宿主机 node_modules、`.env`、secrets、数据库、证据、备份或本地打包脚本。

## 上线前退出条件

- `docker compose config --quiet` 通过。
- 新 release 的 Web 静态内容包含 `/help/`、25 张脱敏截图和 A4 PDF，帮助 HTML 不引用 `/api`、`/artifacts` 或 `/share` 业务入口。
- `geo-console prepare` 在旧服务在线时验证 artifact 哈希/平台、Compose、固定 Worker base、PostgreSQL/Caddy 镜像和无 `RUN` Dockerfile，再从本地 artifact 重构应用镜像。服务器不得执行 pnpm、apt、Playwright 下载、Web build 或 `docker pull`。
- 旧实例已有包含全部租户/问题库/RBAC/业务审计/运行日志的最新数据库与对象成对备份；S3 模式已抽查原始证据、PDF 和 Word 对象版本。
- `log-service` 只在 Compose 内网 3020，`GEO_LOG_RETENTION_DAYS` 在 7-3650 范围，Log Service token 不出现在 `.env` 或日志中。
- 明确 migration 只能向前和可接受的停机窗口。
- 明确失败后的策略：保持旧实例在线、停止切换，或恢复到新建空数据库；不能原地覆盖唯一数据库。
