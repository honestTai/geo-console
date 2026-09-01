# GEO Console Incident Checklist

## 事件记录

记录以下字段，不要只保存截图或一段日志：

- 实例、时间窗、当前 release/commit
- project、batch、report、agent run、job ID
- batch kind、config hash、计划/有效/失败样本
- Provider、首个失败时间、failure code、Request ID
- job type/status、attempts/max attempts、lease owner/expiry、last error
- 数据库、对象存储、备份和可用磁盘状态

## 只读检查

服务器先执行有界检查：

```bash
sudo geo-console version
sudo geo-console status
sudo geo-console doctor
cd /opt/geo-console/current
docker compose --env-file .env logs --tail=200 api capture-worker agent-worker report-worker
```

不要默认使用持续跟随日志。需要数据库明细时，在确认当前目录就是目标实例后，用内部 PostgreSQL 执行只读查询：

```sql
SELECT type, status, count(*)::int
FROM jobs
GROUP BY type, status
ORDER BY type, status;

SELECT id, type, status, attempts, max_attempts, lease_owner,
       lease_expires_at, available_at, last_error,
       payload->>'batchId' AS batch_id,
       payload->>'runId' AS run_id,
       payload->>'reportId' AS report_id
FROM jobs
WHERE status IN ('pending', 'leased', 'failed')
ORDER BY created_at
LIMIT 200;

SELECT platform, status, failure_code, count(*)::int
FROM query_captures
WHERE batch_id = '<exact-batch-id>'
GROUP BY platform, status, failure_code
ORDER BY platform, status, failure_code;
```

示例执行方式：

```bash
docker compose --env-file .env exec -T postgres +  psql -U geo -d geo -P pager=off -c "SELECT type,status,count(*) FROM jobs GROUP BY type,status ORDER BY type,status"
```

不要把 Secret、完整 Provider response、回答正文或客户页面正文复制进普通日志/工单。

## 判断与动作

1. 服务缺失或反复退出：先读该服务最后 200 行日志，确认镜像、环境、Secret、数据库和对象存储，再决定 restart。
2. `pending` 且 `available_at` 已到：确认对应 Worker 存活；恢复 Worker 后观察是否被 claim。
3. `leased` 且未过期：确认 owner 对应进程，不要并发抢占。
4. `leased` 且已过期、attempts 未达上限：恢复单个正确 Worker，让正常 claim 逻辑重领。
5. Capture 已有非 complete QueryCapture：这是 Provider 结果，不是丢任务。分类修复后创建新批次。
6. Capture job 已过期、attempts 已达上限且没有 QueryCapture：当前 claim 条件不会再次领取。将其视为执行器异常的终态缺口；不得标 complete。先保存证据并修复代码/环境，只有获得精确写授权后才能把该 job 置为 failed 或创建替代批次。
7. Agent 最多两次，单次失败 30 秒后重试；最终失败保留 `agent_runs.error_message` 和 tool trace。
8. PDF 默认最多三次，单次失败 30 秒后重试；修复浏览器/字体/存储后只补 PDF job。

## 写修复前置条件

任何 SQL 写入前逐项确认：

- 用户明确授权该实例和具体修复
- 刚完成且可读取的备份
- 精确主键与预期影响行数
- 不修改 `query_captures` 或其 raw artifacts
- 不把缺失证据的 job 标为 complete
- 有 rollback SQL 或可在事务中验证并回滚
- 记录执行人、SQL、时间、影响行和后续新批次 ID
