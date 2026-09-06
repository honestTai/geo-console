# 五平台联网适配器契约

统一接口位于 `packages/search-providers`。每个适配器实现连接测试、能力声明和一次真实采集；页面、指标和报告不直接解析供应商响应。

| Provider ID | 协议 | 强制搜索 | 口径声明 |
| --- | --- | --- | --- |
| `deepseek_api` | DeepSeek Responses + `web_search` | 是 | 不等同 DeepSeek App |
| `kimi_api` | Moonshot Chat + `moonshot/web-search` Formula | 是 | 不等同 Kimi App |
| `doubao_api` | 火山方舟 Responses + `web_search` | 是 | 不等同豆包 App |
| `qwen_api` | DashScope 原生 Generation + `enable_search` | 是 | 不等同通义 App |
| `yuanbao_hunyuan` | SearchPro 搜索 + 混元 Chat 合成 | 是 | 不是元宝 App 回答 |

适配器返回回答正文、品牌位置、来源、Query Fan-out、来源可见性、模型、协议、搜索工具版本、适配器版本、Request ID、Token、成本、延迟、原始响应和失败原因。未开放来源或 Fan-out 时返回 `unavailable`，不得构造空值后按 0 参与指标。

Provider config 与加密凭据按 `organization_id` 隔离。创建批次时只读取项目所属机构的已启用配置并冻结公开契约；Capture Worker 执行冻结契约时仍按该机构读取对应密钥。环境变量/Secret 文件仅作为 `default` 机构的 bootstrap fallback，非默认机构缺少自身加密凭据时必须返回真实鉴权配置失败，不得借用其他租户或默认机构 Key。

失败状态包括 `auth_required`、`rate_limited`、`timeout`、`search_not_triggered`、`no_answer`、`model_unavailable`、`protocol_changed` 和 `failed`。Provider 失败时禁止静默切换其他模型。适配器返回失败结果与适配器本身抛错是两回事：前者作为失败 Capture 落证据，后者由 Capture Worker 走 `failJob`（重试或标记任务失败）并刷新批次，两者都不会让批次停在“采集中”。

## 变更要求

1. 只在对应适配器中修改供应商字段映射。
2. 协议或提取语义变化必须提升 `ADAPTER_VERSION` 或搜索工具版本。提升后旧基线不能再创建复测（`createBatch` 直接拒绝，周期监测自动改为新建基线），发布说明里要提醒客户新建正式基线。
3. 契约测试至少覆盖正常回答、无来源、未触发搜索、限流、超时、鉴权失败、模型下线和协议变化。
4. 原始响应始终完整写入对象存储，解析结果写 `QueryCapture v2`。
5. 真实验收只使用用户提供的 Key，不提交问题、回答、Key 或验收项目。

## V2 测量接入（2026-09-05）

本轮不修改外部 Provider 协议或切换模型。新采样任务冻结稳定 `sampleKey`，Capture 提交在事务内验证任务范围与有效租约，原始证据仍只追加。原始 `brandMatches` 仅为历史/文本标记，不再参与推荐排名或指标计算；成功 API 回答由独立 Semantic Worker 按冻结的语义契约解析，指标来自 V2 MetricSnapshot。Provider 失败与语义失败分别计入覆盖率，不能伪造回答或把解析失败当未提及。详见 `visibility-measurement-v2.md`。

## 2026-09-06 Responses 提取修正

当前 ADAPTER_VERSION=cloud-search.v2。DeepSeek/豆包只能采用最后完成的 assistant/output_text；reasoning_text、工具结果、中间消息、incomplete 输出不能当回答。source.isCitation 仅由最终回答 annotations/明确 Markdown 链接证明；成功浏览 URL 可观测但不是引用，失败工具 URL 排除，query/queries 均记录并去重。来源未知仍 unavailable，不能靠任意 URL 推断搜索已执行。全盘实测发现的旧污染记录保留原样，仅新批次采用新合同；报告口碑也只接受回答中 isCitation=true 的 URL。见 full-audit-2026-09-06.md。
