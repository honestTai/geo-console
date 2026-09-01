# GEO Console Project Map

## 工具链

- Node.js `24.x`，根 `packageManager` 固定 pnpm 11；所有命令使用 `corepack pnpm`。
- Turborepo 编排 build/check-types/test；Biome 负责 TS/CSS lint 与格式。
- `scripts/check-skill-drift.mjs` 根据重大变更的任务文件推导影响面，检查对应 docs/skill reference 是否同步。
- 本机默认 PGlite；存在 `DATABASE_URL` 时切换 PostgreSQL。
- 本机对象写入 `GEO_DATA_DIR/artifacts`；`GEO_OBJECT_STORE=s3` 时使用 S3 兼容存储。

## 运行拓扑

```text
Browser -> Caddy -> static landing (/)
                 -> React Web (/app/)
                 -> API (apps/worker/src/index.ts) -> PGlite/PostgreSQL
                                                  -> local/S3 artifacts
Capture Worker -> frozen provider adapter -> raw response + QueryCapture v2
Agent Worker   -> HRouter/Pi Agent -> pending structured draft -> human approval
Report Worker  -> immutable snapshot -> Playwright PDF -> artifact store
```

本机 `corepack pnpm geo start` 启动 API、Capture Worker、Agent Worker、Report Worker 和 Vite Web。服务器 Compose 将五个应用服务分开，只有 Caddy 暴露 80/443。

## 所有者地图

| 关注点 | 首要事实来源 | 主要消费端 |
| --- | --- | --- |
| 数据库接口、迁移执行 | `packages/core/src/database.ts`、`packages/core/migrations/` | 所有 Worker/API |
| 表、枚举、冻结配置 | `packages/core/src/schema.ts` | service、workers、tests |
| Capture 租约 | `packages/core/src/repository.ts` | `cloud-runner.ts` |
| 证据 JSON 契约 | `packages/evidence/src/schema.ts` | adapters、cloud runner、metrics、reports |
| 五平台协议 | `packages/search-providers/src/*.ts` | `apps/worker/src/providers.ts` |
| 指标分母与汇总 | `packages/metrics/src/visibility.ts` | batch/report UI |
| HTTP、RBAC、公开分享 | `apps/worker/src/index.ts`、`auth.ts` | `apps/web/src/api.ts` |
| 项目、批次、诊断、整改、漂移 | `apps/worker/src/service.ts` | API、Web |
| 官网抓取与审计 | `apps/worker/src/crawler.ts` | onboarding、audit、diagnosis、verification |
| Provider 配置与密钥 | `apps/worker/src/providers.ts`、`packages/core/src/secrets.ts` | Settings、Capture Worker |
| Agent 工具与审批 | `apps/worker/src/agent.ts`、`agent-jobs.ts` | Agent Worker、Web |
| 报告快照/PDF/分享 | `apps/worker/src/report-snapshots.ts`、`report.ts` | Report Worker、Web |
| 归因 CSV | `apps/worker/src/attribution.ts` | Attribution view |
| 对象存储 | `apps/worker/src/object-store.ts` | captures、snapshots、PDF |
| 工作台 UI | `apps/web/src/App.tsx`、`styles.css` | browser |
| 静态官网 | `landing/` | browser root path; no API/DB access |
| 本机 CLI | `scripts/geo.ts` | setup/start/doctor/backup |
| 防飘逸检查 | `scripts/check-skill-drift.mjs`、`references/drift-control.md` | 重大功能变更交付 |
| 服务器发布 | `compose.yaml`、`docker/`、`deploy/` | installer/management command |

## 业务数据流

1. 项目创建后抓取官网证据，生成画像、竞品和 Prompt 候选；人工确认后项目进入 active。
2. 创建批次时读取已批准范围和启用 Provider，将完整配置写入 `experiment_batches.config` 与 hash，并为每个采样创建 capture job。
3. Capture Worker 只按冻结 Provider 契约执行；原始响应先写对象存储，再以唯一 `job_id` 插入 QueryCapture v2，最后完成 job 和批次状态。
4. 指标从采集证据确定性计算。规则诊断可更新派生 finding；模型诊断只产生待审批 Agent draft。
5. finding 转整改任务；发布 URL 必须重新抓取形成网站快照，再进行相同 baseline config 的 retest。
6. 报告冻结 payload/hash 后才进入 PDF 队列；分享链接只存 token hash，支持过期与撤销。
7. 归因 CSV 按 `sourceType + csv` 内容 hash 防重复，和 GEO 指标并列展示，不自动声称因果。

## Web 工作台

`App.tsx` 当前包含项目总览、AI 监测、证据中心、官网审计、诊断、整改、业务归因、复测报告、平台设置、机构成员和审计日志。后三项仅管理员可见；平台设置使用本地真实 Logo 的五平台 tab，每次只显示一个 Provider 表单。移动端底部导航和平台 tab 均允许横向滚动。监测运行面板只能从真实批次状态、预期样本数和 Capture 记录计算进度与日志；报告先呈现管理摘要、核心指标和整改前后对比。

图表、KPI 与平台卡只消费真实 API 响应；无批次时使用空状态，不能把视觉验收 fixture 放入 `apps/web/public` 或正式构建。UI 仍是单文件应用壳；新增共享业务规则时不要继续堆入组件，应放回拥有该规则的 package/worker service。

`landing/` 是独立静态官网，部署在根路径；`apps/web` 使用 Vite base `/app/`。官网演示同步工作台菜单顺序和浅色布局，并为菜单、运行操作、设置、成员和日志提供窄屏交互；示意数据必须显式标注，不能请求业务 API、写数据库或被工作台导入。

API 使用 same-origin Cookie。公开面只有登录、健康检查和带 token 的报告分享；Artifact 需要登录。Settings、用户和审计日志要求 admin，其他写操作要求 analyst，读操作要求 viewer。
