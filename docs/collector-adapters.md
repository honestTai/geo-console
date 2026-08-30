# 真实页面适配器契约

`CaptureAdapter` 的职责是页面会话检查、新对话、提问、等待生成、提取正文和提取来源。业务层只识别统一证据协议，不依赖页面 DOM。

## 修改原则

1. 平台改版只修改 `apps/collector/src/adapters.ts` 或新增对应适配器文件。
2. 优先使用语义稳定的 `textarea`、`role=textbox`、按钮文案和回答语义容器；选择器按可靠度排序。
3. 每题必须新建对话，不复用上题上下文。
4. 回答需连续多次内容不变才判定完成；超时保存 `timeout`，不得截取半成品为完整结果。
5. 引用只从最终回答容器内的 HTTP(S) 链接提取，保存 URL、域名、标题和顺序。Query Fan-out 只提取页面实际展示的搜索词或工具调用文本；页面没有展示时保存空数组。
6. 页面找到登录提示但没有输入框时保存 `login_required`；验证码保存 `challenge_required`；明显限流保存 `rate_limited`。
7. 登录正常但核心输入框或回答容器不存在时保存 `page_contract_changed`，以便运维发现平台改版。
8. 成功和失败均尽量保存全页截图、页面 URL、适配器版本和采集时间。适配器版本变化必须更新冻结批次的 Collector 版本，避免混入同配置趋势。

## 新增平台

第一版数据库枚举仅包含 DeepSeek 和 Kimi。新增豆包、元宝或通义时必须同步修改：

- `packages/evidence/src/schema.ts`
- `packages/core/src/schema.ts` 与新迁移
- `packages/surface-adapters/src/index.ts`
- Collector 适配器和会话状态测试
- Web 平台设置与指标显示
- Docker/运维文档中的账号与限流说明

不得在既有迁移文件中改枚举。为 PostgreSQL 新建向前迁移，并分别在空 PGlite 与测试 PostgreSQL 验证。
