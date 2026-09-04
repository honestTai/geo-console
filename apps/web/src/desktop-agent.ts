import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import { contentText, type Model } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { ApiError, api, post } from "./api";
import type { AgentSessionWaiting, WorkbenchEvent, WorkbenchSession } from "./types";

const DESKTOP_CLIENT_KEY = "geo.desktop.agent.client-id";
const RELAY_BASE_URL = "https://desktop-agent.invalid/v1";

type DesktopToolSpec = {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	executionMode: "sequential" | "parallel";
};

type DesktopRuntime = {
	runId: string;
	clientId: string;
	trigger: "user" | "resume" | "answer";
	message: string | null;
	turnStartIndex: number;
	transcript: AgentMessage[];
	waiting: AgentSessionWaiting | null;
	model: string;
	thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh";
	systemPrompt: string;
	tools: DesktopToolSpec[];
	session: WorkbenchSession;
};

type StreamHead = { event: "head"; status: number; content_type: string; request_id: string | null };
type StreamChunk = { event: "chunk"; data: number[] };
type StreamEnd = { event: "end" };
type StreamError = { event: "error"; message: string };
type NativeStreamEvent = StreamHead | StreamChunk | StreamEnd | StreamError;

export type DesktopAgentHandlers = {
	onEvent(event: WorkbenchEvent): void;
	onSession(session: WorkbenchSession): void;
	onError(error: Error): void;
};

type ActiveDesktopRun = { agent: Agent | null; promise: Promise<void> };
const activeRuns = new Map<string, ActiveDesktopRun>();

function desktopClientId(): string {
	const existing = localStorage.getItem(DESKTOP_CLIENT_KEY);
	if (existing) return existing;
	const value = `desktop:${crypto.randomUUID()}`;
	localStorage.setItem(DESKTOP_CLIENT_KEY, value);
	return value;
}

function modelFor(runtime: DesktopRuntime): Model<"openai-responses"> {
	return {
		id: runtime.model,
		name: runtime.model,
		api: "openai-responses",
		provider: "hrouter",
		baseUrl: RELAY_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 12_000,
	};
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
	if (typeof init?.body === "string") return init.body;
	if (input instanceof Request) return input.clone().text();
	return "{}";
}

async function nativeRelayFetch(runtime: DesktopRuntime, body: string, signal?: AbortSignal | null): Promise<Response> {
	const [{ Channel, invoke }] = await Promise.all([import("@tauri-apps/api/core")]);
	return new Promise<Response>((resolve, reject) => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
		let settledHead = false;
		let ended = false;
		const requestId = `agent:${crypto.randomUUID()}`;
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const abort = () => {
			if (ended) return;
			ended = true;
			void invoke("cancel_agent_response", { requestId }).catch(() => undefined);
			const error = new DOMException("The operation was aborted", "AbortError");
			if (settledHead) streamController?.error(error);
			else reject(error);
		};
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				streamController = controller;
			},
		});
		const channel = new Channel<NativeStreamEvent>();
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Channel lifecycle must distinguish headers, chunks, completion, errors and aborts in one ordered handler.
		channel.onmessage = (event) => {
			if (event.event === "head") {
				settledHead = true;
				resolve(
					new Response(stream, {
						status: event.status,
						headers: {
							"content-type": event.content_type,
							...(event.request_id ? { "x-request-id": event.request_id } : {}),
						},
					}),
				);
			} else if (event.event === "chunk") streamController?.enqueue(Uint8Array.from(event.data));
			else if (event.event === "end") {
				if (ended) return;
				ended = true;
				cleanup();
				streamController?.close();
			} else {
				if (ended) return;
				ended = true;
				cleanup();
				const error = new Error(event.message);
				if (settledHead) streamController?.error(error);
				else reject(error);
			}
		};
		void invoke("stream_agent_response", {
			sessionId: (runtime.session as WorkbenchSession).id,
			runId: runtime.runId,
			clientId: runtime.clientId,
			requestId,
			body,
			onEvent: channel,
		}).catch((reason) => {
			if (ended) return;
			ended = true;
			cleanup();
			const error = reason instanceof Error ? reason : new Error(String(reason));
			if (settledHead) streamController?.error(error);
			else reject(error);
		});
		if (signal) {
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

function relayFetch(runtime: DesktopRuntime): typeof globalThis.fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const body = await requestBody(input, init);
		if (window.location.protocol === "geo:") return nativeRelayFetch(runtime, body, init?.signal);
		return fetch(`/api/workbench/sessions/${runtime.session.id}/desktop/responses`, {
			method: "POST",
			credentials: "same-origin",
			signal: init?.signal,
			headers: { "content-type": "application/json", "x-geo-client": "desktop" },
			body: JSON.stringify({ runId: runtime.runId, clientId: runtime.clientId, request: JSON.parse(body) }),
		});
	}) as typeof globalThis.fetch;
}

