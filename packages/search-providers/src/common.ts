import type { BrandMatch, CaptureFailureCode, CaptureStatus, CitationSource } from "@geo/evidence";
import type { AdapterDependencies, CaptureBrand, ConnectionResult, ProviderUsage } from "./types";

export const ADAPTER_VERSION = "cloud-search.v1";

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
		return { url: parsed.toString(), domain: parsed.hostname, title: title?.trim() || null, position, isCitation };
	} catch {
		return null;
	}
}

export function dedupeSources(sources: Array<CitationSource | null>): CitationSource[] {
	const unique = new Map<string, CitationSource>();
	for (const source of sources) {
		if (!source || unique.has(source.url)) continue;
		unique.set(source.url, { ...source, position: unique.size + 1 });
	}
	return [...unique.values()];
}

export function outputText(response: Record<string, unknown>): string | null {
	if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text.trim();
	const output = Array.isArray(response.output) ? response.output : [];
	const text = output
		.flatMap((item) =>
			item && typeof item === "object" && Array.isArray((item as { content?: unknown }).content)
				? (item as { content: unknown[] }).content
				: [],
		)
		.map((part) =>
			part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("\n")
		.trim();
	return text || null;
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
