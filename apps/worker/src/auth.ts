import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Database, type OrganizationRole, readSecret } from "@geo/core";
import { z } from "zod";
import { type Paginated, type PaginationInput, paginated } from "./pagination";
import { resolveEffectiveAccess } from "./rbac";

export type Identity = {
	id: string | null;
	email: string;
	displayName: string;
	role: OrganizationRole;
	homeOrganizationId: string;
	organizationId: string;
	organizationName: string;
	organizationSuspended: boolean;
	isSuperAdmin: boolean;
	localBypass: boolean;
	roles: Array<{ id: string; name: string }>;
	permissions: string[];
	allProjects: boolean;
	projectIds: string[];
};

export class AuthenticationError extends Error {}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

function passwordHash(password: string): string {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 64);
	return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password: string, encoded: string): boolean {
	const [algorithm, saltValue, hashValue] = encoded.split("$");
	if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
	const expected = Buffer.from(hashValue, "base64");
	const actual = scryptSync(password, Buffer.from(saltValue, "base64"), expected.length);
	return timingSafeEqual(actual, expected);
}

function cookieValue(request: IncomingMessage, name: string): string | null {
	const cookies = request.headers.cookie?.split(";") ?? [];
	for (const cookie of cookies) {
		const [key, ...value] = cookie.trim().split("=");
		if (key === name) return decodeURIComponent(value.join("="));
	}
	return null;
}

function sessionToken(request: IncomingMessage): string | null {
	const authorization = request.headers.authorization;
	if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim() || null;
	return cookieValue(request, "geo_session");
}

export async function ensureBootstrapAdmin(database: Database): Promise<void> {
	const superAdmin = (await database.query("SELECT id FROM users WHERE is_super_admin=true LIMIT 1")).rows[0];
	if (superAdmin) return;
	const count =
		(await database.query<{ count: number }>("SELECT count(*)::int AS count FROM users")).rows[0]?.count ?? 0;
	const password = await readSecret("admin_password");
	if (!password) {
		if (process.env.NODE_ENV === "production" && count === 0)
			throw new Error("生产环境必须通过 GEO_ADMIN_PASSWORD 或 GEO_ADMIN_PASSWORD_FILE 初始化超管");
		return;
	}
	if (password.length < 12) throw new Error("GEO_ADMIN_PASSWORD 至少需要 12 位");
	const email = process.env.GEO_ADMIN_EMAIL?.trim().toLowerCase() || "admin@geo.local";
	const existing = (
		await database.query<{ id: string }>(
			"SELECT id FROM users WHERE organization_id='default' AND lower(email)=lower($1) LIMIT 1",
			[email],
		)
	).rows[0];
	if (existing)
		await database.query(
			"UPDATE users SET role='admin',is_super_admin=true,password_hash=$2,disabled_at=NULL,updated_at=now() WHERE id=$1",
			[existing.id, passwordHash(password)],
		);
	else
		await database.query(
			`INSERT INTO users (id,organization_id,email,display_name,role,is_super_admin,password_hash)
			 VALUES ($1,'default',$2,'系统超管','admin',true,$3)`,
			[randomUUID(), email, passwordHash(password)],
		);
}

async function identityFromRow(
	database: Database,
	row: Record<string, unknown>,
	activeOrganizationId?: string,
	activeOrganizationName?: string,
): Promise<Identity> {
	const homeOrganizationId = String(row.organization_id);
	const organizationId = activeOrganizationId ?? homeOrganizationId;
	const isSuperAdmin = Boolean(row.is_super_admin);
	const access = await resolveEffectiveAccess(database, String(row.id), organizationId, isSuperAdmin);
	return {
		id: String(row.id),
		email: String(row.email),
		displayName: String(row.display_name),
		role: String(row.role) as OrganizationRole,
		homeOrganizationId,
		organizationId,
		organizationName: activeOrganizationName ?? String(row.organization_name),
		organizationSuspended: Boolean(row.organization_suspended_at),
		isSuperAdmin,
		localBypass: false,
		...access,
	};
}

