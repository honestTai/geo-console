# GEO Console 防飘逸机制

防飘逸用于重大功能变更，目标是让代码、迁移、运行手册、部署说明和项目 skill 始终描述同一个系统。它不是要求每次小改动都重写文档。

## 何时触发

出现以下任一变化，按重大功能变更处理：

- 新增、删除或重分 Web/API/package/Worker/service 的职责或调用链。
- 修改数据库表、migration、证据 schema、对象格式、job type、状态机、租约或重试语义。
- 新增/删除 Provider，或修改协议、字段解释、搜索触发、失败分类、版本或口径披露。
- 修改指标分母、平台汇总、采样窗口、批次冻结、可比性、漂移阈值或费用含义。
- 修改 Agent 工具、审批写入、项目隔离、RBAC、凭据、抓取安全或报告不可变边界。
- 新增或重做主要用户工作流、报告类型、导入/导出、审计、整改或归因能力。
- 修改 Compose 拓扑、端口、Secret、对象存储、安装器、升级、备份、恢复或回滚行为。

以下通常不触发：不改变行为的重命名/重构、测试补充、文案纠错、纯样式微调、已有规则内的局部缺陷修复。若改动范围很大但判定为非重大，交付时要说明为什么没有改变上述契约。

## 开始前

1. 记录本次任务开始前的 Git 基准，例如 `git rev-parse HEAD`。不要把用户已有未提交改动算成本任务文件。
2. 从代码事实源重新确认受影响行为，不以当前 skill 或 docs 单独作为证据。
3. 写出影响面：architecture、domain、provider、operations、deployment、capability 中哪些会变化。
4. 明确对应测试、migration、运行恢复和发布兼容性。

## 同步矩阵

| 影响面 | 必须重新核对并按需更新 |
| --- | --- |
| architecture | `docs/architecture.md`、`references/project-map.md` |
| domain | `references/domain-contracts.md`、Drizzle Schema、evidence/metrics tests |
| provider | `docs/search-provider-adapters.md`、`references/domain-contracts.md`、adapter contract tests |
| operations | `docs/operations.md`、`../geo-operations/references/runtime-runbook.md` |
| deployment | `docs/deployment.md`、`../geo-deployment/SKILL.md` 或其 preflight/release reference |
| capability | `docs/capability-matrix.md`、`references/project-map.md`、真实 UI/API 状态 |

如果 routing、触发条件或关键边界改变，还要更新对应 `SKILL.md`；如果只是某个场景的细节改变，更新 reference 即可。不要复制容易变化的大段代码或默认值，优先指向事实源并保留会改变决策的规则。

## 交付前闭环

1. 从用户需求重新逐项检查：需求 -> 实现 -> 测试 -> docs/skill，不从实现反推需求已经满足。
2. 检查新增能力的失败、partial、权限、队列恢复、备份/回滚和证据语义。
3. 使用任务实际文件运行：

```bash
corepack pnpm check-drift -- --major --base <pre-task-ref>
```

共享 dirty worktree 中存在无关改动时，用重复 `--file` 只列本任务拥有的文件：

```bash
corepack pnpm check-drift -- --major \
  --file apps/worker/src/example.ts \
  --file docs/architecture.md \
  --file .agents/skills/geo-development/references/project-map.md
```

4. 再运行仓库四项交付检查。防飘逸检查通过不代表内容正确；必须人工复核同步文件确实描述新行为。
5. 交付说明列出触发的影响面、更新的知识文件和未能验证的外部条件。

## 检查器限制

`scripts/check-skill-drift.mjs` 根据路径推导影响面，并验证对应知识文件是否出现在同一变更集合中。它不会判断文字是否准确，也不会自动认定一个改动是否“重大”；重大性必须按上面的行为标准判断，不能为了绕过同步而降级分类。
