import { describe, expect, it } from "vitest";
import { queryCaptureSchema } from "./schema";

const completeCapture = {
	schemaVersion: "geo.query-capture.v1",
	captureId: "capture-1",
	jobId: "job-1",
	projectId: "project-1",
	promptId: "prompt-1",
	prompt: "推荐一家企业 GEO 服务商",
	engine: "deepseek",
	captureMode: "consumer_surface",
	attempt: 1,
	capturedAt: "2026-08-30T05:00:00.000Z",
	locale: "zh-CN",
	region: "CN",
	status: "complete",
	answerText: "示例品牌提供企业 GEO 服务。",
	brandMatches: [{ brandId: "brand-1", matchedAlias: "示例品牌", position: 0 }],
	sources: [
		{
			url: "https://example.com/geo",
			domain: "example.com",
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
} as const;

describe("queryCaptureSchema", () => {
	it("接受带回答和证据的完整采集", () => {
		expect(queryCaptureSchema.parse(completeCapture).status).toBe("complete");
	});

	it("拒绝没有回答正文的完整采集", () => {
		expect(queryCaptureSchema.safeParse({ ...completeCapture, answerText: null }).success).toBe(false);
	});

	it("拒绝没有失败原因的异常采集", () => {
		expect(
			queryCaptureSchema.safeParse({
				...completeCapture,
				status: "login_required",
				answerText: null,
				failureCode: null,
			}).success,
		).toBe(false);
	});
});
