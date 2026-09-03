import type { QueryCapture } from "@geo/evidence";
import { describe, expect, it } from "vitest";
import { buildEvidenceIndex, isReasoningScratch, stripInlineMarkdown, stripTrackingFragment } from "./report";
import { citationMarks, evidenceLookup, renderReportHtml } from "./report-snapshots";

const capture = (id: string, attempt: number, capturedAt: string): QueryCapture =>
	({
		schemaVersion: "geo.query-capture.v1",
		captureId: id,
		jobId: `job-${id}`,
		projectId: "project",
		promptId: "prompt",
		prompt: "成都有哪些厂家能提供钢结构数控钻孔设备？",
		engine: "deepseek_api",
		captureMode: "llm_search_api",
		attempt,
		capturedAt,
		locale: "zh-CN",
		region: "成都",
		status: "complete",
		answerText: "成都远景数控最对口。I found good info on the company. Let me search more for other companies.",
		brandMatches: [{ brandId: "project", matchedAlias: "远景数控", position: 1 }],
		sources: [
			{
				url: "https://www.yjcnc.com/Ab_index_gci_7.html#ws_call_id=call_02_abc",
				domain: "yjcnc.com",
				title: "官网",
				position: 1,
				isCitation: true,
			},
		],
		queryFanOut: [],
		evidence: {
			captureNodeId: "node",
			screenshotObjectKey: null,
			traceObjectKey: null,
			pageUrl: "https://api.deepseek.com/",
		},
		adapterVersion: "test",
		contentHash: "a".repeat(64),
		failureCode: null,
		failureMessage: null,
	}) as unknown as QueryCapture;

describe("报告引用可读化", () => {
	it("证据索引按采集时间稳定编号并保留可读字段", () => {
		const index = buildEvidenceIndex(
			[capture("b", 2, "2026-09-02T02:00:00.000Z"), capture("a", 1, "2026-09-02T01:00:00.000Z")],
			[
				{
					id: "snap",
					role: "customer",
					url: "https://www.yjcnc.com/",
					domain: "yjcnc.com",
					title: "官网首页",
					content: "",
					structuredData: [],
				},
			],
			{ id: "audit", result: { checkedAt: "2026-09-01T03:15:00.000Z" } as never },
		);
		expect(index.map((entry) => [entry.n, entry.id, entry.kind])).toEqual([
			[1, "a", "capture"],
			[2, "b", "capture"],
			[3, "snap", "snapshot"],
			[4, "audit", "audit"],
		]);
		expect(index[0].platformLabel).toBe("DeepSeek 联网 API");
		expect(index[0].question).toContain("钢结构");
		expect(index[0].sourceUrls).toEqual(["https://www.yjcnc.com/Ab_index_gci_7.html"]);
		expect(index[2].url).toBe("https://www.yjcnc.com/");
	});

	it("过滤模型夹带的英文推理草稿并去掉追踪片段", () => {
		expect(isReasoningScratch("I found good info on 成都远景数控. Let me search more.")).toBe(true);
		expect(isReasoningScratch("Let me also check other manufacturers")).toBe(true);
		expect(isReasoningScratch("成都远景数控被列为第 1 位并称为最对口。")).toBe(false);
		expect(isReasoningScratch("Chengdu Vista CNC is the most relevant supplier for steel structures.")).toBe(false);
		expect(stripTrackingFragment("https://a.example/p#ws_call_id=call_01_x")).toBe("https://a.example/p");
		expect(stripTrackingFragment("https://a.example/p#section")).toBe("https://a.example/p#section");
	});

	it("品牌描述摘录去掉 Markdown 标记与表格竖线", () => {
		expect(stripInlineMarkdown("1. **成都远景数控**（远景）：专注 [数控设备](https://x.example) 的厂家。")).toBe(
			"1. 成都远景数控（远景）：专注 数控设备 的厂家。",
		);
		expect(stripInlineMarkdown("| 远景数控 | 钢结构钻孔 | 成都 |")).toBe("远景数控，钢结构钻孔，成都");
		expect(stripInlineMarkdown("远景数控** 的报告以证据编号引用")).toBe("远景数控 的报告以证据编号引用");
	});

	it("报告 HTML 用 [n] 上标引用并附带证据索引表", () => {
		const captures = [capture("a", 1, "2026-09-02T01:00:00.000Z")];
		const evidenceIndex = buildEvidenceIndex(captures);
		const payload = {
			batch: {
				metrics: { overall: { brandMentionRate: 0.5 }, perPlatform: { deepseek_api: { brandMentionRate: 0.5 } } },
			},
			report: {
				analysis: {
					executive: { headline: "标题", summary: "摘要" },
					promptRows: [],
					sourceDomains: [],
					evidenceIndex,
				},
				findings: [],
				tasks: [],
			},
			agentNarrative: {
				executiveSummary: "叙述",
				reputation: {
					overall: "positive",
					summary: "正向",
					positiveSignals: [
						{
							statement: "被列为第 1 位",
							sourceStatus: "cited",
							sourceUrls: ["https://www.yjcnc.com/Ab_index_gci_7.html#ws_call_id=call_02_abc"],
							evidenceIds: ["a"],
						},
					],
					negativeSignals: [],
				},
				geoRecommendations: [
					{
						priority: "high",
						title: "补齐参数",
						action: "建型号页",
						rationale: "缺参数",
						evidenceIds: ["a", "unknown"],
					},
				],
				limitations: [],
			},
			providerDisclosures: [],
			blackBoxStatement: "声明",
		};
		const lookup = evidenceLookup(payload);
		expect(citationMarks(["a", "unknown"], lookup)).toContain("[1][unknown]");
		const html = renderReportHtml({
			id: "snapshot",
			title: "客户 - 售前快审",
			report_type: "quick_audit",
			created_at: "2026-09-02T04:00:00.000Z",
			payload,
		});
		expect(html).toContain('<sup class="cite">[1]</sup>');
		expect(html).not.toContain("ws_call_id");
		expect(html).toContain("高优先级");
		expect(html).toContain('<table class="evidence-index">');
		expect(html).toContain("DeepSeek 联网 API");
		expect(html).toContain("第 1 次");
	});
});
