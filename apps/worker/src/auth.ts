import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { decideDelegation, type Principal } from "@geo/authorization";
import { type Database, type OrganizationRole, readSecret } from "@geo/core";
import { z } from "zod";
import { AccessDeniedError } from "./authorization";
import { loadActorPrincipal, loadPrincipal, loadPrincipals, type PrincipalRecord } from "./authorization/principal";
import { loginLimiter } from "./login-limiter";
import { assertAssignableMember, assertManageableMember, type MemberActor, memberAuthority } from "./member-access";
import { type Paginated, type PaginationInput, paginated } from "./pagination";
import { HttpInputError } from "./utils";

export type Identity = {
	principal: Principal;
	authorizationRevision: string;
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

const scryptAsync = promisify(scrypt);
async function passwordHash(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = (await scryptAsync(password, salt, 64)) as Buffer;
	return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	const [algorithm, saltValue, hashValue] = encoded.split("$");
	if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
	const expected = Buffer.from(hashValue, "base64");
	const actual = (await scryptAsync(password, Buffer.from(saltValue, "base64"), expected.length)) as Buffer;
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
			[existing.id, await passwordHash(password)],
		);
	else
		await database.query(
			`INSERT INTO users (id,organization_id,email,display_name,role,is_super_admin,password_hash)
			 VALUES ($1,'default',$2,'系统超管','admin',true,$3)`,
			[randomUUID(), email, await passwordHash(password)],
		);
}

function identityFromPrincipal(p: PrincipalRecord): Identity {
	return {
		id: p.userId,
		email: p.email,
		displayName: p.displayName,
		role: p.legacyRole as OrganizationRole,
		homeOrganizationId: p.homeOrganizationId,
		organizationId: p.organizationId,
		organizationName: p.organizationName,
		organizationSuspended: p.organizationSuspended,
		isSuperAdmin: p.systemAdmin,
		localBypass: false,
		roles: p.roles,
		permissions: p.permissions,
		allProjects: p.projects.all,
		projectIds: p.projects.ids,
		principal: p,
		authorizationRevision: p.revision,
	};
}
export async function authenticateRequest(database: Database, request: IncomingMessage): Promise<Identity | null> {
	const selected = cookieValue(request, "geo_organization") ?? undefined;
	const token = sessionToken(request);
	if (token) {
		const principal = await loadPrincipal(database, { tokenHash: hashToken(token), organizationId: selected });
		if (principal?.active && (!principal.organizationSuspended || principal.systemAdmin))
			return identityFromPrincipal(principal);
		return null;
	}
	if (process.env.NODE_ENV !== "production") {
		const orgId = selected ?? "default";
		const principal = await loadActorPrincipal(database, { kind: "local" }, orgId);
		if (principal) {
			const org = (await database.query<{ name: string }>("SELECT name FROM organizations WHERE id=$1", [orgId]))
				.rows[0];
			return {
				id: null,
				email: "local@geo",
				displayName: "本机开发",
				role: "admin",
				homeOrganizationId: orgId,
				organizationId: orgId,
				organizationName: org.name,
				organizationSuspended: principal.organizationSuspended,
				isSuperAdmin: true,
				localBypass: true,
				roles: principal.roles,
				permissions: principal.permissions,
				allProjects: true,
				projectIds: [],
				principal,
				authorizationRevision: principal.revision,
			};
		}
	}
	return null;
}

