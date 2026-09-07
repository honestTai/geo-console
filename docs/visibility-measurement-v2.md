# 可见度 V2：实现与运行契约

无官网客户：新的基线冻结 `project.domain=""`（保留既有字符串契约）和可空 `websiteUrl`；Metric 输入的 owned domains 为空。品牌提及/推荐照常基于真实回答和门槛测量，官网 citationRate/sourcePresenceRate 保持 null（不适用），不是零引用；不能生成“官网零引用”发现。后补官网只影响新基线，旧基线同条件复测仍完整复制原配置。额度不足收尾的未执行任务没有伪造 Capture，正式采样/解析/问题覆盖门槛不降低。见 `docs/website-audit-and-capture-recovery.md`。

证据中心另有 `geo.answer-analysis.v1` 完整回答辅助解读（`docs/answer-analysis.md`）。其 job/运行/尝试与本文件的原子语义观察独立，不改公式、分母、快照或可比性；重生成辅助解读不会触发 V2 重解析。

实施日期：2026-09-05；任务基准：`a8e8cd284ee016aaa280f58ad36eb4b6709e3abc`。

本次按用户要求直接切换 V2，不保留 V1 指标计算或自动回退。历史原始证据不被自动修改或删除；没有测量契约的旧批次不再自动产生指标，旧基线不能创建新的复测。测试数据清空是单独的显式操作，本次实现不执行清库。

## 事实源与流程

- `packages/evidence/src/semantic.ts`：冻结测量契约、严格原子语义 Schema、白名单/原文片段/UTF-16 偏移/名次/冲突校验及独立复核一致性。
- `packages/metrics/src/visibility.ts`：唯一指标算法。先重复采样、再问题等权、再达标平台等权，固定种子按问题聚类 bootstrap。旧首次提及顺序不再参与推荐率。
- `apps/worker/src/measurement.ts`：冻结模型与算法、异步解析、原始模型响应和派生观察、人工审核、指标快照、配对漂移与读取入口。
- `semantic-runtime.ts` / `semantic-worker.ts`：独立受限执行器；本机合并进 API 的 PGlite 进程，服务器新增独立 `semantic-worker` 服务。

新批次在一个事务中写入冻结配置、全部 Capture jobs 和语义运行。技术重试不增加业务样本；新样本的 `sampleKey` 是 `[batchId, platform, promptId, windowIndex, repeatIndex]` 的 JSON 编码，当前每个时间窗一条业务采样，`repeatIndex=0`。

Capture 状态保持原有队列语义。成功的 API Capture 才进入 `semantic_parse`。语义完成后由 Worker 生成只追加的 `metric_snapshots`；`getBatch()` 只读取快照和运行进度，不调用 GPT，也不重新计算已有指标。没有快照或有效观察时返回 `unavailable/null`，不是 V1 或词法回退。

## 冻结的初始统计政策

- 快审 1 次，正式默认 3 次（0、4、24 小时），沿用已有采样时间窗。
- 正式每题至少 `ceil(repeats × 2/3)` 次采集成功且解析有效。
- 平台问题覆盖至少 80%、解析覆盖至少 90%、有效问题至少 10。
- 95% percentile 区间按问题聚类重采样 2,000 次。种子由**尚未加入 measurement 的采集配置哈希**与算法版本构造，避免 seed 与 config hash 自我引用。
- 初始保守的品牌/推荐指标区间宽度上限为 0.5（50 个百分点），超过则 `limited`。这是待标注集/试运行校准的冻结政策，不代表已验证的统计精度。
- 快审始终是 `limited` 时点结果；不计算重复稳定性或置信区间，不产生显著性告警。
- 不足门槛的平台可展示有限结果，但不以完整平台权重进入正式总体结论。所有平台无有效结果时品牌指标是 `null`。
- 采集覆盖分母是计划采样数；解析覆盖分母是成功回答数；问题覆盖分母是冻结问题数。没有 Capture 的终态失败 job 单独计入执行失败数。
- 来源仅来自已保存 Capture 的可观测来源，不接受模型新增 URL。不可见保持 `null`。
- 两两一致率为 `[k(k-1)+(n-k)(n-k-1)]/[n(n-1)]`；一次采样时为 `null`。
- 指标包含提及、推荐、明确推荐、明确列表第一推荐、监测品牌出现份额、明确推荐名次中位数、来源及竞品指标。反对不计为推荐。
- 漂移必须使用同项目、同完整冻结配置、同测量契约的 baseline/retest，且共同有效问题达到门槛。下降 ≥10/20 个百分点且配对差值区间上界 <0 才分别为 warning/high；否则保存观察项，不生成正式告警。告警同时绑定两份 MetricSnapshot，展示的前后值也来自共同问题。

`geo.semantic-observation.v1` 是本设计的**原子语义 Schema 版本**，不是被停用的 V1 可见度算法。

## 语义执行与审核

模型由机构 HRouter 设置选择，endpoint/model/schema/prompt/validator/adjudication/metrics 全部冻结。当前 HRouter 配置没有可靠的不可变模型修订来源，因此 `modelRevision=null`，不得把它宣传为已经验证的模型快照锁定。切换模型/算法需新基线。未知成本保持 `null`，使用量独立记录。

解析使用 Responses 严格 `text.format=json_schema`，没有 tools、联网、文件、SQL、Bash 或业务写工具。正文上限 120,000 UTF-16 单元，过长拒绝解析而不是截断后打分；每次请求最多 12,000 output tokens、120 秒超时。首轮通过即采用，冲突/校验失败只做一次独立复核，关键语义一致且复核通过才采用，否则等待人工处理。