function errorText(result: AgentToolResult<unknown>): string {
	return (
		result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n") || "工具执行失败"
	);
}

function localEvent(
	type: string,
	payload: Record<string, unknown>,
	clientEventId: string,
	localSeq: number,
): WorkbenchEvent {
	return {
		seq: Number.MAX_SAFE_INTEGER - 100_000 + localSeq,
		type,
		payload: { ...payload, clientEventId },
		created_at: new Date().toISOString(),
	};
}

async function requestDesktopTool(
	runtime: DesktopRuntime,
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ result: AgentToolResult<unknown>; isError: boolean }> {
	while (!signal?.aborted) {
		try {
			return await api<{ result: AgentToolResult<unknown>; isError: boolean }>(
				`/api/workbench/sessions/${runtime.session.id}/desktop/tools`,
				{
					method: "POST",
					signal,
					body: JSON.stringify({
						runId: runtime.runId,
						clientId: runtime.clientId,
						toolCallId,
						toolName,
						args,
					}),
				},
			);
		} catch (error) {
			if (!(error instanceof ApiError) || error.status !== 409 || !error.message.includes("仍在执行")) throw error;
			await new Promise((resolve) => window.setTimeout(resolve, 500));
		}
	}
	throw new DOMException("The operation was aborted", "AbortError");
}

function desktopTools(
	runtime: DesktopRuntime,
	handlers: DesktopAgentHandlers,
	nextLocalSeq: () => number,
): AgentTool[] {
	return runtime.tools.map(
		(spec) =>
			({
				name: spec.name,
				label: spec.label,
				description: spec.description,
				parameters: spec.parameters,
				executionMode: spec.executionMode,
				execute: async (toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
					const eventBase = `${runtime.runId}:${toolCallId}`;
					handlers.onEvent(
						localEvent("tool_start", { toolCallId, tool: spec.name, args }, `${eventBase}:start`, nextLocalSeq()),
					);
					const response = await requestDesktopTool(runtime, toolCallId, spec.name, args, signal);
					handlers.onEvent(
						localEvent(
							"tool_end",
							{ toolCallId, tool: spec.name, isError: response.isError, details: response.result.details ?? null },
							`${eventBase}:end`,
							nextLocalSeq(),
						),
					);
					if (response.isError) throw new Error(errorText(response.result));
					return response.result;
				},
			}) as AgentTool,
	);
}

function continuationMessage(runtime: DesktopRuntime): AgentMessage {
	const last = runtime.transcript.at(-1);
	if (last?.role === "assistant" && runtime.waiting) {
		const toolName =
			runtime.waiting.kind === "user" ? (runtime.waiting.proposal ? "propose_questions" : "ask_user") : "wait_for";
		return {
			role: "toolResult",
			toolCallId: runtime.waiting.toolCallId,
			toolName,
			content: [{ type: "text", text: runtime.message ?? "{}" }],
			isError: false,
			timestamp: Date.now(),
		};
	}
	return { role: "user", content: runtime.message ?? "请继续。", timestamp: Date.now() };
}

