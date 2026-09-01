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

服务只绑定 `127.0.0.1`。PGlite 仅用于开发测试，不用作生产数据库。Report Worker 优先使用 Playwright Chromium；macOS 开发环境在下载不可用时可使用系统 Google Chrome，也可通过 `GEO_PLAYWRIGHT_EXECUTABLE_PATH` 指定受控浏览器路径。服务器镜像始终安装 Playwright Chromium。

## 服务器 Docker

低负载 Demo（同时只跑一两个任务）可使用 2 vCPU、4 GB 内存、50 GB SSD 和 2 GB Swap，并把采集并发固定为 1。持续监测或多客户并发建议 4 vCPU、8 GB 内存、80 GB SSD。无需 GPU。

服务器使用 Ubuntu/Debian。域名必须解析到服务器，云安全组只开放 80/443；SSH 端口限制到管理来源。API、Worker 和 PostgreSQL 不映射主机端口。

同一个 HTTPS 域名提供两个前端入口：

- `https://<domain>/`：静态产品官网。
- `https://<domain>/app/`：React 业务工作台；访问 `/app` 会重定向到带尾斜杠的地址。

官网演示与业务工作台在 Web 镜像内使用不同目录。官网示意数据不访问 API 或数据库；业务工作台继续只显示真实项目数据。

### 本地生成闭源发布包

发布包通过 SSH/SCP 私下传输，不依赖公开 Git 仓库，也不包含 Git 历史、`.env`、Secret、数据库、证据或备份。它包含构建服务器镜像所需的当前源码；服务器安装目录仅 root 可进入。

在开发机仓库中执行：

```bash
bash deploy/package.sh
```

命令在 `dist/` 生成单文件 `geo-console-<版本>.run` 和对应的 SHA-256 文件。工作区干净时版本号使用 Git commit；包含未提交开发改动时会加入 `dev` 和 UTC 时间戳。

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
- 生成 owner-only 的 PostgreSQL 密码、32 字节 Base64 主密钥和管理员初始密码。
- 顺序启动 PostgreSQL、API、Capture Worker、Agent Worker、Report Worker、Web 和 Caddy，避免首次迁移竞争。
- 验证 HTTPS、服务健康和一次数据库/本地证据成对备份。
- 验证根路径官网、`/app/` 登录入口以及两者之间的导航。

默认备份目录为 `/var/backups/geo-console`，可用 `--backup-dir /安全路径` 指定。该目录仍应定期同步到另一台机器或私有对象存储。

首次登录密码不会直接打印在安装日志中：

```bash
sudo geo-console show-admin-password
```

`/opt/geo-console/shared/secrets/master_key` 必须永久离线备份；丢失或随意更换会导致数据库中已加密的供应商 Key 无法读取。登录后在平台设置中保存五家供应商与 HRouter Key，并逐个测试连接。

### 开发阶段升级

开发机重新运行 `bash deploy/package.sh`，上传新 `.run` 后执行：

```bash
sudo geo-console upgrade /tmp/geo-console-<新版本>.run
```

新镜像会在旧版本仍在线时构建。切换前自动备份 PostgreSQL 与本地证据，之后停止应用服务、切换 `current` 软链接、按顺序运行迁移并启动新版本。旧 release 目录会保留，但迁移只向前执行，不会自动回滚数据库。

常用管理命令：

```bash
sudo geo-console status
sudo geo-console doctor
sudo geo-console logs api
sudo geo-console logs capture-worker
sudo geo-console logs agent-worker
sudo geo-console backup
sudo geo-console restart
sudo geo-console version
```

## S3 兼容证据存储

默认 `GEO_OBJECT_STORE=local` 使用共享持久卷。生产建议私有 S3/MinIO/COS 桶，在 `/opt/geo-console/shared/.env` 配置 endpoint、region、bucket 和凭据，并启用桶版本控制、服务端加密、生命周期与备份。实例角色可用时省略 Access Key。所有 API、Capture Worker 和 Report Worker 通过同一个 Compose 配置读取完全一致的对象存储参数。

## 备份、升级与回滚

本地卷模式的成对备份：

```bash
sudo geo-console backup
```

S3 模式由桶版本控制和跨区域复制保护对象，命令仍备份 PostgreSQL。升级包会记录 commit、打包时间和 release ID。迁移只向前执行；需要回滚不兼容迁移时，把升级前 dump 恢复到新建空 PostgreSQL，验证旧 release 后再切换流量，不要覆盖唯一数据库。
