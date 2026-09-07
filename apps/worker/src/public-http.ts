import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export class PublicHttpError extends Error {
	constructor(
		public readonly url: string,
		public readonly status: number,
		public readonly body: Buffer,
		public readonly contentType: string,
	) {
		super(`${url} 返回 HTTP ${status}`);
	}
}

export function decodePublicBody(body: Buffer, encoding: string): Buffer {
	const options = { maxOutputLength: 8 * 1024 * 1024 };
	if (encoding === "gzip" || (body[0] === 0x1f && body[1] === 0x8b)) return gunzipSync(body, options);
	if (encoding === "br") return brotliDecompressSync(body, options);
	if (encoding === "deflate") return inflateSync(body, options);
	return body;
}

const denied = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	denied.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
	["2001::", 32],
	["2001:db8::", 32],
	["2002::", 16],
] as const)
	denied.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return !denied.check(address, "ipv4");
	return family === 6 && globalV6.check(address, "ipv6") && !denied.check(address, "ipv6");
}

export async function assertPublicUrl(value: string): Promise<URL> {
	const { url } = await publicTarget(value);
	return url;
}

async function publicTarget(value: string, timeoutMs = 10_000): Promise<{ url: URL; address: string }> {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("官网只支持不含凭据的 HTTP 或 HTTPS 地址");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const addresses = await Promise.race([
			lookup(host, { all: true }),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("官网 DNS 解析超时")), Math.max(1, Math.min(10_000, timeoutMs)));
			}),
		]);
		if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
			throw new Error("不能抓取本机、内网或保留地址");
		return { url, address: addresses[0].address };
	} finally {
		clearTimeout(timer);
	}
}

/** Connect to the checked IP, retaining the original Host/SNI. No second DNS lookup or automatic redirect. */
export async function fetchPublicResource(
	value: URL,
	timeoutMs: number,
	userAgent: string,
): Promise<{
	body: Buffer;
	contentType: string;
	finalUrl: string;
	status: number;
}> {
	let current = value;
	const deadline = Date.now() + timeoutMs;
	for (let redirect = 0; redirect <= 5; redirect += 1) {
		if (Date.now() >= deadline) throw new Error("官网请求超时");
		const { url, address } = await publicTarget(current.href, deadline - Date.now());
		if (Date.now() >= deadline) throw new Error("官网请求超时");
		const result = await new Promise<{
			status: number;
			location?: string;
			body: Buffer;
			contentType: string;
			encoding: string;
		}>((resolve, reject) => {
			const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
				{
					protocol: url.protocol,
					hostname: address,
					port: url.port || undefined,
					servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
					path: `${url.pathname}${url.search}`,
					headers: { host: url.host, "user-agent": userAgent },
				},
				(response) => {
					const chunks: Buffer[] = [];
					let bytes = 0;
					response.on("data", (chunk: Buffer) => {
						bytes += chunk.length;
						if (bytes > 8 * 1024 * 1024) request.destroy(new Error("官网响应超过 8 MiB 限制"));
						else chunks.push(chunk);
					});
					response.on("error", reject);
					response.on("end", () =>
						resolve({
							status: response.statusCode ?? 0,
							location: response.headers.location,
							body: Buffer.concat(chunks),
							contentType: response.headers["content-type"] ?? "",
							encoding: response.headers["content-encoding"] ?? "",
						}),
					);
				},
			);
			const timer = setTimeout(() => request.destroy(new Error("官网请求超时")), Math.max(1, deadline - Date.now()));
			request.on("close", () => clearTimeout(timer));
			request.on("error", reject);
			request.end();
		});
		if (result.status >= 300 && result.status < 400) {
			if (!result.location) throw new Error("官网返回无地址重定向");
			current = new URL(result.location, url);
			continue;
		}
		const body = decodePublicBody(result.body, result.encoding);
		if (result.status < 200 || result.status >= 300)
			throw new PublicHttpError(url.href, result.status, body, result.contentType);
		return { body, contentType: result.contentType, finalUrl: url.href, status: result.status };
	}
	throw new Error("官网重定向次数过多");
}

export async function fetchPublicText(value: URL, timeoutMs: number, userAgent: string) {
	const result = await fetchPublicResource(value, timeoutMs, userAgent);
	return { ...result, body: result.body.toString("utf8") };
}
