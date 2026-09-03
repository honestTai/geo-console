/**
 * 报告 PDF/Word 等服务端渲染用的中文标签；页面端在 apps/web/src/types.ts 有同口径映射，
 * 两边保持一致，避免交付物里出现 retest / todo / owned 这类内部枚举。
 */

export const PRODUCT_NAME = "ZZ Geo";

const reportTypeLabels: Record<string, string> = {
	quick_audit: "售前快审报告",
	remediation: "整改方案报告",
	retest: "周期复测报告",
};

const taskStatusLabels: Record<string, string> = {
	todo: "待处理",
	in_progress: "处理中",
	published: "已发布",
	verified: "已验收",
	done: "已完成",
};

const priorityLabels: Record<string, string> = { high: "高优先级", medium: "中优先级", mid: "中优先级", low: "低优先级" };

const reputationLabels: Record<string, string> = {
	positive: "正面为主",
	mixed: "正负混合",
	negative: "负面为主",
	neutral: "中性",
	not_observed: "未观察到口碑",
};

const sourceCategoryLabels: Record<string, string> = {
	owned: "客户官网",
	competitor: "竞品站点",
	government: "政府/机构",
	social: "社交与内容平台",
	review: "点评/问答",
	encyclopedia: "百科",
	other: "其他网站",
};

const labelOf = (table: Record<string, string>, value: unknown): string => {
	const key = String(value ?? "");
	return table[key] ?? key;
};

export const reportTypeLabel = (value: unknown): string => labelOf(reportTypeLabels, value);
export const taskStatusLabel = (value: unknown): string => labelOf(taskStatusLabels, value);
export const priorityLabel = (value: unknown): string => labelOf(priorityLabels, value);
export const reputationLabel = (value: unknown): string => labelOf(reputationLabels, value);
export const sourceCategoryLabel = (value: unknown): string => labelOf(sourceCategoryLabels, value);
