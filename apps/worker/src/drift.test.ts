import { type Database, migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { refreshBatchStatus } from "./service";

const config = {
	project: { name: "客户", domain: "brand.cn", region: "成都", language: "zh-CN", aliases: ["客户"] },
	competitors: [],
	prompts: [{ id: "prompt", question: "问题？", intent: "购买", tags: [] }],
	platforms: ["kimi_api", "deepseek_api"],
	repeats: 1,
	runnerVersion: "cloud-runner.v1",
	samplingMode: "formal",
	executionWindows: ["PT0M"],
	providers: [],
};

async function insertCapture(
	database: Database,
	input: {
		id: string;
		batchId: string;
		platform: string;
		status: "complete" | "auth_required";
		mentioned: boolean;
	},
) {
	await database.query(`INSERT INTO jobs (id,type,payload,status) VALUES ($1,'capture',$2::jsonb,'complete')`, [
		`job-${input.id}`,
		JSON.stringify({
			projectId: "project",
			batchId: input.batchId,
			promptId: "prompt",
			prompt: "问题？",
			platform: input.platform,
			attempt: 1,
			region: "成都",
			locale: "zh-CN",
			brands: [],
		}),
	]);
	await database.query(
		`INSERT INTO query_captures
		 (id,job_id,batch_id,project_id,prompt_id,platform,attempt,status,answer_text,brand_matches,sources,query_fan_out,
		 page_url,content_hash,adapter_version,failure_code,captured_at,schema_version,capture_mode,model,protocol,
		 search_tool_version,source_visibility,fanout_visibility,raw_artifact_key,latency_ms,executor_id)
		 VALUES ($1,$2,$3,'project','prompt',$4,1,$5,$6,$7::jsonb,'[]'::jsonb,'[]'::jsonb,'https://endpoint',$8,'cloud-search.v1',$9,
		 now(),'geo.query-capture.v2','llm_search_api','model','protocol','tool','unavailable','unavailable','raw',10,'worker')`,
		[
			input.id,
			`job-${input.id}`,
			input.batchId,
			input.platform,
			input.status,
			input.status === "complete" ? "回答正文" : null,
			JSON.stringify(input.mentioned ? [{ brandId: "project", matchedAlias: "客户", position: 1 }] : []),
			input.status === "complete" ? "a".repeat(64) : null,
			input.status === "complete" ? null : "authentication_failed",
		],
	);
}

describe("漂移告警", () => {
	it("没有成功回答的平台不产生告警；有回答且真正下降的平台照常告警", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,aliases,status)
				 VALUES ('project','客户','https://brand.cn','brand.cn','成都','zh-CN','["客户"]'::jsonb,'active')`,
			);
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
				 VALUES ('prompt','project','问题？','购买','[]'::jsonb,true,0)`,
			);
			await database.query(
				`INSERT INTO experiment_batches (id,project_id,kind,compare_to_batch_id,status,config,config_hash,started_at,completed_at)
				 VALUES ('baseline','project','baseline',NULL,'complete',$1::jsonb,'hash',now(),now()),
				        ('retest','project','retest','baseline','running',$1::jsonb,'hash',now(),NULL)`,
				[JSON.stringify(config)],
			);
			await insertCapture(database, {
				id: "b-kimi",
				batchId: "baseline",
				platform: "kimi_api",
				status: "complete",
				mentioned: true,
			});
			await insertCapture(database, {
				id: "b-deepseek",
				batchId: "baseline",
				platform: "deepseek_api",
				status: "complete",
				mentioned: true,
			});
			// 复测：Kimi 有回答但不再提及品牌（真实下降）；DeepSeek 鉴权失败，没有任何成功回答。
			await insertCapture(database, {
				id: "r-kimi",
				batchId: "retest",
				platform: "kimi_api",
				status: "complete",
				mentioned: false,
			});
			await insertCapture(database, {
				id: "r-deepseek",
				batchId: "retest",
				platform: "deepseek_api",
				status: "auth_required",
				mentioned: false,
			});

			await refreshBatchStatus(database, "retest");
			expect(
				(await database.query<{ status: string }>("SELECT status FROM experiment_batches WHERE id='retest'")).rows[0]
					.status,
			).toBe("partial");
			const alerts = (
				await database.query<{ provider_id: string; metric: string; severity: string }>(
					"SELECT provider_id,metric,severity FROM drift_alerts WHERE batch_id='retest' ORDER BY provider_id,metric",
				)
			).rows;
			expect(alerts.every((alert) => alert.provider_id === "kimi_api")).toBe(true);
			expect(alerts).toContainEqual({ provider_id: "kimi_api", metric: "brandMentionRate", severity: "high" });
		} finally {
			await database.close();
		}
	});
});
