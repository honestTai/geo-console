import { z } from "zod";
import type { SemanticBrand } from "./semantic";

export const ANSWER_ANALYSIS_VERSION = "geo.answer-analysis.v1";
export const ANSWER_ANALYSIS_MAX_LENGTH = 60_000;
export const answerAnalysisContractSchema = z.strictObject({
	version: z.literal(ANSWER_ANALYSIS_VERSION),
	promptVersion: z.literal("answer-analysis.grounded.v1"),
	segmenterVersion: z.literal("answer-segments.utf16.v1"),
	validatorVersion: z.literal("answer-analysis.evidence.v1"),
	modelId: z.string().min(1),
	modelRevision: z.string().nullable(),
	endpoint: z.url(),
});
export type AnswerAnalysisContract = z.infer<typeof answerAnalysisContractSchema>;

const text = z.string().trim().min(1).max(1500);
const reference = z.strictObject({ segmentId: z.string().min(1), quote: z.string().min(1).max(2400) });
const evidence = z.array(reference).min(1).max(8);
const claim = z.strictObject({ text, evidence });
export const analysisSentimentSchema = z.enum(["positive", "neutral", "negative", "mixed", "unclear"]);
export const analysisStanceSchema = z.enum([
	"explicit",
	"implicit",
	"conditional",
	"none",
	"against",
	"mixed",
	"unclear",
]);
export const answerAnalysisSchema = z.strictObject({
	schemaVersion: z.literal(ANSWER_ANALYSIS_VERSION),
	status: z.enum(["complete", "needs_review"]),
	answerType: z.enum(["recommendation", "comparison", "informational", "mixed", "other"]),
	summary: claim,
	keyPoints: z.array(claim).min(1).max(24),
	sections: z
		.array(
			z.strictObject({
				segmentIds: z.array(z.string().min(1)).min(1).max(120),
				title: text,
				kind: z.enum(["background", "recommendation", "comparison", "explanation", "limitation", "other"]),
				summary: text,
				evidence,
			}),
		)
		.min(1)
		.max(120),
	brands: z
		.array(
			z.strictObject({
				brandId: z.string().min(1),
				sentiment: analysisSentimentSchema,
				stance: analysisStanceSchema,
				summary: claim,
				aspects: z
					.array(z.strictObject({ aspect: text, sentiment: analysisSentimentSchema, assessment: text, evidence }))
					.max(24),
				recommendations: z
					.array(
						z.strictObject({
							stance: analysisStanceSchema,
							reason: text.nullable(),
							conditions: z.array(text).max(12),
							evidence,
						}),
					)
					.max(24),
			}),
		)
		.max(100),
	comparisons: z
		.array(
			z.strictObject({
				brandIds: z.array(z.string().min(1)).min(2).max(10),
				aspect: text,
				conclusion: text,
				favoredBrandId: z.string().min(1).nullable(),
				evidence,
			}),
		)
		.max(30),
	limitations: z.array(claim).max(24),
	ambiguities: z.array(text).max(24),
});
export type AnswerAnalysis = z.infer<typeof answerAnalysisSchema>;
export type AnalysisReference = z.infer<typeof reference>;
export type AnalysisEvidenceSpan = AnalysisReference & { start: number; end: number };
export type AnswerSegment = { id: string; start: number; end: number; text: string };
export type AnswerAnalysisResult = {
	analysis: AnswerAnalysis;
	evidenceSpans: AnalysisEvidenceSpan[];
	coverage: { totalSegments: number; analyzedSegments: number };
};
export type AnswerAnalysisView = {
	id: string | null;
	question: string;
	status: "not_generated" | "queued" | "running" | "ready" | "needs_review" | "failed";
	createdAt: string | null;
	contract: Omit<AnswerAnalysisContract, "endpoint"> | null;
	inputHash: string | null;
	answerHash: string;
	brands: Array<{ id: string; name: string }>;
	result: AnswerAnalysisResult | null;
	issues: string[];
	error: string | null;
	usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null;
	costMicros: number | null;
	previousRunId: string | null;
	latestRunId: string | null;
};

/** Stable source offsets belong to the application, never to the model. No normalization or truncation. */
export function segmentAnswer(answer: string): AnswerSegment[] {
	if (!answer.trim() || answer.length > ANSWER_ANALYSIS_MAX_LENGTH)
		throw new Error(`完整分析需要非空原文，且不能超过 ${ANSWER_ANALYSIS_MAX_LENGTH} 个 UTF-16 单元；不会截断回答`);
	const segments: AnswerSegment[] = [];
	const paragraphs = [...answer.matchAll(/\r?\n[ \t]*\r?\n/g)].map((match) => match.index + match[0].length);
	const minimumChunk = paragraphs.length > 60 ? Math.ceil(answer.length / 60) : 0;
	let start = 0;
	while (start < answer.length) {
		let end = Math.min(start + 1800, answer.length);
		const paragraph = paragraphs.find((offset) => offset > start && offset >= start + minimumChunk && offset <= end);
		if (paragraph !== undefined) end = paragraph;
		if (end < answer.length) {
			const newline = answer.lastIndexOf("\n", end - 1);
			if (newline > start + 450) end = newline + 1;
			if (/[\uD800-\uDBFF]/.test(answer[end - 1])) end -= 1;
		}
		const part = answer.slice(start, end);
		if (part.trim()) segments.push({ id: `s${segments.length + 1}`, start, end, text: part });
		start = end;
	}
	return segments;
}

function mentions(value: string, brand: SemanticBrand): boolean {
	return [brand.name, ...brand.aliases]
		.filter((alias) => alias.trim())
		.some((alias) => {
			const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(
				`${/^[a-z0-9]/i.test(alias) ? "(?<![a-z0-9_])" : ""}${escaped}${/[a-z0-9]$/i.test(alias) ? "(?![a-z0-9_])" : ""}`,
				"iu",
			).test(value);
		});
}

