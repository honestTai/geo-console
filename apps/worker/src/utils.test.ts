import { describe, expect, it } from "vitest";
import { normalizeDomain, sha256, stableJson } from "./utils";

describe("worker utils", () => {
	it("规范化客户域名", () => expect(normalizeDomain("https://www.Example.com/path")).toBe("example.com"));
	it("稳定序列化不受键顺序影响", () => expect(stableJson({ b: 2, a: 1 })).toBe(stableJson({ a: 1, b: 2 })));
	it("冻结配置的哈希在写库前后一致（忽略 undefined 字段）", () => {
		const beforeWrite = { providers: [{ id: "kimi_api", secondaryEndpoint: undefined, model: "kimi" }], topic: undefined };
		const afterRead = JSON.parse(JSON.stringify(beforeWrite));
		expect(sha256(stableJson(beforeWrite))).toBe(sha256(stableJson(afterRead)));
		expect(stableJson([1, undefined, 2])).toBe("[1,null,2]");
	});
});
