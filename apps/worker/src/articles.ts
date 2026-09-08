import { randomUUID } from "node:crypto";
import type { ExecutionActor } from "@geo/authorization";
import type { Database, OptimizationArticleStatus } from "@geo/core";
import { ARTICLE_QUALITY_POLICY_VERSION, publicationPlanSchema } from "@geo/evidence";
import { z } from "zod";
import { enqueueAgentDraft } from "./agent";
import { articleVersion, assertArticlePublishable, getArticleQuality } from "./article-quality";
import { type Paginated, type PaginationInput, paginated } from "./pagination";
import { HttpInputError, parseJsonColumn, stableJson } from "./utils";

export type ArticleRecommendation = {
	deliveryType: string;
	index: number;
	priority: string;
	title: string;
	action: string;
	rationale: string;
	evidenceIds: string[];
};

/** 最新已批准报告叙述及其 GEO 建议；优化文章逐条建议生成。 */
export async function approvedRecommendations(
	database: Database,
	batchId: string,
): Promise<{ narrativeRunId: string; projectId: string; recommendations: ArticleRecommendation[] } | null> {
	const row = (
		await database.query<{ id: string; project_id: string; draft: unknown }>(
			`SELECT id,project_id,draft FROM agent_runs WHERE batch_id=$1 AND purpose='report_narrative' AND status='approved'
			 ORDER BY approved_at DESC LIMIT 1`,
			[batchId],
		)
	).rows[0];
	if (!row) return null;
	const draft = parseJsonColumn<{ geoRecommendations?: Array<Record<string, unknown>> }>(
		row.draft as string | Record<string, unknown>,
	);
	const recommendations = (draft.geoRecommendations ?? []).map((item, index) => ({
		deliveryType: typeof item.deliveryType === "string" ? item.deliveryType : "unclassified",
		index,
		priority: String(item.priority ?? "medium"),
		title: String(item.title ?? `GEO 建议 ${index + 1}`),
		action: String(item.action ?? ""),
		rationale: String(item.rationale ?? ""),
		evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds.map(String) : [],
	}));
	return { narrativeRunId: row.id, projectId: row.project_id, recommendations };
}

export async function generateArticlesForBatch(
	database: Database,
	batchId: string,
	options: { sessionId?: string | null; onlyMissing?: boolean; actor?: ExecutionActor } = {},
): Promise<{
	narrativeRunId: string;
	queued: Array<{ runId: string; recommendationIndex: number; title: string }>;
	skipped: Array<{ title: string; reason: string }>;
}> {
	const approved = await approvedRecommendations(database, batchId);
	if (!approved) throw new HttpInputError("生成优化文章前必须先批准该批次的报告叙述", 409);
	if (!approved.recommendations.length) throw new HttpInputError("报告叙述中没有 GEO 优化建议，无法生成文章", 409);
	const existing = new Set(
		(
			await database.query<{ recommendation_index: number }>(
				"SELECT recommendation_index FROM optimization_articles WHERE narrative_run_id=$1 AND deleted_at IS NULL",
				[approved.narrativeRunId],
			)
		).rows.map((row) => row.recommendation_index),
	);
	// 只看绑定当前已批准叙述的在途 run：叙述重生成后，旧叙述的 run 不能再挡住同序号的新文章。
	const pending = new Set(
		(
			await database.query<{ target_ref: unknown }>(
				`SELECT target_ref FROM agent_runs WHERE purpose='optimization_article' AND batch_id=$1
				 AND status IN ('queued','running','awaiting_approval') AND target_ref->>'narrativeRunId'=$2`,
				[batchId, approved.narrativeRunId],
			)
		).rows.map((row) => {
			const target = parseJsonColumn<{ recommendationIndex?: number }>(
				row.target_ref as string | Record<string, unknown>,
			);
			return target.recommendationIndex ?? -1;
		}),
	);
	const queued: Array<{ runId: string; recommendationIndex: number; title: string }> = [];
	const skipped: Array<{ title: string; reason: string }> = [];
	for (const recommendation of approved.recommendations) {
		if (recommendation.deliveryType !== "content") {
			skipped.push({
				title: recommendation.title,
				reason:
					recommendation.deliveryType === "unclassified"
						? "历史建议未明确交付类型，请先重新生成并批准有分类的报告建议"
						: "该建议需要技术、采集或资料核实，不应通过写文章处理",
			});
			continue;
		}
		if (options.onlyMissing !== false && (existing.has(recommendation.index) || pending.has(recommendation.index)))
			continue;
		const run = await enqueueAgentDraft(database, {
			projectId: approved.projectId,
			batchId,
			purpose: "optimization_article",
			sessionId: options.sessionId ?? null,
			actor: options.actor,
			targetRef: { narrativeRunId: approved.narrativeRunId, recommendationIndex: recommendation.index },
		});
		queued.push({ runId: run.id, recommendationIndex: recommendation.index, title: recommendation.title });
	}
	return { narrativeRunId: approved.narrativeRunId, queued, skipped };
}

