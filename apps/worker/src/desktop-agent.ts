import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Database, type DesktopAgentTrigger, readEncryptedCredential } from "@geo/core";
import { z } from "zod";
import { getHRouterConfig } from "./hrouter";
import { AccessDeniedError } from "./rbac";
import { parseJsonColumn, sha256, stableJson } from "./utils";
import { WEB_SEARCH_LIMITS } from "./web-search";
import {
	appendEvent,
	createWorkbenchTools,
	getSession,
	loadSession,
	toolEventDetails,
	WORKBENCH_SYSTEM_PROMPT,
	type WorkbenchSession,
	webSearchPromptNote,
} from "./workbench";

const DESKTOP_LEASE_SECONDS = 60;
const DESKTOP_TOOL_LEASE_SECONDS = 180;
const MAX_RELAY_BODY_BYTES = 2_000_000;
const MAX_TRANSCRIPT_MESSAGE_BYTES = 500_000;
const MAX_TRANSCRIPT_BYTES = 4_000_000;

export class DesktopAgentConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DesktopAgentConflictError";
	}
}

const clientIdSchema = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9._:-]{8,128}$/);
const runSchema = z.object({
	runId: z.string().uuid(),
	clientId: clientIdSchema,
});
const desktopEventSchema = runSchema.extend({
	clientEventId: z.string().trim().min(8).max(200),
	type: z.enum(["assistant_delta", "assistant_message"]),
	payload: z.record(z.string(), z.unknown()),
});
const desktopMessageSchema = runSchema.extend({
	index: z.number().int().min(0).max(50_000),
	message: z.object({ role: z.enum(["user", "assistant", "toolResult"]), content: z.unknown() }).passthrough(),
});
const desktopToolSchema = runSchema.extend({
	toolCallId: z.string().trim().min(1).max(200),
	toolName: z.string().trim().min(1).max(120),
	args: z.record(z.string(), z.unknown()),
});
const desktopCompleteSchema = runSchema.extend({
	error: z.string().trim().max(2_000).nullable().optional(),
});
const relayBodySchema = z
	.object({
		input: z.array(z.unknown()).max(2_000),
	})
	.passthrough();

type DesktopToolSpec = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	executionMode: "sequential" | "parallel";
};

export type DesktopAgentRuntime = {
	runId: string;
	clientId: string;
	trigger: DesktopAgentTrigger;
	message: string | null;
	turnStartIndex: number;
	transcript: AgentMessage[];
	waiting: WorkbenchSession["waiting"];
	model: string;
	thinkingLevel: string;
	systemPrompt: string;
	tools: DesktopToolSpec[];
	session: Record<string, unknown>;
};

type DesktopActor = { userId: string | null; isSuperAdmin?: boolean };

function assertDesktopOwner(session: WorkbenchSession, actor: DesktopActor): void {
	if (session.execution_target !== "desktop") throw new Error("该会话不是桌面 Agent 会话");
	if (session.created_by !== actor.userId && !actor.isSuperAdmin)
		throw new AccessDeniedError("只能在创建该会话的桌面账号中运行 Agent");
}

async function assertDesktopRun(
	database: Database,
	sessionId: string,
	input: { runId: string; clientId: string },
	actor: DesktopActor,
): Promise<WorkbenchSession> {
	const session = await loadSession(database, sessionId);
	assertDesktopOwner(session, actor);
	if (
		session.desktop_run_id !== input.runId ||
		session.desktop_client_id !== input.clientId ||
		!session.desktop_lease_expires_at ||
		new Date(session.desktop_lease_expires_at).getTime() <= Date.now()
	)
		throw new DesktopAgentConflictError("桌面 Agent 回合租约已失效，请重新领取后继续");
	return session;
}

