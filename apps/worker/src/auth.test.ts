import type { IncomingMessage, ServerResponse } from "node:http";
import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { authenticateRequest, createUser, disableUser, ensureBootstrapAdmin, hasRole, listUsers, login } from "./auth";

describe("机构身份与角色", () => {
	it("初始化管理员、创建成员并撤销成员会话", async () => {
		const database = openMemoryDatabase();
		const previousPassword = process.env.GEO_ADMIN_PASSWORD;
		const previousEmail = process.env.GEO_ADMIN_EMAIL;
		process.env.GEO_ADMIN_PASSWORD = "a-strong-admin-password";
		process.env.GEO_ADMIN_EMAIL = "admin@example.com";
		try {
			await migrateDatabase(database);
			await ensureBootstrapAdmin(database);
			let cookie = "";
			const response = {
				setHeader: (_name: string, value: string) => {
					cookie = value.split(";")[0] ?? "";
				},
			} as unknown as ServerResponse;
			const admin = await login(database, response, {
				email: "admin@example.com",
				password: "a-strong-admin-password",
			});
			const identity = await authenticateRequest(database, { headers: { cookie } } as IncomingMessage);
			expect(identity?.email).toBe(admin.email);
			expect(identity && hasRole(identity, "admin")).toBe(true);
			const analyst = await createUser(database, {
				email: "analyst@example.com",
				displayName: "分析师",
				role: "analyst",
				password: "a-strong-analyst-password",
			});
			expect(await listUsers(database)).toHaveLength(2);
			await disableUser(database, analyst.id, admin.id);
			expect(
				((await listUsers(database)) as Array<{ id: string; disabled_at: string | null }>).find(
					(user) => user.id === analyst.id,
				)?.disabled_at,
			).not.toBeNull();
		} finally {
			if (previousPassword === undefined) delete process.env.GEO_ADMIN_PASSWORD;
			else process.env.GEO_ADMIN_PASSWORD = previousPassword;
			if (previousEmail === undefined) delete process.env.GEO_ADMIN_EMAIL;
			else process.env.GEO_ADMIN_EMAIL = previousEmail;
			await database.close();
		}
	});
});
