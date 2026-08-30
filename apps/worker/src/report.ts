import type { FrozenBatchConfig, WebsiteAuditResult } from "@geo/core";
import type { QueryCapture } from "@geo/evidence";
import type { OverallVisibilityMetrics, VisibilityMetrics } from "@geo/metrics";

type BatchMetrics = {
	perPlatform: Record<string, VisibilityMetrics>;
	overall: OverallVisibilityMetrics;
	validSamples: number;
	failedSamples: number;
	expectedSamples: number;
};

export type ReportFinding = {
	category: string;
	title: string;
	detail: string;
	confidence: number;
	evidenceIds: string[];
	targetPromptIds: string[];
	recommendation: string;
};

export type DiagnosisWebEvidence = {
	id: string;
	role: "customer" | "competitor" | "citation";
	url: string;
	domain: string;
	title: string | null;
	content: string;
	structuredData: unknown[];
};

export type ReportAnalysis = {
	generatedAt: string;
	executive: {
		headline: string;
		summary: string;
		evidenceLevel: "高" | "中" | "低";
		validityNote: string;
	};
	promptRows: Array<{
		promptId: string;
		question: string;
		intent: string;
		tags: string[];
		completeSamples: number;
		plannedSamples: number;
		targetMentionRate: number;
		firstRecommendationRate: number;
		bestTargetPosition: number | null;
		sourceCount: number;
		competitors: Array<{ id: string; name: string; mentionRate: number; bestPosition: number | null }>;
		captures: Array<{
			captureId: string;
			platform: string;
			attempt: number;
			status: string;
			targetPosition: number | null;
			sourceCount: number;
			screenshotKey: string | null;
		}>;
	}>;
	sourceDomains: Array<{
		domain: string;
		citationCount: number;
		promptCount: number;
		isOwned: boolean;
		urls: Array<{ url: string; title: string | null; count: number }>;
	}>;
	perceptionExcerpts: Array<{
		text: string;
		captureId: string;
		question: string;
		platform: string;
	}>;
	topicCoverage: Array<{
		promptId: string;
		question: string;
		terms: Array<{
			term: string;
			customerEvidenceIds: string[];
			externalEvidenceIds: string[];
		}>;
	}>;
	webEvidenceSummary: { customerPages: number; competitorPages: number; citationPages: number };
	strengths: ReportFinding[];
	gaps: ReportFinding[];
	websiteAudit: { id: string; result: WebsiteAuditResult } | null;
};

const normalizeDomain = (value: string): string =>
	value
		.trim()
		.toLowerCase()
		.replace(/^www\./, "");
const percentage = (value: number): string => `${Math.round(value * 100)}%`;

function bestPosition(captures: QueryCapture[], brandId: string): number | null {
	const positions = captures.flatMap((capture) =>
		capture.brandMatches.filter((match) => match.brandId === brandId).map((match) => match.position),
	);
	return positions.length ? Math.min(...positions) : null;
}

function perceptionExcerpts(captures: QueryCapture[], aliases: string[]): ReportAnalysis["perceptionExcerpts"] {
	const values: ReportAnalysis["perceptionExcerpts"] = [];
	const seen = new Set<string>();
	for (const capture of captures) {
		if (capture.status !== "complete" || !capture.answerText) continue;
		const sentences = capture.answerText
			.split(/(?<=[。！？!?])|\n+/)
			.map((sentence) => sentence.replace(/\s+/g, " ").trim())
			.filter(Boolean);
		for (const sentence of sentences) {
			if (!aliases.some((alias) => sentence.toLowerCase().includes(alias.toLowerCase()))) continue;
			const text = sentence.slice(0, 260);
			if (seen.has(text)) continue;
			seen.add(text);
			values.push({ text, captureId: capture.captureId, question: capture.prompt, platform: capture.engine });
			if (values.length >= 8) return values;
		}
	}
	return values;
}

