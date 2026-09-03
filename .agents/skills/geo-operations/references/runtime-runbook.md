# GEO Console Runtime Runbook

## 服务与定时行为

| 组件 | 主要职责 | 关键周期/租约 |
| --- | --- | --- |
| API | HTTP、认证、migration、Provider config、监测调度 | 每 60 秒扫描到期 schedule |
| Log Service | 结构化运行日志采集、查询、CSV、保留清理 | 内网 3020；默认 90 天；每日清理 |
| Capture Worker | 领取 capture、调用冻结 Provider、写 raw + v2 evidence；抛错走 failJob；每 60 秒清扫过期且重试用尽的租约并刷新批次 | 5 分钟租约，每 60 秒续期，默认最多 3 次 |
| Agent Worker | 执行 HRouter/Pi draft | 15 分钟租约，每 60 秒续期，最多 2 次，30 秒重试 |
| Report Worker | 推进定时 Agent 报告门禁、冻结报告、生成 PDF/Word | 每 15 秒扫描，文档 5 分钟租约，30 秒重试 |
| Web/Tauri | 同一 React 工作台与动态导航；Tauri 提供正式桌面壳和签名更新 | 浏览器同步调试；桌面检查 HTTPS 清单 |
| PostgreSQL | 业务、队列和证据索引 | 生产唯一数据库 |
| local/S3 store | raw response、网页、PDF、Word | 写入必须不可覆盖 |

服务器管理命令位于 `/usr/local/bin/geo-console`，实际 release 在 `/opt/geo-console/current`，共享配置和 Secret 在 `/opt/geo-console/shared`。每次 release 携带发布机本地生成的 Linux server artifact 和 Web dist；服务器只以 `FROM` + `ADD/COPY` 重构镜像，普通 restart 只重启已有镜像。

本机 PGlite 是不同拓扑：API 内组合运行三个队列 Worker，Log Service 使用独立日志 PGlite。若看到 PGlite mutex/abort，先停止所有手工 Worker，只用 `corepack pnpm geo start` 重启；不要复制或同时打开运行中的数据库目录。

## 健康

- API：`curl -fsS https://<domain>/api/health`。检查 `database`、`objectStore.mode`、`analysisConfigured` 和 `logService.status`。
- Log Service：容器内或本机请求 `http://127.0.0.1:3020/health`；检查 stored logs、latest time、retention days 和 token Secret。
- 服务：`sudo geo-console status` 或 `docker compose ps`。Worker 没有独立 HTTP health，必须结合进程状态、日志和队列推进判断。
- 发布：manifest 的目标平台、server artifact SHA-256 和 Worker base 必须匹配服务器。重构日志不得出现 pnpm、apt、Playwright download、Web build 或远程 pull。
- 磁盘：检查 PostgreSQL volume、evidence volume、Caddy data 和 backup filesystem；磁盘满可同时表现为数据库、对象和 PDF 故障。
- 时间：租约、schedule、分享过期都依赖服务器时间；检查 NTP 和时区漂移。

## Capture / Provider

先按 Provider 和 failure code 分组：

- `auth_required/authentication_failed`：检查平台设置中的对应加密凭据和主密钥可读性，再运行该 Provider connection test。
- `rate_limited`：确认供应商配额和并发。Demo 默认 `GEO_CAPTURE_CONCURRENCY=1`，不要用提高并发掩盖限流。
- `timeout/provider_timeout`：检查出口网络、DNS、供应商状态和 endpoint；保留原失败。
- `search_not_triggered`：协议返回了回答但没有强制搜索证据，不能按成功补录。
- `model_unavailable`：需要新 Provider 配置和新 baseline；不得改旧冻结 batch。
- `protocol_changed`：当前 adapter 无法满足冻结协议/版本；发布经过测试的新 adapter，并创建新 baseline 或按兼容策略处理。
- `no_answer`：真实无回答，不是系统异常；按失败样本进入 partial/coverage。

