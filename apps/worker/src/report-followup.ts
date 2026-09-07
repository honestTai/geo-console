import { metricGuide } from "@geo/metrics";
import { priorityLabel, taskStatusLabel } from "./labels";
import { evidencePlatformLabel } from "./report";

type FollowupLine = { title: string; detail: string; evidenceIds: string[]; urls: string[] };
const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const percent = (value: unknown) => (typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "无法判断");
const points = (value: unknown) => (typeof value === "number" ? `${(value * 100).toFixed(1)} 个百分点` : "无法判断");

/** Preserve approved tasks and frozen paired comparisons in every new report format. Never recalculate a delta. */
export function reportFollowup(payload: {
	report: { tasks?: Record<string, unknown>[] };
	comparison?: Record<string, unknown> | null;
}): FollowupLine[] {
	const tasks = (payload.report.tasks ?? []).map((task) => ({
		title: `整改任务：${task.title}`,
		detail: `${priorityLabel(task.priority)} · ${taskStatusLabel(task.status)}。负责人：${task.owner ?? "待分配"}。验收：${task.acceptance_criteria ?? "需先确认验收标准"}`,
		evidenceIds: strings(task.evidence_ids ?? task.evidenceIds),
		urls: task.published_url ? [String(task.published_url)] : [],
	}));
	const comparisons = rows(payload.comparison?.pairedResults).map((row) => {
		const result = (row.result ?? {}) as Record<string, unknown>;
		const name = metricGuide[row.metric as keyof typeof metricGuide]?.label ?? "监测指标";
		const interval = Array.isArray(result.interval)
			? result.interval.map(points).join(" 至 ")
			: "无法计算，不能判断显著变化";
		return {
			title: `同条件复测：${evidencePlatformLabel(String(row.provider_id ?? row.platform ?? "")) ?? "所测平台"} · ${name}`,
			detail: `仅比较前后共同可判断的 ${strings(result.promptIds).length} 个问题，不直接相减两次总分。基线 ${percent(result.previous)} → 复测 ${percent(result.current)}；变化 ${points(result.delta)}。95% 波动范围：${interval}。${result.status === "ready" ? "达到配对比较要求" : "证据不足，不下变化结论"}。不能仅凭时间先后声称文章或整改导致了变化。`,
			evidenceIds: [],
			urls: [],
		};
	});
	const sources = payload.comparison
		? [
				{
					title: "前后引用出处变化",
					detail: `本轮新增 ${strings(payload.comparison.newSources).length} 个出处；本轮未再次出现 ${strings(payload.comparison.lostSources).length} 个出处。未再次出现不等于网页失效或被平台删除。`,
					evidenceIds: [],
					urls: [...strings(payload.comparison.newSources), ...strings(payload.comparison.lostSources)],
				},
			]
		: [];
	return [...tasks, ...comparisons, ...sources];
}
