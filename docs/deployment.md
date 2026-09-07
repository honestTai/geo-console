# 本机与服务器部署

官网选填/可追溯审计发布须同步 API、Web、Capture、Agent、Report 代码和 migration `0024_optional_website.sql`，仅针对新建或明确授权部署库。没有新增服务/端口/包依赖，但人工审计所在 API 与 `run_site_audit` 所在 Agent 现在需要可用 Chromium 和中文字体；沿用项目 Playwright 发行版或显式 `GEO_PLAYWRIGHT_EXECUTABLE_PATH`。上线前分别验证截图/PDF、artifact 项目授权、quota 清扫和空官网建档，确认代理请求隔离与资源预算。备份数据库与对象存储；空官网记录与旧版 NOT NULL 假设不兼容，回滚不得通过编造官网或删除客户恢复约束。详细回滚/验证边界见 `docs/website-audit-and-capture-recovery.md`。

完整回答辅助解读随 API/Web 一起发布 migration `0023_answer_analysis.sql`，复用 Semantic Worker，无新增服务、端口或生产 Python 依赖。备份须包含 `answer_analysis_runs/answer_analysis_attempts`；回滚前停止新建并等待在途分析结束，保留新增表，旧代码不消费 `answer_analysis` 队列。只在新建 PGlite 或明确授权部署库迁移。完整行为见 `docs/answer-analysis.md`。

## 本机开发

建议 4 核、16 GB 内存、20 GB 可用磁盘。Node.js 24 与 pnpm 11 由根 `packageManager` 固定。

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm geo setup
corepack pnpm --filter @geo/worker exec playwright install chromium
corepack pnpm geo start
```

服务只绑定 `127.0.0.1`；Log Service 使用 3020 和独立日志 PGlite，API 使用 3010 并在进程内组合执行四个本机队列 Worker。PGlite 仅用于开发测试，不要对同一目录启动多进程 Worker。Report Worker 优先使用 Playwright Chromium；服务器镜像始终安装 Playwright Chromium。

## 服务器 Docker

低负载 Demo（同时只跑一两个任务）可使用 2 vCPU、4 GB 内存、50 GB SSD 和 2 GB Swap，并把采集并发固定为 1。持续监测或多客户并发建议 4 vCPU、8 GB 内存、80 GB SSD。无需 GPU。

服务器使用 Ubuntu/Debian。域名必须解析到服务器，云安全组只开放 80/443；SSH 端口限制到管理来源。Log Service 3020、API、Worker 和 PostgreSQL 不映射主机端口。

同一个 HTTPS 域名提供三个前端入口：

- `https://<domain>/`：静态产品官网。
- `https://<domain>/help/`：公开操作手册、脱敏截图与同源 A4 PDF；帮助页不访问业务 API。
- `https://<domain>/app/`：React 业务工作台；访问 `/app` 会重定向到带尾斜杠的地址。

官网/帮助中心与业务工作台在 Web 镜像内使用不同目录。官网示意数据和帮助截图不访问 API 或数据库；业务工作台继续只显示真实项目数据。发布后除根路径和 `/app/` 外，还要验证 `/help/`、25 张截图及 `/help/ZZ-Geo-操作手册.pdf` 可访问。

## 桌面客户端

`apps/desktop` 是面向全部用户的 Tauri 2 客户端。正式版内置与 `/app/` 同源构建的 Web 资产，开发版加载本机 `/app/`；浏览器暂时保留同步调试。正式桌面工作台在 WebView 内运行 `pi-agent-core`，模型请求通过 Tauri Channel 流式访问服务器的受控 Responses 代理，工具通过服务器业务 RPC 执行。桌面不内置数据库、证据文件或 Provider/HRouter Key，权限、会话、工具幂等结果和业务数据仍来自服务器。

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

