import type { Database } from "@geo/core";
import type { Identity } from "./auth";
import { assertProjectAccess } from "./project-state";

export async function projectOperations(database: Database, projectId: string, identity: Identity) {
	await assertProjectAccess(database, projectId);
	const allowed = (permission: string) => identity.isSuperAdmin || identity.permissions.includes(permission);
	const entries: Array<{ key: string; label: string; view: string; filter: string; sql: string }> = [];
	if (allowed("page.articles")) {
		entries.push({
			key: "article-review",
			label: "待审核文章",
			view: "articles",
			filter: "review:pending",
			sql: `SELECT count(*)::int AS count FROM optimization_articles a WHERE a.project_id=$1 AND a.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM article_editorial_reviews r WHERE r.article_id=a.id AND r.article_version=a.version AND r.decision='approve' AND NOT EXISTS(SELECT 1 FROM article_editorial_reviews newer WHERE newer.article_id=r.article_id AND (newer.created_at,newer.id)>(r.created_at,r.id)))`,
		});
		entries.push({
			key: "article-quality",
			label: "质检异常",
			view: "articles",
			filter: "quality:failed",
			sql: `SELECT count(*)::int AS count FROM optimization_articles a JOIN LATERAL(SELECT status FROM article_quality_runs WHERE article_id=a.id AND article_version=a.version ORDER BY created_at DESC,id DESC LIMIT 1) q ON true WHERE a.project_id=$1 AND a.deleted_at IS NULL AND q.status='failed'`,
		});
	}
	if (allowed("page.publications")) {
		entries.push({
			key: "publication-ready",
			label: "待执行发布",
			view: "publications",
			filter: "ready",
			sql: "SELECT count(*)::int AS count FROM publication_orders WHERE project_id=$1 AND status='ready'",
		});
		entries.push({
			key: "publication-review",
			label: "待复核回执",
			view: "publications",
			filter: "submitted",
			sql: "SELECT count(*)::int AS count FROM publication_orders WHERE project_id=$1 AND status='submitted'",
		});
		entries.push({
			key: "publication-failed",
			label: "发布失败",
			view: "publications",
			filter: "failed",
			sql: "SELECT count(*)::int AS count FROM publication_orders WHERE project_id=$1 AND status='failed'",
		});
	}
	if (allowed("page.customer_knowledge"))
		entries.push({
			key: "knowledge-review",
			label: "待核实资料",
			view: "customerKnowledge",
			filter: "draft",
			sql: "SELECT count(*)::int AS count FROM customer_knowledge_assets WHERE project_id=$1 AND status='draft'",
		});
	if (allowed("page.remediation"))
		entries.push({
			key: "remediation-open",
			label: "待处理整改",
			view: "remediation",
			filter: "",
			sql: "SELECT count(*)::int AS count FROM remediation_tasks WHERE project_id=$1 AND status IN ('todo','in_progress','published')",
		});
	const items = await Promise.all(
		entries.map(async ({ sql, ...entry }) => ({
			...entry,
			count: Number((await database.query<{ count: number }>(sql, [projectId])).rows[0].count),
		})),
	);
	const content = allowed("page.articles")
		? (
				await database.query<{ total: number; published: number }>(
					"SELECT count(*)::int AS total,count(*) FILTER(WHERE status='published')::int AS published FROM optimization_articles WHERE project_id=$1 AND deleted_at IS NULL",
					[projectId],
				)
			).rows[0]
		: null;
	const attribution = allowed("page.attribution")
		? (
				await database.query(
					"SELECT source_type,metric,sum(value)::float8 AS value,max(observed_at) AS last_observed_at FROM attribution_events WHERE project_id=$1 AND observed_at>=now()-interval '30 days' AND metric IN ('sessions','users','leads','qualified_leads','phone_calls') GROUP BY source_type,metric ORDER BY source_type,metric",
					[projectId],
				)
			).rows
		: [];
	const pendingRetests = allowed("page.monitor")
		? (
				await database.query<{ id: string }>(
					`SELECT DISTINCT b.id FROM publication_orders p JOIN optimization_articles a ON a.id=p.article_id
	 JOIN experiment_batches source ON source.id=a.batch_id JOIN experiment_batches b ON b.id=CASE WHEN source.kind='retest' THEN source.compare_to_batch_id ELSE source.id END
	 WHERE p.project_id=$1 AND p.status='verified' AND b.kind='baseline' AND b.status IN ('complete','partial')
	 AND NOT EXISTS(SELECT 1 FROM experiment_batches r WHERE r.compare_to_batch_id=b.id AND r.kind='retest' AND r.status IN ('complete','partial') AND r.completed_at>p.completed_at)
	 ORDER BY b.id`,
					[projectId],
				)
			).rows
		: [];
	return { items, content, attribution, pendingRetests, asOf: new Date().toISOString() };
}
