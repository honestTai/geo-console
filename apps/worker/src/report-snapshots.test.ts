import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { readArtifact } from "./object-store";
import {
	createReportShare,
	generateReportPdf,
	getReportPdfStatus,
	getReportSnapshot,
	getSharedReport,
	listReportShares,
	listReportSnapshots,
	queueScheduledReportSnapshots,
	renderReportHtml,
	requestReportPdf,
	revokeReportShare,
} from "./report-snapshots";

describe("不可变报告快照", () => {
	it("生成售前快照并支持过期或撤销的分享链接", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,aliases,status)
				 VALUES ('project','真实客户','https://brand.example','brand.example','成都','zh-CN','["真实客户"]'::jsonb,'active')`,
			);
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
				 VALUES ('prompt','project','成都有哪些服务商？','购买','["成都"]'::jsonb,true,0)`,
			);
			const config = {
				project: {
					name: "真实客户",
					domain: "brand.example",
					region: "成都",
					language: "zh-CN",
					aliases: ["真实客户"],
				},
				competitors: [],
				prompts: [{ id: "prompt", question: "成都有哪些服务商？", intent: "购买", tags: ["成都"] }],
				platforms: ["qwen_api"],
				repeats: 1,
				runnerVersion: "test",
				samplingMode: "quick",
				executionWindows: ["PT0M"],
				providers: [
					{
						id: "qwen_api",
						model: "qwen-plus",
						protocol: "dashscope-native-generation",
						searchToolVersion: "native-web-search",
						searchStrategy: {},
					},
				],
			};
			await database.query(
				`INSERT INTO experiment_batches (id,project_id,kind,status,config,config_hash,started_at,completed_at)
				 VALUES ('batch','project','quick_audit','complete',$1::jsonb,'hash',now(),now())`,
				[JSON.stringify(config)],
			);
			await database.query(
				`INSERT INTO jobs (id,type,payload,status) VALUES
				 ('job','capture',$1::jsonb,'complete')`,
				[
					JSON.stringify({
						projectId: "project",
						batchId: "batch",
						promptId: "prompt",
						prompt: "成都有哪些服务商？",
						platform: "qwen_api",
						attempt: 1,
						region: "成都",
						locale: "zh-CN",
						brands: [],
					}),
				],
			);
			await database.query(
				`INSERT INTO query_captures
				 (id,job_id,batch_id,project_id,prompt_id,platform,attempt,status,answer_text,brand_matches,sources,query_fan_out,
				 page_url,content_hash,adapter_version,failure_code,failure_message,captured_at,schema_version,capture_mode,model,
				 protocol,search_tool_version,source_visibility,fanout_visibility,raw_artifact_key,provider_request_id,usage,
				 cost_micros,latency_ms,executor_id)
				 VALUES ('capture','job','batch','project','prompt','qwen_api',1,'complete','真实客户值得考虑。',
				 '[{"brandId":"project","matchedAlias":"真实客户","position":1}]'::jsonb,
				 '[{"url":"https://brand.example/case","domain":"brand.example","title":"案例","position":1,"isCitation":true}]'::jsonb,
				 '[]'::jsonb,'https://dashscope.aliyuncs.com/api/v1',$1,'test',NULL,NULL,now(),'geo.query-capture.v2',
				 'llm_search_api','qwen-plus','dashscope-native-generation','native-web-search','available','unavailable',
				 'captures/project/capture.json','request','{"totalTokens":10}'::jsonb,0,100,'worker')`,
				["a".repeat(64)],
			);

			await database.query(
				`INSERT INTO monitoring_schedules (id,project_id,enabled,platforms,last_batch_id)
				 VALUES ('schedule','project',true,'["qwen_api"]'::jsonb,'batch')`,
			);
			expect(await queueScheduledReportSnapshots(database)).toBe(1);
			expect(await queueScheduledReportSnapshots(database)).toBe(0);
			const created = (await listReportSnapshots(database, "project"))[0] as { id: string };
			const snapshot = await getReportSnapshot(database, created.id);
			expect(snapshot?.payload_hash).toMatch(/^[a-f0-9]{64}$/);
			expect(renderReportHtml(snapshot ?? {})).toContain("API 回答不等同于对应消费端 App");
			expect(await requestReportPdf(database, created.id)).toEqual({ status: "queued", artifactKey: null });
			expect((await getReportPdfStatus(database, created.id)).status).toBe("queued");
			if (process.env.GEO_PDF_E2E === "true") {
				const generated = await generateReportPdf(database, created.id);
				const pdf = await readArtifact(generated.artifactKey);
				expect(pdf.contentType).toBe("application/pdf");
				expect(Buffer.from(pdf.body.subarray(0, 4)).toString("ascii")).toBe("%PDF");
			}

			const share = await createReportShare(database, created.id, 30);
			expect((await getSharedReport(database, share.token))?.id).toBe(created.id);
			expect(await listReportShares(database, created.id)).toHaveLength(1);
			await revokeReportShare(database, share.id);
			expect(await getSharedReport(database, share.token)).toBeNull();
			expect((await listReportShares(database, created.id)) as Array<{ revoked_at: string | null }>).toEqual([
				expect.objectContaining({ revoked_at: expect.anything() }),
			]);
		} finally {
			await database.close();
		}
	});
});
