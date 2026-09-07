import { describe, expect, it } from "vitest";
import { classifyProviderError, ProviderRequestError } from "./common";

describe("Provider quota classification", () => {
	it("HTTP 402 is actionable quota failure, not a transient provider error", () => {
		expect(
			classifyProviderError(new ProviderRequestError("HTTP 402", 402, { error: { message: "Insufficient Balance" } })),
		).toMatchObject({
			status: "failed",
			failureCode: "quota_exceeded",
			message: expect.stringContaining("手动重新运行"),
		});
	});
	it("quota and rate limiting remain distinct", () => {
		expect(
			classifyProviderError(new ProviderRequestError("429", 429, { error: { code: "insufficient_quota" } }))
				.failureCode,
		).toBe("quota_exceeded");
		expect(
			classifyProviderError(new ProviderRequestError("429", 429, { error: { code: "rate_limit_exceeded" } }))
				.failureCode,
		).toBe("rate_limited");
		expect(classifyProviderError(new ProviderRequestError("401", 401, {})).failureCode).toBe("authentication_failed");
		expect(classifyProviderError(new ProviderRequestError("500", 500, {})).failureCode).toBe("provider_error");
	});
});
