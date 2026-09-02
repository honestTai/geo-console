import { randomUUID } from "node:crypto";
import { applicationPermissions, type Database, legacyRolePermissionPresets, permissionParentKey } from "@geo/core";
import { z } from "zod";
import { type Paginated, type PaginationInput, paginated } from "./pagination";

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
				await transaction.query<{ id: string }>("SELECT id FROM roles WHERE organization_id=$1 AND name=$2 LIMIT 1", [
					organizationId,
					details.name,
				])
			).rows[0];
			const roleId = existing?.id ?? randomUUID();
			if (!existing)
				await transaction.query(
					"INSERT INTO roles (id,organization_id,name,description,is_system) VALUES ($1,$2,$3,$4,true)",
					[roleId, organizationId, details.name, details.description],
				);
			for (const permissionKey of legacyRolePermissionPresets[legacyRole as keyof typeof legacyRolePermissionPresets])
				await transaction.query(
					"INSERT INTO role_permissions (role_id,permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING",
					[roleId, permissionKey],
				);
		}
	});
}

export async function resolveEffectiveAccess(
	database: Database,
	userId: string | null,
	organizationId: string,
	isSuperAdmin: boolean,
): Promise<EffectiveAccess> {
	if (isSuperAdmin || userId === null) {
		const permissionRows = await database.query<{ key: string }>("SELECT key FROM permissions ORDER BY key");
		return {
			roles: [{ id: "super-admin", name: "系统超管" }],
			permissions: permissionRows.rows.map((row) => row.key),
			allProjects: true,
			projectIds: [],
		};
	}
	const [roleRows, permissionRows, userRow, projectRows] = await Promise.all([
		database.query<{ id: string; name: string }>(
			`SELECT r.id,r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id
			 WHERE ur.user_id=$1 AND r.organization_id=$2 ORDER BY r.name`,
			[userId, organizationId],
		),
		database.query<{ permission_key: string }>(
			`SELECT DISTINCT rp.permission_key FROM user_roles ur
			 JOIN roles r ON r.id=ur.role_id
			 JOIN role_permissions rp ON rp.role_id=r.id
			 JOIN organization_permissions op ON op.organization_id=r.organization_id AND op.permission_key=rp.permission_key
			 WHERE ur.user_id=$1 AND r.organization_id=$2 ORDER BY rp.permission_key`,
			[userId, organizationId],
		),
		database.query<{ all_projects: boolean }>("SELECT all_projects FROM users WHERE id=$1 AND organization_id=$2", [
			userId,
			organizationId,
		]),
		database.query<{ project_id: string }>(
			`SELECT upa.project_id FROM user_project_access upa JOIN projects p ON p.id=upa.project_id
			 WHERE upa.user_id=$1 AND p.organization_id=$2 ORDER BY upa.project_id`,
			[userId, organizationId],
		),
	]);
	return {
		roles: roleRows.rows,
		permissions: permissionRows.rows.map((row) => row.permission_key),
		allProjects: Boolean(userRow.rows[0]?.all_projects),
		projectIds: projectRows.rows.map((row) => row.project_id),
	};
}

