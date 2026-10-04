# GEO Console Domain Contracts


Deep Agents 替换 Pi，保留 user/assistant/toolResult 消息，新增可选 toolResult.terminate，不重写历史。调用先持久化再执行；结果保存失败不继续。全体工具明确 parallel 的只读批次可并行，其他批次串行；人工暂停后剩余调用保存未执行结果。默认文件/Shell/子 Agent 工具被模型可见层及执行层双重拦截。Graph MemorySaver 不是离线队列，桌面恢复使用 SQLite transcript、工具账本、等待状态和任务租约。UI 新会话默认人工审批，已存设置不改，见 `docs/desktop-agent.md`。

## 内容运营契约

含客户知识的文章质检在模型请求前和结果选用事务内重验 `knowledge.assets.read`，撤权不得继续外发资料或选用输出。软删除文章不进入新报告快照和工作台当前上下文；已有冻结报告仍保留原文和哈希。

0028-0031 的 `article_versions` 由数据库触发器对文章内容/计划/证据/再生成保存不可变版本；旧文章不补造批准。质检冻结版本、来源、模型与策略，无工具调用，需结构/原文引用校验与人工复核；内容审核独立。客户知识修订/撤回/过期会让依赖它的质检失效。`customer_knowledge_revisions/reviews`、质检尝试/审批、发布事件/回执只追加。发布工单固定文章及渠道快照，待执行/开始前校验当前批准与执行人权限，历史已执行版本可记录回执但不替新版本标为发布。用户仅选择人工发布，禁止把计划状态当已发文或 GEO 效果；详见 `docs/content-operations.md`。

## 客户生命周期

0027 的 archived_at/deleted_at 为附加状态；status=archived 后仅允许读取和逻辑删除，不允许改名、解封或新增业务内容。删除关闭列表、授权候选、子资源、artifact 与公开分享，原始行和对象保留。project.archive/project.delete 独立授权，新权限不自动补授既有机构/角色。状态切换在事务中锁定项目并重新授权，未结束任务返回 409，成功时停用周期计划。数据库触发器锁项目并检查直接及间接项目写入，覆盖通过授权后发生封档的竞争；新增子表必须补映射。详见 `docs/customer-management.md`。

## 客户可读报告与文章计划

文章采用问题/证据/渠道驱动的自适应写作（`agent.ts ARTICLE_WRITING_GUIDANCE`）；新提交需 `publicationPlan.contentStrategy.format/rationale/lengthApproach`，类型为自由文本。正文非空即可，大纲可空；60,000 字符是资源上限，不是统一篇幅。保留真实问题/证据与 content 类型门禁。老 JSON/草稿兼容，不给旧文章补造写作方案；Web/PDF/Word 同步显示形式与篇幅依据。见 `docs/reader-report-workflow.md`。

`communication.ts` 仅从冻结指标/config/Capture 派生分母、逐题纳入和点名拆分；正式算法仍以 visibility.ts 为准，不池化次数或把未知记零。sources 与 isCitation 分开。新模板 v4 冻结前补齐同客户嵌套历史引用，缺失拒绝冻结；旧报告不改。Word 原生书签、PDF 锚点、外链协议白名单和截图哈希不可省略。

0026 增加 nullable publication_plan；新建议需 deliveryType/ownerRole/acceptanceCriteria，新文章需 targetPromptIds 与用途/渠道/证据/验收计划。只有 content 可生成，未分类历史建议需重生成批准。发布检查在行锁事务内，需实际 URL 和无待补充事实的正文，计划证据不超出文章 evidence_ids。报告冻结目标/计划，后改文章不改旧报告。定位 API 不授予正文/文件权限。见 `docs/reader-report-workflow.md`。

