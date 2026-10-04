# GEO Console Release Workflow


先 prepare-runtime 再 cargo fmt/test 和 Tauri bundle；平台 Node、engine.mjs、Playwright/Chromium、manifest、许可证必须同包。按 OS/CPU 原生构建。验证 SQLite 重启/恢复、受控 auth/storage stdio、人工确认和独立指标入口。三平台 CI 为验证包，不代替正式签名/公证/更新链；见 `docs/desktop-agent.md`。

## 1. 单一发布流程

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

若变更包含桌面 Agent 协议，还要运行 `cargo fmt --check`、`cargo test`，确认 Web build 只含订阅桥、Node bundle 完整，并在 Tauri 开发客户端验证 stdio 首字节、取消和工具恢复。服务器 `.run` 与 Tauri 签名更新包仍是两条独立产物链。

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
    root@8.218.21.183:/tmp/
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

旧版服务器升级后执行 `geo-console version/status/doctor`，验证 HTTPS、Log Service、已授权 migration、对象与报告。新桌面控制面改为验证 auth/storage、账户对象隔离与 CAS，业务路由必须返回 410；客户端在本机 SQLite 中创建 agent_session_turn，模型不经过云端 Responses 代理。不要用旧版桌面租约 RPC 冒充新链路验收。

- 构建或 pre-switch 失败保持旧版本在线。
- 切换后失败且 migration 兼容时，重新激活旧 release；保留旧应用镜像和 Worker base 到回滚窗口结束。
- migration 不兼容时，用切换前 dump 与 evidence/S3 版本恢复到新建空数据库和隔离对象位置，不能覆盖唯一数据库。
- 新客户端依赖 auth/storage 控制面。回滚到不支持该协议的服务器会明确启动失败，不回退云端执行；先备份本机工作区和当前云端 storage 对象，不能因回滚覆盖 SQLite 或删除同步数据。
- 部署窗口结束后按明确文件名清理 `/tmp` 的 `.run`/checksum，不使用 glob。

桌面客户端继续使用独立 Tauri 签名发布链，不进入服务器 bundle。协议变更按“服务器 migration/API 先上线并验证，签名客户端后发布”的顺序执行；客户端回滚只替换签名包，不回滚数据库。

## 2026-09-06 跨架构与 checksum 修正

artifact Dockerfile 的 Node/corepack 在 BUILDPLATFORM 原生运行，pnpm 用显式目标 OS/CPU/libc 与 ignore-scripts 安装锁定依赖。必须在目标服务器临时隔离容器/恢复测试库验证 tsx 原生执行、迁移和重复启动，不依靠 QEMU 成功假设。输出路径绝对化；checksum 空值或失败直接终止。清理测试恢复库，保留原实例成对备份，普通发布不改固定运行时 base。

## SQLite 桌面执行边界（2026-10-04）

当前桌面为 React → Tauri IPC → 本机 Node 业务引擎 → 新 SQLite 工作区。模型/搜索/采集/网站分析/指标/内容质检/报告/调度均在客户端；云端只鉴权、权限管理与账户私有快照存储。代码事实源：`apps/desktop/src/engine.ts`、`src-tauri/src/local_engine.rs`、`packages/core/src/sqlite.ts`、`apps/worker/src/api-service.ts` 和 `desktop-storage.ts`。独立指标、证据页面保留，不迁移旧数据库或业务数据。

会话/工具账本/等待状态/租约落 SQLite；MemorySaver 仅回合内使用。结果不确定的工具停止自动重放并要求成员核查。关闭客户端会停止本机执行；鉴权断网 fail-closed。哈希分块 + CAS 同步不自动合并冲突，设备主密钥不上传，新设备重配 Provider Key。桌面公开分享暂未接静态托管，会明确拒绝创建无效链接，PDF/Word 本地导出仍可用。

完整开发、恢复、测试和限制见 `docs/desktop-agent.md`。云端新部署显式使用 `compose.desktop-cloud.yaml`，不启动业务 Workers；其余服务器拓扑与 PostgreSQL 操作章节仅适用于旧版兼容部署，不代表新桌面执行位置。
