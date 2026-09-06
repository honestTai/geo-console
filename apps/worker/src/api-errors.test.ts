import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiErrorResponse } from "./api-errors";
import { HttpInputError } from "./utils";

describe("public API failure contract", () => {
	it("does not expose unexpected database/internal failures", () => {
		const result = apiErrorResponse(new Error("duplicate key: private-schema credentials=secret-value"), "trace-test");
		expect(result.status).toBe(500);
		expect(result.body.error).not.toContain("private-schema");
		expect(result.body.error).not.toContain("secret-value");
		expect(result.body.requestId).toBe("trace-test");
	});
	it("retains actionable domain conflicts instead of pretending they are server faults", () => {
		expect(apiErrorResponse(new HttpInputError("请先批准报告叙述", 409), "t")).toEqual({
			status: 409,
			body: { error: "请先批准报告叙述", requestId: "t" },
		});
	});
	it("formats invalid input without dumping Zod internals or the input value", () => {
		const parsed = z.object({ page: z.number().min(1) }).safeParse({ page: -1 });
		if (parsed.success) throw new Error("fixture");
		const response = apiErrorResponse(parsed.error, "t");
		expect(response.status).toBe(400);
		expect(response.body.error).toContain("page");
		expect(response.body.error).not.toContain("origin");
	});
});