async function touchDesktopLease(
	database: Database,
	sessionId: string,
	runId: string,
	clientId: string,
): Promise<void> {
	const touched = await database.query(
		`UPDATE agent_sessions SET desktop_lease_expires_at=now()+interval '${DESKTOP_LEASE_SECONDS} seconds',updated_at=now()
		 WHERE id=$1 AND execution_target='desktop' AND desktop_run_id=$2 AND desktop_client_id=$3
		 AND desktop_lease_expires_at>now()`,
		[sessionId, runId, clientId],
	);
	if (touched.affectedRows !== 1) throw new DesktopAgentConflictError("桌面 Agent 回合租约已失效");
}

async function sessionSearchCount(database: Database, sessionId: string): Promise<number> {
	return Number(
		(
			await database.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM web_search_evidence WHERE session_id=$1",
				[sessionId],
			)
		).rows[0]?.count ?? 0,
	);
}

async function desktopTools(
	database: Database,
	session: WorkbenchSession,
	excludeToolCallId: string | null = null,
): Promise<AgentTool[]> {
	const turnSearches = Number(
		(
			await database.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM desktop_agent_tool_calls
				 WHERE session_id=$1 AND tool_name='web_search' AND created_at>=COALESCE($2,created_at)
				 AND ($3::text IS NULL OR tool_call_id<>$3)`,
				[session.id, session.last_turn_at, excludeToolCallId],
			)
		).rows[0]?.count ?? 0,
	);
	const control = {
		waiting: null,
		finished: null,
		plan: session.plan,
		currentBatchId: session.current_batch_id,
	};
	return createWorkbenchTools(
		database,
		session,
		control,
		async () => undefined,
		async () => undefined,
		{ sessionSearches: await sessionSearchCount(database, session.id), turnSearches },
	);
}

function toolSpecs(tools: AgentTool[]): DesktopToolSpec[] {
	return tools.map((tool) => ({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		executionMode: tool.executionMode ?? "parallel",
	}));
}

export async function claimDesktopTurn(
	database: Database,
	sessionId: string,
	input: unknown,
	actor: DesktopActor,
): Promise<DesktopAgentRuntime> {
	const { clientId } = z.object({ clientId: clientIdSchema }).parse(input);
	const current = await loadSession(database, sessionId);
	assertDesktopOwner(current, actor);
	const config = await getHRouterConfig(database, current.organization_id);
	const model = current.model ?? config.model;
	if (!model || !config.configured) throw new Error("请先配置 HRouter API Key 与 GPT 模型");
	const claimed = await database.transaction(async (transaction) => {
		const session = await loadSession(transaction, sessionId);
		assertDesktopOwner(session, actor);
		if (session.status !== "running" || !session.desktop_pending_trigger)
			throw new DesktopAgentConflictError("该会话当前没有待桌面执行的回合");
		if (
			session.desktop_run_id &&
			session.desktop_client_id !== clientId &&
			session.desktop_lease_expires_at &&
			new Date(session.desktop_lease_expires_at).getTime() > Date.now()
		)
			throw new DesktopAgentConflictError("该回合正在另一台桌面客户端运行");
		const runId = randomUUID();
		await transaction.query(
			`UPDATE agent_sessions SET desktop_run_id=$2,desktop_client_id=$3,
			 desktop_lease_expires_at=now()+interval '${DESKTOP_LEASE_SECONDS} seconds',
			 last_turn_at=CASE WHEN desktop_run_id IS NULL THEN now() ELSE last_turn_at END,updated_at=now()
			 WHERE id=$1`,
			[sessionId, runId, clientId],
		);
		return { session, runId };
	});
	const searches = await sessionSearchCount(database, sessionId);
	const tools = await desktopTools(database, claimed.session);
	return {
		runId: claimed.runId,
		clientId,
		trigger: claimed.session.desktop_pending_trigger as DesktopAgentTrigger,
		message: claimed.session.desktop_pending_message,
		turnStartIndex: claimed.session.desktop_turn_start_index ?? claimed.session.transcript.length,
		transcript: claimed.session.transcript,
		waiting: claimed.session.waiting,
		model,
		thinkingLevel: claimed.session.thinking_level ?? config.thinkingLevel,
		systemPrompt: `${WORKBENCH_SYSTEM_PROMPT}${webSearchPromptNote(claimed.session, searches)}`,
		tools: toolSpecs(tools),
		session: await getSession(database, sessionId),
	};
}

export async function heartbeatDesktopTurn(
	database: Database,
	sessionId: string,
	input: unknown,
	actor: DesktopActor,
): Promise<{ alive: true }> {
	const data = runSchema.parse(input);
	await assertDesktopRun(database, sessionId, data, actor);
	await touchDesktopLease(database, sessionId, data.runId, data.clientId);
	return { alive: true };
}

function validateDesktopEvent(data: z.infer<typeof desktopEventSchema>): void {
	const text = data.payload.text;
	if (typeof text !== "string" || text.length > 100_000) throw new Error("桌面 Agent 文本事件无效或过长");
	if (!Number.isInteger(Number(data.payload.turn)) || Number(data.payload.turn) < 1)
		throw new Error("桌面 Agent 文本事件缺少有效回合序号");
}

export async function recordDesktopEvent(
	database: Database,
	sessionId: string,
	input: unknown,
	actor: DesktopActor,
): Promise<{ seq: number; createdAt: string }> {
	const data = desktopEventSchema.parse(input);
	validateDesktopEvent(data);
	await assertDesktopRun(database, sessionId, data, actor);
	await touchDesktopLease(database, sessionId, data.runId, data.clientId);
	const createdAt = new Date().toISOString();
	const seq = await appendEvent(
		database,
		sessionId,
		data.type,
		{ ...data.payload, clientEventId: data.clientEventId },
		data.clientEventId,
	);
	return { seq, createdAt };
}

export async function recordDesktopMessage(
	database: Database,
	sessionId: string,
	input: unknown,
	actor: DesktopActor,
): Promise<{ saved: true }> {
	const data = desktopMessageSchema.parse(input);
	const encoded = JSON.stringify(data.message);
	if (Buffer.byteLength(encoded) > MAX_TRANSCRIPT_MESSAGE_BYTES) throw new Error("桌面 Agent 单条消息超过保存上限");
	await assertDesktopRun(database, sessionId, data, actor);
	await database.transaction(async (transaction) => {
		const session = await loadSession(transaction, sessionId);
		assertDesktopOwner(session, actor);
		if (session.desktop_run_id !== data.runId || session.desktop_client_id !== data.clientId)
			throw new DesktopAgentConflictError("桌面 Agent 回合已经失效");
		if (data.index < session.transcript.length) {
			if (stableJson(session.transcript[data.index]) !== stableJson(data.message))
				throw new DesktopAgentConflictError("桌面 Agent 消息序号与已保存内容冲突");
			return;
		}
		if (data.index !== session.transcript.length) throw new DesktopAgentConflictError("桌面 Agent 消息必须按顺序保存");
		if (Buffer.byteLength(JSON.stringify(session.transcript)) + Buffer.byteLength(encoded) > MAX_TRANSCRIPT_BYTES)
			throw new Error("桌面 Agent 会话上下文超过保存上限，请新建会话");
		const toolCallId = (data.message as { toolCallId?: unknown }).toolCallId;
		const clearsWaiting =
			data.message.role === "toolResult" &&
			typeof toolCallId === "string" &&
			session.waiting?.toolCallId === toolCallId;
		await transaction.query(
			`UPDATE agent_sessions SET transcript=transcript || $4::jsonb,
				 waiting=CASE WHEN $5 THEN NULL ELSE waiting END,
				 desktop_lease_expires_at=now()+interval '${DESKTOP_LEASE_SECONDS} seconds',updated_at=now()
				 WHERE id=$1 AND desktop_run_id=$2 AND desktop_client_id=$3`,
			[sessionId, data.runId, data.clientId, JSON.stringify([data.message]), clearsWaiting],
		);
	});
	return { saved: true };
}

type StoredToolCall = {
	tool_name: string;
	args_hash: string;
	status: "running" | "complete" | "failed";
	result: unknown;
	error_message: string | null;
	lease_expires_at: string | null;
};

async function claimDesktopToolCall(
	database: Database,
	sessionId: string,
	data: z.infer<typeof desktopToolSchema>,
): Promise<{ cached: boolean; result?: Record<string, unknown>; isError?: boolean; error?: string }> {
	const argsHash = sha256(stableJson(data.args));
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The locked claim covers cached, failed, active, expired and quota branches atomically.
	return database.transaction(async (transaction) => {
		await transaction.query("SELECT id FROM agent_sessions WHERE id=$1 FOR UPDATE", [sessionId]);
		const existing = (
			await transaction.query<StoredToolCall>(
				"SELECT tool_name,args_hash,status,result,error_message,lease_expires_at FROM desktop_agent_tool_calls WHERE session_id=$1 AND tool_call_id=$2 FOR UPDATE",
				[sessionId, data.toolCallId],
			)
		).rows[0];
		if (existing) {
			if (existing.tool_name !== data.toolName || existing.args_hash !== argsHash)
				throw new DesktopAgentConflictError("相同工具调用 ID 的名称或参数发生变化");
			if (existing.status === "complete")
				return { cached: true, result: parseJsonColumn(existing.result as string | Record<string, unknown>) };
			if (existing.status === "failed")
				return { cached: true, isError: true, error: existing.error_message ?? "工具执行失败" };
			if (existing.lease_expires_at && new Date(existing.lease_expires_at).getTime() > Date.now())
				throw new DesktopAgentConflictError("该工具调用仍在执行");
			await transaction.query(
				`UPDATE desktop_agent_tool_calls SET status='running',error_message=NULL,
				 lease_expires_at=now()+interval '${DESKTOP_TOOL_LEASE_SECONDS} seconds',updated_at=now()
				 WHERE session_id=$1 AND tool_call_id=$2`,
				[sessionId, data.toolCallId],
			);
			return { cached: false };
		}
		if (data.toolName === "web_search") {
			const counts = (
				await transaction.query<{ turn_count: number; session_count: number }>(
					`SELECT
					 (SELECT count(*)::int FROM desktop_agent_tool_calls c
					  JOIN agent_sessions s ON s.id=c.session_id
					  WHERE c.session_id=$1 AND c.tool_name='web_search' AND c.created_at>=COALESCE(s.last_turn_at,c.created_at)) AS turn_count,
					 (SELECT count(*)::int FROM desktop_agent_tool_calls
					  WHERE session_id=$1 AND tool_name='web_search') AS session_count`,
					[sessionId],
				)
			).rows[0];
			if (Number(counts?.turn_count ?? 0) >= WEB_SEARCH_LIMITS.workbenchTurn)
				throw new DesktopAgentConflictError(`联网搜索已达本回合上限（${WEB_SEARCH_LIMITS.workbenchTurn} 次）`);
			if (Number(counts?.session_count ?? 0) >= WEB_SEARCH_LIMITS.workbenchSession)
				throw new DesktopAgentConflictError(`联网搜索已达本会话上限（${WEB_SEARCH_LIMITS.workbenchSession} 次）`);
		}
		await transaction.query(
			`INSERT INTO desktop_agent_tool_calls
			 (id,session_id,tool_call_id,tool_name,args,args_hash,status,lease_expires_at)
			 VALUES ($1,$2,$3,$4,$5::jsonb,$6,'running',now()+interval '${DESKTOP_TOOL_LEASE_SECONDS} seconds')`,
			[randomUUID(), sessionId, data.toolCallId, data.toolName, JSON.stringify(data.args), argsHash],
		);
		return { cached: false };
	});
}

function errorToolResult(message: string): AgentToolResult<null> {
	return { content: [{ type: "text", text: message.slice(0, 2_000) }], details: null };
}

export async function executeDesktopTool(
	database: Database,
	sessionId: string,
	input: unknown,
	actor: DesktopActor,
	signal?: AbortSignal,
): Promise<{ result: AgentToolResult<unknown>; isError: boolean; cached: boolean }> {
	const data = desktopToolSchema.parse(input);
	const session = await assertDesktopRun(database, sessionId, data, actor);
	await touchDesktopLease(database, sessionId, data.runId, data.clientId);
	const claimed = await claimDesktopToolCall(database, sessionId, data);
	if (claimed.cached)
		return claimed.isError
			? { result: errorToolResult(claimed.error ?? "工具执行失败"), isError: true, cached: true }
			: { result: claimed.result as unknown as AgentToolResult<unknown>, isError: false, cached: true };
	const turnSearches = Number(
		(
			await database.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM desktop_agent_tool_calls
				 WHERE session_id=$1 AND tool_name='web_search' AND created_at>=COALESCE($2,created_at)
				 AND tool_call_id<>$3`,
				[session.id, session.last_turn_at, data.toolCallId],
			)
		).rows[0]?.count ?? 0,
	);
	const control = {
		waiting: null as WorkbenchSession["waiting"],
		finished: null as string | null,
		plan: session.plan,
		currentBatchId: session.current_batch_id,
	};
	const persistControl = async () => {
		const updated = await database.query(
			`UPDATE agent_sessions SET plan=$4::jsonb,current_batch_id=$5,waiting=$6::jsonb,
			 desktop_lease_expires_at=now()+interval '${DESKTOP_LEASE_SECONDS} seconds',updated_at=now()
			 WHERE id=$1 AND desktop_run_id=$2 AND desktop_client_id=$3`,
			[
				sessionId,
				data.runId,
				data.clientId,
				JSON.stringify(control.plan),
				control.currentBatchId,
				control.waiting ? JSON.stringify(control.waiting) : null,
			],
		);
		if (updated.affectedRows !== 1) throw new DesktopAgentConflictError("桌面 Agent 回合已经失效");
	};
	const tools = await createWorkbenchTools(
		database,
		session,
		control,
		persistControl,
		(type, payload) => appendEvent(database, sessionId, type, payload).then(() => undefined),
		{
			sessionSearches: await sessionSearchCount(database, session.id),
			turnSearches,
		},
	);
	const tool = tools.find((item) => item.name === data.toolName);
	if (!tool) throw new AccessDeniedError("工具不在 AI 工作台白名单中");
	const eventBase = `${data.runId}:${data.toolCallId}`;
	await appendEvent(
		database,
		sessionId,
		"tool_start",
		{ clientEventId: `${eventBase}:start`, toolCallId: data.toolCallId, tool: data.toolName, args: data.args },
		`${eventBase}:start`,
	);
	let updateQueue = Promise.resolve();
	let updateIndex = 0;
	const toolLeaseTimer = setInterval(() => {
		void database
			.query(
				`UPDATE desktop_agent_tool_calls SET lease_expires_at=now()+interval '${DESKTOP_TOOL_LEASE_SECONDS} seconds',updated_at=now()
				 WHERE session_id=$1 AND tool_call_id=$2 AND status='running'`,
				[sessionId, data.toolCallId],
			)
			.catch(() => undefined);
	}, 30_000);
	try {
		const result = await tool.execute(data.toolCallId, data.args as never, signal, (partial) => {
			updateIndex += 1;
			const clientEventId = `${eventBase}:update:${updateIndex}`;
			updateQueue = updateQueue.then(() =>
				appendEvent(
					database,
					sessionId,
					"tool_update",
					{
						clientEventId,
						toolCallId: data.toolCallId,
						tool: data.toolName,
						details: toolEventDetails(data.toolName, partial.details),
					},
					clientEventId,
				).then(() => undefined),
			);
		});
		await updateQueue;
		await database.query(
			`UPDATE desktop_agent_tool_calls SET status='complete',result=$3::jsonb,error_message=NULL,
			 lease_expires_at=NULL,completed_at=now(),updated_at=now() WHERE session_id=$1 AND tool_call_id=$2`,
			[sessionId, data.toolCallId, JSON.stringify(result)],
		);
		await appendEvent(
			database,
			sessionId,
			"tool_end",
			{
				clientEventId: `${eventBase}:end`,
				toolCallId: data.toolCallId,
				tool: data.toolName,
				isError: false,
				details: toolEventDetails(data.toolName, result.details),
			},
			`${eventBase}:end`,
		);
		return { result, isError: false, cached: false };
	} catch (error) {
		await updateQueue;
		const message = error instanceof Error ? error.message.slice(0, 2_000) : "工具执行失败";
		await database.query(
			`UPDATE desktop_agent_tool_calls SET status='failed',error_message=$3,lease_expires_at=NULL,
			 completed_at=now(),updated_at=now() WHERE session_id=$1 AND tool_call_id=$2`,
			[sessionId, data.toolCallId, message],
		);
		await appendEvent(
			database,
			sessionId,
			"tool_end",
			{
				clientEventId: `${eventBase}:end`,
				toolCallId: data.toolCallId,
				tool: data.toolName,
				isError: true,
				details: message,
			},
			`${eventBase}:end`,
		);
		return { result: errorToolResult(message), isError: true, cached: false };
	} finally {
		clearInterval(toolLeaseTimer);
	}
}

