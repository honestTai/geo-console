import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunActivityPanel, runActivityStatus } from "../components/Monitoring";
import { WebsiteAudit } from "../components/WebsiteAudit";
import type { Batch, Project } from "../types";

describe("explainable monitoring and optional-website UI", () => {
	it("distinguishes future sampling windows from active work", () => {
		const batch = {
			id: "test",
			kind: "baseline",
			created_at: "2026-09-07T09:49:00Z",
			status: "running",
			captures: [],
			metrics: { expectedSamples: 150 },
			captureProgress: {
				pending: 100,
				active: 0,
				completed: 50,
				failed: 0,
				next_at: "2099-01-01T00:00:00Z",
				blockedProviders: [],
			},
		} as unknown as Batch;
		const html = renderToStaticMarkup(
			<RunActivityPanel batch={batch} summary={batch} busy={false} onRerun={async () => {}} />,
		);
		expect(html).toContain("等待下一采样时段");
		expect(html).toContain("不是卡住");
	});
	it("terminal copy does not pretend semantic metrics are already available", () => {
		expect(runActivityStatus("partial", false, 50)).toContain("失败或未执行");
		expect(runActivityStatus("complete", false, 50)).toContain("语义解析状态");
	});
	it("no website is not a zero score and offers profile editing", () => {
		const project = { id: "test", name: "测试客户", website_url: null, websiteAudits: [] } as unknown as Project;
		const html = renderToStaticMarkup(<WebsiteAudit project={project} refresh={async () => {}} />);
		expect(html).toContain("暂未填写官网");
		expect(html).toContain("暂无官网可供检查");
		expect(html).not.toContain("ant-statistic");
		expect(html).not.toContain("开始真实审计");
	});
});
