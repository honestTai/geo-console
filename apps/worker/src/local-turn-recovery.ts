import { randomUUID } from "node:crypto";
import { type AgentMessage, pendingDesktopToolCalls } from "@geo/agent-runtime";
import type { Database } from "@geo/core";
import { sha256, stableJson } from "./utils";

/** Durable domain checkpoints, not the graph's per-invocation MemorySaver. */
export async function recoverLocalToolResults(
	database: Database,
	sessionId: string,
	messages: AgentMessage[],
): Promise<{ messages: AgentMessage[]; uncertain: boolean }> {
	const restored = [...messages];
	let uncertain = false;
	for (const call of pendingDesktopToolCalls(messages)) {
		const row = (
			await database.query<{
				tool_name: string;
				args_hash: string;
				status: string;
				result: { content: Array<{ type: "text"; text: string }>; isError?: boolean; terminate?: boolean } | null;
			}>(
				"SELECT tool_name,args_hash,status,result FROM desktop_agent_tool_calls WHERE session_id=$1 AND tool_call_id=$2",
				[sessionId, call.id],
			)
		).rows[0];
		const result =
			row?.status === "complete" && row.tool_name === call.name && row.args_hash === sha256(stableJson(call.arguments))
				? row.result
				: null;
		if (!result) uncertain = true;
		restored.push({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			timestamp: Date.now(),
			content: result?.content ?? [
				{
					type: "text",
					text: "进程在工具结果落盘前中断，执行结果不确定。禁止自动重复写入；成员应先核查已有任务与证据，再决定是否继续。",
				},
			],
			isError: result?.isError ?? true,
			...(result?.terminate ? { terminate: true } : {}),
		});
	}
	return { messages: restored, uncertain };
}

export async function startLocalToolCall(
	database: Database,
	sessionId: string,
	id: string,
	name: string,
	args: unknown,
): Promise<void> {
	// Duplicate call IDs are never executed again, including after an ambiguous crash.
	await database.query(
		"INSERT INTO desktop_agent_tool_calls(id,session_id,tool_call_id,tool_name,args,args_hash,status) VALUES($1,$2,$3,$4,$5::jsonb,$6,'running')",
		[randomUUID(), sessionId, id, name, JSON.stringify(args), sha256(stableJson(args))],
	);
}
export async function finishLocalToolCall(
	database: Database,
	sessionId: string,
	id: string,
	result: unknown,
	isError: boolean,
): Promise<void> {
	await database.query(
		"UPDATE desktop_agent_tool_calls SET status='complete',result=$3::jsonb,completed_at=now(),updated_at=now() WHERE session_id=$1 AND tool_call_id=$2",
		[sessionId, id, JSON.stringify({ ...(result as object), isError })],
	);
}
