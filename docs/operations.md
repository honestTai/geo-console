# 运行与故障处理

## 额度耗尽与官网证据

不要把跨采样窗口等待判断成死 Worker：看 `captureProgress.next_at/pending/active` 与真实 HTTP 状态。明确额度不足后，Capture Runner 即时或启动/每分钟清扫会将同批次同平台 pending/过期 leased 任务收尾为 failed；活跃租约不抢占。日志 `capture.quota_jobs_stopped` 与普通 `capture.stale_jobs_failed` 分开；不用 SQL 修改 Capture 或 config。余额补足不自动产生付费重跑，用户手动创建严格同条件复测，其他平台继续。

官网为空显示不适用；截图/PDF 失败看 `audit.screenshot_failed` / `audit.pdf_failed`，源证据保留，恢复浏览器依赖后新建审计，不回填旧记录。备份需同时包含 website_audits 的 JSON/哈希、对象文件及报告快照。详细症状、限制和发布检查见 `docs/website-audit-and-capture-recovery.md`。

## 完整回答语义分析队列

`answer_analysis` 是按需辅助解读，复用 Semantic Worker 独立 1 槽（正式测量另外 2 槽），无需新进程。最多 2 次技术尝试、5 分钟租约、30 秒续租/重试；`sweepTerminalLeases` 同步收敛耗尽的 job/run。看 `answer_analysis_runs.status/error_message`、执行策略和 jobs；failed/needs_review 由用户核对原文/模型后重生成，保留旧尝试，不改 Capture 或正式指标。备份包含新增两表的原始模型响应，视为敏感证据；没有自动付费历史回填。见 `docs/answer-analysis.md`。

## 健康检查

```bash
corepack pnpm geo doctor
curl -fsS http://127.0.0.1:3010/api/health
curl -fsS http://127.0.0.1:3020/health
docker compose ps
docker compose logs --tail=200 log-service api capture-worker agent-worker report-worker
```

服务器 release 安装后优先使用：

```bash
sudo geo-console doctor
sudo geo-console logs api
sudo geo-console logs log-service
sudo geo-console logs capture-worker
sudo geo-console logs agent-worker
sudo geo-console logs report-worker
```

`geo-console upgrade` 只允许服务器从 release 内本地构建的 Linux artifact/dist 重构镜像；日志中出现 pnpm、apt、Playwright download、Web build 或远程 pull 都表示发布协议错误。`restart` 只按顺序重启已有镜像，不重新构建。

健康响应会标识数据库类型、对象存储模式、HRouter 配置状态、云端采集模式和 Log Service 健康，不暴露 Key 或完整模型配置。

## 独立日志服务

Log Service 仅绑定本机 `127.0.0.1:3020` 或 Compose 内网 `log-service:3020`，不经 Caddy 暴露。API/Worker 使用 owner-only `log_service_token` 上报；服务不可用时业务继续运行并保留容器标准输出，恢复后进程内最多缓冲 500 条并重试。

本机 PGlite 模式由 API 进程组合执行 Capture/Agent/Report，Log Service 使用独立 `${GEO_DATA_DIR}/log-service/database`；不要手工再启动四个 Worker 指向同一 PGlite。`pnpm geo backup` 会在停服后同时复制业务 PGlite、日志 PGlite 和 artifacts。

工作台“运行日志”由 `page.service_logs` 控制，CSV 与保留清理由独立功能权限控制；超管可同时查看 system logs。查询使用游标逐页替换，不在浏览器或桌面端累积全部日志。默认自动删除 90 天前 `service_logs`。手工清理必须核对活动机构和天数，清理动作写 `audit_logs` 与 `logs.retention_pruned`，但不会删除 `query_captures`、raw、网页、报告或业务审计。

排查顺序：先检查 `/health`、数据库、`log_service_token` 文件权限与 API 的 `logService.status`，再看 `docker compose logs log-service`。不要通过公开映射 3020 绕过 API RBAC。

## 采集队列

Capture 任务状态为 `pending -> leased -> complete`，执行抛错时为 `pending`（30 秒后重试）或 `failed`（用尽 3 次），`last_error` 记录原因。进程退出后租约过期即可被其他 Worker 领取；租约过期且重试已用尽的任务由 Capture Worker 每分钟清扫为 `failed` 并刷新批次，所以批次不会永久停在“采集中”。供应商的鉴权、限流、超时、模型下线和协议变化会写入不可变 `QueryCapture`；不得补数或改写为成功。

排查部分批次时记录批次 ID、配置哈希、计划/有效/失败样本、按平台失败码以及 `failed` 任务的 `last_error`。先修复 Key、配额、网络或适配器，再创建新基线或严格复测。不要手工把未完成租约改成 `complete`。批次长时间“采集中”而 `jobs` 里没有 pending/leased 任务时，检查 Capture Worker 是否在运行（清扫也由它执行）。

