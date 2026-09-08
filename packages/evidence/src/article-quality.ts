import { z } from "zod";

export const ARTICLE_QUALITY_POLICY_VERSION = "article-quality.grounded.v1";

export const articleQualityIssueSchema = z.strictObject({
	severity: z.enum(["blocking", "warning", "info"]),
	category: z.enum(["factual", "evidence", "completeness", "readability", "publication"]),
	message: z.string().trim().min(1).max(1600),
	field: z.enum(["title", "summary", "contentMarkdown", "publicationPlan"]),
	quote: z.string().max(1600).nullable(),
	evidenceIds: z.array(z.string().min(1)).max(40),
	suggestion: z.string().trim().min(1).max(2000),
});

export const articleQualityResultSchema = z.strictObject({
	verdict: z.enum(["pass", "needs_review", "blocked"]),
	summary: z.string().trim().min(1).max(2000),
	issues: z.array(articleQualityIssueSchema).max(60),
});

export type ArticleQualityResult = z.infer<typeof articleQualityResultSchema>;
export type ArticleQualityStatus = "pending" | "running" | "failed" | "needs_review" | "passed" | "stale";
export type ArticleEditorialStatus = "pending" | "approved" | "rejected" | "stale";
export type ArticleQualitySource = {
	id: string;
	kind: string;
	title: string;
	content: string;
	hash: string;
	assetId?: string;
	revision?: number;
};
export type ArticleVersionSnapshot = {
	articleId: string;
	projectId: string;
	organizationId: string;
	version: number;
	title: string;
	summary: string | null;
	contentMarkdown: string;
	publicationPlan: unknown;
	evidenceIds: string[];
	targetPromptIds: string[];
	factGaps: string[];
	contentHash: string;
};
export type ArticleQualityView = {
	articleId: string;
	version: number;
	qualityStatus: ArticleQualityStatus;
	editorialStatus: ArticleEditorialStatus;
	runs: Array<{
		id: string;
		version: number;
		status: ArticleQualityStatus;
		policyVersion: string;
		model: string;
		createdAt: string;
		completedAt: string | null;
		error: string | null;
		result: ArticleQualityResult | null;
		validation: string[];
		sources: Array<Omit<ArticleQualitySource, "content">>;
		review: { decision: "approve" | "reject"; note: string; createdAt: string } | null;
	}>;
	reviews: Array<{ id: string; version: number; decision: "approve" | "reject"; note: string; createdAt: string }>;
};

/** Validate grounded references independently of the model's requested verdict. */
export function validateArticleQuality(
	value: unknown,
	snapshot: ArticleVersionSnapshot,
	sources: ArticleQualitySource[],
) {
	const parsed = articleQualityResultSchema.safeParse(value);
	if (!parsed.success) return { result: null, validation: ["质检响应不符合结构化契约"], status: "failed" as const };
	const result = parsed.data;
	const validation: string[] = [];
	const allowed = new Set(sources.map((source) => source.id));
	for (const issue of result.issues) {
		const text =
			issue.field === "publicationPlan" ? JSON.stringify(snapshot.publicationPlan) : (snapshot[issue.field] ?? "");
		if (issue.quote && !text.includes(issue.quote)) validation.push("质检问题的引文不在对应文章原文中");
		if (issue.evidenceIds.some((id) => !allowed.has(id))) validation.push("质检问题引用了未提供的证据或知识版本");
	}
	if (validation.length) return { result: null, validation: [...new Set(validation)], status: "failed" as const };
	if (/【待补充[：:]/.test(snapshot.contentMarkdown)) validation.push("文章正文仍有待补充事实");
	if (!snapshot.publicationPlan) validation.push("文章缺少发布计划");
	if (!sources.length) validation.push("没有可供核对的证据或客户知识资料");
	const pass =
		result.verdict === "pass" && !result.issues.some((issue) => issue.severity === "blocking") && !validation.length;
	return { result, validation, status: "needs_review" as const, eligible: pass };
}