export async function completeDesktopTurn(
	database: Database,
	sessionId: string,
	input: unknown,
	actor: DesktopActor,
): Promise<{ status: string; session: Record<string, unknown> }> {
	const data = desktopCompleteSchema.parse(input);
	const session = await assertDesktopRun(database, sessionId, data, actor);
	const finish = (
		await database.query<{ summary: string | null }>(
			`SELECT args->>'summary' AS summary FROM desktop_agent_tool_calls
			 WHERE session_id=$1 AND tool_name='finish' AND status='complete' AND created_at>=COALESCE($2,created_at)
			 ORDER BY created_at DESC LIMIT 1`,
			[sessionId, session.last_turn_at],
		)
	).rows[0]?.summary;
	let status = "idle";
	if (data.error) status = "failed";
	else if (session.waiting?.kind === "user") status = "waiting_user";
	else if (session.waiting) status = "waiting_job";
	else if (finish) status = "done";
	const updated = await database.query(
		`UPDATE agent_sessions SET status=$4,desktop_pending_trigger=NULL,desktop_pending_message=NULL,
		 desktop_turn_start_index=NULL,desktop_run_id=NULL,desktop_client_id=NULL,desktop_lease_expires_at=NULL,
		 error_message=$5,updated_at=now() WHERE id=$1 AND desktop_run_id=$2 AND desktop_client_id=$3`,
		[sessionId, data.runId, data.clientId, status, data.error ?? null],
	);
	if (updated.affectedRows !== 1) throw new DesktopAgentConflictError("桌面 Agent 回合已经由其他客户端结束");
	if (data.error) await appendEvent(database, sessionId, "error", { message: data.error });
	else if (status === "done") await appendEvent(database, sessionId, "finished", { summary: finish });
	else if (status === "idle") await appendEvent(database, sessionId, "turn_idle", {});
	return { status, session: await getSession(database, sessionId) };
}