export function pendingDesktopToolCalls(
	messages: AgentMessage[],
): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
	let assistantIndex = -1;
	let calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const found = message.content.flatMap((item) =>
			item.type === "toolCall"
				? [{ id: item.id, name: item.name, arguments: item.arguments as Record<string, unknown> }]
				: [],
		);
		if (!found.length) return [];
		assistantIndex = index;
		calls = found;
		break;
	}
	if (assistantIndex < 0) return [];
	const completed = new Set(
		messages
			.slice(assistantIndex + 1)
			.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
	);
	return calls.filter((call) => !completed.has(call.id));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One durable desktop turn owns claim, recovery, streaming, persistence, heartbeat and completion ordering.
async function runDesktopTurn(sessionId: string, handlers: DesktopAgentHandlers): Promise<void> {
	const runtime = await post<DesktopRuntime>(`/api/workbench/sessions/${sessionId}/desktop/claim`, {
		clientId: desktopClientId(),
	});
	let localSeq = 0;
	const nextLocalSeq = () => ++localSeq;
	const tools = desktopTools(runtime, handlers, nextLocalSeq);
	const streamFn: StreamFn = (model, context, options) =>
		streamOpenAIResponses(model as Model<"openai-responses">, context, {
			...options,
			fetch: relayFetch(runtime),
		});
	const agent = new Agent({
		initialState: {
			systemPrompt: runtime.systemPrompt,
			model: modelFor(runtime),
			thinkingLevel: runtime.thinkingLevel,
			tools,
			messages: runtime.transcript,
		},
		streamFn,
		getApiKey: () => "desktop-relay",
		sessionId,
		toolExecution: "parallel",
	});
	const active = activeRuns.get(sessionId);
	if (active) active.agent = agent;
	let persistQueue = Promise.resolve();
	let persistError: Error | null = null;
	let nextMessageIndex = runtime.transcript.length;
	let assistantTurn = 0;
	let streamedText = "";
	let lastFlush = 0;
	let eventIndex = 0;
	const enqueue = (work: () => Promise<unknown>) => {
		persistQueue = persistQueue.then(work).then(
			() => undefined,
			(reason) => {
				persistError ??= reason instanceof Error ? reason : new Error(String(reason));
			},
		);
	};
	const flushPersistence = async () => {
		await persistQueue;
		if (persistError) throw persistError;
	};
	const emitAssistant = (type: "assistant_delta" | "assistant_message", text: string, persist: boolean) => {
		eventIndex += 1;
		const clientEventId = `${runtime.runId}:assistant:${eventIndex}`;
		const payload = { turn: assistantTurn, text };
		handlers.onEvent(localEvent(type, payload, clientEventId, nextLocalSeq()));
		if (persist)
			enqueue(() =>
				post(`/api/workbench/sessions/${sessionId}/desktop/events`, {
					runId: runtime.runId,
					clientId: runtime.clientId,
					clientEventId,
					type,
					payload,
				}),
			);
	};
	const persistMessage = (message: AgentMessage) => {
		const index = nextMessageIndex;
		nextMessageIndex += 1;
		enqueue(() =>
			post(`/api/workbench/sessions/${sessionId}/desktop/messages`, {
				runId: runtime.runId,
				clientId: runtime.clientId,
				index,
				message,
			}),
		);
	};
	agent.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			assistantTurn += 1;
			streamedText = "";
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			streamedText += event.assistantMessageEvent.delta;
			if (Date.now() - lastFlush > 200) {
				lastFlush = Date.now();
				emitAssistant("assistant_delta", streamedText, false);
			}
		}
		if (event.type === "message_end") {
			persistMessage(event.message);
			if (event.message.role === "assistant") {
				const text = contentText(event.message.content).trim();
				if (text) emitAssistant("assistant_message", text, true);
				streamedText = "";
			}
			return persistQueue;
		}
	});
	const heartbeat = window.setInterval(() => {
		void post(`/api/workbench/sessions/${sessionId}/desktop/heartbeat`, {
			runId: runtime.runId,
			clientId: runtime.clientId,
		}).catch(() => undefined);
	}, 20_000);
	let runtimeError: Error | null = null;
	try {
		if (runtime.transcript.length === runtime.turnStartIndex) {
			if (runtime.trigger === "user") await agent.prompt(runtime.message ?? "请继续。");
			else {
				const continuation = continuationMessage(runtime);
				agent.state.messages = [...agent.state.messages, continuation];
				persistMessage(continuation);
				await flushPersistence();
				await agent.continue();
			}
		} else {
			const missing = pendingDesktopToolCalls(agent.state.messages);
			if (missing.length) {
				const byName = new Map(tools.map((tool) => [tool.name, tool]));
				const execute = async (call: (typeof missing)[number]): Promise<AgentMessage> => {
					const tool = byName.get(call.name);
					if (!tool)
						return {
							role: "toolResult" as const,
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text" as const, text: "工具不在桌面白名单中" }],
							isError: true,
							timestamp: Date.now(),
						};
					try {
						const result = await tool.execute(call.id, call.arguments as never);
						return {
							role: "toolResult" as const,
							toolCallId: call.id,
							toolName: call.name,
							content: result.content,
							isError: false,
							timestamp: Date.now(),
						};
					} catch (error) {
						return {
							role: "toolResult" as const,
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text" as const, text: error instanceof Error ? error.message : "工具执行失败" }],
							isError: true,
							timestamp: Date.now(),
						};
					}
				};
				const mustRunSequentially = missing.some((call) => byName.get(call.name)?.executionMode === "sequential");
				const results: AgentMessage[] = [];
				if (mustRunSequentially) for (const call of missing) results.push(await execute(call));
				else results.push(...(await Promise.all(missing.map(execute))));
				for (const result of results) persistMessage(result);
				agent.state.messages = [...agent.state.messages, ...results];
				await flushPersistence();
				await agent.continue();
			} else if (["user", "toolResult"].includes(agent.state.messages.at(-1)?.role ?? "")) await agent.continue();
		}
		if (agent.state.errorMessage) runtimeError = new Error(agent.state.errorMessage);
	} catch (reason) {
		runtimeError = reason instanceof Error ? reason : new Error(String(reason));
	} finally {
		window.clearInterval(heartbeat);
		await persistQueue;
		runtimeError ??= persistError;
		try {
			const completed = await post<{ session: WorkbenchSession }>(
				`/api/workbench/sessions/${sessionId}/desktop/complete`,
				{
					runId: runtime.runId,
					clientId: runtime.clientId,
					error: runtimeError?.message ?? null,
				},
			);
			handlers.onSession(completed.session);
		} catch (reason) {
			runtimeError ??= reason instanceof Error ? reason : new Error(String(reason));
		}
	}
	if (runtimeError) throw runtimeError;
}

export function startDesktopAgent(sessionId: string, handlers: DesktopAgentHandlers): Promise<void> {
	const existing = activeRuns.get(sessionId);
	if (existing) return existing.promise;
	const entry: ActiveDesktopRun = { agent: null, promise: Promise.resolve() };
	entry.promise = runDesktopTurn(sessionId, handlers)
		.catch((error) => handlers.onError(error instanceof Error ? error : new Error(String(error))))
		.finally(() => activeRuns.delete(sessionId));
	activeRuns.set(sessionId, entry);
	return entry.promise;
}

export function abortDesktopAgent(sessionId: string): void {
	activeRuns.get(sessionId)?.agent?.abort();
}

export function isDesktopAgentRunning(sessionId: string): boolean {
	return activeRuns.has(sessionId);
}