function buildSourceDomains(captures: QueryCapture[], ownedDomain: string): ReportAnalysis["sourceDomains"] {
	const domains = new Map<
		string,
		{ citationCount: number; prompts: Set<string>; urls: Map<string, { title: string | null; count: number }> }
	>();
	for (const capture of captures) {
		if (capture.status !== "complete") continue;
		for (const source of capture.sources) {
			const domain = normalizeDomain(source.domain);
			const current = domains.get(domain) ?? { citationCount: 0, prompts: new Set<string>(), urls: new Map() };
			current.citationCount += 1;
			current.prompts.add(capture.promptId);
			const url = current.urls.get(source.url) ?? { title: source.title, count: 0 };
			url.count += 1;
			current.urls.set(source.url, url);
			domains.set(domain, current);
		}
	}
	return [...domains.entries()]
		.map(([domain, value]) => ({
			domain,
			citationCount: value.citationCount,
			promptCount: value.prompts.size,
			isOwned: domain === normalizeDomain(ownedDomain),
			urls: [...value.urls.entries()]
				.map(([url, meta]) => ({ url, title: meta.title, count: meta.count }))
				.sort((left, right) => right.count - left.count),
		}))
		.sort((left, right) => right.citationCount - left.citationCount || left.domain.localeCompare(right.domain));
}

function includesTerm(content: string, term: string): boolean {
	return content.replace(/\s+/g, "").toLowerCase().includes(term.replace(/\s+/g, "").toLowerCase());
}

function buildTopicCoverage(
	config: FrozenBatchConfig,
	webEvidence: DiagnosisWebEvidence[],
): ReportAnalysis["topicCoverage"] {
	return config.prompts.map((prompt) => ({
		promptId: prompt.id,
		question: prompt.question,
		terms: [...new Set(prompt.tags.map((tag) => tag.trim()).filter((tag) => tag.length >= 2))].map((term) => ({
			term,
			customerEvidenceIds: webEvidence
				.filter((item) => item.role === "customer" && includesTerm(item.content, term))
				.map((item) => item.id),
			externalEvidenceIds: webEvidence
				.filter((item) => item.role !== "customer" && includesTerm(item.content, term))
				.map((item) => item.id),
		})),
	}));
}

