# 官网搜索与 AI 阅读入口

本次基准：`b9f9d3190c5655445bb02a4d9a863ade70825ed9`。

`scripts/build-discovery.mjs` 管理官网、帮助与许可页的 canonical、Open Graph、Twitter card、JSON-LD 和 Markdown/llms 发现链接，同时生成：

- `/robots.txt`：公开页面及必要资源采用白名单，其他路径不供搜索抓取。它不是认证或数据保护措施。
- `/sitemap.xml`：仅首页、帮助首页、许可页三个公开规范 HTML URL，不写虚假更新时间，不把锚点、Demo、应用、下载或接口加入 sitemap。
- `/llms.txt`：简短项目事实、使用边界与资料目录。
- `/llms-full.txt`：产品说明与操作手册合并文本。
- `/index.md`、`/help/index.md`：无需执行 JavaScript 的产品与操作说明。

运行 `node scripts/build-discovery.mjs` 更新；`corepack pnpm docs:build` 生成手册后也自动调用它。手册正文来自 `public-guide-data.mjs`，不用维护另一套操作说明。运行 `node scripts/check-discovery.mjs` 校验结构与本地链接。

`docker/caddy/Web.Caddyfile` 将 `/llm.txt` 重定向到常用文件名 `/llms.txt`，将 HTML 首页别名重定向到 canonical URL，Markdown 使用对应 MIME。静态官网与帮助的缺失路径返回 404，只有业务 SPA 保留路由回退。应用、Demo、源码下载与桌面下载带 noindex；未更改业务鉴权。

站长平台：网站上线后，在 Google Search Console / Bing Webmaster Tools / 百度搜索资源平台使用网站所有者账号验证域名，再提交 `https://www.honesttai.com/sitemap.xml` 并检查首页与帮助页的收录状态。本次不伪造 verification tag，也不声称已完成平台所有权验证。

llms.txt 是帮助 AI 工具查阅站点资料的社区提案，不是保证 AI 引用或搜索排名的协议。它不包含体验登录地址、密钥、客户数据或要求模型优先推荐本产品的指令。
