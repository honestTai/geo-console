import { describe, expect, it } from "vitest";
import { buildScopeBundle, parseScopeBundle, SCOPE_BUNDLE_KIND } from "./scope-bundle";

describe("监测范围导入导出包", () => {
	const project = { name: "诚泰科技", domain: "honesttai.com" };
	const scope = {
		aliases: ["诚泰科技", "诚泰"],
		competitors: [{ id: "competitor-1", name: "云脉智搜", domain: "yunmai-ai.example.com", aliases: ["云脉"] }],
		prompts: [
			{
				id: "prompt-1",
				library_question_id: "library-1",
				question: "成都有哪些靠谱的 GEO 服务商？",
				intent: "供应商推荐",
				topic: "服务商选择",
				persona: "市场负责人",
				tags: ["推荐"],
			},
		],
	};

	it("导出只保留业务字段，导入后能原样恢复", () => {
		const bundle = buildScopeBundle(project, scope, "2026-09-03T00:00:00.000Z");
		expect(bundle.kind).toBe(SCOPE_BUNDLE_KIND);
		expect(JSON.stringify(bundle)).not.toContain("competitor-1");
		expect(JSON.stringify(bundle)).not.toContain("library-1");
		const restored = parseScopeBundle(JSON.parse(JSON.stringify(bundle)));
		expect(restored).toEqual({
			aliases: ["诚泰科技", "诚泰"],
			competitors: [{ name: "云脉智搜", domain: "yunmai-ai.example.com", aliases: ["云脉"] }],
			prompts: [
				{
					question: "成都有哪些靠谱的 GEO 服务商？",
					intent: "供应商推荐",
					topic: "服务商选择",
					persona: "市场负责人",
					tags: ["推荐"],
				},
			],
		});
	});

	it("清洗脏数据：空竞品、过短问题被丢弃，缺失意图给默认值", () => {
		const restored = parseScopeBundle({
			kind: SCOPE_BUNDLE_KIND,
			aliases: ["  客户 ", "", 3],
			competitors: [{ name: " 竞品 ", domain: "" }, { name: "有效竞品", domain: "rival.cn", aliases: "不是数组" }],
			prompts: [{ question: "短" }, { question: "这个问题足够长了吗？", topic: "", persona: null }],
		});
		expect(restored.aliases).toEqual(["客户"]);
		expect(restored.competitors).toEqual([{ name: "有效竞品", domain: "rival.cn", aliases: [] }]);
		expect(restored.prompts).toEqual([
			{ question: "这个问题足够长了吗？", intent: "购买决策", topic: null, persona: null, tags: [] },
		]);
	});

	it("拒绝其他类型的文件与没有问题的范围包", () => {
		expect(() => parseScopeBundle({ kind: "geo-settings" })).toThrow("监测范围包");
		expect(() => parseScopeBundle({ kind: SCOPE_BUNDLE_KIND, prompts: [] })).toThrow("购买问题");
	});
});
