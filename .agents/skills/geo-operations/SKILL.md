---
name: geo-operations
description: Operate and troubleshoot an existing GEO Console instance, including health, structured log service, provider failures, capture/Agent/report queues, schedules, drift alerts, object storage, backups, restores, and evidence/log retention. Use for runtime diagnosis and recovery; use geo-deployment for first installation, upgrades, rollback, or environment provisioning.
---

# GEO Console Operations

对用户明确指定的现有实例排障，默认只读，保持证据链和审计可追溯。

## 开始排障

1. 明确目标是本机 PGlite 还是哪个服务器/实例。不得从环境变量、SSH 配置或历史记录推断生产目标。
2. 记录用户可见症状、开始时间、项目/批次/报告/任务 ID，以及最近部署或配置变化。
3. 先读 [../../../docs/operations.md](../../../docs/operations.md)。按故障类型读 [references/runtime-runbook.md](references/runtime-runbook.md)，部分批次或卡住的任务再用 [references/incident-checklist.md](references/incident-checklist.md)。
4. 先采集健康、服务状态、有限日志、磁盘/对象存储和队列状态，再决定是否需要任何写操作。

## 事实边界

- `/api/health` 证明 API 可访问数据库/对象存储并报告 Log Service 状态；Log Service `/health` 只证明其可读数据库。两者都不证明三个 Worker 正在消费，也不测试五个 Provider。
- 服务器 `geo-console doctor` 检查 Compose、全部服务、HTTPS 和备份文件可见性；它仍不证明队列已排空、Provider Key 有效或 S3 对象可恢复。
- `query_captures`、raw response objects、网站快照和报告快照不可作为普通修复更新或删除。修配置、网络、配额或代码后，创建新批次或重试派生任务。
- Provider 的 auth、quota、timeout、model retirement、search-not-triggered、protocol change 是不同故障；必须保留原 Provider 和失败码，不得替换模型/平台或补写成功。
- quick audit、baseline、retest 必须分开。复测只与完整冻结 `config` 相同的 baseline 可比。
- 费用未知是 `null`；来源/Fan-out 不可见是 `unavailable`，都不能在运维修复时改成 0。

## 恢复原则

- Capture、Agent 和 PDF 使用不同租约与重试次数。只让未到最大尝试的过期租约被 Worker 正常重领；不要手工把未完成任务标成 complete。
- Provider 失败已经形成真实 QueryCapture 时，修复 Key/配额/网络后创建新的 baseline 或严格 retest，不修改原 capture。
- PDF 失败时复用已冻结 report snapshot，只修 Chromium、中文字体或对象存储后重试 PDF job，不重建 payload。
- Agent 失败时保留 tool trace 和 error；重新入队产生新的运行记录或按产品流程重试，不把未审批 draft 写入正式记录。
- 数据库写修复必须有精确实例、表、ID、预期行数、当前备份、显式授权和审计说明。先用事务或 `RETURNING` 证明目标；绝不对未指定外部数据库执行 migration 或修复。
- 删除证据、项目或对象属于破坏性操作。先解析关联行和 object prefix，验证备份可恢复，再单独请求确认。
- `service_logs` 可按明确机构和保留天数清理；`audit_logs` 与证据不可借用日志清理接口。所有清理先确认活动租户、预期范围和备份。

## 备份与恢复

- 本机备份前停止 `corepack pnpm geo start`，再运行 `corepack pnpm geo backup`；运行中的 PGlite 目录不能直接复制。
- 服务器本地对象模式用 `sudo geo-console backup` 创建同一时间点的 PostgreSQL dump 与 evidence archive，并核对两个文件均非空。
- S3 模式仍需 PostgreSQL dump，同时验证 bucket versioning、对象版本和实际恢复权限；数据库 dump 不等于完整备份。
- 仓库没有“一键原地恢复”命令。恢复必须进入新建空 PGlite/PostgreSQL 与隔离对象位置，完成健康、行数、随机 evidence 和报告抽查后再切换。

## 防飘逸

如果故障修复改变 Worker 拓扑、job/lease/retry、Provider 失败语义、健康检查、备份恢复或证据保留行为，它已属于重大功能变更。使用 [../geo-development/references/drift-control.md](../geo-development/references/drift-control.md) 重新核对代码事实源，在同一变更中更新 `docs/operations.md`、[references/runtime-runbook.md](references/runtime-runbook.md) 及其他触发的知识文件，并运行 `corepack pnpm check-drift -- --major ...`。只修现场配置或恢复现有设计内的服务不触发。

## 结束条件

报告根因、受影响范围、保留的失败证据、采取的恢复动作、备份状态和验证结果。只有服务健康、相关队列进入可解释终态、对象可读且用户工作流恢复后，才能宣布故障完成。
