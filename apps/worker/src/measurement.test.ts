import { type Database, migrateDatabase, openMemoryDatabase, writeEncryptedCredential } from "@geo/core";
import type { QueryCaptureV2 } from "@geo/evidence";
import { pairedDrift, rateKeys } from "@geo/metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	currentMeasurement,
	finalizeMeasurements,
	queueSemanticCaptures,
	recordMeasurementDrift,
	reviewSemanticObservation,
	runOneSemanticJob,
} from "./measurement";
import { ensureProviderConfigs } from "./providers";
import { sweepTerminalLeases } from "./queue-recovery";
import { createBatch, getBatch, storeCloudCapture } from "./service";
import { seedMeasurementModel } from "./test-support/measurement";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
async function seed(
	kind: "quick_audit" | "baseline" = "quick_audit",
): Promise<{ database: Database; batchId: string; capture: QueryCaptureV2 }> {
	vi.stubEnv("GEO_MASTER_KEY", Buffer.alloc(32, 1).toString("base64"));
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await seedMeasurementModel(database);
	await writeEncryptedCredential(database, "hrouter_api_key", "test-only-secret");
	await ensureProviderConfigs(database);
	await database.query("UPDATE provider_configs SET enabled=true WHERE provider_id='kimi_api'");
	await database.query(
		`INSERT INTO projects(id,name,website_url,domain,region,language,aliases,status) VALUES('brand','客户','https://brand.example','brand.example','CN','zh-CN','["客户"]','active')`,
	);
	await database.query(
		`INSERT INTO prompts(id,project_id,question,intent,tags,approved,position) VALUES('p','brand','问题？','购买','[]',true,0)`,
	);
	const batch = await createBatch(database, "brand", { kind, platforms: ["kimi_api"], repeats: 1 });
	const job = (
		await database.query<{ id: string }>("SELECT id FROM jobs WHERE type='capture' AND payload->>'batchId'=$1", [
			batch.id,
		])
	).rows[0];
	await database.query(
		"UPDATE jobs SET status='leased',lease_owner='worker',lease_expires_at=now()+interval '1 minute' WHERE id=$1",
		[job.id],
	);
	const capture: QueryCaptureV2 = {
		schemaVersion: "geo.query-capture.v2",
		captureId: "capture",
		jobId: job.id,
		projectId: "brand",
		promptId: "p",
		prompt: "问题？",
		engine: "kimi_api",
		captureMode: "llm_search_api",
		attempt: 1,
		capturedAt: new Date().toISOString(),
		locale: "zh-CN",
		region: "CN",
		status: "complete",
		answerText: "1. 推荐客户。",
		brandMatches: [],
		sources: [],
		queryFanOut: [],
		sourceVisibility: "unavailable",
		fanoutVisibility: "unavailable",
		evidence: { endpoint: "https://example.com", rawResponseObjectKey: "capture.json", requestId: null },
		model: "model",
		protocol: "protocol",
		searchToolVersion: "tool",
		adapterVersion: "adapter",
		executorId: "worker",
		usage: null,
		costMicros: null,
		latencyMs: 1,
		contentHash: "a".repeat(64),
		failureCode: null,
		failureMessage: null,
	};
	await storeCloudCapture(database, capture);
	return { database, batchId: batch.id, capture };
}
const observation = {
	schemaVersion: "geo.semantic-observation.v1",
	parseStatus: "valid",
	answerIntent: "purchase_recommendation",
	hasExplicitRecommendationList: true,
	brandSignals: [
		{
			brandId: "brand",
			mention: true,
			context: "recommendation",
			sentiment: "positive",
			recommendation: "explicit",
			rank: 1,
			evidenceSpans: [{ start: 0, end: 8, text: "1. 推荐客户。" }],
		},
	],
	ambiguityReasons: [],
};
function modelResponse(value: unknown = observation) {
	return new Response(
		JSON.stringify({
			status: "completed",
			output_text: JSON.stringify(value),
			usage: { input_tokens: 10, output_tokens: 10 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("V2 解析队列和指标快照", () => {
	it("配对派生可从部分写入继续，少量问题的下降不升级为正式告警", async () => {
		const { database, batchId, capture } = await seed("baseline");
		try {
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockImplementationOnce(async () => modelResponse())
					.mockImplementationOnce(async () =>
						modelResponse({ ...observation, hasExplicitRecommendationList: false, brandSignals: [] }),
					),
			);
			await queueSemanticCaptures(database);
			await runOneSemanticJob(database, "semantic");
			await finalizeMeasurements(database);
			const baseline = await currentMeasurement(database, batchId);
			const retest = await createBatch(database, "brand", { kind: "retest", compareToBatchId: batchId });
			const job = (
				await database.query<{ id: string }>("SELECT id FROM jobs WHERE type='capture' AND payload->>'batchId'=$1", [
					retest.id,
				])
			).rows[0];
			await database.query(
				"UPDATE jobs SET status='leased',lease_owner='worker',lease_expires_at=now()+interval '1 minute' WHERE id=$1",
				[job.id],
			);
			await storeCloudCapture(database, {
				...capture,
				captureId: "retest-capture",
				jobId: job.id,
				answerText: "未涉及监测品牌。",
			});
			await queueSemanticCaptures(database);
			await runOneSemanticJob(database, "semantic");
			await finalizeMeasurements(database);
			const current = await currentMeasurement(database, retest.id);
			if (!baseline.payload || !current.payload) throw new Error("test snapshot missing");
			const first = pairedDrift(
				baseline.payload.perPlatform.kimi_api,
				current.payload.perPlatform.kimi_api,
				"brandMentionRate",
				current.payload.contract,
			);
			await database.query(
				"INSERT INTO measurement_drift_observations(id,baseline_metric_id,metric_id,provider_id,metric,result) VALUES('first',$1,$2,'kimi_api','brandMentionRate',$3::jsonb)",
				[baseline.snapshotId, current.snapshotId, JSON.stringify(first)],
			);
			await recordMeasurementDrift(database);
			await recordMeasurementDrift(database);
			const rows = (
				await database.query("SELECT metric,result FROM measurement_drift_observations WHERE metric_id=$1", [
					current.snapshotId,
				])
			).rows;
			expect(rows).toHaveLength(rateKeys.length);
			expect(rows.find((r) => r.metric === "brandMentionRate")?.result).toMatchObject({
				previous: 1,
				current: 0,
				delta: -1,
				status: "limited",
				severity: "observation",
			});
			expect((await database.query("SELECT id FROM drift_alerts")).rows).toEqual([]);
		} finally {
			await database.close();
		}
	});
	it("实际采集 → 无工具的严格解析 → 不可变快照；GET 不调用模型", async () => {
		const { database, batchId } = await seed();
		try {
			const fetcher = vi.fn(async () => modelResponse());
			vi.stubGlobal("fetch", fetcher);
			await queueSemanticCaptures(database);
			await queueSemanticCaptures(database);
			expect((await database.query("SELECT id FROM jobs WHERE type='semantic_parse'")).rows).toHaveLength(1);
			expect(await runOneSemanticJob(database, "semantic")).toBe(true);
			await finalizeMeasurements(database);
			const current = await currentMeasurement(database, batchId);
			expect(current.status).toBe("partial");
			expect(current.payload?.perPlatform.kimi_api.recommendationRate).toBe(1);
			expect(current.payload?.perPlatform.kimi_api.citationRate).toBeNull();
			expect(current.payload?.consumerApp).toEqual({ status: "not_configured", metrics: null });
			const body = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
			expect(body.tools).toEqual([]);
			expect(body.tool_choice).toBe("none");
			expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
			const calls = fetcher.mock.calls.length;
			await getBatch(database, batchId);
			await getBatch(database, batchId);
			expect(fetcher).toHaveBeenCalledTimes(calls);
			expect((await database.query("SELECT id FROM metric_snapshots")).rows).toHaveLength(1);
			await finalizeMeasurements(database);
			expect((await database.query("SELECT id FROM metric_snapshots")).rows).toHaveLength(1);
		} finally {
			await database.close();
		}
	});
	it("冲突复核不采用；人工审核新增观察和快照，原始回答保持不变", async () => {
		const { database, batchId } = await seed();
		try {
			const first = { ...observation, parseStatus: "needs_review", ambiguityReasons: ["语境冲突"] };
			const second = { ...observation, brandSignals: [], hasExplicitRecommendationList: false };
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockImplementationOnce(async () => modelResponse(first))
					.mockImplementationOnce(async () => modelResponse(second)),
			);
			await queueSemanticCaptures(database);
			await runOneSemanticJob(database, "semantic");
			await finalizeMeasurements(database);
			const current = await currentMeasurement(database, batchId);
			expect(current.status).toBe("failed");
			expect((await database.query("SELECT id FROM semantic_observations")).rows).toHaveLength(2);
			await expect(
				reviewSemanticObservation(
					database,
					"other",
					{ runId: current.runId, captureId: "capture", observation, reason: "人工核实原文" },
					null,
				),
			).rejects.toThrow();
			await reviewSemanticObservation(
				database,
				batchId,
				{ runId: current.runId, captureId: "capture", observation, reason: "人工核实原文" },
				null,
			);
			await finalizeMeasurements(database);
			expect((await currentMeasurement(database, batchId)).snapshotId).not.toBe(current.snapshotId);
			expect((await database.query("SELECT id FROM metric_snapshots")).rows).toHaveLength(2);
			expect(
				(await database.query("SELECT answer_text,status FROM query_captures WHERE id='capture'")).rows[0],
			).toEqual({ answer_text: "1. 推荐客户。", status: "complete" });
			expect((await database.query("SELECT id FROM audit_logs WHERE action='semantic.review'")).rows).toHaveLength(1);
		} finally {
			await database.close();
		}
	});
	it("最后一次租约崩溃能收敛；解析失败不修改 Capture", async () => {
		const { database, batchId } = await seed();
		try {
			await queueSemanticCaptures(database);
			await database.query(
				"UPDATE jobs SET status='leased',attempts=max_attempts,lease_expires_at=now()-interval '1 minute' WHERE type='semantic_parse'",
			);
			expect(await sweepTerminalLeases(database)).toBe(1);
			await finalizeMeasurements(database);
			expect((await currentMeasurement(database, batchId)).status).toBe("failed");
			expect((await database.query("SELECT status FROM query_captures")).rows[0].status).toBe("complete");
		} finally {
			await database.close();
		}
	});
});
