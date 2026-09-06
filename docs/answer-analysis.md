# 完整 AI 回答语义分析

任务基准：`be572715790c8576f058af9bb77fdb71abc4f7ae`。影响 architecture/domain/capability 和 Semantic Worker 队列；新增 migration `0023_answer_analysis.sql`，不改 Provider、正式指标、批次 config 或部署服务数量。

## 使用与事实源

证据中心 → AI 回答 → 选择回答 → **生成完整语义分析**。打开页面只读库，不自动调用模型；重新生成需确认，保留旧版。支持后台状态、失败/待核对、上一版/最新版、逐字原文高亮和 JSON 导出。

`packages/evidence/src/answer-analysis.ts` 拥有版本、Schema、片段与证据校验及 API 类型；Worker `answer-analysis-model.ts` 拥有固定提示和最终消息提取，`answer-analysis.ts` 拥有冻结/排队/授权/版本/成本。`semantic-runtime.ts`、`queue-recovery.ts` 执行与回收。Core Schema/migration 0023 拥有两表和策略。Web 的 AnswerAnalysis 组件、ui/answer-analysis、useAnswerAnalysis hook 由 EvidenceDetail 装配。

## 语义与证据

`geo.answer-analysis.v1` 包括类型、总览、核心观点、全文分段、监测品牌情感与推荐立场、各维度评价、推荐理由/条件、品牌比较、原文明确的限制与歧义。维度从真实原文提取，不设行业默认。缺少对应内容返回空数组，理由未说明为 null，比较未明确偏好时 favoredBrandId=null。不生成综合分、名次或优化建议。

问题/品牌/别名取冻结 batch config。原文不规范化、不改写、不截断。应用划分自然段/有界片段；模型引用片段 ID 与逐字引文，应用唯一定位并计算 UTF-16 偏移。分段须按序覆盖所有片段恰好一次，含非品牌段落和结尾。缺段/乱序/条件不完整为 needs_review；无效引文、白名单外品牌、跨段或缺少品牌归属时不展示正文。覆盖 n/n 不是准确率；引文存在不等于语义蕴含，结果未人工复核。

这是独立辅助解读，不是事实核验或上游排序机制，**不进入正式排名、报告指标和漂移**。旧 V2 API 回答可独立解读但不恢复正式可比性；失败/空回答/历史消费端页面不可生成。

## API、执行与存储

`POST /api/batches/:batchId/captures/:captureId/analysis` 在授权事务内锁 capture，对 active 运行去重；每次手动重生成冻结当前模型、endpoint、提示/分段器/校验版本及 input_hash，不改旧 config/分析。相同路径 GET 只读最新版，`?runId=` 读历史；必须同时匹配 batchId/captureId/runId。previousRunId/latestRunId 支持逐版导航，原始模型响应/endpoint 不进入读取或导出对象。输入哈希不一致不返回正文。

- `answer_analysis_runs` 保存冻结配置、execution_actor、状态、采用指针；`answer_analysis_attempts` 每次技术尝试只追加 raw_response、校验、结果、用量。原始 Capture 和旧分析不更新；不新增对象存储格式。
- `answer_analysis` job 最多 2 次技术尝试，5 分钟租约，30 秒续租/重试；耗尽租约同步将 run 标 failed。
- 复用 Semantic Worker，完整分析独立 1 槽，正式测量仍为 2 槽；本机仍同一 API/PGlite 进程，无新增 Python 生产服务/端口。
- 输入最多 60,000 UTF-16 单元，输出最多 16,000 tokens，120 秒超时。超限调用前拒绝，不截断后称完整；拒绝/未完成/非 JSON 响应不当作有效结果。
- GET 需 page.evidence；POST 和 `answer.analysis.execute` 需 page.evidence + agent.run。HTTP 按 batch 校验项目，处理器复核 capture 归属；POST、执行前、模型调用前、采用结果事务内均复核当前授权。持久 actor 不可省略。撤权/停用/封禁不能被队列绕过，已发请求不能撤回或宣称退款。
- 模型无工具、联网、代码、文件、业务写能力；输入全部视为不可信数据，只消费 completed 最终 assistant 消息，不消费 reasoning/tool 内容。
- 成本记录 operation=answer_analysis，未知金额 null；modelRevision 当前 null，不宣传不可变模型修订锁定。

## 运维与验证

排障看 run.status/error_message、jobs 租约和执行策略，不改 query_captures、不强制 job complete。failed/needs_review 由用户核对配置/原文后重生成，没有上线后自动付费回填。API/Web 与 0023 同步发布；备份须包含两表及敏感原始模型响应。回滚前停止新增并等待在途分析结束，保留新表；旧代码不消费 answer_analysis。迁移只在新建 PGlite 或明确授权部署库执行。

契约/隔离 PGlite/Web 测试覆盖 Unicode、全文覆盖、引文/品牌归属、条件、幂等、冻结、只追加、只读无调用、授权隔离、重试/回收、安全高亮。`tools/answer-analysis-eval/` 是 Python 3.9+ 标准库离线人工标签评测，不是 Agent 执行工具，不联网/读业务库/回写。输出品牌情感、立场、方面情感 precision/recall/F1 与覆盖率。没有真实人工标注集不能宣称模型精度达标；摘要忠实度、条件抽取、语义蕴含、多语种效果仍需真实人工评测。

浏览器验收使用仓库外的临时合成样本页面，未连接业务 API/数据库：原生桌面与同源 iframe 的 1440/900/600/390px 视口均无横向溢出；验证原文高亮、逐版切换、确认前 0 次 POST/确认后 1 次 POST、排队到完成的轮询、未生成/待核对/失败/请求失败/只读状态。CDP 未开启，未修改浏览器权限。真实 HRouter 效果及现有实例迁移/部署未执行，不能把隔离夹具验收当作真实模型准确率验证。
