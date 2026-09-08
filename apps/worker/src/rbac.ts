import { randomUUID } from "node:crypto";
import { applicationPermissions, type Database, legacyRolePermissionPresets } from "@geo/core";
import { z } from "zod";
import { loadPrincipal } from "./authorization/principal";
import { type Paginated, type PaginationInput, paginated } from "./pagination";
import { HttpInputError } from "./utils";

export { AccessDeniedError } from "./authorization";

export type EffectiveAccess = {
	roles: Array<{ id: string; name: string }>;
	permissions: string[];
	allProjects: boolean;
	projectIds: string[];
};

const permissionKeySchema = z
	.string()
	.trim()
	.min(1)
	.max(160)
	.regex(/^[a-z][a-z0-9_.:-]*$/);
const roleInputSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).optional().nullable(),
	permissionKeys: z.array(permissionKeySchema).max(1_000),
});

const userAccessSchema = z.object({
	roleIds: z.array(z.string().trim().min(1)).max(50),
	allProjects: z.boolean(),
	projectIds: z.array(z.string().trim().min(1)).max(10_000).default([]),
});

function sqlPlaceholders(values: unknown[], start = 1): string {
	return values.map((_, index) => `$${index + start}`).join(",");
}

export async function seedOrganizationRbac(
	database: Database,
	organizationId: string,
	grantedBy: string | null = null,
): Promise<void> {
	await database.transaction(async (transaction) => {
		await transaction.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [organizationId]);
		if (
			(
				await transaction.query("SELECT id FROM roles WHERE organization_id=$1 AND system_key IS NOT NULL LIMIT 1", [
					organizationId,
				])
			).rows.length
		)
			return;
		for (const permission of applicationPermissions) {
			if ("systemOnly" in permission && permission.systemOnly) continue;
			await transaction.query(
				`INSERT INTO organization_permissions (organization_id,permission_key,granted_by)
				 VALUES ($1,$2,$3) ON CONFLICT (organization_id,permission_key) DO NOTHING`,
				[organizationId, permission.key, grantedBy],
			);
		}
		for (const [legacyRole, details] of Object.entries({
			admin: { name: "机构管理员", description: "默认管理角色" },
			analyst: { name: "业务分析师", description: "默认业务操作角色" },
			viewer: { name: "只读成员", description: "默认只读角色" },
		})) {
			const existing = (
				await transaction.query<{ id: string }>(
					"SELECT id FROM roles WHERE organization_id=$1 AND system_key=$2 LIMIT 1",
					[organizationId, legacyRole],
				)
			).rows[0];
			const roleId = existing?.id ?? randomUUID();
			if (!existing)
				await transaction.query(
					"INSERT INTO roles (id,organization_id,name,description,is_system,system_key) VALUES ($1,$2,$3,$4,true,$5)",
					[roleId, organizationId, details.name, details.description, legacyRole],
				);
			for (const permissionKey of legacyRolePermissionPresets[legacyRole as keyof typeof legacyRolePermissionPresets])
				await transaction.query(
					"INSERT INTO role_permissions (role_id,permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING",
					[roleId, permissionKey],
				);
		}
	});
}

/** Legacy projection for consumers; the underlying authorization snapshot is read by one SQL statement. */
export async function resolveEffectiveAccess(
	database: Database,
	userId: string | null,
	organizationId: string,
	_isSuperAdmin: boolean,
): Promise<EffectiveAccess> {
	if (!userId) return { roles: [], permissions: [], allProjects: false, projectIds: [] };
	const principal = await loadPrincipal(database, { userId, organizationId });
	return principal
		? {
				roles: principal.roles,
				permissions: principal.permissions,
				allProjects: principal.projects.all,
				projectIds: principal.projects.ids,
			}
		: { roles: [], permissions: [], allProjects: false, projectIds: [] };
}

export async function getRbacCatalog(database: Database, organizationId: string): Promise<Record<string, unknown>> {
	const [catalog, grants] = await Promise.all([
		database.query(
			`SELECT key,kind,group_label,label,navigation_key,icon_key,system_only,desktop_only,position,parent_key,enabled,built_in
			 FROM permissions ORDER BY position,key`,
		),
		database.query<{ permission_key: string }>(
			"SELECT permission_key FROM organization_permissions WHERE organization_id=$1 ORDER BY permission_key",
			[organizationId],
		),
	]);
	return {
		permissions: catalog.rows.map((row) => ({ ...row, parent_key: row.parent_key })),
		organizationPermissionKeys: grants.rows.map((row) => row.permission_key),
	};
}

