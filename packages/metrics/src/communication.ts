import type { QueryCapture } from "@geo/evidence";
import { mean, type OverallVisibilityMetrics, type VisibilityMetrics } from "./visibility";

/** Reader-facing definitions. These describe the calculation, never replace frozen scores. */
export const metricGuide = {
	brandMentionRate: {
		label: "品牌提及率",
		meaning: "AI 的回答有没有提到这家公司，不代表推荐或认可。",
		formula: "每个问题：提到品牌的有效回答数 ÷ 可用于品牌判断的回答数。",
		caution: "点名问公司的问题与不点名找供应商的问题要分开看；不是实际用户曝光率。",
	},
	recommendationRate: {
		label: "正向推荐率",
		meaning: "回答是否明确或隐含地建议选择这家公司。",
		formula: "每个问题：正向推荐品牌的有效回答数 ÷ 可判断回答数。",
		caution: "提到公司不一定推荐公司；带条件的推荐不等于无条件背书。",
	},
	explicitRecommendationRate: {
		label: "明确推荐率",
		meaning: "回答明确建议选择这家公司，而不只是提到它。",
		formula: "每个问题：明确推荐品牌的有效回答数 ÷ 可判断回答数。",
		caution: "未明确推荐不等于负面评价。",
	},
	firstRecommendationRate: {
		label: "首位推荐率",
		meaning: "回答是否把公司放在明确推荐名单的第一位。",
		formula: "每个问题：品牌被明确排在推荐首位的有效回答数 ÷ 可判断回答数。",
		caution: "0% 是本轮未观察到首位推荐，不是排名垫底；没有推荐名单时不能编造名次。",
	},
	monitoredBrandShare: {
		label: "监测品牌出现份额",
		meaning: "仅在已选监测品牌出现时，客户品牌占其中多少。",
		formula: "每个问题：客户品牌出现次数 ÷ 客户与已选竞品出现次数之和；没有任何监测品牌出现的问题不参与此项。",
		caution: "不是市场份额，也不包含监测名单之外的品牌。很少的出现次数也可能得到很高的份额。",
	},
	captureCoverage: {
		label: "采集覆盖率",
		meaning: "计划测试中，有多少取得符合要求的回答。",
		formula: "每个平台：成功取得回答数 ÷ 计划采集数。",
		caution: "这是检测完成度，不是企业表现或 AI 推荐概率。",
	},
	parseCoverage: {
		label: "解析覆盖率",
		meaning: "已取得的回答中，有多少能可靠地用于品牌判断。",
		formula: "每个平台：通过解析校验的回答数 ÷ 成功取得回答数。",
		caution: "有回答不等于能计算指标；无法判断的回答保留为未知，不记零分。",
	},
	promptCoverage: {
		label: "问题覆盖率",
		meaning: "计划问题中，有多少达到了最低有效回答要求。",
		formula: "每个平台：有效重复次数达标的问题数 ÷ 计划问题数。",
		caution: "这是检测完整度，不是市场需求覆盖率。",
	},
	citationRate: {
		label: "官网引用率",
		meaning: "AI 是否把官网明确列为答案引用出处。",
		formula: "每个问题：明确引用官网的回答数 ÷ 来源记录可观察的回答数；只在参与统计的问题中汇总。",
		caution: "搜索或浏览过官网不算最终引用。没有官网或来源不可观察时无法计算；0% 不代表官网未收录。",
	},
	sourcePresenceRate: {
		label: "官网来源出现率",
		meaning: "官网是否出现在搜索返回的来源记录中。",
		formula: "每个问题：来源中出现官网的回答数 ÷ 来源记录可观察的回答数。",
		caution: "来源出现不等于答案实际引用。",
	},
	sourceToCitationRate: {
		label: "来源转引用率",
		meaning: "官网出现于来源后，有多少被明确引用。",
		formula: "每个问题：明确引用官网的回答数 ÷ 来源中出现官网的回答数。",
		caution: "没有官网来源记录时无法计算，不能记作 0%。",
	},
	dataCoverage: {
		label: "正式结果覆盖率",
		meaning: "已配置的平台中，有多少达到正式统计要求。",
		formula: "达到正式统计要求的平台数 ÷ 配置平台数。",
		caution: "快速检测仅供初步参考，不能与采集覆盖率混淆。",
	},
	pairwiseAgreement: {
		label: "重复回答一致率",
		meaning: "同一问题多次测试时，是否一致地提到或不提到公司。",
		formula: "对同一问题的有效回答两两比较品牌提及判断，再按问题和平台等权汇总。",
		caution: "只问一次无法计算；一致不代表回答内容一定正确。",
	},
	medianRecommendationRank: {
		label: "明确推荐名次中位数",
		meaning: "在确实存在明确推荐名次的回答中，公司通常排在哪里。",
		formula: "仅统计明确推荐名单中有名次的有效回答，按问题与平台等权取加权中位数。",
		caution: "无明确名单显示无法判断；不是平台长期固定排名。",
	},
	sourceCoverage: {
		label: "来源可观察率",
		meaning: "已取得回答中，有多少提供了可检查的来源记录。",
		formula: "来源可观察的回答数 ÷ 成功取得回答数。",
		caution: "它不表示有多少回答最终引用了这些来源。",
	},
} as const;
export type MetricGuideKey = keyof typeof metricGuide;
export const aggregationExplanation =
	"先计算各平台每个问题的比例，再按问题等权、平台等权汇总。正式检测只纳入达标平台，快速检测提供初步结果。总次数仅用于核对，不能直接相除得到总分。失败、无法判断和缺少来源的数据不记为零分。";

