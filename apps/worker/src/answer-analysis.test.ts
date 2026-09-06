import { type Database, migrateDatabase, openMemoryDatabase, writeEncryptedCredential } from "@geo/core";
import type { AnswerAnalysis } from "@geo/evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueAnswerAnalysis, getAnswerAnalysis, runOneAnswerAnalysisJob } from "./answer-analysis";
import { evaluateRequest, loadActorPrincipal } from "./authorization";
import { ensureProviderConfigs } from "./providers";
import { sweepTerminalLeases } from "./queue-recovery";
import { createBatch } from "./service";
import { seedMeasurementModel } from "./test-support/measurement";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
const answer = "测试客户价格较低，但仅推荐在预算有限时使用。";
function annotation(): AnswerAnalysis {
	const evidence = [{ segmentId: "s1", quote: answer }];
	return {
		schemaVersion: "geo.answer-analysis.v1",
		status: "complete",
		answerType: "recommendation",
		summary: { text: "原文有条件地推荐测试客户。", evidence },
		keyPoints: [{ text: "推荐限定在预算有限时。", evidence }],
		sections: [
			{ segmentIds: ["s1"], title: "条件推荐", kind: "recommendation", summary: "说明价格与适用条件。", evidence },
		],
		brands: [
			{
				brandId: "analysis-brand",
				sentiment: "positive",
				stance: "conditional",
				summary: { text: "原文有条件地推荐测试客户。", evidence },
				aspects: [{ aspect: "价格", sentiment: "positive", assessment: "价格较低。", evidence }],
				recommendations: [{ stance: "conditional", reason: "价格较低", conditions: ["预算有限"], evidence }],
			},
		],
		comparisons: [],
		limitations: [{ text: "推荐有预算条件。", evidence }],
		ambiguities: [],
	};
}
const response = (value: unknown = annotation()) =>
	new Response(
		JSON.stringify({
			status: "completed",
			output_text: JSON.stringify(value),
			usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
		}),
		{ status: 200 },
	);
async function seed() {
	vi.stubEnv("GEO_MASTER_KEY", Buffer.alloc(32, 1).toString("base64"));
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await seedMeasurementModel(database);
	await writeEncryptedCredential(database, "hrouter_api_key", "test-only-secret");
	await ensureProviderConfigs(database);
	await database.query("UPDATE provider_configs SET enabled=true WHERE provider_id='kimi_api'");
	await database.query(
		"INSERT INTO projects(id,name,website_url,domain,region,language,aliases,status) VALUES('analysis-brand','测试客户','https://brand.example','brand.example','CN','zh-CN','[]','active')",
	);
	await database.query(
		"INSERT INTO prompts(id,project_id,question,intent,tags,approved,position) VALUES('analysis-prompt','analysis-brand','如何选择？','比较','[]',true,0)",
	);
	const batch = await createBatch(database, "analysis-brand", {
		kind: "quick_audit",
		platforms: ["kimi_api"],
		repeats: 1,
	});
	const job = (
		await database.query<{ id: string }>("SELECT id FROM jobs WHERE type='capture' AND payload->>'batchId'=$1", [
			batch.id,
		])
	).rows[0];
	await database.query(
		`INSERT INTO query_captures(id,job_id,batch_id,project_id,prompt_id,platform,attempt,status,answer_text,adapter_version,captured_at,schema_version,capture_mode)
	 VALUES('analysis-capture',$1,$2,'analysis-brand','analysis-prompt','kimi_api',1,'complete',$3,'test-only',now(),'geo.query-capture.v2','llm_search_api')`,
		[job.id, batch.id, answer],
	);
	return { database, batchId: batch.id };
}
const enqueue = (database: Database, batchId: string) =>
	enqueueAnswerAnalysis(database, batchId, "analysis-capture", { kind: "local" });
const read = (database: Database, batchId: string, runId: string | null = null) =>
	getAnswerAnalysis(database, batchId, "analysis-capture", runId);

