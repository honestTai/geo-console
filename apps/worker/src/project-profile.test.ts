import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { projectProfileSchema, updateProjectProfile } from "./project-profile";
import { auditProject, createProject, ensureProjectSnapshots } from "./service";

describe("optional official website", () => {
	it("creates without website, does not crawl, supports adding/removing it without changing historical config", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			await migrateDatabase(db);
			const input = {
				name: "测试客户",
				region: "测试地区",
				language: "zh-CN",
				industry: "测试行业",
				businessFocus: "用户提供的业务资料",
			};
			const { id } = await createProject(db, input);
			expect((await db.query("SELECT website_url,domain FROM projects WHERE id=$1", [id])).rows[0]).toEqual({
				website_url: null,
				domain: null,
			});
			await expect(auditProject(db, id)).rejects.toThrow("暂未填写官网");
			expect(await ensureProjectSnapshots(db, id)).toBe(0);
			await db.query(
				"INSERT INTO experiment_batches(id,project_id,kind,config,config_hash) VALUES('frozen',$1,'baseline','{\"project\":{\"domain\":\"\"}}','original')",
				[id],
			);
			await updateProjectProfile(db, id, { ...input, websiteUrl: "https://www.example.com/about" });
			expect((await db.query("SELECT website_url,domain FROM projects WHERE id=$1", [id])).rows[0]).toEqual({
				website_url: "https://www.example.com/about",
				domain: "example.com",
			});
			await updateProjectProfile(db, id, { ...input, websiteUrl: "  " });
			expect((await db.query("SELECT website_url,domain FROM projects WHERE id=$1", [id])).rows[0]).toEqual({
				website_url: null,
				domain: null,
			});
			expect((await db.query("SELECT config_hash,config FROM experiment_batches WHERE id='frozen'")).rows[0]).toEqual({
				config_hash: "original",
				config: { project: { domain: "" } },
			});
			expect(
				(await db.query("SELECT all_of,scope FROM authorization_policies WHERE id='http:project:edit'")).rows[0],
			).toEqual({ all_of: ["project.onboard"], scope: "project" });
		} finally {
			await db.close();
		}
	}, 20_000);
	it("rejects unsafe schemes, credentials and hidden privilege fields", () => {
		const input = { name: "测试客户", region: "测试地区", language: "zh-CN" };
		for (const websiteUrl of ["file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.com"])
			expect(() => projectProfileSchema.parse({ ...input, websiteUrl })).toThrow();
		expect(() => projectProfileSchema.parse({ ...input, organizationId: "another-tenant" })).toThrow();
	});
});
