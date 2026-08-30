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

	it("接受带原始响应索引的云端联网采集", () => {
		expect(
			queryCaptureSchema.safeParse({
				...completeCapture,
				schemaVersion: "geo.query-capture.v2",
				engine: "kimi_api",
				captureMode: "llm_search_api",
				sourceVisibility: "available",
				fanoutVisibility: "unavailable",
				evidence: {
					endpoint: "https://api.moonshot.cn/v1/chat/completions",
					rawResponseObjectKey: "raw/capture-1.json",
					requestId: "req-1",
				},
				model: "kimi-k2.5",
				protocol: "moonshot-chat-tools",
				searchToolVersion: "moonshot/web-search:latest",
				executorId: "cloud-worker:test",
				usage: { totalTokens: 128 },
				costMicros: 10,
				latencyMs: 1200,
			}).success,
		).toBe(true);
	});

	it("拒绝把元宝组合口径伪装成 App 回答", () => {
		expect(
			queryCaptureSchema.safeParse({
				...completeCapture,
				schemaVersion: "geo.query-capture.v2",
				engine: "yuanbao_hunyuan",
				captureMode: "llm_search_api",
				sourceVisibility: "available",
				fanoutVisibility: "unavailable",
				evidence: {
					endpoint: "https://api.wsa.cloud.tencent.com/SearchPro",
					rawResponseObjectKey: "raw/capture-1.json",
					requestId: "req-1",
				},
				model: "hunyuan-turbos-latest",
				protocol: "yuanbao-app",
				searchToolVersion: "SearchPro",
				executorId: "cloud-worker:test",
				usage: null,
				costMicros: null,
				latencyMs: 1200,
			}).success,
		).toBe(false);
	});
});