export async function login(
	database: Database,
	response: ServerResponse,
	input: unknown,
	address = "local",
): Promise<{ user: Identity; sessionToken: string }> {
	const data = z
		.object({
			email: z.string().trim().email(),
			password: z.string().min(1).max(1024),
			organizationId: z.string().trim().min(1).optional(),
		})
		.parse(input);
	loginLimiter.check(data.email, address);
	const rows = (
		await database.query<{ id: string; organization_id: string; password_hash: string; is_super_admin: boolean }>(
			`SELECT id,organization_id,password_hash,is_super_admin FROM users
  WHERE lower(email)=lower($1) AND disabled_at IS NULL AND ($2::text IS NULL OR organization_id=$2) ORDER BY is_super_admin DESC,created_at`,
			[data.email, data.organizationId ?? null],
		)
	).rows;
	if (rows.length > 1 && !data.organizationId && !rows[0]?.is_super_admin)
		throw new AuthenticationError("该邮箱属于多个机构，请同时填写机构 ID");
	const candidate = rows[0];
	if (!candidate || !(await verifyPassword(data.password, candidate.password_hash)))
		throw new AuthenticationError("邮箱或密码错误");
	const token = randomBytes(32).toString("base64url");
	const user = await database.transaction(async (tx) => {
		const org = (
			await tx.query<{ suspended_at: string | null }>("SELECT suspended_at FROM organizations WHERE id=$1 FOR SHARE", [
				candidate.organization_id,
			])
		).rows[0];
		const current = (
			await tx.query<{ id: string; password_hash: string; credential_version: number; is_super_admin: boolean }>(
				"SELECT id,password_hash,credential_version,is_super_admin FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE",
				[candidate.id],
			)
		).rows[0];
		if (!current || current.password_hash !== candidate.password_hash)
			throw new AuthenticationError("密码或账号状态已变化，请重新登录");
		if (!org || (org.suspended_at && !current.is_super_admin))
			throw new AuthenticationError("机构已被封禁，请联系系统超管");
		await tx.query("INSERT INTO sessions(id,user_id,token_hash,expires_at,credential_version) VALUES($1,$2,$3,$4,$5)", [
			randomUUID(),
			current.id,
			hashToken(token),
			new Date(Date.now() + 7 * 86400000).toISOString(),
			current.credential_version,
		]);
		const principal = await loadPrincipal(tx, { userId: current.id, tokenHash: hashToken(token) });
		if (!principal) throw new AuthenticationError("会话创建失败");
		return identityFromPrincipal(principal);
	});
	response.setHeader("set-cookie", [
		`geo_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 86400}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
		`geo_organization=${encodeURIComponent(user.organizationId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 86400}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
	]);
	return { user, sessionToken: token };
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
	if (!identity.isSuperAdmin) throw new AccessDeniedError("只有系统超管可以切换机构");
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
	if (identity.localBypass) {
		const principal = await loadActorPrincipal(database, { kind: "local" }, organizationId);
		if (!principal) throw new AuthenticationError("本机开发身份已失效");
		return {
			...identity,
			organizationId,
			homeOrganizationId: organizationId,
			organizationName: organization.name,
			organizationSuspended: principal.organizationSuspended,
			principal,
			authorizationRevision: principal.revision,
		};
	}
	const principal = identity.id ? await loadPrincipal(database, { userId: identity.id, organizationId }) : null;
	if (!principal) throw new AuthenticationError("机构切换身份已失效");
	return identityFromPrincipal(principal);
}

export async function listUsers(
	database: Database,
	organizationId: string,
	input: PaginationInput,
	actor?: MemberActor,
): Promise<Paginated<Record<string, unknown>>> {
	let authority: Awaited<ReturnType<typeof memberAuthority>> | null = null;
	if (actor)
		try {
			authority = await memberAuthority(database, organizationId, actor);
		} catch (error) {
			if (!(error instanceof AccessDeniedError)) throw error;
		}
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
	const principals = new Map(
		(
			await loadPrincipals(
				database,
				users.map((user) => String(user.id)),
				organizationId,
			)
		).map((principal) => [principal.userId, principal]),
	);
	for (const user of users) {
		const target = principals.get(String(user.id));
		user.roles = target?.roles ?? [];
		user.permission_keys = target?.permissions ?? [];
		user.project_ids = target?.projects.ids ?? [];
		user.all_projects = target?.projects.all ?? false;
		user.can_manage = Boolean(authority && target && decideDelegation(authority, target) === "allowed");
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

const memberInputSchema = z.object({
	email: z.string().trim().email(),
	displayName: z.string().trim().min(1).max(160),
	role: z.enum(["admin", "analyst", "viewer"]).default("viewer"),
	roleIds: z.array(z.string().trim().min(1)).max(50).optional(),
	allProjects: z.boolean().default(false),
	projectIds: z.array(z.string().trim().min(1)).max(10_000).default([]),
	password: z.string().min(12).max(1024),
});

async function memberAudit(
	database: Database,
	organizationId: string,
	actorId: string | null,
	action: string,
	userId: string,
	metadata: Record<string, unknown> = {},
) {
	await database.query(
		`INSERT INTO audit_logs(id,organization_id,actor_user_id,action,target_type,target_id,metadata)
  VALUES($1,$2,$3,$4,'user',$5,$6::jsonb)`,
		[randomUUID(), organizationId, actorId, action, userId, JSON.stringify(metadata)],
	);
}

async function requestedMemberRoles(
	database: Database,
	organizationId: string,
	data: z.infer<typeof memberInputSchema>,
): Promise<string[]> {
	if (data.roleIds !== undefined) return [...new Set(data.roleIds)];
	const rows = (
		await database.query<{ id: string }>("SELECT id FROM roles WHERE organization_id=$1 AND system_key=$2", [
			organizationId,
			data.role,
		])
	).rows;
	if (!rows.length) throw new HttpInputError("默认角色不存在，请明确选择一个机构角色", 409);
	return rows.map((row) => row.id);
}

async function assertNewMemberEmail(database: Database, organizationId: string, email: string): Promise<void> {
	const existing = (
		await database.query<{ disabled_at: string | null }>(
			"SELECT disabled_at FROM users WHERE organization_id=$1 AND lower(email)=lower($2)",
			[organizationId, email],
		)
	).rows[0];
	if (existing)
		throw new HttpInputError(
			existing.disabled_at
				? "该邮箱已有停用账号，请在成员列表中恢复，不要重复创建"
				: "该邮箱已是本机构成员，请使用其他邮箱或调整已有成员授权",
			409,
		);
}

export async function createUser(
	database: Database,
	input: unknown,
	organizationId = "default",
	actor?: MemberActor,
): Promise<{ id: string }> {
	const data = memberInputSchema.parse(input),
		id = randomUUID();
	const hash = await passwordHash(data.password);
	await database.transaction(async (tx) => {
		// Serialize case-insensitive checks without rewriting legacy emails or silently merging accounts.
		const org = await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [organizationId]);
		if (!org.rows.length) throw new HttpInputError("机构不存在", 404);
		if (!actor) throw new AccessDeniedError("创建成员必须明确提供已认证操作者");
		const authority = await memberAuthority(tx, organizationId, actor);
		await assertNewMemberEmail(tx, organizationId, data.email);
		const roleIds = await requestedMemberRoles(tx, organizationId, data);
		await assertAssignableMember(
			tx,
			organizationId,
			{ roleIds, allProjects: data.allProjects, projectIds: data.projectIds },
			authority,
		);
		await tx.query(
			`INSERT INTO users(id,organization_id,email,display_name,role,password_hash,all_projects) VALUES($1,$2,$3,$4,$5,$6,$7)`,
			[id, organizationId, data.email.toLowerCase(), data.displayName, data.role, hash, data.allProjects],
		);
		for (const roleId of roleIds) await tx.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)", [id, roleId]);
		if (!data.allProjects)
			for (const projectId of [...new Set(data.projectIds)])
				await tx.query("INSERT INTO user_project_access(user_id,project_id) VALUES($1,$2)", [id, projectId]);
		if (actor)
			await memberAudit(tx, organizationId, actor.id, "member.created", id, {
				roleIds,
				allProjects: data.allProjects,
				projectIds: data.allProjects ? [] : data.projectIds,
			});
	});
	return { id };
}

export async function disableUser(
	database: Database,
	userId: string,
	actorId: string | null,
	organizationId = "default",
	actor?: MemberActor,
): Promise<void> {
	if (actorId === userId) throw new HttpInputError("不能停用当前登录管理员", 403);
	await database.transaction(async (tx) => {
		await assertManageableMember(tx, organizationId, userId, actor ?? { id: actorId, isSuperAdmin: false });
		await tx.query(
			"UPDATE users SET disabled_at=COALESCE(disabled_at,now()),updated_at=now() WHERE id=$1 AND organization_id=$2",
			[userId, organizationId],
		);
		await tx.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1", [userId]);
		if (actor) await memberAudit(tx, organizationId, actor.id, "member.disabled", userId);
	});
}

export async function restoreUser(
	database: Database,
	organizationId: string,
	userId: string,
	actor: MemberActor,
): Promise<void> {
	await database.transaction(async (tx) => {
		await assertManageableMember(tx, organizationId, userId, actor);
		await tx.query("UPDATE users SET disabled_at=NULL,updated_at=now() WHERE id=$1 AND organization_id=$2", [
			userId,
			organizationId,
		]);
		// Restoring an account never revives a previously revoked token.
		await tx.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1", [userId]);
		await memberAudit(tx, organizationId, actor.id, "member.restored", userId);
	});
}

export async function resetMemberPassword(
	database: Database,
	organizationId: string,
	userId: string,
	input: unknown,
	actor: MemberActor,
): Promise<void> {
	const data = z.object({ password: z.string().min(12).max(1024) }).parse(input),
		hash = await passwordHash(data.password);
	await database.transaction(async (tx) => {
		await assertManageableMember(tx, organizationId, userId, actor);
		await tx.query("UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1", [userId, hash]);
		await tx.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1", [userId]);
		await memberAudit(tx, organizationId, actor.id, "member.password_reset", userId);
	});
}

export async function changeOwnPassword(
	database: Database,
	request: IncomingMessage,
	identity: Identity,
	input: unknown,
): Promise<void> {
	if (!identity.id) throw new HttpInputError("免登录模式不能修改密码", 400);
	const userId = identity.id;
	loginLimiter.check(`password-change:${userId}`, `authenticated:${userId}`);
	const data = z
		.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(12).max(1024) })
		.parse(input);
	const nextHash = await passwordHash(data.newPassword),
		token = sessionToken(request);
	await database.transaction(async (tx) => {
		const row = (
			await tx.query<{ password_hash: string }>(
				"SELECT password_hash FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE",
				[identity.id],
			)
		).rows[0];
		if (!token || !(await loadPrincipal(tx, { userId, tokenHash: hashToken(token) })))
			throw new AuthenticationError("当前会话已失效，请重新登录");
		if (!row || !(await verifyPassword(data.currentPassword, row.password_hash)))
			throw new HttpInputError("当前密码不正确", 400);
		await tx.query("UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1", [identity.id, nextHash]);
		await tx.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 AND token_hash<>$2", [
			identity.id,
			token ? hashToken(token) : "",
		]);
		await tx.query(
			"UPDATE sessions SET credential_version=(SELECT credential_version FROM users WHERE id=$1) WHERE user_id=$1 AND token_hash=$2 AND revoked_at IS NULL",
			[userId, token ? hashToken(token) : ""],
		);
		await memberAudit(tx, identity.homeOrganizationId, userId, "member.password_changed", userId);
	});
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
