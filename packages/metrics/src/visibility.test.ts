import type { QueryCapture, QueryCaptureV1, QueryCaptureV2 } from "@geo/evidence";
import { describe, expect, it } from "vitest";
import { calculateEqualWeightedOverall, calculateVisibilityMetrics } from "./visibility";

const capture = (overrides: Partial<QueryCaptureV1>): QueryCaptureV1 => ({
	schemaVersion: "geo.query-capture.v1",
	captureId: "capture-1",
	jobId: "job-1",
	projectId: "project-1",
	promptId: "prompt-1",
	prompt: "推荐 GEO 服务商",
	engine: "deepseek",
	captureMode: "consumer_surface",
	attempt: 1,
	capturedAt: "2026-08-30T05:00:00.000Z",
	locale: "zh-CN",
	region: "CN",
	status: "complete",
	answerText: "目标品牌和竞品都提供 GEO 服务。",
	brandMatches: [
		{ brandId: "target", matchedAlias: "目标品牌", position: 1 },
		{ brandId: "competitor", matchedAlias: "竞品", position: 6 },
	],
	sources: [
		{
			url: "https://example.com/geo",
			domain: "www.example.com",
			title: "GEO 服务",
			position: 1,
			isCitation: true,
		},
	],
	queryFanOut: [],
	evidence: {
		captureNodeId: "node-1",
		screenshotObjectKey: "screenshots/capture-1.png",
		traceObjectKey: null,
		pageUrl: "https://chat.deepseek.com/",
	},
	adapterVersion: "0.1.0",
	contentHash: "a".repeat(64),
	failureCode: null,
	failureMessage: null,
	...overrides,
});

describe("calculateEqualWeightedOverall", () => {
	it("按平台等权而不是按样本数加权", () => {
		const full = calculateVisibilityMetrics({
			captures: [capture({})],
			targetBrandId: "target",
			targetDomains: ["example.com"],
		});
		const empty = calculateVisibilityMetrics({
			captures: [capture({ brandMatches: [], sources: [] })],
			targetBrandId: "target",
			targetDomains: ["example.com"],
		});
		expect(calculateEqualWeightedOverall([full, empty]).brandMentionRate).toBe(0.5);
	});

	it("失败平台不以零分拉低品牌指标，并单独展示覆盖率", () => {
		const valid = calculateVisibilityMetrics({
			captures: [capture({})],
			targetBrandId: "target",
			targetDomains: ["example.com"],
		});
		const failed = calculateVisibilityMetrics({
			captures: [
				capture({
					status: "timeout",
					answerText: null,
					brandMatches: [],
					sources: [],
					contentHash: null,
					failureCode: "answer_timeout",
				}),
			],
			targetBrandId: "target",
			targetDomains: ["example.com"],
		});
		const overall = calculateEqualWeightedOverall([valid, failed]);
		expect(overall.brandMentionRate).toBe(1);
		expect(overall.validPlatformCount).toBe(1);
		expect(overall.dataCoverage).toBe(0.5);
		expect(overall.failureRate).toBe(0.5);
	});
});

describe("calculateVisibilityMetrics", () => {
	it("使用有回答的采集作为可见度分母", () => {
		const metrics = calculateVisibilityMetrics({
			captures: [
				capture({}),
				capture({
					captureId: "capture-2",
					status: "login_required",
					answerText: null,
					brandMatches: [],
					sources: [],
					failureCode: "login_expired",
				}),
			],
			targetBrandId: "target",
			targetDomains: ["example.com"],
			competitorBrandIds: ["competitor"],
		});

		expect(metrics.answerCoverage).toBe(0.5);
		expect(metrics.brandMentionRate).toBe(1);
		expect(metrics.firstRecommendationRate).toBe(1);
		expect(metrics.citationRate).toBe(1);
		expect(metrics.sourceToCitationRate).toBe(1);
		expect(metrics.competitorMentionRates.competitor).toBe(1);
	});

	it("没有进入来源时不虚构来源转引用率", () => {
		const metrics = calculateVisibilityMetrics({
			captures: [capture({ sources: [] })],
			targetBrandId: "target",
			targetDomains: ["example.com"],
		});

		expect(metrics.sourcePresenceRate).toBe(0);
		expect(metrics.sourceToCitationRate).toBeNull();
	});

	it("平台未开放来源时不把引用率记为零", () => {
		const apiCapture: QueryCaptureV2 = {
			...capture({}),
			schemaVersion: "geo.query-capture.v2",
			engine: "deepseek_api",
			captureMode: "llm_search_api",
			sourceVisibility: "unavailable",
			fanoutVisibility: "unavailable",
			evidence: {
				endpoint: "https://api.deepseek.com/v1/responses",
				rawResponseObjectKey: "raw/capture-1.json",
				requestId: "req-1",
			},
			model: "deepseek-model",
			protocol: "deepseek-responses",
			searchToolVersion: "web_search",
			executorId: "cloud-worker:test",
			usage: null,
			costMicros: null,
			latencyMs: 100,
		};
		const metrics = calculateVisibilityMetrics({
			captures: [apiCapture],
			targetBrandId: "target",
			targetDomains: ["example.com"],
		});
		expect(metrics.sourceCoverage).toBe(0);
		expect(metrics.citationRate).toBeNull();
	});
});
