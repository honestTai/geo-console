# GEO Console Project Map


品牌等待：`ui/BrandLoading.tsx/css` 提供 Z 描绘标记和字标，ThemeProvider 通过 ConfigProvider 统一 Spin/Table/Button/Select 指示器；App、ViewBoundary、趋势/设置/归因/证据/文章详情消费同一展示件。保留 Page 延迟、具体业务状态和错误重试，见 docs/ui-refinement.md。

全工作台参考布局：Shell(256/64/48 尺寸及顶栏导航) → Page(唯一 H1/操作) → shared primitives/theme(表格/空态/表单/统计)；Remediation 用 TaskManagementLayout 做主列表、已完成折叠、统计和运行区，任务详情复用 TaskItem 抽屉。无新增后端/迁移/队列行为，运行状态不能推断 Worker 在线。布局验证见 docs/content-operations.md。

内容运营：migration 0028-0031 → `article-quality.ts/articles.ts`（版本、质检、审核和导出）、`customer-knowledge.ts`（资料版本与批准）、`publications.ts`（人工渠道、工单与回执）、`project-operations.ts`（权限内待办/业务反馈）。`content-routes.ts` 由已授权的 API dispatcher 调用；新增资源登记在 authorization/resources。`semantic-runtime.ts` 独立一槽执行 article_quality；`queue-recovery.ts` 收尾耗尽租约。Web 对应 ArticleQuality、CustomerKnowledge、Publications、OperationsOverview；App/lazy-views/workspace-views 装配，theme/Shell 为用户指定浅色蓝色。事实边界、恢复和测试见 `docs/content-operations.md`。

客户生命周期：`project-lifecycle.ts`（锁定、重授权、任务检查、封档/逻辑删除）→ `project-state.ts` + authorization HTTP/artifact/execution → migration 0027 数据库写保护；CustomerManagement/ProjectLifecycleDialog 管理筛选和二次确认，access 的 ProjectReadOnlyContext 控制工作台动作。新项目子表须补充写保护映射。实现与回滚边界见 `docs/customer-management.md`。

界面与文案：Page.css 统一提示上下间距，primitives Pagination 管理页码/每页条数，Articles.css 管理抽屉列宽和证据长文本；文案审阅范围见 `docs/ui-refinement.md`。Agent v9 增加自然行文要求，生成内容仍绑定原证据与审核流程。

自适应文章事实源：`agent.ts ARTICLE_WRITING_GUIDANCE` 与提交边界 → `evidence/publication.ts contentStrategy` → `PublicationPlan` 编辑/预览 → `report-reader/report-word-reader`。按实际问题决定形式与篇幅，不设统一长文门槛；旧 JSON 缺字段只披露，不回填。沿用 0026 的 JSON 列。

客户解释链：`metrics/communication.ts` → Web `MetricLabel/MeasurementExplanation`、worker `report.ts/report-reader.ts/report-word-reader.ts`；`report-followup.ts` 保留任务与冻结配对对比。`report-evidence.ts` + `website-evidence.getEvidenceReference` 负责全文附录与准确历史定位。`evidence/publication.ts` → agent/articles + migration 0026 → `PublicationPlan/Articles` → report-snapshots。先读 `docs/reader-report-workflow.md`；解释不得写回正式指标，来源不等于引用、份额不等于市场份额。

Agent 的 `read_project_context` 通过 `agent-measurement-context.ts` 提供运行绑定的 metricSnapshot、frozenBatchConfig 和 readerGuide；问题校验使用冻结问题，不能拿当前资料或最新解析覆盖运行绑定版本。

机构客户目录：`core/access.ts` + migration 0025 注册 `page.customers`；Web `ui/workspace-views.ts` 维护页面/图标/项目页权限注册，`lazy-views.tsx` 按需加载 `CustomerManagement`；App/Management 只装配，CreateProject 是客户首页与客户管理共用的建档弹窗，ProjectProfileEditor 接受列表摘要。列表/新建/编辑继续复用 service/project-profile 和原有授权边界，0027 增加封档/逻辑删除，不支持跨机构转移。验收与发布见 `docs/customer-management.md`。

客户/官网/额度链：`project-profile.ts` + migration 0024 → `ProjectProfileEditor` / Onboarding / Overview；`capture-progress.ts` → cloud-runner/service → Monitoring；`crawler.ts` → `website-discovery.ts`（XML 类型、嵌套、限额）、`public-http.ts`（DNS 固定与压缩上限）、`website-screenshot.ts`（受控浏览器）、`website-report.ts` / `report-branding.ts`（审计与最终报告）。`website-evidence.ts` + authorization/resources → WebsiteEvidenceViewer / AuditEvidenceDrawer，让历史审计/快照引用可打开且跨项目不可读。操作与兼容说明见 `docs/website-audit-and-capture-recovery.md`。

完整回答辅助解读：evidence `answer-analysis.ts` → worker `answer-analysis-model.ts` / `answer-analysis.ts` → Semantic Worker 独立槽 → Web `AnswerAnalysis` / `ui/answer-analysis` / `useAnswerAnalysis`（EvidenceDetail 装配）。Core migration 0023 保存独立运行/尝试及授权，GET 不调用模型，POST 固定异步身份。与 measurement/metrics 解耦，不改正式排名。`tools/answer-analysis-eval` 是可选 Python 离线标注评测；详情见 `docs/answer-analysis.md`。