describe("独立完整语义分析运行", () => {
	it("GET 零模型调用，排队幂等；冻结模型、留存完整结果和用量，不修改证据或排名", async () => {
		const { database, batchId } = await seed();
		try {
			const original = (await database.query("SELECT * FROM query_captures")).rows;
			const config = (await database.query("SELECT config FROM experiment_batches WHERE id=$1", [batchId])).rows;
			const fetcher = vi.fn(async () => response());
			vi.stubGlobal("fetch", fetcher);
			expect((await read(database, batchId)).status).toBe("not_generated");
			expect(fetcher).not.toHaveBeenCalled();
			const first = await enqueue(database, batchId);
			expect(await enqueue(database, batchId)).toEqual(first);
			await database.query("UPDATE prompts SET question='后续编辑不应改变旧回答分析' WHERE id='analysis-prompt'");
			await database.query(
				"UPDATE settings SET value='{" +
					'"model":"changed-after-freeze","baseUrl":"https://other.example/v1"' +
					"}'::jsonb WHERE key='organization:default:hrouter_config'",
			);
			expect(await runOneAnswerAnalysisJob(database, "analysis-test")).toBe(true);
			const view = await read(database, batchId);
			expect(view.question).toBe("如何选择？");
			expect(view).toMatchObject({
				id: first.id,
				status: "ready",
				contract: { modelId: "gpt-test", modelRevision: null },
				costMicros: null,
				usage: { totalTokens: 300 },
				result: { coverage: { totalSegments: 1, analyzedSegments: 1 } },
			});
			const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
			expect(url).toBe("https://example.com/v1/responses");
			expect(JSON.parse(JSON.parse(String(request.body)).input[1].content).question).toBe("如何选择？");
			expect(JSON.parse(String(request.body))).toMatchObject({
				model: "gpt-test",
				tools: [],
				tool_choice: "none",
				text: { format: { strict: true } },
			});
			expect((await database.query("SELECT * FROM query_captures")).rows).toEqual(original);
			expect((await database.query("SELECT config FROM experiment_batches WHERE id=$1", [batchId])).rows).toEqual(
				config,
			);
			expect((await database.query("SELECT * FROM metric_snapshots")).rows).toHaveLength(0);
			expect(
				(await database.query("SELECT operation,cost_micros FROM project_costs WHERE operation='answer_analysis'"))
					.rows,
			).toEqual([{ operation: "answer_analysis", cost_micros: null }]);
			await read(database, batchId);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(view)).not.toContain("test-only-secret");
			expect(view.contract).not.toHaveProperty("endpoint");
		} finally {
			await database.close();
		}
	});
	it("重新生成只追加运行，旧版仍可读，错批次/错版本拒绝读取", async () => {
		const { database, batchId } = await seed();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => response()),
			);
			const first = await enqueue(database, batchId);
			await runOneAnswerAnalysisJob(database, "analysis-test");
			const second = await enqueue(database, batchId);
			expect(second.id).not.toBe(first.id);
			expect(await read(database, batchId)).toMatchObject({ id: second.id, status: "queued", previousRunId: first.id });
			expect(await read(database, batchId, first.id)).toMatchObject({ status: "ready", latestRunId: second.id });
			await expect(getAnswerAnalysis(database, "wrong-batch", "analysis-capture")).rejects.toMatchObject({
				status: 404,
			});
			await expect(read(database, batchId, "wrong-run")).rejects.toMatchObject({ status: 404 });
		} finally {
			await database.close();
		}
	});
	it("证据错误不显示可采信分析，原始模型响应只保留在派生尝试中", async () => {
		const { database, batchId } = await seed();
		try {
			const invalid = annotation();
			invalid.summary.evidence = [{ segmentId: "s1", quote: "编造的证据" }];
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => response(invalid)),
			);
			await enqueue(database, batchId);
			await runOneAnswerAnalysisJob(database, "analysis-test");
			expect(await read(database, batchId)).toMatchObject({ status: "needs_review", result: null });
			expect((await database.query("SELECT raw_response FROM answer_analysis_attempts")).rows[0]).toHaveProperty(
				"raw_response",
			);
			expect(await read(database, batchId)).not.toHaveProperty("raw_response");
		} finally {
			await database.close();
		}
	});
	it("执行策略撤销后不发送上游请求，缺少异步身份也不按系统身份执行", async () => {
		const { database, batchId } = await seed();
		try {
			const fetcher = vi.fn();
			vi.stubGlobal("fetch", fetcher);
			await enqueue(database, batchId);
			await database.query(
				"UPDATE authorization_policies SET enabled=false WHERE policy_key='answer.analysis.execute'",
			);
			await runOneAnswerAnalysisJob(database, "analysis-test");
			expect(fetcher).not.toHaveBeenCalled();
			expect((await read(database, batchId)).status).toBe("failed");
			await database.query("UPDATE authorization_policies SET enabled=true WHERE policy_key='answer.analysis.execute'");
			await expect(
				enqueueAnswerAnalysis(database, batchId, "analysis-capture", { kind: "unassigned" }),
			).rejects.toMatchObject({ status: 403 });
		} finally {
			await database.close();
		}
	});
	it("模型调用过程中撤权不能采用结果，已产生的调用仍留存用量", async () => {
		const { database, batchId } = await seed();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					await database.query(
						"UPDATE authorization_policies SET enabled=false WHERE policy_key='answer.analysis.execute'",
					);
					return response();
				}),
			);
			await enqueue(database, batchId);
			await runOneAnswerAnalysisJob(database, "analysis-test");
			expect(await read(database, batchId)).toMatchObject({ status: "failed", result: null });
			expect((await database.query("SELECT status FROM answer_analysis_attempts")).rows).toEqual([{ status: "valid" }]);
			expect(
				(await database.query("SELECT cost_micros FROM project_costs WHERE operation='answer_analysis'")).rows,
			).toEqual([{ cost_micros: null }]);
		} finally {
			await database.close();
		}
	});
	it("HTTP 策略区分只读/生成与项目范围，跨机构读取拒绝", async () => {
		const { database, batchId } = await seed();
		try {
			const local = await loadActorPrincipal(database, { kind: "local" }, "default");
			if (!local) throw new Error("missing test principal");
			const reader = { ...local, systemAdmin: false, permissions: ["page.evidence"] };
			const path = `/api/batches/${batchId}/captures/analysis-capture/analysis`;
			expect((await evaluateRequest(database, reader, "GET", path)).decision.allowed).toBe(true);
			expect((await evaluateRequest(database, reader, "POST", path)).decision.reason).toBe("missing_permission");
			expect(
				(await evaluateRequest(database, { ...reader, organizationId: "another-organization" }, "GET", path)).decision
					.reason,
			).toBe("wrong_organization");
			expect(
				(await evaluateRequest(database, { ...reader, projects: { all: false, ids: [] } }, "GET", path)).decision
					.reason,
			).toBe("wrong_project");
		} finally {
			await database.close();
		}
	});
	it("网络失败仅两次技术尝试，耗尽租约可回收，不生成替代结果", async () => {
		const { database, batchId } = await seed();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new Error("upstream secret must not leak");
				}),
			);
			await enqueue(database, batchId);
			await runOneAnswerAnalysisJob(database, "analysis-test");
			expect((await read(database, batchId)).status).toBe("queued");
			await database.query("UPDATE jobs SET available_at=now() WHERE type='answer_analysis'");
			await runOneAnswerAnalysisJob(database, "analysis-test");
			expect((await read(database, batchId)).status).toBe("failed");
			expect((await database.query("SELECT id FROM answer_analysis_attempts")).rows).toHaveLength(2);
			expect(JSON.stringify(await read(database, batchId))).not.toContain("upstream secret");
			expect(await runOneAnswerAnalysisJob(database, "analysis-test")).toBe(false);
			await enqueue(database, batchId);
			await database.query(
				"UPDATE jobs SET status='leased',attempts=max_attempts,lease_owner='dead-worker',lease_expires_at=now()-interval '1 minute' WHERE type='answer_analysis' AND status='pending'",
			);
			await sweepTerminalLeases(database);
			expect((await read(database, batchId)).status).toBe("failed");
		} finally {
			await database.close();
		}
	});
});
