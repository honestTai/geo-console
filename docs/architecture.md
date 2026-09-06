# 架构与数据边界

## 运行组件

```text
浏览器 -> Caddy HTTPS -> /      静态官网与隔离的产品演示
                    -> /help/  公开操作手册、脱敏截图与同源 PDF
                    -> /app/  React 工作台
                    -> /api/  API :3010 -> PostgreSQL
                                         -> S3 兼容证据存储
                              Log Service :3020 -> PostgreSQL service_logs
                              Capture Worker -> 五家联网 API
                              Semantic Worker -> 严格原子语义 -> MetricSnapshot V2
桌面 Tauri -> 本地 Pi Agent -> API 受控 Responses 代理 -> HRouter GPT
                         \-> API 业务工具 RPC -> PostgreSQL / Workers
                              Agent Worker   -> 后台草稿、定时报告、浏览器调试回合
                              Report Worker  -> Playwright PDF
```

Tauri 2 桌面客户端是所有用户的正式产品：正式版嵌入 Web 构建，开发版加载本机工作台，并在 WebView 内运行 `pi-agent-core` 交互 Agent。模型请求通过 Tauri Channel 或开发期同源 fetch 流式调用服务端受控 Responses 代理；服务端覆盖模型、系统提示、工具白名单、缓存键和租户范围，HRouter Key 不进入客户端。浏览器入口保留服务端 Agent 作为同步调试兼容。两种入口消费同一动态导航、API 权限、业务数据和分页契约；桌面只保存非敏感 client id，会话 transcript、证据、审批和业务状态仍在服务器。桌面更新包使用 GEO 独立 minisign 密钥签名，客户端内置公钥并从 HTTPS 更新清单检查、下载和重启安装。

本机使用同一业务代码，但 PGlite 不允许多个进程争用同一目录：API 进程内组合运行 Capture/Agent/Report 队列，独立 Log Service 使用 `${GEO_DATA_DIR}/log-service` 下的单独 PGlite，Web 仍为独立 Vite 进程。生产 PostgreSQL 继续运行八个独立 Compose 服务。

- `landing`：静态官网及 `/help/` 操作手册。交互演示与帮助截图全部标注为演示/脱敏数据，不访问业务 API、不写数据库、不作为指标或证据；帮助页和随 release 发布的 A4 PDF 使用同一份 HTML 内容，截图可由 `scripts/capture-help-screenshots.mjs` 在独立 WebBridge 会话中重新取证。
- `apps/web`：发布在 `/app/` 的客户建档、监测、证据、官网审计、诊断、整改、归因、报告和机构管理工作台。
- `apps/worker/src/index.ts`：机构会话、请求级租户作用域、RBAC、超管机构切换、项目 API、周期调度和审计日志。
- `apps/log-service`：内网结构化运行日志采集、租户查询、CSV 导出、分页与保留期清理；不接收证据正文或凭据。
- `capture-worker.ts`：按数据库租约领取 `capture` 任务，只调用冻结配置中的供应商；执行抛错走 `failJob`（重排或失败并刷新批次），每分钟清扫租约过期且重试用尽的任务。
- `agent-worker.ts`：执行后台 `agent_draft`、定时报告所需草稿和浏览器调试会话的 `agent_session_turn`；桌面 `execution_target='desktop'` 会话不会进入该队列。每 5 秒运行一次工作台协调：自动批准工作台产生的草稿、检查等待批次/Agent/报告；桌面会话只登记待客户端领取的续跑回合，浏览器兼容会话才重新入队。
- `report-worker.ts`：在已批准 Agent 报告叙述与质量检查后领取 `report_document` 任务，以冻结快照生成 PDF 与 Word 后写对象存储。
- `packages/search-providers`：五个平台的真实 API 协议与失败分类。
- `packages/evidence`：`QueryCapture v1/v2` 不可变证据契约。
- `packages/metrics`：品牌匹配后的确定性指标与等权平台汇总。
- `packages/core`：PGlite/PostgreSQL 共用迁移、Schema、租约、信封加密和批次可比性。
- `packages/logging`：跨进程日志类型、脱敏、批量缓冲、内部服务客户端和 Trace ID 关联。