任务最多两次技术尝试、5 分钟租约、30 秒续租、30 秒重试；两个并发槽，每 500ms 尝试领取。协调器每 5 秒排队、清扫耗尽租约并冻结快照。幂等 job 按 `(runId,captureId)` 去重；每个 job 包含有界 primary/review 阶段，原始尝试只追加，当前采用结果由 `semantic_selections` 唯一指向一条观察。

证据中心「V2 语义审核」分页展示观察和校验原因。人工审核需要 `agent.approve`，必须重新验证原文与归属、填写理由，并写入新观察与审计记录；生成新指标快照，不覆盖旧快照。重新解析需要 `agent.run`，创建独立运行。

API：`GET/POST /api/batches/:batchId/measurement`；`POST /api/batches/:batchId/measurement/review`。租户和项目隔离沿用批次资源边界。Semantic 原始响应文件同样需要项目授权。全部配对字段可在中途崩溃后幂等补齐；报告工作流等待完整配对结果后再排叙述。

## 报告与产品边界

报告 Agent 读取绑定的 MetricSnapshot；复测同时绑定基线快照，任一侧版本变化都须重新审批。配对差值保存在独立派生表，Web/PDF/Word/CSV 使用共同有效问题的同一份前后值和区间，禁止用两个不同有效问题集的总体点估计直接相减。报告 Agent 不能自行重新计算百分比或修改漂移等级。草稿审批重新检查当前测量版本；版本已变化时必须重新生成。叙述和质检必须人工审批，工作台的自动批准不绕过这两道门禁。诊断、整改及报告查询绑定指标快照，避免重解析后混入旧结论。

Web、PDF、Word、CSV 和报告分享从同一冻结 payload 展示结果，并披露三类覆盖及区间。总览和监测显示 `queued/running/ready/partial/failed` 分析状态；快审可以展示时点数值但不连接为正式趋势。

未来 App 仍为 `not_configured`，指标为 `null`。没有云安卓、账号池、App Worker、假配对数据或空占位表。

## 存储、发布和恢复

新增 `0019_visibility_v2.sql`：`semantic_parse_runs`、`semantic_observations`、`semantic_selections`、`metric_snapshots`、`measurement_drift_observations`，以及样本键、取消标记和指标快照外键。Drizzle 同步声明。PostgreSQL migration 在事务中锁住迁移记录表并重新检查，避免多个 Worker 重复应用同一文件。

新增 Worker 使用相同证据卷和数据库备份策略；`semantic/` 原始响应和派生记录必须随完整数据库/证据备份保留。仅清理运行日志不能删除这些证据。没有自动迁移/清空用户现有数据库或部署服务器。

V2 不可用时，应修复机构模型/Key/网络、检查 `semantic_parse` 失败原因、人工审核或创建新的解析运行；不能切回 V1 假装成功。Agent、PDF 和 Semantic 的耗尽租约均可终态收敛。

## 同批修复的边界

HTML 证据强制下载并附 CSP sandbox；网站访问将检查过的 IP 绑定到实际 HTTP(S) 连接，保留 Host/SNI、逐跳检查、限制响应大小并记录最终 URL。整改验收核对 HTTPS/访问/机器人检查项，发布验收拒绝跳转到第三方域名。

批次创建原子提交；Capture 提交在事务内锁定并检查租约；服务端会话取消标记不可被旧回合覆盖；新增客户为受限创建者补授权。JSON 请求默认上限 8 MiB，登录 16 KiB；登录按账户/远端 IP 限流（隔离 Caddy 后的 API 设置 `GEO_TRUST_PROXY=true`，直连默认不信任转发头），密码哈希改为异步。前端批次请求取消过期响应并显示错误，等待语义状态完成后刷新报告。

## 验证限制

自动化测试使用新建内存 PGlite、合成测试夹具和受控模型响应，不是人工标注集。真实 HRouter 严格输出兼容性、模型语义准确率、真实 Provider、生产 PostgreSQL 并发及目标服务器发布必须单独验收。没有经过人工标注评估，不报告 precision/recall/F1 达标或客户业务效果。

### 本次执行结果

- `corepack pnpm check-types`、`corepack pnpm test`（169 项）、`corepack pnpm build`、`corepack pnpm lint` 均通过。
- 六个重大变更影响面防飘逸检查通过；许可证检查通过（342 个依赖）；使用占位环境变量与空 env 文件的 Compose 配置校验通过，未启动部署。
- `GEO_PDF_E2E=true` 的报告测试通过，实际生成 PDF 与 Word；对象输出位于隔离临时目录。
- 浏览器只读夹具验证桌面与 390px 布局，无页面横向溢出。390px 使用同源隔离 iframe 测试 CSS 响应式布局，不代表移动真机验证。测试页面不在正式构建中注入假回答或假指标。
- 没有清空或迁移现有业务数据库，没有调用真实模型/Provider、发布服务器或生成签名桌面更新包。临时界面测试服务已关闭。

构建仍有非阻断的前端大 chunk 和纯类型检查任务无输出文件提示；它们不等于测试失败，但不能据此宣称生产性能已通过验收。

## 真实集成验收后的输入边界修正

2026-09-06 的真实 DeepSeek 原始 Responses 证明，旧 cloud-search.v1 提取可能混入 reasoning_text 和中间消息、误把浏览 URL 算作引用。已升级 cloud-search.v2，仅最终 assistant/output_text 进入语义测量；引用和检索来源分离。旧快照保留审计但不继续生成当前报告/复测，新建批次冻结新合同。数学算法与语义 schema 版本没有因此冒充升级。报告明确“采集覆盖率”和“达到正式门槛的平台覆盖率”不是同一指标。见 full-audit-2026-09-06.md。
