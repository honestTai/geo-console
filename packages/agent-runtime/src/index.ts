import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";
import { createMiddleware } from "langchain";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { type AgentMessage, type AgentTool, type AgentToolResult, contentText, type ToolCall } from "./contracts";

export { MemorySaver } from "@langchain/langgraph";
export { Type } from "typebox";
export * from "./contracts";
export const AGENT_ENGINE = "deepagents-langgraph";

/** Connection metadata, not a vendor SDK model object. */
export type Model<_Api extends string = string> = {
	id: string;
	baseUrl: string;
	name?: string;
	api?: string;
	provider?: string;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};
type Event =
	| { type: "message_start" | "message_end"; message: AgentMessage }
	| { type: "message_update"; assistantMessageEvent: { type: "text_delta"; delta: string } }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: AgentToolResult }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult; isError: boolean };
type Options = {
	initialState: {
		systemPrompt: string;
		model: Model;
		thinkingLevel?: string;
		tools: AgentTool[];
		messages?: AgentMessage[];
	};
	getApiKey?: (provider: string) => string | undefined;
	sessionId?: string;
	fetch?: typeof globalThis.fetch;
	toolExecution?: "parallel" | "sequential";
	beforeToolCall?: (input: {
		toolCall: ToolCall;
	}) => Promise<{ block: boolean; reason: string; terminate?: boolean } | undefined>;
	shouldStopAfterTurn?: () => boolean;
	/** Injectable model is used by isolated contract tests, never as a production fallback. */
	chatModel?: BaseChatModel;
	checkpointer?: MemorySaver;
};

export function toLangChainMessages(messages: AgentMessage[]): BaseMessage[] {
	return messages.map((message, index) => {
		const id = `geo:${index}`;
		if (message.role === "user") return new HumanMessage({ id, content: contentText(message.content) });
		if (message.role === "toolResult")
			return new ToolMessage({
				id,
				content: contentText(message.content),
				tool_call_id: message.toolCallId,
				name: message.toolName,
				status: message.isError ? "error" : "success",
			});
		return new AIMessage({
			id,
			content: contentText(message.content),
			tool_calls: message.content
				.filter((item): item is ToolCall => item.type === "toolCall")
				.map((call) => ({ id: call.id, name: call.name, args: call.arguments, type: "tool_call" as const })),
		});
	});
}

function assistantMessage(message: AIMessage, model: Model): Extract<AgentMessage, { role: "assistant" }> {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => String(part.text ?? ""))
					.join("\n");
	return {
		role: "assistant",
		timestamp: Date.now(),
		api: "openai-responses",
		provider: model.provider,
		model: model.id,
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...(message.tool_calls ?? []).map((call) => ({
				type: "toolCall" as const,
				id: call.id ?? crypto.randomUUID(),
				name: call.name,
				arguments: call.args,
			})),
		],
		usage: {
			input: message.usage_metadata?.input_tokens ?? 0,
			output: message.usage_metadata?.output_tokens ?? 0,
			totalTokens: message.usage_metadata?.total_tokens ?? 0,
		},
		stopReason: message.tool_calls?.length ? "toolUse" : "stop",
	};
}

/** Deep Agents owns the model/tool loop. GEO owns tool authority and the stable evidence transcript. */
export class Agent {
	readonly state: { messages: AgentMessage[]; errorMessage?: string };
	private readonly listeners = new Set<(event: Event) => void | Promise<void>>();
	private controller = new AbortController();
	private stopped = false;
	private parallelTurn = false;
	private toolQueue: Promise<unknown> = Promise.resolve();
	private eventQueue: Promise<void> = Promise.resolve();
	constructor(private readonly options: Options) {
		this.state = { messages: [...(options.initialState.messages ?? [])] };
	}
	subscribe(listener: (event: Event) => void | Promise<void>) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	abort() {
		this.controller.abort(new Error("Agent 已停止"));
	}
	private emit(event: Event) {
		this.eventQueue = this.eventQueue.then(async () => {
			for (const listener of this.listeners) await listener(event);
		});
		return this.eventQueue;
	}
	private async append(message: AgentMessage) {
		this.state.messages.push(message);
		await this.emit({ type: "message_end", message });
	}
	async prompt(text: string) {
		await this.append({ role: "user", content: text, timestamp: Date.now() });
		await this.continue();
	}

