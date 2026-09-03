# 本机与服务器部署

## 本机开发

建议 4 核、16 GB 内存、20 GB 可用磁盘。Node.js 24 与 pnpm 11 由根 `packageManager` 固定。

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm geo setup
corepack pnpm --filter @geo/worker exec playwright install chromium
corepack pnpm geo start
```

服务只绑定 `127.0.0.1`；Log Service 使用 3020 和独立日志 PGlite，API 使用 3010 并在进程内组合执行三个本机队列 Worker。PGlite 仅用于开发测试，不要对同一目录启动多进程 Worker。Report Worker 优先使用 Playwright Chromium；服务器镜像始终安装 Playwright Chromium。

## 服务器 Docker

低负载 Demo（同时只跑一两个任务）可使用 2 vCPU、4 GB 内存、50 GB SSD 和 2 GB Swap，并把采集并发固定为 1。持续监测或多客户并发建议 4 vCPU、8 GB 内存、80 GB SSD。无需 GPU。

服务器使用 Ubuntu/Debian。域名必须解析到服务器，云安全组只开放 80/443；SSH 端口限制到管理来源。Log Service 3020、API、Worker 和 PostgreSQL 不映射主机端口。

同一个 HTTPS 域名提供三个前端入口：

- `https://<domain>/`：静态产品官网。
- `https://<domain>/help/`：公开操作手册、脱敏截图与同源 A4 PDF；帮助页不访问业务 API。
- `https://<domain>/app/`：React 业务工作台；访问 `/app` 会重定向到带尾斜杠的地址。

官网/帮助中心与业务工作台在 Web 镜像内使用不同目录。官网示意数据和帮助截图不访问 API 或数据库；业务工作台继续只显示真实项目数据。发布后除根路径和 `/app/` 外，还要验证 `/help/`、25 张截图及 `/help/ZZ-Geo-操作手册.pdf` 可访问。

## 桌面客户端

`apps/desktop` 是面向全部用户的 Tauri 2 客户端。正式版加载 `https://geo.example.com/app/`，开发版加载本机 `/app/`；浏览器暂时保留同步功能用于调试。桌面壳不内置数据库、证据或 Provider Key，所有权限和数据仍来自服务器。

开发运行：

```bash
corepack pnpm desktop
```

首次发布机已使用 Tauri CLI 生成独立密钥：私钥默认位于 `~/.tauri/zz-geo.key` 且必须保持 `0600`，公钥写入 `apps/desktop/src-tauri/tauri.conf.json`。私钥不得进入 Git、`.run` bundle、服务器源码或交付说明。构建签名更新包：

```bash
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/zz-geo.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
corepack pnpm desktop:build
```

macOS/Windows/Linux 更新产物及 `.sig` 由 Tauri 生成。发布时生成有效的 `latest.json`，上传到配置的 HTTPS 地址 `https://www.honesttai.com/desktop/latest.json`，并确保所有已声明平台条目都有 URL 和签名。丢失私钥会导致已安装客户端无法接受后续更新，必须离线备份。

单平台桌面产物应先整理为版本化名称并生成清单；多平台发布在各平台构建完成后合并 `platforms`，不能填写空签名：

```bash
corepack pnpm desktop:stage -- \
  --version 0.2.0 \
  --target darwin-aarch64 \
  --bundle "apps/desktop/src-tauri/target/release/bundle/macos/ZZ Geo.app.tar.gz" \
  --signature-file apps/desktop/src-tauri/target/release/bundle/macos/ZZ\ Geo.app.tar.gz.sig
```

将清单和清单引用的版本化更新包上传到服务器后原子发布；资产先就位，`latest.json` 最后切换，旧清单保留为 `latest.previous.json`：

```bash
sudo geo-console desktop-publish /tmp/latest.json /tmp/zz-geo-0.2.0-darwin-aarch64.app.tar.gz
curl -fsS https://www.honesttai.com/desktop/latest.json
```

### 本地构建服务器发布包

发布机可以是 Windows、macOS 或 Linux。`deploy/package.sh` 使用本地 Docker Buildx 的目标 Linux 容器安装服务端依赖，把依赖、后端源码和 migration 导出为跨宿主系统的 `server-runtime.tar`；Web dist 同样在本地生成。不能把 Windows/macOS `node_modules` 直接复制到 Linux。

release 使用明确 allowlist，不包含 `.agents` 与 Demo 凭据、Git 历史、`.env`、Secret、数据库、证据、备份、宿主机 node_modules、`apps/desktop` 或本地打包脚本。生产 `.env` 与 Secret 始终只保存在服务器 `/opt/geo-console/shared`。

在开发机仓库中执行：

```bash
bash deploy/package.sh
```

仅修改 `apps/web`、`landing` 或文档的 Web-only release，可显式复用同一 Git commit 已验证 release 中的 Linux server artifact，避免发布机跨架构仿真重复安装后端依赖：

```bash
GEO_REUSE_SERVER_BUNDLE=dist/geo-console-<当前版本>.run bash deploy/package.sh
```

打包器只在源 `.run` 的外层 checksum、内层 artifact hash、Git commit、目标平台和 Worker base 全部匹配，且 `apps/worker`、`apps/log-service`、`packages`、根依赖清单与 TypeScript 配置相对 HEAD 无改动时允许复用；任何后端/runtime 输入变化都必须走 Docker Buildx 重新构建。