Agent readerGuide 必须由 `agent-measurement-context.ts` 实际提供运行绑定指标与冻结问题，不能只写提示词要求。getBatch/Agent 索引优先用冻结问题和地区/语言恢复证据上下文，完整新批次不受客户后改资料影响；仅缺少旧配置的历史记录保留兼容回退。所有变更均只读映射，不修改 Capture 行/对象或绑定指标。

## 机构客户目录

`page.customers` 是机构菜单及现有 `/api/projects` 列表读取权限，不等于全机构客户范围或项目证据权限。列表必须同时应用当前 organizationId 与成员 projectIds；只读菜单不能 POST/PUT 或读取项目详情。创建沿用 project.create，资料编辑沿用 project.onboard，历史配置与证据不可改写。migration 0025 从既有 overview 授权补上等价菜单，不能为被撤销的机构上限重新授权；新建后的身份刷新用于读取真实新增客户范围。见 `docs/customer-management.md`。

## 可选官网与额度收尾

- migration 0024 使 projects.website_url/domain 可空；PUT 客户资料严格白名单、project.onboard 权限/项目范围，不改别名、正式范围、历史 config/审计/报告。新基线 domain 用空字符串表示未提供，websiteUrl 可空；后补官网需新基线，同条件复测仍复制旧配置。
- HTTP 402/明确额度型 429 为失败 quota_exceeded，不当作临时限速重试。只停止同批次/平台的 pending 和过期 leased capture jobs；保留活跃租约、其他平台、Capture 原文和历史配置。兼容只读旧 HTTP 402 失败。采集聚合只看 capture jobs，语义解析独立。
- 官网原始证据保持追加：`geo.website-audit.v2` 的 customer、check evidenceIds/selector/recommendation/verification、原文摘要/哈希/对象键和截图模式被冻结；失败响应与空成功文件也有源证据，网络失败不推断内容缺失。GET 官网证据必须按项目限定；artifact 通过 website_audits 的引用归属授权。
- 截图只用新无凭据上下文，从保存 HTML 受控渲染；仅 GET 展示资源经 DNS-pinned public-http，禁止 API、表单、frame、worker、WebSocket/WebRTC。PDF 脚本关闭、所有外网关闭。有限 Sitemap 扫描与截图限制、无官网指标 null、报告品牌冻结规则见 `docs/website-audit-and-capture-recovery.md`。

## 完整回答辅助解读

事实源 `packages/evidence/src/answer-analysis.ts` 和 worker 同名 service；`geo.answer-analysis.v1` 独立于正式 measurement。冻结原文输入哈希、批次问题/品牌、模型/提示/分段/校验版本；每次手动重生成追加 run/attempt，不修改 Capture/config/MetricSnapshot。全文按序覆盖片段，引文逐字唯一定位为 UTF-16；无效引文/品牌归属不展示正文，缺段/条件/歧义为 needs_review，覆盖不是准确率。POST 与执行均走 `answer.analysis.execute`、明确 actor 和当前权限；模型无工具/代码/联网能力。单次 60,000 UTF-16 输入、16,000 output tokens、120 秒；独立 1 槽、两次技术尝试、5 分钟租约、30 秒续租/重试。未知费用 null。详见 `docs/answer-analysis.md`。

## 证据

- 当前采集契约是 `geo.query-capture.v2`，模式固定 `llm_search_api`；`engine` 只能是五个 `SearchProviderId`。
- 成功采集必须有 answer 与 SHA-256；失败采集必须有 failure code。元宝协议固定 `yuanbao-search+hunyuan-synthesis`。
- 原始 Provider 响应对象使用新 object key 写入。local 使用 `wx`，S3 使用 `IfNoneMatch: *`，因此同键覆盖应失败。
- `query_captures.job_id` 唯一。不要通过更新 raw capture 来重跑解析；新增派生结果或创建新批次。
- 网页快照、审计结果和报告快照同样是证据。只有 finding/task 等派生记录允许按明确业务动作更新。

## 批次与队列

