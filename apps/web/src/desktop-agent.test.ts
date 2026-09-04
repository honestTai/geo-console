import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { pendingDesktopToolCalls } from "./desktop-agent";

describe("桌面 Agent 恢复", () => {
	it("只重放尚未保存 toolResult 的工具调用", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-a", name: "read_project_context", arguments: {} },
					{ type: "toolCall", id: "call-b", name: "web_search", arguments: { query: "GEO" } },
				],
				api: "openai-responses",
				provider: "hrouter",
				model: "gpt-5.6-sol",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call-a",
				toolName: "read_project_context",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
		];

		expect(pendingDesktopToolCalls(messages)).toEqual([
			{ id: "call-b", name: "web_search", arguments: { query: "GEO" } },
		]);
	});
});