export function buildDeterministicFindings(input: {
	projectId: string;
	config: FrozenBatchConfig;
	captures: QueryCapture[];
	metrics: BatchMetrics;
	websiteAudit: { id: string; result: WebsiteAuditResult } | null;
	webEvidence?: DiagnosisWebEvidence[];
}): ReportFinding[] {
	const { projectId, config, captures, metrics, websiteAudit, webEvidence = [] } = input;
	const complete = captures.filter((capture) => capture.status === "complete");
	const findings: ReportFinding[] = [];
	if (metrics.failedSamples > 0) {
		const failed = captures.filter((capture) => capture.status !== "complete");
		findings.push({
			category: "样本质量",
			title: "部分真实采样未完成",
			detail: `${metrics.expectedSamples} 个计划样本中 ${metrics.validSamples} 个有效、${metrics.failedSamples} 个失败。失败样本保留原状态，未用替代回答补齐。`,
			confidence: 1,
			evidenceIds: failed.map((capture) => capture.captureId),
			targetPromptIds: [...new Set(failed.map((capture) => capture.promptId))],
			recommendation: "先处理登录、验证、限流或页面契约问题，再按相同冻结配置补建新批次。",
		});
	}
	if (complete.length && metrics.overall.brandMentionRate >= 0.6) {
		const evidenceIds = complete
			.filter((capture) => capture.brandMatches.some((match) => match.brandId === projectId))
			.map((capture) => capture.captureId);
		findings.push({
			category: "可见度优势",
			title: "品牌已建立可验证的 AI 可见度",
			detail: `在有效消费端回答中，品牌提及率为 ${percentage(metrics.overall.brandMentionRate)}，首位推荐率为 ${percentage(metrics.overall.firstRecommendationRate)}。这是本批次的真实基线，不代表长期固定排名。`,
			confidence: 1,
			evidenceIds,
			targetPromptIds: [...new Set(complete.map((capture) => capture.promptId))],
			recommendation: "保留当前被反复提及的品牌名称、产品定位和事实表述，并在复测中持续观察。",
		});
	}
	const weakCaptures = complete.filter((capture) => {
		const position = bestPosition([capture], projectId);
		return position === null || position > 1;
	});
	if (weakCaptures.length) {
		const questions = [...new Set(weakCaptures.map((capture) => capture.prompt))];
		findings.push({
			category: "问题机会",
			title: "重点购买问题仍存在推荐位置差距",
			detail: `${weakCaptures.length} 个有效回答中品牌未居首或未出现，涉及：${questions.slice(0, 5).join("；")}。该结论只描述观测差距，不推断平台黑盒因果。`,
			confidence: 1,
			evidenceIds: weakCaptures.map((capture) => capture.captureId),
			targetPromptIds: [...new Set(weakCaptures.map((capture) => capture.promptId))],
			recommendation: "为这些问题分别建设可公开验证的选购页，补充适用人群、选择条件、比较维度、事实来源和常见问题。",
		});
	}
	const owned = normalizeDomain(config.project.domain);
	const withOwnedCitation = complete.filter((capture) =>
		capture.sources.some((source) => normalizeDomain(source.domain) === owned && source.isCitation),
	);
	if (complete.length && withOwnedCitation.length === 0) {
		const withSources = complete.filter((capture) => capture.sources.length > 0);
		findings.push({
			category: "信源差距",
			title: "官网尚未进入本批次引用链",
			detail: `${complete.length} 个有效回答中官网引用率为 0%。${withSources.length ? `其中 ${withSources.length} 个回答引用了第三方页面。` : "本批次回答未展示可提取来源。"}`,
			confidence: 1,
			evidenceIds: (withSources.length ? withSources : complete).map((capture) => capture.captureId),
			targetPromptIds: [...new Set(complete.map((capture) => capture.promptId))],
			recommendation:
				"修复官网可访问性与结构化信息，为核心购买问题建立独立可索引页面，并争取可信第三方页面引用同一组可核验事实。",
		});
	}
	const outranked = complete.filter((capture) => {
		const target = bestPosition([capture], projectId);
		return config.competitors.some((competitor) => {
			const position = bestPosition([capture], competitor.id);
			return position !== null && (target === null || position < target);
		});
	});
	if (outranked.length) {
		findings.push({
			category: "竞品压力",
			title: "竞品在部分问题中排在客户品牌之前",
			detail: `${outranked.length} 个有效回答出现至少一个已确认竞品位置领先。需要逐问题比较回答用到的描述与引用来源，而不是做全站泛化改写。`,
			confidence: 1,
			evidenceIds: outranked.map((capture) => capture.captureId),
			targetPromptIds: [...new Set(outranked.map((capture) => capture.promptId))],
			recommendation: "打开对应证据，整理竞品被推荐时出现的可验证维度，再将客户真实具备的差异化事实补到相关页面。",
		});
	}
	if (websiteAudit) {
		const material = websiteAudit.result.checks.filter(
			(check) => check.status === "fail" || (check.status === "warning" && check.weight >= 6),
		);
		if (material.length) {
			findings.push({
				category: "官网技术基础",
				title: "官网存在影响读取与引用的技术缺口",
				detail: `官网审计 ${websiteAudit.result.score}/100，需处理：${material.map((check) => `${check.label}（${check.detail}）`).join("；")}。`,
				confidence: 1,
				evidenceIds: [websiteAudit.id],
				targetPromptIds: [],
				recommendation:
					"按审计项从 HTTPS 与可访问性开始整改，再处理页面标题、Sitemap、Canonical 和结构化数据；完成后重新运行官网审计。",
			});
		}
	}
	const coverage = buildTopicCoverage(config, webEvidence);
	const hasCustomerEvidence = webEvidence.some((item) => item.role === "customer");
	const topicGaps = coverage.flatMap((row) =>
		row.terms
			.filter(
				(term) => hasCustomerEvidence && term.customerEvidenceIds.length === 0 && term.externalEvidenceIds.length > 0,
			)
			.map((term) => ({ question: row.question, ...term })),
	);
	if (topicGaps.length) {
		findings.push({
			category: "内容覆盖差距",
			title: "外部证据覆盖了客户已确认但官网缺失的主题",
			detail: `按客户确认标签做精确文本比对，发现：${topicGaps
				.slice(0, 8)
				.map((gap) => `${gap.term}（${gap.question}）`)
				.join("；")}。这表示当前保存的客户页面未出现相同主题，而竞品或引用页出现；不代表它就是排名因果。`,
			confidence: 1,
			evidenceIds: [...new Set(topicGaps.flatMap((gap) => gap.externalEvidenceIds))],
			targetPromptIds: [
				...new Set(
					coverage
						.filter((row) =>
							row.terms.some(
								(term) =>
									hasCustomerEvidence && term.customerEvidenceIds.length === 0 && term.externalEvidenceIds.length > 0,
							),
						)
						.map((row) => row.promptId),
				),
			],
			recommendation:
				"先核验客户是否真实具备这些主题对应的产品、服务或事实；具备时建设独立页面并附来源，不具备时不要为了排名硬写。",
		});
	}
	return findings.filter((finding) => finding.evidenceIds.length > 0);
}

