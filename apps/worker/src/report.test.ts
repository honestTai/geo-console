import type { FrozenBatchConfig } from "@geo/core";
import type { QueryCaptureV2 } from "@geo/evidence";
import { calculateEqualWeightedOverall, calculateVisibilityMetrics } from "@geo/metrics";
import { describe, expect, it } from "vitest";
import { buildReportAnalysis } from "./report";
import { testMeasurementContract } from "./test-support/measurement";

const config: FrozenBatchConfig = {
	project: { name: "真实品牌", domain: "brand.cn", region: "成都", language: "zh-CN", aliases: ["真实品牌"] },
	competitors: [{ id: "competitor", name: "竞品", domain: "competitor.cn", aliases: ["竞品"] }],
	prompts: [{ id: "prompt", question: "成都有哪些值得购买的品牌？", intent: "购买", tags: ["成都"] }],
	platforms: ["kimi_api"],
	repeats: 1,
	collectorVersion: "test",
};

const capture: QueryCaptureV2 = {
	schemaVersion: "geo.query-capture.v2",
	captureId: "capture",
	jobId: "job",
	projectId: "project",
	promptId: "prompt",
	prompt: config.prompts[0].question,
	engine: "kimi_api",
	captureMode: "llm_search_api",
	attempt: 1,
	capturedAt: "2026-08-30T00:00:00.000Z",
	locale: "zh-CN",
	region: "成都",
	status: "complete",
	answerText: "竞品常见。真实品牌适合希望了解本地品牌的消费者。",
	brandMatches: [
		{ brandId: "competitor", matchedAlias: "竞品", position: 1 },
		{ brandId: "project", matchedAlias: "真实品牌", position: 2 },
	],
	sources: [{ url: "https://media.cn/a", domain: "media.cn", title: "报道", position: 1, isCitation: true }],
	queryFanOut: [],
	evidence: { endpoint: "https://example.com", rawResponseObjectKey: "capture.json", requestId: null },
	sourceVisibility: "available",
	fanoutVisibility: "unavailable",
	model: "test",
	protocol: "test",
	searchToolVersion: "test",
	executorId: "worker",
	usage: null,
	costMicros: null,
	latencyMs: 1,

	adapterVersion: "test",
	contentHash: "a".repeat(64),
	failureCode: null,
	failureMessage: null,
};

describe("buildReportAnalysis", () => {
	it("只从真实采集生成问题、信源和证据化差距", () => {
		const platform = calculateVisibilityMetrics({
			captures: [capture],
			targetBrandId: "project",
			targetDomains: ["brand.cn"],
			promptIds: ["prompt"],
			contract: testMeasurementContract,
			brands: [
				{ id: "project", name: "真实品牌", aliases: [] },
				{ id: "competitor", name: "竞品", aliases: [] },
			],
			observations: [
				{
					id: "observation",
					captureId: "capture",
					contract: testMeasurementContract.semantic,
					observation: {
						schemaVersion: "geo.semantic-observation.v1",
						parseStatus: "valid",
						answerIntent: "informational",
						hasExplicitRecommendationList: false,
						ambiguityReasons: [],
						brandSignals: [
							{
								brandId: "project",
								mention: true,
								context: "factual",
								sentiment: "neutral",
								recommendation: "none",
								rank: null,
								evidenceSpans: [{ start: 0, end: capture.answerText!.length, text: capture.answerText! }],
							},
						],
					},
				},
			],
		});
		const report = buildReportAnalysis({
			projectId: "project",
			config,
			captures: [capture],
			metrics: {
				perPlatform: { kimi: platform },
				overall: calculateEqualWeightedOverall([platform], testMeasurementContract),
				validSamples: 1,
				failedSamples: 0,
				expectedSamples: 1,
			},
			websiteAudit: null,
			webEvidence: [
				{
					id: "customer-page",
					role: "customer",
					url: "https://brand.cn/",
					domain: "brand.cn",
					title: "客户官网",
					content: "成都品牌介绍",
					structuredData: [],
				},
				{
					id: "citation-page",
					role: "citation",
					url: "https://media.cn/a",
					domain: "media.cn",
					title: "报道",
					content: "成都本地购买指南",
					structuredData: [],
				},
			],
		});

		expect(report.promptRows[0].bestTargetPosition).toBeNull();
		expect(report.sourceDomains[0].domain).toBe("media.cn");
		const uncited = buildReportAnalysis({
			projectId: "project",
			config,
			captures: [{ ...capture, sources: capture.sources.map((source) => ({ ...source, isCitation: false })) }],
			metrics: {
				perPlatform: { kimi: platform },
				overall: calculateEqualWeightedOverall([platform], testMeasurementContract),
				validSamples: 1,
				failedSamples: 0,
				expectedSamples: 1,
			},
			websiteAudit: null,
		});
		expect(uncited.sourceDomains).toEqual([]);
		expect(uncited.evidenceIndex.find((entry) => entry.kind === "capture")?.sourceUrls).toEqual([]);
		expect(report.perceptionExcerpts[0].text).toContain("真实品牌");
		expect(report.webEvidenceSummary).toEqual({ customerPages: 1, competitorPages: 0, citationPages: 1 });
		expect(report.topicCoverage[0].terms[0].customerEvidenceIds).toEqual(["customer-page"]);
		expect(report.gaps.some((finding) => finding.title.includes("正向推荐覆盖"))).toBe(true);
		expect(report.gaps.every((finding) => finding.evidenceIds.includes("capture"))).toBe(true);
	});
});