function responseTools(tools: AgentTool[]): Array<Record<string, unknown>> {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}

function readUsageEvent(line: string): { input: number; output: number; total: number } | null {
	if (!line.startsWith("data:")) return null;
	const data = line.slice(5).trim();
	if (!data || data === "[DONE]") return null;
	try {
		const event = JSON.parse(data) as { type?: string; response?: { usage?: Record<string, unknown> } };
		if (event.type !== "response.completed" || !event.response?.usage) return null;
		const usage = event.response.usage;
		const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
		const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
		const total = typeof usage.total_tokens === "number" ? usage.total_tokens : input + output;
		return { input, output, total };
	} catch {
		return null;
	}
}

async function recordRelayUsage(
	database: Database,
	session: WorkbenchSession,
	usage: { input: number; output: number; total: number },
): Promise<void> {
	if (usage.total <= 0) return;
	await database.transaction(async (transaction) => {
		const current = await loadSession(transaction, session.id);
		const next = {
			input: (current.usage?.input ?? 0) + usage.input,
			output: (current.usage?.output ?? 0) + usage.output,
			totalTokens: (current.usage?.totalTokens ?? 0) + usage.total,
		};
		await transaction.query("UPDATE agent_sessions SET usage=$2::jsonb,updated_at=now() WHERE id=$1", [
			session.id,
			JSON.stringify(next),
		]);
		await transaction.query(
			`INSERT INTO project_costs (id,project_id,batch_id,provider_id,operation,usage,cost_micros)
			 VALUES ($1,$2,$3,'hrouter_gpt','workbench',$4::jsonb,NULL)`,
			[
				randomUUID(),
				session.project_id,
				session.current_batch_id,
				JSON.stringify({ inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.total }),
			],
		);
	});
}

