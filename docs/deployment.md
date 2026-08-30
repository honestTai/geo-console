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

初期建议 4 vCPU、8 GB 内存、80 GB SSD，无需 GPU。准备 Linux、Docker Engine/Compose、解析到服务器的域名和仅开放 80/443 的防火墙。

```bash
mkdir -p secrets
openssl rand -base64 32 > secrets/postgres_password
openssl rand -base64 32 > secrets/master_key
openssl rand -base64 24 > secrets/admin_password
chmod 600 secrets/*
cp .env.example .env
```

编辑 `.env` 的 `GEO_DOMAIN` 和 `GEO_ADMIN_EMAIL`。`master_key` 必须永久备份；更换它而不重加密凭据会导致现有 Key 无法读取。云厂商 KMS 可通过 Secret CSI/Agent 把 32 字节随机值的 Base64 文本挂载到 `/run/secrets/master_key`。

```bash
docker compose config --quiet
docker compose build
docker compose up -d postgres api capture-worker report-worker web caddy
docker compose ps
curl -fsS https://你的域名/api/health
```

首次登录使用 `.env` 的管理员邮箱和 `secrets/admin_password`。登录后在平台设置中保存五家供应商与 HRouter Key，并逐个测试连接。

## S3 兼容证据存储

默认 `GEO_OBJECT_STORE=local` 使用共享持久卷。生产建议私有 S3/MinIO/COS 桶，在 `.env` 配置 endpoint、region、bucket 和凭据，并启用桶版本控制、服务端加密、生命周期与备份。实例角色可用时省略 Access Key。所有 API、Capture Worker 和 Report Worker 必须使用同一配置。

## 备份、升级与回滚

本地卷模式的成对备份：

```bash
docker compose --profile backup run --rm backup
```

S3 模式由桶版本控制和跨区域复制保护对象，命令仍备份 PostgreSQL。升级前记录提交与镜像摘要，生成数据库 dump，确认对象存储可读，再构建新镜像。迁移只向前执行；需要回滚不兼容迁移时，把 dump 恢复到新建空 PostgreSQL，验证旧镜像后再切换流量，不要覆盖唯一生产库。
