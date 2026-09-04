import type { AgentTool } from "@earendil-works/pi-agent-core";
import { migrateDatabase, openMemoryDatabase, writeEncryptedCredential } from "@geo/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createEvidenceReadTools, knownEvidenceIds } from "./agent";
import {
	createWebSearchTool,
	getWebSearchTestStatus,
	listWebSearchEvidencePage,
	parseWebSearchResponse,
	performWebSearch,
	resetToolChoiceMemory,
	testWebSearch,
	verifyCompetitors,
} from "./web-search";

const searchedBody = {
	output: [
		{ type: "web_search_call", status: "completed", action: { type: "search", query: "工业除尘设备 选型 问题" } },
		{
			type: "message",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: "买家通常会问设备处理风量、能耗与售后响应时间。",
					annotations: [
						{ type: "url_citation", url: "https://example.com/guide", title: "选型指南" },
						{ type: "url_citation", url: "https://example.com/guide", title: "重复来源" },
						{ type: "url_citation", url: "ftp://bad.example/x", title: "非 HTTP" },
					],
				},
			],
		},
	],
	usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
};

const notTriggeredBody = {
	output: [
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "我无法联网。", annotations: [] }] },
	],
	usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

function pick(tools: AgentTool[], name: string): AgentTool {
	const tool = tools.find((item) => item.name === name);
	if (!tool) throw new Error(`缺少工具 ${name}`);
	return tool;
}