周期监测到期创建批次失败时，`monitoring_schedules.last_error/last_error_at/failure_count` 记录原因与连续次数，运行日志事件 `schedule.batch_failed`，一小时后自动重试；AI 监测页在“周期监测”里提示，修正后重新保存计划即清除。常见原因：范围没有已批准问题、平台被停用、旧基线适配器版本过期（此时自动改为新建基线）。修改周期后下一次运行时间按上次运行时间加新周期重算，已到期则立即可运行。

## Report Worker

PDF/Word 请求创建 `report_document` 数据库任务；旧 `report_pdf` 任务仍可兼容领取。页面前台最多等两分钟，之后提示“仍在后台生成”并继续轮询快照，不会把仍在跑的任务报成失败；真正失败以任务 `status='failed'` 与 `last_error` 为准。排队超过两分钟时检查 Report Worker、Chromium、中文字体、对象存储写权限和任务 `last_error`。报告 payload 已冻结，不需要重建快照；修复环境后让任务按租约重试。PDF 和 Word 必须都存在才显示 ready。

Report Worker 每 15 秒检查一次定时监测最近完成的批次。手工和定时链路都使用同一个幂等工作流：创建叙述，等待人工批准；自动排队绑定的质量检查，再等待人工批准；通过后自动冻结并创建 PDF/Word。失败或拒绝后从当前阶段重试，不重复冻结同一叙述版本。质量检查结论为 blocked 时，页面按钮变为“重新生成叙述”（工作台 `advance_report` 同理）：再次推进会排队新的叙述而不是再质检一次；新叙述在途期间定时扫描只报告叙述状态，不会用旧叙述冻结。

## Agent Worker

Agent 请求只创建 `agent_draft` 数据库任务并立即返回。Agent Worker 每 250ms 尝试领取任务，默认同时执行两个以模型/联网等待为主的 I/O 任务，并优先领取浏览器调试入口的 `agent_session_turn`；正式桌面工作台回合不进入该队列，因此不受这两个槽位限制。每个服务端任务仍有独立 15 分钟租约和续期。页面展示排队、工具步骤、结构校验重试、Token、失败原因与待审批草稿。单次失败会在 30 秒后重试一次；不要手工把未完成任务改成成功。审批带状态守卫：同一草稿被手动和协调器同时批准时只有一次生效，另一次返回“已被其他操作处理”，属正常并发，不是故障。

报告口碑来源校验失败时先对照 Capture `sources` 和 `source_visibility`。不得把任意网页 URL 写进口碑信号；平台未开放来源时保留 `unavailable`。质量检查引用过期的叙述 run 时应重新排队检查，不能手工改 run ID。

Agent 的 `web_search` 工具依赖 HRouter 透传 OpenAI `web_search`。工作台里“联网搜索”步骤反复报“未触发”或 HTTP 4xx 时，先到平台设置点“测试联网搜索”或在工作台模型旁点“测试此模型”（`POST /api/settings/hrouter/test-web-search`，可带 `model`，不落证据，结果按模型记住并在工作台选模型时提示）；未触发通常是 HRouter 或所选模型不支持该工具，换模型或联系 HRouter，不要改代码伪造结果。工具默认强制调用（`tool_choice:{type:"web_search"}`），只有 4xx 正文明确指向 `tool_choice` 参数时才自动回退 `auto`，其他 4xx 不重复请求。工作台一次研究会把 2–4 个独立问题放在同一批工具调用中并行搜索，单次归纳最多 1200 output token；每次搜索（含失败）仍分别落在 `web_search_evidence` 并计费，是证据，不作为日常修复的删除对象。证据中心“联网搜索”分区可查；只有 `status='complete'` 的记录可被草稿引用。

联网搜索有硬上限：工作台每回合 8 次、每会话 30 次，`prompt_research` 草稿每次运行 10 次，超出直接拒绝；同一回合连续两次“未触发/失败”后 Agent 会收到“联网不可用”并改用官网快照与知识库出题（工作台日志会显示）。费用敏感的会话可在会话设置里关闭“联网搜索”。建档分析在请求返回后于 API 进程后台为每个竞品候选做一次联网核实并回写 `competitors.verification`（期间为 `pending`，建档页显示“联网核实中”并轮询），未通过的候选标为“待确认”，联网不可用时标“未联网核实”。API 在核实中途重启会让候选停留在 `pending`，前端 10 分钟后按“未核实”展示；重新点“开始官网分析”会复用 24 小时内的快照并重新核实。

## AI 工作台

