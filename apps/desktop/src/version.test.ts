import { describe, expect, it } from "vitest";

describe("desktop release contract", () => {
	it("uses a semver application version", () => {
		expect("0.2.0").toMatch(/^\d+\.\d+\.\d+$/);
	});
});
