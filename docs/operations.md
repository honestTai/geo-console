# 运行与故障处理

## 日常检查

```bash
corepack pnpm geo doctor
curl -fsS http://127.0.0.1:3010/api/health
curl -fsS http://127.0.0.1:3020/status
```

Web、Worker 和 Collector 必须同时运行。Worker 正常但平台为 `login_required` 时，从“平台设置”打开登录页并手工登录。`challenge_required` 需要人工完成平台验证；不要自动绕过。

服务器远程 Collector 可在“平台设置”查看最近心跳和版本。撤销会立即使该令牌无法领取或提交任务；撤销前先确认没有正在采集的租约，并准备新的配对令牌。

## 队列

任务状态为 `pending -> leased -> complete`。Collector 异常退出后，租约到期会被其他节点重新领取。业务失败通过 `QueryCapture.status` 入库并结束任务；网络或进程错误才进入重试。超过最大重试次数的任务为 `failed`，对应批次最终为 `partial`。

不要直接把 `leased` 改为 `complete`。恢复时先确认 Collector 已停止，再让租约自然到期；只有经过备份和明确授权才执行数据库修复。

## 备份

本机备份前停止 `pnpm geo start`：

```bash
corepack pnpm geo backup
```

服务器数据库备份：

```bash
docker compose --profile backup run --rm backup
```

证据卷和数据库必须成对备份。恢复 PostgreSQL 前先启动新的空实例验证 dump；不要覆盖唯一生产副本。浏览器 Profile 包含登录态，不进入服务器备份或证据导出。

## 证据清理

默认保留所有原始采集。需要满足客户删除要求时，先导出报告和证据索引、停止对应批次，再删除整个客户项目及其专属 artifact 目录。不要只删除截图而留下指向失效对象的数据库记录。删除属于破坏性操作，必须在执行前确认项目 ID、目录和备份状态。