- 批次种类：`quick_audit`、`baseline`、`retest`；状态：`draft`、`queued`、`running`、`complete`、`partial`。
- `FrozenBatchConfig` 包含项目、竞品、Prompt、平台、repeats、sampling/window，以及每个 Provider 的 endpoint/model/protocol/search strategy/tool/adapter version。默认时间窗口由 `defaultExecutionWindowMinutes` 给出：≤3 次为 0/240/1440 分钟，>3 次在 0–1440 分钟内平均分布。
- 可比性是规范化后的完整 config 相等（`areBatchConfigsComparable` 与 JSON 一样忽略 undefined 键），不是只比较平台和模型。旧批次继续保留创建时范围。
- 复测复制基线冻结配置；基线任一 Provider 的 `adapterVersion` 与当前 `ADAPTER_VERSION` 不一致时 `createBatch` 拒绝创建复测。
- 周期监测（`processDueSchedules`）到期时先用 `buildBaselineConfig` 按当前范围与平台配置构造候选配置，与最近 `complete/partial` 基线可比才创建 retest，否则创建 baseline；创建失败写 `monitoring_schedules.last_error/last_error_at/failure_count` 并记 `schedule.batch_failed` 日志，一小时后重试；成功或重新保存计划时清零。`saveMonitoringSchedule` 在周期变化时按 `last_run_at + 新周期` 重算 `next_run_at`（已到期立即可运行）。
- Semantic job 默认最多 2 次、租约 5 分钟并每 30 秒续期，由独立/本机组合 Semantic Worker 执行；所有非 Capture 的耗尽租约由 `sweepTerminalLeases` 清扫。Capture job 默认最多 3 次，租约 5 分钟并每分钟续期；Agent job 最多 2 次、租约 15 分钟，Worker 每 250ms 领取一次且最多并行两个 I/O 型任务，浏览器兼容的 `agent_session_turn` 优先于后台 `agent_draft`；桌面会话不创建该 job。PDF job 默认 3 次、租约 5 分钟。失败重试延迟 30 秒。
- 过期租约可由其他 Worker 领取。Capture 执行抛错必须经 `failJob`（未用尽重试回 `pending`，否则 `failed`）并 `refreshBatchStatus`；`failExpiredCaptureJobs`/`sweepExpiredCaptureJobs` 每分钟把租约过期且 `attempts>=max_attempts` 的任务标为 `failed` 并刷新批次。不要把尚未生成证据的任务直接改为 complete。

## Provider

Provider 的实时默认值以 `apps/worker/src/providers.ts` 为准：

- `deepseek_api`: DeepSeek Responses + `web_search`
- `kimi_api`: Moonshot Chat + Web Search Formula
- `doubao_api`: Ark Responses + `web_search`
- `qwen_api`: DashScope native generation + search
- `yuanbao_hunyuan`: SearchPro source + Hunyuan synthesis，需两个凭据

批次执行使用冻结值，不跟随 Settings 的后续修改。当前 worker 不支持冻结 adapter version 时应记录 `protocol_changed`，而不是用当前版本强跑。

## 指标 V2（唯一运行口径）

