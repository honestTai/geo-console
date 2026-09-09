# GEO Console Release Workflow

首版 GitHub Release 为 v0.1.0，使用已提交并验证的 commit 打标签，上传同版源码 ZIP 与 SHA-256。工作台源码链接固定版本，官网指向 Releases/latest；旧 source URL 返回 GitHub 302。先发布 GitHub Release，再部署带该版本入口的 Web，避免在线入口指向不存在的标签。

官网搜索文件随 landing 发布；上线检查 robots.txt、sitemap.xml、llms.txt、llms-full.txt、Markdown MIME、canonical 308 和不存在页面的 404。生成/校验方法见 `docs/search-discovery.md`。只修改公开静态路由时，保留应用 SPA 路由、API 代理和访问控制。

独立 Demo 随 Web build 构建到 Git 忽略的 `landing/interactive/`，release 显式复制此目录。公开源码用户的 Docker 自构建入口在 `docker/quickstart/`，使用独立项目、随机 Secret 和 localhost 默认绑定；维护者原升级流程不变。首次 Docker 构建会安装锁定依赖和 Chromium，用户需 Docker Compose v2。参见 `docs/docker-quickstart.md`。

## 完整开源发行

项目自有代码采用 AGPL-3.0-only，完整 Web/API/Worker/package/桌面及迁移源码公开。执行 `corepack pnpm test:source` 与 `corepack pnpm export-source output/<新目录>`，核对不含密钥、日志、运行数据和 Git 历史后生成同版源码 ZIP 至 `landing/source/`。官网、登录/账号区提供免费源码入口；官方体验地址不放在官网、帮助 HTML/PDF 或 README。帮助必须为新版 21 章与 20 张 current 截图。后续继续走下述同一服务器发行流程，详见 `docs/public-distribution.md`。

## 1. 单一发布流程

构建前 `verify-source-release.mjs` 核对源码归档及逐文件哈希，防止源码下载落后于当前应用。Git 文件列表中的已删除文件不进入 tar；符号链接被拒绝。NOTICE 与上游许可证随制品发布。

每次发布都执行同一条链路：

1. 发布机本地安装/校验依赖并运行仓库检查。
2. `deploy/package.sh` 在本地 Docker Buildx 的目标 Linux 容器中安装服务端依赖，连同后端源码和 migration 导出为 `server-runtime.tar`；同时在宿主机本地构建 Web dist。
3. `.run` 只携带上述两个本地产物、landing、Compose/Caddy 和安装/管理脚本。
4. 服务器校验并替换 release，用无 `RUN` Dockerfile 执行 `FROM` + `ADD/COPY` 重构 Worker/Web 镜像，然后备份、切换并重启容器。

服务器不得运行 pnpm、apt、Playwright 下载、Web build 或 `docker pull`。生产 `.env` 与 Secret 永远只保存在 `/opt/geo-console/shared`，不由 Windows/macOS/Linux 发布机生成或打入 bundle。

## 2. 本地验证与打包

发布机需要 Node 24、corepack pnpm 11、Docker Engine/Desktop 和 Buildx。Windows 使用 Git Bash 或 WSL 运行 Bash 脚本；服务端 artifact 始终由 Linux BuildKit 容器生成，不能复制 Windows `node_modules`。

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check-types
corepack pnpm test
corepack pnpm build
corepack pnpm lint
bash deploy/package.sh
```

若变更包含桌面 Agent 协议，还要运行 `cargo fmt --check`、`cargo test`，确认 Web build 生成独立 desktop-agent chunk，并在 Tauri 开发客户端验证 Channel 首字节、取消和工具恢复。服务器 `.run` 与 Tauri 签名更新包仍是两条独立产物链。

Demo 默认目标为 `linux/amd64`；只有目标服务器明确为 ARM64 时设置 `GEO_SERVER_PLATFORM=linux/arm64`。发布机需要代理时，可为单次 BuildKit 构建设置 `GEO_BUILD_PROXY=http://<host>:<port>`；该值不进入 artifact、manifest 或服务器配置。

若变更严格限于 `apps/web`、`landing` 和文档，可设置 `GEO_REUSE_SERVER_BUNDLE=dist/geo-console-<当前版本>.run` 仍由同一打包器生成 release。该路径要求源 bundle 的 checksum、内层 artifact hash、Git commit、平台和 Worker base 全匹配，并拒绝任何后端/runtime 输入相对 HEAD 的变化；后端、migration、依赖或共享 package 一旦变化必须重新执行 Buildx。

产物：

```text
dist/geo-console-<release>.run
dist/geo-console-<release>.run.sha256
```

clean worktree 使用 12 位 commit；dirty worktree 使用 `<commit>-dev-<UTC>`。manifest 必须记录：

