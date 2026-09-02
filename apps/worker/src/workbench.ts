import { randomUUID } from "node:crypto";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { contentText, Type } from "@earendil-works/pi-ai";
import {
	type AgentSessionPlanStep,
	type AgentSessionStatus,
	type AgentSessionTurnPayload,
	type AgentSessionWaiting,
	type AgentThinkingLevel,
	agentThinkingLevels,
	type Database,
	readEncryptedCredential,
	type SearchProviderId,
	searchProviderIds,
} from "@geo/core";
import { StructuredLogger, safeErrorMessage } from "@geo/logging";
import { z } from "zod";
import {
	AGENT_SAFETY_PROMPT,
	agentRuntimeLogger,
	approveAgentRun,
	createEvidenceReadTools,
	createHRouterModel,
	enqueueAgentDraft,
	hrouterStreamFn,
	knownEvidenceIds,
	toolResult,
} from "./agent";
import { generateArticlesForBatch } from "./articles";
import { getHRouterConfig } from "./hrouter";
import { listLibraryQuestions } from "./knowledge-base";
import { type Paginated, type PaginationInput, paginated } from "./pagination";
import { providerDefinitions } from "./providers";
import { advanceReportWorkflow, getReportPdfStatus } from "./report-snapshots";
import { auditProject, confirmProject, createBatch, createTasksFromFindings, diagnoseBatch, getBatch } from "./service";
import { parseJsonColumn } from "./utils";

export const workbenchLogger = new StructuredLogger("workbench");
const SESSION_PROMPT_VERSION = "geo-workbench.v1";

type SessionRow = {
	id: string;
	organization_id: string;
	project_id: string;
	title: string;
	status: AgentSessionStatus;
	auto_approve: boolean;
	model: string | null;
	thinking_level: AgentThinkingLevel | null;
	transcript: unknown;
	plan: unknown;
	waiting: unknown;
	current_batch_id: string | null;
	usage: unknown;
	error_message: string | null;
	created_by: string | null;
	created_at: string;
	updated_at: string;
	last_turn_at: string | null;
};

const thinkingLevelSchema = z.enum(agentThinkingLevels as [AgentThinkingLevel, ...AgentThinkingLevel[]]);

const createSessionSchema = z.object({
	title: z.string().trim().min(1).max(80).optional(),
	autoApprove: z.boolean().optional(),
	thinkingLevel: thinkingLevelSchema.optional().nullable(),
	message: z.string().trim().min(1).max(4000).optional(),
});

const settingsSchema = z.object({
	autoApprove: z.boolean().optional(),
	thinkingLevel: thinkingLevelSchema.optional().nullable(),
	title: z.string().trim().min(1).max(80).optional(),
});

const messageSchema = z.object({ message: z.string().trim().min(1).max(4000) });
const answerSchema = z.object({
	answer: z.string().trim().max(4000).optional(),
	selected: z.array(z.string().trim().min(1)).max(50).optional(),
});

export const WORKBENCH_QUICK_COMMANDS = [
	{ key: "baseline", label: "跑正式基线", message: "为当前客户跑一次正式基线，并生成报告与优化文章。" },
	{ key: "quick_audit", label: "跑售前快审", message: "为当前客户跑一次售前快审，并生成报告。" },
	{ key: "report", label: "生成报告", message: "基于最近一个已完成批次生成报告，并同步生成优化文章。" },
	{ key: "audit", label: "官网审计", message: "重新审计当前客户官网的 AI 可读性并总结阻断项。" },
	{ key: "articles", label: "生成优化文章", message: "基于最近一份已批准报告的 GEO 建议逐条生成优化文章。" },
] as const;

function parseSession(row: SessionRow) {
	return {
		...row,
		transcript: parseJsonColumn<AgentMessage[]>(row.transcript as string | AgentMessage[]),
		plan: parseJsonColumn<AgentSessionPlanStep[]>(row.plan as string | AgentSessionPlanStep[]),
		waiting: row.waiting ? parseJsonColumn<AgentSessionWaiting>(row.waiting as string | AgentSessionWaiting) : null,
		usage: row.usage ? parseJsonColumn<Record<string, number>>(row.usage as string | Record<string, number>) : null,
	};
}

export type WorkbenchSession = ReturnType<typeof parseSession>;

async function loadSession(database: Database, sessionId: string): Promise<WorkbenchSession> {
	const row = (await database.query<SessionRow>("SELECT * FROM agent_sessions WHERE id=$1", [sessionId])).rows[0];
	if (!row) throw new Error("AI 工作台会话不存在");
	return parseSession(row);
}

async function appendEvent(
	database: Database,
	sessionId: string,
	type: string,
	payload: Record<string, unknown>,
): Promise<number> {
	const row = (
		await database.query<{ seq: number }>(
			`INSERT INTO agent_session_events (id,session_id,seq,type,payload)
			 SELECT $1,$2,COALESCE(max(seq),0)+1,$3,$4::jsonb FROM agent_session_events WHERE session_id=$2
			 RETURNING seq`,
			[randomUUID(), sessionId, type, JSON.stringify(payload)],
		)
	).rows[0];
	return row?.seq ?? 0;
}

async function enqueueTurn(database: Database, payload: AgentSessionTurnPayload): Promise<void> {
	await database.query(
		`INSERT INTO jobs (id,type,payload,status,max_attempts,available_at,created_at,updated_at)
		 VALUES ($1,'agent_session_turn',$2::jsonb,'pending',2,now(),now(),now())`,
		[randomUUID(), JSON.stringify(payload)],
	);
}

export async function createSession(
	database: Database,
	projectId: string,
	input: unknown,
	createdBy: string | null,
): Promise<{ id: string }> {
	const data = createSessionSchema.parse(input);
	const project = (
		await database.query<{ organization_id: string; status: string; name: string }>(
			"SELECT organization_id,status,name FROM projects WHERE id=$1",
			[projectId],
		)
	).rows[0];
	if (!project) throw new Error("客户项目不存在");
	const config = await getHRouterConfig(database, project.organization_id);
	if (!config.configured || !config.model) throw new Error("请先在平台设置中配置 HRouter API Key 与 GPT 模型");
	const id = randomUUID();
	const title = data.title ?? (data.message ? data.message.slice(0, 40) : `${project.name} · 新会话`);
	await database.query(
		`INSERT INTO agent_sessions (id,organization_id,project_id,title,status,auto_approve,model,thinking_level,created_by)
		 VALUES ($1,$2,$3,$4,'idle',$5,$6,$7,$8)`,
		[
			id,
			project.organization_id,
			projectId,
			title,
			data.autoApprove ?? true,
			config.model,
			data.thinkingLevel ?? null,
			createdBy,
		],
	);
	await appendEvent(database, id, "session_created", { title, autoApprove: data.autoApprove ?? true });
	if (data.message) await sendMessage(database, id, { message: data.message });
	return { id };
}

