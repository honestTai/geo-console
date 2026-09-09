# 参与 ZZ Geo 社区

欢迎改进完整系统：前端、API、采集、证据、指标、Agent、报告、部署与文档均可贡献。项目自有源码采用 AGPL-3.0-only；第三方代码保留原许可。

提交修改前请阅读 [许可证](LICENSE.md)。确保你有权提交代码或素材，注明第三方来源；不要提交客户数据、密钥、接口原始响应、数据库、日志、签名私钥或带环境配置的发行包。

报告问题时，请描述复现步骤、浏览器版本及预期行为。安全问题不要公开附带敏感细节，请发邮件至 [honest.tai@outlook.com](mailto:honest.tai@outlook.com)。

外部贡献者保留版权，提交用于本项目的贡献按 AGPL-3.0-only 提供；不会自动转让版权或授予维护者闭源再许可权。若另需授权，应取得相关权利人书面同意。

开发要求 Node.js 24、`corepack pnpm` 11。请运行 `corepack pnpm check-types`、`corepack pnpm test`、`corepack pnpm build`、`corepack pnpm lint`；指标、证据和批次配置变更还需说明兼容性。测试只使用新建隔离数据库，不改写原始采集证据。