```text
PACKAGE_MODE=local-server-artifacts
SERVER_IMAGE_ACTION=reconstruct
SERVER_PLATFORM=linux/amd64
SERVER_ARTIFACT=server-runtime.tar
SERVER_ARTIFACT_SHA256=<sha256>
WORKER_BASE_IMAGE=geo-console-worker-base:node24-playwright1234
```

payload 不得包含 `.agents`/Demo 凭据、Git、desktop、宿主机 node_modules、`.env`、Secret、数据库、证据、备份或本地打包脚本。

## 3. 固定 Worker Base

服务器保留 `geo-console-worker-base:node24-playwright1234`，其中只有 Node 运行环境、Playwright Chromium、中文字体和系统库。普通 release 不改变它；Node、Playwright 或系统库升级需要单独评审、构建和验证新的 base tag，再更新 `GEO_WORKER_BASE_IMAGE` 生成 release。

从旧协议切换到本流程时，可把当前已验证的 Worker 镜像标记为 base：

```bash
docker tag geo-console-worker:<current-release> geo-console-worker-base:node24-playwright1234
```

只允许对已经运行并通过 PDF/中文字体检查的当前镜像执行该一次性标记。

## 4. 上传与预检

使用标准 SSH/SCP 交互密码，不使用 `sshpass` 或关闭 host-key 校验：

```bash
scp dist/geo-console-<release>.run \
    dist/geo-console-<release>.run.sha256 \
    deploy-user@your-server:/tmp/
```

服务器先只读检查当前版本、八个服务、备份和磁盘，再在 `/tmp` 用明确文件名执行 `sha256sum -c`。`geo-console prepare` 必须在旧服务在线时完成：

- 外层 bundle 与内层 `server-runtime.tar` 哈希正确。
- artifact 平台匹配服务器。
- Worker base、PostgreSQL 和 Caddy 镜像已存在且平台匹配。
- Compose 有效，服务器 Dockerfile 没有 `RUN`。
- `docker compose build api web` 只读取本地 base/artifact/dist，不使用 `--pull`。

## 5. 安装与升级

首次安装：

```bash
sudo bash /tmp/geo-console-<release>.run \
  --domain <confirmed-domain> \
  --admin-email <confirmed-admin-email> \
  --capture-concurrency 1
```

已有实例：

```bash
sudo geo-console backup
sudo geo-console upgrade /tmp/geo-console-<release>.run
```

新镜像在旧版本在线时由本地产物重构。切换前再次创建 PostgreSQL/evidence 成对备份，然后停止应用服务、原子切换 `current`，按 PostgreSQL -> Log Service -> API -> Workers -> Web/Caddy 顺序启动。Log Service/API 启动时继续执行向前 migration。

升级日志中出现 pnpm、apt、Playwright download、Web build 或远程 image pull 都属于协议失败，应在切换前停止。

## 6. 上线验证与回滚

升级后执行 `geo-console version/status/doctor`，并验证 HTTPS 根路径、`/help/` 在线手册及帮助 PDF、`/app/`、`/api/health`、Log Service、migration、结构化日志、对象读写、Provider 连接和业务报告中文 PDF。桌面 Agent 协议变更还要确认 `0018_desktop_agent_runtime.sql` 已执行，桌面新会话不会产生 `agent_session_turn` job，Responses Channel 与一个只读业务工具能完成往返。

- 构建或 pre-switch 失败保持旧版本在线。
- 切换后失败且 migration 兼容时，重新激活旧 release；保留旧应用镜像和 Worker base 到回滚窗口结束。
- migration 不兼容时，用切换前 dump 与 evidence/S3 版本恢复到新建空数据库和隔离对象位置，不能覆盖唯一数据库。
- 服务器回滚前查询是否有运行中的 desktop 会话；旧应用不消费 `desktop_pending_*`，应先让客户端回合结束或明确终止这些会话。旧客户端对新服务器仍默认创建 server 会话；新客户端连旧服务器会退回旧服务端执行，但迁移后已存在的 pending desktop 会话不会自动变成 Worker job。
- 部署窗口结束后按明确文件名清理 `/tmp` 的 `.run`/checksum，不使用 glob。

桌面客户端继续使用独立 Tauri 签名发布链，不进入服务器 bundle。协议变更按“服务器 migration/API 先上线并验证，签名客户端后发布”的顺序执行；客户端回滚只替换签名包，不回滚数据库。

## 2026-09-06 跨架构与 checksum 修正

artifact Dockerfile 的 Node/corepack 在 BUILDPLATFORM 原生运行，pnpm 用显式目标 OS/CPU/libc 与 ignore-scripts 安装锁定依赖。必须在目标服务器临时隔离容器/恢复测试库验证 tsx 原生执行、迁移和重复启动，不依靠 QEMU 成功假设。输出路径绝对化；checksum 空值或失败直接终止。清理测试恢复库，保留原实例成对备份，普通发布不改固定运行时 base。
