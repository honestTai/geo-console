# 运行与故障处理

## 健康检查

```bash
corepack pnpm geo doctor
curl -fsS http://127.0.0.1:3010/api/health
docker compose ps
docker compose logs --tail=200 api capture-worker agent-worker report-worker
```

服务器离线发布包安装后优先使用：

```bash
sudo geo-console doctor
sudo geo-console logs api
sudo geo-console logs capture-worker
sudo geo-console logs agent-worker
sudo geo-console logs report-worker
```

健康响应会标识数据库类型、对象存储模式、HRouter 配置状态和云端采集模式，不暴露 Key 或完整模型配置。

## 采集队列

Capture 任务状态为 `pending -> leased -> complete`。进程退出后租约过期即可被其他 Worker 领取。供应商的鉴权、限流、超时、模型下线和协议变化会写入不可变 `QueryCapture`；不得补数或改写为成功。

排查部分批次时记录批次 ID、配置哈希、计划/有效/失败样本和按平台失败码。先修复 Key、配额、网络或适配器，再创建新基线或严格复测。不要手工把未完成租约改成 `complete`。

## Report Worker

PDF 请求创建 `report_pdf` 数据库任务。页面显示排队超过两分钟时检查 Report Worker、Chromium、中文字体、对象存储写权限和任务 `last_error`。报告 payload 已冻结，不需要重建快照；修复环境后让任务按租约重试。

Report Worker 每 15 秒检查一次定时监测最近完成的批次。该批次尚无快照时会自动冻结售前、整改或周期复测报告，并创建 PDF 任务；已存在快照时只补齐缺失的 PDF 任务。Agent 报告叙述仍需人工批准，不会被自动写入正式快照。

## Agent Worker

Agent 请求只创建 `agent_draft` 数据库任务并立即返回。Agent Worker 按租约执行，页面轮询展示排队、工具步骤、结构校验重试、Token、失败原因与待审批草稿。单次失败会在 30 秒后重试一次；不要手工把未完成任务改成成功。

## 漂移与费用

复测相对正式基线下降至少 10 个百分点时生成漂移告警，20 个百分点为高等级。确认告警不会删除证据。费用只有供应商明确返回时才汇总金额；否则展示请求和 Token，并标注费用未知。

## 备份恢复

本机备份前停止 `pnpm geo start`，再运行 `corepack pnpm geo backup`。服务器使用 `docker compose --profile backup run --rm backup`。数据库与本地证据卷必须同一时间点恢复；S3 模式应先验证对象版本仍存在。

恢复必须进入新建空 PGlite/PostgreSQL，运行健康与证据抽查后再切换。不要直接覆盖唯一实例。服务器发布包在 `/opt/geo-console/releases/` 保留历史应用版本，但仅切换应用软链接不能撤销不兼容数据库迁移。

## 证据保留

默认永久保留 `query_captures`、网页快照、原始响应和报告快照。客户删除请求属于破坏性操作：先解析准确项目 ID、报告关联、对象前缀、审计要求和备份状态，再获得明确确认。禁止只删对象而保留悬空数据库引用。
