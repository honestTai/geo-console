import type { AgentMessage } from "@geo/agent-runtime";
import { openMemorySqliteDatabase } from "@geo/core/sqlite";
import { expect, it } from "vitest";
import { finishLocalToolCall, recoverLocalToolResults, startLocalToolCall } from "./local-turn-recovery";

it("recovers durable results without re-execution and marks ambiguous side effects for human review", async () => {
	const db = openMemorySqliteDatabase();
	try {
		await db.query("INSERT INTO projects(id,name,region,language) VALUES('p','fixture','test','en')");
		await db.query("INSERT INTO agent_sessions(id,project_id,title) VALUES('s','p','fixture')");
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				timestamp: 1,
				usage: { input: 0, output: 0, totalTokens: 0 },
				content: [{ type: "toolCall", id: "call-1", name: "read_project_context", arguments: {} }],
			},
		];
		await startLocalToolCall(db, "s", "call-1", "read_project_context", {});
		expect((await recoverLocalToolResults(db, "s", messages)).uncertain).toBe(true);
		await finishLocalToolCall(db, "s", "call-1", { content: [{ type: "text", text: "persisted result" }] }, false);
		const restored = await recoverLocalToolResults(db, "s", messages);
		expect(restored.uncertain).toBe(false);
		expect(restored.messages.at(-1)).toMatchObject({
			role: "toolResult",
			isError: false,
			content: [{ type: "text", text: "persisted result" }],
		});
		await expect(startLocalToolCall(db, "s", "call-1", "read_project_context", {})).rejects.toThrow();
		expect((await recoverLocalToolResults(db, "s", restored.messages)).messages).toEqual(restored.messages);
	} finally {
		await db.close();
	}
});
