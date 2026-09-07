import { websiteScoreBreakdown, websiteScoreGuide } from "@geo/evidence";
import { describe, expect, it } from "vitest";
import { reportFollowup } from "./report-followup";

describe("reader action continuity", () => {
	it("preserves frozen paired results and approved tasks without recomputing from totals", () => {
		const payload = {
			report: {
				tasks: [
					{
						title: "核对发布页面",
						priority: "high",
						status: "published",
						owner: "内容负责人",
						acceptance_criteria: "保存快照后同条件复测",
						published_url: "https://example.com/test",
						evidence_ids: ["frozen"],
					},
				],
			},
			comparison: {
				pairedResults: [
					{
						provider_id: "deepseek_api",
						metric: "brandMentionRate",
						result: {
							status: "ready",
							previous: 0.1,
							current: 0.2,
							delta: 0.1,
							interval: [-0.02, 0.18],
							promptIds: ["p1", "p2"],
						},
					},
				],
				newSources: ["https://example.com/new"],
				lostSources: [],
			},
		};
		const before = JSON.stringify(payload),
			lines = reportFollowup(payload);
		expect(lines[0]).toMatchObject({
			title: "整改任务：核对发布页面",
			evidenceIds: ["frozen"],
			urls: ["https://example.com/test"],
		});
		expect(lines[1].title).toContain("DeepSeek");
		expect(lines[1].title).toContain("品牌提及率");
		expect(lines[1].detail).toContain("10.0 个百分点");
		expect(lines[1].detail).toContain("不能仅凭时间先后");
		expect(lines[2].detail).toContain("未再次出现不等于网页失效");
		expect(JSON.stringify(payload)).toBe(before);
	});
	it("explains real audit weights without assigning scores to missing evidence", () => {
		expect(
			websiteScoreBreakdown([
				{ status: "pass", weight: 20 },
				{ status: "warning", weight: 10 },
				{ status: "fail", weight: 10 },
				{ status: "skip", weight: 50 },
			]),
		).toBe("本次计分权重：25 / 40；共 3 项适用检查。");
		expect(websiteScoreGuide.formula).toContain("一半权重");
		expect(websiteScoreGuide.caution).toContain("不是零分");
	});
});
