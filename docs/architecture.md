# 架构与数据边界

## 运行组件

```text
React Web :3000
    | /api
Worker :3010 ---- PGlite（本机）/ PostgreSQL（服务器）
    | Collector HTTPS/Loopback 协议
Collector :3020 ---- 专用 Playwright Profile ---- DeepSeek / Kimi 消费端页面
```

- `apps/web`：中文工作台，不内置业务数据。
- `apps/worker`：客户建档、官网抓取与审计、DeepSeek 结构化分析、任务租约、周期调度、指标、网页差距、整改、归因与报告 API。
- `apps/collector`：唯一允许接触平台 Cookie 的进程；每个平台单并发执行真实页面采集。
- `packages/core`：Drizzle PostgreSQL Schema、同一份 SQL 迁移、PGlite/PostgreSQL 连接和租约队列。
- `packages/evidence`：Collector 与 Worker 共用的不可变证据协议。
- `packages/metrics`：从成功与失败样本确定性计算平台指标。
- `packages/surface-adapters`：页面适配器接口与失败分类。

## 关键不变量

### 证据不可变

`query_captures.job_id` 唯一。Collector 提交后只允许新增，不允许覆盖；截图使用排他创建。页面解析变化时基于原证据重新计算派生数据，而不是修改原始回答。

### 批次可比

`experiment_batches.config` 冻结客户名称和域名、地区、语言、竞品、问题、平台、重复次数与采集版本。复测直接复制基线配置，不读取项目当前可编辑值。配置不同不得生成直接变化结论。

当前竞品和问题使用 `archived_at` 做范围版本化。保存新范围会创建新 ID，旧行继续服务于原批次、证据与报告；只有未归档行可进入新基线。

### 平台透明

DeepSeek 与 Kimi 分别计算回答覆盖率、品牌提及率、首位推荐率、官网引用率、平均位置和竞品提及率。总览只按平台等权汇总，同时显示计划、有效和失败样本数。

### 无替代结果

`login_required`、`challenge_required`、`rate_limited`、`page_contract_changed`、`timeout` 和 `no_answer` 都是有效的真实结果状态。Worker 和 Collector 均不得用模型 API 或固定文本填补失败。

## 数据流程

1. 用户创建任意行业客户，提供名称、官网、地区和语言。
2. Worker 阻止内网 URL，抓取 Sitemap 和最多 100 个同域 HTML 页面，保存快照与哈希。
3. DeepSeek 只能根据抓取内容生成画像、竞品候选和购买问题。
4. 用户编辑并确认后，项目才可建立基线。
5. Worker 冻结批次并按问题、平台和重复次数创建租约任务。
6. Collector 新建对话、等待回答稳定、提取正文与引用、保存全页截图。
7. Worker 按平台计算指标，并抓取客户页、竞品页和真实引用页做已确认主题覆盖对比；诊断结论必须同时引用存在的证据 ID 和问题 ID。
8. 整改任务生成简报和初稿，用户审核发布并回填 URL；系统重新抓取验收。
9. 复测复制基线条件，报告陈述样本变化与黑盒局限；不同配置只进入各自趋势。
10. GA4、GSC、表单、电话或业务台账以不可重复的真实 CSV 导入，报告与 AI 指标并列展示，不自动推断因果。

## 安全边界

- 本机仅绑定 `127.0.0.1`。
- 服务器由 Caddy 提供 HTTPS 与 Basic Auth。
- Collector 使用独立、可撤销、只保存哈希的节点令牌。
- Cookie 和 Profile 永不上传到 Worker。
- 官网抓取拒绝 loopback、私网、链路本地地址和非 HTTP(S) 协议。
- API Key 本机使用 macOS Keychain，服务器使用只读 Docker Secret 或环境变量。