export async function listArticles(
	database: Database,
	projectId: string,
	input: PaginationInput,
	filters: {
		batchId?: string | null;
		status?: string | null;
		qualityStatus?: string | null;
		reviewStatus?: string | null;
		publicationStatus?: string | null;
		search?: string | null;
	} = {},
): Promise<Paginated<Record<string, unknown>>> {
	const filtered = `WITH operations AS (SELECT a.*,
	 CASE WHEN qr.id IS NULL THEN 'pending' WHEN qr.article_version<>a.version OR qr.contract->>'policyVersion'<>'${ARTICLE_QUALITY_POLICY_VERSION}' OR EXISTS(
	  SELECT 1 FROM jsonb_array_elements(qr.sources) source WHERE source->>'kind'='knowledge' AND NOT EXISTS(
	   SELECT 1 FROM customer_knowledge_assets ka JOIN customer_knowledge_revisions kr ON kr.asset_id=ka.id AND kr.revision=ka.current_revision
	   WHERE ka.id=source->>'assetId' AND ka.project_id=a.project_id AND ka.status='approved' AND ka.current_revision=(source->>'revision')::int AND (kr.valid_until IS NULL OR kr.valid_until>now()))) THEN 'stale'
	  WHEN qr.status='needs_review' AND qa.eligible AND qv.decision='approve' THEN 'passed' ELSE qr.status END AS quality_status,
	 CASE WHEN er.id IS NULL THEN 'pending' WHEN er.article_version<>a.version THEN 'stale'
	  WHEN er.decision='approve' THEN 'approved' ELSE 'rejected' END AS review_status,
	 COALESCE(po.status,CASE WHEN a.status='published' THEN 'verified' ELSE 'unplanned' END) AS publication_status
	 FROM optimization_articles a
	 LEFT JOIN LATERAL (SELECT * FROM article_quality_runs WHERE article_id=a.id ORDER BY created_at DESC,id DESC LIMIT 1) qr ON true
	 LEFT JOIN article_quality_attempts qa ON qa.id=qr.selected_attempt_id AND qa.run_id=qr.id
	 LEFT JOIN LATERAL (SELECT decision FROM article_quality_reviews WHERE run_id=qr.id ORDER BY created_at DESC,id DESC LIMIT 1) qv ON true
	 LEFT JOIN LATERAL (SELECT id,article_version,decision FROM article_editorial_reviews WHERE article_id=a.id ORDER BY created_at DESC,id DESC LIMIT 1) er ON true
	 LEFT JOIN LATERAL (SELECT status FROM publication_orders WHERE article_id=a.id AND article_version=a.version ORDER BY updated_at DESC,id DESC LIMIT 1) po ON true
	 WHERE a.project_id=$1 AND a.deleted_at IS NULL
	 AND ($2::text IS NULL OR a.batch_id=$2) AND ($3::text IS NULL OR a.status=$3)
	 AND ($6::text IS NULL OR a.title ILIKE '%'||$6||'%' OR a.summary ILIKE '%'||$6||'%'))
	 SELECT * FROM operations WHERE ($4::text IS NULL OR quality_status=$4) AND ($5::text IS NULL OR review_status=$5 OR ($5='unapproved' AND review_status<>'approved'))
	 AND ($7::text IS NULL OR publication_status=$7)`;
	const params = [
		projectId,
		filters.batchId ?? null,
		filters.status ?? null,
		filters.qualityStatus ?? null,
		filters.reviewStatus ?? null,
		filters.search ?? input.search ?? null,
		filters.publicationStatus ?? null,
	];
	const total = Number(
		(await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM (${filtered}) results`, params))
			.rows[0]?.count ?? 0,
	);
	const rows = (
		await database.query<Record<string, unknown>>(
			`SELECT id,project_id,batch_id,source_run_id,narrative_run_id,recommendation_index,recommendation_title,
			 recommendation_priority,title,summary,status,published_url,version,length(content_markdown) AS content_length,
			 quality_status,review_status,publication_status,created_at,updated_at FROM (${filtered}) results ORDER BY created_at DESC,id DESC LIMIT $8 OFFSET $9`,
			[...params, input.pageSize, input.offset],
		)
	).rows;
	return paginated(rows, total, input);
}

export async function getArticle(database: Database, articleId: string): Promise<Record<string, unknown> | null> {
	const row = (
		await database.query<Record<string, unknown>>(
			"SELECT * FROM optimization_articles WHERE id=$1 AND deleted_at IS NULL",
			[articleId],
		)
	).rows[0];
	if (!row) return null;
	const targetIds = parseJsonColumn<string[]>(row.target_prompt_ids as string | string[]);
	const batch = row.batch_id
		? (
				await database.query<{ config: unknown }>(
					"SELECT config FROM experiment_batches WHERE id=$1 AND project_id=$2",
					[row.batch_id, row.project_id],
				)
			).rows[0]
		: null;
	const prompts = batch
		? (parseJsonColumn<{ prompts?: Array<{ id: string; question: string }> }>(
				batch.config as string | Record<string, unknown>,
			).prompts ?? [])
		: [];
	const quality = await getArticleQuality(database, articleId);
	return {
		...row,
		quality_status: quality.qualityStatus,
		review_status: quality.editorialStatus,
		outline: parseJsonColumn(row.outline as string | string[]),
		fact_gaps: parseJsonColumn(row.fact_gaps as string | string[]),
		evidence_ids: parseJsonColumn(row.evidence_ids as string | string[]),
		target_prompt_ids: parseJsonColumn(row.target_prompt_ids as string | string[]),
		publication_plan: row.publication_plan
			? parseJsonColumn(row.publication_plan as string | Record<string, unknown>)
			: null,
		target_questions: prompts.filter((p) => targetIds.includes(p.id)).map(({ id, question }) => ({ id, question })),
	};
}

const articleUpdateSchema = z.object({
	version: z.number().int().positive().optional(),
	title: z.string().trim().min(1).max(120).optional(),
	summary: z.string().trim().max(600).nullable().optional(),
	status: z.enum(["draft", "reviewing", "published"]).optional(),
	contentMarkdown: z.string().trim().min(1).max(60_000).optional(),
	publishedUrl: z
		.url()
		.refine((url) => ["http:", "https:"].includes(new URL(url).protocol), "发布地址必须是网页地址")
		.nullable()
		.optional(),
	publicationPlan: publicationPlanSchema.optional(),
});

function validatePublicationUpdate(data: z.infer<typeof articleUpdateSchema>, current: Record<string, unknown>): void {
	const allowedEvidence = new Set(current.evidence_ids as string[]);
	if (data.publicationPlan?.channels.some((c) => c.evidenceIds.some((id) => !allowedEvidence.has(id))))
		throw new HttpInputError("发布计划只能引用这篇文章已绑定的证据", 400);
	if ((data.status ?? current.status) === "published") {
		if (
			!(data.publishedUrl === undefined ? current.published_url : data.publishedUrl) ||
			!(data.publicationPlan ?? current.publication_plan)
		)
			throw new HttpInputError("登记发布前请填写实际发布地址及文章用途/发布计划", 400);
		if (/【待补充[：:]/.test(String(data.contentMarkdown ?? current.content_markdown)))
			throw new HttpInputError("正文仍有待补充事实，不能登记为已发布", 400);
	}
}

function articleContentChanged(data: z.infer<typeof articleUpdateSchema>, current: Record<string, unknown>) {
	return (
		(data.title !== undefined && data.title !== current.title) ||
		(data.summary !== undefined && data.summary !== current.summary) ||
		(data.contentMarkdown !== undefined && data.contentMarkdown !== current.content_markdown) ||
		(data.publicationPlan !== undefined && stableJson(data.publicationPlan) !== stableJson(current.publication_plan))
	);
}

export async function updateArticle(database: Database, articleId: string, input: unknown): Promise<void> {
	const data = articleUpdateSchema.parse(input);
	return database.transaction(async (transaction) => {
		await transaction.query("SELECT id FROM optimization_articles WHERE id=$1 FOR UPDATE", [articleId]);
		const current = await getArticle(transaction, articleId);
		if (!current) throw new HttpInputError("优化文章不存在", 404);
		if (data.version !== undefined && data.version !== current.version)
			throw new HttpInputError("文章已被更新，请刷新后重新编辑", 409);
		validatePublicationUpdate(data, current);
		if (data.status === "published") {
			if (articleContentChanged(data, current))
				throw new HttpInputError("请先保存文章新版本并完成审核质检，再登记发布", 409);
			await assertArticlePublishable(transaction, articleId, Number(current.version));
		}
		const status: OptimizationArticleStatus | null = data.status ?? null;
		const result = await transaction.query(
			`UPDATE optimization_articles SET
		 title=COALESCE($2,title),
		 summary=CASE WHEN $3::boolean THEN $4 ELSE summary END,
		 status=COALESCE($5,status),
		 content_markdown=COALESCE($6,content_markdown),
		 published_url=CASE WHEN $7::boolean THEN $8 ELSE published_url END,
		 publication_plan=CASE WHEN $9::boolean THEN $10::jsonb ELSE publication_plan END,
		 version=CASE WHEN ($6 IS NOT NULL AND $6<>content_markdown) OR $9::boolean THEN version+1 ELSE version END,
		 updated_at=now() WHERE id=$1`,
			[
				articleId,
				data.title ?? null,
				data.summary !== undefined,
				data.summary ?? null,
				status,
				data.contentMarkdown ?? null,
				data.publishedUrl !== undefined,
				data.publishedUrl ?? null,
				data.publicationPlan !== undefined,
				data.publicationPlan ? JSON.stringify(data.publicationPlan) : null,
			],
		);
		if (result.affectedRows !== 1) throw new HttpInputError("优化文章不存在", 404);
	});
}

export async function deleteArticle(database: Database, articleId: string): Promise<void> {
	const result = await database.query(
		"UPDATE optimization_articles SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL",
		[articleId],
	);
	if (result.affectedRows !== 1) throw new HttpInputError("优化文章不存在", 404);
}

export async function regenerateArticle(
	database: Database,
	articleId: string,
	actor?: ExecutionActor,
): Promise<{ runId: string }> {
	const article = (
		await database.query<{
			project_id: string;
			batch_id: string | null;
			narrative_run_id: string | null;
			recommendation_index: number;
		}>(
			"SELECT project_id,batch_id,narrative_run_id,recommendation_index FROM optimization_articles WHERE id=$1 AND deleted_at IS NULL",
			[articleId],
		)
	).rows[0];
	if (!article) throw new HttpInputError("优化文章不存在", 404);
	if (!article.batch_id || !article.narrative_run_id) throw new HttpInputError("该文章缺少来源报告，无法重新生成", 409);
	const run = await enqueueAgentDraft(database, {
		projectId: article.project_id,
		batchId: article.batch_id,
		purpose: "optimization_article",
		actor,
		targetRef: { narrativeRunId: article.narrative_run_id, recommendationIndex: article.recommendation_index },
	});
	return { runId: run.id };
}

export const newArticleId = (): string => randomUUID();

const articleExportSchema = z.strictObject({ articleIds: z.array(z.string().min(1)).min(1).max(100) });
export async function exportArticles(database: Database, projectId: string, input: unknown) {
	const { articleIds } = articleExportSchema.parse(input);
	const ids = [...new Set(articleIds)];
	const rows = (
		await database.query<{ id: string }>(
			"SELECT id FROM optimization_articles WHERE project_id=$1 AND deleted_at IS NULL AND id=ANY($2::text[]) ORDER BY created_at,id",
			[projectId, ids],
		)
	).rows;
	if (rows.length !== ids.length) throw new HttpInputError("所选文章不存在或不属于当前客户", 404);
	const files = [];
	for (const row of rows) {
		const article = await articleVersion(database, row.id);
		files.push({
			articleId: row.id,
			version: article.version,
			title: article.title,
			filename: `${Array.from(article.title)
				.map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
				.join("")
				.replace(/[<>:"/\\|?*]/g, "_")
				.slice(0, 90)}-v${article.version}.md`,
			content: `# ${article.title}\n\n${article.summary ? `${article.summary}\n\n` : ""}${article.contentMarkdown}\n`,
			contentHash: article.contentHash,
		});
	}
	return { files };
}
