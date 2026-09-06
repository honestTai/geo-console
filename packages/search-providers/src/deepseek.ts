import {
	ADAPTER_VERSION,
	classifyProviderError,
	connectionFromError,
	defaultDependencies,
	joinUrl,
	matchBrands,
	outputText,
	requestJson,
	responseSearchEvidence,
	usageFrom,
} from "./common";
import type {
	AdapterDependencies,
	CaptureInput,
	ProviderCaptureResult,
	ProviderConfig,
	SearchProviderAdapter,
} from "./types";

export class DeepSeekSearchAdapter implements SearchProviderAdapter {
	readonly id = "deepseek_api" as const;
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
			await requestJson(this.dependencies, joinUrl(this.config.endpoint, "/models"), this.config.apiKey);
			return {
				ok: true,
				status: "connected",
				message: "DeepSeek API 连接正常",
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
				joinUrl(this.config.endpoint, "/responses"),
				this.config.apiKey,
				{
					method: "POST",
					body: JSON.stringify({
						model: this.config.model,
						input: input.prompt,
						tools: [{ type: "web_search" }],
						tool_choice: { type: "web_search" },
					}),
					signal: input.signal,
				},
			);
			rawResponse = response.body;
			const answerText = outputText(response.body);
			const { searchTriggered, sources, queryFanOut } = responseSearchEvidence(response.body);
			if (!searchTriggered) {
				return this.failure(
					"search_not_triggered",
					"search_not_triggered",
					"DeepSeek 未返回联网搜索证据",
					rawResponse,
					response.latencyMs,
					response.requestId,
				);
			}
			if (!answerText)
				return this.failure(
					"no_answer",
					"no_answer",
					"DeepSeek 未返回回答正文",
					rawResponse,
					response.latencyMs,
					response.requestId,
				);
			return {
				providerId: this.id,
				status: "complete",
				answerText,
				brandMatches: matchBrands(answerText, input.brands),
				sources,
				queryFanOut,
				sourceVisibility: sources.length ? "available" : "unavailable",
				fanoutVisibility: queryFanOut.length ? "partial" : "unavailable",
				model: this.config.model,
				protocol: this.config.protocol,
				searchToolVersion: this.config.searchToolVersion,
				adapterVersion: ADAPTER_VERSION,
				requestId: (typeof response.body.id === "string" ? response.body.id : null) ?? response.requestId,
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
