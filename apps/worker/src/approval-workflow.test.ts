import { describe, expect, it, vi } from "vitest";
import { continueApprovedReport } from "./approval-workflow";
import { HttpInputError } from "./utils";

describe("committed approval and follow-up separation", () => {
	it("exposes denied continuation without retrying or pretending committed approval failed", async () => {
		const error = new HttpInputError("缺少生成权限", 403),
			advance = vi.fn().mockRejectedValue(error);
		expect(await continueApprovedReport({ batchId: "b", purpose: "report_narrative" }, advance)).toEqual({
			status: "blocked",
			workflow: null,
			error,
		});
		expect(advance).toHaveBeenCalledTimes(1);
	});
	it("returns successful follow-up and skips non-report drafts", async () => {
		const advance = vi.fn().mockResolvedValue({ state: "quality_queued" });
		expect(await continueApprovedReport({ batchId: "b", purpose: "report_narrative" }, advance)).toMatchObject({
			status: "advanced",
			workflow: { state: "quality_queued" },
		});
		expect(await continueApprovedReport({ batchId: "b", purpose: "diagnosis" }, advance)).toMatchObject({
			status: "skipped",
		});
		expect(advance).toHaveBeenCalledTimes(1);
	});
});
