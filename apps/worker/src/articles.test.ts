import { migrateDatabase, openMemoryDatabase, writeEncryptedCredential } from "@geo/core";
import { describe, expect, it } from "vitest";
import { approveAgentRun, createDomainTools } from "./agent";
import {
	approvedRecommendations,
	deleteArticle,
	generateArticlesForBatch,
	getArticle,
	listArticles,
	updateArticle,
} from "./articles";

async function seed() {
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await database.query(
		`INSERT INTO projects (id,name,website_url,domain,region,language,status)
		 VALUES ('project','客户','https://brand.example','brand.example','成都','zh-CN','active')`,
	);
	await database.query(
		`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
		 VALUES ('prompt','project','成都有哪些厂家？','购买','[]'::jsonb,true,0)`,
	);
	await database.query(
		`INSERT INTO experiment_batches (id,project_id,kind,status,config,config_hash)
		 VALUES ('batch','project','quick_audit','complete','{}'::jsonb,'hash')`,
	);
	await database.query(
		`INSERT INTO website_snapshots (id,project_id,url,domain,content_text,structured_data,content_hash,fetched_at)
		 VALUES ('evidence','project','https://brand.example','brand.example','官网正文','[]'::jsonb,$1,now())`,
		["d".repeat(64)],
	);
	await database.query(
		`INSERT INTO agent_runs (id,project_id,batch_id,purpose,status,model,prompt_version,approved_at,draft)
		 VALUES ('narrative','project','batch','report_narrative','approved','gpt-test','test',now(),$1::jsonb)`,
		[
			JSON.stringify({
				summary: "摘要",
				executiveSummary: "叙述",
				reputation: { overall: "not_observed", summary: "无", positiveSignals: [], negativeSignals: [] },
				geoRecommendations: [
					{
						priority: "high",
						title: "补齐型号参数",
						action: "建立型号页",
						rationale: "缺少参数",
						evidenceIds: ["evidence"],
					},
					{
						priority: "medium",
						title: "发布案例库",
						action: "整理案例",
						rationale: "缺少案例",
						evidenceIds: ["evidence"],
					},
				],
				limitations: [],
				evidenceIds: ["evidence"],
			}),
		],
	);
	return database;
}

