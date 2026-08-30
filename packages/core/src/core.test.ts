import { describe, expect, it } from "vitest";
import { areBatchConfigsComparable } from "./comparability";
import { migrateDatabase, openMemoryDatabase } from "./database";
import { claimCaptureJob, enqueueCaptureJob } from "./repository";
import type { CaptureJobPayload, FrozenBatchConfig } from "./schema";

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
});