function fakeFetch(status: number, body: unknown, calls: Array<Record<string, unknown>> = []): typeof fetch {
	return (async (_url: string | URL | Request, init?: RequestInit) => {
		calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

/** 按顺序返回不同响应的 fetch，用于模拟“先失败后成功”等序列。 */
function sequenceFetch(
	responses: Array<{ status: number; body: unknown }>,
	calls: Array<Record<string, unknown>> = [],
): typeof fetch {
	let index = 0;
	return (async (_url: string | URL | Request, init?: RequestInit) => {
		calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
		const response = responses[Math.min(index, responses.length - 1)];
		index += 1;
		return new Response(JSON.stringify(response.body), {
			status: response.status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

async function seedProject() {
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await database.query(
		`INSERT INTO projects (id,name,website_url,domain,region,language,industry,status)
		 VALUES ('project','客户','https://brand.example','brand.example','成都','zh-CN','工业除尘','active')`,
	);
	await database.query(
		`INSERT INTO projects (id,name,website_url,domain,region,language,status)
		 VALUES ('other','别的客户','https://other.example','other.example','成都','zh-CN','active')`,
	);
	await writeEncryptedCredential(database, "hrouter_api_key", "hrouter-key-1234567890", "default");
	await database.query(
		`INSERT INTO settings (key,value) VALUES ('organization:default:hrouter_config','{"baseUrl":"https://hrouter.test/v1","model":"gpt-5.4","thinkingLevel":"low"}'::jsonb)`,
	);
	return database;
}

beforeEach(() => resetToolChoiceMemory());

describe("联网搜索响应解析", () => {
	it("提取 web_search_call、归纳正文并按 URL 去重来源", () => {
		const parsed = parseWebSearchResponse(searchedBody);
		expect(parsed.searchCalls).toBe(1);
		expect(parsed.searchQueries).toEqual(["工业除尘设备 选型 问题"]);
		expect(parsed.answerText).toContain("处理风量");
		expect(parsed.sources).toEqual([{ url: "https://example.com/guide", title: "选型指南" }]);
	});

	it("没有 web_search_call 时判定为未触发，HTTP 失败判定为失败", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const base = { baseUrl: "https://hrouter.test/v1/", apiKey: "key", model: "gpt-5.4", query: "问题" };
		const notTriggered = await performWebSearch({ ...base, fetch: fakeFetch(200, notTriggeredBody, calls) });
		expect(notTriggered.status).toBe("search_not_triggered");
		expect(notTriggered.answerText).toBe("我无法联网。");
		expect(calls[0]?.tools).toEqual([{ type: "web_search" }]);
		expect(calls[0]?.tool_choice).toEqual({ type: "web_search" });
		expect(calls[0]?.max_output_tokens).toBe(1200);
		expect(calls[0]?.store).toBe(false);
		const failed = await performWebSearch({ ...base, fetch: fakeFetch(401, { error: { message: "bad key" } }) });
		expect(failed.status).toBe("failed");
		expect(failed.failureMessage).toContain("HTTP 401");
		const ok = await performWebSearch({ ...base, fetch: fakeFetch(200, searchedBody) });
		expect(ok.status).toBe("complete");
		expect(ok.toolChoice).toBe("forced");
		expect(ok.usage).toEqual({ inputTokens: 120, outputTokens: 80, totalTokens: 200 });
	});

	it("强制 tool_choice 被拒绝时回退为 auto，并按模型记住不再重复试探", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const base = { baseUrl: "https://hrouter.test/v1", apiKey: "key", model: "gpt-5.4-mini", query: "问题" };
		const first = await performWebSearch({
			...base,
			fetch: sequenceFetch(
				[
					{ status: 400, body: { error: { message: "unsupported tool_choice" } } },
					{ status: 200, body: searchedBody },
				],
				calls,
			),
		});
		expect(first.status).toBe("complete");
		expect(first.toolChoice).toBe("auto");
		expect(calls.map((call) => call.tool_choice)).toEqual([{ type: "web_search" }, "auto"]);
		const second = await performWebSearch({ ...base, fetch: fakeFetch(200, searchedBody, calls) });
		expect(second.toolChoice).toBe("auto");
		expect(calls).toHaveLength(3);
		expect(calls[2]?.tool_choice).toBe("auto");
	});

	it("与 tool_choice 无关的 4xx 不重复请求", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const outcome = await performWebSearch({
			baseUrl: "https://hrouter.test/v1",
			apiKey: "key",
			model: "gpt-5.4",
			query: "问题",
			fetch: fakeFetch(400, { error: { message: "max_output_tokens is invalid" } }, calls),
		});
		expect(outcome.status).toBe("failed");
		expect(calls).toHaveLength(1);
	});
});

describe("web_search Agent 工具", () => {
	it("成功搜索落为项目证据并可被 read_evidence 读取", async () => {
		const database = await seedProject();
		try {
			const allowed = await knownEvidenceIds(database, "project", null);
			const tool = createWebSearchTool(database, { organizationId: "default", projectId: "project" }, allowed, {
				fetch: fakeFetch(200, searchedBody),
			});
			expect(tool.executionMode).toBe("parallel");
			const result = await tool.execute("call", { query: "工业除尘设备买家会问什么？" } as never);
			const details = result.details as { evidenceId: string; sources: Array<{ url: string }>; remaining: number };
			expect(details.sources).toHaveLength(1);
			expect(details.remaining).toBe(9);
			expect(allowed.has(details.evidenceId)).toBe(true);
			expect((await knownEvidenceIds(database, "project", null)).has(details.evidenceId)).toBe(true);
			expect((await knownEvidenceIds(database, "other", null)).has(details.evidenceId)).toBe(false);
			const costs = await database.query<{ operation: string }>(
				"SELECT operation FROM project_costs WHERE project_id='project'",
			);
			expect(costs.rows.map((row) => row.operation)).toEqual(["web_search"]);
			const readTools = createEvidenceReadTools(database, "project", null, allowed);
			const index = await pick(readTools, "read_batch_evidence_index").execute("call", {} as never);
			expect((index.details as { webSearches: unknown[] }).webSearches).toHaveLength(1);
			const read = await pick(readTools, "read_evidence").execute("call", {
				evidenceIds: [details.evidenceId],
			} as never);
			const rows = (read.details as { webSearches: Array<{ query: string; status: string }> }).webSearches;
			expect(rows[0]?.query).toBe("工业除尘设备买家会问什么？");
			expect(rows[0]?.status).toBe("complete");
			const otherTools = createEvidenceReadTools(
				database,
				"other",
				null,
				await knownEvidenceIds(database, "other", null),
			);
			await expect(
				pick(otherTools, "read_evidence").execute("call", { evidenceIds: [details.evidenceId] } as never),
			).rejects.toThrow("未知或越权证据");
			const page = await listWebSearchEvidencePage(database, "project", {
				page: 1,
				pageSize: 20,
				offset: 0,
				search: null,
			});
			expect(page.total).toBe(1);
			expect(page.items[0]).toMatchObject({ id: details.evidenceId, status: "complete" });
			expect(page.items[0]?.sources).toEqual([{ url: "https://example.com/guide", title: "选型指南" }]);
			const focused = await listWebSearchEvidencePage(
				database,
				"project",
				{ page: 1, pageSize: 20, offset: 0, search: null },
				{ id: "missing" },
			);
			expect(focused.total).toBe(0);
		} finally {
			await database.close();
		}
	});

	it("第一次未触发抛错让模型换问法，连续两次后返回“联网不可用”且不再请求 HRouter", async () => {
		const database = await seedProject();
		try {
			const allowed = new Set<string>();
			const calls: Array<Record<string, unknown>> = [];
			const tool = createWebSearchTool(
				database,
				{ organizationId: "default", projectId: "project", model: "gpt-5.4-mini" },
				allowed,
				{ fetch: fakeFetch(200, notTriggeredBody, calls) },
			);
			await expect(tool.execute("call", { query: "任意问题" } as never)).rejects.toThrow("联网搜索未触发");
			const second = await tool.execute("call", { query: "换个问法" } as never);
			expect(second.details).toMatchObject({ unavailable: true });
			expect(String((second.details as { guidance: string }).guidance)).toContain("官网快照");
			const third = await tool.execute("call", { query: "再换一个" } as never);
			expect(third.details).toMatchObject({ unavailable: true });
			expect(calls).toHaveLength(2);
			expect(allowed.size).toBe(0);
			const rows = await database.query<{ status: string; model: string; answer_text: string | null }>(
				"SELECT status,model,answer_text FROM web_search_evidence WHERE project_id='project' ORDER BY created_at",
			);
			expect(rows.rows).toEqual([
				{ status: "search_not_triggered", model: "gpt-5.4-mini", answer_text: "我无法联网。" },
				{ status: "search_not_triggered", model: "gpt-5.4-mini", answer_text: "我无法联网。" },
			]);
			expect((await knownEvidenceIds(database, "project", null)).size).toBe(0);
		} finally {
			await database.close();
		}
	});

	it("超出回合与会话上限时直接拒绝，不再请求 HRouter", async () => {
		const database = await seedProject();
		try {
			const calls: Array<Record<string, unknown>> = [];
			const tool = createWebSearchTool(
				database,
				{ organizationId: "default", projectId: "project", sessionId: null },
				new Set(),
				{ fetch: fakeFetch(200, searchedBody, calls), budget: { perTurn: 2, perSession: 3, sessionUsed: 0 } },
			);
			await tool.execute("call", { query: "问题一" } as never);
			await tool.execute("call", { query: "问题二" } as never);
			await expect(tool.execute("call", { query: "问题三" } as never)).rejects.toThrow("本回合上限（2 次）");
			expect(calls).toHaveLength(2);
			const sessionTool = createWebSearchTool(
				database,
				{ organizationId: "default", projectId: "project" },
				new Set(),
				{
					fetch: fakeFetch(200, searchedBody, calls),
					budget: { perTurn: 8, perSession: 3, sessionUsed: 3 },
				},
			);
			await expect(sessionTool.execute("call", { query: "问题四" } as never)).rejects.toThrow("本会话上限（3 次）");
			expect(calls).toHaveLength(2);
		} finally {
			await database.close();
		}
	});

	it("并行调用会在网络请求前同步占用回合配额", async () => {
		const database = await seedProject();
		try {
			const calls: Array<Record<string, unknown>> = [];
			const tool = createWebSearchTool(database, { organizationId: "default", projectId: "project" }, new Set(), {
				fetch: fakeFetch(200, searchedBody, calls),
				budget: { perTurn: 2, perSession: null },
			});
			const results = await Promise.allSettled([
				tool.execute("one", { query: "问题一" } as never),
				tool.execute("two", { query: "问题二" } as never),
				tool.execute("three", { query: "问题三" } as never),
			]);
			expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
			expect(calls).toHaveLength(2);
		} finally {
			await database.close();
		}
	});

	it("未配置 HRouter 时拒绝搜索", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,status)
				 VALUES ('project','客户','https://brand.example','brand.example','成都','zh-CN','active')`,
			);
			const tool = createWebSearchTool(database, { organizationId: "default", projectId: "project" }, new Set());
			await expect(tool.execute("call", { query: "任意问题" } as never)).rejects.toThrow("HRouter API Key");
		} finally {
			await database.close();
		}
	});
});

describe("联网搜索测试与竞品核实", () => {
	it("测试结果按模型记住，工作台可读取默认模型与各模型状态", async () => {
		const database = await seedProject();
		try {
			const ok = await testWebSearch(database, "default", null, { fetch: fakeFetch(200, searchedBody) });
			expect(ok).toMatchObject({ model: "gpt-5.4", status: "ok", searchStatus: "complete", toolChoice: "forced" });
			const failed = await testWebSearch(database, "default", "gpt-5.4-mini", {
				fetch: fakeFetch(200, notTriggeredBody),
			});
			expect(failed).toMatchObject({ model: "gpt-5.4-mini", status: "failed", searchStatus: "search_not_triggered" });
			const status = await getWebSearchTestStatus(database, "default");
			expect(status.defaultModel).toBe("gpt-5.4");
			expect(status.tests["gpt-5.4"]?.status).toBe("ok");
			expect(status.tests["gpt-5.4-mini"]?.status).toBe("failed");
			expect(await database.query("SELECT id FROM web_search_evidence")).toMatchObject({ rows: [] });
		} finally {
			await database.close();
		}
	});

	it("竞品候选逐个联网核实：域名出现且同行业才算确认，其余标为待确认", async () => {
		const database = await seedProject();
		try {
			const calls: Array<Record<string, unknown>> = [];
			const verificationFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				calls.push(body);
				if (Array.isArray(body.tools)) {
					const query = String(body.input);
					const domain = query.includes("real.example") ? "https://real.example/about" : "https://news.example/post";
					return new Response(
						JSON.stringify({
							...searchedBody,
							output: [
								searchedBody.output[0],
								{
									type: "message",
									role: "assistant",
									content: [
										{
											type: "output_text",
											text: `关于 ${query.slice(0, 20)} 的归纳`,
											annotations: [{ type: "url_citation", url: domain, title: "来源" }],
										},
									],
								},
							],
						}),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						output_text: JSON.stringify({
							verdicts: [
								{ domain: "real.example", domainMatches: true, sameIndustry: true, note: "同为工业除尘设备制造商" },
								{
									domain: "other-trade.example",
									domainMatches: false,
									sameIndustry: false,
									note: "搜索结果是餐饮品牌",
								},
							],
						}),
					}),
					{ status: 200 },
				);
			}) as typeof fetch;
			const { results, unavailable } = await verifyCompetitors(database, {
				organizationId: "default",
				projectId: "project",
				industry: "工业除尘",
				businessSummary: "客户生产工业除尘设备",
				fetch: verificationFetch,
				competitors: [
					{ name: "真实竞品", domain: "real.example", aliases: [] },
					{ name: "猜错的", domain: "other-trade.example", aliases: [] },
				],
			});
			expect(unavailable).toBe(false);
			expect(results.get("real.example")).toMatchObject({ status: "confirmed", note: "同为工业除尘设备制造商" });
			expect(results.get("other-trade.example")).toMatchObject({ status: "domain_mismatch" });
			expect(results.get("real.example")?.evidenceId).toBeTruthy();
			const searches = calls.filter((call) => Array.isArray(call.tools));
			expect(searches).toHaveLength(2);
			const evidence = await database.query<{ status: string }>(
				"SELECT status FROM web_search_evidence WHERE project_id='project'",
			);
			expect(evidence.rows).toHaveLength(2);
		} finally {
			await database.close();
		}
	});

	it("联网不可用时竞品全部标为未核实，不阻断建档", async () => {
		const database = await seedProject();
		try {
			const { results, unavailable } = await verifyCompetitors(database, {
				organizationId: "default",
				projectId: "project",
				industry: null,
				businessSummary: "摘要",
				fetch: fakeFetch(200, notTriggeredBody),
				competitors: [{ name: "竞品", domain: "x.example", aliases: [] }],
			});
			expect(unavailable).toBe(true);
			expect(results.get("x.example")).toMatchObject({ status: "unverified" });
			expect(results.get("x.example")?.note).toContain("联网核实不可用");
		} finally {
			await database.close();
		}
	});
});
