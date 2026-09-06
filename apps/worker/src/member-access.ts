import { decideDelegation, type Principal } from "@geo/authorization";
import type { Database } from "@geo/core";
import { AccessDeniedError, actorFromIdentity, authorizeAction, decisionMessages } from "./authorization";
import { loadPrincipal } from "./authorization/principal";
import { type PaginationInput, paginated } from "./pagination";
import { HttpInputError } from "./utils";
export type MemberActor = { id: string | null; isSuperAdmin: boolean; localBypass?: boolean };
export type MemberAuthority = Principal & {
	id: string | null;
	isSuperAdmin: boolean;
	allProjects: boolean;
	projectIds: string[];
};
export async function memberAuthority(
	database: Database,
	organizationId: string,
	actor: MemberActor,
): Promise<MemberAuthority> {
	const principal = await authorizeAction(database, actorFromIdentity(actor), "members.manage", { organizationId });
	return {
		...principal,
		id: principal.userId,
		isSuperAdmin: principal.systemAdmin,
		allProjects: principal.projects.all,
		projectIds: principal.projects.ids,
	};
}
export async function assertAssignableMember(
	database: Database,
	organizationId: string,
	input: { roleIds: string[]; allProjects: boolean; projectIds: string[] },
	authority: MemberAuthority,
): Promise<void> {
	const roles = [...new Set(input.roleIds)],
		projects = [...new Set(input.projectIds)];
	const rows = (
		await database.query<{ id: string; permission_key: string | null }>(
			`SELECT r.id,rp.permission_key FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id
  WHERE r.organization_id=$1 AND r.id=ANY($2::text[]) FOR SHARE OF r`,
			[organizationId, roles],
		)
	).rows;
	if (new Set(rows.map((row) => row.id)).size !== roles.length) throw new HttpInputError("角色不存在或不属于当前机构");
	if (
		projects.length &&
		(
			await database.query("SELECT id FROM projects WHERE organization_id=$1 AND id=ANY($2::text[])", [
				organizationId,
				projects,
			])
		).rows.length !== projects.length
	)
		throw new HttpInputError("客户不存在或不属于当前机构");
	const reason = decideDelegation(authority, {
		configuredPermissions: rows.flatMap((row) => (row.permission_key ? [row.permission_key] : [])),
		projects: { all: input.allProjects, ids: projects },
	});
	if (reason !== "allowed") throw new AccessDeniedError(decisionMessages[reason] ?? "委派被拒绝");
}
export async function assertManageableMember(
	database: Database,
	organizationId: string,
	userId: string,
	actor: MemberActor,
): Promise<void> {
	await database.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [organizationId]);
	const row = (
		await database.query<{ is_super_admin: boolean }>(
			"SELECT is_super_admin FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE",
			[userId, organizationId],
		)
	).rows[0];
	if (!row) throw new HttpInputError("成员不存在", 404);
	if (row.is_super_admin) throw new AccessDeniedError("不能通过机构成员管理修改系统超管");
	const authority = await memberAuthority(database, organizationId, actor),
		target = await loadPrincipal(database, { userId, organizationId });
	if (!target) throw new HttpInputError("成员不存在", 404);
	const reason = decideDelegation(authority, target);
	if (reason !== "allowed") throw new AccessDeniedError(decisionMessages[reason] ?? "成员管理被拒绝");
}

export async function listMemberOptions(
	database: Database,
	organizationId: string,
	kind: "roles" | "projects",
	page: PaginationInput,
	actor: MemberActor,
) {
	const authority = await memberAuthority(database, organizationId, actor);
	const search = page.search ? `%${page.search}%` : null;
	const allowed = authority.isSuperAdmin ? null : authority.permissions;
	const projectIds = authority.allProjects ? null : authority.projectIds;
	const parameters = kind === "roles" ? [organizationId, allowed, search] : [organizationId, projectIds, search];
	const source = kind === "roles" ? "roles r" : "projects r";
	const filter =
		kind === "roles"
			? `r.organization_id=$1 AND ($2::text[] IS NULL OR NOT EXISTS(SELECT 1 FROM role_permissions rp WHERE rp.role_id=r.id AND NOT(rp.permission_key=ANY($2::text[]))))
		 AND ($3::text IS NULL OR r.name ILIKE $3)`
			: `r.organization_id=$1 AND ($2::text[] IS NULL OR r.id=ANY($2::text[])) AND ($3::text IS NULL OR r.name ILIKE $3 OR r.domain ILIKE $3)`;
	const total = Number(
		(
			await database.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM ${source} WHERE ${filter}`,
				parameters,
			)
		).rows[0].count,
	);
	const columns = kind === "roles" ? "r.id,r.name,r.description,r.is_system,r.system_key" : "r.id,r.name,r.domain";
	const order = kind === "roles" ? "(r.system_key='viewer') DESC NULLS LAST,r.name,r.id" : "r.name,r.id";
	const rows = (
		await database.query(`SELECT ${columns} FROM ${source} WHERE ${filter} ORDER BY ${order} LIMIT $4 OFFSET $5`, [
			...parameters,
			page.pageSize,
			page.offset,
		])
	).rows;
	return { ...paginated(rows, total, page), allProjectsAllowed: authority.allProjects };
}
