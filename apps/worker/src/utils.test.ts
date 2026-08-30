import { describe, expect, it } from "vitest";
import { normalizeDomain, stableJson } from "./utils";

describe("worker utils", () => {
	it("规范化客户域名", () => expect(normalizeDomain("https://www.Example.com/path")).toBe("example.com"));
	it("稳定序列化不受键顺序影响", () => expect(stableJson({ b: 2, a: 1 })).toBe(stableJson({ a: 1, b: 2 })));
});
