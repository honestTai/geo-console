import { randomUUID } from "node:crypto";
import type { Database } from "@geo/core";
import { z } from "zod";
import { type Paginated, type PaginationInput, paginated } from "./pagination";
import { ensureProviderConfigs } from "./providers";
import { seedOrganizationRbac } from "./rbac";

export async function listOrganizations(
	database: Database,
	input: PaginationInput,
): Promise<Paginated<Record<string, unknown>>> {
	const search = input.search ? `%${input.search}%` : null;
	const total = Number(
		(
			await database.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM organizations WHERE $1::text IS NULL OR name ILIKE $1 OR id ILIKE $1",
				[search],
			)
		).rows[0]?.count ?? 0,
	);
	const rows = (
		await database.query<Record<string, unknown>>(
			`SELECT o.id,o.name,o.suspended_at,o.suspended_reason,o.created_at,o.updated_at,count(DISTINCT p.id)::int AS project_count,
			 count(DISTINCT u.id)::int AS user_count
			 FROM organizations o LEFT JOIN projects p ON p.organization_id=o.id
			 LEFT JOIN users u ON u.organization_id=o.id AND u.disabled_at IS NULL
			 WHERE $1::text IS NULL OR o.name ILIKE $1 OR o.id ILIKE $1
			 GROUP BY o.id ORDER BY o.created_at LIMIT $2 OFFSET $3`,
			[search, input.pageSize, input.offset],
		)
	).rows;
	return paginated(rows, total, input);
}

export async function createOrganization(
	database: Database,
	input: unknown,
	createdBy: string | null = null,
): Promise<{ id: string }> {
	const data = z.object({ name: z.string().trim().min(1).max(160) }).parse(input);
	const id = randomUUID();
	await database.query("INSERT INTO organizations (id,name) VALUES ($1,$2)", [id, data.name]);
	await ensureProviderConfigs(database, id);
	await seedOrganizationRbac(database, id, createdBy);
	return { id };
}

export async function organizationExists(database: Database, organizationId: string): Promise<boolean> {
	return Boolean((await database.query("SELECT id FROM organizations WHERE id=$1", [organizationId])).rows[0]);
}

export async function setOrganizationStatus(database: Database, organizationId: string, input: unknown): Promise<void> {
	const data = z
		.object({ status: z.enum(["active", "suspended"]), reason: z.string().trim().max(500).optional().nullable() })
		.parse(input);
	const result = await database.query(
		`UPDATE organizations SET suspended_at=CASE WHEN $2='suspended' THEN COALESCE(suspended_at,now()) ELSE NULL END,
		 suspended_reason=CASE WHEN $2='suspended' THEN $3 ELSE NULL END,updated_at=now() WHERE id=$1`,
		[organizationId, data.status, data.reason ?? null],
	);
	if (result.affectedRows !== 1) throw new Error("机构不存在");
	if (data.status === "suspended")
		await database.query(
			`UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id IN
			 (SELECT id FROM users WHERE organization_id=$1 AND is_super_admin=false)`,
			[organizationId],
		);
}

type ResourceScope = {
	table: string;
	idColumn?: string;
	organizationExpression: string;
	projectExpression: string;
};

const resourceScopes: Array<{ expression: RegExp; scope: ResourceScope }> = [
	{
		expression: /^\/api\/projects\/([^/]+)/,
		scope: { table: "projects", organizationExpression: "organization_id", projectExpression: "id" },
	},
	{
		expression: /^\/api\/batches\/([^/]+)/,
		scope: {
			table: "experiment_batches b JOIN projects p ON p.id=b.project_id",
			idColumn: "b.id",
			organizationExpression: "p.organization_id",
			projectExpression: "p.id",
		},
	},
	{
		expression: /^\/api\/agent-runs\/([^/]+)/,
		scope: { table: "agent_runs", organizationExpression: "organization_id", projectExpression: "project_id" },
	},
	{
		expression: /^\/api\/drift-alerts\/([^/]+)/,
		scope: {
			table: "drift_alerts d JOIN projects p ON p.id=d.project_id",
			idColumn: "d.id",
			organizationExpression: "p.organization_id",
			projectExpression: "p.id",
		},
	},
	{
		expression: /^\/api\/reports\/([^/]+)/,
		scope: { table: "report_snapshots", organizationExpression: "organization_id", projectExpression: "project_id" },
	},
	{
		expression: /^\/api\/report-shares\/([^/]+)/,
		scope: {
			table: "report_shares s JOIN report_snapshots r ON r.id=s.report_id",
			idColumn: "s.id",
			organizationExpression: "r.organization_id",
			projectExpression: "r.project_id",
		},
	},
	{
		expression: /^\/api\/workbench\/sessions\/([^/]+)/,
		scope: { table: "agent_sessions", organizationExpression: "organization_id", projectExpression: "project_id" },
	},
	{
		expression: /^\/api\/articles\/([^/]+)/,
		scope: {
			table: "optimization_articles",
			organizationExpression: "organization_id",
			projectExpression: "project_id",
		},
	},
	{
		expression: /^\/api\/tasks\/([^/]+)/,
		scope: {
			table: "remediation_tasks t JOIN projects p ON p.id=t.project_id",
			idColumn: "t.id",
			organizationExpression: "p.organization_id",
			projectExpression: "p.id",
		},
	},
];

export type RequestResourceScope = { organizationId: string; projectId: string };

export async function requestResourceScope(database: Database, path: string): Promise<RequestResourceScope | null> {
	for (const item of resourceScopes) {
		const match = path.match(item.expression);
		if (!match?.[1]) continue;
		const idColumn = item.scope.idColumn ?? "id";
		const row = (
			await database.query<{ organization_id: string; project_id: string }>(
				`SELECT ${item.scope.organizationExpression} AS organization_id,
				 ${item.scope.projectExpression} AS project_id FROM ${item.scope.table} WHERE ${idColumn}=$1`,
				[decodeURIComponent(match[1])],
			)
		).rows[0];
		return row ? { organizationId: row.organization_id, projectId: row.project_id } : null;
	}
	return null;
}

export async function requestResourceOrganization(database: Database, path: string): Promise<string | null> {
	return (await requestResourceScope(database, path))?.organizationId ?? null;
}

export function canAccessProject(projectId: string, allProjects: boolean, projectIds: string[]): boolean {
	return allProjects || projectIds.includes(projectId);
}

export async function canReadArtifact(
	database: Database,
	organizationId: string,
	artifactKey: string,
	allProjects: boolean,
	projectIds: string[],
): Promise<boolean> {
	const row = (
		await database.query<{ organization_id: string; project_id: string }>(
			`SELECT organization_id,project_id FROM (
			 SELECT p.organization_id,p.id AS project_id FROM query_captures c JOIN projects p ON p.id=c.project_id
			  WHERE c.raw_artifact_key=$1 OR c.screenshot_key=$1 OR c.trace_key=$1
			 UNION ALL
			 SELECT p.organization_id,p.id AS project_id FROM website_snapshots w JOIN projects p ON p.id=w.project_id WHERE w.artifact_key=$1
			 UNION ALL
			 SELECT r.organization_id,r.project_id FROM report_snapshots r
			  WHERE r.pdf_artifact_key=$1 OR r.word_artifact_key=$1
			) owned LIMIT 1`,
			[artifactKey],
		)
	).rows[0];
	return Boolean(
		row && row.organization_id === organizationId && canAccessProject(row.project_id, allProjects, projectIds),
	);
}
