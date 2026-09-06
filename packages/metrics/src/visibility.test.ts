import {
	type FrozenMeasurementContract,
	type QueryCaptureV2,
	type SemanticObservation,
	validateSemanticObservation,
} from "@geo/evidence";
import { describe, expect, it } from "vitest";
import {
	type AdoptedObservation,
	calculateEqualWeightedOverall,
	calculateVisibilityMetrics,
	clusterInterval,
	pairedDrift,
	pairwiseAgreement,
	type VisibilityMetricInput,
} from "./visibility";

const contract: FrozenMeasurementContract = {
	contractVersion: "geo.visibility-measurement.v2",
	sampling: {
		mode: "formal",
		repeats: 3,
		executionWindows: ["PT0M", "PT240M", "PT1440M"],
		minimumSuccessfulRepeatsPerPrompt: 2,
		minimumPromptCoverage: 0.8,
	},
	semantic: {
		schemaVersion: "geo.semantic-observation.v1",
		promptVersion: "semantic.atomic.v1",
		modelProvider: "hrouter",
		modelId: "gpt-test",
		modelRevision: null,
		endpoint: "https://example.com/v1",
		validatorVersion: "semantic.evidence.v1",
		adjudicationPolicyVersion: "independent-agreement.v1",
	},
	metrics: {
		algorithmVersion: "visibility.prompt-weighted.v2",
		intervalMethod: "cluster-bootstrap-percentile",
		bootstrapIterations: 2000,
		bootstrapSeed: "frozen-test-seed",
		minimumEligiblePrompts: 10,
		minimumParseCoverage: 0.9,
		maximumIntervalWidth: 0.5,
		reportabilityPolicyVersion: "coverage-gates.v1",
		driftPolicyVersion: "paired-delta95.v1",
	},
	surfaces: { api: { enabled: true }, consumerApp: { enabled: false, contractVersion: null } },
};

