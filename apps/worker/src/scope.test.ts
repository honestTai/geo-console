import { type FrozenBatchConfig, migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { frozenProviderContract } from "./cloud-runner";
import { ensureProviderConfigs } from "./providers";
import { confirmProject, createBatch, getProject } from "./service";

describe("监测范围版本", () => {
	it("保留旧批次范围并允许同一竞品在新版本继续使用", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await ensureProviderConfigs(database);
			await database.query("UPDATE provider_configs SET enabled=true WHERE provider_id='kimi_api'");
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,aliases,status)
				 VALUES ('project','客户','https://brand.cn','brand.cn','成都','zh-CN','["客户"]'::jsonb,'active')`,
			);
			await database.query(
				`INSERT INTO competitors (id,project_id,name,domain,aliases,approved)
				 VALUES ('competitor-v1','project','竞品','competitor.cn','["竞品"]'::jsonb,true)`,
			);
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
				 VALUES ('prompt-v1','project','旧问题是什么？','购买','[]'::jsonb,true,0)`,
			);

			const batch = await createBatch(database, "project", {
				kind: "baseline",
				platforms: ["kimi_api"],
				repeats: 1,
			});
			await database.query(
				"UPDATE provider_configs SET model='changed-after-freeze',endpoint='https://changed.invalid' WHERE provider_id='kimi_api'",
			);
			await confirmProject(database, "project", {
				aliases: ["客户", "客户品牌"],
				competitors: [{ name: "竞品", domain: "competitor.cn", aliases: ["竞品品牌"] }],
				prompts: [{ question: "新问题是什么？", intent: "比较", tags: ["高意向"] }],
			});
			// Re-saving the same active domain proves uniqueness applies only to the current version.
			await confirmProject(database, "project", {
				aliases: ["客户", "客户品牌"],
				competitors: [{ name: "竞品", domain: "competitor.cn", aliases: ["竞品品牌"] }],
				prompts: [{ question: "最终问题是什么？", intent: "比较", tags: ["高意向"] }],
			});

			const savedBatch = (
				await database.query<{ config: FrozenBatchConfig }>("SELECT config FROM experiment_batches WHERE id=$1", [
					batch.id,
				])
			).rows[0];
			expect(savedBatch.config.prompts).toEqual([
				{ id: "prompt-v1", question: "旧问题是什么？", intent: "购买", topic: null, persona: null, tags: [] },
			]);
			expect(frozenProviderContract(savedBatch.config, "kimi_api")).toMatchObject({
				endpoint: "https://api.moonshot.ai/v1",
				model: "kimi-k3",
				adapterVersion: "cloud-search.v1",
			});

			const current = await getProject(database, "project");
			expect(current).not.toBeNull();
			const currentPrompts = current?.prompts as Array<{ question: string }>;
			expect(currentPrompts).toHaveLength(1);
			expect(currentPrompts[0].question).toBe("最终问题是什么？");
			expect(current?.competitors).toHaveLength(1);

			const versions = await database.query<{ active: number; total: number }>(
				`SELECT count(*) FILTER (WHERE archived_at IS NULL)::int AS active, count(*)::int AS total
				 FROM competitors WHERE project_id='project' AND domain='competitor.cn'`,
			);
			expect(versions.rows[0]).toMatchObject({ active: 1, total: 3 });
		} finally {
			await database.close();
		}
	});
});
