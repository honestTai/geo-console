import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it, vi } from "vitest";
import { runOneAgentJob } from "./agent-jobs";
import { answerQuestion, cancelSession, listSessionEvents, resumeWaitingSessions, sendMessage } from "./workbench";

async function seedSession(status = "idle", waiting: unknown = null, autoApprove = true, plan: unknown[] = []) {
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await database.query(
		`INSERT INTO projects (id,name,website_url,domain,region,language,status)
		 VALUES ('project','客户','https://brand.example','brand.example','成都','zh-CN','active')`,
	);
	await database.query(
		`INSERT INTO users (id,organization_id,email,display_name,password_hash,role) VALUES ('user','default','a@b.c','成员','x','admin')`,
	);
	await database.query(
		`INSERT INTO agent_sessions (id,organization_id,project_id,title,status,auto_approve,waiting,plan,created_by)
		 VALUES ('session','default','project','跑基线',$1,$2,$3::jsonb,$4::jsonb,'user')`,
		[status, autoApprove, waiting ? JSON.stringify(waiting) : null, JSON.stringify(plan)],
	);
	return database;
}

async function readPlan(database: Awaited<ReturnType<typeof seedSession>>) {
	const row = (
		await database.query<{ plan: Array<{ key: string; label: string; status: string; detail: string | null }> }>(
			"SELECT plan FROM agent_sessions WHERE id='session'",
		)
	).rows[0];
	return row.plan;
}

