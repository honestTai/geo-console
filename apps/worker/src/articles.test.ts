import { migrateDatabase, openMemoryDatabase, writeEncryptedCredential } from "@geo/core";
import { describe, expect, it } from "vitest";
import { ARTICLE_WRITING_GUIDANCE, approveAgentRun, createDomainTools, parseDraft } from "./agent";
import {
	approvedRecommendations,
	deleteArticle,
	generateArticlesForBatch,
	getArticle,
	listArticles,
	updateArticle,
} from "./articles";
import { seedMetricSnapshot } from "./test-support/measurement";

const publicationPlan = {
	purpose: "回答采购者的案例核验问题",
	audience: "采购负责人",
	problem: "已有案例缺少验收材料",
	contentStrategy: {
		format: "案例核验说明",
		rationale: "关联问题需要核验案例，案例页应列出证据支持的材料而非通用公司介绍",
		lengthApproach: "写清已有材料与待补事实即可，不补写无证据的背景来凑篇幅",
	},
	channels: [
		{
			platform: "客户官网",
			placement: "对应案例页",
			reason: "公开可核验的一手事实",
			adaptation: "补充客户授权和验收字段",
			prerequisite: "先确认客户授权和网站编辑权限",
			basis: "owned",
			evidenceIds: ["evidence"],
		},
	],
	acceptance: ["核对发布地址与授权材料，抓取快照后同条件复测"],
};

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
						deliveryType: "content",
						title: "补齐型号参数",
						action: "建立型号页",
						rationale: "缺少参数",
						evidenceIds: ["evidence"],
					},
					{
						priority: "medium",
						deliveryType: "content",
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
	await seedMetricSnapshot(database, "batch");
	return database;
}