export async function listSessions(
	database: Database,
	projectId: string,
	input: PaginationInput,
): Promise<Paginated<Record<string, unknown>>> {
	const total = Number(
		(
			await database.query<{ count: number }>("SELECT count(*)::int AS count FROM agent_sessions WHERE project_id=$1", [
				projectId,
			])
		).rows[0]?.count ?? 0,
	);
	const rows = (
		await database.query<Record<string, unknown>>(
			`SELECT id,title,status,auto_approve,model,thinking_level,plan,waiting,current_batch_id,error_message,
			 created_at,updated_at,last_turn_at FROM agent_sessions WHERE project_id=$1
			 ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
			[projectId, input.pageSize, input.offset],
		)
	).rows.map((row) => ({
		...row,
		plan: parseJsonColumn(row.plan as string | unknown[]),
		waiting: row.waiting ? parseJsonColumn(row.waiting as string | Record<string, unknown>) : null,
	}));
	return paginated(rows, total, input);
}

export async function getSession(database: Database, sessionId: string): Promise<Record<string, unknown>> {
	const session = await loadSession(database, sessionId);
	const { transcript: _transcript, ...rest } = session;
	return rest;
}

export async function listSessionEvents(
	database: Database,
	sessionId: string,
	afterSeq: number,
	limit = 500,
): Promise<{ items: Array<Record<string, unknown>>; lastSeq: number }> {
	const rows = (
		await database.query<{ seq: number; type: string; payload: unknown; created_at: string }>(
			`SELECT seq,type,payload,created_at FROM agent_session_events WHERE session_id=$1 AND seq>$2
			 ORDER BY seq LIMIT $3`,
			[sessionId, afterSeq, limit],
		)
	).rows;
	const items = rows.map((row) => ({
		seq: row.seq,
		type: row.type,
		payload: parseJsonColumn<Record<string, unknown>>(row.payload as string | Record<string, unknown>),
		created_at: row.created_at,
	}));
	return { items, lastSeq: items.at(-1)?.seq ?? afterSeq };
}

export async function updateSessionSettings(database: Database, sessionId: string, input: unknown): Promise<void> {
	const data = settingsSchema.parse(input);
	const result = await database.query(
		`UPDATE agent_sessions SET auto_approve=COALESCE($2,auto_approve),
		 thinking_level=CASE WHEN $3::boolean THEN $4 ELSE thinking_level END,
		 title=COALESCE($5,title),updated_at=now() WHERE id=$1`,
		[
			sessionId,
			data.autoApprove ?? null,
			data.thinkingLevel !== undefined,
			data.thinkingLevel ?? null,
			data.title ?? null,
		],
	);
	if (result.affectedRows !== 1) throw new Error("AI 工作台会话不存在");
	await appendEvent(database, sessionId, "settings_changed", data);
}

export async function sendMessage(database: Database, sessionId: string, input: unknown): Promise<{ queued: true }> {
	const { message } = messageSchema.parse(input);
	const session = await loadSession(database, sessionId);
	if (session.status === "running") throw new Error("Agent 正在执行，请等待本回合结束后再发送");
	if (session.status === "waiting_user") throw new Error("Agent 正在等待你回答上一个问题，请先回答");
	await database.query("UPDATE agent_sessions SET status='running',error_message=NULL,updated_at=now() WHERE id=$1", [
		sessionId,
	]);
	await appendEvent(database, sessionId, "user_message", { text: message });
	await enqueueTurn(database, { sessionId, trigger: "user", message });
	return { queued: true };
}

export async function answerQuestion(database: Database, sessionId: string, input: unknown): Promise<{ queued: true }> {
	const data = answerSchema.parse(input);
	const session = await loadSession(database, sessionId);
	if (session.status !== "waiting_user" || session.waiting?.kind !== "user") throw new Error("当前没有待回答的问题");
	const parts = [
		...(data.selected?.length ? [`选择：${data.selected.join("；")}`] : []),
		...(data.answer ? [data.answer] : []),
	];
	if (!parts.length) throw new Error("请至少选择一项或输入回答");
	const answer = parts.join("\n");
	await database.query("UPDATE agent_sessions SET status='running',updated_at=now() WHERE id=$1", [sessionId]);
	await appendEvent(database, sessionId, "user_answer", { text: answer, selected: data.selected ?? [] });
	await enqueueTurn(database, { sessionId, trigger: "answer", message: answer });
	return { queued: true };
}

export async function cancelSession(database: Database, sessionId: string): Promise<void> {
	const result = await database.query(
		`UPDATE agent_sessions SET status='failed',waiting=NULL,error_message='用户已终止会话',updated_at=now()
		 WHERE id=$1 AND status IN ('running','waiting_user','waiting_job','idle')`,
		[sessionId],
	);
	if (result.affectedRows !== 1) throw new Error("会话已结束或不存在");
	await appendEvent(database, sessionId, "session_cancelled", {});
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

type TurnControl = {
	waiting: AgentSessionWaiting | null;
	finished: string | null;
	plan: AgentSessionPlanStep[];
	currentBatchId: string | null;
};

const purposeLabels: Record<string, string> = {
	diagnosis: "模型诊断",
	remediation: "整改规划",
	report_narrative: "报告叙述",
	quality_review: "报告质检",
	optimization_article: "优化文章",
	content_brief: "内容草稿",
};

function planUpsert(plan: AgentSessionPlanStep[], step: AgentSessionPlanStep): AgentSessionPlanStep[] {
	const index = plan.findIndex((item) => item.key === step.key);
	if (index === -1) return [...plan, step];
	const next = [...plan];
	next[index] = { ...next[index], ...step };
	return next;
}

const platformsSchema = Type.Array(Type.Union(searchProviderIds.map((id) => Type.Literal(id))), {
	minItems: 1,
	description: "监测平台 ID 列表",
});

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The workbench tool set intentionally lives in one auditable function so every write path is visible together.
async function createWorkbenchTools(
	database: Database,
	session: WorkbenchSession,
	control: TurnControl,
	persistControl: () => Promise<void>,
	emit: (type: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<AgentTool[]> {
	const projectId = session.project_id;
	const organizationId = session.organization_id;
	const allowedEvidence = await knownEvidenceIds(database, projectId, session.current_batch_id);
	const waitFor = async (waiting: AgentSessionWaiting, stepKey: string, label: string) => {
		control.waiting = waiting;
		control.plan = planUpsert(control.plan, {
			key: stepKey,
			label,
			status: "running",
			ref: "id" in waiting ? waiting.id : null,
		});
		await persistControl();
		await emit("waiting", { waiting });
		return {
			...toolResult({ waiting: true, detail: `${label}尚未完成，系统会在完成后自动唤醒你。` }),
			terminate: true,
		};
	};
	const ensureBatch = async (batchId: string) => {
		const batch = await getBatch(database, batchId);
		if (!batch || String(batch.project_id) !== projectId) throw new Error("批次不存在或不属于当前客户");
		return batch;
	};
	return [
		{
			name: "read_project_context",
			label: "读取客户项目",
			description: "读取当前客户画像、已确认竞品、已批准监测问题、已启用平台以及最近批次、报告和文章。",
			parameters: Type.Object({}),
			execute: async () => {
				const [project, competitors, prompts, providers, batches, reports, articles, schedule] = await Promise.all([
					database.query(
						"SELECT id,name,website_url,domain,region,language,industry,business_focus,aliases,profile,status FROM projects WHERE id=$1",
						[projectId],
					),
					database.query(
						"SELECT id,name,domain,aliases FROM competitors WHERE project_id=$1 AND approved=true AND archived_at IS NULL",
						[projectId],
					),
					database.query(
						"SELECT id,question,intent,topic,persona,tags,library_question_id FROM prompts WHERE project_id=$1 AND approved=true AND archived_at IS NULL ORDER BY position",
						[projectId],
					),
					database.query<{ provider_id: string }>(
						"SELECT provider_id FROM provider_configs WHERE organization_id=$1 AND enabled=true",
						[organizationId],
					),
					database.query(
						`SELECT id,kind,status,compare_to_batch_id,started_at,completed_at,
						 (SELECT count(*)::int FROM query_captures c WHERE c.batch_id=b.id) AS capture_count
						 FROM experiment_batches b WHERE project_id=$1 ORDER BY created_at DESC LIMIT 10`,
						[projectId],
					),
					database.query(
						"SELECT id,batch_id,report_type,title,pdf_artifact_key IS NOT NULL AS pdf_ready,created_at FROM report_snapshots WHERE project_id=$1 ORDER BY created_at DESC LIMIT 5",
						[projectId],
					),
					database.query(
						"SELECT id,batch_id,title,status,recommendation_title FROM optimization_articles WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20",
						[projectId],
					),
					database.query(
						"SELECT enabled,frequency_days,platforms,repeats,next_run_at FROM monitoring_schedules WHERE project_id=$1",
						[projectId],
					),
				]);
				return toolResult({
					project: project.rows[0] ?? null,
					competitors: competitors.rows,
					prompts: prompts.rows,
					enabledPlatforms: providers.rows.map((row) => ({
						id: row.provider_id,
						label: providerDefinitions[row.provider_id as SearchProviderId]?.label ?? row.provider_id,
					})),
					recentBatches: batches.rows,
					recentReports: reports.rows,
					articles: articles.rows,
					monitoringSchedule: schedule.rows[0] ?? null,
					sessionState: { currentBatchId: control.currentBatchId, plan: control.plan },
				});
			},
		},
		...createEvidenceReadTools(database, projectId, session.current_batch_id, allowedEvidence),
		{
			name: "suggest_questions",
			label: "整理问题候选",
			description:
				"返回当前已批准监测问题，以及同机构同行业知识库中尚未纳入的问题候选。用于在跑基线前与用户确认要使用或追加的问题。",
			parameters: Type.Object({}),
			execute: async () => {
				const project = (
					await database.query<{ industry: string | null }>("SELECT industry FROM projects WHERE id=$1", [projectId])
				).rows[0];
				const current = (
					await database.query(
						"SELECT id,question,intent,topic,persona,tags,library_question_id FROM prompts WHERE project_id=$1 AND approved=true AND archived_at IS NULL ORDER BY position",
						[projectId],
					)
				).rows;
				const usedLibraryIds = new Set(current.map((row) => row.library_question_id).filter(Boolean));
				const usedQuestions = new Set(current.map((row) => String(row.question)));
				const library = await listLibraryQuestions(database, organizationId, project?.industry ?? null, {
					page: 1,
					pageSize: 100,
					offset: 0,
					search: null,
				});
				const candidates = library.items.filter(
					(item) => !usedLibraryIds.has(item.id) && !usedQuestions.has(String(item.question)),
				);
				return toolResult({ current, libraryCandidates: candidates, industry: project?.industry ?? null });
			},
		},
		{
			name: "ask_user",
			label: "向用户提问",
			description:
				"向用户提出一个必须由人决定的问题（例如确认要使用的问题集、是否追加问题、是否继续）。提供可选项时用户可以直接点选；multiple=true 允许多选。调用后本回合结束，用户回答后你会收到回答。",
			parameters: Type.Object({
				question: Type.String({ minLength: 4, maxLength: 1200 }),
				options: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 40 }),
				multiple: Type.Boolean(),
			}),
			executionMode: "sequential",
			execute: async (toolCallId, params) => {
				const { question, options, multiple } = params as { question: string; options: string[]; multiple: boolean };
				control.waiting = { kind: "user", question, options, multiple, toolCallId };
				await persistControl();
				await emit("question", { question, options, multiple });
				return { ...toolResult({ waiting: "user" }), terminate: true };
			},
		},
		{
			name: "apply_scope",
			label: "应用监测范围",
			description:
				"在用户明确确认后，写入新的监测问题集（会生成新版本范围，旧批次不受影响）。必须传入完整的最终问题列表；保留已有问题时带上其 id。竞品与别名默认沿用现有值。",
			parameters: Type.Object({
				prompts: Type.Array(
					Type.Object({
						id: Type.Optional(Type.String()),
						libraryQuestionId: Type.Optional(Type.String()),
						question: Type.String({ minLength: 4 }),
						intent: Type.String({ minLength: 1 }),
						topic: Type.Optional(Type.String()),
						persona: Type.Optional(Type.String()),
						tags: Type.Array(Type.String()),
					}),
					{ minItems: 1, maxItems: 100 },
				),
			}),
			executionMode: "sequential",
			execute: async (_toolCallId, params) => {
				const { prompts } = params as { prompts: Array<Record<string, unknown>> };
				const [project, competitors] = await Promise.all([
					database.query<{ aliases: unknown }>("SELECT aliases FROM projects WHERE id=$1", [projectId]),
					database.query(
						"SELECT id,name,domain,aliases FROM competitors WHERE project_id=$1 AND approved=true AND archived_at IS NULL",
						[projectId],
					),
				]);
				await confirmProject(database, projectId, {
					aliases: parseJsonColumn<string[]>((project.rows[0]?.aliases ?? []) as string | string[]),
					competitors: competitors.rows.map((row) => ({
						id: row.id,
						name: row.name,
						domain: row.domain,
						aliases: parseJsonColumn<string[]>(row.aliases as string | string[]),
					})),
					prompts,
				});
				control.plan = planUpsert(control.plan, {
					key: "scope",
					label: "确认监测问题",
					status: "done",
					detail: `${prompts.length} 个问题`,
				});
				await persistControl();
				await emit("step", { key: "scope", status: "done", detail: `${prompts.length} 个问题` });
				return toolResult({ applied: true, promptCount: prompts.length });
			},
		},
		{
			name: "create_batch",
			label: "创建采集批次",
			description:
				"按已确认问题与启用平台创建批次并排队采集。quick_audit 每题 1 次；baseline 默认每题 3 次分三个时间窗口（0/4h/24h）；retest 需要 compareToBatchId。返回后应调用 wait_for 等待完成。",
			parameters: Type.Object({
				kind: Type.Union([Type.Literal("quick_audit"), Type.Literal("baseline"), Type.Literal("retest")]),
				platforms: Type.Optional(platformsSchema),
				repeats: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
				compareToBatchId: Type.Optional(Type.String()),
			}),
			executionMode: "sequential",
			execute: async (_toolCallId, params) => {
				const input = params as {
					kind: "quick_audit" | "baseline" | "retest";
					platforms?: SearchProviderId[];
					repeats?: number;
					compareToBatchId?: string;
				};
				const platforms =
					input.platforms ??
					(
						await database.query<{ provider_id: SearchProviderId }>(
							"SELECT provider_id FROM provider_configs WHERE organization_id=$1 AND enabled=true",
							[organizationId],
						)
					).rows.map((row) => row.provider_id);
				if (!platforms.length) throw new Error("当前机构没有启用任何监测平台，请先在平台设置中启用");
				const result = await createBatch(database, projectId, {
					kind: input.kind,
					platforms,
					repeats: input.repeats,
					compareToBatchId: input.compareToBatchId ?? null,
				});
				control.currentBatchId = result.id;
				control.plan = planUpsert(control.plan, {
					key: "batch",
					label:
						input.kind === "quick_audit" ? "售前快审采集" : input.kind === "retest" ? "同条件复测" : "正式基线采集",
					status: "running",
					ref: result.id,
					detail: `${result.jobCount} 个采集任务`,
				});
				await persistControl();
				await emit("step", {
					key: "batch",
					status: "running",
					ref: result.id,
					detail: `${result.jobCount} 个采集任务`,
				});
				return toolResult({ batchId: result.id, jobCount: result.jobCount, platforms });
			},
		},
		{
			name: "get_batch_status",
			label: "查看批次状态",
			description: "读取批次状态、已采集/计划样本数与指标摘要。",
			parameters: Type.Object({ batchId: Type.String() }),
			execute: async (_toolCallId, params) => {
				const batch = await ensureBatch((params as { batchId: string }).batchId);
				const metrics = batch.metrics as Record<string, unknown> | undefined;
				return toolResult({
					id: batch.id,
					kind: batch.kind,
					status: batch.status,
					captured: Array.isArray(batch.captures) ? batch.captures.length : 0,
					metrics: metrics
						? {
								overall: metrics.overall,
								validSamples: metrics.validSamples,
								failedSamples: metrics.failedSamples,
								expectedSamples: metrics.expectedSamples,
							}
						: null,
				});
			},
		},
		{
			name: "wait_for",
			label: "等待后台任务",
			description:
				"等待批次采集(batch)、Agent 草稿(agent_run)或报告文档(report)完成。调用后本回合结束，完成后系统自动唤醒你并附上结果摘要。",
			parameters: Type.Object({
				kind: Type.Union([Type.Literal("batch"), Type.Literal("agent_run"), Type.Literal("report")]),
				id: Type.String(),
				label: Type.String({ minLength: 1, maxLength: 80 }),
			}),
			executionMode: "sequential",
			// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: wait_for validates ownership and completion for each waitable kind.
			execute: async (toolCallId, params) => {
				const { kind, id, label } = params as { kind: "batch" | "agent_run" | "report"; id: string; label: string };
				if (kind === "batch") {
					const batch = await ensureBatch(id);
					if (["complete", "partial"].includes(String(batch.status)))
						return toolResult({ alreadyDone: true, status: batch.status });
				}
				if (kind === "agent_run") {
					const run = (
						await database.query<{ status: string; project_id: string }>(
							"SELECT status,project_id FROM agent_runs WHERE id=$1",
							[id],
						)
					).rows[0];
					if (!run || run.project_id !== projectId) throw new Error("Agent 运行不存在或不属于当前客户");
					if (["approved", "rejected", "failed"].includes(run.status))
						return toolResult({ alreadyDone: true, status: run.status });
				}
				if (kind === "report") {
					const report = (
						await database.query<{ project_id: string; pdf_artifact_key: string | null }>(
							"SELECT project_id,pdf_artifact_key FROM report_snapshots WHERE id=$1",
							[id],
						)
					).rows[0];
					if (!report || report.project_id !== projectId) throw new Error("报告不存在或不属于当前客户");
					if (report.pdf_artifact_key) return toolResult({ alreadyDone: true, status: "ready" });
				}
				const stepKey = kind === "batch" ? "batch" : kind === "report" ? "report_document" : `run:${id}`;
				return waitFor({ kind, id, label, toolCallId }, stepKey, label);
			},
		},
		{
			name: "verify_batch",
			label: "核验采集结果",
			description:
				"抽样核验批次证据：失败平台、来源不可见比例、品牌匹配异常、回答为空等。返回统计与抽样，用于你写核验小结，不修改任何证据。",
			parameters: Type.Object({
				batchId: Type.String(),
				sampleSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
			}),
			execute: async (_toolCallId, params) => {
				const { batchId, sampleSize } = params as { batchId: string; sampleSize?: number };
				await ensureBatch(batchId);
				const rows = (
					await database.query<Record<string, unknown>>(
						`SELECT c.id,c.platform,c.status,c.failure_code,c.source_visibility,p.question,
						 jsonb_array_length(c.brand_matches) AS brand_match_count,jsonb_array_length(c.sources) AS source_count,
						 length(c.answer_text) AS answer_length
						 FROM query_captures c LEFT JOIN prompts p ON p.id=c.prompt_id WHERE c.batch_id=$1 ORDER BY c.captured_at`,
						[batchId],
					)
				).rows;
				const byPlatform: Record<string, { total: number; failed: number; noSources: number; noAnswer: number }> = {};
				for (const row of rows) {
					const platform = String(row.platform);
					if (!byPlatform[platform]) byPlatform[platform] = { total: 0, failed: 0, noSources: 0, noAnswer: 0 };
					const bucket = byPlatform[platform];
					bucket.total += 1;
					if (row.status !== "complete") bucket.failed += 1;
					if (Number(row.source_count) === 0) bucket.noSources += 1;
					if (!row.answer_length || Number(row.answer_length) < 50) bucket.noAnswer += 1;
				}
				const failures = rows.filter((row) => row.status !== "complete").slice(0, sampleSize ?? 8);
				const sample = rows.filter((row) => row.status === "complete").slice(0, sampleSize ?? 8);
				return toolResult({ total: rows.length, byPlatform, failures, sample });
			},
		},
		{
			name: "run_site_audit",
			label: "运行官网审计",
			description: "重新抓取并审计客户官网的 AI 可读性（robots、sitemap、结构化数据、HTTPS 等），返回得分与检查项。",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => {
				const audit = await auditProject(database, projectId);
				control.plan = planUpsert(control.plan, {
					key: "audit",
					label: "官网审计",
					status: "done",
					ref: audit.id,
					detail: `${(audit.result as { score?: number }).score ?? "-"} 分`,
				});
				await persistControl();
				await emit("step", { key: "audit", status: "done", ref: audit.id });
				return toolResult({ auditId: audit.id, result: audit.result });
			},
		},
		{
			name: "run_rule_diagnosis",
			label: "运行规则诊断",
			description: "对已完成批次运行确定性证据诊断，并把差距转成整改任务。",
			parameters: Type.Object({ batchId: Type.String() }),
			executionMode: "sequential",
			execute: async (_toolCallId, params) => {
				const { batchId } = params as { batchId: string };
				await ensureBatch(batchId);
				const diagnosis = await diagnoseBatch(database, batchId);
				const tasks = await createTasksFromFindings(database, projectId, batchId).catch((error) => ({
					count: 0,
					error: safeErrorMessage(error),
				}));
				control.plan = planUpsert(control.plan, {
					key: "diagnosis",
					label: "规则诊断与整改任务",
					status: "done",
					ref: batchId,
					detail: `${diagnosis.count} 条诊断`,
				});
				await persistControl();
				await emit("step", { key: "diagnosis", status: "done", detail: `${diagnosis.count} 条诊断` });
				return toolResult({ findings: diagnosis.count, tasks });
			},
		},
		{
			name: "run_agent_draft",
			label: "运行 Agent 草稿",
			description:
				"为批次排队一个受限 Agent 草稿（diagnosis / remediation）。报告叙述与质检请使用 advance_report。返回 runId 后应 wait_for(kind=agent_run)。",
			parameters: Type.Object({
				batchId: Type.String(),
				purpose: Type.Union([Type.Literal("diagnosis"), Type.Literal("remediation")]),
			}),
			executionMode: "sequential",
			execute: async (_toolCallId, params) => {
				const { batchId, purpose } = params as { batchId: string; purpose: "diagnosis" | "remediation" };
				await ensureBatch(batchId);
				const run = await enqueueAgentDraft(database, {
					projectId,
					batchId,
					purpose,
					sessionId: session.id,
					thinkingLevel: session.thinking_level,
				});
				control.plan = planUpsert(control.plan, {
					key: `run:${run.id}`,
					label: purposeLabels[purpose] ?? purpose,
					status: "running",
					ref: run.id,
				});
				await persistControl();
				return toolResult({ runId: run.id, purpose });
			},
		},
		{
			name: "advance_report",
			label: "推进报告工作流",
			description:
				"推进批次的报告工作流：自动排队报告叙述 → 质检 → 冻结快照 → PDF/Word。返回当前 state 与 runId/reportId；若 state 不是 ready，用 wait_for 等待对应对象（narrative_*/quality_* 用 agent_run，documents_queued 用 report）。",
			parameters: Type.Object({ batchId: Type.String(), restart: Type.Optional(Type.Boolean()) }),
			executionMode: "sequential",
			execute: async (_toolCallId, params) => {
				const { batchId, restart } = params as { batchId: string; restart?: boolean };
				await ensureBatch(batchId);
				const result = await advanceReportWorkflow(database, batchId, {
					createdBy: session.created_by,
					allowRetry: true,
					restart: Boolean(restart),
				});
				if (result.runId)
					await database.query("UPDATE agent_runs SET session_id=COALESCE(session_id,$2) WHERE id=$1", [
						result.runId,
						session.id,
					]);
				control.plan = planUpsert(control.plan, {
					key: "report",
					label: "报告叙述与质检",
					status: result.state === "ready" ? "done" : result.state === "quality_blocked" ? "failed" : "running",
					ref: result.reportId ?? result.runId,
					detail: result.state,
				});
				await persistControl();
				await emit("step", {
					key: "report",
					status: control.plan.find((s) => s.key === "report")?.status,
					detail: result.state,
				});
				const pdf = result.reportId ? await getReportPdfStatus(database, result.reportId) : null;
				return toolResult({ ...result, pdf });
			},
		},
		{
			name: "generate_articles",
			label: "生成优化文章",
			description:
				"基于批次已批准报告叙述的每条 GEO 建议排队生成一篇优化文章草稿。返回排队的 runId 列表；可用 wait_for 逐个等待，或告知用户稍后在“优化文章”页查看。",
			parameters: Type.Object({ batchId: Type.String() }),
			executionMode: "sequential",
			execute: async (_toolCallId, params) => {
				const { batchId } = params as { batchId: string };
				await ensureBatch(batchId);
				const result = await generateArticlesForBatch(database, batchId, { sessionId: session.id });
				control.plan = planUpsert(control.plan, {
					key: "articles",
					label: "优化文章",
					status: result.queued.length ? "running" : "done",
					ref: batchId,
					detail: `${result.queued.length} 篇排队`,
				});
				await persistControl();
				await emit("step", { key: "articles", status: "running", detail: `${result.queued.length} 篇排队` });
				return toolResult(result);
			},
		},
		{
			name: "finish",
			label: "结束任务",
			description: "全部步骤完成或无法继续时调用，附上给用户的中文总结（包含批次、报告、文章的结果与后续建议）。",
			parameters: Type.Object({ summary: Type.String({ minLength: 10, maxLength: 4000 }) }),
			executionMode: "sequential",
			execute: async (_toolCallId, params) => {
				control.finished = (params as { summary: string }).summary;
				await persistControl();
				return { ...toolResult({ finished: true }), terminate: true };
			},
		},
	];
}

const WORKBENCH_SYSTEM_PROMPT = `你是 ZZ Geo 的 AI 工作台 Agent，负责替用户把 GEO 监测流程一口气跑完。你通过工具操作系统，所有工具只作用于当前客户项目。

标准流程（用户说"跑基线/跑快审"时）：
1. read_project_context 了解客户、问题、平台与最近批次。
2. suggest_questions，然后用 ask_user 让用户确认：沿用现有问题、追加知识库候选或你建议的新问题。只有用户明确确认后才 apply_scope；用户说沿用则跳过。
3. create_batch，然后 wait_for(batch)。正式基线会分三个时间窗口采集，等待可能长达一天，这是正常的。
4. 采集完成后 verify_batch 写一段核验小结（失败平台、来源不可见、异常样本）。
5. run_site_audit 与 run_rule_diagnosis。
6. advance_report 推进报告；每次返回 state 非 ready 时 wait_for 对应对象，被唤醒后再次 advance_report，直到 ready。质检 blocked 时用 ask_user 询问用户是否重试或结束。
7. generate_articles，并告知用户文章数量与查看位置。
8. finish 给出总结。

其他指令（只生成报告、只审计、只生成文章等）按需选取上述子集。每完成一步用一两句中文向用户汇报进展。不要重复读取已经读过的证据。${AGENT_SAFETY_PROMPT}`;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: A turn restores transcript, streams events and persists the outcome in one auditable path.
export async function executeSessionTurn(
	database: Database,
	sessionId: string,
	trigger: AgentSessionTurnPayload["trigger"],
	message: string | null,
): Promise<void> {
	const session = await loadSession(database, sessionId);
	if (["done", "failed"].includes(session.status) && trigger !== "user") return;
	const config = await getHRouterConfig(database, session.organization_id);
	const apiKey = await readEncryptedCredential(database, "hrouter_api_key", session.organization_id);
	if (!config.model || !apiKey) throw new Error("请先配置 HRouter API Key 与 GPT 模型");
	const control: TurnControl = {
		waiting: null,
		finished: null,
		plan: session.plan,
		currentBatchId: session.current_batch_id,
	};
	const persistControl = async () => {
		await database.query("UPDATE agent_sessions SET plan=$2::jsonb,current_batch_id=$3,updated_at=now() WHERE id=$1", [
			sessionId,
			JSON.stringify(control.plan),
			control.currentBatchId,
		]);
	};
	const emit = async (type: string, payload: Record<string, unknown>) => {
		await appendEvent(database, sessionId, type, payload);
	};
	await database.query(
		"UPDATE agent_sessions SET status='running',waiting=NULL,last_turn_at=now(),updated_at=now() WHERE id=$1",
		[sessionId],
	);
	const priorWaiting = session.waiting;
	const tools = await createWorkbenchTools(database, session, control, persistControl, emit);
	const allowedToolNames = new Set(tools.map((tool) => tool.name));
	const agent = new Agent({
		initialState: {
			systemPrompt: WORKBENCH_SYSTEM_PROMPT,
			model: createHRouterModel(config.model, config.baseUrl),
			thinkingLevel: session.thinking_level ?? config.thinkingLevel,
			tools,
			messages: session.transcript,
		},
		streamFn: hrouterStreamFn,
		getApiKey: (provider) => (provider === "hrouter" ? apiKey : undefined),
		toolExecution: "sequential",
		beforeToolCall: async ({ toolCall }) =>
			allowedToolNames.has(toolCall.name)
				? undefined
				: { block: true, reason: "工具不在 AI 工作台白名单中", terminate: true },
		shouldStopAfterTurn: () => control.waiting !== null || control.finished !== null,
	});
	let streamedText = "";
	let lastFlush = 0;
	let assistantSeq = 0;
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One subscriber maps every agent event type to a persisted session event.
	agent.subscribe(async (event) => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			streamedText = "";
			assistantSeq += 1;
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			streamedText += event.assistantMessageEvent.delta;
			if (Date.now() - lastFlush > 600) {
				lastFlush = Date.now();
				await emit("assistant_delta", { turn: assistantSeq, text: streamedText });
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const text = contentText(event.message.content).trim();
			if (text) await emit("assistant_message", { turn: assistantSeq, text });
			streamedText = "";
		}
		if (event.type === "tool_execution_start") {
			await emit("tool_start", { tool: event.toolName, args: event.args ?? null });
		}
		if (event.type === "tool_execution_end") {
			const details = (event.result as { details?: unknown } | null)?.details;
			await emit("tool_end", {
				tool: event.toolName,
				isError: event.isError,
				details: event.isError ? summarizeError(event.result) : compactDetails(details),
			});
		}
	});
	try {
		if (trigger === "answer" && priorWaiting?.kind === "user") {
			// 用户回答作为 ask_user 的工具结果续接，保持对话结构完整。
			const answered: AgentMessage = {
				role: "toolResult",
				toolCallId: priorWaiting.toolCallId,
				toolName: "ask_user",
				content: [{ type: "text", text: JSON.stringify({ answer: message ?? "" }) }],
				isError: false,
				timestamp: Date.now(),
			};
			await appendToolResult(agent, answered);
			await agent.continue();
		} else if (trigger === "resume" && priorWaiting && priorWaiting.kind !== "user") {
			const resumed: AgentMessage = {
				role: "toolResult",
				toolCallId: priorWaiting.toolCallId,
				toolName: "wait_for",
				content: [
					{
						type: "text",
						text: JSON.stringify({ completed: true, kind: priorWaiting.kind, id: priorWaiting.id, summary: message }),
					},
				],
				isError: false,
				timestamp: Date.now(),
			};
			await appendToolResult(agent, resumed);
			await agent.continue();
		} else {
			await agent.prompt(message ?? "请继续。");
		}
		const assistants = agent.state.messages.filter((item) => item.role === "assistant");
		const usage = assistants.reduce(
			(total, item) => ({
				input: total.input + (item.usage?.input ?? 0),
				output: total.output + (item.usage?.output ?? 0),
				totalTokens: total.totalTokens + (item.usage?.totalTokens ?? 0),
			}),
			{ input: 0, output: 0, totalTokens: 0 },
		);
		let status: AgentSessionStatus = "idle";
		if (control.finished) status = "done";
		else if (control.waiting?.kind === "user") status = "waiting_user";
		else if (control.waiting) status = "waiting_job";
		await database.query(
			`UPDATE agent_sessions SET status=$2,waiting=$3::jsonb,transcript=$4::jsonb,plan=$5::jsonb,current_batch_id=$6,
			 usage=$7::jsonb,error_message=NULL,updated_at=now() WHERE id=$1`,
			[
				sessionId,
				status,
				control.waiting ? JSON.stringify(control.waiting) : null,
				JSON.stringify(agent.state.messages),
				JSON.stringify(control.plan),
				control.currentBatchId,
				JSON.stringify(usage),
			],
		);
		if (control.finished) await emit("finished", { summary: control.finished });
		else if (status === "idle") await emit("turn_idle", {});
		await database.query(
			`INSERT INTO project_costs (id,project_id,batch_id,provider_id,operation,usage,cost_micros)
			 VALUES ($1,$2,$3,'hrouter_gpt','workbench',$4::jsonb,NULL)`,
			[
				randomUUID(),
				session.project_id,
				control.currentBatchId,
				JSON.stringify({ inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.totalTokens }),
			],
		);
	} catch (error) {
		const detail = error instanceof Error ? error.message.slice(0, 2000) : "Agent 执行失败";
		await database.query(
			"UPDATE agent_sessions SET status='failed',waiting=NULL,transcript=$2::jsonb,error_message=$3,updated_at=now() WHERE id=$1",
			[sessionId, JSON.stringify(agent.state.messages), detail],
		);
		await emit("error", { message: detail });
		workbenchLogger.error("workbench.turn_failed", safeErrorMessage(error), {
			organizationId: session.organization_id,
			projectId: session.project_id,
			traceId: sessionId,
		});
		throw error;
	}
}

async function appendToolResult(agent: Agent, message: AgentMessage): Promise<void> {
	const messages = agent.state.messages;
	// 只有最后一条是 assistant 且含未回应的 toolCall 时才能续接；否则退化为用户消息。
	const last = messages.at(-1);
	if (last?.role === "assistant" && message.role === "toolResult") {
		agent.state.messages = [...messages, message];
		return;
	}
	const text = message.role === "toolResult" ? contentText(message.content) : "";
	agent.state.messages = [...messages, { role: "user", content: text, timestamp: Date.now() }];
}

function summarizeError(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
	return (
		content
			?.filter((item) => item.type === "text" && item.text)
			.map((item) => item.text)
			.join("\n")
			.slice(0, 600) || "工具执行失败"
	);
}

function compactDetails(details: unknown): unknown {
	if (details === null || details === undefined) return null;
	const text = JSON.stringify(details);
	if (text.length <= 1500) return details;
	return { truncated: true, preview: text.slice(0, 1500) };
}

// ---------------------------------------------------------------------------
// Coordinator: wake waiting sessions and auto-approve drafts
// ---------------------------------------------------------------------------

type WaitingSession = {
	id: string;
	project_id: string;
	auto_approve: boolean;
	created_by: string | null;
	waiting: unknown;
};

async function describeBatch(database: Database, batchId: string): Promise<string> {
	const batch = await getBatch(database, batchId);
	if (!batch) return "批次不存在";
	const metrics = batch.metrics as {
		validSamples?: number;
		failedSamples?: number;
		expectedSamples?: number;
		overall?: Record<string, number>;
	};
	const overall = metrics.overall ?? {};
	const pct = (value: unknown) => (typeof value === "number" ? `${Math.round(value * 100)}%` : "不可用");
	return `批次 ${batchId} 状态 ${batch.status}：有效 ${metrics.validSamples ?? 0}/${metrics.expectedSamples ?? 0}，失败 ${metrics.failedSamples ?? 0}；品牌提及率 ${pct(overall.brandMentionRate)}，首位推荐率 ${pct(overall.firstRecommendationRate)}，官网引用率 ${pct(overall.citationRate)}。`;
}

/** 由 Agent Worker 周期调用：自动批准工作台产生的草稿，并唤醒等待中的会话。 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The coordinator checks every waiting kind in one scan so wake-ups stay ordered.
export async function resumeWaitingSessions(database: Database): Promise<number> {
	let resumed = 0;
	// 1. 自动批准：会话开启自动模式且草稿来自该会话。
	const pendingRuns = (
		await database.query<{
			id: string;
			purpose: string;
			session_id: string;
			batch_id: string | null;
			created_by: string | null;
		}>(
			`SELECT r.id,r.purpose,r.session_id,r.batch_id,s.created_by FROM agent_runs r
			 JOIN agent_sessions s ON s.id=r.session_id
			 WHERE r.status='awaiting_approval' AND s.auto_approve=true AND s.status<>'failed'`,
		)
	).rows;
	for (const run of pendingRuns) {
		try {
			const approved = await approveAgentRun(database, run.id, run.created_by, "workbench", run.session_id);
			await appendEvent(database, run.session_id, "auto_approved", {
				runId: run.id,
				purpose: run.purpose,
				summary: String((approved.draft as { summary?: unknown }).summary ?? ""),
			});
			if (approved.batchId && ["report_narrative", "quality_review"].includes(approved.purpose))
				await advanceReportWorkflow(database, approved.batchId, { createdBy: run.created_by, allowRetry: false }).catch(
					(error) =>
						workbenchLogger.error("workbench.workflow_advance_failed", safeErrorMessage(error), {
							traceId: run.session_id,
						}),
				);
		} catch (error) {
			await appendEvent(database, run.session_id, "auto_approve_failed", {
				runId: run.id,
				purpose: run.purpose,
				message: safeErrorMessage(error),
			});
			await database.query("UPDATE agent_runs SET status='rejected' WHERE id=$1 AND status='awaiting_approval'", [
				run.id,
			]);
		}
	}
	// 1b. 文章草稿不需要人工审批：无会话时也自动物化。
	const articleRuns = (
		await database.query<{ id: string }>(
			"SELECT id FROM agent_runs WHERE status='awaiting_approval' AND purpose='optimization_article'",
		)
	).rows;
	for (const run of articleRuns) {
		try {
			await approveAgentRun(database, run.id, null, "auto_article");
		} catch (error) {
			await database.query("UPDATE agent_runs SET status='failed',error_message=$2 WHERE id=$1", [
				run.id,
				safeErrorMessage(error).slice(0, 2000),
			]);
		}
	}
	// 2. 唤醒等待后台对象的会话。
	const waitingSessions = (
		await database.query<WaitingSession>(
			"SELECT id,project_id,auto_approve,created_by,waiting FROM agent_sessions WHERE status='waiting_job' AND waiting IS NOT NULL",
		)
	).rows;
	for (const session of waitingSessions) {
		const waiting = parseJsonColumn<AgentSessionWaiting>(session.waiting as string | AgentSessionWaiting);
		if (waiting.kind === "user") continue;
		let summary: string | null = null;
		if (waiting.kind === "batch") {
			const batch = (
				await database.query<{ status: string }>("SELECT status FROM experiment_batches WHERE id=$1", [waiting.id])
			).rows[0];
			if (batch && ["complete", "partial"].includes(batch.status)) summary = await describeBatch(database, waiting.id);
		} else if (waiting.kind === "agent_run") {
			const run = (
				await database.query<{ status: string; purpose: string; error_message: string | null; draft: unknown }>(
					"SELECT status,purpose,error_message,draft FROM agent_runs WHERE id=$1",
					[waiting.id],
				)
			).rows[0];
			if (run && ["approved", "rejected", "failed"].includes(run.status)) {
				const draft = run.draft
					? parseJsonColumn<Record<string, unknown>>(run.draft as string | Record<string, unknown>)
					: {};
				summary = `${purposeLabels[run.purpose] ?? run.purpose} ${waiting.id} 状态 ${run.status}${run.error_message ? `：${run.error_message}` : ""}${draft.summary ? `。摘要：${String(draft.summary).slice(0, 600)}` : ""}${draft.verdict ? `。质检结论：${String(draft.verdict)}` : ""}`;
			} else if (run && run.status === "awaiting_approval" && !session.auto_approve) {
				// 手动模式：把审批交还用户。
				await database.query(
					"UPDATE agent_sessions SET status='waiting_user',waiting=$2::jsonb,updated_at=now() WHERE id=$1",
					[
						session.id,
						JSON.stringify({
							kind: "user",
							question: `${purposeLabels[run.purpose] ?? run.purpose}草稿已生成，等待你在对应页面批准或拒绝。批准后回复“已批准”，拒绝后回复“已拒绝并结束”。`,
							options: ["已批准，继续", "已拒绝，结束流程"],
							multiple: false,
							toolCallId: waiting.toolCallId,
						} satisfies AgentSessionWaiting),
					],
				);
				await appendEvent(database, session.id, "question", {
					question: `${purposeLabels[run.purpose] ?? run.purpose}草稿已生成，请到对应页面审批后回复。`,
					options: ["已批准，继续", "已拒绝，结束流程"],
					multiple: false,
					runId: waiting.id,
				});
				continue;
			}
		} else if (waiting.kind === "report") {
			const report = (
				await database.query<{ pdf_artifact_key: string | null; title: string }>(
					"SELECT pdf_artifact_key,title FROM report_snapshots WHERE id=$1",
					[waiting.id],
				)
			).rows[0];
			if (report?.pdf_artifact_key) summary = `报告《${report.title}》PDF 已生成（报告 ID ${waiting.id}）。`;
		}
		if (!summary) continue;
		await database.query("UPDATE agent_sessions SET status='running',updated_at=now() WHERE id=$1", [session.id]);
		await appendEvent(database, session.id, "resumed", { kind: waiting.kind, id: waiting.id, summary });
		await enqueueTurn(database, { sessionId: session.id, trigger: "resume", message: summary });
		resumed += 1;
	}
	return resumed;
}

/** 执行进程中断后，长时间 running 且无待处理任务的会话置为失败，避免前端永久转圈。 */
export async function recoverOrphanedSessions(database: Database): Promise<number> {
	const result = await database.query(
		`UPDATE agent_sessions s SET status='failed',error_message='Agent 执行进程已中断；请重新发送消息继续',updated_at=now()
		 WHERE s.status='running' AND s.updated_at<now()-interval '20 minutes'
		 AND NOT EXISTS (
			 SELECT 1 FROM jobs j WHERE j.type='agent_session_turn' AND j.payload->>'sessionId'=s.id AND j.status IN ('pending','leased')
		 )`,
	);
	return result.affectedRows;
}

export const workbenchPromptVersion = SESSION_PROMPT_VERSION;
export { agentRuntimeLogger as workbenchAgentLogger };
