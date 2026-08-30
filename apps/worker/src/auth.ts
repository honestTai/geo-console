import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Database, type OrganizationRole, readSecret } from "@geo/core";
import { z } from "zod";

export type Identity = {
	id: string | null;
	email: string;
	displayName: string;
	role: OrganizationRole;
	localBypass: boolean;
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

export async function ensureBootstrapAdmin(database: Database): Promise<void> {
	const count =
		(await database.query<{ count: number }>("SELECT count(*)::int AS count FROM users")).rows[0]?.count ?? 0;
	if (count > 0) return;
	const password = await readSecret("admin_password");
	if (!password) {
		if (process.env.NODE_ENV === "production")
			throw new Error("生产环境必须通过 GEO_ADMIN_PASSWORD 或 GEO_ADMIN_PASSWORD_FILE 初始化管理员");
		return;
	}
	if (password.length < 12) throw new Error("GEO_ADMIN_PASSWORD 至少需要 12 位");
	await database.query(
		`INSERT INTO users (id,organization_id,email,display_name,role,password_hash)
		 VALUES ($1,'default',$2,'系统管理员','admin',$3)`,
		[randomUUID(), process.env.GEO_ADMIN_EMAIL?.trim().toLowerCase() || "admin@geo.local", passwordHash(password)],
	);
}

export async function authenticateRequest(database: Database, request: IncomingMessage): Promise<Identity | null> {
	const userCount =
		(await database.query<{ count: number }>("SELECT count(*)::int AS count FROM users")).rows[0]?.count ?? 0;
	if (userCount === 0 && process.env.NODE_ENV !== "production") {
		return { id: null, email: "local@geo.local", displayName: "本机管理员", role: "admin", localBypass: true };
	}
	const token = cookieValue(request, "geo_session");
	if (!token) return null;
	const row = (
		await database.query<Record<string, unknown>>(
			`SELECT u.id,u.email,u.display_name,u.role FROM sessions s JOIN users u ON u.id=s.user_id
			 WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.disabled_at IS NULL`,
			[hashToken(token)],
		)
	).rows[0];
	return row
		? {
				id: String(row.id),
				email: String(row.email),
				displayName: String(row.display_name),
				role: String(row.role) as OrganizationRole,
				localBypass: false,
			}
		: null;
}

export async function login(database: Database, response: ServerResponse, input: unknown): Promise<Identity> {
	const data = z.object({ email: z.email(), password: z.string().min(1) }).parse(input);
	const row = (
		await database.query<Record<string, unknown>>(
			"SELECT id,email,display_name,role,password_hash FROM users WHERE organization_id='default' AND lower(email)=lower($1) AND disabled_at IS NULL",
			[data.email],
		)
	).rows[0];
	if (!row || !verifyPassword(data.password, String(row.password_hash)))
		throw new AuthenticationError("邮箱或密码错误");
	const token = randomBytes(32).toString("base64url");
	const expiresAt = new Date(Date.now() + 7 * 86_400_000);
	await database.query("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)", [
		randomUUID(),
		row.id,
		hashToken(token),
		expiresAt.toISOString(),
	]);
	response.setHeader(
		"set-cookie",
		`geo_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 86_400}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
	);
	return {
		id: String(row.id),
		email: String(row.email),
		displayName: String(row.display_name),
		role: String(row.role) as OrganizationRole,
		localBypass: false,
	};
}

export async function logout(database: Database, request: IncomingMessage, response: ServerResponse): Promise<void> {
	const token = cookieValue(request, "geo_session");
	if (token)
		await database.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1", [
			hashToken(token),
		]);
	response.setHeader(
		"set-cookie",
		`geo_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
	);
}

export function hasRole(identity: Identity, required: OrganizationRole): boolean {
	const rank: Record<OrganizationRole, number> = { viewer: 1, analyst: 2, admin: 3 };
	return rank[identity.role] >= rank[required];
}

export async function listUsers(database: Database): Promise<unknown[]> {
	return (
		await database.query(
			"SELECT id,email,display_name,role,disabled_at,created_at,updated_at FROM users ORDER BY created_at",
		)
	).rows;
}

export async function listAuditLogs(database: Database): Promise<unknown[]> {
	return (
		await database.query(
			`SELECT a.id,a.action,a.target_type,a.target_id,a.metadata,a.created_at,u.email AS actor_email
			 FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
			 WHERE a.organization_id='default' ORDER BY a.created_at DESC LIMIT 200`,
		)
	).rows;
}

export async function createUser(database: Database, input: unknown): Promise<{ id: string }> {
	const data = z
		.object({
			email: z.email(),
			displayName: z.string().trim().min(1),
			role: z.enum(["admin", "analyst", "viewer"]),
			password: z.string().min(12),
		})
		.parse(input);
	const id = randomUUID();
	await database.query(
		`INSERT INTO users (id,organization_id,email,display_name,role,password_hash)
		 VALUES ($1,'default',$2,$3,$4,$5)`,
		[id, data.email.toLowerCase(), data.displayName, data.role, passwordHash(data.password)],
	);
	return { id };
}

export async function disableUser(database: Database, userId: string, actorId: string | null): Promise<void> {
	if (actorId === userId) throw new Error("不能停用当前登录管理员");
	const result = await database.query(
		"UPDATE users SET disabled_at=COALESCE(disabled_at,now()),updated_at=now() WHERE id=$1",
		[userId],
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
		 VALUES ($1,'default',$2,$3,'http_route',NULL,$4::jsonb)`,
		[randomUUID(), identity.id, `${method.toLowerCase()}.request`, JSON.stringify({ path })],
	);
}
