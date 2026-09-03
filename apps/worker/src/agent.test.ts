import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { approveAgentRun, createDomainTools } from "./agent";

describe("HRouter Agent 领域工具边界", () => {
	it("拒绝未知证据并只创建待审批草稿", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,status)
				 VALUES ('project','客户','https://brand.example','brand.example','成都','zh-CN','active')`,
			);
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
				 VALUES ('prompt','project','成都有哪些服务商？','购买','[]'::jsonb,true,0)`,
			);
			await database.query(
				`INSERT INTO website_snapshots
				 (id,project_id,url,domain,content_text,structured_data,content_hash,fetched_at)
				 VALUES ('evidence','project','https://brand.example','brand.example','真实官网内容','[]'::jsonb,$1,now())`,
				["a".repeat(64)],
			);
			const sink = { value: null as Record<string, unknown> | null, evidenceIds: [] as string[] };
			const tools = await createDomainTools(database, "project", null, "diagnosis", sink);
			const readEvidence = tools.find((tool) => tool.name === "read_evidence");
			await expect(readEvidence?.execute("call", { evidenceIds: ["other-project-evidence"] } as never)).rejects.toThrow(
				"未知或越权证据",
			);
			const submit = tools.find((tool) => tool.name === "submit_draft");
			await submit?.execute("call", {
				evidenceIds: ["evidence"],
				draftJson: JSON.stringify({
					summary: "基于官网证据的待审批判断",
					findings: [
						{
							category: "内容",
							title: "事实覆盖不足",
							detail: "现有证据仅覆盖基础介绍",
							confidence: 0.8,
							evidenceIds: ["evidence"],
							targetPromptIds: ["prompt"],
							recommendation: "补充可核验事实",
						},
					],
				}),
			} as never);
			expect(sink.value).not.toBeNull();
			expect(sink.evidenceIds).toEqual(["evidence"]);
		} finally {
			await database.close();
		}
	});

	it("问题研究草稿批准后只落为未确认候选，并按问题文本去重", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,status)
				 VALUES ('project','客户','https://brand.example','brand.example','成都','zh-CN','review')`,
			);
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
				 VALUES ('existing','project','已有候选？','购买','[]'::jsonb,false,0)`,
			);
			await database.query(
				`INSERT INTO website_snapshots (id,project_id,url,domain,content_text,structured_data,content_hash,fetched_at)
				 VALUES ('snapshot','project','https://brand.example','brand.example','官网','[]'::jsonb,$1,now())`,
				["d".repeat(64)],
			);
			await database.query(
				`INSERT INTO agent_runs (id,project_id,purpose,status,model,prompt_version,evidence_ids,draft)
				 VALUES ('run','project','prompt_research','awaiting_approval','gpt-test','test','["snapshot"]'::jsonb,$1::jsonb)`,
				[
					JSON.stringify({
						summary: "研究摘要",
						prompts: [
							{ question: "已有候选？", intent: "购买", tags: [], evidenceIds: ["snapshot"] },
							{
								question: "成都工业除尘设备哪家售后快？",
								intent: "售后",
								topic: "售后",
								persona: "采购经理",
								tags: ["本地"],
								evidenceIds: ["snapshot"],
							},
						],
					}),
				],
			);
			// 手动审批与协调器自动审批可能同时到达：状态守卫保证只有一次进入物化，其余以明确错误失败。
			const outcomes = await Promise.allSettled([
				approveAgentRun(database, "run", null),
				approveAgentRun(database, "run", null, "workbench"),
			]);
			expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
			const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
			expect(String(rejected.reason)).toContain("已被其他操作处理");
			await expect(approveAgentRun(database, "run", null)).rejects.toThrow("已处理");
			expect((await database.query("SELECT id FROM audit_logs WHERE action='agent.approve'")).rows).toHaveLength(1);
			const prompts = (
				await database.query<{ question: string; approved: boolean; position: number; persona: string | null }>(
					"SELECT question,approved,position,persona FROM prompts WHERE project_id='project' ORDER BY position",
				)
			).rows;
			expect(prompts).toEqual([
				{ question: "已有候选？", approved: false, position: 0, persona: null },
				{ question: "成都工业除尘设备哪家售后快？", approved: false, position: 1, persona: "采购经理" },
			]);
			const project = (await database.query<{ status: string }>("SELECT status FROM projects WHERE id='project'"))
				.rows[0];
			expect(project.status).toBe("review");
		} finally {
			await database.close();
		}
	});

	it("内容 Agent 只能更新目标任务且必须经过批准", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,status) VALUES ('project','客户','https://brand.example','brand.example','成都','zh-CN','active')`,
			);
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position) VALUES ('prompt','project','如何选择？','购买','[]'::jsonb,true,0)`,
			);
			await database.query(
				`INSERT INTO website_snapshots (id,project_id,url,domain,content_text,structured_data,content_hash,fetched_at) VALUES ('evidence','project','https://brand.example','brand.example','真实官网内容','[]'::jsonb,$1,now())`,
				["b".repeat(64)],
			);
			await database.query(
				`INSERT INTO remediation_tasks (id,project_id,title,detail,priority,status,target_prompt_ids,evidence_ids,expected_metric,acceptance_criteria) VALUES ('task','project','补充事实','基于证据补充内容','high','todo','["prompt"]'::jsonb,'["evidence"]'::jsonb,'引用率','发布页包含可核验来源')`,
			);
			const sink = { value: null as Record<string, unknown> | null, evidenceIds: [] as string[] };
			const tools = await createDomainTools(database, "project", null, "content_brief", sink, "task");
			const submit = tools.find((tool) => tool.name === "submit_draft");
			await expect(
				submit?.execute("call", {
					evidenceIds: ["evidence"],
					draftJson: JSON.stringify({
						taskId: "other",
						summary: "摘要",
						title: "标题",
						outline: ["结构"],
						evidenceIds: ["evidence"],
						factGaps: [],
						draftContent: "正文",
					}),
				} as never),
			).rejects.toThrow("错误的整改任务");
			await submit?.execute("call", {
				evidenceIds: ["evidence"],
				draftJson: JSON.stringify({
					taskId: "task",
					summary: "摘要",
					title: "标题",
					outline: ["结构"],
					evidenceIds: ["evidence"],
					factGaps: ["价格来源"],
					draftContent: "只包含真实证据边界的正文",
				}),
			} as never);
			await database.query(
				`INSERT INTO agent_runs (id,project_id,purpose,status,model,prompt_version,evidence_ids,draft) VALUES ('run','project','content_brief','awaiting_approval','gpt-test','test','["evidence"]'::jsonb,$1::jsonb)`,
				[JSON.stringify(sink.value)],
			);
			await approveAgentRun(database, "run");
			const task = (
				await database.query<{ content_brief: string; draft_content: string }>(
					"SELECT content_brief,draft_content FROM remediation_tasks WHERE id='task'",
				)
			).rows[0];
			expect(task.content_brief).toContain("价格来源");
			expect(task.draft_content).toContain("真实证据");
		} finally {
			await database.close();
		}
	});

	it("报告口碑只接受回答证据中的真实信息源", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query(
				`INSERT INTO projects (id,name,website_url,domain,region,language,status)
				 VALUES ('project','客户','https://brand.example','brand.example','中国','zh-CN','active')`,
			);
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
				 VALUES ('prompt','project','客户口碑怎么样？','口碑','[]'::jsonb,true,0)`,
			);
			await database.query(
				`INSERT INTO experiment_batches (id,project_id,kind,status,config,config_hash)
				 VALUES ('batch','project','quick_audit','complete','{}'::jsonb,'hash')`,
			);
			await database.query("INSERT INTO jobs (id,type,payload,status) VALUES ('job','capture','{}'::jsonb,'complete')");
			await database.query(
				`INSERT INTO query_captures
				 (id,job_id,batch_id,project_id,prompt_id,platform,attempt,status,answer_text,brand_matches,sources,
				 query_fan_out,adapter_version,captured_at)
				 VALUES ('capture','job','batch','project','prompt','qwen_api',1,'complete','有用户提到售后较慢','[]'::jsonb,
				 '[{"url":"https://review.example/1","domain":"review.example","title":"用户评价","position":1,"isCitation":true}]'::jsonb,
				 '[]'::jsonb,'test',now())`,
			);
			const sink = { value: null as Record<string, unknown> | null, evidenceIds: [] as string[] };
			const tools = await createDomainTools(database, "project", "batch", "report_narrative", sink);
			const submit = tools.find((tool) => tool.name === "submit_draft");
			const draft = (sourceUrls: string[]) => ({
				summary: "报告摘要",
				executiveSummary: "管理摘要",
				reputation: {
					overall: "negative",
					summary: "出现售后负面评价",
					positiveSignals: [],
					negativeSignals: [
						{
							statement: "售后较慢",
							sourceStatus: "cited",
							sourceUrls,
							evidenceIds: ["capture"],
						},
					],
				},
				geoRecommendations: [
					{
						priority: "high",
						title: "澄清售后标准",
						action: "发布可核验的响应时效。",
						rationale: "回应当前负面评价。",
						evidenceIds: ["capture"],
					},
				],
				limitations: [],
				evidenceIds: ["capture"],
			});
			await expect(
				submit?.execute("call", {
					evidenceIds: ["capture"],
					draftJson: JSON.stringify(draft(["https://invented.example/negative"])),
				} as never),
			).rejects.toThrow("不属于对应回答证据");
			await submit?.execute("call", {
				evidenceIds: ["capture"],
				draftJson: JSON.stringify(draft(["https://review.example/1"])),
			} as never);
			expect(sink.value).toMatchObject({ reputation: { overall: "negative" } });
		} finally {
			await database.close();
		}
	});
});