export async function authenticateRequest(database: Database, request: IncomingMessage): Promise<Identity | null> {
	const userCount =
		(await database.query<{ count: number }>("SELECT count(*)::int AS count FROM users")).rows[0]?.count ?? 0;
	if (userCount === 0 && process.env.NODE_ENV !== "production") {
		const selectedOrganization = cookieValue(request, "geo_organization");
		const selected = selectedOrganization
			? (
					await database.query<{ id: string; name: string }>("SELECT id,name FROM organizations WHERE id=$1", [
						selectedOrganization,
					])
				).rows[0]
			: null;
		return {
			id: null,
			email: "local@geo.local",
			displayName: "本机超管",
			role: "admin",
			homeOrganizationId: "default",
			organizationId: selected?.id ?? "default",
			organizationName: selected?.name ?? "默认机构",
			organizationSuspended: false,
			isSuperAdmin: true,
			localBypass: true,
			...(await resolveEffectiveAccess(database, null, selected?.id ?? "default", true)),
		};
	}
	const token = sessionToken(request);
	if (!token) return null;
	const row = (
		await database.query<Record<string, unknown>>(
			`SELECT u.id,u.email,u.display_name,u.role,u.organization_id,u.is_super_admin,o.name AS organization_name,
				 o.suspended_at AS organization_suspended_at
				 FROM sessions s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=u.organization_id
				 WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.disabled_at IS NULL
				 AND (u.is_super_admin=true OR o.suspended_at IS NULL)`,
			[hashToken(token)],
		)
	).rows[0];
	if (!row) return null;
	const selectedOrganization = cookieValue(request, "geo_organization");
	if (row.is_super_admin && selectedOrganization) {
		const selected = (
			await database.query<{ id: string; name: string; suspended_at: string | null }>(
				"SELECT id,name,suspended_at FROM organizations WHERE id=$1",
				[selectedOrganization],
			)
		).rows[0];
		if (selected)
			return identityFromRow(
				database,
				{ ...row, organization_suspended_at: selected.suspended_at },
				selected.id,
				selected.name,
			);
	}
	return identityFromRow(database, row);
}

export async function login(
	database: Database,
	response: ServerResponse,
	input: unknown,
): Promise<{ user: Identity; sessionToken: string }> {
	const data = z
		.object({ email: z.email(), password: z.string().min(1), organizationId: z.string().trim().min(1).optional() })
		.parse(input);
	const rows = (
		await database.query<Record<string, unknown>>(
			`SELECT u.id,u.email,u.display_name,u.role,u.password_hash,u.organization_id,u.is_super_admin,
				 o.name AS organization_name,o.suspended_at AS organization_suspended_at
				 FROM users u JOIN organizations o ON o.id=u.organization_id
				 WHERE lower(u.email)=lower($1) AND u.disabled_at IS NULL AND ($2::text IS NULL OR u.organization_id=$2)
				 ORDER BY u.is_super_admin DESC,u.created_at`,
			[data.email, data.organizationId ?? null],
		)
	).rows;
	if (rows.length > 1 && !data.organizationId && !rows[0]?.is_super_admin)
		throw new AuthenticationError("该邮箱属于多个机构，请同时填写机构 ID");
	const row = rows[0];
	if (!row || !verifyPassword(data.password, String(row.password_hash)))
		throw new AuthenticationError("邮箱或密码错误");
	if (!row.is_super_admin && row.organization_suspended_at)
		throw new AuthenticationError("机构已被封禁，请联系系统超管");
	const token = randomBytes(32).toString("base64url");
	const expiresAt = new Date(Date.now() + 7 * 86_400_000);
	await database.query("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)", [
		randomUUID(),
		row.id,
		hashToken(token),
		expiresAt.toISOString(),
	]);
	response.setHeader("set-cookie", [
		`geo_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 86_400}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
		`geo_organization=${encodeURIComponent(String(row.organization_id))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 86_400}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
	]);
	return { user: await identityFromRow(database, row), sessionToken: token };
}

export async function logout(database: Database, request: IncomingMessage, response: ServerResponse): Promise<void> {
	const token = sessionToken(request);
	if (token)
		await database.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1", [
			hashToken(token),
		]);
	response.setHeader("set-cookie", [
		`geo_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
		`geo_organization=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
	]);
}

export async function selectOrganization(
	database: Database,
	response: ServerResponse,
	identity: Identity,
	organizationId: string,
): Promise<Identity> {
	if (!identity.isSuperAdmin) throw new AuthenticationError("只有系统超管可以切换机构");
	const organization = (
		await database.query<{ id: string; name: string; suspended_at: string | null }>(
			"SELECT id,name,suspended_at FROM organizations WHERE id=$1",
			[organizationId],
		)
	).rows[0];
	if (!organization) throw new Error("机构不存在");
	response.setHeader(
		"set-cookie",
		`geo_organization=${encodeURIComponent(organization.id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 86_400}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
	);
	return {
		...identity,
		organizationId: organization.id,
		organizationName: organization.name,
		organizationSuspended: Boolean(organization.suspended_at),
		...(await resolveEffectiveAccess(database, identity.id, organization.id, identity.isSuperAdmin)),
	};
}

export async function listUsers(
	database: Database,
	organizationId: string,
	input: PaginationInput,
): Promise<Paginated<Record<string, unknown>>> {
	const search = input.search ? `%${input.search}%` : null;
	const total = Number(
		(
			await database.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM users WHERE organization_id=$1
				 AND ($2::text IS NULL OR email ILIKE $2 OR display_name ILIKE $2)`,
				[organizationId, search],
			)
		).rows[0]?.count ?? 0,
	);
	const users = (
		await database.query<Record<string, unknown>>(
			`SELECT id,email,display_name,role,is_super_admin,all_projects,disabled_at,created_at,updated_at
			 FROM users WHERE organization_id=$1 AND ($2::text IS NULL OR email ILIKE $2 OR display_name ILIKE $2)
			 ORDER BY created_at LIMIT $3 OFFSET $4`,
			[organizationId, search, input.pageSize, input.offset],
		)
	).rows;
	for (const user of users) {
		const access = await resolveEffectiveAccess(
			database,
			String(user.id),
			organizationId,
			Boolean(user.is_super_admin),
		);
		user.roles = access.roles;
		user.permission_keys = access.permissions;
		user.project_ids = access.projectIds;
	}
	return paginated(users, total, input);
}