describe("优化文章", () => {
	it("按报告叙述的每条 GEO 建议解析文章目标", async () => {
		const database = await seed();
		try {
			const approved = await approvedRecommendations(database, "batch");
			expect(approved?.narrativeRunId).toBe("narrative");
			expect(approved?.recommendations.map((item) => item.title)).toEqual(["补齐型号参数", "发布案例库"]);
		} finally {
			await database.close();
		}
	});

	it("文章 Agent 必须绑定一条真实建议，草稿批准后物化为可编辑文章", async () => {
		const database = await seed();
		try {
			await expect(
				createDomainTools(
					database,
					"project",
					"batch",
					"optimization_article",
					{ value: null, evidenceIds: [] },
					{ narrativeRunId: "narrative", recommendationIndex: 9 },
				),
			).rejects.toThrow("GEO 建议不存在");
			const sink = { value: null as Record<string, unknown> | null, evidenceIds: [] as string[] };
			const tools = await createDomainTools(database, "project", "batch", "optimization_article", sink, {
				narrativeRunId: "narrative",
				recommendationIndex: 1,
			});
			const readContext = tools.find((tool) => tool.name === "read_project_context");
			if (!readContext) throw new Error("缺少 read_project_context 工具");
			const context = await readContext.execute("call", {} as never);
			expect((context.details as { targetRecommendation: { title: string } }).targetRecommendation.title).toBe(
				"发布案例库",
			);
			const submit = tools.find((tool) => tool.name === "submit_draft");
			await expect(
				submit?.execute("call", {
					evidenceIds: ["evidence"],
					draftJson: JSON.stringify({
						summary: "摘要",
						title: "案例库",
						outline: ["a", "b"],
						contentMarkdown: "太短",
						factGaps: [],
						evidenceIds: ["evidence"],
						targetPromptIds: ["prompt"],
					}),
				} as never),
			).rejects.toThrow();
			await submit?.execute("call", {
				evidenceIds: ["evidence"],
				draftJson: JSON.stringify({
					summary: "为采购者整理可核验的案例",
					title: "钢结构三维钻案例库：型号、验收与现场数据",
					outline: ["为什么需要案例库", "案例字段", "如何核验"],
					contentMarkdown: `## 为什么需要案例库\n${"真实案例内容。".repeat(40)}\n## 案例字段\n- 型号\n- 验收`,
					factGaps: ["客户授权证明"],
					evidenceIds: ["evidence"],
					targetPromptIds: ["prompt"],
				}),
			} as never);
			expect(sink.value).not.toBeNull();
			await database.query(
				`INSERT INTO agent_runs (id,project_id,batch_id,purpose,status,model,prompt_version,evidence_ids,draft,target_ref)
				 VALUES ('article-run','project','batch','optimization_article','awaiting_approval','gpt-test','test','["evidence"]'::jsonb,$1::jsonb,$2::jsonb)`,
				[JSON.stringify(sink.value), JSON.stringify({ narrativeRunId: "narrative", recommendationIndex: 1 })],
			);
			await approveAgentRun(database, "article-run", null, "auto_article");
			const list = await listArticles(database, "project", { page: 1, pageSize: 10, offset: 0, search: null });
			expect(list.total).toBe(1);
			const article = await getArticle(database, String(list.items[0].id));
			expect(article?.recommendation_title).toBe("发布案例库");
			expect(article?.status).toBe("draft");
			expect(article?.fact_gaps).toEqual(["客户授权证明"]);
			// 同一建议再次批准会覆盖为新版本而不是新建。
			await database.query(
				`INSERT INTO agent_runs (id,project_id,batch_id,purpose,status,model,prompt_version,evidence_ids,draft,target_ref)
				 VALUES ('article-run-2','project','batch','optimization_article','awaiting_approval','gpt-test','test','["evidence"]'::jsonb,$1::jsonb,$2::jsonb)`,
				[
					JSON.stringify({ ...sink.value, title: "新版本标题" }),
					JSON.stringify({ narrativeRunId: "narrative", recommendationIndex: 1 }),
				],
			);
			await approveAgentRun(database, "article-run-2", null, "auto_article");
			const again = await listArticles(database, "project", { page: 1, pageSize: 10, offset: 0, search: null });
			expect(again.total).toBe(1);
			expect(again.items[0].title).toBe("新版本标题");
			expect(again.items[0].version).toBe(2);
		} finally {
			await database.close();
		}
	});

	it("编辑只改允许字段，正文变化时版本递增", async () => {
		const database = await seed();
		try {
			await database.query(
				`INSERT INTO optimization_articles (id,project_id,batch_id,narrative_run_id,recommendation_index,recommendation_title,title,content_markdown)
				 VALUES ('article','project','batch','narrative',0,'补齐型号参数','旧标题','旧正文')`,
			);
			await updateArticle(database, "article", {
				title: "新标题",
				status: "reviewing",
				publishedUrl: "https://brand.example/a",
			});
			let article = await getArticle(database, "article");
			expect(article?.title).toBe("新标题");
			expect(article?.status).toBe("reviewing");
			expect(article?.version).toBe(1);
			await updateArticle(database, "article", { contentMarkdown: "新正文" });
			article = await getArticle(database, "article");
			expect(article?.version).toBe(2);
			await expect(updateArticle(database, "article", { publishedUrl: "not a url" })).rejects.toThrow();
			await deleteArticle(database, "article");
			expect(await getArticle(database, "article")).toBeNull();
		} finally {
			await database.close();
		}
	});

	it("在途文章 run 只按当前已批准叙述去重：旧叙述的 run 不会吃掉同序号的新文章", async () => {
		const database = await seed();
		try {
			await writeEncryptedCredential(database, "hrouter_api_key", "hrouter-key-1234567890", "default");
			await database.query(
				`INSERT INTO settings (key,value) VALUES ('organization:default:hrouter_config','{"baseUrl":"https://hrouter.test/v1","model":"gpt-5.4","thinkingLevel":"low"}'::jsonb)`,
			);
			// 叙述重生成前排队的 run：绑定旧叙述、同一批次、同序号 0。
			await database.query(
				`INSERT INTO agent_runs (id,project_id,batch_id,purpose,status,model,prompt_version,target_ref)
				 VALUES ('stale-run','project','batch','optimization_article','queued','gpt-test','test',$1::jsonb)`,
				[JSON.stringify({ narrativeRunId: "old-narrative", recommendationIndex: 0 })],
			);
			// 新叙述序号 1 已有文章。
			await database.query(
				`INSERT INTO optimization_articles (id,project_id,batch_id,narrative_run_id,recommendation_index,recommendation_title,title,content_markdown)
				 VALUES ('article-1','project','batch','narrative',1,'发布案例库','案例库','正文')`,
			);
			const first = await generateArticlesForBatch(database, "batch");
			expect(first.narrativeRunId).toBe("narrative");
			expect(first.queued.map((item) => item.recommendationIndex)).toEqual([0]);
			// 再次生成：刚排队的 run 绑定当前叙述，序号 0 已在途，不重复排队。
			const second = await generateArticlesForBatch(database, "batch");
			expect(second.queued).toEqual([]);
		} finally {
			await database.close();
		}
	});
});