会话状态：`idle`（等待指令）、`running`（Agent 回合执行中）、`waiting_user`（等待成员回答问题、在候选问题表格里确认，或手动审批）、`waiting_job`（等待批次/Agent run/报告 PDF 完成）、`done`、`failed`。候选问题确认由服务端直接写入监测范围（`agent_session_events` 里是 `proposal` → `step(scope)` + `user_answer(applied=true)`），成员确认失败时错误直接返回给页面，会话仍停在 `waiting_user`，可重新确认。桌面 `execution_target='desktop'` 会话由创建者客户端领取 60 秒租约，本地 Agent 直接渲染文本流，最终消息、工具进度和状态回写服务器；`desktop_agent_tool_calls` 以 `session_id + tool_call_id` 保存参数 hash、180 秒工具租约和幂等结果，崩溃重连只补缺失的 toolResult。浏览器兼容会话继续通过最长 25 秒的 events 长轮询接收增量；桌面也用该路由恢复服务端事实。协调器每 5 秒检查等待对象：桌面会话只写待领取的 `desktop_pending_*`，浏览器会话才入队 `agent_session_turn`，两者都更新 `plan`。桌面卡在 `running` 时先看 `desktop_run_id/client_id/lease_expires_at/pending_trigger`、最后的 transcript 与工具调用表；过期租约允许原客户端或同账号另一客户端重新领取。会话卡在 `waiting_job` 时再看批次、Agent run 或报告对象本身。不要手工修改 `transcript`、`plan` 或工具调用结果；终止会话只改状态，不会取消已排队的批次。

优化文章 run（`purpose='optimization_article'`）到 `awaiting_approval` 后由协调器自动物化到 `optimization_articles`，失败会写 `error_message`；重新生成会覆盖同一建议的文章并递增 `version`。“生成文章”只把绑定当前已批准叙述的在途 run 视为重复；叙述重生成后旧叙述的 run 不会挡住新文章。

## 多租户与权限

权限排查按机构授权上限 -> `roles/role_permissions` -> `user_roles` -> `users.all_projects/user_project_access` 顺序进行。页面导航来自 `permissions`，API 来自 `permission_routes`；未登记路由默认 403。历史 `users.role` 不再决定授权，不要通过修改该字段修权限。

系统只能有一个超管。超管通过活动机构 Cookie 显式切换后，项目、证据、报告和 Artifact 仍必须属于该活动机构；普通成员还要命中自己的客户范围。遇到 404 时同时核对 home organization、活动 organization、资源 `organization_id/project_id` 和用户客户范围，不要改数据库归属绕过。

封禁机构会设置 `organizations.suspended_at/reason` 并撤销该机构所有非超管会话。解封不会恢复旧会话，用户必须重新登录。误封恢复时先由唯一超管解封，再验证机构授权、用户角色和客户范围；不要直接清空 session 或把普通用户提升为超管。

Provider/HRouter 凭据继续按机构隔离；环境变量 Key 只对默认机构提供引导 fallback。

## 桌面客户端

正式产品使用 Tauri 2 客户端，浏览器暂时保留服务端执行的工作台用于调试。客户端 User-Agent 为 `ZZGeoDesktop/<version>`；桌面专用路由还要求 `x-geo-client: desktop`。WebView 内运行交互 Agent，模型流经原生 Channel 转发，业务工具仍在服务器鉴权并执行。页面和 API 继续使用服务端会话、动态权限和活动机构，客户端不保存业务数据库、证据文件或 Provider/HRouter Key。PDF/Word、采集、后台草稿与定时报告由服务端 Worker 完成，关闭桌面不会中断这些已排队任务。

应用内更新只接受 `tauri.conf.json` 内 GEO 公钥验证通过的 HTTPS 更新清单和签名包。更新故障先检查清单是否为有效 SemVer、目标平台/架构、下载 URL 和 `.sig` 内容，再检查客户端版本；不要关闭签名校验或复用其他产品私钥。

## 漂移与费用

复测相对正式基线下降至少 10 个百分点时生成漂移告警，20 个百分点为高等级；基线或复测中没有成功回答的平台（鉴权失败、限流）不参与比较，不会因“0%”产生假告警——这类平台看批次失败码而不是告警。确认告警不会删除证据。费用只有供应商明确返回时才汇总金额；否则展示请求和 Token，并标注费用未知。

整改任务验收：技术类任务（诊断类别含“技术”或验收标准要求重跑官网审计）点“重跑审计验收”，审计仍有阻断项则拒绝；其余任务填写发布地址后“抓取验收”，地址必须在客户官网域名（含子域名）下，第三方页面直接拒绝。“已验收”不能在状态下拉里手工选择。

## 备份恢复

本机备份前停止 `pnpm geo start`，再运行 `corepack pnpm geo backup`。服务器使用 `docker compose --profile backup run --rm backup`。数据库与本地证据卷必须同一时间点恢复；S3 模式应先验证对象版本仍存在。

