import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
	it("返回真实 JSON 响应", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
				),
		);
		expect(await api<{ ok: boolean }>("/api/health")).toEqual({ ok: true });
	});
	it("保留后端错误信息", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "证据不足" }), { status: 422 })),
		);
		await expect(api("/api/test")).rejects.toThrow("证据不足");
	});
	it("把浏览器网络错误转换为可理解提示", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
		await expect(api("/api/test")).rejects.toThrow("无法连接服务器，请检查网络后重试");
	});
});
