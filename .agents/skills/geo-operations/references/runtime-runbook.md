# GEO Console Runtime Runbook

内容运营排障先看 `docs/content-operations.md`：article_quality 由 Semantic Worker 独立一槽处理，检查版本/知识修订/审批/租约。失效结果必须新建质检，不修改历史。发布工单仅人工执行，submitted 是回执待复核，verified 只代表对应版本交付已核对。无自动 CMS 或浏览器发文。0028-0031 和 API/Web/Agent/Semantic Worker 保持同版，备份覆盖全部新增表；既有机构新权限不自动授予。

客户封档/删除 409 先看 jobs、AI 会话和分析运行是否结束；不通过删证据解锁。0027 提供数据库写保护，封档/逻辑删除后计划与协调器停止推进。删除客户的旧分享和 artifacts 应为 404；若旧服务仍可读取，需统一更新 API/Workers，禁止回退到未检查 deleted_at 的版本。备份包含状态字段和全部证据，详见 `docs/customer-management.md`。

可读报告/文章排障：新模板仅用于新冻结快照；0026 为文章可空计划和定位策略加法，发布须 API/Agent/Report/Web 同版本。文章排队先确认 content，历史未分类需重生成批准，不自动付费回填。引用 409/打不开区分跨客户、缺失对象、正文或文件权限，不替换记录/放宽隔离。备份计划、冻结全文与 PNG/raw；回滚不删列，保留新模板渲染能力。见 `docs/reader-report-workflow.md`。

额度耗尽排查：区分未来采样窗口和 leased 活跃请求；查看 captureProgress 的 pending/active/next_at 与 blockedProviders。HTTP 402 / 明确额度型 429 后，只收尾同批次该平台 pending/过期 leased capture jobs；即时与每分钟清扫兼容旧 provider_error HTTP 402，日志 capture.quota_jobs_stopped，不改 Capture/config、不换平台、不自动充值后重跑。截图/PDF 失败检查 audit.screenshot_failed/audit.pdf_failed、API/Agent 的 Chromium/字体/资源；源文件与旧截图不可补写覆盖，修复后新建审计。备份包含审计 JSON 与对象证据。详见 `docs/website-audit-and-capture-recovery.md`。

完整回答辅助解读复用 Semantic Worker 的独立 1 槽，正式测量保留 2 槽。`answer_analysis` job 最多 2 次技术尝试、5 分钟租约、30 秒续租/重试；通用清扫同步终结耗尽的 run。排查 `answer_analysis_runs.error_message`、jobs、`answer.analysis.execute` 与当前 actor 权限；保留原始 Capture/旧分析，失败在 UI 重新生成而非改证据。备份两张新增分析表，包含敏感原始模型响应。详见 `docs/answer-analysis.md`。

## 服务与定时行为

| 组件 | 主要职责 | 关键周期/租约 |
| --- | --- | --- |
| API | HTTP、认证、migration、Provider config、监测调度 | 每 60 秒扫描到期 schedule |
| Log Service | 结构化运行日志采集、查询、CSV、保留清理 | 内网 3020；默认 90 天；每日清理 |
| Capture Worker | 领取 capture、调用冻结 Provider、写 raw + v2 evidence；抛错走 failJob；每 60 秒清扫过期且重试用尽的租约并刷新批次 | 5 分钟租约，每 60 秒续期，默认最多 3 次 |
| Agent Worker | 执行后台 HRouter/Pi draft 与浏览器兼容工作台回合；浏览器交互任务优先，两个 I/O 槽 | 每 250ms 领取；15 分钟租约，每 60 秒续期，最多 2 次，30 秒重试 |
| Report Worker | 推进定时 Agent 报告门禁、冻结报告、生成 PDF/Word | 每 15 秒扫描，文档 5 分钟租约，30 秒重试 |
| Web/Tauri | 同一 React 工作台与动态导航；Tauri WebView 运行本地交互 Agent，并以 Channel 接收模型流 | 桌面回合租约 60 秒、20 秒续租；浏览器同步调试；桌面检查 HTTPS 清单 |
| PostgreSQL | 业务、队列和证据索引 | 生产唯一数据库 |
| local/S3 store | raw response、网页、PDF、Word | 写入必须不可覆盖 |

