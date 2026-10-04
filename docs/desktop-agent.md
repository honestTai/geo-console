# SQLite 本地 GEO Agent（2026-10-04）

基准 `d880e092ec9342362161775f68bbe100d6d39fd0`。影响架构、数据/身份/Agent 边界、运维、部署和能力说明。不是旧版“本地对话 + 云端工具 RPC”。

## 架构与代码事实源

React / antd（对话 + 独立指标、证据、报告）→ Tauri IPC → 独立 Node 24 业务进程 → SQLite + 本地 artifacts。Deep Agents / LangGraph 提供受控模型/工具循环；Capture、Semantic、Agent、Report、内容质检与定时器都在本机。模型、搜索和平台 Provider 是本机发起的外部网络调用，不代表离线模型。

- `apps/desktop/src-tauri/src/local_engine.rs`：主窗口校验、进程、鉴权/业务分流、受控存储 broker、停止。
- `apps/desktop/src/engine.ts`：工作区、设备密钥、云端授权镜像/复核、本机 API 与全部执行器。
- `apps/desktop/src/workspace-sync.ts`：SQLite 一致快照、分块、CAS、恢复与待提交日志。
- `packages/core/src/sqlite.ts`、`sqlite-dialect.ts`、`sqlite-guards.ts`：本地数据库与原生约束。
- `apps/worker/src/api-service.ts`：共享领域 API；`desktop-storage.ts`：云端不透明存储。
- `packages/agent-runtime`：Deep Agents / LangGraph；`apps/worker/src/local-turn-recovery.ts`：领域工具账本恢复。

源码复用不是云端执行。桌面 bundle 通过 `desktop-index.ts` 禁止 pg/PGlite/旧迁移执行器；Rust 不允许子进程访问云端模型/工具/业务路由，本地失败不回退云端。旧服务端入口仅为兼容保留。

## 新 SQLite，不迁移旧数据

Tauri appData 的 `workspaces/<sha256([organizationId,userId])>/workspace.sqlite` 是业务主库。当前为**账号私有工作区**，不是多人实时共享数据库。Node 内置 SQLite，WAL/FULL synchronous/外键，串行 BEGIN IMMEDIATE。全新 v1 静态初始 schema；只初始化系统权限定义，没有业务示例或默认行业。

不连接/导出/导入现有 PostgreSQL 或 PGlite，不新增数据库 migration 文件。未知版本、非空未标版本库拒绝打开，绝不覆盖。`scripts/build-sqlite-schema.mts` 仅开发时用全新内存 PGlite 编译领域定义为静态 schema，不读已有数据库，不随客户端运行。枚举/外键/不可变历史/项目写保护由 SQLite 原生约束实现。

`sqlite-dialect.ts` 只处理仓库受测试覆盖的静态领域 SQL，不接收模型、UI、云端 SQL，不是通用 PostgreSQL 模拟器。会话、任务、审批、配置、指标、证据索引及脱敏运行日志落本机；原始 Capture 行与 artifacts 仍只读。

## 长任务与人工确认

Deep Agents 提供模型/工具循环，GEO 保留双重工具白名单、参数检查与当前主体授权。不开放通用 shell、文件系统、SQL 或任意子 Agent。

Graph 当前使用回合内 MemorySaver，**未实现 LangGraph 节点级 SQLite checkpointer**。持久恢复以 SQLite 领域记录为准：最终消息先写 transcript，执行工具前写账本，结果先落盘再追加 toolResult，等待状态、计划与队列租约也落盘。正常重启读取队列/等待状态；已保存的工具结果恢复时不重复执行。副作用执行后但结果未落盘的中断状态不确定，会停止自动重放，要求成员先核查任务/证据再继续。不是 exactly-once 外部副作用保证。

人工确认继续经候选表格、ask_user 和审批流程。独立指标/证据页保留。关闭客户端即停止本机调度，不再由云端接手；原生退出等待任务收尾与同步，超时保留 SQLite/WAL，未完成租约按现有超时规则恢复，不能手工标为成功。

## 身份与安全

Rust 保存云端登录 cookie，子进程只接收已认证主体及存储响应；主窗口 IPC 来源校验。本机 HTTP 绑定 127.0.0.1 随机端口，要求随机令牌且常量时间验证，拒绝浏览器 Origin。子进程继承环境经过清理，云端 broker 只允许 auth/me、storage bootstrap/head/objects/commit。功能权限仍由云端控制；账号私有工作区的项目范围取本机创建授权记录，不混用旧云端数据库的项目 ID。普通成员创建的本机项目在本机获得访问权；事务内重授权使用同一事务连接，避免 SQLite 队列自锁。

Provider Key 本机加密，设备 master-key 文件权限 0600，不同步；Windows 依赖用户目录 ACL，不宣称使用系统密钥库。云端约 10 秒复核授权，失联/撤权后 fail-closed，不是长期离线授权产品。账号/机构切换前先停止原工作区。

云端是受信存储：业务快照和证据不做端到端加密；快照内凭据仍是设备密钥加密内容，新设备恢复会清除不可解密凭据并要求重配，不同步 cookie 或主密钥。

