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
	type ScopeProposal,
	type ScopeProposalCompetitor,
	type ScopeProposalQuestion,
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
import type { EvidenceIndexEntry } from "./report";
import { advanceReportWorkflow, getReportPdfStatus } from "./report-snapshots";
import { auditProject, confirmProject, createBatch, createTasksFromFindings, diagnoseBatch, getBatch } from "./service";
import { parseJsonColumn } from "./utils";
import { createWebSearchTool, WEB_SEARCH_LIMITS } from "./web-search";

export const workbenchLogger = new StructuredLogger("workbench");
const SESSION_PROMPT_VERSION = "geo-workbench.v3";

type SessionRow = {
	id: string;
	organization_id: string;
	project_id: string;
	title: string;
	status: AgentSessionStatus;
	auto_approve: boolean;
	model: string | null;
	thinking_level: AgentThinkingLevel | null;
	web_search_enabled: boolean;
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
const modelSchema = z
	.string()
	.trim()
	.regex(/^gpt(?:-|\.)/i, "AI 工作台模型必须是 GPT 系列");

const createSessionSchema = z.object({
	title: z.string().trim().min(1).max(80).optional(),
	autoApprove: z.boolean().optional(),
	thinkingLevel: thinkingLevelSchema.optional().nullable(),
	model: modelSchema.optional().nullable(),
	webSearchEnabled: z.boolean().optional(),
	message: z.string().trim().min(1).max(4000).optional(),
});

const settingsSchema = z.object({
	autoApprove: z.boolean().optional(),
	thinkingLevel: thinkingLevelSchema.optional().nullable(),
	model: modelSchema.optional().nullable(),
	webSearchEnabled: z.boolean().optional(),
	title: z.string().trim().min(1).max(80).optional(),
});

const messageSchema = z.object({ message: z.string().trim().min(1).max(4000) });

const emptyToNull = (value: unknown) => (value === "" ? null : value);
const proposalQuestionInputSchema = z.object({
	id: z.string().optional().nullable(),
	libraryQuestionId: z.string().optional().nullable(),
	question: z.string().trim().min(4).max(500),
	intent: z.string().trim().min(1).max(120),
	topic: z.preprocess(emptyToNull, z.string().trim().min(1).max(120).optional().nullable()),
	persona: z.preprocess(emptyToNull, z.string().trim().min(1).max(120).optional().nullable()),
	tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
});
const proposalCompetitorInputSchema = z.object({
	id: z.string().optional().nullable(),
	name: z.string().trim().min(1).max(120),
	domain: z.string().trim().min(1).max(200),
	aliases: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});
const answerSchema = z.object({
	answer: z.string().trim().max(4000).optional(),
	selected: z.array(z.string().trim().min(1)).max(50).optional(),
	/** 候选问题表格确认后的最终列表；存在且非空时由服务端直接写入监测范围。 */
	questions: z.array(proposalQuestionInputSchema).max(100).optional(),
	competitors: z.array(proposalCompetitorInputSchema).max(20).optional(),
	/** 是否把新问题同步写入客户行业知识库；调用方需先确认成员有 knowledge.manage 权限。 */
	syncLibrary: z.boolean().optional(),
});

export type AnswerActor = { userId: string | null; canWriteKnowledge: boolean };

export const WORKBENCH_QUICK_COMMANDS = [
	{
		key: "questions",
		label: "帮我出监测问题",
		message: "我不确定该监测哪些问题。请联网研究这个行业的买家会怎样向 AI 搜索提问，给我出一批监测问题候选并和我确认。",
	},
	{ key: "baseline", label: "跑正式基线", message: "为当前客户跑一次正式基线，并生成报告与优化文章。" },
	{ key: "quick_audit", label: "跑售前快审", message: "为当前客户跑一次售前快审，并生成报告。" },
	{ key: "report", label: "生成报告", message: "基于最近一个已完成批次生成报告，并同步生成优化文章。" },
	{ key: "audit", label: "官网审计", message: "重新审计当前客户官网的 AI 可读性并总结阻断项。" },
	{ key: "articles", label: "生成优化文章", message: "基于最近一份已批准报告的 GEO 建议逐条生成优化文章。" },
] as const;

export type WorkbenchQuickCommand = (typeof WORKBENCH_QUICK_COMMANDS)[number];

/** 问题不足或项目未启用时“帮我出监测问题”置顶，已有成熟问题集的活跃项目把它排到最后。 */
export function orderQuickCommands(project: { status: string; approvedPromptCount: number }): WorkbenchQuickCommand[] {
	const questions = WORKBENCH_QUICK_COMMANDS.filter((command) => command.key === "questions");
	const rest = WORKBENCH_QUICK_COMMANDS.filter((command) => command.key !== "questions");
	const needsQuestions = project.status !== "active" || project.approvedPromptCount < 5;
	return needsQuestions ? [...questions, ...rest] : [...rest, ...questions];
}

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
	const model = data.model ?? config.model;
	if (!config.configured || !model) throw new Error("请先在平台设置中配置 HRouter API Key 与 GPT 模型");
	const id = randomUUID();
	const title = data.title ?? (data.message ? data.message.slice(0, 40) : `${project.name} · 新会话`);
	await database.query(
		`INSERT INTO agent_sessions (id,organization_id,project_id,title,status,auto_approve,model,thinking_level,web_search_enabled,created_by)
		 VALUES ($1,$2,$3,$4,'idle',$5,$6,$7,$8,$9)`,
		[
			id,
			project.organization_id,
			projectId,
			title,
			data.autoApprove ?? true,
			model,
			data.thinkingLevel ?? null,
			data.webSearchEnabled ?? true,
			createdBy,
		],
	);
	await appendEvent(database, id, "session_created", {
		title,
		autoApprove: data.autoApprove ?? true,
		model,
		webSearchEnabled: data.webSearchEnabled ?? true,
	});
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
			`SELECT id,title,status,auto_approve,model,thinking_level,web_search_enabled,plan,waiting,current_batch_id,error_message,
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
		 title=COALESCE($5,title),
		 model=CASE WHEN $6::boolean THEN $7 ELSE model END,
		 web_search_enabled=COALESCE($8,web_search_enabled),
		 updated_at=now() WHERE id=$1`,
		[
			sessionId,
			data.autoApprove ?? null,
			data.thinkingLevel !== undefined,
			data.thinkingLevel ?? null,
			data.title ?? null,
			// 传 null 表示恢复为机构默认模型；执行时再回退到平台设置。
			data.model !== undefined,
			data.model ?? null,
			data.webSearchEnabled ?? null,
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

type ProposalAnswer = z.infer<typeof answerSchema>;

/**
 * 成员在候选问题表格里确认后，由服务端直接写入监测范围（新版本范围；未建档项目随之启用），
 * 不再依赖模型把编辑结果原样抄回 apply_scope。竞品：表格里有就用表格的，否则沿用已批准竞品。
 */
async function applyScopeProposal(
	database: Database,
	session: WorkbenchSession,
	proposal: ScopeProposal,
	data: ProposalAnswer & { questions: NonNullable<ProposalAnswer["questions"]> },
	actor: AnswerActor,
): Promise<{ promptCount: number; competitorCount: number; libraryAdded: number; libraryLinked: number }> {
	const projectId = session.project_id;
	const [project, approvedCompetitors] = await Promise.all([
		database.query<{ aliases: unknown; name: string }>("SELECT aliases,name FROM projects WHERE id=$1", [projectId]),
		database.query<{ id: string; name: string; domain: string; aliases: unknown }>(
			"SELECT id,name,domain,aliases FROM competitors WHERE project_id=$1 AND approved=true AND archived_at IS NULL",
			[projectId],
		),
	]);
	const aliases = parseJsonColumn<string[]>((project.rows[0]?.aliases ?? []) as string | string[]);
	const competitors =
		data.competitors ??
		(proposal.competitors.length
			? proposal.competitors
					.filter((item) => item.selected)
					.map((item) => ({ id: item.id ?? undefined, name: item.name, domain: item.domain, aliases: item.aliases }))
			: approvedCompetitors.rows.map((row) => ({
					id: row.id,
					name: row.name,
					domain: row.domain,
					aliases: parseJsonColumn<string[]>(row.aliases as string | string[]),
				})));
	const result = await confirmProject(
		database,
		projectId,
		{
			aliases: aliases.length ? aliases : [project.rows[0]?.name ?? ""].filter(Boolean),
			competitors: competitors.map((item) => ({ ...item, id: item.id ?? undefined })),
			prompts: data.questions.map((item) => ({
				libraryQuestionId: item.libraryQuestionId ?? null,
				question: item.question,
				intent: item.intent,
				topic: item.topic ?? null,
				persona: item.persona ?? null,
				tags: item.tags,
			})),
		},
		{
			syncLibrary:
				data.syncLibrary && actor.canWriteKnowledge && proposal.industry
					? { organizationId: session.organization_id, createdBy: actor.userId }
					: null,
		},
	);
	const detail = `${result.promptCount} 个问题${result.libraryAdded ? ` · 知识库新增 ${result.libraryAdded}` : ""}`;
	await database.query("UPDATE agent_sessions SET plan=$2::jsonb,updated_at=now() WHERE id=$1", [
		session.id,
		JSON.stringify(planUpsert(session.plan, { key: "scope", label: "确认监测问题", status: "done", detail })),
	]);
	await appendEvent(database, session.id, "step", { key: "scope", status: "done", detail });
	return result;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 普通问答与候选问题确认共用一个入口，确认分支还要区分采用/不采用两种结果。
export async function answerQuestion(
	database: Database,
	sessionId: string,
	input: unknown,
	actor: AnswerActor = { userId: null, canWriteKnowledge: false },
): Promise<{ queued: true; applied?: boolean; promptCount?: number; libraryAdded?: number }> {
	const data = answerSchema.parse(input);
	const session = await loadSession(database, sessionId);
	if (session.status !== "waiting_user" || session.waiting?.kind !== "user") throw new Error("当前没有待回答的问题");
	const proposal = session.waiting.proposal ?? null;
	if (proposal && data.questions?.length) {
		const applied = await applyScopeProposal(
			database,
			session,
			proposal,
			{ ...data, questions: data.questions },
			actor,
		);
		const text = `已确认 ${applied.promptCount} 个监测问题并写入范围${applied.competitorCount ? `，竞品 ${applied.competitorCount} 个` : ""}${applied.libraryAdded ? `，${applied.libraryAdded} 个新问题已同步到行业知识库` : ""}${data.answer ? `。补充：${data.answer}` : ""}`;
		await database.query("UPDATE agent_sessions SET status='running',updated_at=now() WHERE id=$1", [sessionId]);
		await appendEvent(database, sessionId, "user_answer", {
			text,
			selected: [],
			applied: true,
			promptCount: applied.promptCount,
			competitorCount: applied.competitorCount,
			libraryAdded: applied.libraryAdded,
		});
		await enqueueTurn(database, {
			sessionId,
			trigger: "answer",
			message: JSON.stringify({
				applied: true,
				promptCount: applied.promptCount,
				competitorCount: applied.competitorCount,
				libraryAdded: applied.libraryAdded,
				answer: data.answer ?? "",
				note: "监测范围已由系统写入，不需要再调用任何工具写入问题；继续后续步骤或 finish。",
			}),
		});
		return { queued: true, applied: true, promptCount: applied.promptCount, libraryAdded: applied.libraryAdded };
	}
	if (proposal) {
		if (!data.answer) throw new Error("请确认候选问题，或说明为什么不采用以便 Agent 调整");
		await database.query("UPDATE agent_sessions SET status='running',updated_at=now() WHERE id=$1", [sessionId]);
		await appendEvent(database, sessionId, "user_answer", {
			text: `未采用候选：${data.answer}`,
			selected: [],
			applied: false,
		});
		await enqueueTurn(database, {
			sessionId,
			trigger: "answer",
			message: JSON.stringify({
				applied: false,
				answer: data.answer,
				note: "用户没有采用这批候选，监测范围未改变；根据反馈调整后可再次 propose_questions。",
			}),
		});
		return { queued: true, applied: false };
	}
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

const reportStateLabels: Record<string, string> = {
	narrative_queued: "叙述排队中",
	narrative_running: "叙述生成中",
	narrative_approval: "叙述待审批",
	quality_queued: "质检排队中",
	quality_running: "质检进行中",
	quality_approval: "质检待审批",
	quality_blocked: "质检未通过",
	documents_queued: "正在生成 PDF/Word",
	ready: "PDF/Word 已生成",
};

function planUpsert(plan: AgentSessionPlanStep[], step: AgentSessionPlanStep): AgentSessionPlanStep[] {
	const index = plan.findIndex((item) => item.key === step.key);
	if (index === -1) return [...plan, step];
	const next = [...plan];
	next[index] = { ...next[index], ...step };
	return next;
}

/** 只更新已存在的步骤；步骤不存在时原样返回，避免为历史会话凭空补步骤。 */
function planPatch(
	plan: AgentSessionPlanStep[],
	key: string,
	patch: Pick<AgentSessionPlanStep, "status"> & { detail?: string | null },
): AgentSessionPlanStep[] {
	if (!plan.some((step) => step.key === key)) return plan;
	return plan.map((step) =>
		step.key === key
			? { ...step, status: patch.status, ...(patch.detail !== undefined ? { detail: patch.detail } : {}) }
			: step,
	);
}

type WaitTarget = Exclude<AgentSessionWaiting, { kind: "user" }>;

/** 报告叙述/质检/PDF 的等待都归入 advance_report 维护的 report 步骤，不再各自生成一条“等待…”。 */
const REPORT_WORKFLOW_PURPOSES = new Set(["report_narrative", "quality_review"]);

/** 等待对象对应的计划步骤 key；旧会话的 waiting 没有 stepKey 时按原规则推导。 */
function waitStepKey(waiting: WaitTarget): string {
	if (waiting.stepKey) return waiting.stepKey;
	return waiting.kind === "batch" ? "batch" : waiting.kind === "report" ? "report_document" : `run:${waiting.id}`;
}

const platformsSchema = Type.Array(Type.Union(searchProviderIds.map((id) => Type.Literal(id))), {
	minItems: 1,
	description: "监测平台 ID 列表",
});

const proposalQuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "保留已有问题时带上其 id" })),
	libraryQuestionId: Type.Optional(Type.String({ description: "来自知识库候选时带上其 id" })),
	question: Type.String({ minLength: 4, maxLength: 500 }),
	intent: Type.String({ minLength: 1, maxLength: 120 }),
	topic: Type.Optional(Type.String({ maxLength: 120 })),
	persona: Type.Optional(Type.String({ maxLength: 120 })),
	tags: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 30 }),
	source: Type.Union(
		[Type.Literal("existing"), Type.Literal("pending"), Type.Literal("library"), Type.Literal("research")],
		{ description: "existing=已批准问题；pending=建档候选；library=知识库候选；research=本次研究新增" },
	),
	evidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 10, description: "支撑该问题的证据 ID" })),
	selected: Type.Optional(Type.Boolean({ description: "默认勾选；不建议纳入但值得让用户看到的设为 false" })),
});

