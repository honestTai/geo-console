# 架构与数据边界

## 运行组件

```text
浏览器 -> Caddy HTTPS -> /      静态官网与隔离的产品演示
                    -> /app/  React 工作台
                    -> /api/  API :3010 -> PostgreSQL
                                         -> S3 兼容证据存储
                              Log Service :3020 -> PostgreSQL service_logs
                              Capture Worker -> 五家联网 API
                              Agent Worker   -> HRouter GPT
                              Report Worker  -> Playwright PDF
```

Tauri 2 桌面客户端是所有用户的正式产品壳，正式版加载同域 `/app/`，开发版加载本机工作台；浏览器入口暂时保留同等能力用于调试。两种入口消费同一动态导航、API 权限和分页契约，不复制业务状态。桌面更新包使用 GEO 独立 minisign 密钥签名，客户端内置公钥并从 HTTPS 更新清单检查、下载和重启安装。

本机使用同一业务代码，但 PGlite 不允许多个进程争用同一目录：API 进程内组合运行 Capture/Agent/Report 队列，独立 Log Service 使用 `${GEO_DATA_DIR}/log-service` 下的单独 PGlite，Web 仍为独立 Vite 进程。生产 PostgreSQL 继续运行八个独立 Compose 服务。

- `landing`：静态官网。交互演示全部标注为演示数据，不访问业务 API、不写数据库、不作为指标或证据。
- `apps/web`：发布在 `/app/` 的客户建档、监测、证据、官网审计、诊断、整改、归因、报告和机构管理工作台。
- `apps/worker/src/index.ts`：机构会话、请求级租户作用域、RBAC、超管机构切换、项目 API、周期调度和审计日志。
- `apps/log-service`：内网结构化运行日志采集、租户查询、CSV 导出、分页与保留期清理；不接收证据正文或凭据。
- `capture-worker.ts`：按数据库租约领取 `capture` 任务，只调用冻结配置中的供应商。
- `agent-worker.ts`：领取 `agent_draft` 与 `agent_session_turn` 任务，实时保存受限工具轨迹；每 5 秒运行一次工作台协调（自动批准工作台会话产生的草稿、唤醒等待批次/Agent/报告完成的会话）。
- `report-worker.ts`：在已批准 Agent 报告叙述与质量检查后领取 `report_document` 任务，以冻结快照生成 PDF 与 Word 后写对象存储。
- `packages/search-providers`：五个平台的真实 API 协议与失败分类。
- `packages/evidence`：`QueryCapture v1/v2` 不可变证据契约。
- `packages/metrics`：品牌匹配后的确定性指标与等权平台汇总。
- `packages/core`：PGlite/PostgreSQL 共用迁移、Schema、租约、信封加密和批次可比性。
- `packages/logging`：跨进程日志类型、脱敏、批量缓冲、内部服务客户端和 Trace ID 关联。

每个用户归属一个机构。授权链路是机构权限上限 -> 机构自定义角色 -> 用户多角色权限并集 -> 全部客户或指定客户范围；历史管理员、分析师和只读字段只用于迁移默认角色，不参与运行时授权。页面导航来自 `permissions`，API 方法与路径模板来自 `permission_routes`，未登记 API 默认拒绝。系统只能有一个超管账号；超管拥有全部资源权限并可切换、授权、封禁或解封机构，但切换后业务数据仍严格限制在活动机构，机构内再按客户范围过滤。证据文件下载同样校验活动机构和客户归属，不仅依赖对象 key。

旧 `consumer_surface` 证据仍可只读查看。新批次只创建 `llm_search_api` v2 证据；两种口径不会进入同一个冻结批次或趋势比较。每个新批次冻结端点、模型、协议、搜索策略、搜索工具和适配器版本，Capture Worker 只读取该冻结契约；缺少完整契约的历史基线不能用于新复测。

## 工作台信息架构