## 同步与恢复

SQLite 原生一致快照包含已提交 WAL。只同步 workspace.sqlite 与 artifacts/，拒绝符号链接、危险跨平台路径。SHA-256 分块最大 1 MiB，单文件 512 MiB，清单 10 GiB；云端历史块总计上限 20 GiB / 25,000 块。超额明确报错，不删原始证据。本机成功不等于云端已备份。

云端复用既有 settings 元数据和不可变 object-store，不新增表。CAS 版本提交；丢失响应通过 sync-pending.json 重试相同提交。多设备版本冲突保留本机，不自动合并或覆盖。每 60 秒、手动“同步”、正常退出尝试同步，UI 显示版本及错误。

备份本地目录须先正常退出客户端，保留数据库、WAL/SHM、artifacts 与设备主密钥。冲突时先复制整个目录，不删除或强制重置；需要采用云端版本时在新的设备目录恢复。当前没有图形化冲突合并向导。

## 开发、打包与控制面

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @geo/worker exec playwright install chromium
corepack pnpm --filter @geo/desktop prepare-runtime
corepack pnpm desktop
```

beforeDev 只准备运行时和 React，不自动启动旧 API/数据库。开发鉴权默认 http://127.0.0.1:3010，可用 GEO_DESKTOP_SERVER_ORIGIN 显式配置；正式包只接受 HTTPS。必须显式提供隔离鉴权/存储服务，不能推断已有外部数据库权限。

新控制面部署显式使用 `docker compose -f compose.yaml -f compose.desktop-cloud.yaml ...`：GEO_SERVER_MODE=storage，业务路由 410，不启动 Capture/Agent/Report/Semantic（仅 legacy profile）。未实际部署或更改现有实例。切换已有服务器须另外确认并停止原本运行的业务容器，新增 profile 不保证既有容器已停止。旧云端数据库初始化/升级仍需明确部署授权。

随包 Node 24、业务 bundle、Playwright 与匹配 Chromium，校验哈希并保留许可证。macOS 最低 13.5（与包内 Node 二进制部署目标一致），产物 .app/.dmg；Windows NSIS，Linux .deb/.AppImage 均需对应 OS 原生构建。`.github/workflows/desktop.yml` 提供手动验证构建，不等于三个平台已安装验收。公开发布仍需签名、公证/对应平台信任和签名更新包；不关闭正式 updater 校验。

## 验证与已知边界

- engine.test.ts：真实子进程、实际 Deep Agents + Responses SSE（回环测试 Provider）、项目/会话创建、SQLite 重启、新设备快照恢复与凭据重配，断言云端无业务执行请求。
- workspace-sync.test.ts：密钥不上传、哈希校验、丢失提交响应恢复。
- sqlite.test.ts：空库、枚举、并发/回滚、SQLite 文件、快照、拒绝旧格式和危险路径。
- Worker 领域测试分别在新内存 PGlite 和 GEO_TEST_DATABASE=sqlite 下运行；本地工具恢复、云端账号隔离/CAS/哈希有专用测试。
- Rust 验证主窗口/业务路由/broker，Mac 构建另检包内 Node/SQLite/Chromium。UI 截图为隔离夹具，不冒充生产或原生业务 E2E。
- 未验证生产登录、真实付费模型与全部平台搜索、Windows/Linux 安装、签名更新。换底座本身不代表搜索质量提高。
- 桌面公开报告分享尚未接云端静态托管，当前明确返回 409，避免生成无效 geo:// 公开链接。本机 PDF/Word 导出保留。

## 本机验收记录（2026-10-04）

- 类型检查、完整测试（71 文件 / 316 项）、构建、lint、许可证检查（320 个包）与重大变更 drift 检查通过。完整测试使用 `corepack pnpm test --force --concurrency=2`，避免多个内存 PostgreSQL 实例并发启动超过测试时间预算。
- SQLite Worker 48 文件 / 209 项通过，SQLite Log Service 2 项通过。原生 cargo fmt/check/test 通过，Rust 11 项。
- Apple Silicon `.app` 构建成功，最低 macOS 13.5；实际使用包内 Node + engine 重跑独立进程集成测试，包括受限成员创建/读取/事务内封档、真实 SDK 的回环 SSE、重启和新目录恢复。Node/engine SHA-256 与 manifest 一致。
- 包内 Node 24.16.0、SQLite 3.53.0、Chromium 151.0.7922.34；在阻断网络条件下用随包浏览器生成 PDF 冒烟文件。没有使用外部安装的浏览器替代包内浏览器。
- 隔离 UI 夹具验证输入、默认不自动批准、独立指标导航及 1280×820 / 980×680 布局；最小宽度无横向溢出。截图 `artifacts/desktop-agent/workspace-sqlite-1280.png`，不是生产业务截图。
- 未部署现有云端实例、未迁移旧库、未测试真实付费 Provider；Windows/Linux、完整原生窗口登录及签名更新仍未实测。Vite 大 chunk 提示仍在，未将其描述为构建失败。
