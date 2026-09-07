import type { FrozenMeasurementContract, QueryCaptureV2 } from "@geo/evidence";
import { describe, expect, it } from "vitest";
import { explainMeasurement, failureExplanation, isNamedBrandQuestion } from "./communication";
import { type AdoptedObservation, calculateEqualWeightedOverall, calculateVisibilityMetrics } from "./visibility";

const contract: FrozenMeasurementContract = {
	contractVersion: "geo.visibility-measurement.v2",
	sampling: {
		mode: "quick",
		repeats: 1,
		executionWindows: ["PT0M"],
		minimumSuccessfulRepeatsPerPrompt: 1,
		minimumPromptCoverage: 0.8,
	},
	semantic: {
		schemaVersion: "geo.semantic-observation.v1",
		promptVersion: "semantic.atomic.v1",
		modelProvider: "hrouter",
		modelId: "test",
		modelRevision: null,
		endpoint: "https://example.com",
		validatorVersion: "semantic.evidence.v1",
		adjudicationPolicyVersion: "independent-agreement.v1",
	},
	metrics: {
		algorithmVersion: "visibility.prompt-weighted.v2",
		intervalMethod: "cluster-bootstrap-percentile",
		bootstrapIterations: 100,
		bootstrapSeed: "test",
		minimumEligiblePrompts: 10,
		minimumParseCoverage: 0.9,
		maximumIntervalWidth: 0.5,
		reportabilityPolicyVersion: "coverage-gates.v1",
		driftPolicyVersion: "paired-delta95.v1",
	},
	surfaces: { api: { enabled: true }, consumerApp: { enabled: false, contractVersion: null } },
};

function fixture() {
	const prompts = Array.from({ length: 50 }, (_, i) => ({
		id: `p${i}`,
		question: [0, 1, 46, 49].includes(i) ? `测试品牌的业务问题${i}` : `不点名的采购问题${i}`,
	}));
	const captures = prompts.map(
		(p, i) =>
			({
				schemaVersion: "geo.query-capture.v2",
				jobId: `job${i}`,
				attempt: 1,
				captureId: `c${i}`,
				promptId: p.id,
				prompt: p.question,
				status: i < 47 ? "complete" : "no_answer",
				answerText:
					i < 2
						? "测试品牌可提供业务信息。"
						: i === 2
							? "对照品牌可提供业务信息。"
							: i < 47
								? "这里介绍问题的处理办法。"
								: null,
				captureMode: "llm_search_api",
				sourceVisibility: i < 41 ? "visible" : "unavailable",
				failureCode: i < 47 ? null : "no_answer",
				sources:
					i < 41
						? Array.from({ length: i === 0 ? 5 : 1 }, (_, j) => ({
								url: `https://source.example/${j}`,
								domain: "source.example",
								title: null,
								isCitation: i === 0,
							}))
						: [],
			}) as unknown as QueryCaptureV2,
	);
	const observations: AdoptedObservation[] = captures.slice(0, 44).map((c, i) => ({
		id: `o${i}`,
		captureId: c.captureId,
		contract: contract.semantic,
		observation: {
			schemaVersion: "geo.semantic-observation.v1",
			parseStatus: "valid",
			answerIntent: "informational",
			hasExplicitRecommendationList: false,
			ambiguityReasons: [],
			brandSignals:
				i < 3
					? [
							{
								brandId: i < 2 ? "brand" : "competitor",
								mention: true,
								context: "factual",
								sentiment: "neutral",
								recommendation: "none",
								rank: null,
								evidenceSpans: [{ start: 0, end: c.answerText!.length, text: c.answerText! }],
							},
						]
					: [],
		},
	}));
	const platform = calculateVisibilityMetrics({
		captures,
		observations,
		brands: [
			{ id: "brand", name: "测试品牌", aliases: [] },
			{ id: "competitor", name: "对照品牌", aliases: [] },
		],
		targetBrandId: "brand",
		targetDomains: ["brand.example"],
		promptIds: prompts.map((p) => p.id),
		contract,
	});
	const metrics = {
		contract,
		overall: calculateEqualWeightedOverall([platform], contract),
		perPlatform: { deepseek_api: platform },
		expectedSamples: 50,
		validSamples: 47,
		failedSamples: 3,
	};
	return { metrics, config: { project: { name: "测试品牌", aliases: [] }, prompts, repeats: 1 }, captures };
}

describe("reader metric explanations", () => {
	it("reconciles 50 → 47 → 44 without confusing search sources and citations", () => {
		const f = fixture(),
			before = JSON.stringify(f),
			guide = explainMeasurement(f.metrics, f.config, f.captures);
		expect(guide.counts).toEqual({ planned: 50, answered: 47, parsed: 44, failed: 3 });
		expect(f.metrics.overall.brandMentionRate).toBeCloseTo(2 / 44);
		expect(f.metrics.overall.monitoredBrandShare).toBeCloseTo(2 / 3);
		expect(guide.sources).toEqual({ withSearchSources: 41, withFinalCitations: 1, citationLinks: 5, unavailable: 6 });
		expect(guide.segments.find((s) => s.named)).toMatchObject({
			plannedQuestions: 4,
			eligibleQuestions: 2,
			mentionAnswers: 2,
			validAnswers: 2,
		});
		expect(guide.segments.find((s) => !s.named)).toMatchObject({ eligibleQuestions: 42, mentionRate: 0 });
		expect(guide.calculationRows.filter((r) => !r.included)).toHaveLength(6);
		expect(guide.calculationRows.reduce((sum, r) => sum + (r.monitoredMentions ?? 0), 0)).toBe(3);
		expect(JSON.stringify(f)).toBe(before);
	});
	it("formal limited platforms do not get a fabricated segmented score", () => {
		const f = fixture();
		f.metrics.contract = { ...contract, sampling: { ...contract.sampling, mode: "formal" } };
		const guide = explainMeasurement(f.metrics, f.config, f.captures);
		expect(guide.segments.every((s) => s.mentionRate === null)).toBe(true);
		expect(guide.calculationRows.every((r) => !r.included)).toBe(true);
	});
	it("matches only confirmed name/aliases and explains real failure causes", () => {
		expect(isNamedBrandQuestion(" TEST brand 的业务", { name: "Test Brand", aliases: [] })).toBe(true);
		expect(isNamedBrandQuestion("本地有何服务商", { name: "测试品牌", aliases: [] })).toBe(false);
		expect(failureExplanation("search_not_triggered").action).not.toContain("登录");
		expect(failureExplanation("quota_exceeded").reason).toBe("服务商额度不足");
	});
});
