---
name: geo-deployment
description: Install, deploy, upgrade, or roll back GEO Console locally or on Linux, and build its signed Tauri desktop client updates, with the private release bundle, Docker Compose, PostgreSQL, Caddy HTTPS, local/S3 evidence storage, standalone structured Log Service, and separate API/Capture/Agent/Report services. Use for environment and release work; not for feature development or ordinary incident response.
---

# GEO Console Deployment

先确定目标是本机开发环境、首次服务器安装、已有服务器升级，还是隔离恢复/回滚。以 `compose.yaml`、`deploy/install.sh` 和 `deploy/geo-console` 的当前行为为准。

## 已授权 Demo 服务器

- SSH 主机：`8.218.21.183`
- SSH 用户：`root`
- SSH 认证：使用 SSH agent 或用户受控的安全凭据存储；不得在仓库文档中记录明文密码。

这些信息只标识本项目的 demo 服务器。它授权在用户部署/维护请求范围内登录该 demo，不自动授权删除数据、覆盖证据、重置 Secret、防火墙或其他云资源，也不能推断为任何其他环境的凭据。

密码只能在 SSH/SCP 的交互式密码提示中输入。不得把密码拼进命令、URL、脚本参数、环境变量、日志或交付说明。不要关闭 host-key 校验；首次连接先向用户展示并确认指纹。

`8.218.21.183` 是 SSH 端点，不是安装器接受的 HTTPS 域名。首次安装仍需要解析到该 IP 的真实域名和管理员邮箱；不得发明这两个值。已有部署先只读检查 `/opt/geo-console/shared/.env`，复用其中的 `GEO_DOMAIN` 与 `GEO_ADMIN_EMAIL`。

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
- 同一域名根路径发布静态官网，`/help/` 发布公开操作手册、脱敏截图和同源 PDF，`/app/` 发布业务工作台；官网/帮助示意数据与 API、数据库和证据链隔离。
- 发布机可为 Windows、macOS 或 Linux；`deploy/package.sh` 通过本地 Docker Buildx 生成目标 Linux 平台的 `server-runtime.tar`，并本地构建 Web dist。`.run` 上传后，服务器只用无 `RUN` 指令的 Dockerfile 通过 `FROM` + `ADD/COPY` 重构 Worker/Web 镜像，不执行 pnpm、apt、Playwright 下载或应用构建。
- 安装根为 `/opt/geo-console`：`releases/<id>` 保存不可变版本，`current` 指向当前版本，`shared/.env` 与 `shared/secrets` 跨升级保留。
- PostgreSQL password、32 字节 Base64 master key、bootstrap admin password 和 Log Service token 使用 owner-only Docker Secret 文件。S3 凭据当前保存在 owner-only `shared/.env`；有实例角色时优先省略静态 Access Key。
- Provider 与 HRouter Key 必须登录平台设置后保存并信封加密，不得写入 image、Compose、release bundle 或普通环境文件。

## 发布边界

## 防飘逸

Deep Agents 桌面包需随平台捆绑 Node 24、engine.mjs、Playwright/Chromium、manifest 与许可证；先 prepare-runtime 再 cargo/Tauri。三平台 CI 不等于签名发布或安装实测。新桌面业务全部本地执行；云端仅 auth/storage。只初始化新 SQLite，不导入旧业务数据库。部署切换用显式控制面覆盖配置，不自动改动旧实例；见 `docs/desktop-agent.md`。

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

## SQLite 桌面执行边界（2026-10-04）

当前桌面为 React → Tauri IPC → 本机 Node 业务引擎 → 新 SQLite 工作区。模型/搜索/采集/网站分析/指标/内容质检/报告/调度均在客户端；云端只鉴权、权限管理与账户私有快照存储。代码事实源：`apps/desktop/src/engine.ts`、`src-tauri/src/local_engine.rs`、`packages/core/src/sqlite.ts`、`apps/worker/src/api-service.ts` 和 `desktop-storage.ts`。独立指标、证据页面保留，不迁移旧数据库或业务数据。

会话/工具账本/等待状态/租约落 SQLite；MemorySaver 仅回合内使用。结果不确定的工具停止自动重放并要求成员核查。关闭客户端会停止本机执行；鉴权断网 fail-closed。哈希分块 + CAS 同步不自动合并冲突，设备主密钥不上传，新设备重配 Provider Key。桌面公开分享暂未接静态托管，会明确拒绝创建无效链接，PDF/Word 本地导出仍可用。

完整开发、恢复、测试和限制见 `docs/desktop-agent.md`。云端新部署显式使用 `compose.desktop-cloud.yaml`，不启动业务 Workers；其余服务器拓扑与 PostgreSQL 操作章节仅适用于旧版兼容部署，不代表新桌面执行位置。
