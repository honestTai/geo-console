import { describe, expect, it } from "vitest";
import { routeMatch } from "./http-routes";

describe("HTTP route dispatch", () => {
	it("distinguishes measurement reparse from the optional review suffix", () => {
		const route = /^\/api\/batches\/([^/]+)\/measurement(\/review)?$/;
		expect(routeMatch("/api/batches/b/measurement", route)).toEqual(["b", ""]);
		expect(Boolean(routeMatch("/api/batches/b/measurement", route)?.[1])).toBe(false);
		expect(routeMatch("/api/batches/b/measurement/review", route)).toEqual(["b", "/review"]);
	});
	it("malformed URL parameters are input errors, not internal server failures", () => {
		expect(() => routeMatch("/share/%zz", /^\/share\/([^/]+)$/)).toThrow("路由参数编码无效");
	});
});
