import { describe, expect, it } from "vitest";
import { type AnswerAnalysis, analysisReferences, segmentAnswer, validateAnswerAnalysis } from "./answer-analysis";

// Synthetic annotation examples exist only in tests, never as runtime fallback answers.
const answer = "测试品牌A价格较低，但稳定性不足；关键业务更推荐测试品牌B。";
const brands = [
	{ id: "a", name: "测试品牌A", aliases: [] },
	{ id: "b", name: "测试品牌B", aliases: [] },
];
function fixture(): AnswerAnalysis {
	const evidence = [{ segmentId: "s1", quote: answer }];
	return {
		schemaVersion: "geo.answer-analysis.v1",
		status: "complete",
		answerType: "comparison",
		summary: { text: "原文对不同品牌有不同评价和适用场景。", evidence },
		keyPoints: [{ text: "关键业务倾向测试品牌B。", evidence }],
		sections: [
			{
				segmentIds: ["s1"],
				title: "比较与选择",
				kind: "comparison",
				summary: "原文比较价格与稳定性，并给出场景选择。",
				evidence,
			},
		],
		brands: [
			{
				brandId: "a",
				sentiment: "mixed",
				stance: "none",
				summary: { text: "价格与稳定性评价不同。", evidence },
				aspects: [
					{
						aspect: "价格",
						sentiment: "positive",
						assessment: "价格较低。",
						evidence: [{ segmentId: "s1", quote: "测试品牌A价格较低" }],
					},
					{
						aspect: "稳定性",
						sentiment: "negative",
						assessment: "稳定性不足。",
						evidence: [{ segmentId: "s1", quote: "测试品牌A价格较低，但稳定性不足" }],
					},
				],
				recommendations: [],
			},
			{
				brandId: "b",
				sentiment: "positive",
				stance: "conditional",
				summary: { text: "关键业务获得推荐。", evidence },
				aspects: [],
				recommendations: [{ stance: "conditional", reason: null, conditions: ["关键业务"], evidence }],
			},
		],
		comparisons: [
			{
				brandIds: ["a", "b"],
				aspect: "关键业务适配",
				conclusion: "原文倾向测试品牌B。",
				favoredBrandId: "b",
				evidence,
			},
		],
		limitations: [],
		ambiguities: [],
	};
}
describe("完整回答语义契约", () => {
	it("区分维度情感与条件推荐，偏移由原文解析而不是模型生成", () => {
		const result = validateAnswerAnalysis(fixture(), answer, brands);
		expect(result.status).toBe("valid");
		expect(result.result?.coverage).toEqual({ totalSegments: 1, analyzedSegments: 1 });
		expect(result.result?.analysis.brands[0].aspects.map((item) => item.sentiment)).toEqual(["positive", "negative"]);
		for (const span of result.result?.evidenceSpans ?? []) expect(answer.slice(span.start, span.end)).toBe(span.quote);
		expect(analysisReferences(fixture()).length).toBeGreaterThan(5);
	});
	it("按自然段保留完整 Unicode 原文，不切断代理对或规范化空格", () => {
		const source = `前言😀\n\n${"文".repeat(1799)}😀结论\r\n\r\n末段`;
		const segments = segmentAnswer(source);
		expect(segments.map((segment) => segment.text).join("")).toBe(source);
		expect(segments[0].text).toBe("前言😀\n\n");
		for (const segment of segments) {
			expect(source.slice(segment.start, segment.end)).toBe(segment.text);
			expect(segment.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
		}
		expect(segmentAnswer("句\n\n".repeat(15000)).length).toBeLessThanOrEqual(120);
	});
	it("拒绝超长与空输入，不截断后假称完整", () => {
		expect(() => segmentAnswer("x".repeat(60001))).toThrow("不会截断");
		expect(() => segmentAnswer(" \n")).toThrow();
	});
	it("保留没有品牌的正文与结尾，漏段或重复段只能为待核对", () => {
		const source = `${answer}\n\n这是非品牌结尾。`;
		const value = fixture();
		expect(validateAnswerAnalysis(value, source, brands)).toMatchObject({
			status: "needs_review",
			result: { coverage: { totalSegments: 2, analyzedSegments: 1 } },
		});
		value.sections.push({
			segmentIds: ["s2"],
			title: "结尾",
			kind: "other",
			summary: "非品牌结尾。",
			evidence: [{ segmentId: "s2", quote: "这是非品牌结尾。" }],
		});
		expect(validateAnswerAnalysis(value, source, brands).status).toBe("valid");
		value.sections.push(value.sections[0]);
		expect(validateAnswerAnalysis(value, source, brands).status).toBe("needs_review");
	});
	it("拒绝虚构引文、重复引文定位和跨段冒用", () => {
		const value = fixture();
		value.summary.evidence = [{ segmentId: "s1", quote: "编造的评价" }];
		expect(validateAnswerAnalysis(value, answer, brands)).toMatchObject({ status: "needs_review", result: null });
		const repeated = `${answer}${answer}`;
		expect(validateAnswerAnalysis(fixture(), repeated, brands).result).toBeNull();
		const cross = fixture();
		cross.sections[0].segmentIds = ["s2"];
		expect(validateAnswerAnalysis(cross, `${answer}\n\n结尾`, brands).result).toBeNull();
	});
	it("拒绝品牌白名单外 id、品牌遗漏与竞品评价移植", () => {
		const unknown = fixture();
		unknown.brands[0].brandId = "invented";
		expect(validateAnswerAnalysis(unknown, answer, brands).result).toBeNull();
		const missing = fixture();
		missing.brands.pop();
		expect(validateAnswerAnalysis(missing, answer, brands).status).toBe("needs_review");
		const moved = fixture();
		moved.brands[0].aspects[0].evidence = [{ segmentId: "s1", quote: "关键业务更推荐测试品牌B" }];
		expect(validateAnswerAnalysis(moved, answer, brands).result).toBeNull();
	});
	it("条件缺失与模型自报歧义不升级为完整，结构外评分不被接受", () => {
		const value = fixture();
		value.brands[1].recommendations[0].conditions = [];
		expect(validateAnswerAnalysis(value, answer, brands).status).toBe("needs_review");
		expect(validateAnswerAnalysis({ ...fixture(), ambiguities: ["语义有歧义"] }, answer, brands).status).toBe(
			"needs_review",
		);
		expect(validateAnswerAnalysis({ ...fixture(), score: 99 }, answer, brands).status).toBe("failed");
	});
});