export async function listRoles(
	database: Database,
	organizationId: string,
	input: PaginationInput,
): Promise<Paginated<Record<string, unknown>>> {
	const search = input.search ? `%${input.search}%` : null;
	const total = Number(
		(
			await database.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM roles WHERE organization_id=$1 AND ($2::text IS NULL OR name ILIKE $2)",
				[organizationId, search],
			)
		).rows[0]?.count ?? 0,
	);
	const roles = (
		await database.query<Record<string, unknown>>(
			`SELECT r.id,r.name,r.description,r.is_system,r.system_key,r.created_at,r.updated_at,count(DISTINCT ur.user_id)::int AS user_count
			 FROM roles r LEFT JOIN user_roles ur ON ur.role_id=r.id
			 WHERE r.organization_id=$1 AND ($2::text IS NULL OR r.name ILIKE $2)
			 GROUP BY r.id ORDER BY r.is_system DESC,r.created_at,r.name LIMIT $3 OFFSET $4`,
			[organizationId, search, input.pageSize, input.offset],
		)
	).rows;
	if (roles.length) {
		const ids = roles.map((role) => String(role.id));
		const permissionRows = (
			await database.query<{ role_id: string; permission_key: string }>(
				`SELECT role_id,permission_key FROM role_permissions WHERE role_id IN (${sqlPlaceholders(ids)}) ORDER BY permission_key`,
				ids,
			)
		).rows;
		for (const role of roles)
			role.permission_keys = permissionRows.filter((row) => row.role_id === role.id).map((row) => row.permission_key);
	}
	return paginated(roles, total, input);
}

async function assertOrganizationPermissionKeys(
	database: Database,
	organizationId: string,
	permissionKeys: string[],
): Promise<void> {
	if (!permissionKeys.length) return;
	const rows = await database.query<{ permission_key: string }>(
		`SELECT permission_key FROM organization_permissions WHERE organization_id=$1
		 AND permission_key IN (${sqlPlaceholders(permissionKeys, 2)})`,
		[organizationId, ...permissionKeys],
	);
	if (rows.rows.length !== new Set(permissionKeys).size)
		throw new HttpInputError("角色包含机构尚未获准的页面或功能", 403);
}

async function replaceRolePermissions(database: Database, roleId: string, permissionKeys: string[]): Promise<void> {
	await database.query("DELETE FROM role_permissions WHERE role_id=$1", [roleId]);
	for (const permissionKey of [...new Set(permissionKeys)])
		await database.query("INSERT INTO role_permissions (role_id,permission_key) VALUES ($1,$2)", [
			roleId,
			permissionKey,
		]);
}

export async function createRole(database: Database, organizationId: string, input: unknown): Promise<{ id: string }> {
	const data = roleInputSchema.parse(input);
	const id = randomUUID();
	await database.transaction(async (transaction) => {
		const organization = await transaction.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
			organizationId,
		]);
		if (!organization.rows.length) throw new HttpInputError("机构不存在", 404);
		await assertOrganizationPermissionKeys(transaction, organizationId, data.permissionKeys);
		if (
			(
				await transaction.query("SELECT id FROM roles WHERE organization_id=$1 AND name=$2", [
					organizationId,
					data.name,
				])
			).rows.length
		)
			throw new HttpInputError("本机构已存在同名角色", 409);
		await transaction.query("INSERT INTO roles (id,organization_id,name,description) VALUES ($1,$2,$3,$4)", [
			id,
			organizationId,
			data.name,
			data.description ?? null,
		]);
		await replaceRolePermissions(transaction, id, data.permissionKeys);
	});
	return { id };
}

export async function updateRole(
	database: Database,
	organizationId: string,
	roleId: string,
	input: unknown,
): Promise<void> {
	const data = roleInputSchema.parse(input);
	await database.transaction(async (transaction) => {
		await transaction.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [organizationId]);
		const currentKeys = (
			await transaction.query<{ permission_key: string }>(
				"SELECT rp.permission_key FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.id=$1 AND r.organization_id=$2",
				[roleId, organizationId],
			)
		).rows.map((r) => r.permission_key);
		await assertOrganizationPermissionKeys(
			transaction,
			organizationId,
			data.permissionKeys.filter((key) => !currentKeys.includes(key)),
		);
		if (
			(
				await transaction.query("SELECT id FROM roles WHERE organization_id=$1 AND name=$2 AND id<>$3", [
					organizationId,
					data.name,
					roleId,
				])
			).rows.length
		)
			throw new HttpInputError("本机构已存在同名角色", 409);
		const result = await transaction.query(
			"UPDATE roles SET name=$3,description=$4,updated_at=now() WHERE id=$1 AND organization_id=$2",
			[roleId, organizationId, data.name, data.description ?? null],
		);
		if (result.affectedRows !== 1) throw new HttpInputError("角色不存在", 404);
		await replaceRolePermissions(transaction, roleId, data.permissionKeys);
	});
}

