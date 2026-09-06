import { describe, expect, it } from "vitest";
import { LoginLimiter } from "./login-limiter";
import { artifactSafetyHeaders } from "./object-store";
import { assertPublicUrl, isPublicAddress } from "./public-http";
import { safeReportLink } from "./report-snapshots";
import { HttpInputError, readJson } from "./utils";

describe("输入和网络边界", () => {
	it("报告中的非 HTTP(S) 来源只能作为文本，不能执行 javascript URL", () => {
		expect(safeReportLink("javascript://example.com/%0Aalert(1)")).not.toContain("href=");
		expect(safeReportLink("https://example.com/a")).toContain('href="https://example.com/a"');
	});
	it("HTML 原始证据必须下载并沙箱化，不能同域执行脚本", () => {
		expect(artifactSafetyHeaders("text/html; charset=utf-8")).toMatchObject({
			"content-disposition": "attachment",
			"x-content-type-options": "nosniff",
		});
		expect(artifactSafetyHeaders("text/html")["content-security-policy"]).toContain("sandbox");
	});
	it.each([
		"127.0.0.1",
		"10.0.0.1",
		"172.16.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"::1",
		"::ffff:127.0.0.1",
		"fd00::1",
		"fe80::1",
		"2001:db8::1",
	])("拒绝内网和特殊地址 %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
	it("支持公开 IPv4 和 IPv6", () => {
		expect(isPublicAddress("8.8.8.8")).toBe(true);
		expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
	});
	it("拒绝协议、凭据与数字编码 loopback", async () => {
		await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
		await expect(assertPublicUrl("https://user:password@example.com")).rejects.toThrow();
		await expect(assertPublicUrl("http://0x7f000001")).rejects.toThrow();
	});
	it("请求体有界，畸形 JSON 返回输入错误", async () => {
		async function* chunks(text: string) {
			yield Buffer.from(text);
		}
		await expect(readJson(chunks("123456"), 3)).rejects.toMatchObject({ status: 413 });
		await expect(readJson(chunks("{"))).rejects.toBeInstanceOf(HttpInputError);
		expect(await readJson(chunks("{}"))).toEqual({});
	});
	it("账户限流窗口结束后恢复", () => {
		let now = 0;
		const limiter = new LoginLimiter(() => now);
		for (let i = 0; i < 20; i++) limiter.check("USER@example.com", `ip${i}`);
		expect(() => limiter.check("user@example.com", "new-ip")).toThrow();
		now = 15 * 60_000 + 1;
		expect(() => limiter.check("user@example.com", "new-ip")).not.toThrow();
	});
});
