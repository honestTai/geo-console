import type { BrandMatch, CaptureFailureCode, CaptureStatus, CitationSource } from "@geo/evidence";
import type { AdapterDependencies, CaptureBrand, ConnectionResult, ProviderUsage } from "./types";

export const ADAPTER_VERSION = "cloud-search.v2";

export class ProviderRequestError extends Error {
	constructor(
		message: string,
		readonly statusCode: number | null,
		readonly body: unknown,
	) {
		super(message);
	}
}

export const defaultDependencies: AdapterDependencies = { fetch: globalThis.fetch, now: () => Date.now() };

export function joinUrl(base: string, path: string): string {
	return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export async function requestJson(
	dependencies: AdapterDependencies,
	url: string,
	apiKey: string,
	init: RequestInit = {},
): Promise<{ body: Record<string, unknown>; requestId: string | null; latencyMs: number }> {
	const startedAt = dependencies.now();
	const response = await dependencies.fetch(url, {
		...init,
		signal: init.signal ?? AbortSignal.timeout(120_000),
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			...init.headers,
		},
	});
	const latencyMs = dependencies.now() - startedAt;
	const text = await response.text();
	let body: unknown = {};
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		throw new ProviderRequestError("供应商返回了非 JSON 响应", response.status, text.slice(0, 500));
	}
	if (!response.ok) {
		throw new ProviderRequestError(`供应商请求失败（HTTP ${response.status}）`, response.status, body);
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new ProviderRequestError("供应商响应结构无效", response.status, body);
	}
	const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
	return { body: body as Record<string, unknown>, requestId, latencyMs };
}

export function classifyProviderError(error: unknown): {
	status: CaptureStatus;
	failureCode: CaptureFailureCode;
	message: string;
} {
	if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
		return { status: "timeout", failureCode: "provider_timeout", message: "供应商请求超时" };
	}
	if (error instanceof ProviderRequestError) {
		const errorDetail = JSON.stringify(error.body).toLowerCase();
		if (error.statusCode === 401 || error.statusCode === 403)
			return { status: "auth_required", failureCode: "authentication_failed", message: error.message };
		if (error.statusCode === 429)
			return { status: "rate_limited", failureCode: "rate_limited", message: error.message };
		if (
			error.statusCode === 404 ||
			(error.statusCode === 400 &&
				errorDetail.includes("model") &&
				/(not.found|unavailable|不存在|下线)/.test(errorDetail))
		)
			return { status: "model_unavailable", failureCode: "model_unavailable", message: error.message };
		if (error.statusCode === 400)
			return { status: "protocol_changed", failureCode: "protocol_changed", message: error.message };
		return { status: "failed", failureCode: "provider_error", message: error.message };
	}
	return {
		status: "failed",
		failureCode: "provider_error",
		message: error instanceof Error ? error.message : "未知供应商错误",
	};
}

export function connectionFromError(error: unknown, latencyMs: number): ConnectionResult {
	const failure = classifyProviderError(error);
	const status =
		failure.status === "auth_required"
			? "auth_required"
			: failure.status === "rate_limited"
				? "rate_limited"
				: failure.status === "protocol_changed"
					? "invalid_configuration"
					: "unavailable";
	return { ok: false, status, message: failure.message, latencyMs };
}

export function matchBrands(answer: string, brands: CaptureBrand[]): BrandMatch[] {
	const found = brands.flatMap((brand) => {
		const aliases = [brand.name, ...brand.aliases].map((alias) => alias.trim()).filter(Boolean);
		const matches = aliases
			.map((alias) => ({ alias, index: answer.toLocaleLowerCase().indexOf(alias.toLocaleLowerCase()) }))
			.filter((match) => match.index >= 0)
			.sort((left, right) => left.index - right.index);
		return matches[0] ? [{ brandId: brand.id, matchedAlias: matches[0].alias, index: matches[0].index }] : [];
	});
	return found
		.sort((left, right) => left.index - right.index)
		.map((match, index) => ({ brandId: match.brandId, matchedAlias: match.matchedAlias, position: index + 1 }));
}

export function citationSource(
	url: string,
	position: number,
	title: string | null,
	isCitation: boolean,
): CitationSource | null {
	try {
		const parsed = new URL(url);
		if (!["http:", "https:"].includes(parsed.protocol)) return null;
		if (parsed.hash.startsWith("#ws_call_id=")) parsed.hash = "";
		return { url: parsed.toString(), domain: parsed.hostname, title: title?.trim() || null, position, isCitation };
	} catch {
		return null;
	}
}

