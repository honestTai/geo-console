# GEO Console Web 前端架构规则

通用等待统一使用 `ui/BrandLoading`，不新增纯“加载中”占位：完整字标用于启动/懒加载/内容占位，BrandLoadingMark 经 ThemeProvider 的 spin/button/select 配置用于紧凑指示器。自定义 Spin indicator 必须接收 className/style 并消费 percent，不能把 SVG 或字标强塞进错误尺寸。Page 的300ms延迟与已挂载内容保留；失败、权限和实际业务进度不能被无限动画覆盖；支持 prefers-reduced-motion。详见 docs/ui-refinement.md。

2026-09 用户指定全工作台复刻 GEOFlow 的视觉布局：256px 白色侧栏、64px 顶栏、48px 桌面内容留白、30px 页面标题、40px 主操作，列表/表单/空态/统计使用同一细灰边框与 8px 圆角规范。继续使用 React/antd 独立实现。任务页由 `TaskManagementLayout` 排列主列表、已完成折叠行、四项统计与三栏运行信息。导航业务组保持监测/内容/交付；客户与页面切换移到 Shell 顶栏，Page 只展示唯一 H1。详见 `docs/content-operations.md`。

客户封档使用 `ProjectReadOnlyContext`，权限按钮和 usePermission 在项目视图禁用写动作；筛选、展开、查看和下载保持可用，机构管理不继承项目只读。App 不把 archived 项目导回建档页。CustomerManagement 的独立权限菜单打开 ProjectLifecycleDialog，删除需两步确认并输入全名；成功后刷新列表，失败保留弹窗。

Page.css 为 Alert 与前后内容保留 16px 间距；不要让提示与表格共用一条边。Pagination 不同时调用页码和页大小回调，少量记录隐藏页码条，页码区需上下内边距。文章抽屉的两列均 min-width:0，引用芯片与长问题受列宽约束。文案写具体状态或动作，删掉反复的“真实”“不会伪造”等自我说明，费用/范围/失败语义需准确保留。见 `docs/ui-refinement.md`。

调用成本与官网审计的重复卡片间距为24px，子项 min-width:0，网格最小列宽不能小于子卡片的最小宽度。审计卡最多两列，窄内容区改单列；报告检查与长来源域名按容器宽度换行。私有布局分别归 Monitoring.css、WebsiteAudit.css、Report.css；不要在全局重复覆盖这些卡片规则。

文章 `PublicationPlanView/Fields` 增加内容形式、选择理由和篇幅依据；自由文本，不做固定文章类型下拉或字数目标。新生成由实际问题/证据/渠道决定，短答允许无大纲；旧计划缺 `contentStrategy` 明确提示，不自动补模板。编辑中不完整的计划也应可预览，保存时校验必填项。见 `docs/reader-report-workflow.md`。

客户解释优先：复用 `MetricLabel` 可键盘操作的释义，监测/报告 `MeasurementExplanation` 展示实际分母、纳入原因与原文入口。不暴露内部状态或把缺失当 0。EvidenceRef 即使不在当前索引也按全局元数据定位真实历史证据，缺失/权限不足明确提示。文章 PublicationPlan 展示/编辑用途、读者、平台/栏目、依据类别和验收；推荐渠道不是已发布。见 `docs/reader-report-workflow.md`。

官网/任务状态补充：官网字段选填；客户概览和未建档页可编辑资料，无官网审计展示不适用及补充入口，不显示 0 分。Monitoring 分开已存证、已结束任务、等待窗口、额度阻断与语义解析覆盖。WebsiteAudit 每个检查项可开证据 Drawer，展示冻结客户、定位/建议/验收、截图预览、源文和探测状态；旧记录缺失截图要直说。全局 WebsiteEvidenceViewer 按项目/证据 ID 读取历史快照，不借用最新审计替换旧引用。下载有真实 artifact 权限，抽屉在桌面界面检查无溢出。见 `docs/website-audit-and-capture-recovery.md`。

完整回答语义解读由 EvidenceDetail 装配 AnswerAnalysis，结构化视图在 `ui/answer-analysis.tsx`、按需读取/串行轮询在 `hooks/useAnswerAnalysis.ts`。切换回答必须取消旧请求并重置状态；只读不生成，生成按钮权限 `agent.run`，重生成需确认。分段/品牌/条件分节平铺，不 dump JSON；原文 Drawer 用转义文本和服务端验证的 UTF-16 高亮。明确区分 ready（未人工复核）/needs_review/failed/历史只读；导出是主动下载客户证据，不可放公开目录。

适用于 `apps/web/`(React 19 + Vite 8 + antd 6)。这是 2026-09 UI 精修后确立的结构,后续前端改动必须遵守。

## 目录结构与拆分规则