export async function deleteRole(database: Database, organizationId: string, roleId: string): Promise<void> {
	await database.transaction(async (tx) => {
		await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [organizationId]);
		const role = (
			await tx.query<{ is_system: boolean }>(
				"SELECT is_system FROM roles WHERE id=$1 AND organization_id=$2 FOR UPDATE",
				[roleId, organizationId],
			)
		).rows[0];
		if (!role) throw new HttpInputError("角色不存在", 404);
		if (role.is_system) throw new HttpInputError("默认角色不能删除，但可以修改其权限", 409);
		if ((await tx.query("SELECT user_id FROM user_roles WHERE role_id=$1 LIMIT 1", [roleId])).rows.length)
			throw new HttpInputError("请先移除该角色下的用户", 409);
		await tx.query("DELETE FROM roles WHERE id=$1 AND organization_id=$2", [roleId, organizationId]);
	});
}

export async function updateOrganizationPermissions(
	database: Database,
	organizationId: string,
	permissionKeysInput: unknown,
	grantedBy: string | null,
): Promise<void> {
	const permissionKeys = [...new Set(z.array(permissionKeySchema).max(1_000).parse(permissionKeysInput))];
	if (permissionKeys.length) {
		const rows = await database.query<{ key: string }>(
			`SELECT key FROM permissions WHERE system_only=false AND key IN (${sqlPlaceholders(permissionKeys)})`,
			permissionKeys,
		);
		if (rows.rows.length !== permissionKeys.length)
			throw new HttpInputError("机构授权包含不存在或仅限系统超管的权限", 400);
	}
	await database.transaction(async (transaction) => {
		if (!(await transaction.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [organizationId])).rows.length)
			throw new HttpInputError("机构不存在", 404);
		await transaction.query("DELETE FROM organization_permissions WHERE organization_id=$1", [organizationId]);
		for (const permissionKey of [...new Set(permissionKeys)])
			await transaction.query(
				"INSERT INTO organization_permissions (organization_id,permission_key,granted_by) VALUES ($1,$2,$3)",
				[organizationId, permissionKey, grantedBy],
			);

		// Entitlements are an upper bound, not a destructive rewrite of configured roles.
	});
}

export async function getDynamicNavigation(
	database: Database,
	permissions: string[],
	isSuperAdmin: boolean,
	_isDesktop: boolean,
): Promise<{ items: unknown[] }> {
	const rows = (
		await database.query<Record<string, unknown>>(
			`SELECT key,group_label,label,navigation_key,icon_key,desktop_only,position FROM permissions
			 WHERE kind='page' AND enabled=true AND navigation_key IS NOT NULL ORDER BY position,key`,
		)
	).rows;
	return { items: isSuperAdmin ? rows : rows.filter((row) => permissions.includes(String(row.key))) };
}

async function validateMemberScope(
	transaction: Database,
	organizationId: string,
	roleIds: string[],
	projectIds: string[],
): Promise<void> {
	if (roleIds.length) {
		const roleRows = await transaction.query<{ id: string }>(
			`SELECT id FROM roles WHERE organization_id=$1 AND id IN (${sqlPlaceholders(roleIds, 2)}) FOR SHARE`,
			[organizationId, ...roleIds],
		);
		if (roleRows.rows.length !== roleIds.length) throw new HttpInputError("包含其他机构或不存在的角色", 400);
	}
	if (projectIds.length) {
		const projectRows = await transaction.query<{ id: string }>(
			`SELECT id FROM projects WHERE organization_id=$1 AND deleted_at IS NULL AND id IN (${sqlPlaceholders(projectIds, 2)})`,
			[organizationId, ...projectIds],
		);
		if (projectRows.rows.length !== projectIds.length) throw new HttpInputError("包含其他机构或不存在的客户", 400);
	}
}

export async function updateUserAccess(
	database: Database,
	organizationId: string,
	userId: string,
	input: unknown,
): Promise<void> {
	const data = userAccessSchema.parse(input);
	const roleIds = [...new Set(data.roleIds)];
	const projectIds = [...new Set(data.projectIds)];
	await database.transaction(async (transaction) => {
		await transaction.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [organizationId]);
		await validateMemberScope(transaction, organizationId, roleIds, projectIds);
		const user = await transaction.query<{ is_super_admin: boolean }>(
			"SELECT is_super_admin FROM users WHERE id=$1 AND organization_id=$2",
			[userId, organizationId],
		);
		if (!user.rows[0]) throw new HttpInputError("用户不存在", 404);
		if (user.rows[0].is_super_admin) throw new HttpInputError("系统超管不接受机构角色或客户范围限制", 403);
		await transaction.query("UPDATE users SET all_projects=$2,updated_at=now() WHERE id=$1", [
			userId,
			data.allProjects,
		]);
		await transaction.query("DELETE FROM user_roles WHERE user_id=$1", [userId]);
		for (const roleId of roleIds)
			await transaction.query("INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)", [userId, roleId]);
		await transaction.query("DELETE FROM user_project_access WHERE user_id=$1", [userId]);
		if (!data.allProjects)
			for (const projectId of projectIds)
				await transaction.query("INSERT INTO user_project_access (user_id,project_id) VALUES ($1,$2)", [
					userId,
					projectId,
				]);
	});
}