## 工具链

- Node.js `24.x`，根 `packageManager` 固定 pnpm 11；所有命令使用 `corepack pnpm`。
- Turborepo 编排 build/check-types/test；Biome 负责 TS/CSS lint 与格式。
- `scripts/check-skill-drift.mjs` 根据重大变更的任务文件推导影响面，检查对应 docs/skill reference 是否同步。
- 本机默认 PGlite；存在 `DATABASE_URL` 时切换 PostgreSQL。
- 本机对象写入 `GEO_DATA_DIR/artifacts`；`GEO_OBJECT_STORE=s3` 时使用 S3 兼容存储。

## 运行拓扑

本机 `corepack pnpm geo start` 启动独立 Log Service、包含四个队列执行器的组合 API 进程和 Vite Web，避免多进程 PGlite 目录争用；Log Service 使用独立本机 PGlite。服务器 PostgreSQL Compose 将 Log/API/四个 Worker/Web/Caddy 分开，只有 Caddy 暴露 80/443。

## 所有者地图

## 业务数据流

1. 项目创建后抓取官网证据（最多 40 页、4 路并发，24 小时内重试复用快照），生成画像、竞品和 Prompt 候选；竞品候选以 `pending` 落库后在后台逐个联网核实（结论回写 `competitors.verification`，未通过的在建档页标“待确认”）；人工确认后项目进入 active，确认沿用未变化问题/竞品的 ID，确认时可把新问题回流到行业知识库。成员不知道该监测什么时，可在建档页“后台联网出题”（`prompt_research` 草稿，批准后进入候选列表）或到工作台让 Agent 用 `web_search` 联网研究买家问法；工作台以 `propose_questions` 提交候选，成员在表格里改字、勾选后确认，服务端写入范围并启用项目。
2. 创建批次时读取已批准范围和启用 Provider，将完整配置写入 `experiment_batches.config` 与 hash，并为每个采样创建 capture job。
3. Capture Worker 只按冻结 Provider 契约执行；原始响应先写对象存储，再以唯一 `job_id` 插入 QueryCapture v2，最后完成 job 和批次状态。执行抛错走 `failJob` 并刷新批次；Worker 每分钟清扫租约过期且重试用尽的任务，批次总会收敛。周期监测到期时按当前范围构造配置，可比才复测否则新建基线，失败原因写在计划上。
4. 成功 API Capture 异步进入受限 Semantic Worker，经确定性校验/独立复核或人工审核后生成 V2 MetricSnapshot。GET 只读快照；问题/平台等权、覆盖门槛和配对区间决定正式漂移；报告及其草稿绑定当前快照。V1 计算不再调用。
5. finding 转整改任务；技术类任务重跑官网审计验收，其余任务的发布 URL 必须在客户域名下并重新抓取形成网站快照，再进行相同 baseline config 的 retest。
6. 报告叙述必须包含证据化口碑与 GEO 建议；批准后系统自动排队绑定该 run 的质量检查，质量检查批准通过后自动冻结 payload/hash 并进入 PDF/Word 队列；质检未通过时重试即重新生成叙述。分享链接只存 token hash，支持过期与撤销。
7. 归因 CSV 按 `sourceType + csv` 内容 hash 防重复，和 GEO 指标并列展示，不自动声称因果。

## Web 工作台

`App.tsx` 的组件注册表只负责把服务端 `navigation_key` 映射到真实组件（含 `workbench`、`articles`），并通过 `ui/navigation.tsx` 提供跨视图跳转（证据定位、批次定位 `openBatch`、工作台预填指令）；标签、顺序和可见性来自 `/api/rbac/navigation`。切换业务视图会重新拉取项目，AI 监测页停留期间定期刷新批次列表，工作台拿到 `current_batch_id` 时立即刷新——后台创建的批次不依赖整页刷新。工作台 events 路由在原权限路径上支持最长 25 秒的长轮询并同时返回会话快照；浏览器兼容会话通过它接收模型与工具增量，桌面会话则立即显示本地 Agent 文本流，并用该路由恢复服务端工具事件、最终消息和会话状态。桌面运行时按会话动态加载并在工作台空闲时预载，单客户端可同时保留多个活动会话，不经过 Agent Worker 的双槽队列。AI 监测页内“批次记录/同配置趋势/周期监测/调用成本”用 Segmented 分面板互斥展示（Monitoring.tsx，监测任务活动条与漂移告警保持常驻）。`useAgentRunPolling` 可指定触发轮询的 run 状态（文章页把 `awaiting_approval` 也算进去），建档页在竞品核实 `pending` 期间轮询项目，报告页 PDF 前台等待超时后转入快照轮询。工作台包含业务页面、机构管理、超管机构状态和分层 RBAC 编辑器。运营列表统一分页，运行日志使用不累积全部结果的游标翻页。证据回答使用安全结构化 Markdown；报告使用单一可续跑工作流展示叙述、质检、冻结和文档状态。