```text
apps/web/src/
  App.tsx            # 应用外壳:认证、项目选择与切换;只装配,不写业务 UI
  ui/workspace-views.ts # 页面/图标/项目页权限注册;服务端仍决定导航与可访问范围
  main.tsx           # StrictMode + ThemeProvider 入口
  theme.tsx          # antd ConfigProvider 主题 token + zhCN locale + <AntdApp>(message/modal 上下文)
  api.ts             # fetch 封装与 ApiError
  types.ts           # 共享领域类型、Provider 常量、共享格式化小函数
  access.tsx         # AccessContext、usePermission、权限门控 Button、useAgentRunPolling、useBatch
  hooks/             # 跨视图数据 hooks(usePagination 等)
  ui/primitives.tsx  # 共享展示件:Pagination(antd 封装)、Empty、BatchPicker、percentage/date 等
  components/        # 一视图一文件;跨视图共享组件(EditableList 等)也放这里
  components/*.css   # 视图私有样式,与组件同目录同 import
```

- App.tsx 保持薄壳(<500 行)。新增视图 = 新建 `components/<Name>.tsx` + 在 `ui/workspace-views.ts` 登记 + 服务端权限目录加 navigation_key，重视图从 `lazy-views.tsx` 按需加载；不得把业务视图写回 App.tsx。
- 共享物只能向上沉淀:components 之间不互相 import;两个视图都要用的组件先证明复用价值,再提升为 `components/` 下的共享件(如 EditableList),通用类型/常量进 `types.ts`,数据请求模式进 `hooks/`,展示原件进 `ui/primitives.tsx`。
- 拆分是自顶向下的,不是提前抽象:三行相似代码保留重复胜过过早组件化;但整段重复的可编辑列表、审批卡、KPI 卡这类**结构性重复**必须提取。

## UI 框架与组件选用

- 统一使用 antd 6 组件:表格 `Table`、弹窗 `Modal`、页面级导航 `Tabs`、表单 `Form/Input/Select/DatePicker/Switch`、反馈 `Alert/Tag/Progress/Statistic/Descriptions`。不再手写 modal-backdrop、tablist、table、进度条。`Tabs` 只用于页面级导航(如 RBAC、设置页平台);内容区内的次级分组用普通小节(h3+细分隔线)平铺,不用嵌套 `Tabs`/`Collapse`。
- 分页只能用 `ui/primitives.tsx` 的 `Pagination`(antd Pagination 封装)。游标翻页(如 ServiceLogs)无法套用页码分页时,在 Table footer 自绘,但视觉沿用同一套 antd 控件。
- 操作成功/失败用 `App.useApp()` 的 `message`;持续性错误用 `Alert`。禁止用错误字符串前缀判断成败、禁止 `JSON.stringify` dump 草稿到页面——结构化数据用 `Descriptions`/`Collapse` 展示。
- 权限门控动作必须用 `access.tsx` 的 `Button`(permission prop),不得换成 antd Button 丢掉权限检查;无权限语义的纯交互按钮用 antd Button。

## 信息密度与操作

- 首屏只放主操作与关键数据;次要内容进 `Popover` 或后置小节;长文本转要点;能图标+title 的不堆文字。一个视图的信息量以"无需滚动即可理解当前状态"为准。
- 危险操作二次确认(antd `Popconfirm` 或 Modal 确认);删除/封禁等必须保留权限门控。

## 样式