每个用户归属一个机构。授权链路是机构权限上限 -> 机构自定义角色 -> 用户多角色权限并集 -> 全部客户或指定客户范围；历史管理员、分析师和只读字段只用于迁移默认角色，不参与运行时授权。页面导航来自 `permissions`，API、文件、后台动作和逐工具策略来自 `authorization_policies`（`permission_routes` 仅用于迁移），未登记 API 默认拒绝。系统只能有一个超管账号；超管可绕过角色权限条件并可切换、授权、封禁或解封机构，但不能绕过停用策略和封禁业务机构，但切换后业务数据仍严格限制在活动机构，机构内再按客户范围过滤。证据文件下载同样校验文件类型功能权限、活动机构和客户归属，不仅依赖对象 key。

旧 `consumer_surface` 证据仍可只读查看。新批次只创建 `llm_search_api` v2 证据；两种口径不会进入同一个冻结批次或趋势比较。每个新批次冻结端点、模型、协议、搜索策略、搜索工具和适配器版本，Capture Worker 只读取该冻结契约；缺少完整契约的历史基线不能用于新复测。

## 工作台信息架构

- 项目业务菜单包括 AI 工作台、项目总览、AI 监测、证据中心、官网审计、差距诊断、整改中心、业务归因、复测报告和优化文章；侧栏按“客户工作台 / 机构管理 / 系统管理”分组，顶栏只显示客户名与域名，页面标题由页头唯一渲染。页头面包屑是真实导航：前级客户名点击返回客户列表，末级当前面板带下拉可直接切换同客户其他面板（数据来自 NavigationContext 的 `panelViews`）。
- 机构级问题知识库、平台设置、成员、业务审计、运行日志和多租户管理在未选择客户时也可进入，避免空租户无法先配置平台。
- 菜单名称、顺序和可见性由服务端动态导航目录返回；机构未获授权的页面不会进入任何角色，用户未获授权的页面不会渲染，对应 API 同时返回 403。
- 问题知识库按机构和行业维护；新客户分析先复用同业问题，再追加 Agent 发现的新问题候选，只有成员主动添加或在确认监测范围时勾选“同步写入行业知识库”的记录才成为后续共享知识。
- 系统超管拥有机构授权、动态角色、用户角色/客户范围和多租户状态视图；封禁机构会立即撤销其非超管会话。
- 所有运营列表使用有界服务端分页或游标分页；报告正文和固定 Provider 目录不是无限列表。
- 工作台前端按视图拆分：`App.tsx` 只做认证/项目/视图装配，`components/` 一视图一文件，共享类型、权限门控、分页与反馈原件分别收敛在 `types.ts`、`access.tsx`、`ui/primitives.tsx`、`hooks/`;UI 控件统一使用 antd 6(emerald 主题 token、zh-CN locale)，不再手写 modal/table/tab/pagination，规则见 `references/frontend.md`(geo-development skill)。装饰色收敛为品牌绿(主按钮/链接/选中态/logo)+中性灰,内容区次级分组用小节平铺。
- 登录页、客户列表和工作台顶栏提供帮助入口，在新标签打开公开 `/help/`。帮助中心按所有已实现页面维护逐按钮说明、禁用条件、证据/审批边界和排障；公开截图必须先替换客户、域名、邮箱、输入值和长 ID，不得携带线上凭据或客户内容。
- 平台设置用本地真实品牌 Logo 的平台导航切换五个平台，每次只渲染当前平台表单；HRouter GPT 配置保持独立。
- 桌面使用固定侧栏；390px 移动端使用可横向滚动的底部图标导航，避免菜单增加后压缩点击目标。
- 总览和监测图表只渲染 API 返回的真实、可比批次数据；没有数据时显示空状态，不内置示例客户或指标。
- 项目数据不是打开客户时的一次性快照：切换业务视图会重新拉取项目，AI 监测页在停留期间定期刷新批次列表并在批次详情状态与列表不一致时同步；工作台会话拿到 `current_batch_id` 时立即刷新，“查看批次”通过 `openBatch` 跳转并选中该批次。Agent、周期监测或其他成员创建的批次因此无需整页刷新即可出现。AI 监测页内“批次记录/同配置趋势/周期监测/调用成本”分面板互斥展示（Segmented 带计数），监测任务活动条与待处理漂移告警在面板外常驻。
- Agent 草稿（诊断、整改规划、内容简报、报告叙述、质检、文章）统一由 `components/AgentDraft.tsx` 按用途分节渲染：首屏只放结论摘要与概览标签（大纲/事实缺口/证据条数），完整草稿收进“查看草稿详情”；证据 ID 显示为 `EvidenceRef` 引用、任务 ID 显示为任务标题、其余 ID 走 `IdChip`，不再按 JSON 键名平铺英文字段或裸 UUID。整改中心内“整改任务 / Agent 草稿”用 Segmented 分面板互斥展示并带计数，有待审批草稿时默认停在草稿面板。
- AI 监测运行面板以批次状态、预期样本数和 `query_captures` 生成真实进度与采集日志；重新运行会创建实际批次，不使用前端动画伪造后台结果。
- 复测报告先显示管理摘要、核心指标和整改前后对比，再进入证据、叙述与导出等详细内容。
- 官网与工作台共用一个 Web 镜像但目录隔离：`/srv` 是官网，本地生成的 Vite dist 位于 `/srv/app`。官网“进入工作台”只导航到 `/app/`。
- 官网演示与工作台使用相同菜单顺序和浅色信息架构；官网数据仍显式标注为演示数据。演示菜单、运行操作、设置、成员与日志视图在窄屏下保持可滚动或单列操作。