命令要求本地 Node/corepack pnpm、Docker 和 Buildx，默认生成 `linux/amd64` server artifact；ARM64 服务器明确设置 `GEO_SERVER_PLATFORM=linux/arm64`。脚本在 `dist/` 生成 `geo-console-<版本>.run` 和 SHA-256。工作区干净时版本号使用 Git commit；有未提交改动时加入 `dev` 和 UTC 时间戳。

服务器使用已经验证的 `geo-console-worker-base:node24-playwright1234` 提供 Node、Playwright Chromium、中文字体和系统库。每个 release 的 Dockerfile 只有 `FROM`、`ADD/COPY`、`ENV` 和 `CMD`：Worker 镜像加入本地 `server-runtime.tar`，Web 镜像复制本地 dist/landing。服务器不运行 pnpm、apt、Playwright 下载或 Web build。

打包器会把 Windows 工作树中的部署 shell 入口规范化为 LF，确保自解压安装器和 `geo-console` 管理命令可在 Linux 执行。

上传到服务器：

```bash
scp dist/geo-console-<版本>.run dist/geo-console-<版本>.run.sha256 用户@服务器:/tmp/
```

### 首次一键安装

先把域名 A/AAAA 记录指向服务器，再登录服务器执行：

```bash
cd /tmp
sha256sum -c geo-console-<版本>.run.sha256
sudo bash ./geo-console-<版本>.run \
  --domain demo.example.com \
  --admin-email admin@example.com
```

安装器会：

- 从 Docker 官方 APT 仓库安装 Docker Engine 和 Compose 插件（已有则复用）。
- 校验本地生成的 Linux server artifact，并从服务器已有基础镜像重构应用镜像。
- 在无 Swap 的服务器创建 `/swapfile` 2 GB；可用 `--no-swap` 关闭。
- 创建 `/opt/geo-console/releases/<版本>` 和持久的 `/opt/geo-console/shared`。
- 生成 owner-only 的 PostgreSQL 密码、32 字节 Base64 主密钥、系统超管初始密码和 Log Service 内部令牌。
- 顺序启动 PostgreSQL、Log Service、API、Capture Worker、Agent Worker、Report Worker、Web 和 Caddy，避免首次迁移竞争。
- 验证 HTTPS、服务健康和一次数据库/本地证据成对备份。
- 验证根路径官网、`/help/` 在线手册及 PDF、`/app/` 同步调试入口以及桌面客户端登录与动态导航。

默认备份目录为 `/var/backups/geo-console`，可用 `--backup-dir /安全路径` 指定。该目录仍应定期同步到另一台机器或私有对象存储。

首次登录密码不会直接打印在安装日志中：

```bash
sudo geo-console show-admin-password
```

`/opt/geo-console/shared/secrets/master_key` 必须永久离线备份；丢失或随意更换会导致数据库中按租户加密的供应商/HRouter Key 无法读取。首次账号是数据库中唯一系统超管；后续机构和角色不能创建第二个超管。环境变量或 Secret 文件中的 Provider/HRouter Key 只为默认机构提供 bootstrap fallback；新机构必须切换到该机构后单独保存并测试密钥，绝不能隐式共享默认机构凭据。

### 开发阶段升级

开发机重新运行 `bash deploy/package.sh`，上传新 `.run` 后执行：

```bash
sudo geo-console upgrade /tmp/geo-console-<新版本>.run
```

服务器先在旧版本在线时验证 `server-runtime.tar` 哈希、目标平台、Compose、固定 Worker base/PostgreSQL/Caddy 镜像以及 Dockerfile 不含 `RUN`。随后仅以 `FROM` + `ADD/COPY` 从本地产物重构 Worker/Web 镜像，不执行 `docker pull`、pnpm、apt、Playwright 下载或 Web build。切换前自动备份 PostgreSQL 与本地证据，之后停止应用服务、切换 `current` 并按顺序启动新容器。旧 release 目录会保留，但 migration 只向前执行，不会自动回滚数据库。

常用管理命令：

```bash
sudo geo-console status
sudo geo-console doctor
sudo geo-console logs api
sudo geo-console logs log-service
sudo geo-console logs capture-worker
sudo geo-console logs agent-worker
sudo geo-console backup
sudo geo-console restart
sudo geo-console version
```

## S3 兼容证据存储

默认 `GEO_OBJECT_STORE=local` 使用共享持久卷。生产建议私有 S3/MinIO/COS 桶。Log Service 只写 PostgreSQL `service_logs`，不访问 evidence volume 或 bucket；`log_service_token` 只通过 owner-only Docker Secret 挂载，不进入 `.env`、镜像或 bundle 明文。

## 备份、升级与回滚

本地卷模式的成对备份：

```bash
sudo geo-console backup
```

S3 模式由桶版本控制和跨区域复制保护对象，命令仍备份 PostgreSQL。数据库备份包含全部租户、RBAC、问题库、Agent 审批、业务审计、运行日志和报告索引；对象备份覆盖 PDF 与 Word。恢复后需同时抽查 Log Service 健康、租户日志隔离和保留配置。