桌面构建必须同时包含 `apps/web/src/desktop-agent.ts` 的独立运行时 chunk 和 Rust `stream_agent_response/cancel_agent_response` 命令。发布前至少验证首个文本增量可通过 Channel 到达、取消可中止上游请求、断线后不会重复执行已完成的工具，以及普通浏览器创建的会话仍走服务端兼容执行。

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
- 顺序启动 PostgreSQL、Log Service、API、Capture Worker、Semantic Worker、Agent Worker、Report Worker、Web 和 Caddy，避免首次迁移竞争。
- 验证 HTTPS、服务健康和一次数据库/本地证据成对备份。
- 验证根路径官网、`/help/` 在线手册及 PDF、`/app/` 同步调试入口以及桌面客户端登录与动态导航。
- 验证 migration `0018_desktop_agent_runtime.sql` 已执行；桌面新会话显示“桌面执行”、不产生 `agent_session_turn` job，受控 Responses 流和一个只读业务工具可完整跑通，PDF/Word 仍由 Report Worker 生成。

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


## V2 发布门禁（2026-09-05）

服务器新增 `semantic-worker`（同一 Worker 镜像、数据库、Secrets 和证据卷）；管理脚本同步启动、停止及检查该服务。本机保持一个业务 PGlite 进程，组合四类执行器。先完成 API migration `0019_visibility_v2.sql`，再启动后台 Worker 与 Web/桌面客户端。不得把代码验证描述为已发布。

新批次必须配置机构 HRouter GPT 模型。部署验收增加：成功 Capture → 无工具严格语义解析 → 只追加 MetricSnapshot → 证据中心人工审核 → 当前快照绑定的报告叙述/质检两次人工审批 → PDF/Word。需要真实 Key 验证 HRouter 对严格结构化输出的支持，单元测试不能证明模型准确率或线上兼容性。

不存在 V1 指标回退开关；应用回滚前先停止 V2 新采样并核对数据库兼容性。所有语义表与 `semantic/` 原始模型响应随完整数据库/证据备份保留。历史测试数据清空必须另行明确操作，不能混入升级 migration。


## RBAC 成员修复发布门禁（2026-09-06）

新增迁移 `0020_membership_rbac.sql`，与 API/Web 同步发布：稳定默认角色键、候选权限端点、恢复/重置端点、新成员默认无客户。已有用户范围不被修改，既有机构/角色的撤权不会自动恢复；不要借升级扩大默认机构权限。

先部署服务端并验证 migration，再更新 Web/桌面内置 Web。验收至少覆盖超管正常新增、重复邮箱 409、受限管理员越权创建/停用 403、停用恢复后旧 token 401、密码重置和跨页范围保存。新前端不能搭配没有 `/api/users/options` 的旧 API。实际是否已部署以部署记录为准，见 `rbac-demo-verification-2026-09-06.md`。

## RBAC V2 发布补充（2026-09-06）

必须将 packages/authorization 随服务端制品打包，并同步更新 API、Agent、Web/Tauri 与 0021 migration。Docker 和旧制品复用检查已纳入该 package；构建使用 corepack pnpm、冻结 lockfile，保留 minimumReleaseAge/trustPolicy。升级前备份，在隔离库验证，禁止混跑旧 API/Agent 与新授权语义；回退使用对应备份与制品。本轮没有构建发布服务器镜像、部署 Demo 或清空数据库。详情见 docs/rbac-v2.md。

## ARM 发布机与 AMD64 制品（全盘审查修正）

Docker artifact builder 使用 BUILDPLATFORM 原生 Linux Node 24 执行 corepack pnpm，不在 QEMU 中运行目标 Node；install 明确 --os=linux、--cpu=x64/arm64、--libc=glibc，--ignore-scripts 更严格禁依赖脚本，并检查目标 esbuild 存在。继续冻结锁文件和保留供应链控制，不打包宿主 node_modules。服务器固定 Worker base 不变，并用恢复到独立 PostgreSQL 的目标架构容器验证 tsx/DB/迁移。相对输出目录先解析为绝对路径，外层 checksum 计算失败必须终止。正式切换仍走 geo-console upgrade，无服务器下载/安装/构建代码。
# 仓库凭据与本地验收制品

SSH 密码、管理员初始密码和模型密钥不得写入仓库文档；连接认证通过 SSH agent 或用户受控的安全凭据存储取得。本地 `deliverables/` 中的业务截图、报告及一次性环境操作制品不随源码提交。删除当前文件中的明文凭据不等于清除 Git 历史；曾进入提交历史的真实密码应轮换，历史重写须另行明确授权，不能在普通发布或推送时擅自执行。