## 核心流程

1. 抓取客户 Sitemap 及最多 40 个公开同域页面（首页先抓，其余 4 路并发），拒绝私网、Loopback 和非 HTTP(S) 地址；24 小时内已有快照的项目重试建档时直接复用快照，不重新抓取。
2. HRouter GPT 仅根据网页证据生成画像、竞品候选、主题、Persona 和购买问题；无效、与客户相同或重复的候选域名在写库前过滤；竞品候选以 `pending` 落库并在建档请求返回后由后台经 `web_search` 逐个核实域名与行业，建档页轮询到结论；用户确认后项目才启用。
3. 快审固定每平台每题 1 次。正式基线默认 3 次并分布在 0、4、24 小时窗口；重复次数超过 3 时在同一天内平均分布，不会把批次拖到多天以后。
4. 批次冻结客户、竞品、问题、平台、模型、协议、搜索策略、地区、重复次数、时间窗口和适配器版本。
5. Capture Worker 保存回答、来源、Query Fan-out 可见性、原始响应、Request ID、Token、延迟、成本可见性、内容哈希和失败码。
6. 指标由代码确定性计算；HRouter Agent 逐条校验其他模型回答及其来源，并生成口碑正负信号、GEO 优化建议和报告叙述草稿。
7. 人工批准报告叙述后，系统自动排队绑定该版本的 HRouter Agent 质量检查；质量检查人工批准且通过后，自动冻结快照并排队 PDF/Word。质量检查结论为 blocked 时，再次推进会重新生成叙述（新叙述批准后自动绑定新的质检），不会对同一份叙述反复质检；有新叙述在途时旧叙述不再被冻结。诊断、整改、内容与报告草稿都不自动发布或修改客户网站。
8. 验收方式由任务来源决定：技术类结论重跑官网审计（无阻断项才通过，记录 `verified_audit_id`），其余任务发布真实页面后重新抓取验收，发布地址必须在客户官网域名（含子域名）下；“已验收”状态只能由验收动作写入。复测必须复制正式基线完整配置，基线冻结的适配器版本与当前 Worker 不一致时拒绝创建复测。
9. 只有已批准叙述与通过的质量检查才能冻结报告 payload 与 SHA-256；Report Worker 再确定性生成 PDF/Word，另提供 CSV、JSON 和可撤销分享链接。定时批次会依序创建 Agent 任务，等待人工批准后再继续冻结与导出。
10. 报告分析包含 `evidenceIndex`：每条回答/快照/审计证据按采集时间编号，正文、PDF、Word 和 CSV 用 `[n]` 引用并附带平台、问题、采样次数、时间与引用网址；口碑来源 URL 去掉供应商追踪片段；模型夹带的英文推理草稿不进入“AI 如何描述品牌”。
11. 优化文章：以已批准报告叙述的每条 GEO 建议为目标，`optimization_article` Agent 读取该建议引用的证据与官网快照生成 Markdown 草稿，物化到 `optimization_articles`（每条建议一篇，重复生成覆盖为新版本）。文章只是可编辑草稿，发布由成员完成后填写地址。