- 契约与校验以 `packages/evidence/src/semantic.ts` 为准；公式以 `packages/metrics/src/visibility.ts` 为准；异步落库与快照读取以 `apps/worker/src/measurement.ts` 为准。详见 `docs/visibility-measurement-v2.md`。
- V1 指标已停用。成功 Capture 不等于有效语义观察；未知、冲突、无原文依据不能进入品牌分母。原始证据不可更新。
- 先问题内汇总有效重复，再问题等权，最后达标平台等权。三类覆盖独立，失败/未配置/来源不可见保持 null。
- 正式默认最低有效重复 ceil(repeats*2/3)、问题覆盖 80%、解析覆盖 90%、至少 10 个有效问题、初始品牌/推荐区间宽度不超过 0.5。门槛、2000 次 bootstrap、种子和策略版本全部冻结；它们仍需人工标注集校准。
- 首位推荐仅来自证据校验的明确推荐列表；against 不计推荐。品牌出现份额不是文本声量，推荐名次用中位数，重复稳定性用两两一致率。
- Semantic Worker 没有工具、联网、文件或 SQL 能力。每条任务最多两次技术尝试、每次首轮加至多一次独立复核；只追加观察，当前选择唯一。人工审核重新验证原文与项目并写审计。
- Capture 完成和语义分析完成独立。只有 Worker 生成 MetricSnapshot；GET 不计算旧指标、不调用模型。报告、诊断、整改和漂移绑定快照。
- 正式漂移只比较同配置和测量契约的 ready baseline/retest，使用共同有效问题的配对差值与 95% 区间；10/20 个百分点下降且区间上界<0 才告警，其余仅观察。
- 报告叙述和质量检查不能被工作台自动批准绕过。旧指标快照上的草稿不能在新版本下审批。
- 费用未知仍为 null；未启用 App 不生成配对分数或占位数据。

## Agent 与审批


## 网站、报告与安全

- Crawler 每次请求和重定向都解析 DNS 并拒绝私网/Loopback；官网 crawl 上限由调用方控制（首页单独抓，其余 `CRAWL_CONCURRENCY=4` 并发），建档分析最多 40 页。
- 诊断需要真实回答；网页或竞品抓取失败只减少证据，不产生“内容缺失”结论。
- 整改验收：`taskVerificationMode` 由诊断类别含“技术”或验收标准含“官网审计”判定为 `audit`（重跑 `auditProject`，verdict 为 blocked 则拒绝，写 `verified_audit_id`），否则为 `publish`（`publishedUrlBelongsToProject` 要求发布地址在客户域名或子域名下，再 `crawlPublishedUrl` 写 `verified_snapshot_id`）；`getProject` 的 task 带 `verification_mode`；`updateTask` 拒绝手工 `status='verified'`。
- 监测范围确认（`confirmProject`）：`normalizeCompetitorScope` 拒绝无效域名、等于客户域名或重复的竞品域名，`assertUniqueQuestions` 拒绝重复问题；竞品按 ID（域名未变）或域名、问题按 ID（文本未变）或文本匹配当前活动版本并原地更新保留 ID，只有新增条目拿新 ID，未命中的旧行归档；结果含 `promptsKept/competitorsKept/libraryUnlinked`。
- 报告快照 v2 保存 Agent 叙述/质量 run、payload 和 hash；PDF/Word 只能补充各自 artifact key，不能重写冻结 payload。Report Worker 只做确定性二进制排版，不产生新业务判断。
- 分享 token 只在创建时返回明文，数据库保存 SHA-256；读取必须未过期且未撤销。
- Provider/HRouter Key 由 AES-256-GCM 信封加密，AAD 包含 organization 与 credential key。主密钥丢失会使数据库凭据不可恢复。
- 用户归属一个 organization；有效授权为机构权限上限与用户多角色权限并集的交集，数据范围再限制为机构下全部客户或明确指定客户。页面和 API 策略来自数据库资源目录，未登记 API 默认拒绝。历史 admin/analyst/viewer 只用于迁移默认角色，不参与运行时判断。
- 数据库最多存在一个 `is_super_admin=true` 用户。超管可绕过角色权限条件，但不能绕过停用策略、封禁业务机构和活动机构过滤；超管可封禁机构，封禁立即撤销该机构非超管会话并阻止后续登录。
- Provider/HRouter 配置、加密凭据和问题知识库按 organization 隔离。环境变量凭据只为 `default` 机构提供 bootstrap fallback，不能泄漏给其他租户。

## 行业问题知识库