export function guideForLabel(label: string) {
	return Object.values(metricGuide).find((guide) => guide.label === label || label === `整体${guide.label}`);
}

export function measurementStatusLabel(status: string | undefined): string {
	return status === "ready"
		? "达到正式统计要求"
		: status === "limited" || status === "partial"
			? "初步结果，仅供参考"
			: "暂时无法可靠判断";
}

export function failureExplanation(code: string | null | undefined): { reason: string; action: string } {
	const rows: Record<string, [string, string]> = {
		quota_exceeded: ["服务商额度不足", "补足额度或调整后续测试计划，再手动创建测试；已有回答不变。"],
		search_not_triggered: [
			"没有返回可验证的联网搜索记录",
			"检查该模型联网搜索是否可用，再按相同配置新建测试；不是企业内容差。",
		],
		no_answer: ["服务商没有返回回答正文", "核对该次响应和服务商状态，再按相同配置新建测试。"],
		rate_limited: ["服务商请求频率受限", "降低并发或等待限流恢复，再新建测试。"],
		timeout: ["服务商响应超时", "检查请求耗时和服务商状态，不要把超时解释为品牌未被提及。"],
		provider_error: ["服务商请求失败", "查看该次失败记录的具体错误，再处理对应问题；不预设登录或官网故障。"],
	};
	const [reason, action] = rows[code ?? ""] ?? [
		"本次回答未通过采集检查",
		"打开该次采集证据核对具体失败原因，再决定是否重测。",
	];
	return { reason, action };
}

export type ExplainableMetrics = {
	overall: OverallVisibilityMetrics;
	perPlatform: Record<string, VisibilityMetrics>;
	validSamples: number;
	expectedSamples: number;
	failedSamples: number;
	contract?: { sampling: { mode: string } };
};
export type ExplanationConfig = {
	project: { name: string; aliases: string[] };
	prompts: Array<{ id: string; question: string }>;
	repeats: number;
};
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
export function isNamedBrandQuestion(question: string, project: ExplanationConfig["project"]): boolean {
	const text = normalize(question);
	return [project.name, ...project.aliases].some(
		(alias) => normalize(alias).length > 1 && text.includes(normalize(alias)),
	);
}

/** Read-only explanation from the exact metric snapshot, not a fresh semantic parse. */
function hitCount(rate: number | null, valid: number): number | null {
	return rate === null ? null : Math.round(rate * valid);
}

