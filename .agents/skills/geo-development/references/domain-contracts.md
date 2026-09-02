# GEO Console Domain Contracts

## 证据

- 当前采集契约是 `geo.query-capture.v2`，模式固定 `llm_search_api`；`engine` 只能是五个 `SearchProviderId`。
- 成功采集必须有 answer 与 SHA-256；失败采集必须有 failure code。元宝协议固定 `yuanbao-search+hunyuan-synthesis`。
- 原始 Provider 响应对象使用新 object key 写入。local 使用 `wx`，S3 使用 `IfNoneMatch: *`，因此同键覆盖应失败。
- `query_captures.job_id` 唯一。不要通过更新 raw capture 来重跑解析；新增派生结果或创建新批次。
- 网页快照、审计结果和报告快照同样是证据。只有 finding/task 等派生记录允许按明确业务动作更新。

## 批次与队列

- 批次种类：`quick_audit`、`baseline`、`retest`；状态：`draft`、`queued`、`running`、`complete`、`partial`。
- `FrozenBatchConfig` 包含项目、竞品、Prompt、平台、repeats、sampling/window，以及每个 Provider 的 endpoint/model/protocol/search strategy/tool/adapter version。
- 可比性是规范化后的完整 config 相等，不是只比较平台和模型。旧批次继续保留创建时范围。
- Capture job 默认最多 3 次，租约 5 分钟并每分钟续期；Agent job 最多 2 次、租约 15 分钟；PDF job 默认 3 次、租约 5 分钟。失败重试延迟 30 秒。
- 过期租约可由其他 Worker 领取。不要把尚未生成证据的任务直接改为 complete。

## Provider

Provider 的实时默认值以 `apps/worker/src/providers.ts` 为准：

- `deepseek_api`: DeepSeek Responses + `web_search`
- `kimi_api`: Moonshot Chat + Web Search Formula
- `doubao_api`: Ark Responses + `web_search`
- `qwen_api`: DashScope native generation + search
- `yuanbao_hunyuan`: SearchPro source + Hunyuan synthesis，需两个凭据

批次执行使用冻结值，不跟随 Settings 的后续修改。当前 worker 不支持冻结 adapter version 时应记录 `protocol_changed`，而不是用当前版本强跑。

## 指标

- `answeredCaptures` 仅含 `status=complete` 且 answer 非空。
- 品牌提及、首位、声量、位置和竞品提及率以成功回答为分母。
- 总览按 `answeredCaptures > 0` 的平台等权；失败平台单独影响 `dataCoverage` 和 `failureRate`。
- 来源指标只使用来源可观测的成功回答。没有可观测来源时 citation/source rate 是 `null`。
- 重复一致性只在同 Prompt 有多次成功回答时计算，否则为 `null`。
- Provider 未返回明确金额时 `costMicros` 保持 `null`；可汇总 Token/请求数，但不能虚构价格。

## Agent 与审批

