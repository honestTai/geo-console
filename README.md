# GEO Console

面向 GEO 机构的多客户云端工作台。它用真实官网证据建立客户范围，通过五家供应商的联网 API 采样回答，再完成证据化诊断、人工审批整改、同条件复测、不可变报告和业务归因。

```text
客户建档 -> 官网与竞品研究 -> 人工确认问题
-> 五平台分时采样 -> 指标、信源与稳定性分析
-> HRouter Agent 草稿 -> 人工审批 -> 发布 URL 验收
-> 严格复测 -> 在线报告/PDF -> 业务归因
```

监测平台包括 DeepSeek、Kimi、豆包火山方舟、通义千问 DashScope，以及“元宝搜索源 + 混元合成”。所有页面和报告都会说明 API 口径，不把 API 回答描述成对应 App 页面回答。运行时代码没有示例公司、Mock 回答、Seed 指标或行业硬编码。

## 本机启动

要求 Node.js 24、Corepack、pnpm 11。PGlite 只用于本机开发和测试。

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm geo setup
corepack pnpm geo start
```

打开工作台 <http://127.0.0.1:3000/app/>。本机无用户时使用仅限开发环境的管理员旁路；所有供应商与 HRouter Key 都在“平台设置”中配置，并由 macOS 钥匙串中的主密钥信封加密。生成 PDF 需要 Chromium：

```bash
corepack pnpm --filter @geo/worker exec playwright install chromium
```

本机数据位于 `~/Library/Application Support/GEO Console/`，不会写入 Git。`database/` 是 PGlite，`artifacts/` 保存不可变证据，`backups/` 保存离线备份。

## 验证命令

```bash
corepack pnpm check-types
corepack pnpm test
corepack pnpm build
corepack pnpm lint
corepack pnpm license-check
```

服务器 Docker、S3 兼容存储、HTTPS、备份与回滚见 [部署文档](docs/deployment.md)。`bash deploy/package.sh` 在 Windows/macOS/Linux 发布机本地生成目标 Linux 的服务端依赖/源码 artifact 和 Web dist，再封装 `.run`；服务器只用 `FROM` + `ADD/COPY` 重构应用镜像并重启，不运行 pnpm、apt、Playwright 下载或 Web build。系统边界见 [架构文档](docs/architecture.md)，五平台契约见 [适配器文档](docs/search-provider-adapters.md)，故障处理见 [运维文档](docs/operations.md)。

本项目为专有闭源软件，未经书面授权不得使用、复制、修改或分发；具体条款见 [LICENSE](LICENSE.md)。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 本次能力更新（2026-09）

- AI 工作台：正式桌面客户端在本机独立 Node 进程运行 Deep Agents / LangGraph 的模型调用与工具编排，每台客户端独立并发；服务端只代理受控 Responses 流、执行项目范围内的业务工具并保存会话/证据。输入“跑基线/跑快审/生成报告/生成优化文章”等自然语言指令后，Agent 确认问题集并调用服务端接口建批次、等待采集、核验、官网审计、规则诊断、报告叙述/质检/冻结/PDF 和优化文章；浏览器入口保留服务端 Agent 作为调试兼容。
- 优化文章：按已批准报告的每条 GEO 建议生成 Markdown 草稿，可编辑、预览、改状态、填写发布地址、重新生成。
- 报告引用可读化：证据统一编号 `[n]`，附平台、问题、采样、时间与引用网址，PDF/Word/CSV 同步。
- 模型配置：平台设置里从各平台与 HRouter 读取模型列表下拉选择，HRouter Agent 思考强度可按会话覆盖；AI 工作台可为单次会话指定模型。
- 配置迁移：平台设置（不含密钥）、行业问题知识库、客户监测范围均可导出 JSON 并导入到其他机构或环境；范围导入后先载入编辑器核对再保存为新版本。
- 归因日报口径：GA4/GSC 等只到天的数据按中国时区零点入库，页面只显示日期；同配置的基线与复测在总览与监测页可比对。
- 工作台 UI 重做：侧栏分组、单一页面标题、统一间距/按钮/分页/表单原语。

## SQLite 桌面执行边界（2026-10-04）

当前桌面为 React → Tauri IPC → 本机 Node 业务引擎 → 新 SQLite 工作区。模型/搜索/采集/网站分析/指标/内容质检/报告/调度均在客户端；云端只鉴权、权限管理与账户私有快照存储。代码事实源：`apps/desktop/src/engine.ts`、`src-tauri/src/local_engine.rs`、`packages/core/src/sqlite.ts`、`apps/worker/src/api-service.ts` 和 `desktop-storage.ts`。独立指标、证据页面保留，不迁移旧数据库或业务数据。

会话/工具账本/等待状态/租约落 SQLite；MemorySaver 仅回合内使用。结果不确定的工具停止自动重放并要求成员核查。关闭客户端会停止本机执行；鉴权断网 fail-closed。哈希分块 + CAS 同步不自动合并冲突，设备主密钥不上传，新设备重配 Provider Key。桌面公开分享暂未接静态托管，会明确拒绝创建无效链接，PDF/Word 本地导出仍可用。

完整开发、恢复、测试和限制见 `docs/desktop-agent.md`。云端新部署显式使用 `compose.desktop-cloud.yaml`，不启动业务 Workers；其余服务器拓扑与 PostgreSQL 操作章节仅适用于旧版兼容部署，不代表新桌面执行位置。
