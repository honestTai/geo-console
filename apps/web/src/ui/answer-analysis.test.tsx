import type { AnswerAnalysisResult } from "@geo/evidence";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnswerAnalysisContent, HighlightedAnswer } from "./answer-analysis";

describe("完整语义分析展示", () => {
	it("原文高亮使用 UTF-16 切片，安全转义 HTML，不解释模型指令", () => {
		const answer = "😀前言 <script>alert(1)</script> 结论";
		const quote = "<script>alert(1)</script>";
		const start = answer.indexOf(quote);
		const html = renderToStaticMarkup(
			<HighlightedAnswer answer={answer} span={{ segmentId: "s1", quote, start, end: start + quote.length }} />,
		);
		expect(html).toContain("😀前言");
		expect(html).toContain("<mark>&lt;script&gt;alert(1)&lt;/script&gt;</mark>");
		expect(html).not.toContain("<script>");
		const mismatch = renderToStaticMarkup(
			<HighlightedAnswer answer={answer} span={{ segmentId: "s1", quote, start: 0, end: 1 }} />,
		);
		expect(mismatch).not.toContain("<mark>");
	});
	it("非品牌回答仍展示全文、观点与限制，不制造排名、品牌评价或情感分", () => {
		const evidence = [{ segmentId: "s1", quote: "测试原文" }];
		const result: AnswerAnalysisResult = {
			analysis: {
				schemaVersion: "geo.answer-analysis.v1",
				status: "complete",
				answerType: "informational",
				summary: { text: "只做事实说明。", evidence },
				keyPoints: [{ text: "这是说明而非推荐。", evidence }],
				sections: [{ segmentIds: ["s1"], title: "全文说明", kind: "explanation", summary: "没有品牌推荐。", evidence }],
				brands: [],
				comparisons: [],
				limitations: [],
				ambiguities: [],
			},
			evidenceSpans: [{ ...evidence[0], start: 0, end: 4 }],
			coverage: { totalSegments: 1, analyzedSegments: 1 },
		};
		const html = renderToStaticMarkup(<AnswerAnalysisContent result={result} brands={[]} onEvidence={() => {}} />);
		expect(html).toContain("全文分段解读");
		expect(html).toContain("查看原文");
		expect(html).toContain("原文分段覆盖 1/1");
		expect(html).toContain("不代表分析准确率");
		expect(html).not.toContain("100%");
	});
});