export function buildReportAnalysis(input: {
	projectId: string;
	config: FrozenBatchConfig;
	captures: QueryCapture[];
	metrics: BatchMetrics;
	websiteAudit: { id: string; result: WebsiteAuditResult } | null;
	webEvidence?: DiagnosisWebEvidence[];
}): ReportAnalysis {
	const complete = input.captures.filter((capture) => capture.status === "complete");
	const findings = buildDeterministicFindings(input);
	const strengths = findings.filter((finding) => finding.category.includes("优势"));
	const gaps = findings.filter((finding) => !finding.category.includes("优势"));
	const promptRows = input.config.prompts.map((prompt) => {
		const captures = input.captures.filter((capture) => capture.promptId === prompt.id);
		const valid = captures.filter((capture) => capture.status === "complete");
		const targetMentioned = valid.filter((capture) => bestPosition([capture], input.projectId) !== null);
		const targetFirst = valid.filter((capture) => bestPosition([capture], input.projectId) === 1);
		return {
			promptId: prompt.id,
			question: prompt.question,
			intent: prompt.intent,
			tags: prompt.tags,
			completeSamples: valid.length,
			plannedSamples: input.config.platforms.length * input.config.repeats,
			targetMentionRate: valid.length ? targetMentioned.length / valid.length : 0,
			firstRecommendationRate: valid.length ? targetFirst.length / valid.length : 0,
			bestTargetPosition: bestPosition(valid, input.projectId),
			sourceCount: valid.reduce((sum, capture) => sum + capture.sources.length, 0),
			competitors: input.config.competitors.map((competitor) => {
				const mentioned = valid.filter((capture) => bestPosition([capture], competitor.id) !== null);
				return {
					id: competitor.id,
					name: competitor.name,
					mentionRate: valid.length ? mentioned.length / valid.length : 0,
					bestPosition: bestPosition(valid, competitor.id),
				};
			}),
			captures: captures.map((capture) => ({
				captureId: capture.captureId,
				platform: capture.engine,
				attempt: capture.attempt,
				status: capture.status,
				targetPosition: bestPosition([capture], input.projectId),
				sourceCount: capture.sources.length,
				screenshotKey: capture.evidence.screenshotObjectKey,
			})),
		};
	});
	const validRatio = input.metrics.expectedSamples ? input.metrics.validSamples / input.metrics.expectedSamples : 0;
	const evidenceLevel = validRatio >= 0.8 && input.metrics.validSamples >= 5 ? "高" : validRatio >= 0.5 ? "中" : "低";
	const averagePosition = input.metrics.overall.averageMentionPosition;
	const webEvidence = input.webEvidence ?? [];
	return {
		generatedAt: new Date().toISOString(),
		executive: {
			headline: `${input.config.project.name} AI 可见度基线：提及率 ${percentage(input.metrics.overall.brandMentionRate)}，官网引用率 ${percentage(input.metrics.overall.citationRate)}`,
			summary: `本批次获得 ${input.metrics.validSamples}/${input.metrics.expectedSamples} 个有效消费端回答。品牌首位推荐率 ${percentage(input.metrics.overall.firstRecommendationRate)}${averagePosition === null ? "，暂无可计算位置" : `，出现时平均位置 ${averagePosition.toFixed(1)}`}。报告同时保留平台差异、竞品位置、引用来源和失败样本。`,
			evidenceLevel,
			validityNote: `证据等级${evidenceLevel}：有效率 ${percentage(validRatio)}；结果是指定时间、账号、地区和问题集下的真实采样，不等于平台长期固定排名。`,
		},
		promptRows,
		sourceDomains: buildSourceDomains(complete, input.config.project.domain),
		perceptionExcerpts: perceptionExcerpts(complete, input.config.project.aliases),
		topicCoverage: buildTopicCoverage(input.config, webEvidence),
		webEvidenceSummary: {
			customerPages: webEvidence.filter((item) => item.role === "customer").length,
			competitorPages: webEvidence.filter((item) => item.role === "competitor").length,
			citationPages: webEvidence.filter((item) => item.role === "citation").length,
		},
		strengths,
		gaps,
		websiteAudit: input.websiteAudit,
	};
}
