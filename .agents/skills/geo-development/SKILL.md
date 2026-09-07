---
name: geo-development
description: Develop or review GEO Console application code, including the Web/API, cloud-search adapters, evidence and metric contracts, capture/Agent/report workers, website analysis, remediation, attribution, migrations, and tests. Use for feature or code work; use geo-operations for an existing-instance incident and geo-deployment for environment setup or releases.
---

# GEO Console Development

以仓库当前代码和迁移为事实来源，不从产品描述推断尚未实现的能力。

## 开始工作

1. 先读 [references/project-map.md](references/project-map.md)，确认改动的所有者和跨模块调用链。
2. 涉及批次、采集、指标、Agent、报告、网站证据、身份或凭据时，再读 [references/domain-contracts.md](references/domain-contracts.md)。
3. 涉及 Web UI 结构、组件拆分、antd 组件选用、分页/反馈/密度规则时，读 [references/frontend.md](references/frontend.md)。
4. 跨模块改动读 [../../../docs/architecture.md](../../../docs/architecture.md)；Provider 改动同时读 [../../../docs/search-provider-adapters.md](../../../docs/search-provider-adapters.md)。
4. 符合重大功能变更标准时，编辑前读 [references/drift-control.md](references/drift-control.md)，记录 pre-task Git ref 和影响面。
5. 检查受影响代码和现有测试后再编辑。不要只改 UI 类型或只改数据库一端来掩盖契约不一致。

## 开发边界

- 使用 Node.js 24、`corepack pnpm` 和 workspace 依赖；不得绕过 `pnpm-workspace.yaml` 的供应链限制。
- 运行时代码必须适用于任意客户和行业。不得加入 Mock 回答、Seed 指标、示例公司或行业默认值；测试夹具必须明确只存在于测试中。
- 新采集只写 `geo.query-capture.v2` / `llm_search_api`。旧 `consumer_surface` v1 证据只读，不能和 v2 批次或趋势混算。
- `query_captures`、Provider 原始响应、网页快照和报告快照是证据。只追加，不覆盖或“修正”；重新解析只生成派生结果或新批次。
- 批次创建时冻结客户、竞品、Prompt、平台、重复次数、时间窗及完整 Provider 契约。复测必须逐字段复用正式基线 `config`；任何配置变化都创建新基线。
- Provider 失败必须保留为该 Provider 的真实状态，不得切换模型、平台或用合成结果补齐。来源或 Fan-out 不可见时保留 `unavailable`，不是空数组代表的 0。
- 指标仅使用 V2 MetricSnapshot：原子语义必须经原文与品牌白名单校验，先问题等权再达标平台等权。采集/解析/问题覆盖独立，正式漂移必须有共同问题配对区间；禁止 V1 首次提及排名回退，未知费用保持 `null`。实现细节见 `references/domain-contracts.md` 与 `docs/visibility-measurement-v2.md`。
- 完整回答辅助解读独立于正式指标：只追加 `answer_analysis` 运行/尝试，按需收费，全文片段与品牌归属校验，不能把辅助情感/理由写回正式排名。Python 仅离线评测，不给业务 Agent 任意代码执行能力；见 `docs/answer-analysis.md`。
- 授权扩展统一使用 `packages/authorization` 和 Worker `authorization/`；单 SQL 主体、credential_version 会话、显式异步执行者及逐工具策略不得绕过，细节见 `docs/rbac-v2.md`。
- 成员管理必须在服务端事务内限制可授予角色/客户范围，不能以 members.manage 间接提升权限；默认角色用稳定 system_key，机构授权上限不删除角色定义。账号生命周期与前端状态规则见 domain-contracts/frontend。
- HRouter Agent 只能读取当前项目的领域数据并提交待审批结构化草稿。不得增加 Bash、任意文件、任意 SQL 或开放 HTTP；审批时重新校验证据、Prompt、任务和项目归属。
- 网站抓取必须继续阻止私网、Loopback、非 HTTP(S) 和重定向后的内网目标。抓取失败表示证据不足，不能推断页面没有内容。
- 官网为选填；后补资料不改冻结批次。额度耗尽只收尾本批次该平台未执行任务，不改已有证据。官网审计源文件/截图/报告必须追加、可按项目授权打开；人工与 Agent 使用同一受控管线，不开放任意浏览器/HTTP 工具。详细预算和发布边界见 `docs/website-audit-and-capture-recovery.md`。
- 报告先冻结 payload 与 SHA-256，再异步生成 PDF。只有批准的 Agent 草稿能进入正式业务记录或报告叙述。
- 保持 API 口径披露，尤其 `yuanbao_hunyuan` 必须显示“元宝搜索源 + 混元合成”，不得冒充消费端 App 回答。

## 实现方式

- 先修改拥有契约的 package，再更新 Worker/API/Web 消费端。共享规则放在现有 package，不在路由或组件中复制。
- 数据库变更同时更新 Drizzle Schema 和新的递增 SQL migration；不得编辑已部署 migration。
- 只在新建项目 PGlite 或用户明确提供的隔离 PostgreSQL 上运行 migration。不得连接或修改推断出来的外部数据库。
- 对外部 Provider 使用结构化响应解析和明确失败分类；协议或解析语义变化时提升 adapter/search tool 版本。
- UI 延续现有工作台信息架构，覆盖 loading、empty、error、partial、queued、failed、read-only 状态；检查桌面界面无重叠和截断。默认不做手机端检查，只有用户明确要求时才进行。前端结构、antd 组件选用、分页/反馈/密度规则按 [references/frontend.md](references/frontend.md) 执行。
- 重大功能变更必须在同一变更中重新蒸馏受影响的代码事实源，并同步对应 docs、skill entrypoint/reference；不能把同步留给后续任务。
- 改动范围和验证方法按 [references/change-checklist.md](references/change-checklist.md) 执行。

## 交付

先运行受影响 package 的测试，再运行：

```bash
# 仅重大功能变更；<pre-task-ref> 是任务开始前记录的 Git ref
corepack pnpm check-drift -- --major --base <pre-task-ref>
corepack pnpm check-types
corepack pnpm test
corepack pnpm build
corepack pnpm lint
```

依赖或许可发生变化时还要运行 `corepack pnpm license-check`。交付说明应列出变更的契约、migration、测试结果和未验证的真实 Provider/浏览器/数据库条件。

- Responses 采集必须区分最终回答、推理/中间消息与工具来源；只能把最终 annotation/明确引用链接标为 isCitation。协议变化提升 ADAPTER_VERSION，旧证据只读、新建批次验证，详见 full-audit-2026-09-06.md。