const proposalCompetitorSchema = Type.Object({
	id: Type.Optional(Type.String()),
	name: Type.String({ minLength: 1, maxLength: 120 }),
	domain: Type.String({ minLength: 1, maxLength: 200 }),
	aliases: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 20 }),
	selected: Type.Optional(Type.Boolean()),
});

/** 会话级联网次数从证据表统计，跨回合、跨进程重启都不会漏算。 */
async function countSessionSearches(database: Database, sessionId: string): Promise<number> {
	return Number(
		(
			await database.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM web_search_evidence WHERE session_id=$1",
				[sessionId],
			)
		).rows[0]?.count ?? 0,
	);
}

/** 把候选引用的证据翻译成表格可读的条目（联网搜索→问题与来源数，快照→标题/网址），前端不必再查索引。 */
async function describeProposalEvidence(
	database: Database,
	projectId: string,
	evidenceIds: string[],
): Promise<EvidenceIndexEntry[]> {
	if (!evidenceIds.length) return [];
	const [webSearches, snapshots] = await Promise.all([
		database.query<{ id: string; query: string; sources: unknown; created_at: string }>(
			"SELECT id,query,sources,created_at FROM web_search_evidence WHERE project_id=$1 AND id=ANY($2::text[])",
			[projectId, evidenceIds],
		),
		database.query<{ id: string; url: string; title: string | null }>(
			"SELECT id,url,title FROM website_snapshots WHERE project_id=$1 AND id=ANY($2::text[])",
			[projectId, evidenceIds],
		),
	]);
	const blank = { n: 0, platform: null, attempt: null, status: null, url: null, title: null };
	return [
		...webSearches.rows.map((row) => ({
			...blank,
			id: row.id,
			kind: "web_search" as const,
			platformLabel: "联网搜索",
			question: row.query,
			capturedAt: new Date(String(row.created_at)).toISOString(),
			sourceUrls: parseJsonColumn<Array<{ url: string }>>(row.sources as string | Array<{ url: string }>)
				.map((source) => source.url)
				.slice(0, 12),
		})),
		...snapshots.rows.map((row) => ({
			...blank,
			id: row.id,
			kind: "snapshot" as const,
			platformLabel: "客户官网快照",
			question: null,
			capturedAt: null,
			sourceUrls: [],
			url: row.url,
			title: row.title,
		})),
	];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The workbench tool set intentionally lives in one auditable function so every write path is visible together.
export async function createWorkbenchTools(
	database: Database,
	session: WorkbenchSession,
	control: TurnControl,
	persistControl: () => Promise<void>,
	emit: (type: string, payload: Record<string, unknown>) => Promise<void>,
	dependencies: { fetch?: typeof globalThis.fetch; sessionSearches?: number } = {},
): Promise<AgentTool[]> {
	const projectId = session.project_id;
	const organizationId = session.organization_id;
	const allowedEvidence = await knownEvidenceIds(database, projectId, session.current_batch_id);
	const sessionSearches = dependencies.sessionSearches ?? (await countSessionSearches(database, session.id));
	const waitFor = async (waiting: WaitTarget, stepKey: string, label: string) => {
		control.waiting = { ...waiting, stepKey };
		const existing = control.plan.find((step) => step.key === stepKey);
		control.plan = planUpsert(control.plan, {
			key: stepKey,
			label: existing?.label ?? label,
			status: "running",
			ref: waiting.id,
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
		...(session.web_search_enabled
			? [
					createWebSearchTool(
						database,
						{ organizationId, projectId, sessionId: session.id, model: session.model },
						allowedEvidence,
						{
							fetch: dependencies.fetch,
							budget: {
								perTurn: WEB_SEARCH_LIMITS.workbenchTurn,
								perSession: WEB_SEARCH_LIMITS.workbenchSession,
								sessionUsed: sessionSearches,
							},
						},
					),
				]
			: []),
		{
			name: "suggest_questions",
			label: "整理问题候选",
			description:
				"返回当前已批准监测问题、建档分析留下但尚未确认的候选，以及同机构同行业知识库中尚未纳入的问题候选。用于出题或跑基线前与用户确认要使用或追加的问题。",
			parameters: Type.Object({}),
			execute: async () => {
				const project = (
					await database.query<{ industry: string | null; status: string }>(
						"SELECT industry,status FROM projects WHERE id=$1",
						[projectId],
					)
				).rows[0];
				// 未建档确认的项目：官网分析留下的竞品候选也一并交给用户确认，apply_scope 时可显式传入。
				const pendingCompetitors =
					project?.status === "active"
						? []
						: (
								await database.query(
									"SELECT id,name,domain,aliases FROM competitors WHERE project_id=$1 AND approved=false AND archived_at IS NULL",
									[projectId],
								)
							).rows;
				const rows = (
					await database.query<Record<string, unknown> & { approved: boolean }>(
						"SELECT id,question,intent,topic,persona,tags,library_question_id,approved FROM prompts WHERE project_id=$1 AND archived_at IS NULL ORDER BY position",
						[projectId],
					)
				).rows;
				const current = rows.filter((row) => row.approved);
				const pendingCandidates = rows.filter((row) => !row.approved);
				const usedLibraryIds = new Set(rows.map((row) => row.library_question_id).filter(Boolean));
				const usedQuestions = new Set(rows.map((row) => String(row.question)));
				const library = await listLibraryQuestions(database, organizationId, project?.industry ?? null, {
					page: 1,
					pageSize: 100,
					offset: 0,
					search: null,
				});
				const candidates = library.items.filter(
					(item) => !usedLibraryIds.has(item.id) && !usedQuestions.has(String(item.question)),
				);
				return toolResult({
					current,
					pendingCandidates,
					libraryCandidates: candidates,
					pendingCompetitors,
					projectStatus: project?.status ?? null,
					industry: project?.industry ?? null,
				});
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
			name: "propose_questions",
			label: "提交问题候选",
			description:
				"把最终候选问题（包含要保留的已有问题）交给用户在表格里勾选、修改、增删并确认。确认后系统会直接写入新版本监测范围（未建档项目随之启用），你不需要也不能再调用其他工具写入问题。调用后本回合结束，用户确认或拒绝后你会收到结果。未建档项目请把 suggest_questions 返回的候选竞品也放进 competitors 让用户一并确认。",
			parameters: Type.Object({
				intro: Type.String({
					minLength: 4,
					maxLength: 2000,
					description: "给用户的说明：研究依据、按意图怎么分组、建议保留/新增了什么（可引用证据 ID）",
				}),
				questions: Type.Array(proposalQuestionSchema, { minItems: 1, maxItems: 100 }),
				competitors: Type.Optional(Type.Array(proposalCompetitorSchema, { maxItems: 20 })),
			}),
			executionMode: "sequential",
			execute: async (toolCallId, params) => {
				const input = params as {
					intro: string;
					questions: Array<{
						id?: string;
						libraryQuestionId?: string;
						question: string;
						intent: string;
						topic?: string;
						persona?: string;
						tags: string[];
						source: ScopeProposalQuestion["source"];
						evidenceIds?: string[];
						selected?: boolean;
					}>;
					competitors?: Array<{ id?: string; name: string; domain: string; aliases: string[]; selected?: boolean }>;
				};
				const [project, promptRows, libraryRows] = await Promise.all([
					database.query<{ industry: string | null }>("SELECT industry FROM projects WHERE id=$1", [projectId]),
					database.query<{ id: string }>("SELECT id FROM prompts WHERE project_id=$1 AND archived_at IS NULL", [
						projectId,
					]),
					database.query<{ id: string }>(
						"SELECT id FROM prompt_library_questions WHERE organization_id=$1 AND archived_at IS NULL",
						[organizationId],
					),
				]);
				const knownPromptIds = new Set(promptRows.rows.map((row) => row.id));
				const knownLibraryIds = new Set(libraryRows.rows.map((row) => row.id));
				const unknownEvidence = input.questions.flatMap((item) =>
					(item.evidenceIds ?? []).filter((id) => !allowedEvidence.has(id)),
				);
				if (unknownEvidence.length)
					throw new Error(`候选引用了未知或越权证据：${[...new Set(unknownEvidence)].join("、")}`);
				const unknownPrompts = input.questions.flatMap((item) =>
					item.id && !knownPromptIds.has(item.id) ? [item.id] : [],
				);
				if (unknownPrompts.length) throw new Error(`候选引用了不存在的问题 id：${unknownPrompts.join("、")}`);
				const unknownLibrary = input.questions.flatMap((item) =>
					item.libraryQuestionId && !knownLibraryIds.has(item.libraryQuestionId) ? [item.libraryQuestionId] : [],
				);
				if (unknownLibrary.length) throw new Error(`候选引用了不存在的知识库问题：${unknownLibrary.join("、")}`);
				const seen = new Set<string>();
				const questions: ScopeProposalQuestion[] = [];
				for (const item of input.questions) {
					const normalized = item.question.trim().toLocaleLowerCase();
					if (seen.has(normalized)) continue;
					seen.add(normalized);
					questions.push({
						key: `q${questions.length + 1}`,
						id: item.id ?? null,
						libraryQuestionId: item.libraryQuestionId ?? null,
						question: item.question.trim(),
						intent: item.intent.trim(),
						topic: item.topic?.trim() || null,
						persona: item.persona?.trim() || null,
						tags: [...new Set(item.tags.map((tag) => tag.trim()).filter(Boolean))],
						source: item.source,
						evidenceIds: [...new Set(item.evidenceIds ?? [])],
						selected: item.selected ?? true,
					});
				}
				const competitors: ScopeProposalCompetitor[] = (input.competitors ?? []).map((item, index) => ({
					key: `c${index + 1}`,
					id: item.id ?? null,
					name: item.name.trim(),
					domain: item.domain.trim(),
					aliases: [...new Set(item.aliases.map((alias) => alias.trim()).filter(Boolean))],
					selected: item.selected ?? true,
				}));
				const proposal: ScopeProposal = {
					intro: input.intro,
					questions,
					competitors,
					industry: project.rows[0]?.industry ?? null,
				};
				const evidence = await describeProposalEvidence(database, projectId, [
					...new Set(questions.flatMap((item) => item.evidenceIds)),
				]);
				control.waiting = {
					kind: "user",
					question: input.intro,
					options: [],
					multiple: true,
					toolCallId,
					proposal,
				};
				control.plan = planUpsert(control.plan, {
					key: "scope",
					label: "确认监测问题",
					status: "running",
					detail: `${questions.length} 个候选待确认`,
				});
				await persistControl();
				await emit("proposal", { ...proposal, evidence });
				return {
					...toolResult({ waiting: "user", proposal: true, questionCount: questions.length }),
					terminate: true,
				};
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
				let stepKey = kind === "batch" ? "batch" : kind === "report" ? "report" : `run:${id}`;
				if (kind === "batch") {
					const batch = await ensureBatch(id);
					if (["complete", "partial"].includes(String(batch.status)))
						return toolResult({ alreadyDone: true, status: batch.status });
				}
				if (kind === "agent_run") {
					const run = (
						await database.query<{ status: string; project_id: string; purpose: string }>(
							"SELECT status,project_id,purpose FROM agent_runs WHERE id=$1",
							[id],
						)
					).rows[0];
					if (!run || run.project_id !== projectId) throw new Error("Agent 运行不存在或不属于当前客户");
					if (["approved", "rejected", "failed"].includes(run.status))
						return toolResult({ alreadyDone: true, status: run.status });
					if (REPORT_WORKFLOW_PURPOSES.has(run.purpose)) stepKey = "report";
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
				"推进批次的报告工作流：自动排队报告叙述 → 质检 → 冻结快照 → PDF/Word。返回当前 state 与 runId/reportId；若 state 不是 ready，用 wait_for 等待对应对象（narrative_*/quality_* 用 agent_run，documents_queued 用 report）。质检未通过（quality_blocked）后再次调用会重新生成叙述并重新质检，属于额外开销，先用 ask_user 征得用户同意。",
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
					detail: reportStateLabels[result.state] ?? result.state,
				});
				await persistControl();
				await emit("step", {
					key: "report",
					status: control.plan.find((s) => s.key === "report")?.status,
					detail: reportStateLabels[result.state] ?? result.state,
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
				const status = result.queued.length ? "running" : "done";
				control.plan = planUpsert(control.plan, {
					key: "articles",
					label: "优化文章",
					status,
					ref: batchId,
					detail: `${result.queued.length} 篇排队`,
				});
				await persistControl();
				await emit("step", { key: "articles", status, detail: `${result.queued.length} 篇排队` });
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

监测问题的唯一写入方式是 propose_questions：把最终列表（含要保留的已有问题）交给用户在表格里勾选、修改后确认，系统会在用户确认后自动写入范围；你不能、也不需要自己写入。不要用 ask_user 罗列问题让用户选。

标准流程（用户说"跑基线/跑快审"时）：
1. read_project_context 了解客户、问题、平台与最近批次。
2. suggest_questions。已有问题不足 5 个时按下面的出题流程补齐；否则用 propose_questions 提交“现有问题 + 值得追加的知识库候选”让用户确认（全部沿用时用户直接点确认即可）。收到 applied=true 后再继续。
3. create_batch，然后 wait_for(batch)。正式基线会分三个时间窗口采集，等待可能长达一天，这是正常的。
4. 采集完成后 verify_batch 写一段核验小结（失败平台、来源不可见、异常样本）。
5. run_site_audit 与 run_rule_diagnosis。
6. advance_report 推进报告；每次返回 state 非 ready 时 wait_for 对应对象，被唤醒后再次 advance_report，直到 ready。质检 blocked 时用 ask_user 询问用户是否重新生成叙述（再次 advance_report）或结束。
7. generate_articles，并告知用户文章数量与查看位置。
8. finish 给出总结。

出题流程（用户说"帮我出监测问题/不知道该问什么"，或跑基线时现有问题不足 5 个）：
1. read_project_context 与 suggest_questions，了解客户业务、地区、已有问题、建档候选与知识库候选。
2. 若本会话开放 web_search：做 3-6 次有针对性的联网研究，每次一个具体问题，覆盖：该行业买家在选型/采购时会问 AI 的问题、常见对比与价格/资质/售后疑虑、客户所在地区或场景的问法、竞品被推荐的语境。搜索结果只能作为证据，不得直接照抄网页里的问题。工具返回 unavailable=true 或提示达到上限时立即停止搜索，改用官网快照与知识库候选。
3. 汇总出 10-30 个候选问题：用买家真实口吻写中文提问，不出现客户品牌名（除非是品牌口碑题），每题标注 intent（如 选型对比/价格/资质/售后/口碑/本地服务）、topic、persona、tags 与 source，并按意图排列。已有问题与候选重复的要合并；每题尽量带上支撑它的证据 ID。
4. 用 propose_questions 提交：intro 里说明研究依据与分组逻辑（引用证据 ID）；未建档项目把候选竞品放进 competitors。
5. 收到 applied=true 表示范围已写入，向用户简要总结并 finish（或按用户指令继续跑基线）；applied=false 表示用户未采用，按其反馈调整后再次 propose_questions。
6. 联网不可用时如实告诉用户，并在总结中写明“候选基于官网快照与知识库，未经联网研究”的局限。

其他指令（只生成报告、只审计、只生成文章等）按需选取上述子集。每完成一步用一两句中文向用户汇报进展。不要重复读取已经读过的证据。${AGENT_SAFETY_PROMPT}`;

/** 会话级联网状态与配额写进系统提示，模型不用试错就知道能不能搜、能搜几次。 */
function webSearchPromptNote(session: WorkbenchSession, sessionUsed: number): string {
	if (!session.web_search_enabled)
		return "\n\n本会话已关闭联网搜索：没有 web_search 工具，出题直接用官网快照与知识库候选，并向用户说明未经联网研究。";
	const remaining = Math.max(0, WEB_SEARCH_LIMITS.workbenchSession - sessionUsed);
	return `\n\n联网搜索配额：每回合最多 ${WEB_SEARCH_LIMITS.workbenchTurn} 次，本会话还剩 ${remaining} 次（上限 ${WEB_SEARCH_LIMITS.workbenchSession}）。每次搜索都计费，问法要具体，不要为同一问题反复换词重试。`;
}

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
	const model = session.model ?? config.model;
	if (!model || !apiKey) throw new Error("请先配置 HRouter API Key 与 GPT 模型");
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
	const sessionSearches = await countSessionSearches(database, sessionId);
	const tools = await createWorkbenchTools(database, session, control, persistControl, emit, { sessionSearches });
	const allowedToolNames = new Set(tools.map((tool) => tool.name));
	const agent = new Agent({
		initialState: {
			systemPrompt: `${WORKBENCH_SYSTEM_PROMPT}${webSearchPromptNote(session, sessionSearches)}`,
			model: createHRouterModel(model, config.baseUrl),
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
			// 用户回答作为 ask_user / propose_questions 的工具结果续接，保持对话结构完整。
			// 候选确认的结果已经是服务端生成的 JSON（applied、数量），普通回答则包成 {answer}。
			const answered: AgentMessage = {
				role: "toolResult",
				toolCallId: priorWaiting.toolCallId,
				toolName: priorWaiting.proposal ? "propose_questions" : "ask_user",
				content: [
					{ type: "text", text: priorWaiting.proposal ? (message ?? "{}") : JSON.stringify({ answer: message ?? "" }) },
				],
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
		// 只统计本回合新增的 assistant 消息：transcript 每回合都会恢复历史，按全量累加会把旧回合的 Token 重复记进费用。
		const turnAssistants = agent.state.messages
			.slice(session.transcript.length)
			.filter((item) => item.role === "assistant");
		const turnUsage = turnAssistants.reduce(
			(total, item) => ({
				input: total.input + (item.usage?.input ?? 0),
				output: total.output + (item.usage?.output ?? 0),
				totalTokens: total.totalTokens + (item.usage?.totalTokens ?? 0),
			}),
			{ input: 0, output: 0, totalTokens: 0 },
		);
		const usage = {
			input: (session.usage?.input ?? 0) + turnUsage.input,
			output: (session.usage?.output ?? 0) + turnUsage.output,
			totalTokens: (session.usage?.totalTokens ?? 0) + turnUsage.totalTokens,
		};
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
		if (turnUsage.totalTokens > 0)
			await database.query(
				`INSERT INTO project_costs (id,project_id,batch_id,provider_id,operation,usage,cost_micros)
				 VALUES ($1,$2,$3,'hrouter_gpt','workbench',$4::jsonb,NULL)`,
				[
					randomUUID(),
					session.project_id,
					control.currentBatchId,
					JSON.stringify({
						inputTokens: turnUsage.input,
						outputTokens: turnUsage.output,
						totalTokens: turnUsage.totalTokens,
					}),
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
	plan: unknown;
};

/** 等待对象到达终态后，对应计划步骤的结果；report 步骤由 advance_report 维护，这里不改。 */
type WaitOutcome = { status: "done" | "failed"; detail?: string | null };

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
			// 成员抢先手动审批时守卫会拒绝本次自动批准：这不是失败，也不能把已批准的草稿改成拒绝。
			if (error instanceof Error && error.message.includes("已被其他操作处理")) continue;
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
			"SELECT id,project_id,auto_approve,created_by,waiting,plan FROM agent_sessions WHERE status='waiting_job' AND waiting IS NOT NULL",
		)
	).rows;
	for (const session of waitingSessions) {
		const waiting = parseJsonColumn<AgentSessionWaiting>(session.waiting as string | AgentSessionWaiting);
		if (waiting.kind === "user") continue;
		const plan = parseJsonColumn<AgentSessionPlanStep[]>(session.plan as string | AgentSessionPlanStep[]);
		const stepKey = waitStepKey(waiting);
		const stepDetail = plan.find((step) => step.key === stepKey)?.detail ?? null;
		let summary: string | null = null;
		let outcome: WaitOutcome | null = null;
		if (waiting.kind === "batch") {
			const batch = (
				await database.query<{ status: string }>("SELECT status FROM experiment_batches WHERE id=$1", [waiting.id])
			).rows[0];
			if (batch && ["complete", "partial"].includes(batch.status)) {
				summary = await describeBatch(database, waiting.id);
				outcome =
					batch.status === "partial"
						? { status: "done", detail: [stepDetail, "部分平台失败，原始证据已保留"].filter(Boolean).join(" · ") }
						: { status: "done" };
			}
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
				outcome =
					run.status === "approved"
						? { status: "done" }
						: {
								status: "failed",
								detail: (run.error_message ?? (run.status === "rejected" ? "草稿已拒绝" : "运行失败")).slice(0, 120),
							};
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
			if (report?.pdf_artifact_key) {
				summary = `报告《${report.title}》PDF 已生成（报告 ID ${waiting.id}）。`;
				outcome = { status: "done", detail: "PDF/Word 已生成" };
			}
		}
		if (!summary || !outcome) continue;
		const nextPlan = stepKey === "report" ? plan : planPatch(plan, stepKey, outcome);
		await database.query("UPDATE agent_sessions SET status='running',plan=$2::jsonb,updated_at=now() WHERE id=$1", [
			session.id,
			JSON.stringify(nextPlan),
		]);
		if (nextPlan !== plan)
			await appendEvent(database, session.id, "step", {
				key: stepKey,
				status: outcome.status,
				detail: outcome.detail ?? null,
			});
		await appendEvent(database, session.id, "resumed", { kind: waiting.kind, id: waiting.id, summary });
		await enqueueTurn(database, { sessionId: session.id, trigger: "resume", message: summary });
		resumed += 1;
	}
	// 3. 文章草稿是后台物化的，会话通常在它们完成前就已结束：全部落地后再收尾“优化文章”步骤。
	const articleSessions = (
		await database.query<{ id: string; plan: unknown; pending: number; approved: number; failed: number }>(
			`SELECT s.id,s.plan,
			   count(*) FILTER (WHERE r.status IN ('queued','running','awaiting_approval'))::int AS pending,
			   count(*) FILTER (WHERE r.status='approved')::int AS approved,
			   count(*) FILTER (WHERE r.status IN ('failed','rejected'))::int AS failed
			 FROM agent_sessions s JOIN agent_runs r ON r.session_id=s.id AND r.purpose='optimization_article'
			 WHERE s.plan @> '[{"key":"articles","status":"running"}]'::jsonb
			 GROUP BY s.id,s.plan`,
		)
	).rows;
	for (const session of articleSessions) {
		if (session.pending > 0) continue;
		const outcome: WaitOutcome = {
			status: session.approved > 0 ? "done" : "failed",
			detail:
				session.failed > 0 ? `${session.approved} 篇已生成，${session.failed} 篇失败` : `${session.approved} 篇已生成`,
		};
		const plan = parseJsonColumn<AgentSessionPlanStep[]>(session.plan as string | AgentSessionPlanStep[]);
		await database.query("UPDATE agent_sessions SET plan=$2::jsonb,updated_at=now() WHERE id=$1", [
			session.id,
			JSON.stringify(planPatch(plan, "articles", outcome)),
		]);
		await appendEvent(database, session.id, "step", {
			key: "articles",
			status: outcome.status,
			detail: outcome.detail,
		});
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
