# GEO Console Change Checklist

只执行与改动相关的专项检查，但交付前始终执行仓库四项总检查。

## 数据库与共享契约

- Schema 改动：新增编号 SQL migration，同时更新 `packages/core/src/schema.ts` 和依赖类型。
- 迁移测试：只用新建 PGlite 或明确隔离的 PostgreSQL；验证首次迁移和重复启动幂等性。
- 队列改动：覆盖 claim、租约续期、租约过期重领、最大尝试、延迟重试和可见终态。
- 证据改动：覆盖 append-only、对象键防穿越、同键拒绝覆盖、失败采集和 nullable 字段。
- 批次改动：覆盖 quick/baseline/retest、完整 config 冻结、严格可比性和范围版本保留。

## Provider 与指标

- Provider adapter 至少覆盖：成功、无来源、搜索未触发、鉴权、限流、超时、模型不可用、协议变化。
- 保存 endpoint、model、protocol、search tool、adapter version、Request ID、usage、latency、raw response 和失败码。
- 解析含义变化时提升 `ADAPTER_VERSION` 或 `searchToolVersion`，并验证旧冻结批次不会被新语义静默执行。
- 指标覆盖：失败平台不进入品牌率分母、平台等权、来源不可见返回 `null`、无提及时平均位置为 `null`、未知成本不变成 0。

## Agent、网站与报告

- Agent 覆盖：跨项目 ID、未知 evidence/prompt/task ID、Prompt injection 文本、Schema 拒绝、两次尝试、批准与拒绝。
- 批准动作必须再次验证归属；未经批准的 draft 不得更新 finding、task、content 或 report narrative。
- 网站抓取覆盖：协议限制、DNS 私网、重定向私网、超时、不可访问页面和快照对象落盘。
- 报告覆盖：类型规则、payload hash、不可变快照、PDF 排队/失败/重试、中文字体、CSV/JSON、分享过期和撤销。

## API、身份与 UI

- API 输入继续用 Zod 校验；写请求进入审计日志；运行时授权使用动态权限/策略；admin/analyst/viewer 仅为可扩展默认模板，不能夹带 system_only 权限。
- 认证变更覆盖生产环境 bootstrap、12 位密码下限、HttpOnly/Strict/Secure Cookie 和停用用户会话撤销。
- UI 覆盖真实 API 的 loading、empty、partial、queued、failed、permission 和 read-only 状态，不加入演示数据兜底。
- 手工检查工作台主流程、长中文/英文内容、桌面和 390px 移动宽度；确认工具栏、表格、弹窗和底部导航不重叠。

## 最终检查

`drift-control.md` 判定为重大功能变更时，先运行并通过：

```bash
corepack pnpm check-drift -- --major --base <pre-task-ref>
```

共享 dirty worktree 使用重复 `--file` 传入本任务文件，避免把用户已有改动误算为同步证据。

```bash
corepack pnpm check-types
corepack pnpm test
corepack pnpm build
corepack pnpm lint
```

修改依赖、锁文件、构建镜像或许可信息时再运行：

```bash
corepack pnpm license-check
docker compose config --quiet
```
## 测试环境隔离

Worker Vitest 通过 `apps/worker/vitest.config.ts` 在应用导入前加载 `src/test-support/environment.ts`：每个测试文件使用独立临时 GEO_DATA_DIR 和随机测试主密钥，缺失凭据由空文件返回 null，不回退到用户真实钥匙串。不得移除该隔离后依靠本机配置“跑绿”，不得在测试中连接继承的外部 DATABASE_URL 或写入默认业务目录；需要模型凭据的用例显式提供测试夹具。回归应包含一次 `corepack pnpm test --force`，避免旧缓存掩盖环境依赖。