- 项目业务菜单包括 AI 工作台、项目总览、AI 监测、证据中心、官网审计、差距诊断、整改中心、业务归因、复测报告和优化文章；侧栏按“客户工作台 / 机构管理 / 系统管理”分组，顶栏只显示客户名与域名，页面标题由页头唯一渲染。
- 机构级问题知识库、平台设置、成员、业务审计、运行日志和多租户管理在未选择客户时也可进入，避免空租户无法先配置平台。
- 菜单名称、顺序和可见性由服务端动态导航目录返回；机构未获授权的页面不会进入任何角色，用户未获授权的页面不会渲染，对应 API 同时返回 403。
- 问题知识库按机构和行业维护；新客户分析先复用同业问题，再追加 Agent 发现的新问题候选，只有成员主动添加的记录才成为后续共享知识。
- 系统超管拥有机构授权、动态角色、用户角色/客户范围和多租户状态视图；封禁机构会立即撤销其非超管会话。
- 所有运营列表使用有界服务端分页或游标分页；报告正文和固定 Provider 目录不是无限列表。
- 工作台前端按视图拆分：`App.tsx` 只做认证/项目/视图装配，`components/` 一视图一文件，共享类型、权限门控、分页与反馈原件分别收敛在 `types.ts`、`access.tsx`、`ui/primitives.tsx`、`hooks/`;UI 控件统一使用 antd 6(emerald 主题 token、zh-CN locale)，不再手写 modal/table/tab/pagination，规则见 `references/frontend.md`(geo-development skill)。装饰色收敛为品牌绿(主按钮/链接/选中态/logo)+中性灰,内容区次级分组用小节平铺。
- 平台设置用本地真实品牌 Logo 的平台导航切换五个平台，每次只渲染当前平台表单；HRouter GPT 配置保持独立。
- 桌面使用固定侧栏；390px 移动端使用可横向滚动的底部图标导航，避免菜单增加后压缩点击目标。
- 总览和监测图表只渲染 API 返回的真实、可比批次数据；没有数据时显示空状态，不内置示例客户或指标。
- AI 监测运行面板以批次状态、预期样本数和 `query_captures` 生成真实进度与采集日志；重新运行会创建实际批次，不使用前端动画伪造后台结果。
- 复测报告先显示管理摘要、核心指标和整改前后对比，再进入证据、叙述与导出等详细内容。
- 官网与工作台共用一个 Web 镜像但目录隔离：`/srv` 是官网，本地生成的 Vite dist 位于 `/srv/app`。官网“进入工作台”只导航到 `/app/`。
- 官网演示与工作台使用相同菜单顺序和浅色信息架构；官网数据仍显式标注为演示数据。演示菜单、运行操作、设置、成员与日志视图在窄屏下保持可滚动或单列操作。

## 核心流程

1. 抓取客户 Sitemap 及最多 100 个公开同域页面，拒绝私网、Loopback 和非 HTTP(S) 地址。
2. HRouter GPT 仅根据网页证据生成画像、竞品候选、主题、Persona 和购买问题；用户确认后项目才启用。
3. 快审固定每平台每题 1 次。正式基线默认 3 次并分布在 0、4、24 小时窗口。
4. 批次冻结客户、竞品、问题、平台、模型、协议、搜索策略、地区、重复次数、时间窗口和适配器版本。
5. Capture Worker 保存回答、来源、Query Fan-out 可见性、原始响应、Request ID、Token、延迟、成本可见性、内容哈希和失败码。
6. 指标由代码确定性计算；Pi Agent 逐条校验其他模型回答及其来源，并生成口碑正负信号、GEO 优化建议和报告叙述草稿。
7. 人工批准报告叙述后，系统自动排队绑定该版本的 Pi Agent 质量检查；质量检查人工批准且通过后，自动冻结快照并排队 PDF/Word。诊断、整改、内容与报告草稿都不自动发布或修改客户网站。
8. 已发布 URL 重新抓取验收。复测必须复制正式基线完整配置。
9. 只有已批准叙述与通过的质量检查才能冻结报告 payload 与 SHA-256；Report Worker 再确定性生成 PDF/Word，另提供 CSV、JSON 和可撤销分享链接。定时批次会依序创建 Agent 任务，等待人工批准后再继续冻结与导出。
10. 报告分析包含 `evidenceIndex`：每条回答/快照/审计证据按采集时间编号，正文、PDF、Word 和 CSV 用 `[n]` 引用并附带平台、问题、采样次数、时间与引用网址；口碑来源 URL 去掉供应商追踪片段；模型夹带的英文推理草稿不进入“AI 如何描述品牌”。
11. 优化文章：以已批准报告叙述的每条 GEO 建议为目标，`optimization_article` Agent 读取该建议引用的证据与官网快照生成 Markdown 草稿，物化到 `optimization_articles`（每条建议一篇，重复生成覆盖为新版本）。文章只是可编辑草稿，发布由成员完成后填写地址。

