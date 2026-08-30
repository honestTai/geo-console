import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { areBatchConfigsComparable } from "./comparability";
import { migrateDatabase, openMemoryDatabase } from "./database";
import { claimCaptureJob, enqueueCaptureJob } from "./repository";
import type { CaptureJobPayload, FrozenBatchConfig } from "./schema";
import { readEncryptedCredential, writeEncryptedCredential } from "./secrets";

const config: FrozenBatchConfig = {
	project: { name: "真实客户", domain: "customer.example", region: "中国", language: "zh-CN", aliases: ["真实客户"] },
	competitors: [],
	prompts: [{ id: "prompt-1", question: "应该选择哪家服务商？", intent: "购买", tags: [] }],
	platforms: ["deepseek", "kimi"],
	repeats: 3,
	collectorVersion: "0.1.0",
};

describe("批次可比性", () => {
	it("只接受完全相同的冻结条件", () => {
		expect(areBatchConfigsComparable(config, structuredClone(config))).toBe(true);
		expect(areBatchConfigsComparable(config, { ...config, repeats: 2 })).toBe(false);
	});
});

describe("PGlite 数据契约", () => {
	it("在空库执行迁移并通过租约领取任务", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			const projectId = "project-1";
			await database.query(
				"INSERT INTO projects (id,name,website_url,domain,region,language,status) VALUES ($1,'客户','https://customer.example','customer.example','中国','zh-CN','active')",
				[projectId],
			);
			const payload: CaptureJobPayload = {
				projectId,
				batchId: "batch-1",
				promptId: "prompt-1",
				prompt: "推荐服务商",
				platform: "deepseek",
				attempt: 1,
				region: "中国",
				locale: "zh-CN",
				brands: [],
			};
			const jobId = await enqueueCaptureJob(database, payload);
			const claimed = await claimCaptureJob(database, "node-1", 60);
			expect(claimed?.id).toBe(jobId);
			expect(claimed?.payload.platform).toBe("deepseek");
			expect(await claimCaptureJob(database, "node-2", 60)).toBeNull();
		} finally {
			await database.close();
		}
	});

	it("使用机构主密钥加密供应商凭据", async () => {
		const database = openMemoryDatabase();
		const previous = process.env.GEO_MASTER_KEY;
		process.env.GEO_MASTER_KEY = randomBytes(32).toString("base64");
		try {
			await migrateDatabase(database);
			await writeEncryptedCredential(database, "hrouter_api_key", "真实密钥内容");
			expect(await readEncryptedCredential(database, "hrouter_api_key")).toBe("真实密钥内容");
			const row = (
				await database.query<{ ciphertext: string }>(
					"SELECT ciphertext FROM encrypted_credentials WHERE credential_key='hrouter_api_key'",
				)
			).rows[0];
			expect(row.ciphertext).not.toContain("真实密钥内容");
		} finally {
			if (previous === undefined) delete process.env.GEO_MASTER_KEY;
			else process.env.GEO_MASTER_KEY = previous;
			await database.close();
		}
	});
});
