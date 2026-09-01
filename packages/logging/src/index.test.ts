import { afterEach, describe, expect, it, vi } from "vitest";
import { redactLogText, StructuredLogger, sanitizeLogMetadata } from "./index";

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.GEO_LOG_SERVICE_URL;
	delete process.env.GEO_LOG_SERVICE_TOKEN;
});

describe("structured logging", () => {
	it("脱敏凭据、Cookie、回答正文与 URL token", () => {
		expect(
			sanitizeLogMetadata({
				apiKey: "secret-value",
				answerText: "provider answer",
				nested: { cookie: "session=value", safe: "https://example.com/?token=visible" },
			}),
		).toEqual({
			apiKey: "[REDACTED]",
			answerText: "[REDACTED]",
			nested: { cookie: "[REDACTED]", safe: "https://example.com/?token=[REDACTED]" },
		});
		expect(redactLogText("Bearer abc.def and sk-secretvalue")).not.toContain("abc.def");
	});

	it("批量发送结构化日志且上报失败不抛给业务调用方", async () => {
		process.env.GEO_LOG_SERVICE_URL = "http://logs.test";
		process.env.GEO_LOG_SERVICE_TOKEN = "service-token";
		const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 202 }));
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		const logger = new StructuredLogger("test-service");
		logger.info("test.event", "完成", { organizationId: "organization", metadata: { count: 1 } });
		await logger.flush();
		expect(fetchMock).toHaveBeenCalledWith(
			"http://logs.test/v1/logs",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ authorization: "Bearer service-token" }),
			}),
		);
	});
});
