import { hasRequirements } from "@geo/authorization";
import { legacyRolePermissionPresets, migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { findHttpPolicy } from "./authorization/policies";
import { getDynamicNavigation } from "./rbac";
import { createProject, listProjects } from "./service";

describe("organization customer management", () => {
	it("registers read-only navigation without granting writes or detailed evidence access", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			await migrateDatabase(db);
			const menu = await getDynamicNavigation(db, ["page.customers"], false, false);
			expect(menu.items).toEqual([
				expect.objectContaining({ navigation_key: "customers", label: "客户管理", group_label: "机构管理" }),
			]);
			const list = await findHttpPolicy(db, "GET", "/api/projects");
			expect(list && hasRequirements(["page.customers"], list.policy)).toBe(true);
			for (const [method, path] of [
				["POST", "/api/projects"],
				["PUT", "/api/projects/p"],
				["GET", "/api/projects/p"],
				["POST", "/api/projects/p/batches"],
			]) {
				const policy = await findHttpPolicy(db, method, path);
				expect(policy && hasRequirements(["page.customers"], policy.policy)).toBe(false);
			}
			expect(legacyRolePermissionPresets.viewer).toContain("page.customers");
			expect(legacyRolePermissionPresets.viewer).not.toContain("project.create");
			expect(legacyRolePermissionPresets.viewer).not.toContain("project.onboard");
			const missing = (
				await db.query(
					"SELECT 1 FROM role_permissions r WHERE r.permission_key='page.overview' AND NOT EXISTS(SELECT 1 FROM role_permissions c WHERE c.role_id=r.role_id AND c.permission_key='page.customers')",
				)
			).rows;
			expect(missing).toHaveLength(0);
		} finally {
			await db.close();
		}
	}, 20000);
	it("lists only the current organization and member scope, including optional website and edit fields", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			await db.query("INSERT INTO organizations(id,name) VALUES('other','测试其他机构')");
			const input = {
				name: "测试客户甲",
				region: "测试地区",
				language: "zh-CN",
				industry: "测试行业",
				businessFocus: "测试业务资料",
			};
			const first = await createProject(db, input);
			const second = await createProject(db, { ...input, name: "测试客户乙", websiteUrl: "https://example.com" });
			const foreign = await createProject(db, { ...input, name: "其他机构客户" }, "other");
			const page = { page: 1, pageSize: 20, offset: 0, search: null };
			const limited = await listProjects(db, "default", page, {
				allProjects: false,
				projectIds: [first.id, foreign.id],
			});
			expect(limited.total).toBe(1);
			expect(limited.items).toEqual([
				expect.objectContaining({
					id: first.id,
					website_url: null,
					business_focus: input.businessFocus,
					batch_count: 0,
				}),
			]);
			const search = await listProjects(
				db,
				"default",
				{ ...page, search: "example.com" },
				{ allProjects: true, projectIds: [] },
			);
			expect(search.items.map((row) => row.id)).toEqual([second.id]);
			expect((await listProjects(db, "default", page, { allProjects: false, projectIds: [] })).total).toBe(0);
			expect(
				await listProjects(db, "default", { ...page, pageSize: 1 }, { allProjects: true, projectIds: [] }),
			).toMatchObject({ total: 2, totalPages: 2 });
		} finally {
			await db.close();
		}
	}, 20000);
});
