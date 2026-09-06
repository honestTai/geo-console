import { describe, expect, it } from "vitest";
import {
	DeepSeekSearchAdapter,
	DoubaoSearchAdapter,
	KimiSearchAdapter,
	QwenSearchAdapter,
	YuanbaoHunyuanSearchAdapter,
} from "./index";
import type { AdapterDependencies, ProviderConfig } from "./types";

const config = (providerId: ProviderConfig["providerId"], overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
	providerId,
	endpoint: "https://provider.example/v1",
	model: "provider-model",
	protocol: "provider-protocol",
	searchToolVersion: "web-search-v1",
	apiKey: "test-key",
	...overrides,
});

const input = {
	prompt: "成都有哪些值得考虑的企业服务商？",
	region: "成都",
	locale: "zh-CN",
	brands: [{ id: "brand", name: "真实品牌", aliases: [] }],
};

function dependencies(
	responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
): AdapterDependencies {
	let clock = 0;
	return {
		now: () => (clock += 10),
		fetch: (async () => {
			const next = responses.shift();
			if (!next) throw new Error("测试响应队列已耗尽");
			return new Response(JSON.stringify(next.body), {
				status: next.status ?? 200,
				headers: { "content-type": "application/json", ...next.headers },
			});
		}) as typeof fetch,
	};
}