export function dedupeSources(sources: Array<CitationSource | null>): CitationSource[] {
	const unique = new Map<string, CitationSource>();
	for (const source of sources) {
		if (!source) continue;
		const prior = unique.get(source.url);
		if (prior) {
			unique.set(source.url, {
				...prior,
				title: prior.title ?? source.title,
				isCitation: prior.isCitation || source.isCitation,
			});
			continue;
		}
		unique.set(source.url, { ...source, position: unique.size + 1 });
	}
	return [...unique.values()];
}

function responseItems(response: Record<string, unknown>): Record<string, unknown>[] {
	return Array.isArray(response.output)
		? response.output.filter((item): item is Record<string, unknown> =>
				Boolean(item && typeof item === "object" && !Array.isArray(item)),
			)
		: [];
}
function finalMessage(response: Record<string, unknown>): Record<string, unknown> | undefined {
	return responseItems(response)
		.filter((item) => item.type === "message" && (item.role === undefined || item.role === "assistant"))
		.at(-1);
}
export function outputText(response: Record<string, unknown>): string | null {
	if (["incomplete", "failed", "cancelled", "in_progress", "queued"].includes(String(response.status))) return null;
	const message = finalMessage(response);
	if (message) {
		if (message.phase !== undefined && message.phase !== "final_answer") return null;
		if (message.channel === "analysis" || message.channel === "commentary") return null;
		if (message.status !== undefined && message.status !== "completed") return null;
		const parts = Array.isArray(message.content) ? message.content : [];
		return (
			parts
				.filter((p) => p && typeof p === "object" && p.type === "output_text" && typeof p.text === "string")
				.map((p) => p.text)
				.join("\n")
				.trim() || null
		);
	}
	// Some SDKs provide only the documented final output_text convenience field.
	return typeof response.output_text === "string" ? response.output_text.trim() || null : null;
}
export function responseSearchEvidence(response: Record<string, unknown>) {
	const calls = responseItems(response).filter(
		(item) => String(item.type).includes("web_search") && (item.status === undefined || item.status === "completed"),
	);
	const queries = calls.flatMap((item) => {
		const action = item.action as Record<string, unknown> | undefined;
		return [action?.query, ...(Array.isArray(action?.queries) ? action.queries : [])]
			.filter((q): q is string => typeof q === "string" && Boolean(q.trim()))
			.map((q) => q.trim());
	});
	const message = finalMessage(response),
		parts = Array.isArray(message?.content) ? message.content : [];
	const annotationUrls = recursiveUrls(
		parts.filter((p) => p && p.type === "output_text").map((p) => p.annotations ?? []),
	);
	const answer = outputText(response) ?? "";
	const linkedUrls = [...answer.matchAll(/\[[^\]]*\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g)].map((match) => ({
		url: match[1],
		title: null,
	}));
	const cited = [...annotationUrls, ...linkedUrls].map((item, index) =>
		citationSource(item.url, index + 1, item.title, true),
	);
	const observed = recursiveUrls(calls).map((item, index) => citationSource(item.url, index + 1, item.title, false));
	return {
		searchTriggered: calls.length > 0,
		sources: dedupeSources([...cited, ...observed]),
		queryFanOut: [...new Set(queries)],
	};
}

export function usageFrom(value: unknown): ProviderUsage | null {
	if (!value || typeof value !== "object") return null;
	const usage = value as Record<string, unknown>;
	const number = (...keys: string[]) => {
		for (const key of keys) if (typeof usage[key] === "number") return usage[key] as number;
		return undefined;
	};
	return {
		inputTokens: number("input_tokens", "prompt_tokens"),
		outputTokens: number("output_tokens", "completion_tokens"),
		totalTokens: number("total_tokens"),
	};
}

export function recursiveUrls(value: unknown): Array<{ url: string; title: string | null }> {
	const found: Array<{ url: string; title: string | null }> = [];
	const visit = (item: unknown): void => {
		if (Array.isArray(item)) {
			item.forEach(visit);
			return;
		}
		if (!item || typeof item !== "object") return;
		const record = item as Record<string, unknown>;
		const url = typeof record.url === "string" ? record.url : typeof record.uri === "string" ? record.uri : null;
		if (url?.startsWith("http")) {
			found.push({ url, title: typeof record.title === "string" ? record.title : null });
		}
		Object.values(record).forEach(visit);
	};
	visit(value);
	return found;
}
