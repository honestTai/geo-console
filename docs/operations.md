# 运行与故障处理

## 健康检查

```bash
corepack pnpm geo doctor
curl -fsS http://127.0.0.1:3010/api/health
curl -fsS http://127.0.0.1:3020/health
docker compose ps
docker compose logs --tail=200 log-service api capture-worker agent-worker report-worker
```

服务器 release 安装后优先使用：

```bash
sudo geo-console doctor
sudo geo-console logs api
sudo geo-console logs log-service
sudo geo-console logs capture-worker
sudo geo-console logs agent-worker
sudo geo-console logs report-worker
```

`geo-console upgrade` 只允许服务器从 release 内本地构建的 Linux artifact/dist 重构镜像；日志中出现 pnpm、apt、Playwright download、Web build 或远程 pull 都表示发布协议错误。`restart` 只按顺序重启已有镜像，不重新构建。

健康响应会标识数据库类型、对象存储模式、HRouter 配置状态、云端采集模式和 Log Service 健康，不暴露 Key 或完整模型配置。

## 独立日志服务

Log Service 仅绑定本机 `127.0.0.1:3020` 或 Compose 内网 `log-service:3020`，不经 Caddy 暴露。API/Worker 使用 owner-only `log_service_token` 上报；服务不可用时业务继续运行并保留容器标准输出，恢复后进程内最多缓冲 500 条并重试。

本机 PGlite 模式由 API 进程组合执行 Capture/Agent/Report，Log Service 使用独立 `${GEO_DATA_DIR}/log-service/database`；不要手工再启动三个 Worker 指向同一 PGlite。`pnpm geo backup` 会在停服后同时复制业务 PGlite、日志 PGlite 和 artifacts。

工作台“运行日志”由 `page.service_logs` 控制，CSV 与保留清理由独立功能权限控制；超管可同时查看 system logs。查询使用游标逐页替换，不在浏览器或桌面端累积全部日志。默认自动删除 90 天前 `service_logs`。手工清理必须核对活动机构和天数，清理动作写 `audit_logs` 与 `logs.retention_pruned`，但不会删除 `query_captures`、raw、网页、报告或业务审计。

排查顺序：先检查 `/health`、数据库、`log_service_token` 文件权限与 API 的 `logService.status`，再看 `docker compose logs log-service`。不要通过公开映射 3020 绕过 API RBAC。

## 采集队列

Capture 任务状态为 `pending -> leased -> complete`。进程退出后租约过期即可被其他 Worker 领取。供应商的鉴权、限流、超时、模型下线和协议变化会写入不可变 `QueryCapture`；不得补数或改写为成功。

排查部分批次时记录批次 ID、配置哈希、计划/有效/失败样本和按平台失败码。先修复 Key、配额、网络或适配器，再创建新基线或严格复测。不要手工把未完成租约改成 `complete`。

## Report Worker

PDF/Word 请求创建 `report_document` 数据库任务；旧 `report_pdf` 任务仍可兼容领取。页面显示排队超过两分钟时检查 Report Worker、Chromium、中文字体、对象存储写权限和任务 `last_error`。报告 payload 已冻结，不需要重建快照；修复环境后让任务按租约重试。PDF 和 Word 必须都存在才显示 ready。

Report Worker 每 15 秒检查一次定时监测最近完成的批次。手工和定时链路都使用同一个幂等工作流：创建叙述，等待人工批准；自动排队绑定的质量检查，再等待人工批准；通过后自动冻结并创建 PDF/Word。失败或拒绝后从当前阶段重试，不重复冻结同一叙述版本。

## Agent Worker

Agent 请求只创建 `agent_draft` 数据库任务并立即返回。Agent Worker 按租约执行，页面轮询展示排队、工具步骤、结构校验重试、Token、失败原因与待审批草稿。单次失败会在 30 秒后重试一次；不要手工把未完成任务改成成功。

