# GEO Console Project Map

完整回答辅助解读：evidence `answer-analysis.ts` → worker `answer-analysis-model.ts` / `answer-analysis.ts` → Semantic Worker 独立槽 → Web `AnswerAnalysis` / `ui/answer-analysis` / `useAnswerAnalysis`（EvidenceDetail 装配）。Core migration 0023 保存独立运行/尝试及授权，GET 不调用模型，POST 固定异步身份。与 measurement/metrics 解耦，不改正式排名。`tools/answer-analysis-eval` 是可选 Python 离线标注评测；详情见 `docs/answer-analysis.md`。

## 工具链

- Node.js `24.x`，根 `packageManager` 固定 pnpm 11；所有命令使用 `corepack pnpm`。
- Turborepo 编排 build/check-types/test；Biome 负责 TS/CSS lint 与格式。
- `scripts/check-skill-drift.mjs` 根据重大变更的任务文件推导影响面，检查对应 docs/skill reference 是否同步。
- 本机默认 PGlite；存在 `DATABASE_URL` 时切换 PostgreSQL。
- 本机对象写入 `GEO_DATA_DIR/artifacts`；`GEO_OBJECT_STORE=s3` 时使用 S3 兼容存储。

## 运行拓扑

```text
Browser -> Caddy -> static landing (/)
                 -> static help + PDF (/help/)
                 -> React Web (/app/)
                 -> API (apps/worker/src/index.ts) -> PGlite/PostgreSQL
                                                  -> local/S3 artifacts
API/Workers -> Log Service -> structured service_logs
Capture Worker -> frozen provider adapter -> raw response + QueryCapture v2
Agent Worker   -> background HRouter Agent / browser fallback -> pending structured draft -> human approval
Report Worker  -> immutable snapshot -> Playwright PDF -> artifact store
Tauri WebView  -> local Pi Agent -> controlled Responses relay + business-tool RPC -> API
```

Tauri 2 桌面客户端加载同一个工作台构建，是所有角色的正式客户端；浏览器保留同步调试。交互式工作台 Agent 在 WebView 内运行 `pi-agent-core`，每个桌面会话独立执行；模型流通过 Tauri Channel 访问服务端受控 Responses 代理，工具通过服务端 RPC 复用现有业务 service。页面导航、API 策略、会话、证据和审批仍以服务器为事实源，HRouter Key、数据库和文件不进入客户端。

本机 `corepack pnpm geo start` 启动独立 Log Service、包含四个队列执行器的组合 API 进程和 Vite Web，避免多进程 PGlite 目录争用；Log Service 使用独立本机 PGlite。服务器 PostgreSQL Compose 将 Log/API/四个 Worker/Web/Caddy 分开，只有 Caddy 暴露 80/443。

## 所有者地图

