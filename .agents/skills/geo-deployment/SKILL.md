---
name: geo-deployment
description: Install, deploy, upgrade, or roll back GEO Console locally or on Linux, and build its signed Tauri desktop client updates, with the private release bundle, Docker Compose, PostgreSQL, Caddy HTTPS, local/S3 evidence storage, standalone structured Log Service, and separate API/Capture/Agent/Report services. Use for environment and release work; not for feature development or ordinary incident response.
---

# GEO Console Deployment

完整源码发行使用 AGPL-3.0-only。发布前生成与当前工作树一致的 `landing/source/zzgeo-source.zip` 和 SHA-256，随同官网/帮助一起发布；登录与账号区提供源码下载，公开官网/帮助只用邮件申请体验账号。20 张 current 截图和 21 章手册替代旧模拟演示与截图。操作见 `docs/public-distribution.md` 和 release workflow，不公开本 skill 中的主机信息。

先确定目标是本机开发环境、首次服务器安装、已有服务器升级，还是隔离恢复/回滚。以 `compose.yaml`、`deploy/install.sh` 和 `deploy/geo-console` 的当前行为为准。

## 部署目标

SSH 主机、用户与环境由维护者在任务中提供，公开仓库不记录生产主机和账号。认证使用 SSH agent 或用户受控的凭据存储。部署请求不授权删除数据、重置 Secret、防火墙或其他云资源。

密码只能在 SSH/SCP 的交互式密码提示中输入。不得把密码拼进命令、URL、脚本参数、环境变量、日志或交付说明。不要关闭 host-key 校验；首次连接先向用户展示并确认指纹。

首次安装需要真实 HTTPS 域名与管理员邮箱；不得从 SSH 端点推断这些值。已有部署先只读核对部署配置里的域名与管理员邮箱，不输出 Secret。

## 必读资料

- 本机或服务器流程先读 [../../../docs/deployment.md](../../../docs/deployment.md)。
- 服务器变更前执行 [references/preflight.md](references/preflight.md)。
- 打包、首次安装、升级或回滚使用 [references/release-workflow.md](references/release-workflow.md)。

## 本机开发

公开源码 Docker 快启使用 `docker/quickstart/start.sh` 或 `start.ps1`，独立生成 `.quickstart` Secret 并启动 `zzgeo-quickstart` 项目，只绑定 localhost。该自构建路径允许在用户本机 Docker 构建依赖和 Chromium，不改变下述维护者服务器不得联网构建的限制。详见 `docs/docker-quickstart.md`。

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
- 同一域名根路径发布静态官网，`/help/` 发布公开操作手册、脱敏截图和同源 PDF，`/app/` 发布业务工作台；官网/帮助示意数据与 API、数据库和证据链隔离。
- 发布机可为 Windows、macOS 或 Linux；`deploy/package.sh` 通过本地 Docker Buildx 生成目标 Linux 平台的 `server-runtime.tar`，并本地构建 Web dist。`.run` 上传后，服务器只用无 `RUN` 指令的 Dockerfile 通过 `FROM` + `ADD/COPY` 重构 Worker/Web 镜像，不执行 pnpm、apt、Playwright 下载或应用构建。
- 安装根为 `/opt/geo-console`：`releases/<id>` 保存不可变版本，`current` 指向当前版本，`shared/.env` 与 `shared/secrets` 跨升级保留。
- PostgreSQL password、32 字节 Base64 master key、bootstrap admin password 和 Log Service token 使用 owner-only Docker Secret 文件。S3 凭据当前保存在 owner-only `shared/.env`；有实例角色时优先省略静态 Access Key。
- Provider 与 HRouter Key 必须登录平台设置后保存并信封加密，不得写入 image、Compose、release bundle 或普通环境文件。

## 发布边界