## AI 工作台

`agent_sessions.execution_target` 区分 `desktop/server`。正式桌面新会话不创建 `agent_session_turn` job，而由创建者的客户端用 60 秒租约领取待运行回合；WebView 内的 pi-agent-core 恢复 `transcript` 并运行模型/工具循环，每 20 秒续租。服务端以 `desktop_agent_tool_calls(session_id,tool_call_id)` 保存工具幂等结果并续租长工具，客户端或 WebView 崩溃后可恢复未完成 tool result，不重复写业务。`agent_session_events.event_seq` 由会话行原子递增，客户端事件另有 `client_event_id` 去重。模型输出在桌面本地立即显示，最终消息与 transcript 按序回写；events 长轮询仍用于跨刷新恢复、服务端工具进度和浏览器兼容。

桌面 Responses 代理只接受当前用户、客户端和回合租约，把已持久化会话与客户端输入交给 HRouter 时强制使用服务端模型、系统提示、受限工具表、`parallel_tool_calls=true`、会话缓存键和输出上限；SSE 用量由服务端解析并计入项目成本。工作台工具继续只复用现有 service：`suggest_questions/propose_questions`、`create_batch`、`run_site_audit`、`run_rule_diagnosis`、`run_agent_draft`、`advance_report`、`generate_articles`、`verify_batch`、证据读取和 `web_search`。这些是服务端业务 RPC：桌面不能直接访问数据库、任意 HTTP、文件或 SQL。`advance_report` 只负责推进/等待服务端报告状态，PDF/Word 仍由 Report Worker 根据已冻结快照生成。

“帮我出监测问题”是工作台的第二条主流程：Agent 读取项目、建档候选与知识库候选后，把研究拆成 2–4 个独立问题并在同一工具批次并行调用 `web_search`（买家选型问法、价格/资质/售后疑虑、地区场景、竞品被推荐语境），等待时间取决于最慢的一次而不是逐次相加；每条搜索仍分别落证据与费用。Agent 汇总成按意图排列的候选，用 `propose_questions` 交给成员——前端渲染成可勾选、可改字、可增删的表格（问题、意图、主题、角色、来源与证据依据，未建档项目还有候选竞品），成员确认后服务端直接 `confirmProject` 写入新版本范围并启用项目，可选把新问题回流到客户行业知识库；模型没有直接写范围的工具。成员“不采用”时把原因作为工具结果交回 Agent 调整。联网搜索有回合/会话上限，连续两次未触发或失败后工具自身返回“联网不可用”，Agent 改用官网快照与知识库出题并写明局限。项目问题不足 5 个或未启用时“帮我出监测问题”快捷指令置顶。

`ask_user` 与 `wait_for` 都以 `terminate` 结束当前本地回合并把 `waiting` 写入服务器。用户回答或协调器发现批次 `complete/partial`、Agent run 终态、报告 PDF 就绪后，桌面会话写入 `desktop_pending_trigger/message` 并在客户端在线时领取续跑；客户端离线时保持可恢复，历史浏览器会话仍入队 `agent_session_turn(resume)`。`auto_approve=true` 时协调器代表会话创建者批准该会话产生的草稿，`agent_runs.approved_via='workbench'` 且审计日志带 `sessionId`；关闭自动模式则回到 `waiting_user`。文章草稿仍由服务器后台物化，PDF/Word 仍由 Report Worker 生成，因此桌面关闭不会中断已排队的采集、草稿或文档任务。

`agent_sessions.plan` 是右侧“执行进度”的事实源：工具创建步骤时写 `running`，`wait_for` 只把已有步骤（`waiting.stepKey`）置为等待，不再另起“等待…”条目；报告叙述/质检/PDF 的等待都归入 `advance_report` 维护的 `report` 步骤。协调器唤醒会话时按结果把等待步骤改为 `done/failed`（partial 批次、被拒绝或失败的 run 写入 `detail`），并追加 `step` 事件；会话结束后仍在后台生成的优化文章步骤由协调器在全部 run 落地后收尾。前端不再把“会话已完成但步骤仍 running”渲染为失败，只有会话本身失败/终止时才这样标记。