describe("AI 工作台会话", () => {
	it("用户消息入队为会话回合并写入事件流", async () => {
		const database = await seedSession();
		try {
			await sendMessage(database, "session", { message: "跑一次正式基线" });
			const job = (
				await database.query<{ type: string; payload: unknown }>(
					"SELECT type,payload FROM jobs WHERE type='agent_session_turn'",
				)
			).rows[0];
			expect(job).toBeDefined();
			const events = await listSessionEvents(database, "session", 0);
			expect(events.items.map((event) => event.type)).toEqual(["user_message"]);
			await expect(sendMessage(database, "session", { message: "再来一次" })).rejects.toThrow("正在执行");
		} finally {
			await database.close();
		}
	});

	it("只有等待用户回答时才能提交回答，并以工具结果续跑", async () => {
		const database = await seedSession("waiting_user", {
			kind: "user",
			question: "沿用现有问题？",
			options: ["沿用", "追加"],
			multiple: false,
			toolCallId: "call-1",
		});
		try {
			await answerQuestion(database, "session", { selected: ["沿用"] });
			const session = (await database.query<{ status: string }>("SELECT status FROM agent_sessions WHERE id='session'"))
				.rows[0];
			expect(session.status).toBe("running");
			const job = (
				await database.query<{ payload: { trigger: string; message: string } }>(
					"SELECT payload FROM jobs WHERE type='agent_session_turn'",
				)
			).rows[0];
			expect(job.payload.trigger).toBe("answer");
			expect(job.payload.message).toContain("沿用");
			await expect(answerQuestion(database, "session", { answer: "再答一次" })).rejects.toThrow("没有待回答");
		} finally {
			await database.close();
		}
	});

	it("会话回合任务由 Agent 队列按类型分发", async () => {
		const database = await seedSession("running");
		try {
			await database.query(
				`INSERT INTO jobs (id,type,payload,status,max_attempts,available_at)
				 VALUES ('job','agent_session_turn','{"sessionId":"session","trigger":"user","message":"跑基线"}'::jsonb,'pending',2,now())`,
			);
			const draft = vi.fn(async () => undefined);
			const sessionTurn = vi.fn(async () => undefined);
			expect(await runOneAgentJob(database, "worker", { draft, sessionTurn })).toBe(true);
			expect(draft).not.toHaveBeenCalled();
			expect(sessionTurn).toHaveBeenCalledWith(database, "session", "user", "跑基线");
			const job = (await database.query<{ status: string }>("SELECT status FROM jobs WHERE id='job'")).rows[0];
			expect(job.status).toBe("complete");
		} finally {
			await database.close();
		}
	});

	it("回合最终失败时会话进入可见失败态", async () => {
		const database = await seedSession("running");
		try {
			await database.query(
				`INSERT INTO jobs (id,type,payload,status,max_attempts,available_at)
				 VALUES ('job','agent_session_turn','{"sessionId":"session","trigger":"user","message":"跑基线"}'::jsonb,'pending',1,now())`,
			);
			await runOneAgentJob(database, "worker", {
				sessionTurn: async () => {
					throw new Error("模型不可用");
				},
			});
			const session = (
				await database.query<{ status: string; error_message: string }>(
					"SELECT status,error_message FROM agent_sessions WHERE id='session'",
				)
			).rows[0];
			expect(session.status).toBe("failed");
			expect(session.error_message).toContain("模型不可用");
		} finally {
			await database.close();
		}
	});

	it("批次完成后唤醒等待中的会话，并把采集步骤标记为完成", async () => {
		const database = await seedSession(
			"waiting_job",
			{ kind: "batch", id: "batch", label: "等待正式基线采集完成", toolCallId: "call-2", stepKey: "batch" },
			true,
			[{ key: "batch", label: "正式基线采集", status: "running", ref: "batch", detail: "3 个采集任务" }],
		);
		try {
			await database.query(
				`INSERT INTO experiment_batches (id,project_id,kind,status,config,config_hash)
				 VALUES ('batch','project','baseline','running','{"project":{"name":"客户","domain":"brand.example","region":"成都","language":"zh-CN","aliases":["客户"]},"competitors":[],"prompts":[],"platforms":["deepseek_api"],"repeats":1}'::jsonb,'hash')`,
			);
			expect(await resumeWaitingSessions(database)).toBe(0);
			expect((await readPlan(database))[0].status).toBe("running");
			await database.query("UPDATE experiment_batches SET status='partial' WHERE id='batch'");
			expect(await resumeWaitingSessions(database)).toBe(1);
			const job = (
				await database.query<{ payload: { trigger: string; message: string } }>(
					"SELECT payload FROM jobs WHERE type='agent_session_turn'",
				)
			).rows[0];
			expect(job.payload.trigger).toBe("resume");
			expect(job.payload.message).toContain("partial");
			const events = await listSessionEvents(database, "session", 0);
			expect(events.items.some((event) => event.type === "resumed")).toBe(true);
			expect(events.items.some((event) => event.type === "step")).toBe(true);
			const [step] = await readPlan(database);
			expect(step).toMatchObject({ key: "batch", label: "正式基线采集", status: "done" });
			expect(step.detail).toBe("3 个采集任务 · 部分平台失败，原始证据已保留");
		} finally {
			await database.close();
		}
	});

	it("报告工作流的等待不改 report 步骤，旧会话缺少 stepKey 时按 run 推导", async () => {
		const database = await seedSession(
			"waiting_job",
			{ kind: "agent_run", id: "run", label: "等待报告叙述完成", toolCallId: "call-2b", stepKey: "report" },
			true,
			[
				{ key: "report", label: "报告叙述与质检", status: "running", detail: "叙述生成中" },
				{ key: "run:draft", label: "模型诊断", status: "running" },
			],
		);
		try {
			await database.query(
				`INSERT INTO agent_runs (id,project_id,purpose,status,model,prompt_version,session_id)
				 VALUES ('run','project','report_narrative','approved','gpt-test','test','session'),
				        ('draft','project','diagnosis','failed','gpt-test','test','session')`,
			);
			expect(await resumeWaitingSessions(database)).toBe(1);
			expect((await readPlan(database))[0]).toMatchObject({ key: "report", status: "running", detail: "叙述生成中" });
			await database.query(`UPDATE agent_sessions SET status='waiting_job',waiting=$1::jsonb WHERE id='session'`, [
				JSON.stringify({ kind: "agent_run", id: "draft", label: "模型诊断", toolCallId: "call-2c" }),
			]);
			await database.query("UPDATE agent_runs SET error_message='模型超时' WHERE id='draft'");
			expect(await resumeWaitingSessions(database)).toBe(1);
			expect((await readPlan(database))[1]).toMatchObject({ key: "run:draft", status: "failed", detail: "模型超时" });
		} finally {
			await database.close();
		}
	});

	it("文章草稿全部落地后收尾会话的优化文章步骤", async () => {
		const database = await seedSession("done", null, true, [
			{ key: "articles", label: "优化文章", status: "running", ref: "batch", detail: "2 篇排队" },
		]);
		try {
			await database.query(
				`INSERT INTO agent_runs (id,project_id,purpose,status,model,prompt_version,session_id)
				 VALUES ('a1','project','optimization_article','approved','gpt-test','test','session'),
				        ('a2','project','optimization_article','queued','gpt-test','test','session')`,
			);
			await resumeWaitingSessions(database);
			expect((await readPlan(database))[0].status).toBe("running");
			await database.query("UPDATE agent_runs SET status='failed' WHERE id='a2'");
			await resumeWaitingSessions(database);
			expect((await readPlan(database))[0]).toMatchObject({ status: "done", detail: "1 篇已生成，1 篇失败" });
			const events = await listSessionEvents(database, "session", 0);
			expect(events.items.filter((event) => event.type === "step")).toHaveLength(1);
		} finally {
			await database.close();
		}
	});

	it("自动模式下工作台草稿自动批准并写审计", async () => {
		const database = await seedSession("waiting_job", {
			kind: "agent_run",
			id: "run",
			label: "模型诊断",
			toolCallId: "call-3",
		});
		try {
			await database.query(
				`INSERT INTO experiment_batches (id,project_id,kind,status,config,config_hash)
				 VALUES ('batch','project','quick_audit','complete','{}'::jsonb,'hash')`,
			);
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
				 VALUES ('prompt','project','问题','购买','[]'::jsonb,true,0)`,
			);
			await database.query(
				`INSERT INTO website_snapshots (id,project_id,url,domain,content_text,structured_data,content_hash,fetched_at)
				 VALUES ('evidence','project','https://brand.example','brand.example','官网','[]'::jsonb,$1,now())`,
				["c".repeat(64)],
			);
			await database.query(
				`INSERT INTO agent_runs (id,project_id,batch_id,purpose,status,model,prompt_version,session_id,evidence_ids,draft)
				 VALUES ('run','project','batch','diagnosis','awaiting_approval','gpt-test','test','session','["evidence"]'::jsonb,$1::jsonb)`,
				[
					JSON.stringify({
						summary: "诊断摘要",
						findings: [
							{
								category: "内容",
								title: "缺少型号页",
								detail: "详情",
								confidence: 0.9,
								evidenceIds: ["evidence"],
								targetPromptIds: ["prompt"],
								recommendation: "补充型号页",
							},
						],
					}),
				],
			);
			await resumeWaitingSessions(database);
			const run = (
				await database.query<{ status: string; approved_via: string; approved_by: string }>(
					"SELECT status,approved_via,approved_by FROM agent_runs WHERE id='run'",
				)
			).rows[0];
			expect(run.status).toBe("approved");
			expect(run.approved_via).toBe("workbench");
			expect(run.approved_by).toBe("user");
			const audit = (
				await database.query<{ metadata: { via: string; sessionId: string } }>(
					"SELECT metadata FROM audit_logs WHERE action='agent.approve'",
				)
			).rows[0];
			expect(audit.metadata.via).toBe("workbench");
			expect(audit.metadata.sessionId).toBe("session");
			const findings = await database.query("SELECT id FROM diagnosis_findings WHERE batch_id='batch'");
			expect(findings.rows).toHaveLength(1);
			const resumeJob = await database.query("SELECT id FROM jobs WHERE type='agent_session_turn'");
			expect(resumeJob.rows).toHaveLength(1);
		} finally {
			await database.close();
		}
	});

	it("关闭自动模式时把审批交还用户", async () => {
		const database = await seedSession(
			"waiting_job",
			{ kind: "agent_run", id: "run", label: "报告叙述", toolCallId: "call-4" },
			false,
		);
		try {
			await database.query(
				`INSERT INTO agent_runs (id,project_id,purpose,status,model,prompt_version,session_id)
				 VALUES ('run','project','report_narrative','awaiting_approval','gpt-test','test','session')`,
			);
			await resumeWaitingSessions(database);
			const session = (
				await database.query<{ status: string; waiting: { kind: string } }>(
					"SELECT status,waiting FROM agent_sessions WHERE id='session'",
				)
			).rows[0];
			expect(session.status).toBe("waiting_user");
			expect(session.waiting.kind).toBe("user");
			const run = (await database.query<{ status: string }>("SELECT status FROM agent_runs WHERE id='run'")).rows[0];
			expect(run.status).toBe("awaiting_approval");
		} finally {
			await database.close();
		}
	});

	it("终止会话后不再接受消息", async () => {
		const database = await seedSession("waiting_user", {
			kind: "user",
			question: "?",
			options: [],
			multiple: false,
			toolCallId: "call-5",
		});
		try {
			await cancelSession(database, "session");
			const session = (
				await database.query<{ status: string; waiting: unknown }>(
					"SELECT status,waiting FROM agent_sessions WHERE id='session'",
				)
			).rows[0];
			expect(session.status).toBe("failed");
			expect(session.waiting).toBeNull();
			await expect(cancelSession(database, "session")).rejects.toThrow("已结束");
		} finally {
			await database.close();
		}
	});
});