- 优先 antd 默认样式;确需自定义时写视图私有 `<Name>.css`,不要改 `styles.css` 全局区。
- `styles.css` 只保留设计变量(`:root`)、基础布局壳和仍存活的通用类;圆角用 `--radius-s/radius/radius-l`,断点只有 `max-width: 900px` 和 `600px` 两档,颜色尽量走变量。
- 类名 kebab-case;视图私有类用短前缀(如 `ed-`、`.service-log-`)避免跨视图撞名。
- 色彩纪律:主操作/链接使用蓝色 `--brand`(#2563eb)，选中态用浅蓝底；白色侧栏、浅灰背景和中性边框。状态使用 antd 的 success/error/warning/processing/default 语义色，非状态装饰保持中性。不使用大片深色背景，不把未配置/未知指标当作零。

## 验证

改前端后跑 `corepack pnpm --filter @geo/web check-types && corepack pnpm --filter @geo/web test && corepack pnpm --filter @geo/web build` 及 biome check；默认只检查桌面界面无重叠截断，手机端检查仅在用户明确要求时进行；桌面与 Tauri 客户端加载同一份构建产物。涉及桌面 Agent 时还要验证运行时独立 chunk、Tauri Channel 首字节流、断线后的 transcript/toolResult 恢复，以及浏览器入口不会创建 desktop 会话。

## 2026-09 布局重做后的约定

- 页面标题只由 `components/Page.tsx` 渲染唯一 H1：标题、可选描述、右侧主操作。Shell 顶栏提供客户切换与当前页面下拉，不重复页面大标题。
- 侧栏菜单按服务端 `group_label` 分组（客户工作台 / 机构管理 / 系统管理）；<900px 改为抽屉。
- 间距只用 `--space-1..8`（4/8/12/16/20/24/32/48）；内容区最大宽 `--content-max`。
- 按钮统一走 `access.tsx Button`（antd Button 封装：primary/secondary/ghost/danger/link + `permission` + `busy`），不再有 `.button` 自定义样式；仅在 antd 组件内部（Dropdown 触发器、Modal footer）直接用 antd Button。
- 共享原语（`ui/primitives.tsx`）：`SectionTitle`（页内分组，替代嵌套卡片/Collapse）、`FilterBar`（搜索/筛选一行，禁止把输入框套在卡片里）、`KpiGrid/KpiCard`、`IdChip`（短 ID + 复制，任何 UUID/hash 都不得裸露）、`EvidenceRef`（证据引用 `[n] 平台 · 问题`，可跳转证据中心）、`BatchPicker`（antd Select）、`shortDate`。
- 分页统一使用 `Pagination` 原语，放在列表底部，总数在左、页码在右。
- 表单：表单字段用 `Form layout="vertical"` + 网格类（如 `.settings-grid`、`.knowledge-form-grid`），不用 `layout="inline"` 堆一行；避免 inline `style={{ width }}`，宽度写在视图 CSS。
- 原生 `input/select/textarea` 的全局边框只作用于非 antd 控件（`styles.css` 用 `:not([class*="ant-"])` 与祖先排除），避免双边框。
- 状态与失败码要翻译成中文（批次 `batchStatusLabel`、采集 `captureLogMessage`、文章/会话状态映射），界面不出现英文枚举值。
- Agent 草稿一律通过 `components/AgentDraft.tsx` 渲染：`AgentDraftCard` 是差距诊断/整改中心/建档页共用的审批卡（首屏 = 摘要 + 概览标签 + 查看草稿详情 + 批准/拒绝），`AgentDraftContent` 按 purpose 分节（含 `prompt_research` 候选问题列表）；新增 purpose 时在该文件加分支和 `draftFieldLabels` 中文字段名，不在视图里重新 `Object.entries(draft)`。证据 ID 用 `EvidenceRef`（索引来自 `hooks/useEvidenceIndex(batchId, projectId)`：批次报告索引 + 项目内成功的联网搜索），任务 ID 显示任务标题，其余 ID 用 `IdChip`。
- `EvidenceRef` 的 `onOpen(id, kind)` 带证据种类；`navigation.openEvidence(id, batchId, kind)` 对 `web_search` 切到证据中心“联网搜索”分区并只显示该条记录，回答证据仍按批次定位。联网搜索引用显示为 `[联网] 检索问题`，不占报告编号。
- Shell 的客户按钮调用既有 onSwitchProject，页面下拉只列服务端授权的 navigation；Page 不再占一行面包屑。原 navigation.openView/openEvidence/openBatch/openWorkbench 的定位行为继续保留。
- 工作台使用 `workspace-wide` 专用 1600px 上限，桌面三栏为会话/对话/执行进度；900px 下会话改成横向列表且进度栏移到对话下方，600px 下头部设置、输入区和操作按钮单列或弹性重排。工作台候选问题走 `components/ScopeProposalCard.tsx`（`proposal` 事件 → 可勾选、可编辑的 antd `Table`：问题/意图/主题/角色 + 来源标签与证据引用，竞品小表，知识库同步开关只对 `knowledge.manage` 显示）；列显隐按候选卡自身的实际宽度分紧凑/常规/完整三档，紧凑档把问题元数据和竞品字段收进主单元格，不以整个窗口宽度猜测中栏空间，也不保留整表横向滚动。确认调用 `POST …/answer` 带 `questions/competitors/syncLibrary`，不采用时必须填原因。不要再用 `ask_user` 的 options 罗列问题。
- 会话设置除模型/思考强度/自动批准外还有“联网搜索”开关；模型下拉按 `/api/settings/hrouter/web-search-status` 标注“联网未验证/联网测试失败”，并提供“测试此模型”（`workbench.run`）。
- 工作台对话流里的 `web_search` 工具不走通用的 `.wb-tool` 一行胶囊，而是 `SearchCard`：连续几次搜索（中间没有别的气泡）合成一张卡，逐条显示检索问题（`tool_start.args.query`）、Agent 声明的目的（`args.purpose`）、模型实际发出的检索词、来源超链接（`cleanSourceUrl` + `sourceHost`，默认 5 条可展开）和可跳转证据中心的“证据 xxxxxxxx”芯片；失败/联网不可用按失败样式显示原因。并行搜索事件必须按 `toolCallId` 配对，不能按工具名猜测完成顺序；`tool_update` 显示搜索/保存证据阶段。服务端 `tool_end.payload.details` 对 `web_search` 用 `toolEventDetails` 按字段保留 `evidenceId/query/searchQueries/sources/remaining/unavailable/reason/phase`（不含归纳全文），其他工具超过 1500 字仍整体截成 `{truncated,preview}`。前端通过原 events 路由的有界长轮询接收带会话快照的增量，收到后立即续订；不要退回固定 1.5 秒定时刷新。
- 项目级数据（批次、任务、诊断）不是打开客户时的一次性快照：需要跨视图定位时走 `ui/navigation.tsx`（`openEvidence`/`openBatch`/`openWorkbench`）并在目标视图消费焦点；后台任务会创建数据的页面要自行安排列表刷新，不能只轮询当前选中项。
- `access.tsx useAgentRunPolling(runs, reload, activeStatuses?)` 默认只在 `queued/running` 轮询；由协调器在后台物化的用途（优化文章）传 `["queued","running","awaiting_approval"]`，否则页面会停在“正在生成”。建档页在任一竞品 `verification.status==='pending'`（`isCompetitorVerificationPending`，10 分钟内）时每 3 秒刷新项目。
- 前台等待有上限的操作（报告 PDF/Word 两分钟）超时后不能报成失败：改成 info 提示并把 `workflowState` 置为 `documents_queued` 让快照轮询接手；真正失败只以服务端 `status='failed'` 为准。
- 整改中心使用 TaskManagementLayout：创建/规划弹窗选择已完成批次，主体分页展示未完成任务，已完成任务单独折叠分页，点击任务在抽屉中编辑和验收；Agent 草稿仍用原审批组件。下方四项任务统计来自全部 project.tasks，运行信息只描述当前页 Agent 记录，不能冒充 Worker 心跳或全局队列。已有删除契约没有回收站，因此折叠行不展示垃圾箱或虚构恢复能力。验收方式与只读授权保持原规则。
- 报告页质检未通过（`workflowState==='quality_blocked'` 或最新绑定当前叙述的质检 verdict 为 blocked）时主按钮改为“质检未通过 · 重新生成叙述”，步骤条质检项标 `error`。
- 公开帮助中心位于 `landing/help/`，不作为动态 RBAC 页面注册：登录页、客户列表和工作台顶栏都以新标签打开 `/help/`，无须业务会话即可阅读。帮助正文按当前页面与按钮事实源维护，可搜索、可打印，并与随 release 发布的 PDF 同源；截图只能由独立浏览器会话生成，公开前替换客户名、域名、邮箱、输入值和长 ID，帮助页面不得调用 `/api`、`/artifacts` 或读取业务状态。


## 成员与授权编辑补充

成员角色/客户候选来自 `/api/users/options` 的服务端可分配范围，支持搜索和继续加载，不能拿第一页第一个角色当默认授权。默认只读角色按 system_key 识别，新建客户范围默认空。Member 表单、重置密码和自己改密表单使用不同 Form name，避免重复 input id 与标签关联。只读成员只看列表；业务错误与候选加载错误分开，429/403/409 不当作成功。

角色编辑跨页保留勾选，客户 Table 配置 `preserveSelectedRowKeys`；分页不重置未保存的机构授权。通用分页在卸载/查询条件变化时失效旧请求并将失败交给界面，不允许分页 Promise 拒绝无人处理。撤权后 App 定期刷新身份并清除不再可见的项目；新建客户先刷新自己的范围再进入客户页。

### 授权引擎管理界面

`RbacManagement` → `AuthorizationConfiguration` 是超管权限目录、策略分页/搜索/编辑和只读授权诊断入口。策略编辑必须提交 version，409 要刷新再编辑；资源绑定不可变不能只在 UI 禁用而漏服务端校验。新权限不自动赋予机构/角色；OR 与 AND 分开展示，页面父子关系读 parent_key。界面不推测最终 API 授权，解释器必须调用后端同一规则。背景标签/减少动态效果下弹窗关闭不能依赖动画结束事件。

### 按需加载与异常恢复

App 与 Management 共用 lazy-views；功能组件放在 ViewBoundary 下，导航壳保持可用，不自动无限刷新失败 chunk。客户卡片提供 role/button、焦点和 Enter/Space 操作。旧采集合同用 capture_contract_changed 明确只读，不以旧分数冒充新协议。API 输入错误展示简明说明与 requestId；404 asset 不能回退为 index.html。
