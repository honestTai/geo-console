import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { renderReportDocx } from "./docx";
import type { ReportAnalysis } from "./report";
import { freezeReferencedEvidence } from "./report-evidence";
import { renderReaderReport } from "./report-reader";
import { getEvidenceReference } from "./website-evidence";

function snapshot() {
	return {
		title: "仅测试的报告",
		created_at: "2026-09-07T12:00:00Z",
		payload: {
			renderContract: { templateVersion: "zzgeo.report.v4" },
			batch: {
				config: {
					project: { name: "测试客户", aliases: [], domain: "" },
					prompts: [{ id: "p", question: "采购问题" }],
					repeats: 1,
				},
				metrics: {
					contract: { sampling: { mode: "quick" } },
					overall: { status: "unavailable", brandMentionRate: null, citationRate: null },
					perPlatform: {},
					expectedSamples: 1,
					validSamples: 1,
					failedSamples: 0,
				},
				captures: [
					{
						captureId: "answer",
						status: "complete",
						prompt: "采购问题",
						answerText: "保留原文 <script>alert(1)</script>，不将搜索等同引用。",
						captureMode: "llm_search_api",
						sourceVisibility: "available",
						sources: [
							{ url: "https://cited.example/one", title: "实际引用", isCitation: true },
							{ url: "https://searched.example/two", title: "仅搜索", isCitation: false },
							{ url: "javascript:alert(1)", title: "危险链接", isCitation: false },
						],
					},
				],
			},
			report: {
				analysis: {
					evidenceIndex: [
						{
							id: "answer",
							n: 1,
							kind: "capture",
							question: "采购问题",
							platformLabel: "测试平台",
							capturedAt: "2026-09-07T12:00:00Z",
							sourceUrls: [],
						},
					],
					gaps: [],
					webPages: [],
					executive: { summary: "仅测试摘要" },
				},
				findings: [],
			},
			agentNarrative: {
				executiveSummary: "初步结果，不判断排名。",
				evidenceIds: ["answer"],
				geoRecommendations: [],
				limitations: [],
			},
		},
	};
}

describe("reader-facing reports and reference resolution", () => {
	it("PDF and Word preserve the actual content strategy without filling legacy plans from a template", () => {
		const input = snapshot();
		const article = {
			title: "测试短答",
			recommendation_title: "补充一项已核实事实",
			summary: "直接回答实际问题",
			target_prompt_ids: ["p"],
			evidence_ids: ["answer"],
			published_url: null,
			publication_plan: {
				purpose: "说明已核实事实",
				audience: "此问题的提问者",
				problem: "缺少直接回答",
				contentStrategy: {
					format: "单条问答 <script>",
					rationale: "证据支持直接说明，不必写长文",
					lengthApproach: "只说明这一项事实与其边界",
				},
				channels: [],
				acceptance: [],
			},
		};
		const withArticle = { ...input, payload: { ...input.payload, articles: [article] } };
		expect(renderReaderReport(withArticle)).toContain("单条问答 &lt;script&gt;");
		expect(renderReaderReport(withArticle)).toContain("只说明这一项事实与其边界");
		expect(renderReportDocx(withArticle).toString("utf8")).toContain("不必写长文");
		const legacy = {
			...withArticle,
			payload: {
				...withArticle.payload,
				articles: [{ ...article, publication_plan: { ...article.publication_plan, contentStrategy: undefined } }],
			},
		};
		expect(renderReaderReport(legacy)).toContain("尚未记录内容形式与篇幅依据");
		expect(renderReportDocx(legacy).toString("utf8")).toContain("尚未记录内容形式与篇幅依据");
	});

	it("links every citation to full evidence, separates sources, escapes hostile content and has no internal report jargon", () => {
		const input = snapshot(),
			before = JSON.stringify(input),
			html = renderReaderReport(input);
		const $ = load(html);
		for (const a of $("a[href^='#']").toArray())
			expect($(decodeURIComponent($(a).attr("href") ?? "")).length).toBeGreaterThan(0);
		expect(html).toContain("&lt;script&gt;");
		expect($("script")).toHaveLength(0);
		expect($("a[href^='javascript:']")).toHaveLength(0);
		expect(html).toContain("搜索过程中出现的页面（不算最终引用）");
		expect(html).toContain("1 个回答有明确最终引用");
		expect(html).toContain("官网引用率");
		expect(html.indexOf('id="problems"')).toBeLessThan(html.indexOf('id="metrics"'));
		expect(html).not.toMatch(/\b(?:V2|MetricSnapshot|limited|unavailable)\b/);
		expect(JSON.stringify(input)).toBe(before);
	});
	it("Word uses real bookmarks, external hyperlink relationships and an embedded PNG", () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		);
		const doc = renderReportDocx(snapshot(), png).toString("utf8");
		expect(doc).toContain('w:anchor="evidence_1"');
		expect(doc).toContain('w:bookmarkStart w:id="1"');
		expect(doc).toContain('Target="https://cited.example/one"');
		expect(doc).not.toContain('Target="javascript:');
		expect(doc).toContain("word/media/audit.png");
		expect(doc).toContain('r:embed="readerAuditImage"');
	});
	it("freezes older referenced website text and refuses cross-customer or missing evidence", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			await db.query(
				"INSERT INTO projects(id,name,region,language) VALUES ('p','仅测试客户','测试地区','zh-CN'),('other','其他测试客户','测试地区','zh-CN')",
			);
			await db.query(
				"INSERT INTO website_snapshots(id,project_id,url,domain,content_text,content_hash,fetched_at) VALUES ('old','p','https://example.com','example.com','当时保存的原文','hash',now()),('foreign','other','https://example.org','example.org','其他客户文本','hash',now())",
			);
			const analysis = { evidenceIndex: [], gaps: [] } as unknown as ReportAnalysis;
			await freezeReferencedEvidence(db, "p", analysis, ["old"]);
			expect(analysis.supplementalEvidence?.[0].content).toBe("当时保存的原文");
			expect(analysis.evidenceIndex[0]).toMatchObject({ id: "old", n: 1, kind: "snapshot" });
			expect(await getEvidenceReference(db, "p", "old")).toMatchObject({ kind: "snapshot" });
			await expect(getEvidenceReference(db, "p", "foreign")).rejects.toThrow("没有这条证据");
			await expect(freezeReferencedEvidence(db, "p", analysis, ["foreign"])).rejects.toThrow("无法在本客户");
		} finally {
			await db.close();
		}
	}, 20_000);
});
