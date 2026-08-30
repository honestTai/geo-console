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

失败状态包括 `auth_required`、`rate_limited`、`timeout`、`search_not_triggered`、`no_answer`、`model_unavailable`、`protocol_changed` 和 `failed`。Provider 失败时禁止静默切换其他模型。

## 变更要求

1. 只在对应适配器中修改供应商字段映射。
2. 协议或提取语义变化必须提升 `ADAPTER_VERSION` 或搜索工具版本。
3. 契约测试至少覆盖正常回答、无来源、未触发搜索、限流、超时、鉴权失败、模型下线和协议变化。
4. 原始响应始终完整写入对象存储，解析结果写 `QueryCapture v2`。
5. 真实验收只使用用户提供的 Key，不提交问题、回答、Key 或验收项目。
