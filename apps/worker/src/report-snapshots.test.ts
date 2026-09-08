import { migrateDatabase, openMemoryDatabase, writeEncryptedCredential } from "@geo/core";
import { describe, expect, it } from "vitest";
import { readArtifact } from "./object-store";
import {
	advanceReportWorkflow,
	createReportShare,
	generateReportPdf,
	generateReportWord,
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
import { seedMetricSnapshot } from "./test-support/measurement";

describe("不可变报告快照", () => {
	it(
		"生成售前快照并支持过期或撤销的分享链接",
		async () => {
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
				const narrativeRunId = "narrative-run";
				await database.query(
					`INSERT INTO agent_runs
				 (id,organization_id,project_id,batch_id,purpose,status,model,prompt_version,evidence_ids,draft,approved_at)
				 VALUES ($1,'default','project','batch','report_narrative','approved','gpt-test','geo-agent.v2','["capture"]'::jsonb,$2::jsonb,now())`,
					[
						narrativeRunId,
						JSON.stringify({
							summary: "报告摘要",
							executiveSummary: "管理层摘要",
							reputation: {
								overall: "negative",
								summary: "AI 回答出现一条负面评价。",
								positiveSignals: [],
								negativeSignals: [
									{
										statement: "服务响应需要改善",
										sourceStatus: "cited",
										sourceUrls: ["https://brand.example/case"],
										evidenceIds: ["capture"],
									},
								],
							},
							geoRecommendations: [
								{
									priority: "high",
									title: "补充服务响应证据",
									action: "发布可核验的服务时效说明。",
									rationale: "回应 AI 回答中的负面信号。",
									evidenceIds: ["capture"],
								},
							],
							limitations: ["仅代表当前采样窗口"],
							evidenceIds: ["capture"],
						}),
					],
				);
				await database.query(
					`INSERT INTO agent_runs
				 (id,organization_id,project_id,batch_id,purpose,status,model,prompt_version,evidence_ids,draft,approved_at)
				 VALUES ('quality-run','default','project','batch','quality_review','approved','gpt-test','geo-agent.v2','["capture"]'::jsonb,$1::jsonb,now())`,
					[
						JSON.stringify({
							summary: "证据与来源校验通过",
							verdict: "pass",
							reviewedNarrativeRunId: narrativeRunId,
							issues: [],
							evidenceIds: ["capture"],
						}),
					],
				);

				await database.query(
					`INSERT INTO optimization_articles (id,project_id,batch_id,source_run_id,narrative_run_id,recommendation_index,recommendation_title,title,summary,content_markdown)
					 VALUES ('visible-article','project','batch','narrative-run','narrative-run',0,'建议','保留文章','摘要','正文'),
					 ('deleted-article','project','batch','narrative-run','narrative-run',1,'建议','已删除文章','摘要','正文')`,
				);
				await database.query("UPDATE optimization_articles SET deleted_at=now() WHERE id='deleted-article'");
				await seedMetricSnapshot(database, "batch");
				expect(await advanceReportWorkflow(database, "batch", { actor: { kind: "local" } })).toMatchObject({
					state: "documents_queued",
					reportId: expect.any(String),
				});
				expect(await queueScheduledReportSnapshots(database)).toBe(0);
				expect(await queueScheduledReportSnapshots(database)).toBe(0);
				const created = (
					await listReportSnapshots(database, "project", { page: 1, pageSize: 20, offset: 0, search: null })
				).items[0] as { id: string };
				const snapshot = await getReportSnapshot(database, created.id);
				expect(snapshot?.payload_hash).toMatch(/^[a-f0-9]{64}$/);
				expect(snapshot?.payload).toMatchObject({ articles: [{ title: "保留文章" }] });
				await database.query("UPDATE optimization_articles SET deleted_at=now() WHERE id='visible-article'");
				const historical = await getReportSnapshot(database, created.id);
				expect(historical?.payload_hash).toBe(snapshot?.payload_hash);
				expect(historical?.payload).toMatchObject({ articles: [{ title: "保留文章" }] });
				expect(renderReportHtml(snapshot ?? {})).toContain("API 回答不等同于对应消费端 App");
				expect(renderReportHtml(snapshot ?? {})).toContain("服务响应需要改善");
				expect(renderReportHtml(snapshot ?? {})).toContain("https://brand.example/case");
				expect(renderReportHtml(snapshot ?? {})).toContain("zz-watermark");
				expect(renderReportHtml(snapshot ?? {})).toContain("ZZGEO");
				expect(renderReportHtml(snapshot ?? {})).toContain("客户：真实客户");
				await database.query("UPDATE projects SET name='修改后的客户' WHERE id='project'");
				expect(renderReportHtml((await getReportSnapshot(database, created.id)) ?? {})).not.toContain("修改后的客户");
				const word = await generateReportWord(database, created.id);
				const wordArtifact = await readArtifact(word.artifactKey);
				expect(wordArtifact.contentType).toContain("wordprocessingml");
				expect(Buffer.from(wordArtifact.body.subarray(0, 2)).toString("ascii")).toBe("PK");
				expect(Buffer.from(wordArtifact.body).toString("utf8")).toContain("ZZGEO-Watermark");
				expect(Buffer.from(wordArtifact.body).toString("utf8")).toContain("客户：真实客户");
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
				expect(
					(await listReportShares(database, created.id, { page: 1, pageSize: 20, offset: 0, search: null })).items,
				).toHaveLength(1);
				await revokeReportShare(database, share.id);
				expect(await getSharedReport(database, share.token)).toBeNull();
				expect(
					(await listReportShares(database, created.id, { page: 1, pageSize: 20, offset: 0, search: null }))
						.items as Array<{ revoked_at: string | null }>,
				).toEqual([expect.objectContaining({ revoked_at: expect.anything() })]);
			} finally {
				await database.close();
			}
		},
		// 单跑约 1.5 秒；turbo 并行 14 个任务时 PGlite + docx 会拖到 5 秒以上，留足余量避免偶发超时。
		process.env.GEO_PDF_E2E === "true" ? 30_000 : 15_000,
	);

	it("质检未通过时重试是重新生成叙述，而不是对同一份叙述反复质检；新叙述在途时不再拿旧叙述冻结", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await writeEncryptedCredential(database, "hrouter_api_key", "hrouter-key-1234567890", "default");
			await database.query(
				`INSERT INTO settings (key,value) VALUES ('organization:default:hrouter_config','{"baseUrl":"https://hrouter.test/v1","model":"gpt-5.4","thinkingLevel":"low"}'::jsonb)`,
			);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,aliases,status)
				 VALUES ('project','客户','https://brand.example','brand.example','成都','zh-CN','["客户"]'::jsonb,'active')`,
			);
			await database.query(
				`INSERT INTO experiment_batches (id,project_id,kind,status,config,config_hash,started_at,completed_at)
				 VALUES ('batch','project','quick_audit','complete','{}'::jsonb,'hash',now(),now())`,
			);
			await database.query(
				`INSERT INTO agent_runs (id,project_id,batch_id,purpose,status,model,prompt_version,draft,approved_at,created_at)
				 VALUES ('narrative','project','batch','report_narrative','approved','gpt-test','test','{"summary":"叙述"}'::jsonb,now()-interval '2 minutes',now()-interval '3 minutes'),
				        ('quality','project','batch','quality_review','approved','gpt-test','test',
				         '{"summary":"有高严重度问题","verdict":"blocked","reviewedNarrativeRunId":"narrative","issues":[],"evidenceIds":[]}'::jsonb,now()-interval '1 minute',now()-interval '1 minute')`,
			);
			await seedMetricSnapshot(database, "batch");
			expect(
				await advanceReportWorkflow(database, "batch", { actor: { kind: "local" }, allowRetry: false }),
			).toMatchObject({
				state: "quality_blocked",
				runId: "quality",
			});
			const retried = await advanceReportWorkflow(database, "batch", { actor: { kind: "local" }, allowRetry: true });
			expect(retried.state).toBe("narrative_queued");
			const runs = (
				await database.query<{ purpose: string; status: string }>(
					"SELECT purpose,status FROM agent_runs WHERE batch_id='batch' AND status='queued'",
				)
			).rows;
			expect(runs).toEqual([{ purpose: "report_narrative", status: "queued" }]);
			// 新叙述在途：再次推进（包括定时扫描）只报告叙述状态，不会再排质检或冻结旧叙述。
			expect(
				await advanceReportWorkflow(database, "batch", { actor: { kind: "local" }, allowRetry: true }),
			).toMatchObject({
				state: "narrative_queued",
				runId: retried.runId,
			});
			expect((await database.query("SELECT id FROM agent_runs WHERE purpose='quality_review'")).rows).toHaveLength(1);
			expect((await database.query("SELECT id FROM report_snapshots")).rows).toHaveLength(0);
		} finally {
			await database.close();
		}
	});
});