| 关注点 | 首要事实来源 | 主要消费端 |
| --- | --- | --- |
| 数据库接口、迁移执行 | `packages/core/src/database.ts`、`packages/core/migrations/` | 所有 Worker/API |
| 表、枚举、冻结配置 | `packages/core/src/schema.ts` | service、workers、tests |
| Capture 租约 | `packages/core/src/repository.ts` | `cloud-runner.ts` |
| 证据 JSON 契约 | `packages/evidence/src/schema.ts` | adapters、cloud runner、metrics、reports |
| 五平台协议 | `packages/search-providers/src/*.ts` | `apps/worker/src/providers.ts` |
| V2 语义与指标快照 | `packages/evidence/src/semantic.ts`、`apps/worker/src/measurement.ts`、`semantic-runtime.ts`、`0019_visibility_v2.sql` | Semantic Worker、证据中心审核、API、报告 |
| 指标分母与汇总 | `packages/metrics/src/visibility.ts` | batch/report UI |
| HTTP、RBAC、租户隔离、公开分享 | `apps/worker/src/index.ts`、`auth.ts`、`tenancy.ts` | `apps/web/src/api.ts` |
| 动态权限目录与分页 | `apps/worker/src/rbac.ts`、`pagination.ts`、`permissions/authorization_policies/roles` migration | API、Web/Tauri 导航与列表 |
| Web 外壳与页头导航 | `apps/web/src/components/Shell.tsx`、`Page.tsx`、`ui/navigation.tsx`（NavigationContext：`openView/openProjectList/panelViews/openEvidence/openBatch/openWorkbench`） | 全部客户工作台页面（面包屑前级返回客户列表、末级下拉切换面板） |
| 结构化运行日志 | `packages/logging`、`apps/log-service`、`service_logs` migration | API、Capture/Agent/Report Worker、Web 日志中心 |
| 行业问题知识库 | `apps/worker/src/knowledge-base.ts`、`packages/core/src/schema.ts` | onboarding、Web 知识库 |
| 配置导入导出（平台设置/知识库/监测范围） | `apps/worker/src/config-transfer.ts`、`apps/web/src/ui/transfer.tsx`、`apps/web/src/ui/scope-bundle.ts` | Settings、知识库、ScopeEditor |
| 项目、批次、诊断、整改、漂移 | `apps/worker/src/service.ts` | API、Web（整改中心任务/Agent 草稿分面板切换） |
| 官网抓取与审计 | `apps/worker/src/crawler.ts` | onboarding、audit、diagnosis、verification |
| Provider 配置与密钥 | `apps/worker/src/providers.ts`、`packages/core/src/secrets.ts` | Settings、Capture Worker |
| Agent 工具与审批 | `apps/worker/src/agent.ts`、`agent-jobs.ts` | Agent Worker、Web |
| Agent 联网搜索证据 | `apps/worker/src/web-search.ts`（HRouter `web_search` 请求/解析/落库、独立检索并行执行、`WEB_SEARCH_LIMITS` 配额与退化、按模型测试记录、竞品联网核实 `verifyCompetitors`）、`web_search_evidence` 与 `web_search_controls` migration | 工作台会话、`prompt_research/customer_profile` 草稿、建档分析、Settings、证据中心“联网搜索”分区 |
| AI 工作台会话与协调 | `apps/worker/src/workbench.ts`（工具、`propose_questions` 候选与服务端确认写入、服务端兼容回合、长轮询事件快照、协调器、计划步骤状态、快捷指令排序、工具调用 ID 与事件裁剪 `toolEventDetails`）、`desktop-agent.ts`（桌面回合租约、受控 Responses 代理、工具 RPC 与幂等结果）、`agent-jobs.ts`（浏览器兼容回合优先、双 I/O 槽位）、相关 migration | Tauri 本地 Agent、Agent Worker、Web Workbench（本地文本流 + 服务端事件恢复；联网搜索合成 SearchCard 展示检索词与来源链接） |
| 候选问题确认卡 | `apps/web/src/components/ScopeProposalCard.tsx`（可勾选/可编辑表格、竞品确认、知识库同步开关） | Workbench |
| Agent 草稿展示与审批卡 | `apps/web/src/components/AgentDraft.tsx`（按用途分节渲染、`AgentDraftCard`）、`hooks/useEvidenceIndex.ts`（批次报告索引 + 项目联网搜索索引） | Diagnosis、Remediation、Report、Onboarding |
| 优化文章 | `apps/worker/src/articles.ts`、`optimization_articles` 表、`agent.ts optimization_article` purpose | Web Articles、工作台 |
| 报告证据索引与引用 | `apps/worker/src/report.ts buildEvidenceIndex`、`report-snapshots.ts citationMarks`、`docx.ts` | Report/PDF/Word/CSV、Web EvidenceRef |
| 报告快照/PDF/Word/分享 | `apps/worker/src/report-snapshots.ts`、`report.ts`、`docx.ts` | Report Worker、Web |
| 归因 CSV | `apps/worker/src/attribution.ts` | Attribution view |
| 对象存储 | `apps/worker/src/object-store.ts` | captures、snapshots、PDF |
| 工作台 UI | `apps/web/src/`(App.tsx 外壳 + components/ 视图 + ui/primitives + hooks)、`styles.css` | browser |
| 桌面 Agent、原生流与签名更新 | `apps/web/src/desktop-agent.ts`、`apps/desktop/src-tauri`、`apps/web` 更新入口 | macOS/Windows/Linux 用户 |
| 静态官网与帮助中心 | `landing/`、`landing/help/`、`scripts/capture-help-screenshots.mjs` | browser root/help paths; no API/DB access |
| 本机 CLI | `scripts/geo.ts` | setup/start/doctor/backup |
| 本机组合 Worker | `apps/worker/src/local-workers.ts` | 仅 `GEO_LOCAL_COMBINED=true`；生产禁用 |
| 防飘逸检查 | `scripts/check-skill-drift.mjs`、`references/drift-control.md` | 重大功能变更交付 |
| 服务器发布 | `deploy/package.sh`（本地 Linux server artifact + Web dist）、`install.sh`、`geo-console`、`compose.yaml`、`docker/Dockerfile.artifacts`（本地构建）、`docker/Dockerfile`（服务器仅 ADD/COPY） | installer/management command |

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

图表、KPI 与平台卡只消费真实 API 响应；无批次时使用空状态，不能把视觉验收 fixture 放入 `apps/web/public` 或正式构建。UI 不再是单文件应用壳：`App.tsx` 只做装配，`components/` 一视图一文件，共享类型/权限/分页/反馈分别收敛在 `types.ts`、`access.tsx`、`ui/primitives.tsx`、`hooks/`;UI 控件统一走 antd 6，拆分与选用规则见 `.agents/skills/geo-development/references/frontend.md`。视觉纪律:品牌绿只用于主按钮/链接/选中态/logo,其余静态装饰一律中性灰,内容区次级分组小节平铺,不用嵌套 Tabs/Collapse。新增共享业务规则时不要继续堆入组件，应放回拥有该规则的 package/worker service。

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
