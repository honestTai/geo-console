# 架构与数据边界

## 运行组件

```text
浏览器 -> Caddy HTTPS -> React Web
                    -> API :3010 -> PostgreSQL
                                  -> S3 兼容证据存储
                    Capture Worker -> 五家联网 API
                    Report Worker  -> Playwright PDF
```

本机使用同一业务代码，数据库切换为文件持久化 PGlite，对象存储切换为用户数据目录。`pnpm geo start` 启动 API、Capture Worker、Report Worker 和 Web。

- `apps/web`：客户建档、监测、证据、审计、诊断、整改、归因、报告和平台管理 UI。
- `apps/worker/src/index.ts`：机构会话、角色、项目 API、周期调度和审计日志。
- `capture-worker.ts`：按数据库租约领取 `capture` 任务，只调用冻结配置中的供应商。
- `report-worker.ts`：领取 `report_pdf` 任务，以固定中文字体生成 PDF 后写对象存储。
- `packages/search-providers`：五个平台的真实 API 协议与失败分类。
- `packages/evidence`：`QueryCapture v1/v2` 不可变证据契约。
- `packages/metrics`：品牌匹配后的确定性指标与等权平台汇总。
- `packages/core`：PGlite/PostgreSQL 共用迁移、Schema、租约、信封加密和批次可比性。

旧 `consumer_surface` 证据仍可只读查看。新批次只创建 `llm_search_api` v2 证据；两种口径不会进入同一个冻结批次或趋势比较。每个新批次冻结端点、模型、协议、搜索策略、搜索工具和适配器版本，Capture Worker 只读取该冻结契约；缺少完整契约的历史基线不能用于新复测。

## 核心流程

1. 抓取客户 Sitemap 及最多 100 个公开同域页面，拒绝私网、Loopback 和非 HTTP(S) 地址。
2. HRouter GPT 仅根据网页证据生成画像、竞品候选、主题、Persona 和购买问题；用户确认后项目才启用。
3. 快审固定每平台每题 1 次。正式基线默认 3 次并分布在 0、4、24 小时窗口。
4. 批次冻结客户、竞品、问题、平台、模型、协议、搜索策略、地区、重复次数、时间窗口和适配器版本。
5. Capture Worker 保存回答、来源、Query Fan-out 可见性、原始响应、Request ID、Token、延迟、成本可见性、内容哈希和失败码。
6. 指标由代码确定性计算；Pi Agent 只能用项目、指标和证据领域工具生成草稿。
7. 人工批准诊断、整改、内容和报告叙述。系统不自动发布或修改客户网站。
8. 已发布 URL 重新抓取验收。复测必须复制正式基线完整配置。
9. 报告先冻结 payload 与 SHA-256，再异步生成 PDF、CSV、JSON或可撤销分享链接；定时监测批次结束后，Report Worker 自动冻结对应报告并排队生成 PDF。

## 不变量

### 原始证据不可变

`query_captures` 及 `raw_artifact_key` 指向的对象只新增不覆盖。解析变化时重算派生数据；不修改回答、来源或失败状态。S3 桶应开启版本控制和服务端加密。

### 失败不拉低品牌率

品牌提及、首位推荐和声量只在有回答的平台内计算。总览等权汇总有效平台，并同时显示有效平台数、数据覆盖率和失败率。来源不可见时引用率为 `null`，不是 0。

### 可比性严格

复测只能选择 `baseline`。项目范围或平台配置变化会建立新基线。快审、正式基线和复测永不直接比较。

### Agent 最小权限

Pi SDK 没有 Bash、任意文件、任意 SQL 或开放 HTTP 工具。网页和回答被标记为不可信内容。草稿中的证据 ID、问题 ID 和任务 ID必须属于当前项目；未知 ID 拒绝入库。

### 口径透明

DeepSeek、Kimi、豆包和通义是官方联网 API 结果。元宝平台固定显示“元宝搜索源 + 混元合成”。任何 API 结果都不冒充消费端 App。

## 安全边界

- 服务器仅暴露 Caddy 80/443；API、Worker 与 PostgreSQL 留在 Compose 网络。
- 管理员、分析师和只读角色由 HttpOnly、SameSite=Strict 会话保护。
- 供应商 Key 使用 AES-256-GCM 信封加密；主密钥由 Docker Secret 或 KMS 挂载文件提供。
- 分享链接仅存哈希，可设置过期并撤销。
- 所有写 API、Agent 审批和成员变更进入审计日志。
