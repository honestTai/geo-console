import { randomUUID } from "node:crypto";
import type { Database } from "@geo/core";
import { z } from "zod";
import { type ResourceType, resolveArtifact, resolveResource } from "./authorization/resources";
import { type Paginated, type PaginationInput, paginated } from "./pagination";
import { ensureProviderConfigs } from "./providers";
import { seedOrganizationRbac } from "./rbac";
import { HttpInputError } from "./utils";

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
			 FROM organizations o LEFT JOIN projects p ON p.organization_id=o.id AND p.deleted_at IS NULL
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
	await database.transaction(async (tx) => {
		const result = await tx.query(
			`UPDATE organizations SET suspended_at=CASE WHEN $2='suspended' THEN COALESCE(suspended_at,now()) ELSE NULL END,
		 suspended_reason=CASE WHEN $2='suspended' THEN $3 ELSE NULL END,updated_at=now() WHERE id=$1`,
			[organizationId, data.status, data.reason ?? null],
		);
		if (result.affectedRows !== 1) throw new HttpInputError("机构不存在", 404);
		if (data.status === "suspended")
			await tx.query(
				`UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id IN
			 (SELECT id FROM users WHERE organization_id=$1 AND is_super_admin=false)`,
				[organizationId],
			);
	});
}

export type RequestResourceScope = { organizationId: string; projectId: string };
const resourcePrefixes: Record<string, ResourceType> = {
	projects: "project",
	batches: "batch",
	"agent-runs": "agent_run",
	"drift-alerts": "drift_alert",
	reports: "report",
	"report-shares": "report_share",
	articles: "article",
	tasks: "task",
};
/** Resource ownership inspection only. Call authorizeRequest for actual authorization. */
export async function requestResourceScope(database: Database, path: string): Promise<RequestResourceScope | null> {
	const parts = path.split("/");
	const type = parts[2] === "workbench" && parts[3] === "sessions" ? "session" : resourcePrefixes[parts[2]];
	if (!type) return null;
	let id: string;
	try {
		id = decodeURIComponent(parts[type === "session" ? 4 : 3] ?? "");
	} catch {
		return null;
	}
	const resource = await resolveResource(database, type, id);
	return resource?.organizationId && resource.projectId
		? { organizationId: resource.organizationId, projectId: resource.projectId }
		: null;
}
export async function requestResourceOrganization(database: Database, path: string) {
	return (await requestResourceScope(database, path))?.organizationId ?? null;
}
export function canAccessProject(projectId: string, allProjects: boolean, projectIds: string[]) {
	return allProjects || projectIds.includes(projectId);
}
/** Scope inspection only. Artifact HTTP access MUST use authorizeArtifact, which also checks functional rights. */
export async function canReadArtifact(
	database: Database,
	organizationId: string,
	artifactKey: string,
	allProjects: boolean,
	projectIds: string[],
) {
	const resource = await resolveArtifact(database, artifactKey);
	return Boolean(
		resource &&
			resource.organizationId === organizationId &&
			resource.projectId &&
			canAccessProject(resource.projectId, allProjects, projectIds),
	);
}
