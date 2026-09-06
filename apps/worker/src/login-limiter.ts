import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { HttpInputError } from "./utils";

/** Only enable behind the isolated Caddy proxy; never trust forwarded headers on a directly exposed API. */
export function loginClientAddress(request: IncomingMessage): string {
	const value = request.headers["x-forwarded-for"];
	const forwarded = typeof value === "string" ? value.split(",").at(-1)?.trim() : undefined;
	return process.env.GEO_TRUST_PROXY === "true" && forwarded && isIP(forwarded)
		? forwarded
		: (request.socket.remoteAddress ?? "unknown");
}

export class LoginLimiter {
	private readonly entries = new Map<string, { count: number; until: number }>();
	constructor(private readonly now = () => Date.now()) {}
	check(account: string, address: string): void {
		const now = this.now();
		for (const [key, value] of this.entries) if (value.until <= now) this.entries.delete(key);
		for (const [key, limit] of [
			[`account:${account.toLowerCase()}`, 20],
			[`ip:${address}`, 120],
		] as const) {
			const value = this.entries.get(key) ?? { count: 0, until: now + 15 * 60_000 };
			if (value.count >= limit || (!this.entries.has(key) && this.entries.size >= 10_000))
				throw new HttpInputError("登录尝试过于频繁，请 15 分钟后重试", 429);
			value.count += 1;
			this.entries.set(key, value);
		}
	}
}
export const loginLimiter = new LoginLimiter();