- 每次 release 只运行 `deploy/package.sh`。它要求本地 Git、Node/corepack pnpm、Docker/Buildx；默认在本地 Linux `amd64` 构建容器中安装锁定的服务端依赖并导出 `/opt/geo-app` tar，再构建 Web dist。
- Web-only release 可显式设置 `GEO_REUSE_SERVER_BUNDLE` 指向同一 Git commit 的已验证 `.run`。打包器必须校验源 bundle/内层 artifact 哈希、commit、平台、Worker base，并确认全部后端/runtime 输入相对 HEAD 无改动；任一不符即拒绝，不能用它绕过后端构建。
- 服务器使用固定 `geo-console-worker-base:node24-playwright1234`，它只承载 Node、Playwright Chromium、中文字体和系统库。基础镜像升级是独立维护动作；普通 release 不能在服务器安装或下载这些内容。
- release payload 必须包含 `server-runtime.tar`、Web dist、landing、Compose/Caddy 和无网络重构 Dockerfile；不含 `.agents`/Demo 凭据、Git、desktop、宿主机 node_modules、Secret、`.env`、数据库、证据、备份或本地打包脚本。
- `deploy/install.sh` 和 `geo-console prepare` 必须在停止旧服务前验证 `local-server-artifacts`/`reconstruct` 标记、目标平台、artifact SHA-256、基础镜像及 Dockerfile 没有 `RUN` 指令；随后才允许 `docker compose build api web`，且不得 `--pull`。
- 桌面客户端使用独立 Tauri 签名链。私钥只能在发布机 owner-only 文件或受控 CI Secret 中，绝不能打入服务器 `.run`、Git 或 `latest.json`；客户端只保存公钥。桌面 WebView 内置交互 Agent 运行时，但不保存 HRouter Key、数据库或证据；模型流经 Tauri Channel 调受控 Responses 代理，业务工具仍由服务器执行。
- 涉及桌面 Agent 协议时先发布并验证服务器 migration/API，再发布签名客户端。验证桌面会话不创建 `agent_session_turn`、Channel 能流式返回首字、工具结果可幂等恢复，且旧桌面/浏览器默认的服务端执行仍兼容。回滚服务器前先检查是否存在 `execution_target='desktop' AND status='running'` 的会话；旧代码不会消费其 `desktop_pending_*`，不能把它们当作可自动恢复的 Worker job。
- 外层 release bundle 必须在本地与服务器分别校验 SHA-256，内层 server artifact 由 manifest SHA-256 在重构前再次校验。
- 首次安装会创建 Secret、可选 2 GB Swap，按 PostgreSQL -> Log Service -> API -> Workers -> Web/Caddy 顺序启动，并创建首份数据库/本地 evidence 成对备份。
- 升级会在旧版本在线时用本地产物重构新镜像，切换前自动备份 PostgreSQL 与本地 evidence，然后停止应用、切换 `current` 并重启新镜像；Log Service/API 启动时继续执行向前 migration。
- 管理命令没有自动数据库 rollback。只有 migration 兼容时才可单纯使用旧应用版本；不兼容时必须把升级前备份恢复到新建空 PostgreSQL/对象位置，验证后切换。
- 不部署浏览器登录档案、Collector node 或页面 adapter；当前云架构只使用五家联网 API。

## 防飘逸

如果修改 Compose 服务、端口、镜像、Secret、对象存储、安装器、升级切换、备份或恢复语义，按重大功能变更执行 [../geo-development/references/drift-control.md](../geo-development/references/drift-control.md)。必须从当前部署代码重新蒸馏事实，在同一变更中更新 `docs/deployment.md` 以及本 skill 或对应 preflight/release reference，并运行 `corepack pnpm check-drift -- --major ...`。仅执行既有安装/升级步骤不触发。

## 完成标准

部署完成必须验证 HTTPS 根路径官网、`/help/` 在线手册及帮助 PDF、`/app/` 登录、`/api/health`、Log Service `/health`、全部九个 Compose 服务、migration 表、结构化日志写入/租户读取、对象写读、成对备份、至少一个用户提供 Key 的 Provider 连接测试，以及业务报告中文 PDF。不得因为容器是 running 就宣布成功。


## V2 发布门禁（2026-09-05）

服务器新增 `semantic-worker`（同一 Worker 镜像、数据库、Secrets 和证据卷）；管理脚本同步启动、停止及检查该服务。本机保持一个业务 PGlite 进程，组合四类执行器。先完成 API migration `0019_visibility_v2.sql`，再启动后台 Worker 与 Web/桌面客户端。不得把代码验证描述为已发布。

新批次必须配置机构 HRouter GPT 模型。部署验收增加：成功 Capture → 无工具严格语义解析 → 只追加 MetricSnapshot → 证据中心人工审核 → 当前快照绑定的报告叙述/质检两次人工审批 → PDF/Word。需要真实 Key 验证 HRouter 对严格结构化输出的支持，单元测试不能证明模型准确率或线上兼容性。

不存在 V1 指标回退开关；应用回滚前先停止 V2 新采样并核对数据库兼容性。所有语义表与 `semantic/` 原始模型响应随完整数据库/证据备份保留。历史测试数据清空必须另行明确操作，不能混入升级 migration。


## 成员/RBAC 发布补充

成员修复依赖 `0020_membership_rbac.sql`，API 与 Web 同步更新，桌面客户端内置 Web 也需更新。不得只更新前端而缺少 `/api/users/options`、恢复/重置端点。migration 不扩大既有机构/角色权限，不替代超管审核授权。发布后验证受限成员不能提升权限或客户范围、重复邮箱 409、密码/恢复会话撤销。详见 `docs/rbac-demo-verification-2026-09-06.md`。

## RBAC V2 制品一致性

发布必须包含 packages/authorization 和 0021_authorization_kernel.sql；API、Agent、Web/Tauri 同步升级。无创建者历史任务保持 unassigned 不得冒充超管续跑。Docker 不得删除 workspace 的 minimumReleaseAge/trustPolicy；仅 corepack pnpm 冻结安装。回退须对应升级前备份/制品，具体见 docs/rbac-v2.md。

- ARM 发布机使用原生 BUILDPLATFORM 安装目标 Linux OS/CPU/libc 的冻结依赖，禁止用宿主 node_modules 或关闭供应链控制规避 QEMU。必须验证 artifact 的目标 tsx 和独立 PostgreSQL migration，checksum 失败即阻止发布。