## 不变量

### 原始证据不可变

`query_captures` 及 `raw_artifact_key` 指向的对象只新增不覆盖。解析变化时重算派生数据；不修改回答、来源或失败状态。S3 桶应开启版本控制和服务端加密。

### 失败不拉低品牌率

品牌提及、首位推荐和声量只在有回答的平台内计算。总览等权汇总有效平台，并同时显示有效平台数、数据覆盖率和失败率。来源不可见时引用率为 `null`，不是 0。漂移告警同样跳过基线或复测中没有成功回答的平台：鉴权失败、限流导致的“0%”不是下跌。

### 可比性严格

复测只能选择 `baseline`。项目范围或平台配置变化会建立新基线。快审、正式基线和复测永不直接比较。确认监测范围沿用未变化条目的 ID（问题按 ID/文本、竞品按 ID/域名匹配当前活动版本，只有新增条目拿新 ID，去掉的归档），因此零修改保存不会切断趋势；周期监测到期时先按当前范围与平台配置构造基线配置，与最近完成/部分完成基线可比才复测，否则新建基线，新增的问题不会被旧基线遗漏。

### 队列收敛

Capture 任务执行抛错时由 `failJob` 重新排队或标记失败并刷新批次；Capture Worker 每分钟清扫租约过期且重试用尽的任务，批次因此总会收敛到 `complete/partial`，不会永久停在“采集中”。周期监测到期创建批次失败时把原因写在计划上（`last_error/failure_count`）并写运行日志，一小时后重试，界面提示“已启用但未能运行”。

### Agent 最小权限

Pi SDK 没有 Bash、任意文件、任意 SQL 或开放 HTTP 工具。网页和回答被标记为不可信内容。草稿中的证据 ID、问题 ID 和任务 ID必须属于当前项目；未知 ID 拒绝入库。审批在事务内先以 `status='awaiting_approval'` 守卫占住 run 行再物化，手动审批与协调器自动审批并发时只有一次生效，其余以明确错误失败并回滚。

联网只通过 `web_search` 工具：pi-ai 的 openai-responses 适配器不透传 OpenAI 托管的 `web_search`，也不保留 `url_citation`，所以该工具单独向 HRouter `/responses` 发一次带 `tools:[{type:"web_search"}]`、默认强制 `tool_choice` 的请求（被拒绝时回退 auto），把触发的搜索、归纳文本与来源 URL 落成一条只追加的 `web_search_evidence`（含原始响应、用量、失败原因）。工具协议为 `openai-responses.web_search.v3`，单次归纳最多 1200 output token；同一模型回复中的独立搜索并行执行。只有 `status='complete'` 的记录进入证据白名单并可被草稿引用；未触发/失败照样落库供审计。次数受 `WEB_SEARCH_LIMITS` 硬上限约束（工作台 8/回合、30/会话，草稿 10/次运行），连续两次未触发/失败后工具返回“不可用”而不是让模型继续重试。该工具只对 AI 工作台会话（可按会话关闭）、`prompt_research`/`customer_profile` 草稿和建档分析的竞品核实开放，报告叙述、质检、诊断仍只看批次证据。证据中心的“联网搜索”分区展示全部记录，草稿与候选表格里的 `[联网]` 引用可跳转。工作台会话流里 `web_search` 的工具事件由 `toolEventDetails` 按字段保留检索问题、阶段、实际检索词与来源链接（归纳全文只留在 `web_search_evidence`，其他工具结果超长仍整体截断预览），前端按 `toolCallId` 合并乱序完成的搜索并把连续几次搜索合成一张 SearchCard。

建档分析（`analyzeProject`）在画像与竞品候选之后，对每个竞品做一次联网核实：候选先以 `verification.status='pending'` 落库，建档请求随即返回，后台再搜索落证据并用一次结构化判断域名是否为其官网、是否同行业，结论回写 `competitors.verification`，未通过的候选在建档页标“待确认”；联网不可用只标“未联网核实”，不阻断建档。前端在有候选处于 `pending` 时轮询项目，超过 10 分钟仍是 `pending` 视为未核实。建档页另提供“后台联网出题”：排队一个非交互的 `prompt_research` 草稿（先保证有官网快照可引用），批准后只作为未确认候选进入问题列表，仍由成员确认；确认时可勾选“新问题同步写入行业知识库”，这是 Agent 候选进入共享知识的唯一途径（须有 `knowledge.manage`）。

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