export async function listAuditLogs(
	database: Database,
	organizationId: string,
	input: PaginationInput,
): Promise<Paginated<Record<string, unknown>>> {
	const search = input.search ? `%${input.search}%` : null;
	const total = Number(
		(
			await database.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
				 WHERE a.organization_id=$1 AND ($2::text IS NULL OR a.action ILIKE $2 OR u.email ILIKE $2)`,
				[organizationId, search],
			)
		).rows[0]?.count ?? 0,
	);
	const rows = (
		await database.query<Record<string, unknown>>(
			`SELECT a.id,a.action,a.target_type,a.target_id,a.metadata,a.created_at,u.email AS actor_email
			 FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
			 WHERE a.organization_id=$1 AND ($2::text IS NULL OR a.action ILIKE $2 OR u.email ILIKE $2)
			 ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`,
			[organizationId, search, input.pageSize, input.offset],
		)
	).rows;
	return paginated(rows, total, input);
}

export async function createUser(
	database: Database,
	input: unknown,
	organizationId = "default",
): Promise<{ id: string }> {
	const data = z
		.object({
			email: z.email(),
			displayName: z.string().trim().min(1),
			role: z.enum(["admin", "analyst", "viewer"]).default("viewer"),
			roleIds: z.array(z.string().trim().min(1)).max(50).optional(),
			allProjects: z.boolean().default(true),
			projectIds: z.array(z.string().trim().min(1)).max(10_000).default([]),
			password: z.string().min(12),
		})
		.parse(input);
	const id = randomUUID();
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: User creation atomically validates and writes role plus project scope assignments.
	await database.transaction(async (transaction) => {
		await transaction.query(
			`INSERT INTO users (id,organization_id,email,display_name,role,password_hash,all_projects)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			[
				id,
				organizationId,
				data.email.toLowerCase(),
				data.displayName,
				data.role,
				passwordHash(data.password),
				data.allProjects,
			],
		);
		const roleIds = data.roleIds?.length
			? [...new Set(data.roleIds)]
			: (
					await transaction.query<{ id: string }>("SELECT id FROM roles WHERE organization_id=$1 AND name=$2 LIMIT 1", [
						organizationId,
						data.role === "admin" ? "机构管理员" : data.role === "analyst" ? "业务分析师" : "只读成员",
					])
				).rows.map((row) => row.id);
		if (roleIds.length) {
			const placeholders = roleIds.map((_, index) => `$${index + 2}`).join(",");
			const validRoles = await transaction.query<{ id: string }>(
				`SELECT id FROM roles WHERE organization_id=$1 AND id IN (${placeholders})`,
				[organizationId, ...roleIds],
			);
			if (validRoles.rows.length !== roleIds.length) throw new Error("包含其他机构或不存在的角色");
			for (const roleId of roleIds)
				await transaction.query("INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)", [id, roleId]);
		}
		if (!data.allProjects && data.projectIds.length) {
			const projectIds = [...new Set(data.projectIds)];
			const placeholders = projectIds.map((_, index) => `$${index + 2}`).join(",");
			const validProjects = await transaction.query<{ id: string }>(
				`SELECT id FROM projects WHERE organization_id=$1 AND id IN (${placeholders})`,
				[organizationId, ...projectIds],
			);
			if (validProjects.rows.length !== projectIds.length) throw new Error("包含其他机构或不存在的客户");
			for (const projectId of projectIds)
				await transaction.query("INSERT INTO user_project_access (user_id,project_id) VALUES ($1,$2)", [id, projectId]);
		}
	});
	return { id };
}

export async function disableUser(
	database: Database,
	userId: string,
	actorId: string | null,
	organizationId = "default",
): Promise<void> {
	if (actorId === userId) throw new Error("不能停用当前登录管理员");
	const result = await database.query(
		"UPDATE users SET disabled_at=COALESCE(disabled_at,now()),updated_at=now() WHERE id=$1 AND organization_id=$2 AND is_super_admin=false",
		[userId, organizationId],
	);
	if (result.affectedRows !== 1) throw new Error("用户不存在");
	await database.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1", [userId]);
}

export async function auditRequest(
	database: Database,
	identity: Identity,
	method: string,
	path: string,
): Promise<void> {
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
	await database.query(
		`INSERT INTO audit_logs (id,organization_id,actor_user_id,action,target_type,target_id,metadata)
		 VALUES ($1,$2,$3,$4,'http_route',NULL,$5::jsonb)`,
		[randomUUID(), identity.organizationId, identity.id, `${method.toLowerCase()}.request`, JSON.stringify({ path })],
	);
}