## AI 工作台

`agent_sessions` 保存一段与内置 Pi Agent 的对话：`transcript` 是 pi-agent-core 的 AgentMessage 列表，每回合用 `initialState.messages` 恢复后继续；`agent_session_events` 以递增 `seq` 记录用户消息、Agent 增量文本、工具调用、提问、等待与自动批准事件，前端按 `after=seq` 增量轮询。工作台工具只复用现有 service：`suggest_questions/apply_scope`（版本化监测范围）、`create_batch`、`run_site_audit`、`run_rule_diagnosis`、`run_agent_draft`、`advance_report`、`generate_articles`、`verify_batch`，以及只读证据工具。

会话不会阻塞 Worker：`ask_user` 与 `wait_for` 都以 `terminate` 结束当前回合并把 `waiting` 写入会话；用户回答或协调器发现批次 `complete/partial`、Agent run 终态、报告 PDF 就绪后，入队 `agent_session_turn(resume)` 续跑。`auto_approve=true` 时协调器代表会话创建者批准该会话产生的草稿，`agent_runs.approved_via='workbench'` 且审计日志带 `sessionId`；关闭自动模式则回到 `waiting_user` 等待成员在对应页面审批。文章草稿 run 由协调器以 `auto_article` 直接物化，不需要人工审批。运行 20 分钟以上且无待处理任务的会话会被置为 failed。

## 不变量

### 原始证据不可变

`query_captures` 及 `raw_artifact_key` 指向的对象只新增不覆盖。解析变化时重算派生数据；不修改回答、来源或失败状态。S3 桶应开启版本控制和服务端加密。

### 失败不拉低品牌率

品牌提及、首位推荐和声量只在有回答的平台内计算。总览等权汇总有效平台，并同时显示有效平台数、数据覆盖率和失败率。来源不可见时引用率为 `null`，不是 0。

### 可比性严格

复测只能选择 `baseline`。项目范围或平台配置变化会建立新基线。快审、正式基线和复测永不直接比较。

### Agent 最小权限

Pi SDK 没有 Bash、任意文件、任意 SQL 或开放 HTTP 工具。网页和回答被标记为不可信内容。草稿中的证据 ID、问题 ID 和任务 ID必须属于当前项目；未知 ID 拒绝入库。

报告口碑信号必须来自 AI 搜索回答中实际出现的评价。`cited` 信号的 URL 必须属于引用的回答证据；平台未开放来源时只能标为 `unavailable`，不能补造 URL。质量检查绑定最新已批准叙述的 run ID，未通过时禁止生成正式文档。

### 口径透明

DeepSeek、Kimi、豆包和通义是官方联网 API 结果。元宝平台固定显示“元宝搜索源 + 混元合成”。任何 API 结果都不冒充消费端 App。

## 安全边界

- 服务器仅暴露 Caddy 80/443；API、Worker 与 PostgreSQL 留在 Compose 网络。Windows/macOS/Linux 发布机使用本地 Docker Buildx 生成目标 Linux 的 `server-runtime.tar`（服务端 node_modules、源码、migration）和 Web dist；生产 `.env`/Secret 不进入 bundle。服务器保留含 Node、Playwright Chromium、中文字体和系统库的固定 Worker base，每次 release 的 Dockerfile 只用 `FROM` + `ADD/COPY` 重构 Worker/Web 镜像，不执行 pnpm、apt、Playwright 下载、Web build 或远程 pull。
- Web/Tauri 会话由 HttpOnly、SameSite=Strict Cookie 保护；所有资源入口执行活动机构和客户范围校验。系统超管是数据库唯一的显式布尔权限，不属于任何机构角色。
- 供应商与 HRouter Key 使用包含机构 ID 的 AES-256-GCM AAD 信封加密；环境变量 Key 只作为默认机构的引导配置，其他机构必须保存独立密钥。
- 分享链接仅存哈希，可设置过期并撤销。
- 所有写 API、Agent 审批和成员变更进入审计日志。
- API、Capture、Agent 和 Report 通过内部令牌向 Log Service 批量发送结构化运行日志。敏感键、Bearer/API token、回答正文、网页正文和原始响应均在客户端与服务端双重脱敏。
- `audit_logs` 是业务审计；`service_logs` 是可按机构和保留期清理的运行数据。运行日志清理不得触碰审计、Capture、网页、原始响应或报告证据。
