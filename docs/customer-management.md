# 机构客户管理

最近一次功能变更基准：`cda16814acd229863a38f3673fa3d98501a4fee3`。机构菜单统一管理客户资料、封档和删除，沿用项目与证据数据库。

## 能力与入口

- “机构管理 → 客户管理”，不用先选客户；客户工作台内同一机构分组也可打开同一页面。
- 复用真实 `/api/projects` 分页和名称/域名/行业搜索，显示客户名称、官网、地区/行业、建档状态、批次数量与最近运行时间。
- 新建复用独立的 `CreateProject` 弹窗；官网选填。创建后刷新真实身份中的客户范围及列表，刷新失败明确提示“已创建”，不诱导重复创建。
- 编辑复用 `ProjectProfileEditor`，仅更新当前客户资料，支持后补官网，不重写基线配置、原始证据、旧审计或报告。
- 账号有客户工作台页面权限时才显示进入入口；仅有客户管理权限时不进入未授权项目页。
- 列表支持全部、未封档、已封档筛选。封档需确认，之后仅查看和下载历史资料；不提供解封入口。
- 删除分两步确认：先展示影响，再输入客户全名。服务端同时校验 `confirmed: true` 和当前名称，改名后的旧确认失效。
- 删除为逻辑删除，客户从列表与授权候选中消失，项目、子资源、文件和原有公开分享均无法访问；不物理删除原始证据，不提供系统内恢复入口。
- 删除末页最后一条后服务端返回有效页码；切换每页条数只发送一次分页请求。少量记录隐藏页码条，客户总数仍在筛选栏显示。

## 授权与迁移

`0025_customer_management.sql` 在 0024 后注册 page.customers（机构管理，position 88），仅扩展 GET /api/projects 的读取 any_of。它不授予项目详情、采集、证据、创建或编辑权限。列表仍在服务端同时限定当前机构与成员可见 projectIds；前端不接受机构参数来越权切换。

既有机构/角色只从已有 page.overview 授权补上等价客户列表菜单，撤销的机构上限不恢复；新机构默认角色通过 core/access 的目录获得该菜单，只读角色仍没有写权限。创建仍要求 project.create，编辑仍要求 project.onboard；这两个动作的原有授权与归属保持不变。

`0027_project_lifecycle.sql` 增加 archived_at/deleted_at、project.archive/project.delete 和两条 HTTP 策略。既有机构/角色需显式授予新权限；新机构管理员模板包含新动作，分析师和只读模板不含。状态入口继续限制机构与成员客户范围。

`POST /api/projects/:projectId/archive` 和 `DELETE /api/projects/:projectId` 在事务中重新授权并锁定项目。未结束的队列任务、运行中的 AI 会话/分析会返回 409，等待完成或终止会话后再操作；封档/删除不会抢占采集中请求。完成后停用周期监测，历史待审批草稿不再自动批准或物化。

`project-state.ts`、HTTP/Artifact 授权与后台执行授权提供读取/写入限制；数据库触发器使用项目共享锁，防止已通过授权的并发请求在封档后继续写入。直接项目表和通过会话/报告/分析运行关联的子表均受保护。新增项目子表必须登记触发器映射；日志和成员授权关系不属于历史业务内容。

部署须先备份，在明确授权库执行 0027 后统一更新 API/Web/Workers。备份包含状态字段、原始行与对象文件。回滚到不理解 deleted_at 的代码会重新暴露已删除客户，因此不可直接回退旧 API；保留新迁移和访问保护，修复后重新发布。此开发任务只在新测试 PGlite 上迁移。

## 实现与验收

- 页面：CustomerManagement；共享表单：CreateProject / ProjectProfileEditor；装配：App / Management；声明注册：ui/workspace-views / lazy-views。
- API：listProjects / createProject / updateProjectProfile；封档与删除由 project-lifecycle 处理，状态判断由 project-state 处理。
- 新内存 PGlite 测试：迁移、默认只读角色、列表权限与写/详情拒绝、跨机构/受限客户过滤、官网可空和搜索分页。
- Web 测试：菜单归类、只读按钮门控、创建/编辑独立权限、列表可恢复错误；桌面浏览器验证确认步骤、状态筛选与分页。数据库测试验证权限、忙碌拒绝、只读防写、分享/文件失效及原始 Capture 行未变。
- 交付执行 check-types、test --force、build、lint 和 major check-drift；提交/推送不代表已执行线上迁移或部署。
