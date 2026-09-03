import { randomBytes } from "node:crypto";
import { migrateDatabase, openMemoryDatabase, writeEncryptedCredential } from "@geo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportKnowledge, exportSettings, importKnowledge, importSettings } from "./config-transfer";
import { getHRouterConfig } from "./hrouter";
import { createLibraryQuestion, listLibraryQuestions } from "./knowledge-base";
import { ensureProviderConfigs, getProviderSettings, saveProviderConfig } from "./providers";

const previousMasterKey = process.env.GEO_MASTER_KEY;
beforeAll(() => {
	process.env.GEO_MASTER_KEY = randomBytes(32).toString("base64");
});
afterAll(() => {
	if (previousMasterKey === undefined) delete process.env.GEO_MASTER_KEY;
	else process.env.GEO_MASTER_KEY = previousMasterKey;
});

async function setupOrganizations() {
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await database.query("INSERT INTO organizations (id,name) VALUES ('target','目标机构')");
	await ensureProviderConfigs(database);
	return database;
}

describe("平台设置导入导出", () => {
	it("导出不含密钥；导入时没有密钥的平台按停用落库", async () => {
		const database = await setupOrganizations();
		try {
			await writeEncryptedCredential(database, "kimi_api_key", "source-kimi-key-1234567890", "default");
			await saveProviderConfig(
				database,
				"kimi_api",
				{
					enabled: true,
					model: "kimi-k3-custom",
					endpoint: "https://kimi.example.com/v1",
					options: { region: "cn" },
				},
				"default",
			);
			await writeEncryptedCredential(database, "hrouter_api_key", "source-hrouter-key-1234567890", "default");
			await database.query(
				`INSERT INTO settings (key,value) VALUES ('organization:default:hrouter_config',
				 '{"baseUrl":"https://hrouter.example.com/v1","model":"gpt-5.5","thinkingLevel":"high"}'::jsonb)`,
			);

			const bundle = await exportSettings(database, "default");
			expect(JSON.stringify(bundle)).not.toContain("source-kimi-key");
			expect(JSON.stringify(bundle)).not.toContain("source-hrouter-key");
			expect(bundle.hrouter).toEqual({ baseUrl: "https://hrouter.example.com/v1", model: "gpt-5.5", thinkingLevel: "high" });
			const kimi = bundle.providers.find((provider) => provider.providerId === "kimi_api");
			expect(kimi).toMatchObject({ enabled: true, model: "kimi-k3-custom", options: { region: "cn" } });

			const result = await importSettings(database, "target", bundle);
			expect(result.hrouter.applied).toBe(true);
			expect(result.hrouter.note).toContain("API Key");
			expect(result.providers.find((provider) => provider.providerId === "kimi_api")).toMatchObject({
				enabled: false,
				note: expect.stringContaining("缺少 API Key"),
			});
			const targetHRouter = await getHRouterConfig(database, "target");
			expect(targetHRouter).toMatchObject({ baseUrl: "https://hrouter.example.com/v1", model: "gpt-5.5", thinkingLevel: "high" });
			const targetProviders = (await getProviderSettings(database, "target")) as Array<Record<string, unknown>>;
			expect(targetProviders.find((provider) => provider.providerId === "kimi_api")).toMatchObject({
				enabled: false,
				model: "kimi-k3-custom",
				endpoint: "https://kimi.example.com/v1",
				configured: false,
			});

			// 目标机构补齐密钥后再导入同一份包，启用状态才会生效
			await writeEncryptedCredential(database, "kimi_api_key", "target-kimi-key-1234567890", "target");
			const second = await importSettings(database, "target", bundle);
			expect(second.providers.find((provider) => provider.providerId === "kimi_api")).toMatchObject({
				enabled: true,
				note: null,
			});
		} finally {
			await database.close();
		}
	});

	it("拒绝不是本系统导出的配置包", async () => {
		const database = await setupOrganizations();
		try {
			await expect(importSettings(database, "default", { kind: "something-else", version: 1 })).rejects.toThrow();
			await expect(
				importSettings(database, "default", {
					kind: "geo-settings",
					version: 1,
					hrouter: { baseUrl: "https://hrouter.net/v1", model: "claude-x", thinkingLevel: "low" },
				}),
			).rejects.toThrow("GPT");
		} finally {
			await database.close();
		}
	});
});

describe("问题知识库导入导出", () => {
	it("导出当前机构未归档问题，导入时跳过重复项", async () => {
		const database = await setupOrganizations();
		try {
			await createLibraryQuestion(database, "default", null, {
				industry: "数控机床",
				question: "成都哪家数控机床厂商交期最稳定？",
				intent: "供应商推荐",
				topic: "交期",
				persona: "采购经理",
				tags: ["本地", "交期"],
			});
			await createLibraryQuestion(database, "default", null, {
				industry: "数控机床",
				question: "五轴加工中心该怎么选型？",
				intent: "选型",
				tags: [],
			});
			await createLibraryQuestion(database, "target", null, {
				industry: "数控机床",
				question: "五轴加工中心该怎么选型？",
				intent: "选型",
				tags: ["已有"],
			});

			const bundle = await exportKnowledge(database, "default");
			expect(bundle.questions).toHaveLength(2);
			expect(bundle.questions[0]).toMatchObject({ industry: "数控机床", topic: "交期", tags: ["本地", "交期"] });

			const result = await importKnowledge(database, "target", null, bundle);
			expect(result).toEqual({ total: 2, imported: 1, skipped: 1 });
			const target = await listLibraryQuestions(database, "target");
			expect(target.total).toBe(2);
			expect(target.items.map((item) => item.question)).toContain("成都哪家数控机床厂商交期最稳定？");

			// 按行业过滤导出
			const filtered = await exportKnowledge(database, "default", "不存在的行业");
			expect(filtered.questions).toHaveLength(0);
		} finally {
			await database.close();
		}
	});
});
