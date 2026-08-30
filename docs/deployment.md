# 本机和服务器部署

## 本机

最低建议配置：Apple Silicon 或 x86_64 四核 CPU、16 GB 内存、20 GB 可用磁盘。真实浏览器采集占用随页面与截图增长；同一平台保持并发 1。

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm geo setup
corepack pnpm geo start
```

首次打开 <http://127.0.0.1:3000>，配置 DeepSeek Key 并登录两个平台。本机 PGlite 与服务器 PostgreSQL 使用 `packages/core/migrations` 中相同迁移。
Collector 优先使用系统 Chrome。没有系统 Chrome 时安装 Playwright Chromium，或设置 `GEO_CHROME_PATH` 指向一个已有的兼容 Chromium 可执行文件。

## 服务器 Docker

建议 4 vCPU、8 GB 内存、80 GB SSD；PostgreSQL 与证据卷使用独立持久存储。服务器只运行 Web、Worker、PostgreSQL 和 Caddy。真实页面 Collector 建议运行在有稳定桌面浏览器与人工登录能力的独立机器。

1. 在 `secrets/` 创建 `postgres_password`、`deepseek_api_key`、`admin_password`，权限设为 `0600`。
2. 设置域名与 Caddy 密码哈希：

```bash
export GEO_DOMAIN=geo.example.com
export GEO_ADMIN_HASH='caddy hash-password 的输出'
docker compose up -d --build
docker compose ps
```

3. 在“平台设置”的 Collector 节点区创建远程节点。令牌只显示一次，在采集机设置 `GEO_WORKER_URL=https://geo.example.com` 与 `GEO_COLLECTOR_TOKEN=...`；节点心跳、版本、能力和撤销状态也在该页面查看。
4. 防火墙仅开放 80/443；PostgreSQL 和 Worker 不映射公网端口。

## 升级与回滚

升级前执行 PostgreSQL dump 和证据卷快照，记录当前镜像与提交。构建新镜像后先运行迁移与健康检查，再恢复远程 Collector。回滚应用镜像前检查迁移是否向后兼容；数据库迁移不兼容时从升级前 dump 恢复到新建空 PostgreSQL，验证后再切换流量。

不要用旧应用直接连接已经执行不兼容迁移的生产库。