服务器管理命令位于 `/usr/local/bin/geo-console`，实际 release 在 `/opt/geo-console/current`，共享配置和 Secret 在 `/opt/geo-console/shared`。每次 release 携带发布机本地生成的 Linux server artifact 和 Web dist；服务器只以 `FROM` + `ADD/COPY` 重构镜像，普通 restart 只重启已有镜像。

本机 PGlite 是不同拓扑：API 内组合运行三个队列 Worker，Log Service 使用独立日志 PGlite。若看到 PGlite mutex/abort，先停止所有手工 Worker，只用 `corepack pnpm geo start` 重启；不要复制或同时打开运行中的数据库目录。

## 健康

- API：`curl -fsS https://<domain>/api/health`。检查 `database`、`objectStore.mode`、`analysisConfigured` 和 `logService.status`。
- Log Service：容器内或本机请求 `http://127.0.0.1:3020/health`；检查 stored logs、latest time、retention days 和 token Secret。
- 服务：`sudo geo-console status` 或 `docker compose ps`。Worker 没有独立 HTTP health，必须结合进程状态、日志和队列推进判断。
- 发布：manifest 的目标平台、server artifact SHA-256 和 Worker base 必须匹配服务器。重构日志不得出现 pnpm、apt、Playwright download、Web build 或远程 pull。
- 磁盘：检查 PostgreSQL volume、evidence volume、Caddy data 和 backup filesystem；磁盘满可同时表现为数据库、对象和 PDF 故障。
- 时间：租约、schedule、分享过期都依赖服务器时间；检查 NTP 和时区漂移。

## Capture / Provider

先按 Provider 和 failure code 分组：

- `auth_required/authentication_failed`：检查平台设置中的对应加密凭据和主密钥可读性，再运行该 Provider connection test。
- `rate_limited`：确认供应商配额和并发。Demo 默认 `GEO_CAPTURE_CONCURRENCY=1`，不要用提高并发掩盖限流。
- `timeout/provider_timeout`：检查出口网络、DNS、供应商状态和 endpoint；保留原失败。
- `search_not_triggered`：协议返回了回答但没有强制搜索证据，不能按成功补录。
- `model_unavailable`：需要新 Provider 配置和新 baseline；不得改旧冻结 batch。
- `protocol_changed`：当前 adapter 无法满足冻结协议/版本；发布经过测试的新 adapter，并创建新 baseline 或按兼容策略处理。
- `no_answer`：真实无回答，不是系统异常；按失败样本进入 partial/coverage。

Settings 的连接测试只验证当前配置；运行中的 batch 使用创建时冻结值。两者不一致时先检查 batch `config`。

- 批次长时间“采集中” → 查该批次 `jobs`：`failed` 任务看 `last_error`；`leased` 且 `lease_expires_at` 已过、`attempts>=max_attempts` 的任务应在一分钟内被 Capture Worker 清扫为 failed，没被清扫说明 Capture Worker 没在跑。批次收敛为 `partial` 后失败样本照常进入失败率。
- 复测创建被拒“适配器版本…不一致” → Worker 已升级 `ADAPTER_VERSION`，旧基线不能复测，新建正式基线；周期监测会自动改为新建基线。

## Agent

## Report / PDF / Word

- 快照是不可变 payload/hash，PDF/Word 是其派生产物。先确认已批准叙述、通过并批准的绑定质量检查、report ID 和 snapshot 存在。
- 排队超过两分钟时检查 Report Worker、job lease/last error、Playwright Chromium、`fonts-noto-cjk` 和 object store write。
- ready 要求 `pdf_artifact_key` 和 `word_artifact_key` 都存在，并抽查两个对象实际可读；不要只信数据库字段。
- 手工和定时流程共享幂等状态机；叙述/质量两次人工批准是显式停点，其余排队、冻结和文档生成自动推进。

## Structured Logs