/** 流式代理只接受桌面 Agent 当前租约，服务端覆盖模型、系统提示、工具表与缓存键。 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Relay validation, upstream streaming, backpressure and usage extraction share one response lifecycle.
export async function relayDesktopAgentResponse(
	database: Database,
	sessionId: string,
	runInput: unknown,
	bodyInput: unknown,
	actor: DesktopActor,
	response: ServerResponse,
	signal?: AbortSignal,
	dependencies: { fetch?: typeof globalThis.fetch } = {},
): Promise<void> {
	const run = runSchema.parse(runInput);
	const session = await assertDesktopRun(database, sessionId, run, actor);
	await touchDesktopLease(database, sessionId, run.runId, run.clientId);
	const encoded = JSON.stringify(bodyInput);
	if (Buffer.byteLength(encoded) > MAX_RELAY_BODY_BYTES) throw new Error("桌面 Agent 模型上下文超过代理上限");
	const body = relayBodySchema.parse(bodyInput);
	const config = await getHRouterConfig(database, session.organization_id);
	const apiKey = await readEncryptedCredential(database, "hrouter_api_key", session.organization_id);
	const model = session.model ?? config.model;
	if (!apiKey || !model) throw new Error("请先配置 HRouter API Key 与 GPT 模型");
	const searches = await sessionSearchCount(database, sessionId);
	const tools = await desktopTools(database, session);
	const upstream = await (dependencies.fetch ?? globalThis.fetch)(`${config.baseUrl.replace(/\/$/, "")}/responses`, {
		method: "POST",
		signal,
		headers: {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
			"x-session-id": sessionId,
			"x-client-request-id": sessionId,
		},
		body: JSON.stringify({
			model,
			instructions: `${WORKBENCH_SYSTEM_PROMPT}${webSearchPromptNote(session, searches)}`,
			input: body.input,
			tools: responseTools(tools),
			tool_choice: "auto",
			parallel_tool_calls: true,
			reasoning: { effort: session.thinking_level ?? config.thinkingLevel, summary: "auto" },
			include: ["reasoning.encrypted_content"],
			max_output_tokens: 12_000,
			prompt_cache_key: sessionId,
			stream: true,
			store: false,
		}),
	});
	response.writeHead(upstream.status, {
		"content-type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	response.flushHeaders();
	if (!upstream.body) {
		response.end();
		return;
	}
	const decoder = new TextDecoder();
	let lineBuffer = "";
	let usage: { input: number; output: number; total: number } | null = null;
	try {
		for await (const chunk of upstream.body) {
			if (response.destroyed) break;
			if (!response.write(chunk)) await once(response, "drain");
			lineBuffer += decoder.decode(chunk, { stream: true });
			const lines = lineBuffer.split(/\r?\n/);
			lineBuffer = lines.pop() ?? "";
			for (const line of lines) usage = readUsageEvent(line) ?? usage;
		}
		lineBuffer += decoder.decode();
		for (const line of lineBuffer.split(/\r?\n/)) usage = readUsageEvent(line) ?? usage;
	} finally {
		if (!response.destroyed) response.end();
	}
	if (usage) await recordRelayUsage(database, session, usage);
}

export function desktopAgentRuntimeLimits() {
	return { leaseSeconds: DESKTOP_LEASE_SECONDS, toolLeaseSeconds: DESKTOP_TOOL_LEASE_SECONDS };
}
