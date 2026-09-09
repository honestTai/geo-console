# 第三方声明

本产品工程以 Elmo 的 MIT 许可源码为起点：

- 项目：Elmo
- 上游地址：https://github.com/elmohq/elmo
- 原作者版权：Copyright (c) 2026 Blue Whale Software, LLC
- 许可证：MIT，完整文本见 `docs/licenses/Elmo-MIT.txt`；上游保留原有权利。项目自有新增代码采用 AGPL-3.0-only，见根 LICENSE.md 与 NOTICE。

本仓库不包含调研阶段下载的其他 GEO 项目。运行时 npm 依赖的许可证由
`corepack pnpm license-check` 校验；复用任何新的上游实现前，必须在此补充对应版权
和许可证信息。

关键运行依赖包括：

- `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`：MIT，用于受限领域 Agent 循环。
- `@aws-sdk/client-s3`：Apache-2.0，用于 S3 兼容不可变证据存储。

官网与公开文档：

- GEOFlow 的 README 信息组织与官网分区作为设计参考，未复制其代码、文章或产品素材，也不继承或冒用其 AGPL 授权。
- CC Switch 的单图链接赞助形式作为排版参考，未使用其赞助商素材或优惠文案。
- HRouter 赞助图由本项目重新排版，仅用于经项目维护者指定的赞助链接；HRouter 名称与品牌权利归原权利人，不授予商标许可。
- 平台 logo 仅用于识别对应供应商；帮助截图为本项目已有公开脱敏资料，不是客户背书或效果证明。

- 豆包图标来自豆包官网公开 favicon（`lf-flow-web-cdn.doubao.com/obj/flow-doubao/favicon/new-doubao/128x128.png`）；HRouter 标识来自 `https://hrouter.net/hrouter-logo.svg`。仅用于品牌识别与跳转，品牌权利归各权利人。
