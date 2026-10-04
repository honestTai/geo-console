# 第三方声明

本产品工程以 Elmo 的 MIT 许可源码为起点：

- 项目：Elmo
- 上游地址：https://github.com/elmohq/elmo
- 原作者版权：Copyright (c) 2026 Blue Whale Software, LLC
- 许可证：MIT，完整文本见 `LICENSE.md`

本仓库不包含调研阶段下载的其他 GEO 项目。运行时 npm 依赖的许可证由
`corepack pnpm license-check` 校验；复用任何新的上游实现前，必须在此补充对应版权
和许可证信息。

关键运行依赖包括：

- `deepagents`、`langchain`、`@langchain/core`、`@langchain/langgraph`、`@langchain/openai`：MIT，用于受限领域 Agent 循环与模型接入，具体版本固定在 workspace lockfile。
- Node.js 24：随桌面客户端分发本机执行运行时；其完整许可证和捆绑组件声明包含在客户端 `runtime/NODE-LICENSE.txt`。
- Playwright / playwright-core 与 Chromium：用于客户端网站证据与 PDF 渲染。随包保留 Playwright 的 LICENSE/NOTICE，以及 Chromium 分发包内原始许可证/组件声明；不移除浏览器分发包中的法律声明。SQLite 使用 Node 内置实现，声明随 Node 分发许可证保存。
- `@aws-sdk/client-s3`：Apache-2.0，用于 S3 兼容不可变证据存储。
