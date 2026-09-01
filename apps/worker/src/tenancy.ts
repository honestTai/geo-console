import { randomUUID } from "node:crypto";
import type { Database } from "@geo/core";
import { z } from "zod";
import { ensureProviderConfigs } from "./providers";

export async function listOrganizations(database: Database): Promise<unknown[]> {
	return (
		await database.query(
			`SELECT o.id,o.name,o.created_at,o.updated_at,count(DISTINCT p.id)::int AS project_count,
			 count(DISTINCT u.id)::int AS user_count
			 FROM organizations o LEFT JOIN projects p ON p.organization_id=o.id
			 LEFT JOIN users u ON u.organization_id=o.id AND u.disabled_at IS NULL
			 GROUP BY o.id ORDER BY o.created_at`,
		)
	).rows;
}

export async function createOrganization(database: Database, input: unknown): Promise<{ id: string }> {
	const data = z.object({ name: z.string().trim().min(1).max(160) }).parse(input);
	const id = randomUUID();
	await database.query("INSERT INTO organizations (id,name) VALUES ($1,$2)", [id, data.name]);
	await ensureProviderConfigs(database, id);
	return { id };
}

export async function organizationExists(database: Database, organizationId: string): Promise<boolean> {
	return Boolean((await database.query("SELECT id FROM organizations WHERE id=$1", [organizationId])).rows[0]);
}

type ResourceScope = { table: string; idColumn?: string; organizationExpression: string };

const resourceScopes: Array<{ expression: RegExp; scope: ResourceScope }> = [
	{ expression: /^\/api\/projects\/([^/]+)/, scope: { table: "projects", organizationExpression: "organization_id" } },
	{
		expression: /^\/api\/batches\/([^/]+)/,
		scope: {
			table: "experiment_batches b JOIN projects p ON p.id=b.project_id",
			idColumn: "b.id",
			organizationExpression: "p.organization_id",
		},
	},
	{
		expression: /^\/api\/agent-runs\/([^/]+)/,
		scope: { table: "agent_runs", organizationExpression: "organization_id" },
	},
	{
		expression: /^\/api\/drift-alerts\/([^/]+)/,
		scope: {
			table: "drift_alerts d JOIN projects p ON p.id=d.project_id",
			idColumn: "d.id",
			organizationExpression: "p.organization_id",
		},
	},
	{
		expression: /^\/api\/reports\/([^/]+)/,
		scope: { table: "report_snapshots", organizationExpression: "organization_id" },
	},
	{
		expression: /^\/api\/report-shares\/([^/]+)/,
		scope: {
			table: "report_shares s JOIN report_snapshots r ON r.id=s.report_id",
			idColumn: "s.id",
			organizationExpression: "r.organization_id",
		},
	},
	{
		expression: /^\/api\/tasks\/([^/]+)/,
		scope: {
			table: "remediation_tasks t JOIN projects p ON p.id=t.project_id",
			idColumn: "t.id",
			organizationExpression: "p.organization_id",
		},
	},
];

export async function requestResourceOrganization(database: Database, path: string): Promise<string | null> {
	for (const item of resourceScopes) {
		const match = path.match(item.expression);
		if (!match?.[1]) continue;
		const idColumn = item.scope.idColumn ?? "id";
		const row = (
			await database.query<{ organization_id: string }>(
				`SELECT ${item.scope.organizationExpression} AS organization_id FROM ${item.scope.table} WHERE ${idColumn}=$1`,
				[decodeURIComponent(match[1])],
			)
		).rows[0];
		return row?.organization_id ?? null;
	}
	return null;
}

export async function canReadArtifact(
	database: Database,
	organizationId: string,
	artifactKey: string,
	isSuperAdmin: boolean,
): Promise<boolean> {
	const row = (
		await database.query<{ organization_id: string }>(
			`SELECT organization_id FROM (
			 SELECT p.organization_id FROM query_captures c JOIN projects p ON p.id=c.project_id
			  WHERE c.raw_artifact_key=$1 OR c.screenshot_key=$1 OR c.trace_key=$1
			 UNION ALL
			 SELECT p.organization_id FROM website_snapshots w JOIN projects p ON p.id=w.project_id WHERE w.artifact_key=$1
			 UNION ALL
			 SELECT r.organization_id FROM report_snapshots r
			  WHERE r.pdf_artifact_key=$1 OR r.word_artifact_key=$1
			) owned LIMIT 1`,
			[artifactKey],
		)
	).rows[0];
	return Boolean(row && (isSuperAdmin || row.organization_id === organizationId));
}
