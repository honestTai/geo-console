import type { ExecutionActor, Principal } from "@geo/authorization";
import type { Database } from "@geo/core";

export type PrincipalRecord = Principal & {
	email: string;
	displayName: string;
	legacyRole: string;
	organizationName: string;
	homeOrganizationName: string;
};
type SnapshotRow = {
	id: string;
	email: string;
	display_name: string;
	role: string;
	organization_id: string;
	home_name: string;
	active_id: string;
	active_name: string;
	disabled_at: string | null;
	suspended_at: string | null;
	is_super_admin: boolean;
	all_projects: boolean;
	authz_version: number;
	organization_version: number;
	credential_version: number;
	roles: Array<{ id: string; name: string }>;
	permissions: string[];
	configured_permissions: string[];
	project_ids: string[];
};

const principalSnapshotSql = `SELECT u.id,u.email,u.display_name,u.role,u.organization_id,h.name AS home_name,
	 a.id AS active_id,a.name AS active_name,u.disabled_at,a.suspended_at,u.is_super_admin,u.all_projects,u.authz_version,a.authz_version AS organization_version,u.credential_version,
	 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'name',r.name) ORDER BY r.name,r.id) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.organization_id=a.id),'[]') AS roles,
	 COALESCE((SELECT jsonb_agg(key ORDER BY key) FROM (SELECT DISTINCT p.key FROM permissions p WHERE p.enabled=true AND
	  (u.is_super_admin OR (p.system_only=false AND EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN role_permissions rp ON rp.role_id=r.id
	    JOIN organization_permissions op ON op.organization_id=r.organization_id AND op.permission_key=rp.permission_key
	    WHERE ur.user_id=u.id AND r.organization_id=a.id AND rp.permission_key=p.key)))) eligible),'[]') AS permissions,
	 COALESCE((SELECT jsonb_agg(permission_key ORDER BY permission_key) FROM (SELECT DISTINCT rp.permission_key FROM user_roles ur JOIN roles r ON r.id=ur.role_id
	  JOIN role_permissions rp ON rp.role_id=r.id WHERE ur.user_id=u.id AND r.organization_id=a.id) configured),'[]') AS configured_permissions,
	 COALESCE((SELECT jsonb_agg(p.id ORDER BY p.id) FROM user_project_access up JOIN projects p ON p.id=up.project_id WHERE up.user_id=u.id AND p.organization_id=a.id),'[]') AS project_ids
	 FROM users u JOIN organizations h ON h.id=u.organization_id
	 JOIN organizations a ON a.id=CASE WHEN u.is_super_admin AND $2::text IS NOT NULL THEN $2 ELSE u.organization_id END
	 WHERE ($1::text[] IS NULL OR u.id=ANY($1::text[])) AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.id
	  AND s.token_hash=$3 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.credential_version=u.credential_version))`;
function principalFromRow(row: SnapshotRow): PrincipalRecord {
	return {
		actor: { kind: "user", userId: row.id },
		userId: row.id,
		organizationId: row.active_id,
		homeOrganizationId: row.organization_id,
		active: row.disabled_at === null,
		organizationSuspended: row.suspended_at !== null,
		systemAdmin: row.is_super_admin,
		permissions: row.permissions,
		configuredPermissions: row.configured_permissions,
		roles: row.is_super_admin ? [{ id: "system-admin", name: "系统超管" }] : row.roles,
		projects: { all: row.is_super_admin || row.all_projects, ids: row.project_ids },
		revision: `${row.authz_version}:${row.organization_version}`,
		credentialVersion: row.credential_version,
		email: row.email,
		displayName: row.display_name,
		legacyRole: row.role,
		organizationName: row.active_name,
		homeOrganizationName: row.home_name,
	};
}
/** One SQL statement = one MVCC snapshot. Never independently read permissions and project scopes. */
export async function loadPrincipal(
	database: Database,
	input: { userId?: string; tokenHash?: string; organizationId?: string },
): Promise<PrincipalRecord | null> {
	if (!input.userId && !input.tokenHash) throw new Error("loadPrincipal requires a user or session identifier");
	const row = (
		await database.query<SnapshotRow>(principalSnapshotSql, [
			input.userId ? [input.userId] : null,
			input.organizationId ?? null,
			input.tokenHash ?? null,
		])
	).rows[0];
	return row ? principalFromRow(row) : null;
}
/** Bounded member-page batch: one consistent snapshot instead of one authorization query per listed user. */
export async function loadPrincipals(
	database: Database,
	userIds: string[],
	organizationId: string,
): Promise<PrincipalRecord[]> {
	if (!userIds.length) return [];
	if (userIds.length > 1000) throw new Error("Principal batch is limited to 1000 users");
	const rows = (
		await database.query<SnapshotRow>(principalSnapshotSql + " AND u.organization_id=$2", [
			userIds,
			organizationId,
			null,
		])
	).rows;
	return rows.map(principalFromRow);
}

const servicePermissions: Record<"report-scheduler", string[]> = {
	"report-scheduler": ["page.report", "page.evidence", "report.generate"],
};
export async function loadActorPrincipal(
	database: Database,
	actor: ExecutionActor,
	organizationId: string,
): Promise<Principal | null> {
	if (actor.kind === "user") return loadPrincipal(database, { userId: actor.userId, organizationId });
	if (actor.kind === "unassigned") return null;
	const org = (
		await database.query<{ id: string; suspended_at: string | null; authz_version: number }>(
			"SELECT id,suspended_at,authz_version FROM organizations WHERE id=$1",
			[organizationId],
		)
	).rows[0];
	if (!org) return null;
	if (actor.kind === "local") {
		if (process.env.NODE_ENV === "production" || (await database.query("SELECT id FROM users LIMIT 1")).rows.length)
			return null;
		const keys = (
			await database.query<{ key: string }>("SELECT key FROM permissions WHERE enabled=true ORDER BY key")
		).rows.map((r) => r.key);
		return {
			actor,
			userId: null,
			organizationId,
			homeOrganizationId: organizationId,
			active: true,
			organizationSuspended: Boolean(org.suspended_at),
			systemAdmin: true,
			permissions: keys,
			configuredPermissions: keys,
			roles: [{ id: "local-development", name: "本机开发" }],
			projects: { all: true, ids: [] },
			revision: `local:${org.authz_version}`,
			credentialVersion: 0,
		};
	}
	const allowed = servicePermissions[actor.serviceId];
	if (!allowed) return null;
	const keys = (
		await database.query<{ key: string }>(
			"SELECT p.key FROM permissions p JOIN organization_permissions op ON op.permission_key=p.key WHERE p.enabled=true AND p.system_only=false AND p.key=ANY($1::text[]) AND op.organization_id=$2",
			[allowed, organizationId],
		)
	).rows.map((r) => r.key);
	return {
		actor,
		userId: null,
		organizationId,
		homeOrganizationId: organizationId,
		active: true,
		organizationSuspended: Boolean(org.suspended_at),
		systemAdmin: false,
		permissions: keys,
		configuredPermissions: keys,
		roles: [],
		projects: { all: true, ids: [] },
		revision: `service:${org.authz_version}`,
		credentialVersion: 0,
	};
}

export function actorFromIdentity(identity: { id: string | null; localBypass?: boolean }): ExecutionActor {
	return identity.id
		? { kind: "user", userId: identity.id }
		: identity.localBypass
			? { kind: "local" }
			: { kind: "unassigned" };
}
