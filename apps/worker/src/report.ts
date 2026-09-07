import type { FrozenBatchConfig, WebsiteAuditResult } from "@geo/core";
import type { QueryCapture } from "@geo/evidence";
import {
	explainMeasurement,
	failureExplanation,
	type MeasurementExplanation,
	mean,
	type OverallVisibilityMetrics,
	recommendationRankMedian,
	type VisibilityMetrics,
} from "@geo/metrics";
import { websiteGuidance } from "./website-guidance";

type BatchMetrics = {
	perPlatform: Record<string, VisibilityMetrics>;
	overall: OverallVisibilityMetrics;
	validSamples: number;
	failedSamples: number;
	expectedSamples: number;
	contract?: { sampling: { mode: string } };
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
	supplementalEvidence?: import("./report-evidence").SupplementalEvidence[];
	readerGuide: MeasurementExplanation;
	webPages: DiagnosisWebEvidence[];
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
		targetMentionRate: number | null;
		firstRecommendationRate: number | null;
		bestTargetPosition: number | null;
		sourceCount: number;
		competitors: Array<{ id: string; name: string; mentionRate: number | null; bestPosition: number | null }>;
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
		category: "owned" | "competitor" | "government" | "social" | "review" | "encyclopedia" | "other";
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
	/** 证据编号索引：把 UUID 映射为普通读者可理解的 [n] 平台·问题·采样·时间。 */
	evidenceIndex: EvidenceIndexEntry[];
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

export type EvidenceIndexEntry = {
	/** 报告内编号；联网搜索等不进入冻结报告的证据为 0，前端按 kind 显示标签。 */
	n: number;
	id: string;
	kind: "capture" | "snapshot" | "audit" | "web_search";
	platform: string | null;
	platformLabel: string | null;
	question: string | null;
	attempt: number | null;
	status: string | null;
	capturedAt: string | null;
	sourceUrls: string[];
	url: string | null;
	title: string | null;
};

const platformLabels: Record<string, string> = {
	deepseek_api: "DeepSeek 联网 API",
	kimi_api: "Kimi 联网 API",
	doubao_api: "豆包联网 API",
	qwen_api: "通义千问联网 API",
	yuanbao_api: "元宝+混元",
	deepseek: "DeepSeek",
	kimi: "Kimi",
};

export const evidencePlatformLabel = (platform: string | null | undefined): string | null =>
	platform ? (platformLabels[platform] ?? platform) : null;

/** 去掉来源 URL 上供应商附带的追踪片段（如 #ws_call_id=...），只保留可访问地址。 */
export function stripTrackingFragment(url: string): string {
	return url.replace(/#(?:ws_call_id|call_id|ref|utm_[a-z]+)=[^#]*$/i, "").replace(/#$/, "");
}

export function buildEvidenceIndex(
	captures: QueryCapture[],
	webEvidence: DiagnosisWebEvidence[] = [],
	websiteAudit: { id: string; result: WebsiteAuditResult } | null = null,
): EvidenceIndexEntry[] {
	const entries: EvidenceIndexEntry[] = [];
	const sorted = [...captures].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
	for (const capture of sorted)
		entries.push({
			n: entries.length + 1,
			id: capture.captureId,
			kind: "capture",
			platform: capture.engine,
			platformLabel: evidencePlatformLabel(capture.engine),
			question: capture.prompt,
			attempt: capture.attempt,
			status: capture.status,
			capturedAt: capture.capturedAt,
			sourceUrls: [
				...new Set(
					capture.sources.filter((source) => source.isCitation).map((source) => stripTrackingFragment(source.url)),
				),
			].slice(0, 12),
			url: null,
			title: null,
		});
	for (const page of webEvidence)
		entries.push({
			n: entries.length + 1,
			id: page.id,
			kind: "snapshot",
			platform: null,
			platformLabel:
				page.role === "customer" ? "客户官网快照" : page.role === "competitor" ? "竞品页面快照" : "引用页面快照",
			question: null,
			attempt: null,
			status: null,
			capturedAt: null,
			sourceUrls: [],
			url: page.url,
			title: page.title,
		});
	if (websiteAudit)
		entries.push({
			n: entries.length + 1,
			id: websiteAudit.id,
			kind: "audit",
			platform: null,
			platformLabel: "官网 AI 可读性审计",
			question: null,
			attempt: null,
			status: null,
			capturedAt: (websiteAudit.result as { checkedAt?: string }).checkedAt ?? null,
			sourceUrls: [],
			url: null,
			title: null,
		});
	return entries;
}

/** 模型在联网回答里夹带的英文推理草稿（"Let me search more"）不是面向用户的表述，不能当作品牌描述引用。 */
export function isReasoningScratch(sentence: string): boolean {
	const trimmed = sentence.trim();
	if (!trimmed) return true;
	const hasCjk = /[\u3400-\u9fff]/.test(trimmed);
	const scratchPattern =
		/^(?:i |i'|let me|let's|i'll|i will|i need|i found|i should|now i|okay|ok,|searching|search for|looking up|the user|based on my search)/i;
	const scratchKeywords =
		/(search more|verify the details|let me (?:also )?(?:check|search|do|verify)|do more searches|i found good info)/i;
	if (scratchPattern.test(trimmed)) return true;
	if (scratchKeywords.test(trimmed)) return true;
	if (!hasCjk && /\b(let me|i'll|search)\b/i.test(trimmed)) return true;
	return false;
}

const normalizeDomain = (value: string): string =>
	value
		.trim()
		.toLowerCase()
		.replace(/^www\./, "");
const percentage = (value: number | null): string => (value === null ? "不可用" : `${Math.round(value * 100)}%`);

/** 回答里的 Markdown 标记（加粗、链接、表格竖线）不是品牌描述的一部分，摘录时去掉。 */
export function stripInlineMarkdown(value: string): string {
	return value
		.replace(/!\[[^\]]*]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__)(.*?)\1/g, "$2")
		.replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*|__|~~/g, "")
		.replace(/^\s*\|?\s*/, "")
		.replace(/\s*\|\s*$/, "")
		.replace(/\s*\|\s*/g, "，")
		.replace(/\s+/g, " ")
		.trim();
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Sentence filtering applies alias, scratch and length rules in one pass.
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
			if (isReasoningScratch(sentence)) continue;
			if (/^\|?\s*:?-{3,}/.test(sentence)) continue;
			const text = stripInlineMarkdown(sentence)
				.replace(/^[#>*\-\d.\s]+/, "")
				.slice(0, 260);
			if (text.length < 8) continue;
			if (seen.has(text)) continue;
			seen.add(text);
			values.push({ text, captureId: capture.captureId, question: capture.prompt, platform: capture.engine });
			if (values.length >= 8) return values;
		}
	}
	return values;
}

function sourceCategory(
	domain: string,
	config: FrozenBatchConfig,
): ReportAnalysis["sourceDomains"][number]["category"] {
	if (domain === normalizeDomain(config.project.domain)) return "owned";
	if (config.competitors.some((competitor) => domain === normalizeDomain(competitor.domain))) return "competitor";
	if (domain.endsWith(".gov.cn") || domain === "gov.cn") return "government";
	if (
		["zhihu.com", "xiaohongshu.com", "weibo.com", "weixin.qq.com", "mp.weixin.qq.com"].some(
			(value) => domain === value || domain.endsWith(`.${value}`),
		)
	)
		return "social";
	if (["dianping.com", "meituan.com"].some((value) => domain === value || domain.endsWith(`.${value}`)))
		return "review";
	if (domain.includes("baike") || domain === "wikipedia.org" || domain.endsWith(".wikipedia.org"))
		return "encyclopedia";
	return "other";
}

function buildSourceDomains(captures: QueryCapture[], config: FrozenBatchConfig): ReportAnalysis["sourceDomains"] {
	const domains = new Map<
		string,
		{ citationCount: number; prompts: Set<string>; urls: Map<string, { title: string | null; count: number }> }
	>();
	for (const capture of captures) {
		if (capture.status !== "complete") continue;
		for (const source of capture.sources) {
			if (!source.isCitation) continue;
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
			category: sourceCategory(domain, config),
			citationCount: value.citationCount,
			promptCount: value.prompts.size,
			isOwned: domain === normalizeDomain(config.project.domain),
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
	const { config, captures, metrics, websiteAudit, webEvidence = [] } = input;
	const promptMetrics = Object.values(metrics.perPlatform)
		.flatMap((p) => p.prompts ?? [])
		.filter((p) => p.eligible);
	const complete = captures.filter((capture) => capture.status === "complete");
	const findings: ReportFinding[] = [];
	if (metrics.failedSamples > 0) {
		const failed = captures.filter((capture) => capture.status !== "complete");
		findings.push({
			category: "样本质量",
			title: "部分真实采样未完成",
			detail: `${metrics.expectedSamples} 次计划测试中 ${metrics.validSamples} 次取得符合要求的回答，${metrics.failedSamples} 次未通过采集检查。具体原因：${[...new Set(failed.map((c) => failureExplanation(c.failureCode ?? c.status).reason))].join("；")}。缺失不是企业的负面表现。`,
			confidence: 1,
			evidenceIds: failed.map((capture) => capture.captureId),
			targetPromptIds: [...new Set(failed.map((capture) => capture.promptId))],
			recommendation: [...new Set(failed.map((c) => failureExplanation(c.failureCode ?? c.status).action))].join(" "),
		});
	}
	if (
		metrics.overall.status === "ready" &&
		metrics.overall.brandMentionRate !== null &&
		metrics.overall.brandMentionRate >= 0.6
	) {
		const evidenceIds = [
			...new Set(promptMetrics.filter((p) => (p.brandMentionRate ?? 0) > 0).flatMap((p) => p.evidenceIds)),
		];
		findings.push({
			category: "可见度优势",
			title: "品牌已建立可验证的 AI 可见度",
			detail: `在有效联网回答中，品牌提及率为 ${percentage(metrics.overall.brandMentionRate)}，首位推荐率为 ${percentage(metrics.overall.firstRecommendationRate)}。这是本批次冻结条件下的真实结果，不代表长期固定排名。`,
			confidence: 1,
			evidenceIds,
			targetPromptIds: [...new Set(complete.map((capture) => capture.promptId))],
			recommendation: "保留当前被反复提及的品牌名称、产品定位和事实表述，并在复测中持续观察。",
		});
	}
	const weakPrompts = promptMetrics.filter((p) => p.recommendationRate !== null && p.recommendationRate < 1);
	if (weakPrompts.length)
		findings.push({
			category: "问题机会",
			title: "正向推荐覆盖需结合问题用途解读",
			detail: `${weakPrompts.length} 个平台与问题组合中，没有每次都观察到正向推荐。知识解释类问题本来就未必需要推荐公司，请优先核对真正寻找供应商的问题；不是所有未推荐都需要写文章。`,
			confidence: 1,
			evidenceIds: [...new Set(weakPrompts.flatMap((p) => p.evidenceIds))],
			targetPromptIds: [...new Set(weakPrompts.map((p) => p.promptId))],
			recommendation:
				"先核对哪些问题真的在寻找供应商；客户确实具备对应能力时，补充适用条件、案例和可核验出处，再同条件复测。不为纯知识问题硬塞公司名称。",
		});

	const owned = normalizeDomain(config.project.domain);
	const withOwnedCitation = complete.filter((capture) =>
		capture.sources.some((source) => normalizeDomain(source.domain) === owned && source.isCitation),
	);
	if (
		owned &&
		complete.some((c) => c.captureMode === "llm_search_api" && c.sourceVisibility !== "unavailable") &&
		withOwnedCitation.length === 0
	) {
		const withSources = complete.filter((capture) => capture.sources.length > 0);
		const cited = complete.filter((capture) => capture.sources.some((s) => s.isCitation));
		findings.push({
			category: "信源差距",
			title: "官网尚未进入本批次引用链",
			detail: `${complete.length} 个已取得回答中，${withSources.length} 个有搜索来源记录，${cited.length} 个有明确的最终引用；没有观察到官网被明确引用。来源不可观察的回答不算作零引用，搜索过页面不等于引用过页面。`,
			confidence: 1,
			evidenceIds: (withSources.length ? withSources : complete).map((capture) => capture.captureId),
			targetPromptIds: [...new Set(complete.map((capture) => capture.promptId))],
			recommendation:
				"逐条打开回答，比较真正引用的页面与官网能提供的事实。先确认内容缺口，再补充对应业务页和可核验案例；只有官网审计确认存在技术缺口时才安排技术整改。",
		});
	}
	const competitorAhead = promptMetrics.filter(
		(p) =>
			p.brandMentionRate !== null &&
			Object.values(p.competitorMentionRates).some((rate) => rate !== null && rate > p.brandMentionRate!),
	);
	if (competitorAhead.length)
		findings.push({
			category: "竞品压力",
			title: "竞品在部分问题中的提及概率更高",
			detail: `${competitorAhead.length} 个平台/问题中竞品提及率高于客户；提及不是推荐名次，不推断因果。`,
			confidence: 1,
			evidenceIds: [...new Set(competitorAhead.flatMap((p) => p.evidenceIds))],
			targetPromptIds: [...new Set(competitorAhead.map((p) => p.promptId))],
			recommendation: "阅读对应原文和引用来源，比较可核验事实，并用同一测量契约复测。",
		});

	if (websiteAudit) {
		const material = websiteAudit.result.checks.filter(
			(check) => check.status === "fail" || check.status === "warning",
		);
		if (material.length) {
			findings.push({
				category: "官网技术基础",
				title: "官网检查发现需要复核和处理的项目",
				detail: `官网审计 ${websiteAudit.result.score === null ? "未形成可评分证据" : `${websiteAudit.result.score}/100`}，需处理：${material.map((check) => `${check.label}（${check.detail}）`).join("；")}。`,
				confidence: 1,
				evidenceIds: [websiteAudit.id],
				targetPromptIds: [],
				recommendation: material
					.map(
						(check) =>
							`${check.label}：${check.recommendation ?? websiteGuidance[check.id]?.recommendation ?? "先打开源证据复核"} 验收：${check.verification ?? websiteGuidance[check.id]?.verification ?? "修改上线后重新检查相同页面"}`,
					)
					.join("\n"),
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
	const includedPlatforms = Object.values(input.metrics.perPlatform).filter((p) =>
		input.metrics.contract?.sampling.mode === "quick" ? p.status !== "unavailable" : p.status === "ready",
	);
	const promptRows = input.config.prompts.map((prompt) => {
		const captures = input.captures.filter((capture) => capture.promptId === prompt.id);
		const valid = captures.filter((capture) => capture.status === "complete");
		const measured = includedPlatforms
			.flatMap((p) => p.prompts ?? [])
			.filter((p) => p.promptId === prompt.id && p.eligible);

		return {
			promptId: prompt.id,
			question: prompt.question,
			intent: prompt.intent,
			tags: prompt.tags,
			completeSamples: valid.length,
			plannedSamples: input.config.platforms.length * input.config.repeats,
			targetMentionRate: mean(measured.map((p) => p.brandMentionRate)),
			firstRecommendationRate: mean(measured.map((p) => p.firstRecommendationRate)),
			bestTargetPosition: recommendationRankMedian(measured),
			sourceCount: valid.reduce((sum, capture) => sum + capture.sources.length, 0),
			competitors: input.config.competitors.map((competitor) => {
				return {
					id: competitor.id,
					name: competitor.name,
					mentionRate: mean(measured.map((p) => p.competitorMentionRates[competitor.id] ?? null)),
					bestPosition: null,
				};
			}),
			captures: captures.map((capture) => ({
				captureId: capture.captureId,
				platform: capture.engine,
				attempt: capture.attempt,
				status: capture.status,
				targetPosition: null,
				sourceCount: capture.sources.length,
				screenshotKey:
					capture.captureMode === "consumer_surface"
						? capture.evidence.screenshotObjectKey
						: capture.evidence.rawResponseObjectKey,
			})),
		};
	});
	const validRatio = input.metrics.expectedSamples ? input.metrics.validSamples / input.metrics.expectedSamples : 0;
	const evidenceLevel =
		input.metrics.overall.status === "ready" ? "高" : input.metrics.overall.status === "limited" ? "中" : "低";
	const averagePosition = input.metrics.overall.medianRecommendationRank;
	const webEvidence = input.webEvidence ?? [];
	const readerGuide = explainMeasurement(input.metrics, input.config, input.captures);
	return {
		readerGuide,
		webPages: webEvidence,
		generatedAt: new Date().toISOString(),
		executive: {
			headline: `${input.config.project.name} AI 可见度基线：提及率 ${percentage(input.metrics.overall.brandMentionRate)}，官网引用率 ${input.metrics.overall.citationRate === null ? "不可用" : percentage(input.metrics.overall.citationRate)}`,
			summary: `${readerGuide.scope} ${readerGuide.counts.planned} 次计划测试 → ${readerGuide.counts.answered} 次取得回答 → ${readerGuide.counts.parsed} 次可以用于品牌判断。首位推荐率 ${percentage(input.metrics.overall.firstRecommendationRate)}${averagePosition === null ? "；没有可计算的明确推荐名次，不等于排名最后" : `；明确推荐名次中位数 ${averagePosition.toFixed(1)}`}。`,
			evidenceLevel,
			validityNote: `${readerGuide.status}。${readerGuide.limitation} 采集完成度 ${percentage(validRatio)}、回答可判断比例 ${percentage(input.metrics.overall.parseCoverage)}、有效问题覆盖 ${percentage(input.metrics.overall.promptCoverage)}。这些完成度不是企业得分。`,
		},
		promptRows,
		sourceDomains: buildSourceDomains(complete, input.config),
		perceptionExcerpts: perceptionExcerpts(complete, input.config.project.aliases),
		evidenceIndex: buildEvidenceIndex(input.captures, webEvidence, input.websiteAudit),
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
