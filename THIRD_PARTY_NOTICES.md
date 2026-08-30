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

- `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`：MIT，用于受限领域 Agent 循环。
- `@aws-sdk/client-s3`：Apache-2.0，用于 S3 兼容不可变证据存储。
