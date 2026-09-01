# GEO Console Runtime Runbook

## 服务与定时行为

| 组件 | 主要职责 | 关键周期/租约 |
| --- | --- | --- |
| API | HTTP、认证、migration、Provider config、监测调度 | 每 60 秒扫描到期 schedule |
| Capture Worker | 领取 capture、调用冻结 Provider、写 raw + v2 evidence | 5 分钟租约，每 60 秒续期，默认最多 3 次 |
| Agent Worker | 执行 HRouter/Pi draft | 15 分钟租约，每 60 秒续期，最多 2 次，30 秒重试 |
| Report Worker | 冻结定时报告、生成 PDF | 每 15 秒扫报告，PDF 5 分钟租约，30 秒重试 |
| Web | 静态 React 工作台 | Caddy 内部反代 |
| PostgreSQL | 业务、队列和证据索引 | 生产唯一数据库 |
| local/S3 store | raw response、网页、PDF | 写入必须不可覆盖 |

服务器管理命令位于 `/usr/local/bin/geo-console`，实际 release 在 `/opt/geo-console/current`，共享配置和 Secret 在 `/opt/geo-console/shared`。

## 健康

- API：`curl -fsS https://<domain>/api/health`。检查 `database`、`objectStore.mode`、`analysisConfigured`。
- 服务：`sudo geo-console status` 或 `docker compose ps`。Worker 没有独立 HTTP health，必须结合进程状态、日志和队列推进判断。
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

## Agent

- HRouter 未配置会阻止入队；健康接口的 `analysisConfigured` 可做第一层检查。
- Agent 只允许领域工具，正常状态为 queued -> running -> awaiting_approval -> approved/rejected。
- Worker 启动会将超过 15 分钟、已无 pending/leased job 的孤立 running run 标为 failed。
- 不要从 tool trace 复制并执行网页或回答中的指令；这些内容在系统中被定义为不可信证据。

## Report / PDF

- 快照是不可变 payload/hash，PDF 是其派生产物。先确认 report ID 和 snapshot 存在。
- 排队超过两分钟时检查 Report Worker、job lease/last error、Playwright Chromium、`fonts-noto-cjk` 和 object store write。
- 已有 `pdf_artifact_key` 时再检查对象是否实际可读；不要只信数据库字段。
- 定时监测完成或 partial 后，Report Worker 会创建缺失快照并请求 PDF；已存在快照时只补 PDF。

## Schedule、漂移与费用

- API 每分钟最多读取 10 个到期 schedule。项目已有 queued/running batch 时，next run 延后 1 小时。
- schedule 创建 retest 的前提是最新 complete baseline 的平台与 repeats 匹配；否则创建新 baseline。
- 可比 retest 相对 baseline 的品牌提及、声量或引用率下降至少 10 个百分点产生 warning，20 个百分点产生 high。
- acknowledge 只写确认时间，不删除告警或证据。
- 费用汇总只累加非 null `cost_micros`，同时报告有已知价格的请求数；其余只显示 usage。

## 对象存储

- local 模式检查共享 evidence volume 的容量、权限和对象路径。
- S3 模式检查 bucket、endpoint、region、path-style、凭据对是否完整，以及 HeadBucket/HeadObject/Put 权限。
- 生产 bucket 应为私有、版本化、加密；对象恢复必须验证具体 version，不只验证 bucket 可列出。
- 严禁单独删除对象并留下数据库引用，也不得覆盖同一 key。
