import type { Resource } from "@geo/authorization";
import type { Database } from "@geo/core";

/** Resource resolvers are trusted code, not configurable SQL. Adding a domain object requires one resolver here. */
export const resourceResolvers = {
	organization: "SELECT id AS organization_id FROM organizations WHERE id=$1",
	project: "SELECT organization_id,id AS project_id FROM projects WHERE id=$1",
	batch:
		"SELECT p.organization_id,p.id AS project_id FROM experiment_batches b JOIN projects p ON p.id=b.project_id WHERE b.id=$1",
	task: "SELECT p.organization_id,p.id AS project_id FROM remediation_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1",
	agent_run: "SELECT organization_id,project_id FROM agent_runs WHERE id=$1",
	session: "SELECT organization_id,project_id,created_by AS owner_user_id FROM agent_sessions WHERE id=$1",
	report: "SELECT organization_id,project_id,created_by AS owner_user_id FROM report_snapshots WHERE id=$1",
	report_share:
		"SELECT r.organization_id,r.project_id,s.created_by AS owner_user_id FROM report_shares s JOIN report_snapshots r ON r.id=s.report_id WHERE s.id=$1",
	article: "SELECT organization_id,project_id FROM optimization_articles WHERE id=$1",
	article_quality: "SELECT organization_id,project_id FROM article_quality_runs WHERE id=$1",
	knowledge_asset: "SELECT organization_id,project_id FROM customer_knowledge_assets WHERE id=$1",
	publication_channel: "SELECT organization_id,project_id FROM publication_channels WHERE id=$1",
	publication_order: "SELECT organization_id,project_id FROM publication_orders WHERE id=$1",
	drift_alert:
		"SELECT p.organization_id,p.id AS project_id FROM drift_alerts d JOIN projects p ON p.id=d.project_id WHERE d.id=$1",
	member: "SELECT organization_id,id AS owner_user_id FROM users WHERE id=$1",
	role: "SELECT organization_id FROM roles WHERE id=$1",
} as const;
export type ResourceType = keyof typeof resourceResolvers;
export async function resolveResource(database: Database, type: ResourceType, id: string): Promise<Resource | null> {
	const sql = resourceResolvers[type];
	if (!sql) return null;
	const row = (
		await database.query<{ organization_id: string; project_id?: string; owner_user_id?: string | null }>(sql, [id])
	).rows[0];
	if (
		row?.project_id &&
		!(await database.query("SELECT id FROM projects WHERE id=$1 AND deleted_at IS NULL", [row.project_id])).rows.length
	)
		return null;
	return row
		? { organizationId: row.organization_id, projectId: row.project_id, ownerUserId: row.owner_user_id }
		: null;
}
export async function resolveArtifact(database: Database, key: string): Promise<(Resource & { kind: string }) | null> {
	const row = (
		await database.query<{ organization_id: string; project_id: string; kind: string }>(
			`SELECT * FROM (
	 SELECT p.organization_id,p.id AS project_id,'capture' AS kind FROM query_captures c JOIN projects p ON p.id=c.project_id WHERE c.raw_artifact_key=$1 OR c.screenshot_key=$1 OR c.trace_key=$1
	 UNION ALL SELECT p.organization_id,p.id,'website' FROM website_snapshots w JOIN projects p ON p.id=w.project_id WHERE w.artifact_key=$1
	 UNION ALL SELECT p.organization_id,p.id,'website' FROM website_audits a JOIN projects p ON p.id=a.project_id
	 WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(a.result->'evidence','[]'::jsonb)) evidence WHERE evidence->>'objectKey'=$1)
	 UNION ALL SELECT r.organization_id,r.project_id,'report' FROM report_snapshots r WHERE r.pdf_artifact_key=$1 OR r.word_artifact_key=$1
	 UNION ALL SELECT r.organization_id,r.project_id,'semantic' FROM semantic_observations o JOIN semantic_parse_runs r ON r.id=o.run_id WHERE o.raw_artifact_key=$1
	 ) owned LIMIT 1`,
			[key],
		)
	).rows[0];
	if (
		row &&
		!(await database.query("SELECT id FROM projects WHERE id=$1 AND deleted_at IS NULL", [row.project_id])).rows.length
	)
		return null;
	return row ? { organizationId: row.organization_id, projectId: row.project_id, kind: row.kind } : null;
}