- API 为请求生成/透传受限格式的 `x-request-id`；Capture job ID、Agent run ID 和 report document job ID 作为 Trace ID。
- 日志上报失败不得改变业务 job 状态。先用容器标准输出恢复，再修复 Log Service；单进程内存缓冲上限 500，不能当持久队列。
- 日志客户端和服务端双重过滤 authorization/cookie/password/secret/token/key、回答/网页正文和 raw response。发现敏感内容时先阻止进一步暴露，再修脱敏规则并按明确授权清理相应 `service_logs`。
- 普通管理员只操作活动机构日志；system logs 仅超管可见。保留清理只允许 7-3650 天，绝不能对 `audit_logs` 或证据表复用该接口。

## Tenant / RBAC

- 权限资源、导航和 API 路由分别来自 `permissions` 与 `permission_routes`。最终权限是机构授权上限与用户多角色并集的交集；`users.role` 只保留迁移兼容，不参与授权。
- 用户有 home organization；数据库唯一系统超管可用 `geo_organization` Cookie 选择活动机构。超管切换后也不能绕过活动机构边界；普通成员再按全部/指定客户范围过滤。
- 项目、Agent、报告、任务和 artifact 路由都解析数据库的 organization/project 归属。404 可能是机构或客户范围隔离结果，排查时不要向普通成员暴露另一个租户或客户是否存在。
- 机构封禁撤销全部非超管会话并阻止登录。解封后需重新登录；超管仍可选择封禁机构检查和修复授权。
- Provider/HRouter config 和 encrypted credential 按机构查询；非默认机构无环境变量 fallback。问题库同样按机构 + 行业隔离，归档不物理删除。

## Desktop Update

## Schedule、漂移与费用

- API 每分钟最多读取 10 个到期 schedule。项目已有 queued/running batch 时，next run 延后 1 小时。
- schedule 到期时按当前范围与平台配置构造基线配置，与最近 complete/partial baseline 可比才创建 retest；否则创建新 baseline。创建失败写 `monitoring_schedules.last_error/last_error_at/failure_count`（日志事件 `schedule.batch_failed`），一小时后重试；AI 监测页提示“已启用但上次未能创建批次”，重新保存计划清除。修改周期后 `next_run_at` 按上次运行时间加新周期重算。
- 可比 retest 相对 baseline 的品牌提及、声量或引用率下降至少 10 个百分点产生 warning，20 个百分点产生 high；基线或复测中没有成功回答的平台不比较、不告警。
- 整改验收：技术类任务“重跑审计验收”（审计仍有阻断项则拒绝），其余“抓取验收”要求发布地址在客户官网域名下；“已验收”不能手工选择。
- acknowledge 只写确认时间，不删除告警或证据。
- 费用汇总只累加非 null `cost_micros`，同时报告有已知价格的请求数；其余只显示 usage。

## 对象存储

- local 模式检查共享 evidence volume 的容量、权限和对象路径。
- S3 模式检查 bucket、endpoint、region、path-style、凭据对是否完整，以及 HeadBucket/HeadObject/Put 权限。
- 生产 bucket 应为私有、版本化、加密；对象恢复必须验证具体 version，不只验证 bucket 可列出。
- 严禁单独删除对象并留下数据库引用，也不得覆盖同一 key。


## V2 语义队列与恢复

新增 `semantic-worker`，本机由 `local-workers.ts` 组合运行，禁止对同一 PGlite 目录另起进程。成功 API Capture 才进入 `semantic_parse`；两个槽位、500ms 领取、5 分钟租约、30 秒续期、最多两次尝试、30 秒重试。5 秒协调周期负责排队、耗尽租约清扫、指标快照与配对漂移。Capture complete 不代表 analysis ready。

卡住时查看 `semantic_parse_runs.status`、job 的 attempts/lease/last_error、机构 HRouter 模型/Key 与语义观察校验原因。证据中心可人工审核或重新解析；不得改原始 Capture 状态、补零或回退 V1。Agent/PDF/Semantic 最后一次崩溃也由 `sweepTerminalLeases` 收敛。会话取消标记不得由旧回合覆盖，已创建的采集批次不随会话取消。

