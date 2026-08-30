import {
	ADAPTER_VERSION,
	citationSource,
	classifyProviderError,
	connectionFromError,
	dedupeSources,
	defaultDependencies,
	joinUrl,
	matchBrands,
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

type QwenSearchResult = { url?: unknown; title?: unknown; index?: unknown };

export class QwenSearchAdapter implements SearchProviderAdapter {
	readonly id = "qwen_api" as const;
	constructor(
		private readonly config: ProviderConfig,
		private readonly dependencies: AdapterDependencies = defaultDependencies,
	) {}
	capabilities() {
		return {
			forcedSearch: true,
			sources: "available",
			queryFanOut: "partial",
			compositeSurface: false,
			consumerAppEquivalent: false,
		} as const;
	}
	async testConnection() {
		const startedAt = this.dependencies.now();
		try {
			const compatibleEndpoint = this.config.endpoint.replace(/\/api\/v1\/?$/, "/compatible-mode/v1");
			await requestJson(this.dependencies, joinUrl(compatibleEndpoint, "/models"), this.config.apiKey);
			return {
				ok: true,
				status: "connected",
				message: "DashScope API 连接正常",
				latencyMs: this.dependencies.now() - startedAt,
			} as const;
		} catch (error) {
			return connectionFromError(error, this.dependencies.now() - startedAt);
		}
	}
	async capture(input: CaptureInput): Promise<ProviderCaptureResult> {
		const startedAt = this.dependencies.now();
		let rawResponse: unknown = null;
		try {
			const response = await requestJson(
				this.dependencies,
				joinUrl(this.config.endpoint, "/services/aigc/text-generation/generation"),
				this.config.apiKey,
				{
					method: "POST",
					body: JSON.stringify({
						model: this.config.model,
						input: { messages: [{ role: "user", content: input.prompt }] },
						parameters: {
							enable_search: true,
							result_format: "message",
							search_options: {
								forced_search: true,
								search_strategy: "max",
								enable_source: true,
								enable_citation: true,
								citation_format: "[ref_<number>]",
								enable_search_extension: true,
							},
						},
					}),
					signal: input.signal,
				},
			);
			rawResponse = response.body;
			const output =
				response.body.output && typeof response.body.output === "object"
					? (response.body.output as Record<string, unknown>)
					: {};
			const choices = Array.isArray(output.choices) ? output.choices : [];
			const firstChoice = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
			const message =
				firstChoice.message && typeof firstChoice.message === "object"
					? (firstChoice.message as Record<string, unknown>)
					: {};
			const answerText = typeof message.content === "string" ? message.content.trim() : null;
			const searchInfo =
				output.search_info && typeof output.search_info === "object"
					? (output.search_info as Record<string, unknown>)
					: {};
			const searchResults = Array.isArray(searchInfo.search_results)
				? (searchInfo.search_results as QwenSearchResult[])
				: [];
			if (searchResults.length === 0)
				return this.failure(
					"search_not_triggered",
					"search_not_triggered",
					"通义未返回 search_info，无法证明已联网",
					rawResponse,
					response.latencyMs,
					response.requestId,
				);
			if (!answerText)
				return this.failure(
					"no_answer",
					"no_answer",
					"通义未返回回答正文",
					rawResponse,
					response.latencyMs,
					response.requestId,
				);
			const sources = dedupeSources(
				searchResults.map((item, index) => {
					const position = typeof item.index === "number" ? item.index : index + 1;
					const marker = `[ref_${position}]`;
					return typeof item.url === "string"
						? citationSource(
								item.url,
								position,
								typeof item.title === "string" ? item.title : null,
								answerText.includes(marker),
							)
						: null;
				}),
			);
			const queryFanOut = Array.isArray(searchInfo.search_queries)
				? searchInfo.search_queries.filter((item): item is string => typeof item === "string")
				: [];
			return {
				providerId: this.id,
				status: "complete",
				answerText,
				brandMatches: matchBrands(answerText, input.brands),
				sources,
				queryFanOut,
				sourceVisibility: "available",
				fanoutVisibility: queryFanOut.length ? "partial" : "unavailable",
				model: this.config.model,
				protocol: this.config.protocol,
				searchToolVersion: this.config.searchToolVersion,
				adapterVersion: ADAPTER_VERSION,
				requestId: typeof response.body.request_id === "string" ? response.body.request_id : response.requestId,
				usage: usageFrom(response.body.usage),
				costMicros: null,
				latencyMs: response.latencyMs,
				rawResponse,
				failureCode: null,
				failureMessage: null,
			};
		} catch (error) {
			const failure = classifyProviderError(error);
			return this.failure(
				failure.status,
				failure.failureCode,
				failure.message,
				rawResponse ?? (error as { body?: unknown }).body,
				this.dependencies.now() - startedAt,
				null,
			);
		}
	}
	private failure(
		status: ProviderCaptureResult["status"],
		failureCode: NonNullable<ProviderCaptureResult["failureCode"]>,
		failureMessage: string,
		rawResponse: unknown,
		latencyMs: number,
		requestId: string | null,
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
			latencyMs,
			rawResponse,
			failureCode,
			failureMessage,
		};
	}
}
