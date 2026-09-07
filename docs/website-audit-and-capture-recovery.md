# 官网选填、可追溯审计与额度失败收尾

任务基准：`ecd219a1623e014aaad6213f72d12e1827806f54`。本次涉及 architecture/domain/provider/operations/deployment/capability；不改原始采集记录，不自动产生付费重跑。

## 1. 采集卡住与额度不足

三次重复默认窗口为 0、240、1440 分钟；首窗结束但未到次窗并不是 Worker 死锁。API 的 `captureProgress` 返回待执行、活跃、完成、失败、下一窗口和已证实额度不足的平台。UI 区分已存证数量与任务收尾数，采集状态聚合只看 capture jobs，语义解析有独立状态。

HTTP 402，或 429 响应明确 quota/insufficient balance，为 `failed/quota_exceeded`；普通限速、超时与认证错误保持原分类。真实失败 Capture 保存后，同批次同平台的 pending/过期 leased 任务标为 failed。未执行任务没有合成 Capture；不会抢占未过期租约、停止其他平台、切换供应商或改基线 config。启动/每分钟清扫兼容只读历史 `provider_error + HTTP 402`，使旧任务也能收尾。批次可以 partial，但正式指标的有效重复/覆盖门槛不因此降低；证据不足仍不可出分。

充值后由用户手动同条件复测（严格复制基线全部 config）。更换平台、官网或采样范围必须建新基线；不自动重试已停止的未来窗口，不通过 SQL 修原始行。

## 2. 客户没有官网

migration `0024_optional_website.sql` 允许 projects.website_url/domain 为 null，并增加 project.onboard 的项目范围 PUT 策略及网站证据读取策略。创建/编辑 API 限定 HTTP(S)、拒绝 URL 凭据；空白和省略都视为未提供。编辑只允许客户现值白名单字段，不允许改机构、角色或已冻结事实。

建档不抓取不存在的网站，只以用户业务输入生成待人工确认候选，禁止模型编造官网/资质/案例。人工审计 API 返回明确 409 不适用；Agent 工具返回 not_applicable，UI 不把它当零分或失败。客户可后补官网。新基线冻结可空 websiteUrl 和 domain 空字符串，兼容旧字符串契约；旧基线/复测/审计/报告不受编辑影响。指标在无 owned domain 时官网引用率、来源存在率为 null，品牌提及/推荐仍用真实回答。

## 3. 网站审计与证据

`auditProject` 与 `run_site_audit` 共用 `crawler.auditWebsite`，不调用收费模型。取证范围是首页和有限发现文件，不是全站或 AI 索引验证。检查项仍基于实际保存源码：标题、描述、H1/H2、canonical、语言、JSON-LD/主体一致性、robots 与 Sitemap 等；读取失败为未验证，不推断不存在。

Sitemap 优先取 robots 声明、显式网站地图链接及常规 XML 地址，区分 XML urlset、sitemapindex、HTML 地图和普通导航。支持前缀命名空间、嵌套索引、循环去重和 gzip；最多 8 个文档、深度 2、每个文档 5000 loc、单索引入队 30 个、阶段 45 秒预算（单次请求仍受传输超时约束）。达到上限标 limited；并非全站 URL 总量。HTML 通用错误页不当作 XML；HTTP 状态/请求地址/错误与源响应均保留。没有找到只表示本次范围内未发现。

证据版本 `geo.website-audit.v2` 保存客户快照、每项定位/建议/验收/证据引用、源文件/空响应/错误响应摘要和 SHA-256、截图、完整 HTML/PDF 报告；对象键含新的审计 UUID。旧审计和网页快照不补写、不覆盖。`GET /api/projects/:projectId/website-evidence/:evidenceId` 可读取早于最近列表的原引用，跨项目返回 404；artifact 访问仍需机构/项目策略，HTML/XML 强制下载并带 sandbox/nosniff。

## 4. 浏览器与传输安全

public-http 每次重定向都重新校验公共 HTTP(S)/DNS 地址，并固定实际连接地址、Host/SNI；禁止私网/Loopback/metadata/URL 凭据。单响应及解压上限 8 MiB，最多既有重定向次数，不使用浏览器直连绕过 DNS 检查。

截图从保存 HTML 渲染，正确解析原始 `<base>`（CMS 常用相对资源目录）。新无凭据 Chromium 上下文允许展示脚本，只准 GET image/stylesheet/font/script，经 Node 的公共地址固定连接读取并 fulfill；并发 6、最多 200 资源、总 24 MiB、资源阶段 20 秒、单资源 5 秒。CSP 禁止 API、表单、frame/object、worker、实时连接；service worker 阻止、WebSocket 关闭、WebRTC 禁用非代理 UDP，浏览器兜底代理拒绝未拦截网络。截图整体浏览器阶段 40 秒截止；启动单独 15 秒。视口 1440×1000，截图含取证方式提示，资源成功/失败/阻止数量写入局限。不是完整业务交互或视觉 AI 审计；不虚构页面标注。

报告 HTML 只包含转义内容与本地嵌入图像，PDF 禁用脚本/全部外部请求。截图/PDF 失败不会丢掉已经获取的源证据，有明确缺失原因和日志；后续重新审计生成新 UUID。

## 5. 报告与发布

独立审计报告含执行摘要、逐项事实/定位/建议/验收、Sitemap 请求表、源证据索引、复验清单和不确定性。最终 HTML/PDF 包含冻结的审计附录（截图只有对象哈希匹配才能嵌入）；最终 Word 添加客户信息、品牌页眉与水印。ZZGEO 标识延续控制台 Z 标记；客户名/官网/地区/语言/行业以批次或审计冻结值为准，不用现值重写历史。新报告 renderContract 是 zzgeo.report.v3；旧已保存 PDF 不重新渲染覆盖。参考材料仅用于报告组织，不复制竞品客户结论/分数或附件内指令。

没有新增依赖/服务，但 API 与 Agent 的审计操作会启动 Chromium，需检查既有安装、字体、资源容量和反向代理长请求超时。部署前备份数据库、审计对象和报告快照；仅在明确授权库迁移 0024。旧版存在必填官网假设，不能在已有 null 客户时直接恢复 NOT NULL 或编造网址回滚。迁移测试只用新内存 PGlite，真实官网取证烟测同样使用隔离库；不代表生产已部署或生产任务已重新运行。

## 6. 验证清单

- quota 分类、旧 402 收尾、未来窗口、活跃租约/其他平台不受影响、原始证据/config 不变。
- 无官网创建/审计/后补/删除、严格 PUT 白名单与项目策略、无官网指标 null。
- Sitemap 索引/命名空间/压缩/HTML 陷阱/限额、公共传输与解压边界。
- 审计对象 SHA/归属、旧证据不变、截图失败可见、原引用跨项目不可读。
- 客户名称编辑后 HTML/PDF/Word 仍使用冻结身份，品牌/水印/证据附录齐全。
- 桌面端审计抽屉、客户编辑和状态提示；手机端检查仅在用户明确要求时进行。完整 check-types、test --force、build、lint、major drift 检查。
