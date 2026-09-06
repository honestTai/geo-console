import type { IncomingMessage, ServerResponse } from "node:http";
import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { authenticateRequest, createUser, disableUser, ensureBootstrapAdmin, listUsers, login } from "./auth";

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
				setHeader: (_name: string, value: string | string[]) => {
					const session = (Array.isArray(value) ? value : [value]).find((item) => item.startsWith("geo_session="));
					cookie = session?.split(";")[0] ?? "";
				},
			} as unknown as ServerResponse;
			const loginResult = await login(database, response, {
				email: "admin@example.com",
				password: "a-strong-admin-password",
			});
			const identity = await authenticateRequest(database, { headers: { cookie } } as IncomingMessage);
			const admin = loginResult.user;
			expect(identity?.email).toBe(admin.email);
			expect(identity?.isSuperAdmin).toBe(true);
			expect(identity?.organizationId).toBe("default");
			expect(identity?.permissions).toContain("organization.manage");
			const analyst = await createUser(
				database,
				{
					email: "analyst@example.com",
					displayName: "分析师",
					role: "analyst",
					password: "a-strong-analyst-password",
				},
				"default",
				admin,
			);
			expect(
				(await listUsers(database, "default", { page: 1, pageSize: 20, offset: 0, search: null })).items,
			).toHaveLength(2);
			await disableUser(database, analyst.id, admin.id);
			expect(
				(await listUsers(database, "default", { page: 1, pageSize: 20, offset: 0, search: null })).items.find(
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