describe("优化文章", () => {
	it("写作指导按问题、证据和发布位置选择形式，不强制采购者、长文或固定章节", () => {
		expect(ARTICLE_WRITING_GUIDANCE).toContain("不设统一字数、章节数量或段落顺序");
		expect(ARTICLE_WRITING_GUIDANCE).toContain("不默认是采购者");
		expect(ARTICLE_WRITING_GUIDANCE).toContain("targetRecommendation");
		expect(ARTICLE_WRITING_GUIDANCE).toContain("publicationPlan.contentStrategy");
		expect(ARTICLE_WRITING_GUIDANCE).not.toMatch(/1200|2500|面向采购者的中文标题/);
	});

	it("接受无小节短答及证据充分的长内容，拒绝空正文并兼容历史草稿", () => {
		const draft = {
			summary: "仅测试的内容",
			title: "事实说明",
			contentMarkdown: "这一条已核实事实足以回答问题。",
			factGaps: [],
			evidenceIds: ["evidence"],
			targetPromptIds: ["prompt"],
		};
		expect(parseDraft("optimization_article", draft).outline).toEqual([]);
		expect(parseDraft("optimization_article", { ...draft, publicationPlan }).contentMarkdown).toBe(
			draft.contentMarkdown,
		);
		const longContent = "仅用于测试的、证据支持的说明。".repeat(240);
		expect(
			parseDraft("optimization_article", { ...draft, contentMarkdown: longContent, outline: ["说明"] }).contentMarkdown,
		).toBe(longContent);
		expect(() => parseDraft("optimization_article", { ...draft, contentMarkdown: " \n " })).toThrow();
	});

	it("新内容必须解释形式与篇幅，并关联真实问题和证据，短内容同样受边界校验", async () => {
		const database = await seed();
		try {
			const sink = { value: null as Record<string, unknown> | null, evidenceIds: [] as string[] };
			const tools = await createDomainTools(database, "project", "batch", "optimization_article", sink, {
				narrativeRunId: "narrative",
				recommendationIndex: 0,
			});
			const submit = tools.find((tool) => tool.name === "submit_draft");
			if (!submit) throw new Error("缺少提交工具");
			const draft = {
				summary: "回答具体参数缺口",
				title: "型号参数说明",
				contentMarkdown: "参数需与已有官网信息核对：【待补充：对应型号的实际参数】。",
				factGaps: ["对应型号的实际参数"],
				evidenceIds: ["evidence"],
				targetPromptIds: ["prompt"],
				publicationPlan: {
					...publicationPlan,
					purpose: "在对应型号页回答参数问题",
					problem: "目标建议缺少可核验参数",
					contentStrategy: {
						format: "型号页局部短答",
						rationale: "只补齐关联参数缺口，不重复其他页面内容",
						lengthApproach: "只说明已知参数和待核实项，无独立小节",
					},
				},
			};
			const send = (value: unknown) =>
				submit.execute("call", { evidenceIds: ["evidence"], draftJson: JSON.stringify(value) } as never);
			await expect(
				send({ ...draft, publicationPlan: { ...draft.publicationPlan, contentStrategy: undefined } }),
			).rejects.toThrow("内容形式");
			await expect(send({ ...draft, targetPromptIds: [] })).rejects.toThrow("实际监测问题");
			await expect(send({ ...draft, targetPromptIds: ["not-in-batch"] })).rejects.toThrow("未知问题");
			await expect(send({ ...draft, evidenceIds: ["other-project"] })).rejects.toThrow("越权证据");
			await send(draft);
			expect(sink.value?.outline).toEqual([]);
			expect(sink.value?.publicationPlan).toEqual(draft.publicationPlan);
		} finally {
			await database.close();
		}
	});

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
					publicationPlan,
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
			await database.query(
				"UPDATE agent_runs SET metric_snapshot_id=(SELECT current_metric_id FROM semantic_parse_runs WHERE batch_id='batch' ORDER BY created_at DESC LIMIT 1) WHERE batch_id='batch'",
			);
			await database.query(`UPDATE agent_runs SET execution_actor='{"kind":"local"}' WHERE id='article-run'`);
			await approveAgentRun(database, "article-run", null, "auto_article");
			const list = await listArticles(database, "project", { page: 1, pageSize: 10, offset: 0, search: null });
			expect(list.total).toBe(1);
			const article = await getArticle(database, String(list.items[0].id));
			expect(article?.recommendation_title).toBe("发布案例库");
			expect(article?.status).toBe("draft");
			expect(article?.fact_gaps).toEqual(["客户授权证明"]);
			expect(article?.publication_plan).toEqual(publicationPlan);
			await expect(updateArticle(database, String(article?.id), { status: "published" })).rejects.toThrow(
				"实际发布地址",
			);
			// 同一建议再次批准会覆盖为新版本而不是新建。
			await database.query(
				`INSERT INTO agent_runs (id,project_id,batch_id,purpose,status,model,prompt_version,evidence_ids,draft,target_ref)
				 VALUES ('article-run-2','project','batch','optimization_article','awaiting_approval','gpt-test','test','["evidence"]'::jsonb,$1::jsonb,$2::jsonb)`,
				[
					JSON.stringify({ ...sink.value, title: "新版本标题" }),
					JSON.stringify({ narrativeRunId: "narrative", recommendationIndex: 1 }),
				],
			);
			await database.query(
				"UPDATE agent_runs SET metric_snapshot_id=(SELECT current_metric_id FROM semantic_parse_runs WHERE batch_id='batch' ORDER BY created_at DESC LIMIT 1) WHERE batch_id='batch'",
			);
			await database.query(`UPDATE agent_runs SET execution_actor='{"kind":"local"}' WHERE id='article-run-2'`);
			await approveAgentRun(database, "article-run-2", null, "auto_article");
			const again = await listArticles(database, "project", { page: 1, pageSize: 10, offset: 0, search: null });
			expect(again.total).toBe(1);
			expect(again.items[0].title).toBe("新版本标题");
			expect(again.items[0].version).toBe(2);
		} finally {
			await database.close();
		}
	});

	it("标题与正文变化都递增版本并重置草稿状态，删除保留历史", async () => {
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
			expect(article?.status).toBe("draft");
			expect(article?.version).toBe(2);
			await updateArticle(database, "article", { contentMarkdown: "新正文" });
			article = await getArticle(database, "article");
			expect(article?.version).toBe(3);
			expect(article?.content_markdown).toBe("新正文");
			await expect(updateArticle(database, "article", { contentMarkdown: " \n " })).rejects.toThrow();
			expect((await getArticle(database, "article"))?.version).toBe(3);
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
			const first = await generateArticlesForBatch(database, "batch", { actor: { kind: "local" } });
			expect(first.narrativeRunId).toBe("narrative");
			expect(first.queued.map((item) => item.recommendationIndex)).toEqual([0]);
			// 再次生成：刚排队的 run 绑定当前叙述，序号 0 已在途，不重复排队。
			const second = await generateArticlesForBatch(database, "batch", { actor: { kind: "local" } });
			expect(second.queued).toEqual([]);
		} finally {
			await database.close();
		}
	});

	it("技术问题和未分类的历史建议不排队生成文章，也不能绕过批量入口", async () => {
		const database = await seed();
		try {
			await database.query(`UPDATE agent_runs SET draft=jsonb_set(jsonb_set(draft,
				'{geoRecommendations,0,deliveryType}', '"website"'),
				'{geoRecommendations,1}', (draft->'geoRecommendations'->1)-'deliveryType') WHERE id='narrative'`);
			const result = await generateArticlesForBatch(database, "batch", { actor: { kind: "local" } });
			expect(result.queued).toEqual([]);
			expect(result.skipped).toHaveLength(2);
			expect(result.skipped[1].reason).toContain("历史建议");
			await expect(
				createDomainTools(
					database,
					"project",
					"batch",
					"optimization_article",
					{ value: null, evidenceIds: [] },
					{ narrativeRunId: "narrative", recommendationIndex: 0 },
				),
			).rejects.toThrow("内容优化");
		} finally {
			await database.close();
		}
	});

	it("登记发布需要真实地址、完整计划、事实补齐；不能借编辑计划注入其他证据", async () => {
		const database = await seed();
		try {
			await database.query(`INSERT INTO optimization_articles
				(id,project_id,batch_id,narrative_run_id,recommendation_index,recommendation_title,title,content_markdown,evidence_ids)
				VALUES ('article','project','batch','narrative',0,'建议','仅测试文章','【待补充：授权】','["evidence"]')`);
			await expect(
				updateArticle(database, "article", { publicationPlan: { ...publicationPlan, channels: [] } }),
			).rejects.toThrow();
			await expect(
				updateArticle(database, "article", {
					publicationPlan: {
						...publicationPlan,
						channels: [{ ...publicationPlan.channels[0], basis: "observed_source", evidenceIds: [] }],
					},
				}),
			).rejects.toThrow("来源证据");
			await expect(
				updateArticle(database, "article", {
					publicationPlan: {
						...publicationPlan,
						channels: [{ ...publicationPlan.channels[0], evidenceIds: ["foreign"] }],
					},
				}),
			).rejects.toThrow("已绑定的证据");
			await expect(
				updateArticle(database, "article", {
					status: "published",
					publishedUrl: "https://brand.example/a",
					publicationPlan,
				}),
			).rejects.toThrow("待补充事实");
			expect((await getArticle(database, "article"))?.version).toBe(1);
			await expect(
				updateArticle(database, "article", {
					status: "published",
					publishedUrl: "https://brand.example/a",
					publicationPlan,
					contentMarkdown: "仅测试的已核对正文",
				}),
			).rejects.toThrow("先保存文章新版本");
			expect((await getArticle(database, "article"))?.status).toBe("draft");
		} finally {
			await database.close();
		}
	});
});
