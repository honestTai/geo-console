import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

export function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

export async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

/** 与 JSON.stringify 一样忽略 undefined，保证冻结配置在写库前后哈希一致。 */
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : stableJson(item))).join(",")}]`;
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

export function parseJsonColumn<T>(value: T | string): T {
	return typeof value === "string" ? (JSON.parse(value) as T) : value;
}