报告口碑来源校验失败时先对照 Capture `sources` 和 `source_visibility`。不得把任意网页 URL 写进口碑信号；平台未开放来源时保留 `unavailable`。质量检查引用过期的叙述 run 时应重新排队检查，不能手工改 run ID。

## AI 工作台

会话状态：`idle`（等待指令）、`running`（Agent 回合执行中）、`waiting_user`（等待成员回答问题或手动审批）、`waiting_job`（等待批次/Agent run/报告 PDF 完成）、`done`、`failed`。协调器由 Agent Worker 每 5 秒运行：自动批准工作台草稿并推进报告工作流，唤醒等待对象已完成的会话（入队 `agent_session_turn`）。会话卡在 `waiting_job` 时先看等待对象本身（批次是否完成、Agent run 是否终态、报告是否有 `pdf_artifact_key`）；卡在 `running` 超过 20 分钟且无 pending/leased 回合任务会被自动标为 failed，成员重新发送消息即可续跑（transcript 保留）。不要手工修改 `transcript`；终止会话只改状态，不会取消已排队的批次。

优化文章 run（`purpose='optimization_article'`）到 `awaiting_approval` 后由协调器自动物化到 `optimization_articles`，失败会写 `error_message`；重新生成会覆盖同一建议的文章并递增 `version`。

## 多租户与权限

权限排查按机构授权上限 -> `roles/role_permissions` -> `user_roles` -> `users.all_projects/user_project_access` 顺序进行。页面导航来自 `permissions`，API 来自 `permission_routes`；未登记路由默认 403。历史 `users.role` 不再决定授权，不要通过修改该字段修权限。

系统只能有一个超管。超管通过活动机构 Cookie 显式切换后，项目、证据、报告和 Artifact 仍必须属于该活动机构；普通成员还要命中自己的客户范围。遇到 404 时同时核对 home organization、活动 organization、资源 `organization_id/project_id` 和用户客户范围，不要改数据库归属绕过。

封禁机构会设置 `organizations.suspended_at/reason` 并撤销该机构所有非超管会话。解封不会恢复旧会话，用户必须重新登录。误封恢复时先由唯一超管解封，再验证机构授权、用户角色和客户范围；不要直接清空 session 或把普通用户提升为超管。

Provider/HRouter 凭据继续按机构隔离；环境变量 Key 只对默认机构提供引导 fallback。

## 桌面客户端

正式产品使用 Tauri 2 客户端，浏览器暂时保留同等工作台用于调试。客户端 User-Agent 为 `ZZGeoDesktop/<version>`，页面和 API 仍使用服务端会话、动态权限和活动机构，不在客户端保存业务数据库或 Provider Key。

应用内更新只接受 `tauri.conf.json` 内 GEO 公钥验证通过的 HTTPS 更新清单和签名包。更新故障先检查清单是否为有效 SemVer、目标平台/架构、下载 URL 和 `.sig` 内容，再检查客户端版本；不要关闭签名校验或复用其他产品私钥。

## 漂移与费用

复测相对正式基线下降至少 10 个百分点时生成漂移告警，20 个百分点为高等级。确认告警不会删除证据。费用只有供应商明确返回时才汇总金额；否则展示请求和 Token，并标注费用未知。

## 备份恢复

本机备份前停止 `pnpm geo start`，再运行 `corepack pnpm geo backup`。服务器使用 `docker compose --profile backup run --rm backup`。数据库与本地证据卷必须同一时间点恢复；S3 模式应先验证对象版本仍存在。

恢复必须进入新建空 PGlite/PostgreSQL，运行健康与证据抽查后再切换。不要直接覆盖唯一实例。服务器 release 与应用镜像至少保留到回滚窗口结束，但仅切换应用版本不能撤销不兼容数据库迁移。

## 证据保留

默认永久保留 `query_captures`、网页快照、原始响应、报告快照和 `audit_logs`。`service_logs` 默认保留 90 天，可按机构清理。问题知识库归档只写 `archived_at`。客户或租户删除请求属于破坏性操作：先解析准确 organization/project ID、报告关联、对象前缀、审计要求和备份状态，再获得明确确认。