- 共享范围固定为 `organization_id + industry`；问题支持成员新增和软归档，不跨机构复用。
- 客户建档保存明确 `industry`。官网分析优先合并同业库问题，再追加 Agent 候选并按问题文本去重；Agent 新候选不会自动写回知识库。
- 回流只在成员确认时发生：`confirmProject(…, {syncLibrary:{organizationId,createdBy}})` 把没有知识库引用、长度 ≤500 的新问题写入客户 `industry` 的知识库（同行业同问题已存在则只回填引用），返回 `libraryAdded/libraryLinked`；客户没有行业则不写；`syncLibrary` 的机构必须等于客户所属机构。建档页与工作台候选确认卡都提供该开关，仅对有 `knowledge.manage` 的成员显示，API 侧再次校验权限。
- 项目 Prompt 可引用 `library_question_id`，但批次仍冻结完整问题文本和维度；知识库后续变化不修改历史 Prompt、Capture 或批次。

## 配置导入导出

- `apps/worker/src/config-transfer.ts` 只搬运非密钥配置：平台设置包（`kind=geo-settings`）含 HRouter baseUrl/model/thinkingLevel 与各平台 model/endpoint/options；知识库包（`kind=geo-knowledge`）含未归档问题。密钥永不导出；导入到缺密钥的机构时平台按停用落库并在结果里说明。
- 知识库导入按“行业 + 问题”去重，重复项跳过而不报错；导入只写当前活动机构。
- 监测范围包（`kind=geo-project-scope`）在前端生成与解析（`apps/web/src/ui/scope-bundle.ts`），含别名/竞品/问题业务字段与问题的 `libraryQuestionId`（解析后回到 `library_question_id`），不含行 id；导入后载入编辑器，仍走 `POST /api/projects/:id/confirm` 产生新范围版本。引用不属于本机构或已归档的知识库记录时，`confirmProject` 去掉该引用并在 `libraryUnlinked` 计数，不拒绝整次确认。

## 运行日志

- `service_logs` 是运行诊断数据，不是证据；字段为 organization、service、level、event、message、trace/project、脱敏 metadata 和 occurred time。
- API/Worker 通过 `GEO_LOG_SERVICE_URL` 与独立服务令牌批量上报。日志服务不可用不得阻断采集、Agent、报告或 API；标准输出仍是恢复兜底。
- 客户端与日志服务都必须过滤凭据、Cookie、token、回答/网页正文和 raw response；日志内容不得成为指标、诊断或报告证据。
- 普通机构管理员只能查询/导出/清理当前机构运行日志；系统日志仅超管可见。保留清理只删除 `service_logs`，同时写业务审计与新的 retention operation log。


## 成员授权与默认角色（2026-09-06）

- 创建用户的 HTTP 入口必须传 authenticated actor；事务内重读 actor，只能授予自己已有的权限和客户子集。`members.manage` 不能绕过 `rbac.manage` 创建更高权限账号，也不能管理更高权限/范围用户。
- 新成员默认 `all_projects=false`；必须显式授予全部或指定客户。超管有效访问仍不受该存储默认值限制。用户显式 `roleIds:[]` 表示无角色，不回退；省略 roleIds 时由稳定 `roles.system_key` 找默认角色，改名不影响身份，缺默认键需明确选择角色。
- 同机构邮箱 trim/大小写重复为 409。停用账号通过 restore 重新启用，不能重复创建；恢复不恢复旧会话。管理员 reset 撤销全部会话；自己改密验证旧密码并保留当前会话、撤销其他会话。密码不写审计 metadata。
- 机构授权只计算交集，不删除 `role_permissions`。重复初始化不得重授已撤销权限；角色编辑允许保留已有但暂被上限屏蔽的权限，不允许新增机构未授权项。系统超管权限不能授予机构。
- UI 只读、权限不足、候选加载失败、重复邮箱、停用、保护账号均需显式状态；跨页选择不得丢失。后台鉴权即时生效，前端身份 15 秒/聚焦刷新。

## 授权内核与持久任务身份（V2）