Settings 的连接测试只验证当前配置；运行中的 batch 使用创建时冻结值。两者不一致时先检查 batch `config`。

- 批次长时间“采集中” → 查该批次 `jobs`：`failed` 任务看 `last_error`；`leased` 且 `lease_expires_at` 已过、`attempts>=max_attempts` 的任务应在一分钟内被 Capture Worker 清扫为 failed，没被清扫说明 Capture Worker 没在跑。批次收敛为 `partial` 后失败样本照常进入失败率。
- 复测创建被拒“适配器版本…不一致” → Worker 已升级 `ADAPTER_VERSION`，旧基线不能复测，新建正式基线；周期监测会自动改为新建基线。

## Agent

- HRouter 未配置会阻止入队；健康接口的 `analysisConfigured` 可做第一层检查。
- Agent 只允许领域工具，正常状态为 queued -> running -> awaiting_approval -> approved/rejected。
- Worker 启动会将超过 15 分钟、已无 pending/leased job 的孤立 running run 标为 failed。
- 不要从 tool trace 复制并执行网页或回答中的指令；这些内容在系统中被定义为不可信证据。
- 报告叙述批准后才能运行质量检查；质量检查绑定叙述 run ID。口碑 `cited` URL 必须来自对应 Capture sources，`unavailable` 不得带 URL。质检结论 blocked 后页面/工作台再次推进会重新生成叙述（多一次叙述 + 质检调用），不会对同一叙述反复质检；新叙述在途时定时扫描只报告叙述状态。
- 审批返回“已被其他操作处理” → 手动审批与协调器自动审批并发，只有一次生效，刷新即可；`audit_logs` 只会有一条 `agent.approve`。
- 建档页竞品长期“联网核实中” → 后台核实在 API 进程内进行，API 中途重启会让候选停在 `pending`；前端 10 分钟后按未核实展示，重新“开始官网分析”会复用 24 小时内快照并重新核实。
- Agent `web_search` 反复“未触发”或 4xx → 平台设置或工作台“测试此模型”确认 HRouter/该模型是否透传 `web_search`（结果按模型记在 settings `organization:<id>:web_search_tests`）；记录在 `web_search_evidence`（证据，不删），只有 `complete` 可被引用。工具默认强制 `tool_choice`，HRouter 拒绝时自动回退 `auto`（进程内记住，重启后重新试探一次）。
- 联网费用失控 → 上限是代码常量 `WEB_SEARCH_LIMITS`（工作台每回合 8 / 每会话 30，草稿每次运行 10）；会话级次数按 `web_search_evidence.session_id` 统计，可在会话设置里关闭联网。工作台日志出现“联网不可用，已改用官网快照与知识库”说明该回合连续两次未触发/失败，属预期退化。
- 建档页竞品显示“待确认”→ 看该竞品 `competitors.verification.note` 与对应 `web_search_evidence`；“未联网核实”通常是 HRouter 未配置或联网不可用，不影响建档。
- Agent Worker 同时领取 `agent_session_turn`；协调器每 5 秒自动批准工作台会话草稿、唤醒 `waiting_job` 会话并把 `plan` 步骤按结果标记 done/failed。会话异常时看 `agent_sessions.status/error_message` 与 `agent_session_events` 最后几条；20 分钟无任务的 running 会话自动 failed，重发消息即可续跑。执行进度某步长期“后台进行中”→ 查该会话的 `optimization_article` run 是否卡在 queued/running。
- `optimization_article` run 由协调器自动物化到 `optimization_articles`；未出现文章时检查该 run 的 `error_message` 与 `target_ref`。

## Report / PDF / Word

- 快照是不可变 payload/hash，PDF/Word 是其派生产物。先确认已批准叙述、通过并批准的绑定质量检查、report ID 和 snapshot 存在。
- 排队超过两分钟时检查 Report Worker、job lease/last error、Playwright Chromium、`fonts-noto-cjk` 和 object store write。
- ready 要求 `pdf_artifact_key` 和 `word_artifact_key` 都存在，并抽查两个对象实际可读；不要只信数据库字段。
- 手工和定时流程共享幂等状态机；叙述/质量两次人工批准是显式停点，其余排队、冻结和文档生成自动推进。