function fixture(outcomes: boolean[][]): VisibilityMetricInput {
	const captures: QueryCaptureV2[] = [],
		observations: AdoptedObservation[] = [];
	for (const [p, values] of outcomes.entries())
		for (const [index, present] of values.entries()) {
			const id = `p${p}-r${index}`;
			const answerText = present ? "1. 推荐品牌甲。" : "这里没有监测品牌。";
			captures.push({
				schemaVersion: "geo.query-capture.v2",
				captureId: id,
				jobId: id,
				projectId: "brand",
				promptId: `p${p}`,
				prompt: `问题${p}`,
				engine: "deepseek_api",
				captureMode: "llm_search_api",
				attempt: index + 1,
				capturedAt: "2026-09-05T00:00:00Z",
				locale: "zh-CN",
				region: "CN",
				status: "complete",
				answerText,
				brandMatches: [],
				sources: [],
				queryFanOut: [],
				sourceVisibility: "unavailable",
				fanoutVisibility: "unavailable",
				evidence: { endpoint: "https://example.com", rawResponseObjectKey: id, requestId: null },
				model: "provider-model",
				protocol: "test",
				searchToolVersion: "test",
				adapterVersion: "test",
				executorId: "worker",
				usage: null,
				costMicros: null,
				latencyMs: 1,
				contentHash: "a".repeat(64),
				failureCode: null,
				failureMessage: null,
			});
			const observation: SemanticObservation = {
				schemaVersion: "geo.semantic-observation.v1",
				parseStatus: "valid",
				answerIntent: "purchase_recommendation",
				hasExplicitRecommendationList: present,
				brandSignals: present
					? [
							{
								brandId: "brand",
								mention: true,
								context: "recommendation",
								sentiment: "positive",
								recommendation: "explicit",
								rank: 1,
								evidenceSpans: [{ start: 0, end: answerText.length, text: answerText }],
							},
						]
					: [],
				ambiguityReasons: [],
			};
			observations.push({ id: `o-${id}`, captureId: id, contract: contract.semantic, observation });
		}
	return {
		captures,
		observations,
		promptIds: outcomes.map((_, p) => `p${p}`),
		targetBrandId: "brand",
		targetDomains: ["example.com"],
		brands: [{ id: "brand", name: "品牌甲", aliases: [] }],
		contract: structuredClone(contract),
	};
}
describe("V2 确定性指标", () => {
	it("问题等权，不让三次成功问题压过两次成功问题", () => {
		const result = calculateVisibilityMetrics(
			fixture([
				[true, true, true],
				[false, false],
			]),
		);
		expect(result.brandMentionRate).toBe(0.5);
		expect(result.status).toBe("limited");
		expect(result.captureCoverage).toBe(5 / 6);
	});
	it.each([
		[[], null],
		[[true], null],
		[[true, true], 1],
		[[true, false], 0],
		[[true, true, false], 1 / 3],
		[[false, false, false], 1],
	] as const)("两两一致率 %j", (values, result) => expect(pairwiseAgreement([...values])).toBe(result));
	it("解析失败和缺失不算未提及，覆盖率单独计算", () => {
		const input = fixture([
			[true, true, true],
			[false, false, false],
		]);
		input.observations = input.observations.slice(0, 3);
		const result = calculateVisibilityMetrics(input);
		expect(result.brandMentionRate).toBe(1);
		expect(result.parseCoverage).toBe(0.5);
		expect(result.promptCoverage).toBe(0.5);
	});
	it("来源不可见返回 null，而不是零", () =>
		expect(calculateVisibilityMetrics(fixture([[true, true]])).citationRate).toBeNull());
	it("否定提及不能作为推荐或首位推荐", () => {
		const input = fixture([[true, true]]);
		for (const observation of input.observations) {
			const s = observation.observation.brandSignals[0];
			s.context = "exclusion";
			s.sentiment = "negative";
			s.recommendation = "against";
			s.rank = null;
			observation.observation.hasExplicitRecommendationList = false;
		}
		const result = calculateVisibilityMetrics(input);
		expect(result.brandMentionRate).toBe(1);
		expect(result.firstRecommendationRate).toBe(0);
		expect(result.recommendationRate).toBe(0);
		expect(result.medianRecommendationRank).toBeNull();
	});
	it("快审不计算稳定性、区间和正式漂移", () => {
		const input = fixture([[true]]);
		input.contract.sampling = {
			...input.contract.sampling,
			mode: "quick",
			repeats: 1,
			executionWindows: ["PT0M"],
			minimumSuccessfulRepeatsPerPrompt: 1,
		};
		const result = calculateVisibilityMetrics(input);
		expect(result.status).toBe("limited");
		expect(result.pairwiseAgreement).toBeNull();
		expect(result.confidenceIntervals.brandMentionRate).toBeNull();
		expect(calculateEqualWeightedOverall([result], input.contract).brandMentionRate).toBe(1);
	});
	it("固定种子、输入重排下区间可复现", () => {
		const input = fixture(Array.from({ length: 10 }, (_, i) => [i % 2 === 0, true, false]));
		const first = calculateVisibilityMetrics(input);
		input.captures.reverse();
		input.observations.reverse();
		input.promptIds.reverse();
		expect(calculateVisibilityMetrics(input)).toEqual(first);
		expect(first.confidenceIntervals.brandMentionRate).not.toBeNull();
	});
	it("Bootstrap 按整个问题聚类", () => {
		const result = clusterInterval([0, 1], (v) => v.reduce((s, x) => s + x, 0) / v.length, 2000, "seed");
		expect(result).toEqual([0, 1]);
	});
	it("重复业务样本拒绝，技术重试不能增加分母", () => {
		const input = fixture([[true, true]]);
		input.captures.push({ ...input.captures[0], captureId: "duplicate" });
		expect(() => calculateVisibilityMetrics(input)).toThrow("重复");
	});
	it("不同解析契约不能参与当前指标", () => {
		const input = fixture([[true, true]]);
		for (const o of input.observations) o.contract = { ...o.contract, modelId: "gpt-other" };
		expect(calculateVisibilityMetrics(input).brandMentionRate).toBeNull();
	});
	it("正式总体只纳入达到门槛的平台，全部失败不是零分", () => {
		const ready = calculateVisibilityMetrics(fixture(Array.from({ length: 10 }, () => [true, true, true])));
		const unavailable = calculateVisibilityMetrics(fixture([[]]));
		expect(calculateEqualWeightedOverall([ready, unavailable], contract)).toMatchObject({
			brandMentionRate: 1,
			dataCoverage: 0.5,
		});
		expect(calculateEqualWeightedOverall([unavailable], contract).brandMentionRate).toBeNull();
	});
	it("配对下降幅度和区间同时通过才告警", () => {
		const before = calculateVisibilityMetrics(fixture(Array.from({ length: 10 }, () => [true, true, true])));
		const after = calculateVisibilityMetrics(fixture(Array.from({ length: 10 }, () => [false, false, false])));
		expect(pairedDrift(before, after, "brandMentionRate", contract)).toMatchObject({
			delta: -1,
			interval: [-1, -1],
			severity: "high",
		});
		after.status = "limited";
		expect(pairedDrift(before, after, "brandMentionRate", contract).severity).toBe("observation");
	});
	it("歧义、伪造片段、未知品牌及注入字段拒绝", () => {
		const input = fixture([[true, true]]);
		const o = input.observations[0].observation;
		const answer = input.captures[0].answerText!;
		expect(validateSemanticObservation({ ...o, tools: ["bash"] }, answer, input.brands).status).toBe("failed");
		expect(
			validateSemanticObservation(
				{ ...o, brandSignals: [{ ...o.brandSignals[0], brandId: "other" }] },
				answer,
				input.brands,
			).status,
		).toBe("failed");
		expect(
			validateSemanticObservation(
				{ ...o, brandSignals: [{ ...o.brandSignals[0], evidenceSpans: [{ start: 0, end: 1, text: "伪造" }] }] },
				answer,
				input.brands,
			).status,
		).toBe("failed");
		expect(
			validateSemanticObservation({ ...o, brandSignals: [o.brandSignals[0], o.brandSignals[0]] }, answer, input.brands)
				.status,
		).toBe("needs_review");
	});
});
