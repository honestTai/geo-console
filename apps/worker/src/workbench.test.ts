import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AgentSessionWaiting, migrateDatabase, openMemoryDatabase, type ScopeProposal } from "@geo/core";
import { describe, expect, it, vi } from "vitest";
import { runOneAgentJob } from "./agent-jobs";
import {
	answerQuestion,
	cancelSession,
	createWorkbenchTools,
	listSessionEvents,
	orderQuickCommands,
	resumeWaitingSessions,
	sendMessage,
	type WorkbenchSession,
} from "./workbench";

async function seedSession(
	status = "idle",
	waiting: unknown = null,
	autoApprove = true,
	plan: unknown[] = [],
	projectStatus = "active",
) {
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await database.query(
		`INSERT INTO projects (id,name,website_url,domain,region,language,industry,status)
		 VALUES ('project','客户','https://brand.example','brand.example','成都','zh-CN','工业除尘',$1)`,
		[projectStatus],
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

async function loadTestSession(
	database: Awaited<ReturnType<typeof seedSession>>,
	overrides: Partial<WorkbenchSession> = {},
): Promise<WorkbenchSession> {
	const row = (await database.query<Record<string, unknown>>("SELECT * FROM agent_sessions WHERE id='session'"))
		.rows[0];
	return {
		...(row as unknown as WorkbenchSession),
		transcript: [],
		plan: (row.plan ?? []) as WorkbenchSession["plan"],
		waiting: (row.waiting ?? null) as WorkbenchSession["waiting"],
		usage: null,
		...overrides,
	};
}

function pick(tools: AgentTool[], name: string): AgentTool {
	const tool = tools.find((item) => item.name === name);
	if (!tool) throw new Error(`缺少工具 ${name}`);
	return tool;
}

/** 构造工作台工具集并收集事件；control 与真实回合一致，只是不经过模型。 */
async function toolHarness(database: Awaited<ReturnType<typeof seedSession>>, session: WorkbenchSession) {
	const control: {
		waiting: AgentSessionWaiting | null;
		finished: string | null;
		plan: WorkbenchSession["plan"];
		currentBatchId: string | null;
	} = { waiting: null, finished: null, plan: session.plan, currentBatchId: session.current_batch_id };
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const tools = await createWorkbenchTools(
		database,
		session,
		control,
		async () => {
			await database.query("UPDATE agent_sessions SET plan=$2::jsonb,waiting=$3::jsonb WHERE id=$1", [
				session.id,
				JSON.stringify(control.plan),
				control.waiting ? JSON.stringify(control.waiting) : null,
			]);
		},
		async (type, payload) => {
			events.push({ type, payload });
		},
	);
	return { tools, control, events };
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

	it("关闭联网时没有 web_search 工具，开启时按会话已用次数计入配额", async () => {
		const database = await seedSession();
		try {
			await database.query("UPDATE agent_sessions SET web_search_enabled=false WHERE id='session'");
			const disabled = await toolHarness(database, await loadTestSession(database));
			expect(disabled.tools.map((tool) => tool.name)).not.toContain("web_search");
			expect(disabled.tools.map((tool) => tool.name)).not.toContain("apply_scope");
			await database.query("UPDATE agent_sessions SET web_search_enabled=true WHERE id='session'");
			const enabled = await toolHarness(database, await loadTestSession(database));
			expect(pick(enabled.tools, "web_search").description).toContain("本会话最多 30 次");
		} finally {
			await database.close();
		}
	});

	it("propose_questions 校验证据与问题归属，写入待确认候选并结束回合", async () => {
		const database = await seedSession("running", null, true, [], "review");
		try {
			await database.query(
				`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
				 VALUES ('pending','project','建档候选问题是什么？','购买','[]'::jsonb,false,0)`,
			);
			await database.query(
				`INSERT INTO competitors (id,project_id,name,domain,aliases,approved)
				 VALUES ('rival','project','竞品','rival.example','[]'::jsonb,false)`,
			);
			await database.query(
				`INSERT INTO web_search_evidence (id,organization_id,project_id,session_id,backend,model,query,status,answer_text,sources)
				 VALUES ('search','default','project','session','hrouter_web_search','gpt-5.4','买家怎么问','complete','归纳','[{"url":"https://a.example/1","title":"a"}]'::jsonb)`,
			);
			const harness = await toolHarness(database, await loadTestSession(database));
			const propose = pick(harness.tools, "propose_questions");
			await expect(
				propose.execute("call-p", {
					intro: "说明",
					questions: [
						{
							question: "成都哪家工业除尘设备靠谱？",
							intent: "选型",
							tags: [],
							source: "research",
							evidenceIds: ["nope"],
						},
					],
				} as never),
			).rejects.toThrow("未知或越权证据");
			await expect(
				propose.execute("call-p", {
					intro: "说明",
					questions: [
						{ id: "ghost", question: "成都哪家工业除尘设备靠谱？", intent: "选型", tags: [], source: "existing" },
					],
				} as never),
			).rejects.toThrow("不存在的问题 id");
			const result = await propose.execute("call-p", {
				intro: "按意图分了三组，依据见 [search]。",
				questions: [
					{ id: "pending", question: "建档候选问题是什么？", intent: "购买", tags: [], source: "pending" },
					{
						question: "成都哪家工业除尘设备靠谱？",
						intent: "选型对比",
						topic: "选型",
						persona: "采购经理",
						tags: ["本地"],
						source: "research",
						evidenceIds: ["search"],
					},
					{ question: "成都哪家工业除尘设备靠谱？", intent: "重复项", tags: [], source: "research" },
				],
				competitors: [{ id: "rival", name: "竞品", domain: "rival.example", aliases: [] }],
			} as never);
			expect(result.terminate).toBe(true);
			expect(result.details).toMatchObject({ waiting: "user", proposal: true, questionCount: 2 });
			const waiting = harness.control.waiting as Extract<WorkbenchSession["waiting"], { kind: "user" }>;
			expect(waiting.kind).toBe("user");
			expect(waiting.toolCallId).toBe("call-p");
			expect(waiting.proposal?.questions).toHaveLength(2);
			expect(waiting.proposal?.questions[1]).toMatchObject({ key: "q2", source: "research", evidenceIds: ["search"] });
			expect(waiting.proposal?.competitors[0]).toMatchObject({ id: "rival", selected: true });
			expect(waiting.proposal?.industry).toBe("工业除尘");
			expect(harness.control.plan.find((step) => step.key === "scope")).toMatchObject({ status: "running" });
			const event = harness.events.find((item) => item.type === "proposal");
			expect(event?.payload.evidence).toEqual([
				expect.objectContaining({ id: "search", kind: "web_search", question: "买家怎么问" }),
			]);
		} finally {
			await database.close();
		}
	});

	it("成员确认候选表格后由服务端写入范围、启用项目并同步知识库，再以工具结果续跑", async () => {
		const proposal: ScopeProposal = {
			intro: "说明",
			industry: "工业除尘",
			questions: [
				{
					key: "q1",
					id: null,
					libraryQuestionId: null,
					question: "原候选",
					intent: "选型",
					topic: null,
					persona: null,
					tags: [],
					source: "research",
					evidenceIds: [],
					selected: true,
				},
			],
			competitors: [{ key: "c1", id: null, name: "竞品", domain: "rival.example", aliases: [], selected: true }],
		};
		const database = await seedSession(
			"waiting_user",
			{ kind: "user", question: "说明", options: [], multiple: true, toolCallId: "call-p", proposal },
			true,
			[{ key: "scope", label: "确认监测问题", status: "running", detail: "1 个候选待确认" }],
			"review",
		);
		try {
			await database.query(
				`INSERT INTO prompt_library_questions (id,organization_id,industry,question,intent,tags)
				 VALUES ('lib','default','工业除尘','库里已有的问题？','购买','[]'::jsonb)`,
			);
			await expect(answerQuestion(database, "session", {})).rejects.toThrow("请确认候选问题");
			const result = await answerQuestion(
				database,
				"session",
				{
					questions: [
						{ question: "成员改过的问题？", intent: "选型对比", topic: "选型", persona: "采购经理", tags: ["本地"] },
						{ question: "库里已有的问题？", intent: "购买", tags: [] },
						{ libraryQuestionId: "lib", question: "带引用的库问题？", intent: "购买", tags: [] },
					],
					competitors: [{ name: "竞品", domain: "rival.example", aliases: ["Rival"] }],
					syncLibrary: true,
					answer: "第一题请保留",
				},
				{ userId: "user", canWriteKnowledge: true },
			);
			expect(result).toMatchObject({ queued: true, applied: true, promptCount: 3, libraryAdded: 1 });
			const project = (await database.query<{ status: string }>("SELECT status FROM projects WHERE id='project'"))
				.rows[0];
			expect(project.status).toBe("active");
			const prompts = (
				await database.query<{ question: string; library_question_id: string | null }>(
					"SELECT question,library_question_id FROM prompts WHERE project_id='project' AND approved=true AND archived_at IS NULL ORDER BY position",
				)
			).rows;
			expect(prompts.map((row) => row.question)).toEqual(["成员改过的问题？", "库里已有的问题？", "带引用的库问题？"]);
			expect(prompts[0].library_question_id).toBeTruthy();
			expect(prompts[1].library_question_id).toBe("lib");
			const library = await database.query<{ question: string; created_by: string | null }>(
				"SELECT question,created_by FROM prompt_library_questions WHERE organization_id='default' AND archived_at IS NULL ORDER BY created_at",
			);
			expect(library.rows.map((row) => row.question)).toEqual(["库里已有的问题？", "成员改过的问题？"]);
			expect(library.rows[1].created_by).toBe("user");
			const competitors = await database.query<{ name: string; aliases: string[] }>(
				"SELECT name,aliases FROM competitors WHERE project_id='project' AND approved=true AND archived_at IS NULL",
			);
			expect(competitors.rows).toEqual([{ name: "竞品", aliases: ["Rival"] }]);
			const session = (
				await database.query<{ status: string; plan: Array<{ key: string; status: string; detail: string }> }>(
					"SELECT status,plan FROM agent_sessions WHERE id='session'",
				)
			).rows[0];
			expect(session.status).toBe("running");
			expect(session.plan[0]).toMatchObject({ key: "scope", status: "done", detail: "3 个问题 · 知识库新增 1" });
			const job = (
				await database.query<{ payload: { trigger: string; message: string } }>(
					"SELECT payload FROM jobs WHERE type='agent_session_turn'",
				)
			).rows[0];
			expect(job.payload.trigger).toBe("answer");
			expect(JSON.parse(job.payload.message)).toMatchObject({ applied: true, promptCount: 3, answer: "第一题请保留" });
			const events = await listSessionEvents(database, "session", 0);
			expect(events.items.map((event) => event.type)).toEqual(["step", "user_answer"]);
			expect(events.items[1].payload).toMatchObject({ applied: true, promptCount: 3, libraryAdded: 1 });
		} finally {
			await database.close();
		}
	});

	it("成员不采用候选时范围不变，反馈作为工具结果交回 Agent；无权限时不写知识库", async () => {
		const proposal: ScopeProposal = { intro: "说明", industry: "工业除尘", questions: [], competitors: [] };
		const database = await seedSession("waiting_user", {
			kind: "user",
			question: "说明",
			options: [],
			multiple: true,
			toolCallId: "call-p",
			proposal,
		});
		try {
			const rejected = await answerQuestion(database, "session", { answer: "问法太泛，要按地区拆" });
			expect(rejected).toMatchObject({ queued: true, applied: false });
			const job = (
				await database.query<{ payload: { message: string } }>(
					"SELECT payload FROM jobs WHERE type='agent_session_turn'",
				)
			).rows[0];
			expect(JSON.parse(job.payload.message)).toMatchObject({ applied: false, answer: "问法太泛，要按地区拆" });
			expect((await database.query("SELECT id FROM prompts WHERE project_id='project'")).rows).toHaveLength(0);
			await database.query(`UPDATE agent_sessions SET status='waiting_user',waiting=$1::jsonb WHERE id='session'`, [
				JSON.stringify({ kind: "user", question: "说明", options: [], multiple: true, toolCallId: "call-q", proposal }),
			]);
			const applied = await answerQuestion(
				database,
				"session",
				{ questions: [{ question: "没有权限也能确认的问题？", intent: "购买", tags: [] }], syncLibrary: true },
				{ userId: "user", canWriteKnowledge: false },
			);
			expect(applied).toMatchObject({ applied: true, promptCount: 1, libraryAdded: 0 });
			expect((await database.query("SELECT id FROM prompt_library_questions")).rows).toHaveLength(0);
		} finally {
			await database.close();
		}
	});

	it("快捷指令按项目状态与已批准问题数排序", () => {
		expect(orderQuickCommands({ status: "review", approvedPromptCount: 0 })[0]?.key).toBe("questions");
		expect(orderQuickCommands({ status: "active", approvedPromptCount: 3 })[0]?.key).toBe("questions");
		const mature = orderQuickCommands({ status: "active", approvedPromptCount: 30 });
		expect(mature[0]?.key).toBe("baseline");
		expect(mature.at(-1)?.key).toBe("questions");
		expect(mature).toHaveLength(6);
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
