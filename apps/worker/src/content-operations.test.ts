import { migrateDatabase, openMemoryDatabase, writeEncryptedCredential } from "@geo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueArticleQuality, reviewArticle, reviewArticleQuality, runOneArticleQualityJob } from "./article-quality";
import { updateArticle } from "./articles";
import { authorizeRequest, loadActorPrincipal } from "./authorization";
import {
	approvedKnowledgeSources,
	getCustomerKnowledge,
	reviewCustomerKnowledge,
	saveCustomerKnowledge,
} from "./customer-knowledge";
import {
	createPublicationOrder,
	getPublicationOrder,
	listPublicationOrders,
	savePublicationChannel,
	transitionPublication,
} from "./publications";

const actor = { kind: "local" } as const;
async function setup() {
	const db = openMemoryDatabase();
	await migrateDatabase(db);
	await db.query(
		"INSERT INTO projects(id,name,region,language,status) VALUES('p','测试客户','CN','zh-CN','active'),('other','隔离测试客户','CN','zh-CN','active')",
	);
	return db;
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
describe("客户知识与人工发布", () => {
	it("知识版本批准、过期与跨客户边界，历史不可覆盖", async () => {
		const db = await setup();
		try {
			const asset = await saveCustomerKnowledge(
				db,
				"p",
				null,
				{ title: "产品说明", kind: "product", content: "测试规格", sourceNote: "客户提供的测试材料" },
				actor,
			);
			expect(await approvedKnowledgeSources(db, "p")).toHaveLength(0);
			await reviewCustomerKnowledge(
				db,
				asset.id,
				{ expectedRevision: 1, decision: "approve", note: "已核对来源" },
				actor,
			);
			expect(await approvedKnowledgeSources(db, "p", [asset.revisionId])).toHaveLength(1);
			await expect(approvedKnowledgeSources(db, "other", [asset.revisionId])).rejects.toThrow("当前客户");
			await saveCustomerKnowledge(
				db,
				"p",
				asset.id,
				{ expectedRevision: 1, title: "产品说明", kind: "product", content: "测试规格第二版", sourceNote: "新材料" },
				actor,
			);
			expect((await getCustomerKnowledge(db, asset.id)).revisions).toHaveLength(2);
			await expect(approvedKnowledgeSources(db, "p", [asset.revisionId])).rejects.toThrow("失效");
			await expect(
				db.query("UPDATE customer_knowledge_revisions SET content='changed' WHERE id=$1", [asset.revisionId]),
			).rejects.toThrow("immutable");
			await expect(
				saveCustomerKnowledge(
					db,
					"p",
					asset.id,
					{ expectedRevision: 1, title: "旧版本", kind: "product", content: "覆盖", sourceNote: "来源" },
					actor,
				),
			).rejects.toThrow("版本");
			await db.query("UPDATE projects SET status='archived' WHERE id='p'");
			await expect(
				reviewCustomerKnowledge(db, asset.id, { expectedRevision: 2, decision: "approve", note: "已核对" }, actor),
			).rejects.toThrow("封档");
		} finally {
			await db.close();
		}
	});
	it("冻结版本和渠道、质检门禁、状态并发及不可变回执", async () => {
		const db = await setup();
		try {
			await writeEncryptedCredential(db, "hrouter_api_key", "test-only");
			await db.query(
				`INSERT INTO settings(key,value) VALUES('organization:default:hrouter_config','{"baseUrl":"https://model.example/v1","model":"gpt-test"}')`,
			);
			const plan = {
				purpose: "产品说明",
				audience: "读者",
				problem: "事实核对",
				contentStrategy: { format: "短文", rationale: "问题简短", lengthApproach: "以事实为准" },
				channels: [
					{
						platform: "客户渠道",
						placement: "产品栏目",
						reason: "与读者相关",
						adaptation: "短文",
						prerequisite: "人工确认账号",
						basis: "candidate",
						evidenceIds: [],
					},
				],
				acceptance: ["人工核对发布正文"],
			};
			await db.query(
				"INSERT INTO website_snapshots(id,project_id,url,domain,content_text,structured_data,content_hash,fetched_at) VALUES('source','p','https://brand.example','brand.example','仅用于测试的文字','[]',$1,now())",
				["a".repeat(64)],
			);
			await db.query(
				"INSERT INTO optimization_articles(id,project_id,recommendation_title,title,content_markdown,publication_plan,evidence_ids) VALUES('a','p','测试建议','测试文章','仅用于测试的文字',$1::jsonb,'[\"source\"]')",
				[JSON.stringify(plan)],
			);
			const channel = await savePublicationChannel(
				db,
				"p",
				null,
				{
					name: "测试渠道",
					platform: "客户指定平台",
					accountName: "测试账号",
					targetUrl: "https://publish.example/editor",
				},
				actor,
			);
			const order = await createPublicationOrder(
				db,
				"p",
				{ articleId: "a", articleVersion: 1, channelId: channel.id },
				actor,
			);
			await expect(
				createPublicationOrder(db, "p", { articleId: "a", articleVersion: 1, channelId: channel.id }, actor),
			).rejects.toThrow("已有工单");
			await expect(
				createPublicationOrder(db, "other", { articleId: "a", articleVersion: 1, channelId: channel.id }, actor),
			).rejects.toThrow("文章不存在");
			await expect(
				transitionPublication(db, order.id, { expectedRevision: 1, status: "ready", note: "提交" }, actor),
			).rejects.toThrow("人工审核");
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								status: "completed",
								output_text: JSON.stringify({ verdict: "pass", summary: "测试质检通过", issues: [] }),
							}),
							{ status: 200 },
						),
				),
			);
			const run = await enqueueArticleQuality(db, "a", { version: 1 }, actor);
			await runOneArticleQualityJob(db, "test");
			await reviewArticle(db, "a", { version: 1, decision: "approve", note: "审核测试正文" }, actor);
			await reviewArticleQuality(db, run.id, { version: 1, decision: "approve", note: "复核测试结果" }, actor);
			await transitionPublication(db, order.id, { expectedRevision: 1, status: "ready", note: "提交" }, actor);
			await expect(
				transitionPublication(db, order.id, { expectedRevision: 1, status: "in_progress", note: "旧版本" }, actor),
			).rejects.toThrow("状态已变化");
			await transitionPublication(db, order.id, { expectedRevision: 2, status: "in_progress", note: "开始" }, actor);
			await savePublicationChannel(
				db,
				"p",
				channel.id,
				{ expectedRevision: 1, name: "更名渠道", platform: "其他平台", accountName: "其他账号" },
				actor,
			);
			await updateArticle(db, "a", { version: 1, title: "第二版标题" });
			await transitionPublication(
				db,
				order.id,
				{
					expectedRevision: 3,
					status: "submitted",
					note: "已发布原版本并核对",
					resultUrl: "https://publish.example/article",
				},
				actor,
			);
			await transitionPublication(
				db,
				order.id,
				{ expectedRevision: 4, status: "verified", note: "人工核对回执和版本一致" },
				actor,
			);
			const detail = await getPublicationOrder(db, order.id);
			expect(detail.channel_snapshot.name).toBe("测试渠道");
			expect(detail.article_snapshot.title).toBe("测试文章");
			expect(detail.receipts).toHaveLength(1);
			expect(detail.events).toHaveLength(5);
			expect(
				(await db.query<{ status: string }>("SELECT status FROM optimization_articles WHERE id='a'")).rows[0].status,
			).toBe("draft");
			await expect(db.query("DELETE FROM publication_receipts WHERE order_id=$1", [order.id])).rejects.toThrow(
				"immutable",
			);
			expect(
				(
					await listPublicationOrders(
						db,
						"p",
						{ page: 1, pageSize: 20, offset: 0, search: null },
						{ status: "verified" },
					)
				).total,
			).toBe(1);
		} finally {
			await db.close();
		}
	});
	it("新的页面策略默认拒绝未获授权身份，且资源按客户归属解析", async () => {
		const db = await setup();
		try {
			const principal = await loadActorPrincipal(db, actor, "default");
			expect(principal).not.toBeNull();
			await authorizeRequest(db, principal!, "GET", "/api/projects/p/publications");
			const restricted = {
				...principal!,
				systemAdmin: false,
				permissions: ["page.publications"],
				projects: { all: false, ids: ["p"] },
			};
			await authorizeRequest(db, restricted, "GET", "/api/projects/p/publications");
			await expect(authorizeRequest(db, restricted, "GET", "/api/projects/other/publications")).rejects.toThrow(
				"不存在",
			);
			await expect(authorizeRequest(db, restricted, "POST", "/api/projects/p/publications")).rejects.toThrow("权限");
		} finally {
			await db.close();
		}
	});
});
