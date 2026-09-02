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

同一个 HTTPS 域名提供两个前端入口：

- `https://<domain>/`：静态产品官网。
- `https://<domain>/app/`：React 业务工作台；访问 `/app` 会重定向到带尾斜杠的地址。

官网演示与业务工作台在 Web 镜像内使用不同目录。官网示意数据不访问 API 或数据库；业务工作台继续只显示真实项目数据。

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

### 本地生成闭源发布包

发布包只能在带 Git 元数据的开发机源码工作区生成，再通过 SSH/SCP 私下传输；不得在服务器上执行打包脚本。它不依赖公开 Git 仓库，也不包含 Git 历史、`.env`、Secret、数据库、证据、备份、`apps/desktop` 或仅供本地使用的 `deploy/package.sh`。它包含服务器重构镜像所需的当前源码和本地生成的 Web `dist`；桌面客户端走独立签名发布，服务器安装目录仅 root 可进入。

在开发机仓库中执行：

```bash
bash deploy/package.sh
```

命令使用 `corepack pnpm` 在本地构建 Web，并在 `dist/` 生成单文件 `geo-console-<版本>.run` 和对应的 SHA-256 文件。工作区干净时版本号使用 Git commit；包含未提交开发改动时会加入 `dev` 和 UTC 时间戳。manifest 会标记本地打包和服务器镜像重构模式，安装器会在服务器重构镜像前验证这些标记、Web `dist` 以及 payload 中不存在 `deploy/package.sh`。

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

- 从 Docker 官方 APT 仓库安装 Docker Engine、Buildx 和 Compose 插件（已有则复用）。
- 在无 Swap 的服务器创建 `/swapfile` 2 GB；可用 `--no-swap` 关闭。
- 创建 `/opt/geo-console/releases/<版本>` 和持久的 `/opt/geo-console/shared`。
- 生成 owner-only 的 PostgreSQL 密码、32 字节 Base64 主密钥、系统超管初始密码和 Log Service 内部令牌。
- 顺序启动 PostgreSQL、Log Service、API、Capture Worker、Agent Worker、Report Worker、Web 和 Caddy，避免首次迁移竞争。
- 验证 HTTPS、服务健康和一次数据库/本地证据成对备份。
- 验证根路径官网、`/app/` 同步调试入口以及桌面客户端登录与动态导航。

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

服务器先校验并解压本地生成的 `.run`，再在旧版本仍在线时重构新镜像；服务器不执行 `deploy/package.sh` 或 Web 应用构建。切换前自动备份 PostgreSQL 与本地证据，之后停止应用服务、切换 `current` 软链接、按顺序运行迁移并启动新版本。旧 release 目录会保留，但 migration 只向前执行，不会自动回滚数据库。

应用发布包只在本地生成；服务器从 bundle 重构 Docker 镜像。Web 静态产物由发布机本地构建（`deploy/package.sh` 运行 `corepack pnpm --filter @geo/web build` 并把 dist 放进 bundle），Web 镜像只复制 dist；Worker 镜像重构的 pnpm/corepack 走 npmmirror、Playwright 浏览器下载走 npmmirror CDN（lockfile 完整性校验不变），国内服务器升级不再直连 npmjs.org。

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
