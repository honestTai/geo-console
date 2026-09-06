import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

export function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

export class HttpInputError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export async function readJson(
	request: AsyncIterable<Uint8Array> & {
		iterator?: (options: { destroyOnReturn: boolean }) => AsyncIterable<Uint8Array>;
	},
	limit = 8 * 1024 * 1024,
): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request.iterator?.({ destroyOnReturn: false }) ?? request) {
		bytes += chunk.byteLength;
		if (bytes > limit) throw new HttpInputError("请求内容过大", 413);
		chunks.push(Buffer.from(chunk));
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpInputError("请求必须是有效 JSON");
	}
}

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

/** 与 JSON.stringify 一样忽略 undefined，保证冻结配置在写库前后哈希一致。 */
export function stableJson(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map((item) => (item === undefined ? "null" : stableJson(item))).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function normalizeDomain(urlOrDomain: string): string {
	const raw = urlOrDomain.trim();
	const hostname = raw.includes("://") ? new URL(raw).hostname : raw.split("/")[0];
	return hostname.toLowerCase().replace(/^www\./, "");
}

/** 用户或模型给出的域名可能是垃圾值：无法解析或不像域名（含中文等国际化域名）时返回 null，由调用方决定报错还是丢弃。 */
export function tryNormalizeDomain(urlOrDomain: string): string | null {
	try {
		const domain = normalizeDomain(urlOrDomain);
		return /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(domain) ? domain : null;
	} catch {
		return null;
	}
}

export function parseJsonColumn<T>(value: T | string): T {
	return typeof value === "string" ? (JSON.parse(value) as T) : value;
}