describe("五平台联网采集契约", () => {
	it.each([DeepSeekSearchAdapter, DoubaoSearchAdapter])(
		"Responses 只测量最终回答；浏览记录不冒充引用，queries 数组可追溯",
		async (Adapter) => {
			const adapter = new Adapter(
				config(Adapter === DeepSeekSearchAdapter ? "deepseek_api" : "doubao_api"),
				dependencies([
					{
						body: {
							status: "completed",
							output_text: "不可信的汇总中间文本",
							output: [
								{
									type: "reasoning",
									content: [{ type: "reasoning_text", text: "内部推理中出现真实品牌，不是最终回答" }],
								},
								{ type: "message", role: "assistant", content: [{ type: "output_text", text: "我正在搜索真实品牌" }] },
								{
									type: "web_search_call",
									status: "completed",
									action: { type: "search", queries: ["用户问题", "扩展问题"] },
								},
								{
									type: "web_search_call",
									status: "completed",
									action: { type: "open_page", url: "https://read.example/page#ws_call_id=tracking" },
								},
								{ type: "web_search_call", status: "failed", action: { url: "https://failed.example" } },
								{
									type: "message",
									role: "assistant",
									status: "completed",
									content: [
										{
											type: "output_text",
											text: "最终公开回答。[资料](https://cited.example/page)",
											annotations: [{ url: "https://cited.example/page" }],
										},
									],
								},
							],
						},
					},
				]),
			);
			const result = await adapter.capture(input);
			expect(result.status).toBe("complete");
			expect(result.answerText).toBe("最终公开回答。[资料](https://cited.example/page)");
			expect(result.brandMatches).toEqual([]);
			expect(result.queryFanOut).toEqual(["用户问题", "扩展问题"]);
			expect(result.sources).toEqual([
				expect.objectContaining({ url: "https://cited.example/page", isCitation: true }),
				expect.objectContaining({ url: "https://read.example/page", isCitation: false }),
			]);
		},
	);
	it("普通回答中的 URL 不能冒充已经执行了联网工具", async () => {
		const adapter = new DeepSeekSearchAdapter(
			config("deepseek_api"),
			dependencies([
				{
					body: {
						output: [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "正文", annotations: [{ url: "https://example.com" }] }],
							},
						],
					},
				},
			]),
		);
		expect((await adapter.capture(input)).status).toBe("search_not_triggered");
	});
	it("未完成的响应和只有推理的响应不能计为成功回答", async () => {
		for (const response of [
			{ status: "incomplete", output_text: "被截断的正文" },
			{ output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "不是回答" }] }] },
		]) {
			const adapter = new DeepSeekSearchAdapter(
				config("deepseek_api"),
				dependencies([
					{
						body: {
							...response,
							output: [...(response.output ?? []), { type: "web_search_call", status: "completed" }],
						},
					},
				]),
			);
			expect((await adapter.capture(input)).status).toBe("no_answer");
		}
	});
	it("DeepSeek 强制搜索并保存来源", async () => {
		const adapter = new DeepSeekSearchAdapter(
			config("deepseek_api"),
			dependencies([
				{
					body: {
						id: "resp-1",
						output_text: "真实品牌值得考虑。",
						output: [
							{ type: "web_search_call", action: { query: "成都 企业服务商" } },
							{
								type: "message",
								content: [
									{
										type: "output_text",
										text: "真实品牌值得考虑。",
										annotations: [{ url: "https://brand.example/case", title: "案例" }],
									},
								],
							},
						],
						usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
					},
				},
			]),
		);
		const result = await adapter.capture(input);
		expect(result.status).toBe("complete");
		expect(result.queryFanOut).toEqual(["成都 企业服务商"]);
		expect(result.sources[0]?.domain).toBe("brand.example");
		expect(result.brandMatches[0]?.position).toBe(1);
	});

	it("Kimi 严格执行 Formula 工具循环", async () => {
		const adapter = new KimiSearchAdapter(
			config("kimi_api", { searchToolVersion: "moonshot/web-search:latest" }),
			dependencies([
				{ body: { tools: [{ type: "function", function: { name: "web_search", parameters: {} } }] } },
				{
					body: {
						id: "chat-1",
						choices: [
							{
								message: {
									role: "assistant",
									content: null,
									tool_calls: [
										{
											id: "call-1",
											type: "function",
											function: { name: "web_search", arguments: '{"query":"成都服务商"}' },
										},
									],
								},
							},
						],
					},
				},
				{ body: { context: { output: '{"results":[{"url":"https://brand.example","title":"品牌"}]}' } } },
				{
					body: {
						id: "chat-2",
						choices: [{ message: { role: "assistant", content: "真实品牌值得考虑。" } }],
						usage: { total_tokens: 20 },
					},
				},
			]),
		);
		const result = await adapter.capture(input);
		expect(result.status).toBe("complete");
		expect(result.queryFanOut).toEqual(["成都服务商"]);
		expect(result.usage?.searchRequests).toBe(1);
	});

	it("豆包 Responses 未出现搜索证据时保留真实失败", async () => {
		const adapter = new DoubaoSearchAdapter(
			config("doubao_api"),
			dependencies([{ body: { id: "resp-1", output_text: "模型记忆回答", output: [] } }]),
		);
		const result = await adapter.capture(input);
		expect(result.status).toBe("search_not_triggered");
		expect(result.answerText).toBeNull();
	});

	it("通义原生协议读取 search_info 并识别引用角标", async () => {
		const adapter = new QwenSearchAdapter(
			config("qwen_api"),
			dependencies([
				{
					body: {
						request_id: "qwen-1",
						output: {
							choices: [{ message: { content: "真实品牌值得考虑。[ref_1]" } }],
							search_info: {
								search_results: [{ index: 1, title: "案例", url: "https://brand.example/case" }],
								search_queries: ["成都服务商"],
							},
						},
						usage: { total_tokens: 30 },
					},
				},
			]),
		);
		const result = await adapter.capture(input);
		expect(result.status).toBe("complete");
		expect(result.sources[0]?.isCitation).toBe(true);
		expect(result.requestId).toBe("qwen-1");
	});

	it("元宝始终标记为搜索源加混元合成", async () => {
		const adapter = new YuanbaoHunyuanSearchAdapter(
			config("yuanbao_hunyuan", {
				endpoint: "https://api.wsa.cloud.tencent.com/SearchPro",
				secondaryEndpoint: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
				secondaryApiKey: "hunyuan-key",
			}),
			dependencies([
				{
					body: {
						Response: {
							RequestId: "wsa-1",
							Pages: [JSON.stringify({ title: "案例", url: "https://brand.example/case", passage: "真实内容" })],
						},
					},
				},
				{ body: { choices: [{ message: { content: "真实品牌值得考虑。[1]" } }], usage: { total_tokens: 40 } } },
			]),
		);
		const result = await adapter.capture(input);
		expect(result.status).toBe("complete");
		expect(result.protocol).toBe("yuanbao-search+hunyuan-synthesis");
		expect(result.sources[0]?.isCitation).toBe(true);
	});

	it("鉴权失败不会切换其他模型", async () => {
		const adapter = new DeepSeekSearchAdapter(
			config("deepseek_api"),
			dependencies([{ status: 401, body: { error: { message: "invalid key" } } }]),
		);
		const result = await adapter.capture(input);
		expect(result.status).toBe("auth_required");
		expect(result.failureCode).toBe("authentication_failed");
	});

	it.each([
		[429, { error: { message: "rate limit" } }, "rate_limited"],
		[400, { error: { code: "model_not_found", message: "model unavailable" } }, "model_unavailable"],
		[400, { error: { code: "invalid_request", message: "unknown tool field" } }, "protocol_changed"],
	] as const)("区分限流、模型下线和协议变化：HTTP %s", async (status, body, expected) => {
		const adapter = new DeepSeekSearchAdapter(config("deepseek_api"), dependencies([{ status, body }]));
		expect((await adapter.capture(input)).status).toBe(expected);
	});

	it("请求超时保留 timeout 状态", async () => {
		const adapter = new DeepSeekSearchAdapter(config("deepseek_api"), {
			now: () => 0,
			fetch: (async () => {
				throw new DOMException("timed out", "TimeoutError");
			}) as typeof fetch,
		});
		const result = await adapter.capture(input);
		expect(result.status).toBe("timeout");
		expect(result.failureCode).toBe("provider_timeout");
	});

	it("已执行搜索但未开放来源时不伪造引用", async () => {
		const adapter = new DeepSeekSearchAdapter(
			config("deepseek_api"),
			dependencies([
				{
					body: {
						output_text: "真实品牌值得考虑。",
						output: [{ type: "web_search_call", action: { query: "成都服务商" } }],
					},
				},
			]),
		);
		const result = await adapter.capture(input);
		expect(result.status).toBe("complete");
		expect(result.sourceVisibility).toBe("unavailable");
		expect(result.sources).toEqual([]);
	});
});