图表、KPI 与平台卡只消费真实 API 响应；无批次时使用空状态，视觉 fixture 不得进入 `apps/web/public` 或正式构建。App 只做装配，组件、类型、权限、分页和反馈遵循 frontend reference。用户指定的蓝色浅色主题由 theme/Shell/styles 管理，状态用语义色，次级内容平铺。建档编辑同步以实际范围内容变化为依据，普通项目轮询不清空本地编辑。共享业务规则归所属 package/worker service。

`landing/` 是独立静态官网，部署在根路径；`landing/help/` 是公开帮助中心和同源 PDF，登录页、客户列表与工作台顶栏在新标签打开它；`apps/web` 使用 Vite base `/app/`。官网演示同步工作台菜单顺序和浅色布局，并为菜单、运行操作、设置、成员和日志提供窄屏交互；示意数据必须显式标注，不能请求业务 API、写数据库或被工作台导入。帮助截图通过独立 WebBridge 会话从线上真实界面取证，并在写入公开目录前替换客户名、域名、邮箱、输入值和长 ID；帮助页自身不得访问业务 API。

API 使用 same-origin Cookie。公开面只有登录、健康检查和带 token 的报告分享；Artifact 需要登录。运行时不按固定角色判断：`authorization_policies` 匹配 HTTP 方法和路径模板，用户有效权限来自机构上限与多角色并集，项目和 Artifact 再校验客户范围，Artifact 另需对应文件功能权限；未登记路由默认拒绝。


## 成员与 RBAC 事实源（2026-09-06）

`auth.ts` 管理账号生命周期/密码/域审计，`member-access.ts` 在事务内校验可授予权限和客户范围，`rbac.ts` 管理角色与机构上限，`0020_membership_rbac.sql` 提供稳定默认角色键与新路由。`Members.tsx`、`hooks/useMemberOptions.ts` 消费服务端可分配选项；`RbacManagement.tsx` 保留跨页角色/客户选择和被机构上限暂停的角色定义。`usePagination.ts` 拒绝过期响应并显示失败，`App.tsx` 刷新身份，`Login.tsx` 提供自己修改密码。排障先看有效权限与机构上限，不按角色显示名称推断权限。参考 `docs/rbac-demo-verification-2026-09-06.md`。

### 授权 V2 路由

- 纯权限/范围/委派算法：`packages/authorization/src/index.ts`。
- HTTP/文件/后台授权：`apps/worker/src/authorization/{index,principal,policies,resources,execution}.ts`；配置与无副作用诊断：`configuration.ts`。不要向旧 permission_routes 或复制角色 if 判断继续扩展。
- 授权管理 UI：`AuthorizationConfiguration.tsx`，由 `RbacManagement.tsx` 装配；成员管理继续在 Members。
- 契约：`0021_authorization_kernel.sql` + `schema.ts`；设计与扩展步骤：`docs/rbac-v2.md`；安全回归：`authorization-kernel.test.ts` 和纯内核测试。

### 全功能审查新增事实源

- 最终回答/实际引用/检索词：search-providers/common.ts responseSearchEvidence/outputText，ADAPTER_VERSION=cloud-search.v2。
- 旧采集合同隔离：worker/capture-contract.ts；影响 getBatch、重解析、审批与报告。
- 错误响应：worker/api-errors.ts；不要回显未知异常消息或把可恢复前置条件写为 500。
- 角色系统边界：0022_tenant_role_boundaries.sql + core/access.ts；默认角色不得包含 system_only。
- 页面按需加载：web/lazy-views.tsx + components/ViewBoundary.tsx；保持桌面/机构工作区同一注册表。
- 全功能真实验收与限制：docs/full-audit-2026-09-06.md。

## SQLite 桌面执行边界（2026-10-04）

当前桌面为 React → Tauri IPC → 本机 Node 业务引擎 → 新 SQLite 工作区。模型/搜索/采集/网站分析/指标/内容质检/报告/调度均在客户端；云端只鉴权、权限管理与账户私有快照存储。代码事实源：`apps/desktop/src/engine.ts`、`src-tauri/src/local_engine.rs`、`packages/core/src/sqlite.ts`、`apps/worker/src/api-service.ts` 和 `desktop-storage.ts`。独立指标、证据页面保留，不迁移旧数据库或业务数据。

会话/工具账本/等待状态/租约落 SQLite；MemorySaver 仅回合内使用。结果不确定的工具停止自动重放并要求成员核查。关闭客户端会停止本机执行；鉴权断网 fail-closed。哈希分块 + CAS 同步不自动合并冲突，设备主密钥不上传，新设备重配 Provider Key。桌面公开分享暂未接静态托管，会明确拒绝创建无效链接，PDF/Word 本地导出仍可用。

完整开发、恢复、测试和限制见 `docs/desktop-agent.md`。云端新部署显式使用 `compose.desktop-cloud.yaml`，不启动业务 Workers；其余服务器拓扑与 PostgreSQL 操作章节仅适用于旧版兼容部署，不代表新桌面执行位置。
