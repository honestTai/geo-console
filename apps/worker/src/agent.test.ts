import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { approveAgentRun, createDomainTools } from "./agent";

describe("Pi Agent 领域工具边界", () => {
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
});