完整数据库和证据卷备份必须包含新语义表、指标快照以及 `semantic/` 对象前缀；运行日志保留清理不得删除这些记录。更新前检查 `0019_visibility_v2.sql`，回滚不允许降级已有 V2 基线为 V1。详见 `docs/visibility-measurement-v2.md`。


## RBAC 成员生命周期排障

角色名称不是权限。核对 auth/me → 活动机构上限 → 角色权限 → 客户范围；创建需要 members.manage，菜单需要 page.members。只可分配自身权限和范围的子集。重复邮箱 409 提示搜索已有成员/恢复停用账号；恢复/重置后的旧 token 不应可用。自己修改密码需验证旧密码。

迁移 0020 不恢复旧权限、不改已有客户范围；机构上限变更不再破坏角色定义。默认机构的权限不足可能是配置，不得自动“修复”为全权限。审计按 member.created/disabled/restored/password_reset/password_changed 和 target_id 追踪，禁止记录密码。线上 Demo 测试账号已停用、独立测试机构封存，不要把它们当客户业务数据。

## RBAC V2 排障

事实源为 authorization_policies、permissions.enabled、organization_permissions、user_roles 和用户客户范围。先用无副作用 explain 核对当前主体与具体资源；can_manage 包含休眠配置权限，不能因为有效权限低就强行管理。Agent 授权失败不重试；unassigned 历史任务须重新发起，禁止人工冒充 service/local。封禁后新采集领取及定时监测/报告跳过该机构，原始证据不动；分享读取封禁时返回不存在。规则见 docs/rbac-v2.md。

## 全盘验收后的新故障分类

400=参数，404=资源/隔离，409=当前状态或配置前置条件，未知500只返回requestId，需查受保护日志。平台缺密钥409与供应商401分开，不能切模型假装成功。采集合同cloud-search.v2之前的记录可能包含中间输出，保留审计而不更新原行；新建批次验证，不能只重跑语义器。全功能验收和部署证据见 docs/full-audit-2026-09-06.md。
# 2026-09-06 审批与采集版本排障补充

审批成功但 continuationStatus=blocked 时，先保留已批准状态，检查下一阶段权限/前置条件，再由有权限成员显式继续；不要伪报审批失败或直接改 execution_actor。新批次应冻结编译时 adapter 版本，平台初始化只同步版本字段；遇到 capture_contract_changed/protocol_changed 保留原始记录并创建新批次，不覆盖 raw。机构封禁后语义队列不再领取新任务，已有上游请求不承诺取消。Demo 最终回归和外部未验项见 docs/full-audit-2026-09-06.md。

## SQLite 桌面执行边界（2026-10-04）

当前桌面为 React → Tauri IPC → 本机 Node 业务引擎 → 新 SQLite 工作区。模型/搜索/采集/网站分析/指标/内容质检/报告/调度均在客户端；云端只鉴权、权限管理与账户私有快照存储。代码事实源：`apps/desktop/src/engine.ts`、`src-tauri/src/local_engine.rs`、`packages/core/src/sqlite.ts`、`apps/worker/src/api-service.ts` 和 `desktop-storage.ts`。独立指标、证据页面保留，不迁移旧数据库或业务数据。

会话/工具账本/等待状态/租约落 SQLite；MemorySaver 仅回合内使用。结果不确定的工具停止自动重放并要求成员核查。关闭客户端会停止本机执行；鉴权断网 fail-closed。哈希分块 + CAS 同步不自动合并冲突，设备主密钥不上传，新设备重配 Provider Key。桌面公开分享暂未接静态托管，会明确拒绝创建无效链接，PDF/Word 本地导出仍可用。

完整开发、恢复、测试和限制见 `docs/desktop-agent.md`。云端新部署显式使用 `compose.desktop-cloud.yaml`，不启动业务 Workers；其余服务器拓扑与 PostgreSQL 操作章节仅适用于旧版兼容部署，不代表新桌面执行位置。
