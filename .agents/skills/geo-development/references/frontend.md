# GEO Console Web 前端架构规则

适用于 `apps/web/`(React 19 + Vite 8 + antd 6)。这是 2026-09 UI 精修后确立的结构,后续前端改动必须遵守。

## 目录结构与拆分规则

```text
apps/web/src/
  App.tsx            # 应用外壳:认证、项目选择、视图注册与切换;只装配,不写业务 UI
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

- App.tsx 保持薄壳(<500 行)。新增视图 = 新建 `components/<Name>.tsx` + 在 `App.tsx` 视图注册表登记 + 服务端权限目录加 navigation_key;不得把视图写回 App.tsx。
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
- 色彩纪律:品牌绿(#16a34a 系)只用于主操作按钮、链接、当前选中态(菜单/tab)和品牌 logo;其余静态装饰(标签、卡片、边框、图标底色、状态 pill、静态进度条)一律中性灰(`--surface-2` 底 + `--ink-2/3` 字 + `--line` 边)。状态 `Tag` 一律 `color="default"`,确需区分成败只用 `success`/`default` 二值;功能性反馈(`Alert`/`message`/`Popconfirm`、表单校验)保持 antd 语义色,失败状态可用柔和红字但不铺红底。深色块只允许出现在左侧栏和顶栏。

## 验证

改前端后跑 `pnpm --filter @geo/web check-types && pnpm --filter @geo/web test && pnpm --filter @geo/web build` 及 biome check;窄屏(900px、600px、390px)与桌面端都要检查无重叠截断;桌面与 Tauri 客户端加载同一份构建产物。

## 2026-09 布局重做后的约定

- 页面标题只由 `components/Page.tsx` 渲染一次：面包屑 `客户 / 页面`、标题、一句描述、右侧主操作；`Shell.tsx` 顶栏只显示客户名、域名 Tag 和当前页面名，不再放 `<h1>`。
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
- 工作台候选问题走 `components/ScopeProposalCard.tsx`（`proposal` 事件 → 可勾选、可编辑的 antd `Table`：问题/意图/主题/角色 + 来源标签与证据引用，竞品小表，知识库同步开关只对 `knowledge.manage` 显示），确认调用 `POST …/answer` 带 `questions/competitors/syncLibrary`，不采用时必须填原因。不要再用 `ask_user` 的 options 罗列问题。
- 会话设置除模型/思考强度/自动批准外还有“联网搜索”开关；模型下拉按 `/api/settings/hrouter/web-search-status` 标注“联网未验证/联网测试失败”，并提供“测试此模型”（`workbench.run`）。
- 工作台对话流里的 `web_search` 工具不走通用的 `.wb-tool` 一行胶囊，而是 `SearchCard`：连续几次搜索（中间没有别的气泡）合成一张卡，逐条显示检索问题（`tool_start.args.query`）、Agent 声明的目的（`args.purpose`）、模型实际发出的检索词、来源超链接（`cleanSourceUrl` + `sourceHost`，默认 5 条可展开）和可跳转证据中心的“证据 xxxxxxxx”芯片；失败/联网不可用按失败样式显示原因。服务端 `tool_end.payload.details` 对 `web_search` 用 `toolEventDetails` 按字段保留 `evidenceId/query/searchQueries/sources/remaining/unavailable/reason`（不含归纳全文），其他工具超过 1500 字仍整体截成 `{truncated,preview}`。
- 项目级数据（批次、任务、诊断）不是打开客户时的一次性快照：需要跨视图定位时走 `ui/navigation.tsx`（`openEvidence`/`openBatch`/`openWorkbench`）并在目标视图消费焦点；后台任务会创建数据的页面要自行安排列表刷新，不能只轮询当前选中项。
- `access.tsx useAgentRunPolling(runs, reload, activeStatuses?)` 默认只在 `queued/running` 轮询；由协调器在后台物化的用途（优化文章）传 `["queued","running","awaiting_approval"]`，否则页面会停在“正在生成”。建档页在任一竞品 `verification.status==='pending'`（`isCompetitorVerificationPending`，10 分钟内）时每 3 秒刷新项目。
- 前台等待有上限的操作（报告 PDF/Word 两分钟）超时后不能报成失败：改成 info 提示并把 `workflowState` 置为 `documents_queued` 让快照轮询接手；真正失败只以服务端 `status='failed'` 为准。
- 整改中心的“规划草稿/建任务”按钮作用于头部 Select 选中的已完成批次（默认最近完成的一条），不再固定指向 `project.batches[0]`；任务卡按服务端 `task.verification_mode` 渲染“重跑审计验收”或“抓取验收”（后者需要发布地址），验收按钮带 `busy`；状态下拉里的“已验收”只用于显示（`disabled`）。
- 报告页质检未通过（`workflowState==='quality_blocked'` 或最新绑定当前叙述的质检 verdict 为 blocked）时主按钮改为“质检未通过 · 重新生成叙述”，步骤条质检项标 `error`。
- 公开帮助中心位于 `landing/help/`，不作为动态 RBAC 页面注册：登录页、客户列表和工作台顶栏都以新标签打开 `/help/`，无须业务会话即可阅读。帮助正文按当前页面与按钮事实源维护，可搜索、可打印，并与随 release 发布的 PDF 同源；截图只能由独立浏览器会话生成，公开前替换客户名、域名、邮箱、输入值和长 ID，帮助页面不得调用 `/api`、`/artifacts` 或读取业务状态。