恢复必须进入新建空 PGlite/PostgreSQL，运行健康与证据抽查后再切换。不要直接覆盖唯一实例。服务器 release 与应用镜像至少保留到回滚窗口结束，但仅切换应用版本不能撤销不兼容数据库迁移。

## 证据保留

默认永久保留 `query_captures`、网页快照、原始响应、报告快照和 `audit_logs`。`service_logs` 默认保留 90 天，可按机构清理。问题知识库归档只写 `archived_at`。客户或租户删除请求属于破坏性操作：先解析准确 organization/project ID、报告关联、对象前缀、审计要求和备份状态，再获得明确确认。


## V2 语义队列与恢复

新增 `semantic-worker`，本机由 `local-workers.ts` 组合运行，禁止对同一 PGlite 目录另起进程。成功 API Capture 才进入 `semantic_parse`；两个槽位、500ms 领取、5 分钟租约、30 秒续期、最多两次尝试、30 秒重试。5 秒协调周期负责排队、耗尽租约清扫、指标快照与配对漂移。Capture complete 不代表 analysis ready。

卡住时查看 `semantic_parse_runs.status`、job 的 attempts/lease/last_error、机构 HRouter 模型/Key 与语义观察校验原因。证据中心可人工审核或重新解析；不得改原始 Capture 状态、补零或回退 V1。Agent/PDF/Semantic 最后一次崩溃也由 `sweepTerminalLeases` 收敛。会话取消标记不得由旧回合覆盖，已创建的采集批次不随会话取消。

完整数据库和证据卷备份必须包含新语义表、指标快照以及 `semantic/` 对象前缀；运行日志保留清理不得删除这些记录。更新前检查 `0019_visibility_v2.sql`，回滚不允许降级已有 V2 基线为 V1。详见 `docs/visibility-measurement-v2.md`。


## 不能创建成员 / RBAC 排障

先核对 `/api/auth/me` 的 `isSuperAdmin`、活动机构、有效 `permissions` 和 `allProjects/projectIds`，不要凭角色名称判断权限。普通成员需要机构上限和角色同时包含 `page.members`、`members.manage`；`GET /api/users/options` 返回可分配角色/客户，不是全部机构角色。没有候选时先核对权限，不要临时给所有权限。

重复邮箱返回 409；停用账号在成员列表搜索后恢复，不能再创建同邮箱。恢复必须重新登录，旧 token 不会恢复；管理员重置密码会撤销该成员全部会话，自己修改密码需旧密码且撤销其他会话。所有成员变更记录带目标 user id 的审计，不含密码。403 表示超出管理权限/客户范围或目标受保护，不能按网络故障重试。

机构上限仅收窄有效授权，不删除角色定义；重新授权后重新取交集。`0020_membership_rbac.sql` 不恢复此前已被旧代码删除的角色权限，需超管明确审核后配置。默认机构的现场实测和隔离测试资源处理记录见 `rbac-demo-verification-2026-09-06.md`。

## 授权 V2 运行诊断

遇到 403/404、成员不可管理或后台权限失败，先用超管“权限配置 → 授权引擎 → 授权诊断”检查实际用户、机构、路由、资源、AND/OR 及配置版本。不要通过手工赋超管、清空策略或把 execution_actor 改为 local 修复。后台授权失败直接终止，恢复权限后需要用户重新发起；不自动重播已被拒绝的写入。封禁跳过新监测/采集领取/定时报告并暂停公开分享读取，已有证据不删除。登录改密使用 credential_version，解封/恢复不会复活旧 token。迁移与已知限制见 docs/rbac-v2.md。

## 全功能验收与采集协议升级

cloud-search.v2 是最终回答/引用提取修正，不是重写旧 evidence。旧合同 API 返回 capture_contract_changed；请新建批次，不要改 query_captures 或把旧指标当当前结论。报告流程收到 409 应先检查配置、协议及审批前置条件；真正 500 仅显示 requestId，在受保护日志中排障。Demo 升级先把 dump 恢复到独立临时 PostgreSQL 验证 migration/idempotency，切换前再次成对备份。2026-09-06 的全功能结果与外部条件见 full-audit-2026-09-06.md。
# 2026-09-06 全功能验收运行补充

最终 Demo 应用版本 a8e8cd284ee0-dev-20260906T063820Z，迁移 0022，adapter cloud-search.v2；此记录不替代后续运行时 health/doctor。旧合同批次不能重解析为当前分数，应创建新批次并保留原始证据。审批接口 approved=true 但 continuationStatus=blocked 表示审批已落库，需有下一阶段权限的成员显式续跑，不应反复提交审批或修改执行者绕过权限。机构封禁暂停新的语义任务领取/调用，不保证取消已发出的模型请求。实测、限制与清理记录见 docs/full-audit-2026-09-06.md。
