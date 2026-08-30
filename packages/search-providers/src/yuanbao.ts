import {
	ADAPTER_VERSION,
	citationSource,
	classifyProviderError,
	connectionFromError,
	dedupeSources,
	defaultDependencies,
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

type TencentPage = { url?: unknown; title?: unknown; passage?: unknown; content?: unknown; site?: unknown };

export class YuanbaoHunyuanSearchAdapter implements SearchProviderAdapter {
	readonly id = "yuanbao_hunyuan" as const;
	constructor(
		private readonly config: ProviderConfig,
		private readonly dependencies: AdapterDependencies = defaultDependencies,
	) {}
	capabilities() {
		return {
			forcedSearch: true,
			sources: "available",
			queryFanOut: "unavailable",
			compositeSurface: true,
			consumerAppEquivalent: false,
		} as const;
	}
	async testConnection() {
		const startedAt = this.dependencies.now();
		if (!this.config.secondaryApiKey || !this.config.secondaryEndpoint) {
			return {
				ok: false,
				status: "invalid_configuration",
				message: "元宝组合口径需要联网搜索和混元两组密钥",
				latencyMs: 0,
			} as const;
		}
		try {
			await requestJson(this.dependencies, this.config.endpoint, this.config.apiKey, {
				method: "POST",
				body: JSON.stringify({ Query: "连接测试", Cnt: 10 }),
			});
			const modelsEndpoint = this.config.secondaryEndpoint.replace(/\/chat\/completions\/?$/, "/models");
			await requestJson(this.dependencies, modelsEndpoint, this.config.secondaryApiKey);
			return {
				ok: true,
				status: "connected",
				message: "腾讯联网搜索与混元 API 连接正常",
				latencyMs: this.dependencies.now() - startedAt,
			} as const;
		} catch (error) {
			return connectionFromError(error, this.dependencies.now() - startedAt);
		}
	}
	async capture(input: CaptureInput): Promise<ProviderCaptureResult> {
		const startedAt = this.dependencies.now();
		const raw: Record<string, unknown> = {};
		try {
			if (!this.config.secondaryApiKey || !this.config.secondaryEndpoint) {
				return this.failure("auth_required", "authentication_failed", "缺少混元 API 密钥或端点", raw, startedAt);
			}
			const search = await requestJson(this.dependencies, this.config.endpoint, this.config.apiKey, {
				method: "POST",
				body: JSON.stringify({ Query: input.prompt, Cnt: Number(this.config.options?.resultCount ?? 20) }),
				signal: input.signal,
			});
			raw.search = search.body;
			const response =
				search.body.Response && typeof search.body.Response === "object"
					? (search.body.Response as Record<string, unknown>)
					: search.body;
			const pages = Array.isArray(response.Pages)
				? response.Pages.flatMap((page) => {
						if (typeof page !== "string") return [];
						try {
							return [JSON.parse(page) as TencentPage];
						} catch {
							return [];
						}
					})
				: [];
			if (pages.length === 0)
				return this.failure(
					"search_not_triggered",
					"search_not_triggered",
					"腾讯联网搜索未返回 Pages",
					raw,
					startedAt,
					typeof response.RequestId === "string" ? response.RequestId : search.requestId,
				);
			const sourceContext = pages
				.map(
					(page, index) =>
						`[${index + 1}] ${String(page.title ?? "无标题")}\nURL: ${String(page.url ?? "")}\n摘要: ${String(page.content ?? page.passage ?? "")}`,
				)
				.join("\n\n");
			const synthesis = await requestJson(
				this.dependencies,
				this.config.secondaryEndpoint,
				this.config.secondaryApiKey,
				{
					method: "POST",
					body: JSON.stringify({
						model: this.config.model,
						messages: [
							{
								role: "system",
								content: "你只能根据提供的联网搜索结果回答。引用事实时使用 [数字] 标注来源；证据不足时明确说明。",
							},
							{ role: "user", content: `问题：${input.prompt}\n\n联网搜索结果：\n${sourceContext}` },
						],
					}),
					signal: input.signal,
				},
			);
			raw.synthesis = synthesis.body;
			const choices = Array.isArray(synthesis.body.choices) ? synthesis.body.choices : [];
			const choice = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
			const message =
				choice.message && typeof choice.message === "object" ? (choice.message as Record<string, unknown>) : {};
			const answerText = typeof message.content === "string" ? message.content.trim() : null;
			if (!answerText)
				return this.failure(
					"no_answer",
					"no_answer",
					"混元未返回合成回答",
					raw,
					startedAt,
					typeof response.RequestId === "string" ? response.RequestId : search.requestId,
				);
			const sources = dedupeSources(
				pages.map((page, index) =>
					typeof page.url === "string"
						? citationSource(
								page.url,
								index + 1,
								typeof page.title === "string" ? page.title : null,
								answerText.includes(`[${index + 1}]`),
							)
						: null,
				),
			);
			return {
				providerId: this.id,
				status: "complete",
				answerText,
				brandMatches: matchBrands(answerText, input.brands),
				sources,
				queryFanOut: [],
				sourceVisibility: "available",
				fanoutVisibility: "unavailable",
				model: this.config.model,
				protocol: "yuanbao-search+hunyuan-synthesis",
				searchToolVersion: this.config.searchToolVersion,
				adapterVersion: ADAPTER_VERSION,
				requestId: typeof response.RequestId === "string" ? response.RequestId : search.requestId,
				usage: usageFrom(synthesis.body.usage),
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
				{ ...raw, error: (error as { body?: unknown }).body },
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
			protocol: "yuanbao-search+hunyuan-synthesis",
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
