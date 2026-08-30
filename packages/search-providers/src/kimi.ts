import {
	ADAPTER_VERSION,
	citationSource,
	classifyProviderError,
	connectionFromError,
	dedupeSources,
	defaultDependencies,
	joinUrl,
	matchBrands,
	recursiveUrls,
	requestJson,
	usageFrom,
} from "./common";
import type {
	AdapterDependencies,
	CaptureInput,
	ProviderCaptureResult,
	ProviderConfig,
	SearchProviderAdapter,
} from "./types";

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export class KimiSearchAdapter implements SearchProviderAdapter {
	readonly id = "kimi_api" as const;
	constructor(
		private readonly config: ProviderConfig,
		private readonly dependencies: AdapterDependencies = defaultDependencies,
	) {}
	capabilities() {
		return {
			forcedSearch: true,
			sources: "partial",
			queryFanOut: "available",
			compositeSurface: false,
			consumerAppEquivalent: false,
		} as const;
	}
	async testConnection() {
		const startedAt = this.dependencies.now();
		try {
			await requestJson(this.dependencies, joinUrl(this.config.endpoint, "/models"), this.config.apiKey);
			return {
				ok: true,
				status: "connected",
				message: "Kimi API 连接正常",
				latencyMs: this.dependencies.now() - startedAt,
			} as const;
		} catch (error) {
			return connectionFromError(error, this.dependencies.now() - startedAt);
		}
	}
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Kimi's official Formula protocol requires a bounded, stateful tool-call loop with explicit failure states.
	async capture(input: CaptureInput): Promise<ProviderCaptureResult> {
		const startedAt = this.dependencies.now();
		const raw: unknown[] = [];
		try {
			const formulaUri = this.config.searchToolVersion || "moonshot/web-search:latest";
			const definition = await requestJson(
				this.dependencies,
				joinUrl(this.config.endpoint, `/formulas/${formulaUri}/tools`),
				this.config.apiKey,
				{ signal: input.signal },
			);
			raw.push(definition.body);
			const tools = Array.isArray(definition.body.tools) ? definition.body.tools : [];
			if (tools.length === 0)
				return this.failure("protocol_changed", "protocol_changed", "Kimi Formula 未返回工具定义", raw, startedAt);
			const messages: unknown[] = [
				{ role: "system", content: `请使用联网搜索回答。用户地区：${input.region}；语言：${input.locale}。` },
				{ role: "user", content: input.prompt },
			];
			const queryFanOut: string[] = [];
			let answerText: string | null = null;
			let requestId: string | null = null;
			let usage: ProviderCaptureResult["usage"] = null;
			let searchRequests = 0;
			for (let round = 0; round < 5; round += 1) {
				const completion = await requestJson(
					this.dependencies,
					joinUrl(this.config.endpoint, "/chat/completions"),
					this.config.apiKey,
					{
						method: "POST",
						body: JSON.stringify({
							model: this.config.model,
							messages,
							tools,
							...(round === 0 ? { tool_choice: { type: "function", function: { name: "web_search" } } } : {}),
						}),
						signal: input.signal,
					},
				);
				raw.push(completion.body);
				requestId = typeof completion.body.id === "string" ? completion.body.id : completion.requestId;
				usage = usageFrom(completion.body.usage);
				const choice = Array.isArray(completion.body.choices) ? completion.body.choices[0] : null;
				const message = choice && typeof choice === "object" ? (choice as { message?: unknown }).message : null;
				if (!message || typeof message !== "object")
					return this.failure(
						"protocol_changed",
						"protocol_changed",
						"Kimi 响应缺少 message",
						raw,
						startedAt,
						requestId,
					);
				const toolCalls = Array.isArray((message as { tool_calls?: unknown }).tool_calls)
					? ((message as { tool_calls: ToolCall[] }).tool_calls ?? [])
					: [];
				if (toolCalls.length === 0) {
					answerText =
						typeof (message as { content?: unknown }).content === "string"
							? (message as { content: string }).content.trim()
							: null;
					break;
				}
				messages.push({
					role: "assistant",
					content: (message as { content?: unknown }).content ?? null,
					tool_calls: toolCalls,
				});
				for (const toolCall of toolCalls) {
					searchRequests += 1;
					try {
						const args = JSON.parse(toolCall.function.arguments) as { query?: unknown };
						if (typeof args.query === "string") queryFanOut.push(args.query);
					} catch {
						// The exact argument string is still preserved in raw evidence and sent to Formula unchanged.
					}
					const fiber = await requestJson(
						this.dependencies,
						joinUrl(this.config.endpoint, `/formulas/${formulaUri}/fibers`),
						this.config.apiKey,
						{ method: "POST", body: JSON.stringify(toolCall.function), signal: input.signal },
					);
					raw.push(fiber.body);
					const context =
						fiber.body.context && typeof fiber.body.context === "object"
							? (fiber.body.context as Record<string, unknown>)
							: {};
					const content =
						typeof context.output === "string"
							? context.output
							: typeof context.encrypted_output === "string"
								? context.encrypted_output
								: "";
					messages.push({ role: "tool", tool_call_id: toolCall.id, content });
				}
			}
			if (searchRequests === 0)
				return this.failure(
					"search_not_triggered",
					"search_not_triggered",
					"Kimi 未执行 web-search Formula",
					raw,
					startedAt,
					requestId,
				);
			if (!answerText) return this.failure("no_answer", "no_answer", "Kimi 未返回最终回答", raw, startedAt, requestId);
			const urls = recursiveUrls(raw);
			return {
				providerId: this.id,
				status: "complete",
				answerText,
				brandMatches: matchBrands(answerText, input.brands),
				sources: dedupeSources(urls.map((source, index) => citationSource(source.url, index + 1, source.title, true))),
				queryFanOut: [...new Set(queryFanOut)],
				sourceVisibility: urls.length ? "partial" : "unavailable",
				fanoutVisibility: "available",
				model: this.config.model,
				protocol: this.config.protocol,
				searchToolVersion: formulaUri,
				adapterVersion: ADAPTER_VERSION,
				requestId,
				usage: usage ? { ...usage, searchRequests } : { searchRequests },
				costMicros: null,
				latencyMs: this.dependencies.now() - startedAt,
				rawResponse: raw,
				failureCode: null,
				failureMessage: null,
			};
		} catch (error) {
			const failure = classifyProviderError(error);
			return this.failure(
				failure.status,
				failure.failureCode,
				failure.message,
				[...raw, (error as { body?: unknown }).body],
				startedAt,
			);
		}
	}
	private failure(
		status: ProviderCaptureResult["status"],
		failureCode: NonNullable<ProviderCaptureResult["failureCode"]>,
		failureMessage: string,
		rawResponse: unknown,
		startedAt: number,
		requestId: string | null = null,
	): ProviderCaptureResult {
		return {
			providerId: this.id,
			status,
			answerText: null,
			brandMatches: [],
			sources: [],
			queryFanOut: [],
			sourceVisibility: "unavailable",
			fanoutVisibility: "unavailable",
			model: this.config.model,
			protocol: this.config.protocol,
			searchToolVersion: this.config.searchToolVersion,
			adapterVersion: ADAPTER_VERSION,
			requestId,
			usage: null,
			costMicros: null,
			latencyMs: this.dependencies.now() - startedAt,
			rawResponse,
			failureCode,
			failureMessage,
		};
	}
}
