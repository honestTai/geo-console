import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { readAgentMeasurementContext } from "./agent-measurement-context";
import { seedMetricSnapshot } from "./test-support/measurement";

describe("Agent receives the same explainable measurement as the report", () => {
	it("binds explanations and questions to the run snapshot, not edited customer data or the latest parse", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			await db.query(
				"INSERT INTO projects(id,name,region,language) VALUES ('p','当前客户名称','地区','zh-CN'),('other','其他客户','地区','zh-CN')",
			);
			await db.query(
				"INSERT INTO prompts(id,project_id,question,intent,position) VALUES ('prompt','p','后来改过的问题','采购',0)",
			);
			const config = {
				project: { name: "检测时客户名称", domain: "example.com", region: "冻结地区", language: "zh-CN", aliases: [] },
				prompts: [{ id: "prompt", question: "检测时客户名称提供哪些服务？", intent: "了解", tags: [] }],
				competitors: [],
				platforms: ["qwen_api"],
				repeats: 1,
			};
			await db.query(
				"INSERT INTO experiment_batches(id,project_id,kind,status,config,config_hash) VALUES ('b','p','quick_audit','complete',$1,'hash')",
				[JSON.stringify(config)],
			);
			await db.query(
				"INSERT INTO agent_runs(id,project_id,batch_id,purpose,status,model,prompt_version) VALUES ('run','p','b','report_narrative','queued','test','test')",
			);
			const original = await seedMetricSnapshot(db, "b");
			const newer = await seedMetricSnapshot(db, "b");
			await db.query("UPDATE agent_runs SET metric_snapshot_id=$1 WHERE id='run'", [original]);
			const context = await readAgentMeasurementContext(db, "p", "b", "run");
			expect(context.metricSnapshot?.id).toBe(original);
			expect(context.metricSnapshot?.id).not.toBe(newer);
			expect(context.frozenBatchConfig?.project.name).toBe("检测时客户名称");
			expect(context.frozenBatchConfig?.prompts[0].question).toBe("检测时客户名称提供哪些服务？");
			expect(context.readerGuide?.segments.find((s) => s.named)?.plannedQuestions).toBe(1);
			expect(context.readerGuide?.calculationRows).toEqual([]); // No semantic rows: do not invent a calculated score.
			expect(context.readerGuide?.counts).toMatchObject({ planned: 1, answered: 0, parsed: 0 });
			expect((await readAgentMeasurementContext(db, "other", "b", "run")).readerGuide).toBeNull();
			expect((await readAgentMeasurementContext(db, "p", "b", null)).metricSnapshot).toBeNull();
		} finally {
			await db.close();
		}
	}, 20000);
});
