import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { getProject, publishedUrlBelongsToProject, taskVerificationMode, updateTask, verifyTask } from "./service";

describe("整改任务验收", () => {
	it("验收方式由诊断类别或验收标准决定", () => {
		expect(taskVerificationMode({ finding_category: "官网技术基础", acceptance_criteria: "任意" })).toBe("audit");
		expect(taskVerificationMode({ finding_category: null, acceptance_criteria: "修复后重新运行官网审计" })).toBe(
			"audit",
		);
		expect(
			taskVerificationMode({ finding_category: "内容覆盖差距", acceptance_criteria: "发布真实页面并抓取快照验收" }),
		).toBe("publish");
		expect(taskVerificationMode({})).toBe("publish");
	});

	it("发布地址必须在客户官网域名或其子域名下", () => {
		expect(publishedUrlBelongsToProject("https://www.brand.cn/news/1", "brand.cn")).toBe(true);
		expect(publishedUrlBelongsToProject("https://blog.brand.cn/post", "https://www.brand.cn")).toBe(true);
		expect(publishedUrlBelongsToProject("https://zhuanlan.zhihu.com/p/1", "brand.cn")).toBe(false);
		expect(publishedUrlBelongsToProject("https://notbrand.cn/", "brand.cn")).toBe(false);
		expect(publishedUrlBelongsToProject("not a url", "brand.cn")).toBe(false);
	});

	it("已验收不能手工选择；第三方发布地址在抓取前就被拒绝；技术类任务暴露审计验收模式", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,aliases,status)
				 VALUES ('project','客户','https://brand.cn','brand.cn','成都','zh-CN','["客户"]'::jsonb,'active')`,
			);
			await database.query(
				`INSERT INTO experiment_batches (id,project_id,kind,status,config,config_hash)
				 VALUES ('batch','project','quick_audit','complete','{}'::jsonb,'hash')`,
			);
			await database.query(
				`INSERT INTO diagnosis_findings (id,project_id,batch_id,category,title,detail,confidence,evidence_ids,recommendation)
				 VALUES ('tech','project','batch','官网技术基础','HTTPS 不可用','说明',0.9,'[]'::jsonb,'修复')`,
			);
			await database.query(
				`INSERT INTO remediation_tasks (id,project_id,finding_id,title,detail,priority,status,expected_metric,acceptance_criteria,published_url)
				 VALUES ('publish-task','project',NULL,'发布案例页','说明','high','todo','引用率','发布真实页面并抓取快照验收','https://zhuanlan.zhihu.com/p/1'),
				        ('audit-task','project','tech','修复 HTTPS','说明','high','todo','审计通过','修复后重新运行官网审计',NULL)`,
			);
			await expect(updateTask(database, "publish-task", { status: "verified" })).rejects.toThrow("已验收");
			await expect(verifyTask(database, "publish-task")).rejects.toThrow("客户官网域名 brand.cn");
			const project = (await getProject(database, "project")) as {
				tasks: Array<{ id: string; verification_mode: string; status: string }>;
			};
			expect(project.tasks.find((task) => task.id === "audit-task")?.verification_mode).toBe("audit");
			expect(project.tasks.find((task) => task.id === "publish-task")).toMatchObject({
				verification_mode: "publish",
				status: "todo",
			});
		} finally {
			await database.close();
		}
	});
});
