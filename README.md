# GEO Console

面向任意行业客户的真实 GEO 工作台。系统从客户官网建立画像，通过本机浏览器采集 DeepSeek 与 Kimi 消费端真实回答，保存原始证据，再完成诊断、整改和同条件复测。

```text
客户建档 -> 官网抓取与审计 -> 人工确认 -> 真实页面采集 -> 证据诊断 -> 整改发布 -> 同条件复测 -> 中文报告 -> 业务归因
```

运行时代码不包含示例公司、Mock 回答或演示指标。没有真实客户、API Key 和平台登录时，界面保持空状态。

## 本机运行

要求 Node.js 24、Corepack 和 pnpm 11。

```bash
corepack pnpm install
corepack pnpm geo setup
corepack pnpm geo start
```

打开 <http://127.0.0.1:3000>。DeepSeek API Key 用于自动建档和可选诊断增强；没有 Key 时可手工确认真实竞品和问题。真实采集仍需在“平台设置”分别登录所选的 DeepSeek、Kimi 页面。
Collector 会优先复用系统 Chrome；没有 Chrome 时运行 `corepack pnpm --filter @geo/collector exec playwright install chromium`，也可用 `GEO_CHROME_PATH` 指定可执行文件。

本机数据保存在 `~/Library/Application Support/GEO Console/`：

- `database/`：PGlite 文件数据库
- `artifacts/`：网页快照与采集截图
- `browser-profiles/`：平台 Cookie 和持久浏览器 Profile
- `collector.json`：本机 Collector 节点令牌，权限为当前用户可读
- `backups/`：本机离线备份

这些文件不写入 Git。DeepSeek Key 在 macOS 上保存到系统钥匙串。

## 常用命令

```bash
corepack pnpm geo setup
corepack pnpm geo start
corepack pnpm geo doctor
corepack pnpm geo backup
corepack pnpm check-types
corepack pnpm test
corepack pnpm build
corepack pnpm lint
corepack pnpm license-check
```

## 文档

- [架构与数据边界](docs/architecture.md)
- [统一产品能力矩阵](docs/capability-matrix.md)
- [真实页面适配器契约](docs/collector-adapters.md)
- [运行与故障处理](docs/operations.md)
- [本机和服务器部署](docs/deployment.md)

## 许可

本项目按 [MIT License](LICENSE.md) 发布。保留的第三方来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
