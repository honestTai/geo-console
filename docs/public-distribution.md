# 完整开源发行

v0.1.0 起，用户源码入口统一在 GitHub：官网/README 使用仓库或 Releases，工作台源码链接固定到 v0.1.0 Release；未来版本更新须同步版本链接。旧 `/source/*` 地址 302 到该 GitHub 版本。站内 ZIP 保留为内部制品完整性校验输入，不再作为用户下载渠道；同一归档以版本文件名上传 GitHub Release，附 SHA-256。首版说明见 `docs/releases/v0.1.0.md`。

当前使用原 GitHub 仓库 `honestTai/geo-console` 维护和公开源码。公开前检查全部历史，移除内部主机与验收地址并复扫；不要求同步维护第二个仓库。Docker quickstart 源码入口位于 `docker/quickstart/`。官网交互区是独立 React 模拟 Demo，20 个菜单仅改内存记录，CSP 禁止网络连接；生成文件在 `landing/interactive/`，源码位于 `apps/web/src/preview/`，不混入业务运行时。

决策基准：`d880e092ec9342362161775f68bbe100d6d39fd0`。项目自有代码采用 AGPL-3.0-only，允许依协议商业使用；不保留私有核心。Elmo 上游部分保留 MIT，见 NOTICE 和第三方声明。

## 公开范围

全部 Web、API、Worker、核心业务 packages、数据库迁移、桌面源码、构建脚本、依赖锁文件与必要配置模板。完整运行仍需用户配置供应商密钥、基础设施和主密钥。软件开源不免除第三方 API 成本。

`scripts/export-source.mjs` 只导出登记的源码根目录与根文件，排除 `.git`、`.agents`、本地 `.env`、secrets、日志、备份、数据库、构建输出、签名密钥、旧截图和内部历史验收报告。检查符号链接与已知敏感内容，并生成 SOURCE_MANIFEST.json。扫描不能替代人工审阅。

## 生成流程

```bash
corepack pnpm docs:build
corepack pnpm docs:check
corepack pnpm test:source
corepack pnpm export-source output/source-release
python scripts/package-source.py output/source-release landing/source/zzgeo-source.zip
```

先从新版帮助 HTML 生成 PDF，再导出源码。ZIP 不包含自身，不覆盖已有产物，附 SHA-256。每次修改源码应使用新的导出目录和归档路径；把核验后的归档作为同次 release 的静态资源发布。完整源码与应用在同一 release 内，不能使用旧源码包应付新版本的网络源码提供义务。

归档同时输出 `.manifest.json`；`deploy/package.sh` 在构建前用 `verify-source-release.mjs` 校验 ZIP 哈希及清单内全部当前源文件哈希，不匹配则停止。release 静态文件列表跳过已删除文件，拒绝符号链接，并携带 NOTICE 与上游许可。新增加的业务模块应保持在完整源码导出范围内。

已有开发仓库不直接改为公开，以免泄露历史秘密。公开仓库应从清洁源码快照建立新历史。本次官网直接提供完整源码 ZIP，GitHub 仓库是否公开单独管理，不把当前私有远程当作可访问的下载入口。

## 官网和文档

`landing/index.html` 为完整开源官网，`licensing.html` 与 `LICENSE.txt` 披露 AGPL；HRouter 单图赞助链接保留。申请体验统一 `mailto:honest.tai@outlook.com`，不公开托管体验登录地址。`demo.html` 为旧入口兼容申请页。工作台和登录页通过 `/source/zzgeo-source.zip` 提供本版本源码。

`scripts/public-guide-data.mjs` 是 21 章内容源，`build-public-docs.mjs` 生成 `landing/help/index.html` 和 `docs/user-guide.md`。帮助截图是当前线上界面，20 张图放在 `landing/help/assets/current/`；客户与敏感业务内容脱敏，真实空状态不填假数据。生成 PDF 时加载所有图片，打印全部章节，避免检索状态影响打印。

## 验证与部署

验证文档锚点、资源、隐藏体验地址、许可证与源码覆盖；检查浏览器图片切换、FAQ、搜索和打印。运行四项仓库检查、license-check、source tests、major drift。部署沿用 `deploy/package.sh`，校验制品、备份并升级，线上核对官网/帮助/PDF/源码包和服务健康。没有新增 migration，不改原始证据，不发起收费采样或外部发布。