## 可见度 V2 与本轮安全边界（2026-09-05）

指标只读 `metric_snapshots`，不再执行 V1 词法排名或在 GET 中调用 GPT。新批次原子冻结采样、Provider、Semantic 与 Metrics 契约；Capture 和 analysis 状态独立。`semantic_parse_runs/semantic_observations/semantic_selections` 管理只追加观察与当前选择，`measurement_drift_observations` 保留共同问题的配对变化和区间。报告 Agent、诊断、整改与报告绑定指标快照，重解析后的旧草稿不能批准为当前结论。完整公式、初始门槛、模型修订限制、队列协议和 API 见 `docs/visibility-measurement-v2.md`。

服务器新增独立 Semantic Worker；本机与其他三个执行器共用同一个 PGlite API 进程。语义模型没有联网或业务工具；报告叙述/质检必须人工审批。HTML 原始证据隔离下载，抓取绑定已验证 IP 并记录最终 URL，整改验收核对 HTTPS/访问项及最终发布域名。登录限流、异步密码哈希、请求体限制、事务内租约校验和不可恢复的会话取消标记共同构成边界。


## 成员/RBAC 边界修复（2026-09-06）

成员管理不等于角色授权超管。`member-access.ts` 在写事务内重读操作者，限制可授予的角色权限和客户范围；创建、停用、恢复、重置密码统一执行此边界，不能通过新建高权限用户间接提权。`roles.system_key` 区分稳定默认身份与可编辑名称，显式空角色不回退，新增用户默认无客户范围。机构授权只作为有效权限的交集上限，不删除角色定义；撤权和恢复不需要重建角色。角色/用户/机构修改在组织边界串行化，删除角色与并发成员分配不能互相覆盖。

前端成员只读/管理状态明确，权限身份定期刷新，分页保留跨页选择并拒绝过期响应。迁移 `0020_membership_rbac.sql` 与前后端必须同步发布。线上实测记录、清理边界和本地验证见 `docs/rbac-demo-verification-2026-09-06.md`；代码改动不代表已部署到 Demo。

## 统一授权内核 V2（2026-09-06）

`packages/authorization` 是不依赖 DB/HTTP 的授权语义层；Worker `authorization/` 实现单 SQL Principal、可信资源注册表、策略配置和同源解释器，`rbac.ts` 不再拥有独立运行时鉴权。登录绑定 credential_version 并在锁内复核密码，成员委派/UI 共享配置权限比较；后台执行者显式绑定并逐回合/逐工具重验。权限、功能策略与不可弱化的租户/项目/系统边界分离，超管可以在授权引擎界面管理目录和 OR/AND 条件、用版本防覆盖。新工具未登记即拒绝；workbench.run 不隐含其他域写权限。详见 `docs/rbac-v2.md`。

## 全功能审查修正（2026-09-06）

功能模块通过 lazy-views 注册按需载入，ViewBoundary 保留导航并处理 chunk/渲染失败；静态 hash 资源与 HTML 使用不同缓存策略，缺失脚本不再返回 HTML。成员页 Principal 批量单 SQL 替代 N+1，并保持作用域。API 用 api-errors 显式区分输入、资源、状态冲突和未知内部故障。采集协议 cloud-search.v2 只测量最终回答，浏览来源与最终引用分离；capture-contract 统一阻止旧合同进入新解析、审批和报告。0022 从组织/角色中移除不可生效的系统权限，并以数据库触发器守住此边界。完整部署/验收记录见 docs/full-audit-2026-09-06.md。

新批次冻结编译时 ADAPTER_VERSION，平台初始化仅同步版本字段，不覆盖用户模型、地址、开关和凭据。证据 UI、CSV、报告引用排行榜只将 isCitation=true 计为最终引用。http-routes 保持未匹配可选组为空串，避免重解析误入审核路由。approval-workflow 把已提交审批与独立授权的后续生成分开：审批成功而推进受阻返回 approved + blocked，不回滚或伪报审批失败；语义任务在排队、领取及调用前检查机构封禁。