export async function getRbacCatalog(database: Database, organizationId: string): Promise<Record<string, unknown>> {
	const [catalog, grants] = await Promise.all([
		database.query(
			`SELECT key,kind,group_label,label,navigation_key,icon_key,system_only,desktop_only,position
			 FROM permissions ORDER BY position,key`,
		),
		database.query<{ permission_key: string }>(
			"SELECT permission_key FROM organization_permissions WHERE organization_id=$1 ORDER BY permission_key",
			[organizationId],
		),
	]);
	return {
		permissions: catalog.rows.map((row) => ({ ...row, parent_key: permissionParentKey(String(row.key)) })),
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
			`SELECT r.id,r.name,r.description,r.is_system,r.created_at,r.updated_at,count(DISTINCT ur.user_id)::int AS user_count
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
	if (rows.rows.length !== new Set(permissionKeys).size) throw new Error("角色包含机构尚未获准的页面或功能");
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
	await assertOrganizationPermissionKeys(database, organizationId, data.permissionKeys);
	const id = randomUUID();
	await database.transaction(async (transaction) => {
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
	await assertOrganizationPermissionKeys(database, organizationId, data.permissionKeys);
	await database.transaction(async (transaction) => {
		const result = await transaction.query(
			"UPDATE roles SET name=$3,description=$4,updated_at=now() WHERE id=$1 AND organization_id=$2",
			[roleId, organizationId, data.name, data.description ?? null],
		);
		if (result.affectedRows !== 1) throw new Error("角色不存在");
		await replaceRolePermissions(transaction, roleId, data.permissionKeys);
	});
}

export async function deleteRole(database: Database, organizationId: string, roleId: string): Promise<void> {
	const role = (
		await database.query<{ is_system: boolean; user_count: number }>(
			`SELECT r.is_system,count(ur.user_id)::int AS user_count FROM roles r LEFT JOIN user_roles ur ON ur.role_id=r.id
			 WHERE r.id=$1 AND r.organization_id=$2 GROUP BY r.id`,
			[roleId, organizationId],
		)
	).rows[0];
	if (!role) throw new Error("角色不存在");
	if (role.is_system) throw new Error("默认角色不能删除，但可以修改其权限");
	if (Number(role.user_count) > 0) throw new Error("请先移除该角色下的用户");
	await database.query("DELETE FROM roles WHERE id=$1 AND organization_id=$2", [roleId, organizationId]);
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
		if (rows.rows.length !== permissionKeys.length) throw new Error("机构授权包含不存在或仅限系统超管的权限");
	}
	await database.transaction(async (transaction) => {
		await transaction.query("DELETE FROM organization_permissions WHERE organization_id=$1", [organizationId]);
		for (const permissionKey of [...new Set(permissionKeys)])
			await transaction.query(
				"INSERT INTO organization_permissions (organization_id,permission_key,granted_by) VALUES ($1,$2,$3)",
				[organizationId, permissionKey, grantedBy],
			);
		await transaction.query(
			`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE organization_id=$1)
			 AND permission_key NOT IN (SELECT permission_key FROM organization_permissions WHERE organization_id=$1)`,
			[organizationId],
		);
	});
}

export class AccessDeniedError extends Error {}

function pathMatches(pattern: string, path: string): boolean {
	const patternSegments = pattern.split("/").filter(Boolean);
	const pathSegments = path.split("/").filter(Boolean);
	for (let index = 0; index < patternSegments.length; index += 1) {
		const expected = patternSegments[index];
		if (expected === "*") return true;
		const actual = pathSegments[index];
		if (!actual || (expected && !expected.startsWith(":") && expected !== actual)) return false;
	}
	return patternSegments.length === pathSegments.length;
}

export async function authorizeDynamicRequest(
	database: Database,
	permissions: string[],
	isSuperAdmin: boolean,
	method: string,
	path: string,
): Promise<void> {
	if (isSuperAdmin) return;
	const policies = (
		await database.query<{ permission_key: string; path_pattern: string }>(
			"SELECT permission_key,path_pattern FROM permission_routes WHERE http_method=$1 ORDER BY position,id",
			[method.toUpperCase()],
		)
	).rows.filter((policy) => pathMatches(policy.path_pattern, path));
	if (!policies.length) throw new AccessDeniedError("接口尚未登记动态权限策略");
	if (!policies.some((policy) => permissions.includes(policy.permission_key)))
		throw new AccessDeniedError("当前角色未获得此页面或功能权限");
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
			 WHERE kind='page' AND navigation_key IS NOT NULL ORDER BY position,key`,
		)
	).rows;
	return { items: isSuperAdmin ? rows : rows.filter((row) => permissions.includes(String(row.key))) };
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
	if (roleIds.length) {
		const roleRows = await database.query<{ id: string }>(
			`SELECT id FROM roles WHERE organization_id=$1 AND id IN (${sqlPlaceholders(roleIds, 2)})`,
			[organizationId, ...roleIds],
		);
		if (roleRows.rows.length !== roleIds.length) throw new Error("包含其他机构或不存在的角色");
	}
	if (!data.allProjects && projectIds.length) {
		const projectRows = await database.query<{ id: string }>(
			`SELECT id FROM projects WHERE organization_id=$1 AND id IN (${sqlPlaceholders(projectIds, 2)})`,
			[organizationId, ...projectIds],
		);
		if (projectRows.rows.length !== projectIds.length) throw new Error("包含其他机构或不存在的客户");
	}
	await database.transaction(async (transaction) => {
		const user = await transaction.query<{ is_super_admin: boolean }>(
			"SELECT is_super_admin FROM users WHERE id=$1 AND organization_id=$2",
			[userId, organizationId],
		);
		if (!user.rows[0]) throw new Error("用户不存在");
		if (user.rows[0].is_super_admin) throw new Error("系统超管不接受机构角色或客户范围限制");
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