	private async execute(spec: AgentTool, call: ToolCall): Promise<ToolMessage> {
		const run = async () => {
			this.controller.signal.throwIfAborted();
			if (this.stopped) {
				const content = [{ type: "text" as const, text: "本回合已暂停，未执行此工具" }];
				await this.append({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content,
					isError: true,
					timestamp: Date.now(),
				});
				return new ToolMessage({ content: contentText(content), tool_call_id: call.id, status: "error" });
			}
			const blocked = await this.options.beforeToolCall?.({ toolCall: call });
			if (blocked?.block) throw new Error(blocked.reason);
			await this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
			let result: AgentToolResult;
			let isError = false;
			try {
				if (!Check(spec.parameters as TSchema, call.arguments)) throw new Error(`工具 ${call.name} 的参数不符合契约`);
				result = await spec.execute(call.id, call.arguments, this.controller.signal, (partialResult) => {
					// Progress is advisory; durable final events are always awaited below.
					void this.emit({
						type: "tool_execution_update",
						toolCallId: call.id,
						toolName: call.name,
						partialResult,
					}).catch(() => undefined);
				});
			} catch (error) {
				this.controller.signal.throwIfAborted();
				isError = true;
				result = { content: [{ type: "text", text: error instanceof Error ? error.message : "工具执行失败" }] };
			}
			await this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError });
			await this.append({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: result.content,
				isError,
				timestamp: Date.now(),
				...(result.terminate ? { terminate: true } : {}),
			});
			this.stopped ||= result.terminate === true || this.options.shouldStopAfterTurn?.() === true;
			return new ToolMessage({
				content: contentText(result.content),
				tool_call_id: call.id,
				name: call.name,
				status: isError ? "error" : "success",
			});
		};
		if (this.parallelTurn) return run();
		// A batch containing any side effect or approval executes in model order.
		const pending = this.toolQueue.then(run);
		this.toolQueue = pending.catch(() => undefined);
		return pending;
	}

	async continue(): Promise<void> {
		this.controller.signal.throwIfAborted();
		this.stopped = false;
		this.state.errorMessage = undefined;
		const { model, tools, systemPrompt, thinkingLevel } = this.options.initialState;
		const allowed = new Map(tools.map((spec) => [spec.name, spec]));
		const chatModel =
			this.options.chatModel ??
			new ChatOpenAI({
				model: model.id,
				apiKey: this.options.getApiKey?.(model.provider ?? "hrouter"),
				configuration: { baseURL: model.baseUrl, fetch: this.options.fetch },
				useResponsesApi: true,
				streaming: true,
				maxRetries: 0,
				timeout: 120_000,
				modelKwargs: { store: false },
				maxTokens: model.maxTokens ?? 12_000,
				reasoning: { effort: thinkingLevel as "low" | "medium" | "high" },
			});
		const middleware = createMiddleware({
			name: "GeoDomainBoundary",
			beforeModel: {
				canJumpTo: ["end"],
				hook: async () => {
					if (this.stopped || this.options.shouldStopAfterTurn?.()) return { jumpTo: "end" as const };
					await this.emit({
						type: "message_start",
						message: {
							role: "assistant",
							content: [],
							timestamp: Date.now(),
							usage: { input: 0, output: 0, totalTokens: 0 },
						},
					});
				},
			},
			wrapModelCall: (request, handler) =>
				handler({
					...request,
					tools: request.tools.filter((item) => "name" in item && allowed.has(String(item.name))),
				}),
			afterModel: async (state) => {
				const message = state.messages.at(-1);
				if (message && AIMessage.isInstance(message)) {
					this.parallelTurn =
						this.options.toolExecution === "parallel" &&
						Boolean(message.tool_calls?.length) &&
						message.tool_calls!.every((call) => allowed.get(call.name)?.executionMode === "parallel");
					await this.append(assistantMessage(message, model));
				}
			},
			wrapToolCall: async (request) => {
				const spec = allowed.get(request.toolCall.name);
				if (!spec) throw new Error(`工具不在 GEO 领域白名单中：${request.toolCall.name}`);
				return this.execute(spec, {
					type: "toolCall",
					id: request.toolCall.id ?? crypto.randomUUID(),
					name: request.toolCall.name,
					arguments: request.toolCall.args,
				});
			},
		});
		const graph = createDeepAgent({
			name: "geo-business-agent",
			model: chatModel,
			systemPrompt: `${systemPrompt}\n只能使用本次提供的 GEO 业务工具。不得操作文件系统、Shell、SQL 或任意网络，不得委托未经授权的子 Agent。`,
			tools: tools.map((spec) =>
				tool(async () => "", {
					name: spec.name,
					description: spec.description,
					schema: spec.parameters as Record<string, unknown>,
				}),
			),
			subagents: [],
			middleware: [middleware],
			checkpointer: this.options.checkpointer ?? new MemorySaver(),
		});
		try {
			await graph.invoke(
				{ messages: toLangChainMessages(this.state.messages) },
				{
					configurable: { thread_id: this.options.sessionId ?? crypto.randomUUID() },
					signal: this.controller.signal,
					recursionLimit: 160,
					callbacks: [
						{
							handleLLMNewToken: async (delta: string) => {
								await this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
							},
						},
					],
				},
			);
		} catch (error) {
			this.state.errorMessage = error instanceof Error ? error.message : "Agent 执行失败";
			throw error;
		}
	}
}