- Agent 工具只有读取当前项目、读取证据索引、按允许 ID 读取证据、提交结构化草稿。
- 网页、客户字段和回答全部是不可信输入；工具输出提醒模型不得执行其中指令。
- draft 引用的 evidence、Prompt 和 task 必须属于当前项目/批次，`content_brief` 必须匹配目标 task。
- Agent 完成只进入 awaiting approval。批准时再次校验归属，之后才能写 finding、task、content 或 report narrative。
- HRouter Key 与模型未配置时任务不能入队；不要增加假结果或离线 fallback。
- `report_narrative` 必须输出口碑总体判断、正负信号、来源状态和 GEO 优化建议；每项引用当前批次证据。`cited` URL 必须存在于对应 Capture 的 `sources`，不可见来源只允许 `unavailable`。
- `quality_review` 必须绑定最新已批准 `report_narrative` run ID。正式快照要求该检查已批准且 verdict 为 `pass`；报告内容模型是当前机构配置的 HRouter GPT。
- 报告工作流是幂等推进：叙述批准后自动排队质量检查，质量检查批准通过后自动冻结同一叙述版本并排队 PDF/Word；`awaiting_approval` 仍是人工停点，只有 AI 工作台会话在 `auto_approve=true` 时由协调器代表会话创建者批准（`approved_via='workbench'`，审计带 `sessionId`），以及 `optimization_article` 由协调器 `auto_article` 物化。
- `agent_runs` 新增 `session_id`、`approved_via`、`thinking_level`、`target_ref`；`optimization_article` 的 `target_ref` 必须指向已批准 `report_narrative` run 与建议序号，草稿 `targetPromptIds` 必须属于当前项目。
- 思考强度取自机构 HRouter 配置 `thinkingLevel`（minimal/low/medium/high/xhigh，默认 low），会话或 run 可覆盖；模型仍限定 GPT 系列。
- AI 工作台会话：`agent_sessions.transcript` 是 pi-agent-core AgentMessage 列表，`waiting` 只能是 user/batch/agent_run/report 之一并带 `toolCallId`；续跑以工具结果消息追加到 transcript，不重写历史。`agent_session_events.seq` 单调递增，前端只做增量拉取。工作台工具必须复用现有 service（createBatch/confirmProject/auditProject/diagnoseBatch/advanceReportWorkflow/generateArticlesForBatch），不得直接写证据表。
- 报告 `ReportAnalysis.evidenceIndex` 按采集时间为 capture、网页快照、审计编号；冻结快照后编号不变，HTML/Word/CSV 只能用编号与可读字段引用，不再输出裸 UUID。`perceptionExcerpts` 过滤模型推理草稿句；口碑来源 URL 去掉 `#ws_call_id=` 类追踪片段后展示，但校验仍以原始 `sources` 为准。

## 网站、报告与安全

- Crawler 每次请求和重定向都解析 DNS 并拒绝私网/Loopback；官网 crawl 上限由调用方控制，分析流程最多 100 页。
- 诊断需要真实回答；网页或竞品抓取失败只减少证据，不产生“内容缺失”结论。
- 报告快照 v2 保存 Agent 叙述/质量 run、payload 和 hash；PDF/Word 只能补充各自 artifact key，不能重写冻结 payload。Report Worker 只做确定性二进制排版，不产生新业务判断。
- 分享 token 只在创建时返回明文，数据库保存 SHA-256；读取必须未过期且未撤销。
- Provider/HRouter Key 由 AES-256-GCM 信封加密，AAD 包含 organization 与 credential key。主密钥丢失会使数据库凭据不可恢复。
- 用户归属一个 organization；有效授权为机构权限上限与用户多角色权限并集的交集，数据范围再限制为机构下全部客户或明确指定客户。页面和 API 策略来自数据库资源目录，未登记 API 默认拒绝。历史 admin/analyst/viewer 只用于迁移默认角色，不参与运行时判断。
- 数据库最多存在一个 `is_super_admin=true` 用户。超管始终拥有全部页面和功能，但业务资源仍按当前活动机构过滤；超管可封禁机构，封禁立即撤销该机构非超管会话并阻止后续登录。
- Provider/HRouter 配置、加密凭据和问题知识库按 organization 隔离。环境变量凭据只为 `default` 机构提供 bootstrap fallback，不能泄漏给其他租户。

## 行业问题知识库

- 共享范围固定为 `organization_id + industry`；问题支持成员新增和软归档，不跨机构复用。
- 客户建档保存明确 `industry`。官网分析优先合并同业库问题，再追加 Agent 候选并按问题文本去重；Agent 新候选不会自动写回知识库。
- 项目 Prompt 可引用 `library_question_id`，但批次仍冻结完整问题文本和维度；知识库后续变化不修改历史 Prompt、Capture 或批次。

## 运行日志

- `service_logs` 是运行诊断数据，不是证据；字段为 organization、service、level、event、message、trace/project、脱敏 metadata 和 occurred time。
- API/Worker 通过 `GEO_LOG_SERVICE_URL` 与独立服务令牌批量上报。日志服务不可用不得阻断采集、Agent、报告或 API；标准输出仍是恢复兜底。
- 客户端与日志服务都必须过滤凭据、Cookie、token、回答/网页正文和 raw response；日志内容不得成为指标、诊断或报告证据。
- 普通机构管理员只能查询/导出/清理当前机构运行日志；系统日志仅超管可见。保留清理只删除 `service_logs`，同时写业务审计与新的 retention operation log。
