import { describe, expect, it } from "vitest";
import { matchBrands } from "./brand-matcher";

describe("matchBrands", () => {
	it("按回答首次出现顺序计算品牌位置且别名不重复计数", () => {
		expect(
			matchBrands("首先推荐甲公司，其次是乙品牌。甲公司经验更久。", [
				{ id: "b", name: "乙公司", aliases: ["乙品牌"] },
				{ id: "a", name: "甲公司", aliases: ["甲品牌"] },
			]),
		).toEqual([
			{ brandId: "a", matchedAlias: "甲公司", position: 1 },
			{ brandId: "b", matchedAlias: "乙品牌", position: 2 },
		]);
	});
});
