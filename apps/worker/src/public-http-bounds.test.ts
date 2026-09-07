import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { assertPublicUrl, decodePublicBody, fetchPublicResource, isPublicAddress } from "./public-http";

describe("public website transport boundaries", () => {
	it("honors a total request budget before DNS or redirect work", async () => {
		await expect(fetchPublicResource(new URL("https://example.com"), 0, "test")).rejects.toThrow("官网请求超时");
	});
	it("decodes gzip XML maps and bounds decompression", () => {
		const xml = Buffer.from("<urlset><url><loc>https://example.com/</loc></url></urlset>");
		expect(decodePublicBody(gzipSync(xml), "").toString()).toBe(xml.toString());
		expect(decodePublicBody(gzipSync(xml), "gzip").toString()).toBe(xml.toString());
		expect(() => decodePublicBody(gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1)), "gzip")).toThrow();
	});
	it("rejects private, loopback, metadata and non-HTTP targets before any request", async () => {
		for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "::ffff:127.0.0.1"])
			expect(isPublicAddress(address)).toBe(false);
		for (const value of [
			"http://127.0.0.1",
			"http://169.254.169.254",
			"http://[::1]",
			"file:///etc/passwd",
			"https://u:p@example.com",
		])
			await expect(assertPublicUrl(value)).rejects.toThrow();
		await expect(fetchPublicResource(new URL("http://127.0.0.1"), 1000, "test")).rejects.toThrow("内网");
	});
});
