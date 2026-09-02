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