- 旧云端主体权限/角色/客户由 `loadPrincipal` 的单 SQL 快照提供，不能 Promise.all 拼接不同时间的权限与范围。桌面功能权限取复核过的云端身份，账号私有项目范围取本地创建授权；事务中重授权必须使用传入事务连接，不能查询被自身排队阻塞的根 SQLite 连接。userId=null 不代表超管；local 仅零用户非 production。
- 会话与用户 credential_version 必须一致；登录密码验证后锁内比较哈希，改密触发版本递增。授权变化由 org/user authz_version 记录，不能缓存旧 Principal 跨请求。
- API、文件和动作统一 `authorization/index.ts`，解析器只在 resources 注册可信 SQL；config 不能弱化内置资源/系统边界。解释器复用 evaluateRequest。
- 委派、候选与 can_manage 比较目标配置权限（含被机构上限屏蔽项）；成员和审批写事务内重新授权。
- agent_sessions/runs 必须绑定 ExecutionActor；每个工作台工具有 workbench.tool.* 策略，域写权限不能被 workbench.run 代替。后台撤权/取消阻止后续工具和物化；报告仍人工审批。report-scheduler 只获报告最小权限与机构上限交集。
- 公开分享在封禁机构期间不可读；采集证据不变。完整规则见 docs/rbac-v2.md。

## Responses 最终回答与系统角色边界

原始 Provider 响应不得覆盖；只有最终 assistant/output_text 可用于测量，不包含 reasoning、commentary、工具结果或未完成输出。浏览 URL 不是 citation；报告 sourceStatus=cited 必须对应 capture.sources.isCitation=true。cloud-search.v2 合同与旧版本不混算，capture-contract 拒绝旧合同重解析/审批/报告，使用新批次。成员 Principal 可批量读取但必须在一条 SQL 中保留权限/范围一致性；0022 不允许把 system_only 权限写入组织或机构角色。
# 全功能审查补充边界（2026-09-06）

- 新基线从编译时 ADAPTER_VERSION 冻结采集版本，不能信任升级前残留的平台版本；初始化只同步版本字段。证据、CSV、报告统计必须区分观察来源与 isCitation=true 的最终引用。
- 可选 HTTP 路由捕获组不得把 undefined 解码成字符串；重解析与人工审核使用不同分支，见 http-routes.ts 及测试。
- 审批提交成功与后续单独授权的报告生成是两项结果；approval-workflow.ts 可返回 blocked，但不能将成功审批回显为失败，不能给审批权限隐含生成权限。
- 语义任务排队、领取和每次模型调用前复核机构封禁；暂停不能被描述为撤回已经发送的上游请求或退款。

## SQLite 桌面执行边界（2026-10-04）

当前桌面为 React → Tauri IPC → 本机 Node 业务引擎 → 新 SQLite 工作区。模型/搜索/采集/网站分析/指标/内容质检/报告/调度均在客户端；云端只鉴权、权限管理与账户私有快照存储。代码事实源：`apps/desktop/src/engine.ts`、`src-tauri/src/local_engine.rs`、`packages/core/src/sqlite.ts`、`apps/worker/src/api-service.ts` 和 `desktop-storage.ts`。独立指标、证据页面保留，不迁移旧数据库或业务数据。

会话/工具账本/等待状态/租约落 SQLite；MemorySaver 仅回合内使用。结果不确定的工具停止自动重放并要求成员核查。关闭客户端会停止本机执行；鉴权断网 fail-closed。哈希分块 + CAS 同步不自动合并冲突，设备主密钥不上传，新设备重配 Provider Key。桌面公开分享暂未接静态托管，会明确拒绝创建无效链接，PDF/Word 本地导出仍可用。

完整开发、恢复、测试和限制见 `docs/desktop-agent.md`。云端新部署显式使用 `compose.desktop-cloud.yaml`，不启动业务 Workers；其余服务器拓扑与 PostgreSQL 操作章节仅适用于旧版兼容部署，不代表新桌面执行位置。