export function analysisReferences(analysis: AnswerAnalysis): AnalysisReference[] {
	return [
		...analysis.summary.evidence,
		...analysis.keyPoints.flatMap((item) => item.evidence),
		...analysis.sections.flatMap((item) => item.evidence),
		...analysis.brands.flatMap((brand) => [
			...brand.summary.evidence,
			...brand.aspects.flatMap((item) => item.evidence),
			...brand.recommendations.flatMap((item) => item.evidence),
		]),
		...analysis.comparisons.flatMap((item) => item.evidence),
		...analysis.limitations.flatMap((item) => item.evidence),
	];
}

function resolveAnalysisSpans(analysis: AnswerAnalysis, byId: Map<string, AnswerSegment>) {
	const invalid: string[] = [];
	const spans = new Map<string, AnalysisEvidenceSpan>();
	for (const ref of analysisReferences(analysis)) {
		const segment = byId.get(ref.segmentId);
		const offset = segment?.text.indexOf(ref.quote) ?? -1;
		if (!segment || offset < 0 || segment.text.indexOf(ref.quote, offset + 1) !== -1) {
			invalid.push(`证据 ${ref.segmentId} 的引文不在原文中或不能唯一定位`);
			continue;
		}
		spans.set(JSON.stringify([ref.segmentId, ref.quote]), {
			...ref,
			start: segment.start + offset,
			end: segment.start + offset + ref.quote.length,
		});
	}
	for (const section of analysis.sections) {
		if (
			section.segmentIds.some((id) => !byId.has(id)) ||
			section.evidence.some((ref) => !section.segmentIds.includes(ref.segmentId))
		)
			invalid.push("分段解读引用了其他段落或不存在的原文片段");
	}
	return { invalid, spans };
}

function validateBrandAttribution(
	analysis: AnswerAnalysis,
	answer: string,
	brands: SemanticBrand[],
	byId: Map<string, AnswerSegment>,
) {
	const invalid: string[] = [];
	const issues: string[] = [];
	const brandMap = new Map(brands.map((brand) => [brand.id, brand]));
	const observed = new Set<string>();
	const supportsBrand = (refs: AnalysisReference[], brand: SemanticBrand) =>
		refs.some((ref) => {
			if (mentions(ref.quote, brand)) return true;
			const context = byId.get(ref.segmentId)?.text ?? "";
			return mentions(context, brand) && brands.filter((item) => mentions(context, item)).length === 1;
		});
	for (const item of analysis.brands) {
		const brand = brandMap.get(item.brandId);
		if (!brand || observed.has(item.brandId) || !supportsBrand(item.summary.evidence, brand)) {
			invalid.push("品牌不在冻结白名单、重复出现或缺少原文归属依据");
			continue;
		}
		observed.add(item.brandId);
		for (const detail of [...item.aspects, ...item.recommendations])
			if (!supportsBrand(detail.evidence, brand)) invalid.push("品牌评价或推荐理由缺少可定位的品牌归属依据");
		if (item.recommendations.some((detail) => detail.stance === "conditional" && !detail.conditions.length))
			issues.push("条件推荐缺少原文中的适用条件");
	}
	for (const brand of brands)
		if (mentions(answer, brand) && !observed.has(brand.id))
			issues.push(`原文提及的监测品牌 ${brand.name} 尚未完成解读`);
	for (const comparison of analysis.comparisons) {
		if (
			new Set(comparison.brandIds).size !== comparison.brandIds.length ||
			comparison.brandIds.some((id) => {
				const brand = brandMap.get(id);
				return !brand || !supportsBrand(comparison.evidence, brand);
			}) ||
			(comparison.favoredBrandId !== null && !comparison.brandIds.includes(comparison.favoredBrandId))
		)
			invalid.push("竞品比较的品牌或偏好结论缺少原文归属依据");
	}
	return { invalid, issues };
}

export function validateAnswerAnalysis(
	input: unknown,
	answer: string,
	brands: SemanticBrand[],
): {
	status: "valid" | "needs_review" | "failed";
	issues: string[];
	result: AnswerAnalysisResult | null;
} {
	const parsed = answerAnalysisSchema.safeParse(input);
	if (!parsed.success) return { status: "failed", issues: ["模型输出不符合完整语义结构"], result: null };
	const analysis = parsed.data;
	const segments = segmentAnswer(answer);
	const byId = new Map(segments.map((segment) => [segment.id, segment]));
	const resolved = resolveAnalysisSpans(analysis, byId);
	const attribution = validateBrandAttribution(analysis, answer, brands, byId);
	const invalid = [...resolved.invalid, ...attribution.invalid];
	const issues = [...attribution.issues];
	const covered = analysis.sections.flatMap((section) => section.segmentIds);
	if (JSON.stringify(covered) !== JSON.stringify(segments.map((segment) => segment.id)))
		issues.push("全文分段必须按原文顺序覆盖每个片段一次，当前存在遗漏、重复或乱序");
	if (invalid.length) return { status: "needs_review", issues: [...new Set([...invalid, ...issues])], result: null };
	if (analysis.status === "needs_review" || analysis.ambiguities.length)
		issues.push("模型标记了语义歧义，需要人工核对原文");
	return {
		status: issues.length ? "needs_review" : "valid",
		issues: [...new Set(issues)],
		result: {
			analysis,
			evidenceSpans: [...resolved.spans.values()],
			coverage: {
				totalSegments: segments.length,
				analyzedSegments: new Set(covered.filter((id) => byId.has(id))).size,
			},
		},
	};
}
