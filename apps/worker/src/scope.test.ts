import { type FrozenBatchConfig, migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { frozenProviderContract } from "./cloud-runner";
import { ensureProviderConfigs } from "./providers";
import { confirmProject, createBatch, getProject, getProjectTrends } from "./service";
import { seedMeasurementModel, seedMetricSnapshot } from "./test-support/measurement";
import { sha256, stableJson } from "./utils";

describe("监测范围版本", () => {
	it("保留旧批次范围并允许同一竞品在新版本继续使用", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await seedMeasurementModel(database);
			await ensureProviderConfigs(database);
			await database.query("UPDATE provider_configs SET enabled=true WHERE provider_id='kimi_api'");
			// Existing installations retain provider rows across upgrades; their stale metadata must not freeze old executable code.
			await database.query(
				"UPDATE provider_configs SET adapter_version='cloud-search.v1' WHERE provider_id='kimi_api'",
			);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,aliases,status)
				 VALUES ('project','客户','https://brand.cn','brand.cn','成都','zh-CN','["客户"]'::jsonb,'active')`,
			);
			await database.query(
				`INSERT INTO competitors (id,project_id,name,domain,aliases,approved)
				 VALUES ('competitor-v1','project','竞品','competitor.cn','["竞品"]'::jsonb,true)`,
			);
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
				 VALUES ('prompt-v1','project','旧问题是什么？','购买','[]'::jsonb,true,0)`,
			);

			const batch = await createBatch(database, "project", {
				kind: "baseline",
				platforms: ["kimi_api"],
				repeats: 1,
			});
			await database.query(
				"UPDATE provider_configs SET model='changed-after-freeze',endpoint='https://changed.invalid' WHERE provider_id='kimi_api'",
			);
			await confirmProject(database, "project", {
				aliases: ["客户", "客户品牌"],
				competitors: [{ name: "竞品", domain: "competitor.cn", aliases: ["竞品品牌"] }],
				prompts: [{ question: "新问题是什么？", intent: "比较", tags: ["高意向"] }],
			});
			// 同一域名再次确认沿用同一行（不再重插撞唯一索引），只有问题文本变化的问题才拿新 ID。
			const again = await confirmProject(database, "project", {
				aliases: ["客户", "客户品牌"],
				competitors: [{ name: "竞品", domain: "competitor.cn", aliases: ["竞品品牌"] }],
				prompts: [{ question: "最终问题是什么？", intent: "比较", tags: ["高意向"] }],
			});
			expect(again).toMatchObject({ competitorsKept: 1, promptsKept: 0 });

			const savedBatch = (
				await database.query<{ config: FrozenBatchConfig }>("SELECT config FROM experiment_batches WHERE id=$1", [
					batch.id,
				])
			).rows[0];
			expect(savedBatch.config.prompts).toEqual([
				{ id: "prompt-v1", question: "旧问题是什么？", intent: "购买", topic: null, persona: null, tags: [] },
			]);
			expect(frozenProviderContract(savedBatch.config, "kimi_api")).toMatchObject({
				endpoint: "https://api.moonshot.ai/v1",
				model: "kimi-k3",
				adapterVersion: "cloud-search.v2",
			});

			const current = await getProject(database, "project");
			expect(current).not.toBeNull();
			const currentPrompts = current?.prompts as Array<{ question: string }>;
			expect(currentPrompts).toHaveLength(1);
			expect(currentPrompts[0].question).toBe("最终问题是什么？");
			expect(current?.competitors).toHaveLength(1);

			const versions = await database.query<{ id: string; active: number; total: number }>(
				`SELECT min(id) AS id, count(*) FILTER (WHERE archived_at IS NULL)::int AS active, count(*)::int AS total
				 FROM competitors WHERE project_id='project' AND domain='competitor.cn'`,
			);
			expect(versions.rows[0]).toMatchObject({ id: "competitor-v1", active: 1, total: 1 });
			const promptVersions = await database.query<{ active: number; total: number }>(
				`SELECT count(*) FILTER (WHERE archived_at IS NULL)::int AS active, count(*)::int AS total
				 FROM prompts WHERE project_id='project'`,
			);
			expect(promptVersions.rows[0]).toMatchObject({ active: 1, total: 3 });
		} finally {
			await database.close();
		}
	});

	it("零修改保存沿用问题与竞品 ID，新基线与历史批次保持可比；范围真正变化时才换 ID", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await seedMeasurementModel(database);
			await ensureProviderConfigs(database);
			await database.query("UPDATE provider_configs SET enabled=true WHERE provider_id='kimi_api'");
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,aliases,status)
				 VALUES ('project','客户','https://brand.cn','brand.cn','成都','zh-CN','["客户"]'::jsonb,'active')`,
			);
			await database.query(
				`INSERT INTO competitors (id,project_id,name,domain,aliases,approved)
				 VALUES ('competitor-v1','project','竞品','competitor.cn','["竞品"]'::jsonb,true)`,
			);
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
				 VALUES ('prompt-a','project','问题 A 是什么？','购买','[]'::jsonb,true,0),
				        ('prompt-b','project','问题 B 是什么？','购买','[]'::jsonb,true,1)`,
			);
			const first = await createBatch(database, "project", { kind: "baseline", platforms: ["kimi_api"], repeats: 1 });
			const scope = (await getProject(database, "project")) as {
				aliases: string[];
				competitors: Array<Record<string, unknown>>;
				prompts: Array<Record<string, unknown>>;
			};
			// 建档页/范围编辑器把 getProject 的行原样交回：带 id，且（大小写/空白外）文本没变。
			const unchanged = await confirmProject(database, "project", {
				aliases: scope.aliases,
				competitors: scope.competitors,
				prompts: scope.prompts.map((prompt) => ({ ...prompt, question: `${prompt.question} ` })),
			});
			expect(unchanged).toMatchObject({ promptsKept: 2, competitorsKept: 1, promptCount: 2 });
			const second = await createBatch(database, "project", { kind: "baseline", platforms: ["kimi_api"], repeats: 1 });
			await database.query(
				"UPDATE experiment_batches SET status='complete',completed_at=now() WHERE project_id='project'",
			);
			await seedMetricSnapshot(database, first.id);
			await seedMetricSnapshot(database, second.id);
			const trends = (await getProjectTrends(database, "project", second.id)) as { comparable: Array<{ id: string }> };
			expect(trends.comparable.map((item) => item.id)).toEqual([first.id, second.id]);
			expect((await database.query("SELECT id FROM prompts WHERE project_id='project'")).rows).toHaveLength(2);

			// 工作台候选确认不带 id：按文本匹配同样沿用；新增问题拿新 ID，去掉的问题归档。
			const proposal = await confirmProject(database, "project", {
				aliases: ["客户"],
				competitors: [{ name: "竞品改名", domain: "competitor.cn", aliases: ["竞品", "对手"] }],
				prompts: [
					{ question: "问题 A 是什么？", intent: "对比", tags: ["新标签"] },
					{ question: "新增的问题 C？", intent: "购买", tags: [] },
				],
			});
			expect(proposal).toMatchObject({ promptsKept: 1, competitorsKept: 1, promptCount: 2 });
			const rows = (
				await database.query<{ id: string; question: string; intent: string; archived: boolean }>(
					"SELECT id,question,intent,(archived_at IS NOT NULL) AS archived FROM prompts WHERE project_id='project' ORDER BY position,created_at",
				)
			).rows;
			expect(rows.find((row) => row.id === "prompt-a")).toMatchObject({ intent: "对比", archived: false });
			expect(rows.find((row) => row.id === "prompt-b")).toMatchObject({ archived: true });
			expect(rows.filter((row) => !row.archived).map((row) => row.question)).toEqual([
				"问题 A 是什么？",
				"新增的问题 C？",
			]);
			const competitor = (
				await database.query<{ name: string; aliases: string[] }>(
					"SELECT name,aliases FROM competitors WHERE id='competitor-v1' AND archived_at IS NULL",
				)
			).rows[0];
			expect(competitor).toMatchObject({ name: "竞品改名", aliases: ["竞品", "对手"] });
			const third = await createBatch(database, "project", { kind: "baseline", platforms: ["kimi_api"], repeats: 1 });
			await database.query("UPDATE experiment_batches SET status='complete',completed_at=now() WHERE id=$1", [
				third.id,
			]);
			await seedMetricSnapshot(database, third.id);
			const changed = (await getProjectTrends(database, "project", third.id)) as { comparable: Array<{ id: string }> };
			expect(changed.comparable.map((item) => item.id)).toEqual([third.id]);
		} finally {
			await database.close();
		}
	});

	it("拒绝无效、与客户相同或重复的竞品域名以及重复问题，并给出中文原因", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await seedMeasurementModel(database);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,aliases,status)
				 VALUES ('project','客户','https://www.brand.cn','brand.cn','成都','zh-CN','["客户"]'::jsonb,'review')`,
			);
			const prompts = [{ question: "问题是什么？", intent: "购买", tags: [] }];
			await expect(
				confirmProject(database, "project", {
					aliases: ["客户"],
					competitors: [{ name: "自己", domain: "https://WWW.brand.cn/about", aliases: [] }],
					prompts,
				}),
			).rejects.toThrow("与客户官网相同");
			await expect(
				confirmProject(database, "project", {
					aliases: ["客户"],
					competitors: [
						{ name: "甲", domain: "rival.cn", aliases: [] },
						{ name: "乙", domain: "www.rival.cn", aliases: [] },
					],
					prompts,
				}),
			).rejects.toThrow("竞品域名重复：rival.cn");
			await expect(
				confirmProject(database, "project", {
					aliases: ["客户"],
					competitors: [{ name: "坏域名", domain: "不是域名", aliases: [] }],
					prompts,
				}),
			).rejects.toThrow("域名无效");
			await expect(
				confirmProject(database, "project", {
					aliases: ["客户"],
					competitors: [],
					prompts: [...prompts, { question: " 问题是什么？", intent: "对比", tags: [] }],
				}),
			).rejects.toThrow("监测问题重复");
			expect((await database.query("SELECT id FROM competitors WHERE project_id='project'")).rows).toHaveLength(0);
			expect((await database.query("SELECT status FROM projects WHERE id='project'")).rows[0]).toMatchObject({
				status: "review",
			});
		} finally {
			await database.close();
		}
	});

	it("跨机构或已归档的知识库引用在确认时被去掉并计数，而不是拒绝整次确认", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await seedMeasurementModel(database);
			await database.query("INSERT INTO organizations (id,name) VALUES ('other','别的机构')");
			await database.query(
				`INSERT INTO projects (id,organization_id,name,website_url,domain,region,language,industry,aliases,status)
				 VALUES ('project','default','客户','https://brand.cn','brand.cn','成都','zh-CN','数控设备','["客户"]'::jsonb,'review')`,
			);
			await database.query(
				`INSERT INTO prompt_library_questions (id,organization_id,industry,question,intent,tags,archived_at)
				 VALUES ('mine','default','数控设备','本机构问题？','购买','[]'::jsonb,NULL),
				        ('foreign','other','数控设备','别家问题？','购买','[]'::jsonb,NULL),
				        ('archived','default','数控设备','归档问题？','购买','[]'::jsonb,now())`,
			);
			const result = await confirmProject(database, "project", {
				aliases: ["客户"],
				competitors: [],
				prompts: [
					{ libraryQuestionId: "mine", question: "本机构问题？", intent: "购买", tags: [] },
					{ libraryQuestionId: "foreign", question: "别家问题？", intent: "购买", tags: [] },
					{ library_question_id: "archived", question: "归档问题？", intent: "购买", tags: [] },
				],
			});
			expect(result).toMatchObject({ promptCount: 3, libraryUnlinked: 2 });
			const refs = (
				await database.query<{ question: string; library_question_id: string | null }>(
					"SELECT question,library_question_id FROM prompts WHERE project_id='project' ORDER BY position",
				)
			).rows;
			expect(refs).toEqual([
				{ question: "本机构问题？", library_question_id: "mine" },
				{ question: "别家问题？", library_question_id: null },
				{ question: "归档问题？", library_question_id: null },
			]);
		} finally {
			await database.close();
		}
	});

	it("确认范围时可把新问题回流到客户行业知识库并回填引用；没有行业的客户不写", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await seedMeasurementModel(database);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,industry,aliases,status)
				 VALUES ('project','客户','https://brand.cn','brand.cn','成都','zh-CN','数控设备','["客户"]'::jsonb,'review'),
				        ('plain','无行业客户','https://plain.cn','plain.cn','成都','zh-CN',NULL,'["无行业客户"]'::jsonb,'review')`,
			);
			await database.query(
				`INSERT INTO prompt_library_questions (id,organization_id,industry,question,intent,tags)
				 VALUES ('lib','default','数控设备','数控机床怎么选？','购买','[]'::jsonb)`,
			);
			const result = await confirmProject(
				database,
				"project",
				{
					aliases: ["客户"],
					competitors: [],
					prompts: [
						{ question: "数控机床怎么选？", intent: "购买", tags: [] },
						{
							question: "成都哪家数控设备售后快？",
							intent: "售后",
							topic: "售后",
							persona: "设备主管",
							tags: ["本地"],
						},
						{ libraryQuestionId: "lib", question: "引用库里的问题", intent: "购买", tags: [] },
					],
				},
				{ syncLibrary: { organizationId: "default", createdBy: null } },
			);
			expect(result).toMatchObject({ promptCount: 3, libraryAdded: 1, libraryLinked: 1 });
			const prompts = (
				await database.query<{ question: string; library_question_id: string | null }>(
					"SELECT question,library_question_id FROM prompts WHERE project_id='project' AND archived_at IS NULL ORDER BY position",
				)
			).rows;
			expect(prompts[0].library_question_id).toBe("lib");
			expect(prompts[1].library_question_id).toBeTruthy();
			expect(prompts[2].library_question_id).toBe("lib");
			const library = await database.query<{ question: string; persona: string | null }>(
				"SELECT question,persona FROM prompt_library_questions WHERE organization_id='default' ORDER BY created_at",
			);
			expect(library.rows).toEqual([
				{ question: "数控机床怎么选？", persona: null },
				{ question: "成都哪家数控设备售后快？", persona: "设备主管" },
			]);
			await expect(
				confirmProject(
					database,
					"project",
					{ aliases: ["客户"], competitors: [], prompts: [{ question: "越权写入？", intent: "购买", tags: [] }] },
					{ syncLibrary: { organizationId: "other", createdBy: null } },
				),
			).rejects.toThrow("客户所属机构");
			const plain = await confirmProject(
				database,
				"plain",
				{
					aliases: ["无行业客户"],
					competitors: [],
					prompts: [{ question: "没有行业的问题？", intent: "购买", tags: [] }],
				},
				{ syncLibrary: { organizationId: "default", createdBy: null } },
			);
			expect(plain).toMatchObject({ libraryAdded: 0, libraryLinked: 0 });
			expect((await database.query("SELECT id FROM prompt_library_questions")).rows).toHaveLength(2);
		} finally {
			await database.close();
		}
	});

	it("同条件复测与基线在趋势中可比，且冻结配置哈希写库前后一致", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await seedMeasurementModel(database);
			await ensureProviderConfigs(database);
			await database.query("UPDATE provider_configs SET enabled=true WHERE provider_id='kimi_api'");
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,aliases,status)
				 VALUES ('project','客户','https://brand.cn','brand.cn','成都','zh-CN','["客户"]'::jsonb,'active')`,
			);
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
				 VALUES ('prompt-v1','project','旧问题是什么？','购买','[]'::jsonb,true,0)`,
			);
			const baseline = await createBatch(database, "project", {
				kind: "baseline",
				platforms: ["kimi_api"],
				repeats: 1,
			});
			const retest = await createBatch(database, "project", { kind: "retest", compareToBatchId: baseline.id });
			const rows = (
				await database.query<{ id: string; config: FrozenBatchConfig; config_hash: string }>(
					"SELECT id,config,config_hash FROM experiment_batches WHERE project_id='project'",
				)
			).rows;
			const hashes = new Set(rows.map((row) => row.config_hash));
			expect(hashes.size).toBe(1);
			for (const row of rows) expect(sha256(stableJson(row.config))).toBe(row.config_hash);
			await database.query("UPDATE experiment_batches SET status='complete' WHERE project_id='project'");
			await seedMetricSnapshot(database, baseline.id);
			await seedMetricSnapshot(database, retest.id);
			const trends = (await getProjectTrends(database, "project", retest.id)) as {
				comparable: Array<{ id: string }>;
			};
			expect(trends.comparable.map((item) => item.id)).toEqual([baseline.id, retest.id]);
		} finally {
			await database.close();
		}
	});
});
