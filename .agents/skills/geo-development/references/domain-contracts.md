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

## 网站、报告与安全

- Crawler 每次请求和重定向都解析 DNS 并拒绝私网/Loopback；官网 crawl 上限由调用方控制，分析流程最多 100 页。
- 诊断需要真实回答；网页或竞品抓取失败只减少证据，不产生“内容缺失”结论。
- 报告快照保存 schema version、payload、payload hash；PDF 只能补充 `pdf_artifact_key`，不能重写冻结 payload。
- 分享 token 只在创建时返回明文，数据库保存 SHA-256；读取必须未过期且未撤销。
- Provider/HRouter Key 由 AES-256-GCM 信封加密，AAD 包含 organization 与 credential key。主密钥丢失会使数据库凭据不可恢复。
- 生产环境必须有 bootstrap admin secret；Session Cookie 为 HttpOnly、SameSite=Strict、Secure，角色为 admin/analyst/viewer。