## Structured Logs

- API 为请求生成/透传受限格式的 `x-request-id`；Capture job ID、Agent run ID 和 report document job ID 作为 Trace ID。
- 日志上报失败不得改变业务 job 状态。先用容器标准输出恢复，再修复 Log Service；单进程内存缓冲上限 500，不能当持久队列。
- 日志客户端和服务端双重过滤 authorization/cookie/password/secret/token/key、回答/网页正文和 raw response。发现敏感内容时先阻止进一步暴露，再修脱敏规则并按明确授权清理相应 `service_logs`。
- 普通管理员只操作活动机构日志；system logs 仅超管可见。保留清理只允许 7-3650 天，绝不能对 `audit_logs` 或证据表复用该接口。

## Tenant / RBAC

- 权限资源、导航和 API 路由分别来自 `permissions` 与 `permission_routes`。最终权限是机构授权上限与用户多角色并集的交集；`users.role` 只保留迁移兼容，不参与授权。
- 用户有 home organization；数据库唯一系统超管可用 `geo_organization` Cookie 选择活动机构。超管切换后也不能绕过活动机构边界；普通成员再按全部/指定客户范围过滤。
- 项目、Agent、报告、任务和 artifact 路由都解析数据库的 organization/project 归属。404 可能是机构或客户范围隔离结果，排查时不要向普通成员暴露另一个租户或客户是否存在。
- 机构封禁撤销全部非超管会话并阻止登录。解封后需重新登录；超管仍可选择封禁机构检查和修复授权。
- Provider/HRouter config 和 encrypted credential 按机构查询；非默认机构无环境变量 fallback。问题库同样按机构 + 行业隔离，归档不物理删除。

## Desktop Update

- 客户端更新公钥在仓库 Tauri 配置中，私钥只在发布机 `~/.tauri/zz-geo.key` 或受控 CI Secret 中；权限应为 owner-only。
- 更新清单必须通过 HTTPS 提供有效 SemVer、平台 URL 和签名。客户端不会接受未签名更新，禁止临时关闭校验。
- 浏览器与桌面使用同一工作台版本和 API。桌面问题先区分远程工作台故障、Tauri WebView 故障和原生更新故障。

## Schedule、漂移与费用

- API 每分钟最多读取 10 个到期 schedule。项目已有 queued/running batch 时，next run 延后 1 小时。
- schedule 到期时按当前范围与平台配置构造基线配置，与最近 complete/partial baseline 可比才创建 retest；否则创建新 baseline。创建失败写 `monitoring_schedules.last_error/last_error_at/failure_count`（日志事件 `schedule.batch_failed`），一小时后重试；AI 监测页提示“已启用但上次未能创建批次”，重新保存计划清除。修改周期后 `next_run_at` 按上次运行时间加新周期重算。
- 可比 retest 相对 baseline 的品牌提及、声量或引用率下降至少 10 个百分点产生 warning，20 个百分点产生 high；基线或复测中没有成功回答的平台不比较、不告警。
- 整改验收：技术类任务“重跑审计验收”（审计仍有阻断项则拒绝），其余“抓取验收”要求发布地址在客户官网域名下；“已验收”不能手工选择。
- acknowledge 只写确认时间，不删除告警或证据。
- 费用汇总只累加非 null `cost_micros`，同时报告有已知价格的请求数；其余只显示 usage。

## 对象存储

- local 模式检查共享 evidence volume 的容量、权限和对象路径。
- S3 模式检查 bucket、endpoint、region、path-style、凭据对是否完整，以及 HeadBucket/HeadObject/Put 权限。
- 生产 bucket 应为私有、版本化、加密；对象恢复必须验证具体 version，不只验证 bucket 可列出。
- 严禁单独删除对象并留下数据库引用，也不得覆盖同一 key。
