import { migrateDatabase, openMemoryDatabase, writeEncryptedCredential } from "@geo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	articleVersion,
	assertArticlePublishable,
	enqueueArticleQuality,
	getArticleQuality,
	reviewArticle,
	reviewArticleQuality,
	runOneArticleQualityJob,
} from "./article-quality";
import { exportArticles, getArticle, listArticles, updateArticle } from "./articles";
import { reviewCustomerKnowledge, saveCustomerKnowledge } from "./customer-knowledge";

const actor = { kind: "local" } as const;
const plan = {
	purpose: "核对已公开产品信息",
	audience: "采购者",
	problem: "产品事实缺少出处",
	contentStrategy: { format: "产品事实清单", rationale: "逐条回答已知信息", lengthApproach: "由证据长度决定" },
	channels: [
		{
			platform: "官网",
			placement: "产品页",
			reason: "公开信息",
			adaptation: "事实清单",
			prerequisite: "有发布权限",
			basis: "owned",
			evidenceIds: ["source"],
		},
	],
	acceptance: ["复核原文与发布地址"],
};
async function seed() {
	vi.stubEnv("GEO_MASTER_KEY", Buffer.alloc(32, 2).toString("base64"));
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await writeEncryptedCredential(database, "hrouter_api_key", "test-only-secret");
	await database.query(
		`INSERT INTO settings(key,value) VALUES('organization:default:hrouter_config','{"baseUrl":"https://hrouter.test/v1","model":"gpt-test"}')`,
	);
	await database.query(
		`INSERT INTO projects(id,name,website_url,domain,region,language,status) VALUES('project','测试客户','https://brand.example','brand.example','CN','zh-CN','active'),('other','其他测试客户',NULL,NULL,'CN','zh-CN','active')`,
	);
	await database.query(
		`INSERT INTO website_snapshots(id,project_id,url,domain,content_text,structured_data,content_hash,fetched_at) VALUES('source','project','https://brand.example','brand.example','仅测试产品事实','[]',$1,now())`,
		["a".repeat(64)],
	);
	await database.query(
		`INSERT INTO optimization_articles(id,project_id,recommendation_title,title,summary,content_markdown,evidence_ids,publication_plan) VALUES('article','project','测试建议','测试文章','测试摘要','仅测试产品事实','["source"]',$1::jsonb)`,
		[JSON.stringify(plan)],
	);
	return database;
}
const passResponse = () =>
	new Response(
		JSON.stringify({
			status: "completed",
			output_text: JSON.stringify({ verdict: "pass", summary: "已核对提供的事实。", issues: [] }),
			usage: { input_tokens: 50, output_tokens: 100 },
		}),
		{ status: 200 },
	);
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("文章版本质检和发布门禁", () => {
	it("冻结输入、异步模型无工具、必须分别人工审核与复核后才能发布；编辑令审批失效并保留历史", async () => {
		const database = await seed();
		try {
			const fetcher = vi.fn(async () => passResponse());
			vi.stubGlobal("fetch", fetcher);
			expect((await getArticleQuality(database, "article")).qualityStatus).toBe("pending");
			expect(fetcher).not.toHaveBeenCalled();
			const quality = await enqueueArticleQuality(database, "article", { version: 1 }, actor);
			expect(await enqueueArticleQuality(database, "article", { version: 1 }, actor)).toEqual(quality);
			await expect(assertArticlePublishable(database, "article", 1)).rejects.toThrow("人工审核");
			expect(await runOneArticleQualityJob(database, "test-owner")).toBe(true);
			expect(await runOneArticleQualityJob(database, "test-owner")).toBe(false);
			const body = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
			expect(body).toMatchObject({ tools: [], tool_choice: "none", store: false, model: "gpt-test" });
			expect((await getArticleQuality(database, "article")).qualityStatus).toBe("needs_review");
			await reviewArticle(database, "article", { version: 1, decision: "approve", note: "内容审核通过" }, actor);
			await expect(assertArticlePublishable(database, "article", 1)).rejects.toThrow("复核通过");
			await reviewArticleQuality(
				database,
				quality.id,
				{ version: 1, decision: "approve", note: "证据与原文一致" },
				actor,
			);
			const snapshot = await assertArticlePublishable(database, "article", 1);
			expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
			await updateArticle(database, "article", {
				version: 1,
				status: "published",
				publishedUrl: "https://brand.example/article",
			});
			expect((await getArticle(database, "article"))?.status).toBe("published");
			await updateArticle(database, "article", { version: 1, title: "修改后的测试标题", status: "draft" });
			expect((await articleVersion(database, "article")).version).toBe(2);
			expect(await getArticleQuality(database, "article")).toMatchObject({
				qualityStatus: "stale",
				editorialStatus: "stale",
			});
			await expect(
				reviewArticleQuality(database, quality.id, { version: 2, decision: "approve", note: "过期不可审核" }, actor),
			).rejects.toThrow("过期");
			await expect(updateArticle(database, "article", { version: 1, title: "并发旧内容" })).rejects.toThrow("已被更新");
			expect((await database.query("SELECT * FROM article_versions WHERE article_id='article'")).rows).toHaveLength(2);
			await expect(
				database.query("UPDATE article_versions SET snapshot='{}' WHERE article_id='article'"),
			).rejects.toThrow("immutable");
			await expect(
				database.query("UPDATE article_quality_runs SET sources='[]' WHERE id=$1", [quality.id]),
			).rejects.toThrow("immutable");
			const list = await listArticles(
				database,
				"project",
				{ page: 1, pageSize: 25, offset: 0, search: null },
				{ qualityStatus: "stale", reviewStatus: "stale" },
			);
			expect(list.total).toBe(1);
			expect((await exportArticles(database, "project", { articleIds: ["article"] })).files[0].version).toBe(2);
			await expect(exportArticles(database, "other", { articleIds: ["article"] })).rejects.toThrow("不属于");
		} finally {
			await database.close();
		}
	});

	it("缺失引文、外部证据和阻断项不能被人工复核为通过，失败保留实际状态", async () => {
		const database = await seed();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								status: "completed",
								output_text: JSON.stringify({
									verdict: "pass",
									summary: "不可靠结果",
									issues: [
										{
											severity: "blocking",
											category: "factual",
											message: "不可靠引文",
											field: "contentMarkdown",
											quote: "正文没有这个内容",
											evidenceIds: ["foreign"],
											suggestion: "核对",
										},
									],
								}),
							}),
							{ status: 200 },
						),
				),
			);
			const quality = await enqueueArticleQuality(database, "article", { version: 1 }, actor);
			await runOneArticleQualityJob(database, "test-owner");
			const result = await getArticleQuality(database, "article");
			expect(result.qualityStatus).toBe("failed");
			expect(result.runs[0].result).toBeNull();
			await expect(
				reviewArticleQuality(database, quality.id, { version: 1, decision: "approve", note: "不可批准" }, actor),
			).rejects.toThrow("可复核结果");
			expect(
				(await database.query("SELECT cost_micros FROM project_costs WHERE operation='article_quality'")).rows[0]
					.cost_micros,
			).toBeNull();
		} finally {
			await database.close();
		}
	});

	it("知识版本必须批准且属于当前客户，资料更新后原质检失效", async () => {
		const database = await seed();
		try {
			const input = { title: "测试事实", kind: "fact", content: "仅测试产品事实", sourceNote: "仅用于测试的提供资料" };
			const knowledge = await saveCustomerKnowledge(database, "project", null, input, actor);
			await expect(
				enqueueArticleQuality(database, "article", { version: 1, knowledgeRevisionIds: [knowledge.revisionId] }, actor),
			).rejects.toThrow("已批准");
			await reviewCustomerKnowledge(
				database,
				knowledge.id,
				{ expectedRevision: 1, decision: "approve", note: "已核对" },
				actor,
			);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => passResponse()),
			);
			const quality = await enqueueArticleQuality(
				database,
				"article",
				{ version: 1, knowledgeRevisionIds: [knowledge.revisionId] },
				actor,
			);
			await runOneArticleQualityJob(database, "test-owner");
			await reviewArticleQuality(database, quality.id, { version: 1, decision: "approve", note: "已核对" }, actor);
			expect((await getArticleQuality(database, "article")).qualityStatus).toBe("passed");
			await saveCustomerKnowledge(
				database,
				"project",
				knowledge.id,
				{ ...input, expectedRevision: 1, content: "资料更新" },
				actor,
			);
			expect((await getArticleQuality(database, "article")).qualityStatus).toBe("stale");
			const list = await listArticles(
				database,
				"project",
				{ page: 1, pageSize: 25, offset: 0, search: null },
				{ qualityStatus: "stale" },
			);
			expect(list.total).toBe(1);
		} finally {
			await database.close();
		}
	});

	it("模型调用期间撤销执行策略后结果不可选用，并记录终止状态", async () => {
		const database = await seed();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					await database.query(
						"UPDATE authorization_policies SET enabled=false WHERE policy_key='articles.quality.run'",
					);
					return passResponse();
				}),
			);
			await enqueueArticleQuality(database, "article", { version: 1 }, actor);
			await runOneArticleQualityJob(database, "test-owner");
			const view = await getArticleQuality(database, "article");
			expect(view.qualityStatus).toBe("failed");
			expect(view.runs[0].result).toBeNull();
			expect((await database.query("SELECT status FROM jobs WHERE type='article_quality'")).rows[0].status).toBe(
				"failed",
			);
			expect((await database.query("SELECT * FROM article_quality_attempts")).rows).toHaveLength(1);
		} finally {
			await database.close();
		}
	});

	it.each(["queued", "running"])("知识读取策略在 %s 阶段撤销后不得继续使用质检结果", async (stage) => {
		const database = await seed();
		try {
			const knowledge = await saveCustomerKnowledge(
				database,
				"project",
				null,
				{
					title: "测试事实",
					kind: "fact",
					content: "仅测试产品事实",
					sourceNote: "仅用于授权回归测试",
				},
				actor,
			);
			await reviewCustomerKnowledge(
				database,
				knowledge.id,
				{
					expectedRevision: 1,
					decision: "approve",
					note: "已核对",
				},
				actor,
			);
			await enqueueArticleQuality(
				database,
				"article",
				{
					version: 1,
					knowledgeRevisionIds: [knowledge.revisionId],
				},
				actor,
			);
			const revoke = () =>
				database.query("UPDATE authorization_policies SET enabled=false WHERE policy_key='knowledge.assets.read'");
			const fetcher = vi.fn(async () => {
				await revoke();
				return passResponse();
			});
			vi.stubGlobal("fetch", fetcher);
			if (stage === "queued") await revoke();
			await runOneArticleQualityJob(database, "test-owner");
			expect(fetcher).toHaveBeenCalledTimes(stage === "queued" ? 0 : 1);
			const view = await getArticleQuality(database, "article");
			expect(view.qualityStatus).toBe("failed");
			expect(view.runs[0].result).toBeNull();
			expect((await database.query("SELECT status FROM jobs WHERE type='article_quality'")).rows[0].status).toBe(
				"failed",
			);
		} finally {
			await database.close();
		}
	});
});