export function explainMeasurement(
	metrics: ExplainableMetrics,
	config: ExplanationConfig,
	captures: QueryCapture[] = [],
) {
	const quick = metrics.contract?.sampling.mode === "quick";
	const platformIncluded = (status: string) => (quick ? status !== "unavailable" : status === "ready");
	const platforms = Object.entries(metrics.perPlatform);
	const questions = new Map(config.prompts.map((p) => [p.id, p]));
	const calculationRows = platforms.flatMap(([platform, m]) =>
		(m.prompts ?? []).map((p) => ({
			platform,
			promptId: p.promptId,
			question: questions.get(p.promptId)?.question ?? "历史问题未保存",
			named: isNamedBrandQuestion(questions.get(p.promptId)?.question ?? "", config.project),
			included: p.eligible && platformIncluded(m.status),
			reason: !p.eligible
				? "有效回答次数不足或解析未通过"
				: !platformIncluded(m.status)
					? "平台未达到本轮统计要求"
					: "纳入计算",
			valid: p.validRepeats,
			answered: p.successfulRepeats,
			mentions: hitCount(p.brandMentionRate, p.validRepeats),
			monitoredMentions:
				p.brandMentionRate === null
					? null
					: Math.round(
							(p.brandMentionRate +
								Object.values(p.competitorMentionRates).reduce<number>((sum, n) => sum + (n ?? 0), 0)) *
								p.validRepeats,
						),
			first: hitCount(p.firstRecommendationRate, p.validRepeats),
			mentionRate: p.brandMentionRate,
			share: p.monitoredBrandShare,
			evidenceIds: p.evidenceIds,
		})),
	);
	const segments = [false, true].map((named) => {
		const rows = calculationRows.filter((r) => r.named === named && r.included);
		return {
			named,
			label: named ? "点名问公司" : "不点名找服务或了解问题",
			plannedQuestions: config.prompts.filter((p) => isNamedBrandQuestion(p.question, config.project) === named).length,
			eligibleQuestions: new Set(rows.map((r) => r.promptId)).size,
			mentionRate: mean(platforms.map(([id]) => mean(rows.filter((r) => r.platform === id).map((r) => r.mentionRate)))),
			validAnswers: rows.reduce((s, r) => s + r.valid, 0),
			mentionAnswers: rows.reduce((s, r) => s + (r.mentions ?? 0), 0),
			evidenceIds: [...new Set(rows.flatMap((r) => r.evidenceIds))],
		};
	});
	const complete = captures.filter((c) => c.status === "complete");
	return {
		status: measurementStatusLabel(metrics.overall.status),
		quick,
		scope: `${config.prompts.length} 个问题，每个平台每题计划 ${config.repeats} 次，共 ${platforms.length} 个已配置平台。通过服务商接口测试，不代表手机应用或所有 AI 产品。`,
		limitation: quick
			? `本轮是快速检测，只用于初步排查；${config.repeats === 1 ? "没有重复测试，" : ""}未计算波动范围，不能判断长期排名或优化效果。`
			: "只代表本次问题、平台和时间条件；波动范围无法计算时，不判断稳定排名或显著变化。",
		counts: {
			planned: metrics.expectedSamples,
			answered: metrics.validSamples,
			parsed: platforms.reduce((s, [, p]) => s + p.validObservations, 0),
			failed: metrics.failedSamples,
		},
		platformCounts: platforms.map(([platform, p]) => ({
			platform,
			planned: p.plannedCaptures,
			answered: p.answeredCaptures,
			parsed: p.validObservations,
			eligibleQuestions: p.eligiblePromptCount,
			plannedQuestions: p.plannedPromptCount,
		})),
		sources: {
			withSearchSources: complete.filter((c) => c.sources.length > 0).length,
			withFinalCitations: complete.filter((c) => c.sources.some((s) => s.isCitation)).length,
			citationLinks: complete.reduce((s, c) => s + c.sources.filter((x) => x.isCitation).length, 0),
			unavailable: complete.filter((c) => c.captureMode === "llm_search_api" && c.sourceVisibility === "unavailable")
				.length,
		},
		segments,
		calculationRows,
		failures: captures
			.filter((c) => c.status !== "complete")
			.map((c) => ({ captureId: c.captureId, question: c.prompt, ...failureExplanation(c.failureCode ?? c.status) })),
	};
}
export type MeasurementExplanation = ReturnType<typeof explainMeasurement>;
