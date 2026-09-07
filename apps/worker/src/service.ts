import { randomUUID } from "node:crypto";
import {
	areBatchConfigsComparable,
	type CaptureJobPayload,
	type CompetitorVerification,
	type Database,
	enqueueCaptureJob,
	type FrozenBatchConfig,
	type SearchProviderId,
	searchProviderIds,
	type WebsiteAuditResult,
} from "@geo/core";
import { type QueryCapture, type QueryCaptureV2, queryCaptureSchema, queryCaptureV2Schema } from "@geo/evidence";
import { StructuredLogger, safeErrorMessage } from "@geo/logging";
import { ADAPTER_VERSION } from "@geo/search-providers";
import { z } from "zod";
import { captureContractCurrent } from "./capture-contract";
import { captureProgress } from "./capture-progress";
import { auditWebsite, crawlPublishedUrl, crawlWebsite } from "./crawler";
import { analyzeCustomer } from "./hrouter";
import {
	createMeasurementRun,
	currentMeasurement,
	freezeMeasurement,
	pendingMetrics,
	readPairedComparisons,
} from "./measurement";
import { type Paginated, type PaginationInput, paginated } from "./pagination";
import { optionalWebsiteSchema } from "./project-profile";
import { providerDefinitions } from "./providers";
import { buildDeterministicFindings, buildReportAnalysis, type DiagnosisWebEvidence } from "./report";
import { HttpInputError, normalizeDomain, parseJsonColumn, sha256, stableJson, tryNormalizeDomain } from "./utils";
import { verifyCompetitors } from "./web-search";

export const currentRunnerVersion = "cloud-runner.v1";
const serviceLogger = new StructuredLogger("api");

/** 建档分析最多抓取的官网页数：每页正文截断后都进入画像提示词，页数过多既拖慢建档又撑大请求。 */
export const ANALYSIS_CRAWL_LIMIT = 40;
/** 建档重试时复用多久以内的官网快照，避免模型调用失败后每次点击都重新全量抓取。 */
const ANALYSIS_SNAPSHOT_REUSE_HOURS = 24;

const projectInputSchema = z.object({
	name: z.string().trim().min(1),
	websiteUrl: optionalWebsiteSchema,
	region: z.string().trim().min(1),
	language: z.string().trim().min(1),
	businessFocus: z.string().trim().optional().nullable(),
	industry: z.string().trim().min(1).max(120).optional().nullable(),
	aliases: z.array(z.string().trim().min(1)).default([]),
	knownCompetitors: z.array(z.string().trim().min(1)).default([]),
});

export async function listProjects(
	database: Database,
	organizationId: string,
	input: PaginationInput,
	access: { allProjects: boolean; projectIds: string[] },
): Promise<Paginated<Record<string, unknown>>> {
	const search = input.search ? `%${input.search}%` : null;
	const scopeValues = access.allProjects ? [] : [...new Set(access.projectIds)];
	const scopeClause = access.allProjects
		? "true"
		: scopeValues.length
			? `p.id IN (${scopeValues.map((_, index) => `$${index + 3}`).join(",")})`
			: "false";
	const baseParams = [organizationId, search, ...scopeValues];
	const total = Number(
		(
			await database.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM projects p WHERE p.organization_id=$1
				 AND ($2::text IS NULL OR p.name ILIKE $2 OR p.domain ILIKE $2 OR p.industry ILIKE $2) AND ${scopeClause}`,
				baseParams,
			)
		).rows[0]?.count ?? 0,
	);
	const limitPosition = baseParams.length + 1;
	const result = await database.query<Record<string, unknown>>(
		`SELECT p.*, count(DISTINCT b.id)::int AS batch_count, max(b.created_at) AS last_batch_at
		 FROM projects p LEFT JOIN experiment_batches b ON b.project_id = p.id
		 WHERE p.organization_id=$1 AND ($2::text IS NULL OR p.name ILIKE $2 OR p.domain ILIKE $2 OR p.industry ILIKE $2)
		 AND ${scopeClause} GROUP BY p.id ORDER BY p.updated_at DESC LIMIT $${limitPosition} OFFSET $${limitPosition + 1}`,
		[...baseParams, input.pageSize, input.offset],
	);
	return paginated(result.rows, total, input);
}

export async function createProject(
	database: Database,
	input: unknown,
	organizationId = "default",
	createdBy: string | null = null,
): Promise<{ id: string }> {
	return database.transaction((tx) => createProjectInTransaction(tx, input, organizationId, createdBy));
}

async function createProjectInTransaction(
	database: Database,
	input: unknown,
	organizationId = "default",
	createdBy: string | null = null,
): Promise<{ id: string }> {
	const data = projectInputSchema.parse(input);
	const id = randomUUID();
	const url = data.websiteUrl ? new URL(data.websiteUrl) : null;
	await database.query(
		`INSERT INTO projects (id,organization_id,name,website_url,domain,region,language,business_focus,industry,aliases,status)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'draft')`,
		[
			id,
			organizationId,
			data.name,
			url?.href ?? null,
			url ? normalizeDomain(url.href) : null,
			data.region,
			data.language,
			data.businessFocus || null,
			data.industry || null,
			JSON.stringify([...new Set([data.name, ...data.aliases])]),
		],
	);
	await database.query(
		"INSERT INTO settings (key,value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()",
		[`project:${id}:known_competitors`, JSON.stringify(data.knownCompetitors)],
	);
	if (createdBy)
		await database.query("INSERT INTO user_project_access (user_id,project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [
			createdBy,
			id,
		]);
	return { id };
}

export async function getProject(database: Database, id: string): Promise<Record<string, unknown> | null> {
	const project = (await database.query<Record<string, unknown>>("SELECT * FROM projects WHERE id = $1", [id])).rows[0];
	if (!project) return null;
	const [competitors, prompts, batches, tasks, findings, audits, schedule, enabledProviders] = await Promise.all([
		database.query("SELECT * FROM competitors WHERE project_id = $1 AND archived_at IS NULL ORDER BY created_at", [id]),
		database.query("SELECT * FROM prompts WHERE project_id = $1 AND archived_at IS NULL ORDER BY position", [id]),
		database.query("SELECT * FROM experiment_batches WHERE project_id = $1 ORDER BY created_at DESC", [id]),
		database.query(
			`SELECT t.*,f.category AS finding_category FROM remediation_tasks t
			 LEFT JOIN diagnosis_findings f ON f.id=t.finding_id WHERE t.project_id = $1 ORDER BY t.created_at DESC`,
			[id],
		),
		database.query("SELECT * FROM diagnosis_findings WHERE project_id = $1 ORDER BY created_at DESC", [id]),
		database.query("SELECT * FROM website_audits WHERE project_id = $1 ORDER BY checked_at DESC LIMIT 10", [id]),
		database.query("SELECT * FROM monitoring_schedules WHERE project_id=$1", [id]),
		database.query<{ provider_id: string }>(
			"SELECT provider_id FROM provider_configs WHERE organization_id=$1 AND enabled=true ORDER BY provider_id",
			[project.organization_id],
		),
	]);
	return {
		...project,
		enabledPlatforms: enabledProviders.rows.map((row) => row.provider_id),
		competitors: competitors.rows,
		prompts: prompts.rows,
		batches: batches.rows,
		tasks: tasks.rows.map((row) => ({ ...row, verification_mode: taskVerificationMode(row) })),
		findings: findings.rows,
		websiteAudits: audits.rows.map((row) => ({
			...row,
			result: parseJsonColumn<WebsiteAuditResult>(row.result as WebsiteAuditResult | string),
		})),
		monitoringSchedule: schedule.rows[0] ?? null,
	};
}

export async function auditProject(
	database: Database,
	projectId: string,
): Promise<{ id: string; result: WebsiteAuditResult }> {
	const project = (
		await database.query<Record<string, unknown>>("SELECT website_url,aliases,name FROM projects WHERE id=$1", [
			projectId,
		])
	).rows[0];
	if (!project) throw new HttpInputError("客户项目不存在", 404);
	if (!project.website_url)
		throw new HttpInputError(
			"该客户暂未填写官网，官网审计不适用。可继续 AI 监测；建站后在客户信息中补充官网再审计。",
			409,
		);
	const aliases = parseJsonColumn<string[]>(project.aliases as string[] | string);
	return auditWebsite(database, projectId, String(project.website_url), [
		...new Set([String(project.name), ...aliases]),
	]);
}

type AnalysisPage = { id: string; url: string; title: string | null; text: string };

/**
 * 最近一次建档尝试留下的官网快照：只取客户域名（含子域名）下的页面，同一 URL 只取最新一份，
 * 按抓取顺序返回，供重试时直接复用。竞品页或引用页快照不会混进画像输入。
 */
async function recentProjectPages(database: Database, projectId: string, domain: string): Promise<AnalysisPage[]> {
	const rows = await database.query<{ id: string; url: string; title: string | null; content_text: string }>(
		`SELECT id,url,title,content_text FROM (
			SELECT DISTINCT ON (url) id,url,title,content_text,fetched_at FROM website_snapshots
			WHERE project_id=$1 AND (domain=$4 OR domain LIKE '%.'||$4)
			  AND fetched_at>now()-($2::text||' hours')::interval ORDER BY url,fetched_at DESC
		 ) recent ORDER BY fetched_at ASC LIMIT $3`,
		[projectId, ANALYSIS_SNAPSHOT_REUSE_HOURS, ANALYSIS_CRAWL_LIMIT, domain],
	);
	return rows.rows.map((row) => ({ id: row.id, url: row.url, title: row.title, text: row.content_text }));
}

type CompetitorCandidate = { name: string; domain: string; aliases: string[] };

/**
 * 竞品候选来自官网推断，常猜错域名或行业。核实要联网搜索加一次结构化判断，不能再串在建档请求里：
 * 候选先以 `pending` 落库，请求返回后在后台逐个核实并回写；失败或超出上限的只标“未核实”，不阻断建档。
 */
async function verifyCompetitorsInBackground(
	database: Database,
	input: {
		organizationId: string;
		projectId: string;
		industry: string | null;
		businessSummary: string;
		competitors: CompetitorCandidate[];
	},
): Promise<void> {
	const settlePending = async (note: string) => {
		await database.query(
			`UPDATE competitors SET verification=jsonb_build_object('status','unverified','note',$2::text,'evidenceId',NULL,'checkedAt',$3::text)
			 WHERE project_id=$1 AND archived_at IS NULL AND verification->>'status'='pending'`,
			[input.projectId, note, new Date().toISOString()],
		);
	};
	try {
		const verification = await verifyCompetitors(database, input);
		for (const [domain, verdict] of verification.results)
			await database.query(
				`UPDATE competitors SET verification=$3::jsonb
				 WHERE project_id=$1 AND domain=$2 AND archived_at IS NULL AND verification->>'status'='pending'`,
				[input.projectId, domain, JSON.stringify(verdict)],
			);
		await settlePending("未纳入本次联网核实（超出单次核实数量上限）");
	} catch (error) {
		await settlePending(`联网核实失败：${error instanceof Error ? error.message.slice(0, 200) : "未知错误"}`).catch(
			() => undefined,
		);
		serviceLogger.error("project.competitor_verification_failed", safeErrorMessage(error), {
			organizationId: input.organizationId,
			projectId: input.projectId,
		});
	}
}

export async function analyzeProject(database: Database, id: string): Promise<Record<string, unknown>> {
	const project = (await database.query<Record<string, unknown>>("SELECT * FROM projects WHERE id = $1", [id])).rows[0];
	if (!project) throw new HttpInputError("客户项目不存在", 404);
	if (project.status === "active") throw new Error("运行中的项目请在项目总览更新监测范围，旧证据不会被覆盖");
	const knownSetting = (
		await database.query<{ value: string[] | string }>("SELECT value FROM settings WHERE key = $1", [
			`project:${id}:known_competitors`,
		])
	).rows[0];
	const customerDomain = project.domain ? normalizeDomain(String(project.domain)) : "";
	const reusedPages = customerDomain ? await recentProjectPages(database, id, customerDomain) : [];
	const pages = reusedPages.length
		? reusedPages
		: project.website_url
			? await crawlWebsite(database, id, String(project.website_url), ANALYSIS_CRAWL_LIMIT)
			: [];
	const analysis = await analyzeCustomer(database, {
		organizationId: String(project.organization_id),
		name: String(project.name),
		websiteUrl: project.website_url ? String(project.website_url) : null,
		region: String(project.region),
		language: String(project.language),
		businessFocus: project.business_focus ? String(project.business_focus) : null,
		knownCompetitors: knownSetting ? parseJsonColumn<string[]>(knownSetting.value) : [],
		pages,
	});
	// 模型给的候选可能带无效域名、客户自己的域名或重复域名；这些写库会撞唯一索引，先在这里过滤掉。
	const seenDomains = new Set<string>();
	const normalizedCompetitors: CompetitorCandidate[] = analysis.competitors.flatMap((competitor) => {
		const domain = tryNormalizeDomain(competitor.domain);
		if (!domain || domain === customerDomain || seenDomains.has(domain)) return [];
		seenDomains.add(domain);
		return [{ ...competitor, domain }];
	});
	const pendingVerification: CompetitorVerification = {
		status: "pending",
		note: "联网核实进行中",
		evidenceId: null,
		checkedAt: new Date().toISOString(),
	};
	const libraryQuestions = project.industry
		? (
				await database.query<Record<string, unknown>>(
					`SELECT id,question,intent,topic,persona,tags FROM prompt_library_questions
					 WHERE organization_id=$1 AND archived_at IS NULL AND lower(industry)=lower($2) ORDER BY created_at`,
					[project.organization_id, project.industry],
				)
			).rows
		: [];
	const normalizedQuestions = new Set<string>();
	const proposedPrompts = [
		...libraryQuestions.map((prompt) => ({
			libraryQuestionId: String(prompt.id),
			question: String(prompt.question),
			intent: String(prompt.intent),
			topic: prompt.topic ? String(prompt.topic) : null,
			persona: prompt.persona ? String(prompt.persona) : null,
			tags: parseJsonColumn<string[]>(prompt.tags as string | string[]),
		})),
		...analysis.prompts.map((prompt) => ({ ...prompt, libraryQuestionId: null })),
	]
		.filter((prompt) => {
			const normalized = prompt.question.trim().toLocaleLowerCase();
			if (normalizedQuestions.has(normalized)) return false;
			normalizedQuestions.add(normalized);
			return true;
		})
		.slice(0, 100);
	await database.transaction(async (transaction) => {
		await transaction.query("DELETE FROM competitors WHERE project_id = $1", [id]);
		await transaction.query("DELETE FROM prompts WHERE project_id = $1", [id]);
		for (const competitor of normalizedCompetitors) {
			await transaction.query(
				"INSERT INTO competitors (id,project_id,name,domain,aliases,approved,verification) VALUES ($1,$2,$3,$4,$5::jsonb,false,$6::jsonb)",
				[
					randomUUID(),
					id,
					competitor.name,
					competitor.domain,
					JSON.stringify(competitor.aliases),
					JSON.stringify(pendingVerification),
				],
			);
		}
		for (const [position, prompt] of proposedPrompts.entries()) {
			await transaction.query(
				`INSERT INTO prompts (id,project_id,library_question_id,question,intent,topic,persona,tags,approved,position)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,false,$9)`,
				[
					randomUUID(),
					id,
					prompt.libraryQuestionId,
					prompt.question,
					prompt.intent,
					prompt.topic,
					prompt.persona,
					JSON.stringify(prompt.tags),
					position,
				],
			);
		}
		await transaction.query(
			"UPDATE projects SET profile = $2::jsonb, status = 'review', updated_at = now() WHERE id = $1",
			[id, JSON.stringify(analysis.profile)],
		);
	});
	if (normalizedCompetitors.length)
		void verifyCompetitorsInBackground(database, {
			organizationId: String(project.organization_id),
			projectId: id,
			industry: project.industry ? String(project.industry) : null,
			businessSummary: analysis.profile.businessSummary,
			competitors: normalizedCompetitors,
		});
	return {
		...analysis,
		competitors: normalizedCompetitors.map((competitor) => ({ ...competitor, verification: pendingVerification })),
		prompts: proposedPrompts,
		libraryQuestionCount: libraryQuestions.length,
		crawledPages: pages.length,
		reusedSnapshots: reusedPages.length > 0,
		competitorVerification: {
			status: normalizedCompetitors.length ? "pending" : "none",
			candidates: normalizedCompetitors.length,
		},
	};
}

/**
 * 后台联网出题前保证项目至少有一批官网快照：草稿必须引用真实证据 ID，没抓过官网的项目会没有可引用的本地证据。
 * 已有快照时不重复抓取。
 */
export async function ensureProjectSnapshots(database: Database, projectId: string, limit = 30): Promise<number> {
	const existing = (
		await database.query<{ count: number }>(
			"SELECT count(*)::int AS count FROM website_snapshots WHERE project_id=$1",
			[projectId],
		)
	).rows[0];
	if (existing && Number(existing.count) > 0) return Number(existing.count);
	const project = (
		await database.query<{ website_url: string }>("SELECT website_url FROM projects WHERE id=$1", [projectId])
	).rows[0];
	if (!project) throw new HttpInputError("客户项目不存在", 404);
	if (!project.website_url) return 0;
	const pages = await crawlWebsite(database, projectId, project.website_url, limit);
	return pages.length;
}

const reviewSchema = z.object({
	aliases: z.array(z.string().trim().min(1)),
	competitors: z
		.array(
			z.object({
				id: z.string().optional(),
				name: z.string().trim().min(1),
				domain: z.string().trim().min(1),
				aliases: z.array(z.string().trim().min(1)).default([]),
			}),
		)
		.max(20),
	prompts: z
		.array(
			z.object({
				id: z.string().optional(),
				libraryQuestionId: z.string().optional().nullable(),
				library_question_id: z.string().optional().nullable(),
				question: z.string().trim().min(4),
				intent: z.string().trim().min(1),
				topic: z.preprocess((value) => (value === "" ? null : value), z.string().trim().min(1).optional().nullable()),
				persona: z.preprocess((value) => (value === "" ? null : value), z.string().trim().min(1).optional().nullable()),
				tags: z.array(z.string().trim().min(1)).default([]),
			}),
		)
		.min(1)
		.max(100),
});

export type ConfirmProjectOptions = {
	/**
	 * 把本次确认的新问题（没有知识库引用的）同步写入客户行业的知识库并回填引用；
	 * 只有成员明确勾选且有 knowledge.manage 权限时由调用方传入。项目没有 industry 时不写。
	 */
	syncLibrary?: { organizationId: string; createdBy: string | null } | null;
};

export type ConfirmProjectResult = {
	promptCount: number;
	competitorCount: number;
	/** 新写入知识库的问题数；未开启同步或客户没有行业时为 0。 */
	libraryAdded: number;
	/** 已存在于知识库、只回填了引用的问题数。 */
	libraryLinked: number;
	/** 引用了其他机构或已归档知识库记录、本次被去掉引用的问题数（多见于跨机构导入范围包）。 */
	libraryUnlinked: number;
	/** 沿用上一版本 ID 的问题数：零修改保存时等于 promptCount，后续批次因此与历史可比。 */
	promptsKept: number;
	competitorsKept: number;
};

const LIBRARY_QUESTION_MAX = 500;

type LibrarySync = { organizationId: string; createdBy: string | null; industry: string };
type ScopePrompt = z.infer<typeof reviewSchema>["prompts"][number];
type ScopeCompetitor = z.infer<typeof reviewSchema>["competitors"][number];

const normalizeQuestion = (question: string): string => question.trim().toLocaleLowerCase();

/**
 * 竞品域名规则：必须能解析成域名，不能是客户官网本身（否则声量份额把自己算成对手），同一版本内不能重复
 * （否则撞活动版本唯一索引，返回数据库英文报错）。返回域名已规范化的竞品列表。
 */
export function normalizeCompetitorScope(
	competitors: ScopeCompetitor[],
	customerDomain: string,
): Array<ScopeCompetitor & { domain: string }> {
	const seen = new Set<string>();
	const customer = normalizeDomain(customerDomain);
	return competitors.map((competitor) => {
		const domain = tryNormalizeDomain(competitor.domain);
		if (!domain) throw new HttpInputError(`竞品「${competitor.name}」的域名无效：${competitor.domain}`, 400);
		if (domain === customer)
			throw new HttpInputError(`竞品「${competitor.name}」的域名与客户官网相同，不能作为竞品`, 409);
		if (seen.has(domain)) throw new HttpInputError(`竞品域名重复：${domain}`, 400);
		seen.add(domain);
		return { ...competitor, domain };
	});
}

/** 同一版本内问题按文本去重后必须唯一，否则同一问题会被采集两次并把指标分母翻倍。 */
export function assertUniqueQuestions(prompts: Array<{ question: string }>): void {
	const seen = new Set<string>();
	for (const prompt of prompts) {
		const key = normalizeQuestion(prompt.question);
		if (seen.has(key)) throw new HttpInputError(`监测问题重复：${prompt.question}`, 400);
		seen.add(key);
	}
}

/** 同行业同问题只保留一条：已存在就回填引用，否则新增并记为知识库来源；返回引用的库 ID 与是否新增。 */
async function syncPromptToLibrary(
	transaction: Database,
	sync: LibrarySync,
	prompt: ScopePrompt,
): Promise<{ libraryQuestionId: string; added: boolean }> {
	const duplicate = (
		await transaction.query<{ id: string }>(
			`SELECT id FROM prompt_library_questions WHERE organization_id=$1 AND archived_at IS NULL
			 AND lower(industry)=lower($2) AND lower(question)=lower($3) LIMIT 1`,
			[sync.organizationId, sync.industry, prompt.question],
		)
	).rows[0];
	if (duplicate) return { libraryQuestionId: duplicate.id, added: false };
	const libraryQuestionId = randomUUID();
	await transaction.query(
		`INSERT INTO prompt_library_questions
		 (id,organization_id,industry,question,intent,topic,persona,tags,created_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
		[
			libraryQuestionId,
			sync.organizationId,
			sync.industry,
			prompt.question,
			prompt.intent.slice(0, 120),
			prompt.topic ? prompt.topic.slice(0, 120) : null,
			prompt.persona ? prompt.persona.slice(0, 120) : null,
			JSON.stringify([...new Set(prompt.tags.map((tag) => tag.slice(0, 80)))].slice(0, 30)),
			sync.createdBy,
		],
	);
	return { libraryQuestionId, added: true };
}

/**
 * 确认监测范围。范围仍是版本化的（旧行留给不可变 capture 与冻结批次），但沿用未变化条目的 ID：
 * 问题按 ID（文本未变）或文本匹配、竞品按 ID（域名未变）或域名匹配到当前活动版本时原地更新并保留 ID；
 * 只有真正新增的条目拿新 ID，被去掉的条目归档。冻结配置含这些 ID，零修改保存因此不会切断趋势可比性，
 * 自动复测也能识别“范围没变”。
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Scope validation, id reuse, library sync and archiving form one versioning decision.
export async function confirmProject(
	database: Database,
	id: string,
	input: unknown,
	options: ConfirmProjectOptions = {},
): Promise<ConfirmProjectResult> {
	const data = reviewSchema.parse(input);
	const project = (
		await database.query<{ organization_id: string; industry: string | null; domain: string }>(
			"SELECT organization_id,industry,domain FROM projects WHERE id=$1",
			[id],
		)
	).rows[0];
	if (!project) throw new HttpInputError("客户项目不存在", 404);
	const competitors = normalizeCompetitorScope(data.competitors, project.domain ?? "");
	assertUniqueQuestions(data.prompts);
	const referencedLibraryIds = [
		...new Set(
			data.prompts.flatMap((prompt) => {
				const questionId = prompt.libraryQuestionId ?? prompt.library_question_id;
				return questionId ? [questionId] : [];
			}),
		),
	];
	// 引用只能指向本机构未归档的知识库记录；跨机构导入的范围包会带来别处的引用，去掉引用而不是拒绝整次确认。
	const allowedLibraryIds = new Set(
		referencedLibraryIds.length
			? (
					await database.query<{ id: string }>(
						`SELECT q.id FROM prompt_library_questions q JOIN projects p ON p.organization_id=q.organization_id
						 WHERE p.id=$1 AND q.archived_at IS NULL AND q.id=ANY($2::text[])`,
						[id, referencedLibraryIds],
					)
				).rows.map((row) => row.id)
			: [],
	);
	const sync = options.syncLibrary && project.industry ? { ...options.syncLibrary, industry: project.industry } : null;
	if (sync && sync.organizationId !== project.organization_id)
		throw new HttpInputError("知识库只能写入客户所属机构", 409);
	const result: ConfirmProjectResult = {
		promptCount: data.prompts.length,
		competitorCount: competitors.length,
		libraryAdded: 0,
		libraryLinked: 0,
		libraryUnlinked: 0,
		promptsKept: 0,
		competitorsKept: 0,
	};
	await database.transaction(async (transaction) => {
		await reconcileCompetitorScope(transaction, id, competitors, result);
		await reconcilePromptScope(transaction, id, data.prompts, { allowedLibraryIds, sync }, result);
		await transaction.query(
			"UPDATE projects SET aliases = $2::jsonb, status = 'active', confirmed_at = now(), updated_at = now() WHERE id = $1",
			[id, JSON.stringify(data.aliases)],
		);
	});
	return result;
}

/** 竞品按 ID（域名未变）或域名匹配当前活动版本：命中则原地更新保留 ID，否则新增；未命中的旧行归档。 */
async function reconcileCompetitorScope(
	transaction: Database,
	projectId: string,
	competitors: Array<ScopeCompetitor & { domain: string }>,
	result: ConfirmProjectResult,
): Promise<void> {
	const active = (
		await transaction.query<{ id: string; domain: string }>(
			"SELECT id,domain FROM competitors WHERE project_id=$1 AND archived_at IS NULL",
			[projectId],
		)
	).rows;
	const keptIds: string[] = [];
	for (const competitor of competitors) {
		const existing =
			active.find((row) => row.id === competitor.id && row.domain === competitor.domain && !keptIds.includes(row.id)) ??
			active.find((row) => row.domain === competitor.domain && !keptIds.includes(row.id));
		if (existing) {
			keptIds.push(existing.id);
			result.competitorsKept += 1;
			await transaction.query("UPDATE competitors SET name=$2,aliases=$3::jsonb,approved=true WHERE id=$1", [
				existing.id,
				competitor.name,
				JSON.stringify(competitor.aliases),
			]);
			continue;
		}
		const competitorId = randomUUID();
		keptIds.push(competitorId);
		await transaction.query(
			"INSERT INTO competitors (id,project_id,name,domain,aliases,approved) VALUES ($1,$2,$3,$4,$5::jsonb,true)",
			[competitorId, projectId, competitor.name, competitor.domain, JSON.stringify(competitor.aliases)],
		);
	}
	await transaction.query(
		"UPDATE competitors SET approved=false,archived_at=now() WHERE project_id=$1 AND archived_at IS NULL AND NOT (id=ANY($2::text[]))",
		[projectId, keptIds],
	);
}

/**
 * 问题按 ID（文本未变）或文本匹配当前活动版本：命中则原地更新其他字段并保留 ID（capture 关联的问题文本不变），
 * 否则新增；未命中的旧行归档。知识库引用优先取本次请求的合法引用，其次沿用旧行，仍为空时按需回流。
 */
async function reconcilePromptScope(
	transaction: Database,
	projectId: string,
	prompts: ScopePrompt[],
	context: { allowedLibraryIds: Set<string>; sync: LibrarySync | null },
	result: ConfirmProjectResult,
): Promise<void> {
	const active = (
		await transaction.query<{ id: string; question: string; library_question_id: string | null }>(
			"SELECT id,question,library_question_id FROM prompts WHERE project_id=$1 AND archived_at IS NULL",
			[projectId],
		)
	).rows;
	const keptIds: string[] = [];
	for (const [position, prompt] of prompts.entries()) {
		const key = normalizeQuestion(prompt.question);
		const existing =
			active.find(
				(row) => row.id === prompt.id && normalizeQuestion(row.question) === key && !keptIds.includes(row.id),
			) ?? active.find((row) => normalizeQuestion(row.question) === key && !keptIds.includes(row.id));
		const requestedLibraryId = prompt.libraryQuestionId ?? prompt.library_question_id ?? null;
		const allowedLibraryId =
			requestedLibraryId && context.allowedLibraryIds.has(requestedLibraryId) ? requestedLibraryId : null;
		if (requestedLibraryId && !allowedLibraryId) result.libraryUnlinked += 1;
		let libraryQuestionId = allowedLibraryId ?? existing?.library_question_id ?? null;
		if (context.sync && !libraryQuestionId && prompt.question.length <= LIBRARY_QUESTION_MAX) {
			const synced = await syncPromptToLibrary(transaction, context.sync, prompt);
			libraryQuestionId = synced.libraryQuestionId;
			if (synced.added) result.libraryAdded += 1;
			else result.libraryLinked += 1;
		}
		const fields = [
			prompt.intent,
			prompt.topic ?? null,
			prompt.persona ?? null,
			JSON.stringify(prompt.tags),
			libraryQuestionId,
			position,
		];
		if (existing) {
			keptIds.push(existing.id);
			result.promptsKept += 1;
			await transaction.query(
				`UPDATE prompts SET intent=$2,topic=$3,persona=$4,tags=$5::jsonb,library_question_id=$6,approved=true,position=$7
				 WHERE id=$1`,
				[existing.id, ...fields],
			);
			continue;
		}
		const promptId = randomUUID();
		keptIds.push(promptId);
		await transaction.query(
			`INSERT INTO prompts (id,project_id,question,intent,topic,persona,tags,library_question_id,position,approved)
			 VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,true)`,
			[promptId, projectId, prompt.question, ...fields],
		);
	}
	await transaction.query(
		"UPDATE prompts SET approved=false,archived_at=now() WHERE project_id=$1 AND archived_at IS NULL AND NOT (id=ANY($2::text[]))",
		[projectId, keptIds],
	);
}

const batchInputSchema = z.object({
	kind: z.enum(["quick_audit", "baseline", "retest"]),
	compareToBatchId: z.string().optional().nullable(),
	platforms: z
		.array(z.enum(searchProviderIds))
		.min(1)
		.default([...searchProviderIds]),
	repeats: z.number().int().min(1).max(10).optional(),
	executionWindowMinutes: z.array(z.number().int().min(0).max(43_200)).max(10).optional(),
});

/**
 * 默认采样时间窗口（分钟）：前三次按 0 / 4 小时 / 24 小时分时段；超过三次时在同一天内平均分布，
 * 不再按“每多一次多一天”把批次拖到一周以后。
 */
export function defaultExecutionWindowMinutes(repeats: number): number[] {
	if (repeats <= 3) return [0, 240, 1440].slice(0, Math.max(1, repeats));
	return Array.from({ length: repeats }, (_, index) => Math.round((index * 1440) / (repeats - 1)));
}

const executionWindowToMinutes = (value: string): number => Number(value.match(/^PT(\d+)M$/)?.[1] ?? 0);

function resolveExecutionWindowMinutes(
	kind: "quick_audit" | "baseline",
	repeats: number,
	requested: number[] | undefined,
): number[] {
	if (kind === "quick_audit") return [0];
	return requested?.length === repeats ? requested : defaultExecutionWindowMinutes(repeats);
}

/**
 * 按当前已批准范围与已启用平台配置构造冻结配置。createBatch 与周期监测共用：
 * 周期监测先构造候选配置与最近基线比较，可比才复测，否则新建基线，新增的问题因此不会被旧基线遗漏。
 */
async function buildBaselineConfig(
	database: Database,
	project: Record<string, unknown>,
	input: {
		kind: "quick_audit" | "baseline";
		platforms: SearchProviderId[];
		repeats: number;
		executionWindowMinutes?: number[];
	},
): Promise<FrozenBatchConfig> {
	const projectId = String(project.id);
	const competitors = await database.query<Record<string, unknown>>(
		"SELECT * FROM competitors WHERE project_id = $1 AND approved = true AND archived_at IS NULL ORDER BY created_at",
		[projectId],
	);
	const prompts = await database.query<Record<string, unknown>>(
		"SELECT * FROM prompts WHERE project_id = $1 AND approved = true AND archived_at IS NULL ORDER BY position",
		[projectId],
	);
	if (prompts.rows.length === 0) throw new HttpInputError("至少确认一个监测问题", 400);
	const enabledProviders = await database.query<Record<string, unknown>>(
		"SELECT * FROM provider_configs WHERE organization_id=$1 AND enabled=true AND provider_id=ANY($2::text[]) ORDER BY provider_id",
		[project.organization_id, input.platforms],
	);
	const enabledIds = new Set(enabledProviders.rows.map((row) => String(row.provider_id)));
	const missing = input.platforms.filter((providerId) => !enabledIds.has(providerId));
	if (missing.length)
		throw new HttpInputError(
			`以下监测平台尚未启用：${missing.map((id) => providerDefinitions[id].label).join("、")}`,
			409,
		);
	const windowMinutes = resolveExecutionWindowMinutes(input.kind, input.repeats, input.executionWindowMinutes);
	const config: FrozenBatchConfig = {
		project: {
			name: String(project.name),
			websiteUrl: project.website_url ? String(project.website_url) : null,
			domain: project.domain ? String(project.domain) : "",
			region: String(project.region),
			language: String(project.language),
			industry: project.industry ? String(project.industry) : null,
			aliases: parseJsonColumn<string[]>(project.aliases as string | string[]),
		},
		competitors: competitors.rows.map((row) => ({
			id: String(row.id),
			name: String(row.name),
			domain: String(row.domain),
			aliases: parseJsonColumn<string[]>(row.aliases as string | string[]),
		})),
		prompts: prompts.rows.slice(0, 100).map((row) => ({
			id: String(row.id),
			question: String(row.question),
			intent: String(row.intent),
			topic: row.topic ? String(row.topic) : null,
			persona: row.persona ? String(row.persona) : null,
			tags: parseJsonColumn<string[]>(row.tags as string | string[]),
		})),
		platforms: [...new Set(input.platforms)],
		repeats: input.repeats,
		runnerVersion: currentRunnerVersion,
		samplingMode: input.kind === "quick_audit" ? "quick" : "formal",
		executionWindows: windowMinutes.map((minutes) => `PT${minutes}M`),
		providers: enabledProviders.rows.map((row) => {
			const searchStrategy = parseJsonColumn<Record<string, unknown>>(
				row.search_strategy as string | Record<string, unknown>,
			);
			const options =
				searchStrategy.options && typeof searchStrategy.options === "object"
					? (searchStrategy.options as Record<string, unknown>)
					: {};
			return {
				id: String(row.provider_id) as SearchProviderId,
				endpoint: String(row.endpoint),
				secondaryEndpoint: typeof options.secondaryEndpoint === "string" ? options.secondaryEndpoint : undefined,
				model: String(row.model),
				protocol: String(row.protocol),
				searchToolVersion: providerDefinitions[String(row.provider_id) as SearchProviderId].searchToolVersion,
				searchStrategy,
				// This is an executable-code contract, not a user setting that may remain stale after upgrade.
				adapterVersion: ADAPTER_VERSION,
			};
		}),
	};
	config.measurement = await freezeMeasurement(database, String(project.organization_id), config);
	return config;
}

/** 复测复制基线的完整冻结配置；契约不完整或适配器已升级时每个任务都会失败，创建前直接拒绝。 */
async function loadRetestConfig(
	database: Database,
	projectId: string,
	compareToBatchId: string | null | undefined,
): Promise<FrozenBatchConfig> {
	if (!compareToBatchId) throw new Error("复测必须选择一个基线批次");
	const baseline = (
		await database.query<{ config: FrozenBatchConfig | string }>(
			"SELECT config FROM experiment_batches WHERE id = $1 AND project_id = $2 AND kind='baseline'",
			[compareToBatchId, projectId],
		)
	).rows[0];
	if (!baseline) throw new HttpInputError("复测只能选择正式基线批次", 409);
	const config = parseJsonColumn(baseline.config);
	if (!config.measurement) throw new Error("V1 基线已停用，请创建 V2 正式基线");
	if (!config.providers?.length || config.providers.some((provider) => !provider.endpoint || !provider.adapterVersion))
		throw new HttpInputError("所选基线缺少完整的云端 Provider 冻结契约，请先创建新的正式基线", 409);
	const staleVersions = [
		...new Set(
			config.providers
				.filter((provider) => provider.adapterVersion !== ADAPTER_VERSION)
				.map((provider) => String(provider.adapterVersion)),
		),
	];
	if (staleVersions.length)
		throw new Error(
			`所选基线冻结的适配器版本 ${staleVersions.join("、")} 与当前 Worker（${ADAPTER_VERSION}）不一致，复测会全部失败，请新建正式基线`,
		);
	return config;
}

export async function createBatch(
	database: Database,
	projectId: string,
	input: unknown,
): Promise<{ id: string; jobCount: number }> {
	return database.transaction((tx) => createBatchInTransaction(tx, projectId, input));
}

async function createBatchInTransaction(
	database: Database,
	projectId: string,
	input: unknown,
): Promise<{ id: string; jobCount: number }> {
	const data = batchInputSchema.parse(input);
	const repeats = data.repeats ?? (data.kind === "quick_audit" ? 1 : 3);
	if (data.kind === "quick_audit" && repeats !== 1) throw new Error("售前快审固定每平台每题采样 1 次");
	const project = (await database.query<Record<string, unknown>>("SELECT * FROM projects WHERE id = $1", [projectId]))
		.rows[0];
	if (project?.status !== "active") throw new HttpInputError("客户配置尚未人工确认，不能开始采集", 409);
	const config =
		data.kind === "retest"
			? await loadRetestConfig(database, projectId, data.compareToBatchId)
			: await buildBaselineConfig(database, project, {
					kind: data.kind,
					platforms: data.platforms,
					repeats,
					executionWindowMinutes: data.executionWindowMinutes,
				});
	const id = randomUUID();
	const configHash = sha256(stableJson(config));
	await database.query(
		"INSERT INTO experiment_batches (id,project_id,kind,compare_to_batch_id,status,config,config_hash,started_at) VALUES ($1,$2,$3,$4,'queued',$5::jsonb,$6,now())",
		[id, projectId, data.kind, data.compareToBatchId ?? null, JSON.stringify(config), configHash],
	);
	await createMeasurementRun(database, id, projectId, String(project.organization_id), config.measurement!);
	let jobCount = 0;
	const brands = [
		{ id: projectId, name: config.project.name, aliases: config.project.aliases },
		...config.competitors.map((item) => ({ id: item.id, name: item.name, aliases: item.aliases })),
	];
	for (const prompt of config.prompts)
		for (const platform of config.platforms)
			for (let attempt = 1; attempt <= config.repeats; attempt += 1) {
				const payload: CaptureJobPayload = {
					sampleKey: JSON.stringify([id, platform, prompt.id, attempt - 1, 0]),
					projectId,
					batchId: id,
					promptId: prompt.id,
					prompt: prompt.question,
					platform,
					attempt,
					region: config.project.region,
					locale: config.project.language,
					brands,
				};
				const offset = Number(config.executionWindows?.[attempt - 1]?.match(/^PT(\d+)M$/)?.[1] ?? 0);
				await enqueueCaptureJob(database, payload, new Date(Date.now() + offset * 60_000));
				jobCount += 1;
			}
	return { id, jobCount };
}

const scheduleSchema = z.object({
	enabled: z.boolean(),
	frequencyDays: z.number().int().min(1).max(90),
	platforms: z.array(z.enum(searchProviderIds)).min(1),
	repeats: z.number().int().min(1).max(10),
	executionWindowMinutes: z.array(z.number().int().min(0).max(43_200)).max(10).optional(),
});

/**
 * 保存周期监测计划。下一次运行时间：新启用时从现在起算一个周期；已启用时若周期改了，按上次运行时间
 * 加新周期重算（已经到期就立刻可运行），否则保持原时间。保存计划视为成员介入，同时清掉上次失败记录。
 */
export async function saveMonitoringSchedule(database: Database, projectId: string, input: unknown): Promise<void> {
	const data = scheduleSchema.parse(input);
	const project = (await database.query<{ status: string }>("SELECT status FROM projects WHERE id=$1", [projectId]))
		.rows[0];
	if (project?.status !== "active") throw new HttpInputError("客户项目未启用，不能设置自动监测", 409);
	const nextRunAt = data.enabled ? new Date(Date.now() + data.frequencyDays * 86_400_000).toISOString() : null;
	await database.query(
		`INSERT INTO monitoring_schedules (id,project_id,enabled,frequency_days,platforms,repeats,sampling_mode,execution_windows,next_run_at)
		 VALUES ($1,$2,$3,$4,$5::jsonb,$6,'formal',$7::jsonb,$8)
		 ON CONFLICT (project_id) DO UPDATE SET enabled=excluded.enabled,frequency_days=excluded.frequency_days,
		 platforms=excluded.platforms,repeats=excluded.repeats,sampling_mode='formal',execution_windows=excluded.execution_windows,
		 next_run_at=CASE
		 WHEN excluded.enabled=false THEN NULL
		 WHEN monitoring_schedules.enabled=false THEN excluded.next_run_at
		 WHEN monitoring_schedules.frequency_days<>excluded.frequency_days OR monitoring_schedules.next_run_at IS NULL
			THEN GREATEST(now(),COALESCE(monitoring_schedules.last_run_at,now())+(excluded.frequency_days::text||' days')::interval)
		 ELSE monitoring_schedules.next_run_at END,
		 last_error=NULL,last_error_at=NULL,failure_count=0,updated_at=now()`,
		[
			randomUUID(),
			projectId,
			data.enabled,
			data.frequencyDays,
			JSON.stringify(data.platforms),
			data.repeats,
			JSON.stringify(
				(data.executionWindowMinutes?.length === data.repeats
					? data.executionWindowMinutes
					: defaultExecutionWindowMinutes(data.repeats)
				).map((minutes) => `PT${minutes}M`),
			),
			nextRunAt,
		],
	);
}

/**
 * 到期计划创建批次：先按当前范围与平台配置构造基线配置，与最近完成/部分完成的基线可比就复测，
 * 否则（问题、竞品、别名、平台或供应商配置变了）新建基线，避免复测永远只采旧基线里的问题。
 */
async function createScheduledBatch(
	database: Database,
	schedule: Record<string, unknown>,
): Promise<{ id: string; jobCount: number; kind: "baseline" | "retest" }> {
	const projectId = String(schedule.project_id);
	const project = (await database.query<Record<string, unknown>>("SELECT * FROM projects WHERE id=$1", [projectId]))
		.rows[0];
	if (project?.status !== "active") throw new HttpInputError("客户项目未启用，不能自动监测", 409);
	const platforms = parseJsonColumn<SearchProviderId[]>(schedule.platforms as string | SearchProviderId[]);
	const repeats = Number(schedule.repeats);
	const executionWindowMinutes = parseJsonColumn<string[]>(schedule.execution_windows as string | string[]).map(
		executionWindowToMinutes,
	);
	const candidate = await buildBaselineConfig(database, project, {
		kind: "baseline",
		platforms,
		repeats,
		executionWindowMinutes,
	});
	const latestBaseline = (
		await database.query<{ id: string; config: FrozenBatchConfig | string }>(
			`SELECT id,config FROM experiment_batches
			 WHERE project_id=$1 AND kind='baseline' AND status IN ('complete','partial') ORDER BY completed_at DESC LIMIT 1`,
			[projectId],
		)
	).rows[0];
	if (
		latestBaseline &&
		areBatchConfigsComparable(candidate, parseJsonColumn<FrozenBatchConfig>(latestBaseline.config))
	) {
		const batch = await createBatch(database, projectId, { kind: "retest", compareToBatchId: latestBaseline.id });
		return { ...batch, kind: "retest" };
	}
	const batch = await createBatch(database, projectId, {
		kind: "baseline",
		platforms,
		repeats,
		executionWindowMinutes,
	});
	return { ...batch, kind: "baseline" };
}

export async function processDueSchedules(database: Database): Promise<number> {
	const due = await database.query<Record<string, unknown>>(
		`SELECT * FROM monitoring_schedules WHERE enabled=true AND next_run_at<=now() AND EXISTS(SELECT 1 FROM projects p JOIN organizations o ON o.id=p.organization_id WHERE p.id=monitoring_schedules.project_id AND o.suspended_at IS NULL)
		 ORDER BY next_run_at LIMIT 10`,
	);
	let created = 0;
	for (const schedule of due.rows) {
		const projectId = String(schedule.project_id);
		const active = (
			await database.query(
				"SELECT id FROM experiment_batches WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",
				[projectId],
			)
		).rows[0];
		if (active) {
			await database.query(
				"UPDATE monitoring_schedules SET next_run_at=now()+interval '1 hour',updated_at=now() WHERE id=$1",
				[schedule.id],
			);
			continue;
		}
		try {
			const batch = await createScheduledBatch(database, schedule);
			await database.query(
				`UPDATE monitoring_schedules SET last_run_at=now(),last_batch_id=$2,
				 next_run_at=now()+($3::text||' days')::interval,last_error=NULL,last_error_at=NULL,failure_count=0,updated_at=now()
				 WHERE id=$1`,
				[schedule.id, batch.id, Number(schedule.frequency_days)],
			);
			serviceLogger.info("schedule.batch_created", "周期监测已创建批次", {
				projectId,
				traceId: batch.id,
				metadata: { scheduleId: String(schedule.id), kind: batch.kind, jobCount: batch.jobCount },
			});
			created += 1;
		} catch (error) {
			// 失败不能静默：记在计划上供界面提示，写运行日志，一小时后再试。
			const message = error instanceof Error ? error.message : "创建批次失败";
			const failureCount = Number(schedule.failure_count ?? 0) + 1;
			await database.query(
				`UPDATE monitoring_schedules SET next_run_at=now()+interval '1 hour',last_error=$2,last_error_at=now(),
				 failure_count=$3,updated_at=now() WHERE id=$1`,
				[schedule.id, message.slice(0, 500), failureCount],
			);
			serviceLogger.error("schedule.batch_failed", safeErrorMessage(error), {
				projectId,
				traceId: String(schedule.id),
				metadata: { scheduleId: String(schedule.id), failureCount },
			});
		}
	}
	return created;
}

export function captureFromRow(row: Record<string, unknown>): QueryCapture {
	const common = {
		schemaVersion: row.schema_version ?? "geo.query-capture.v1",
		captureId: row.id,
		jobId: row.job_id,
		sampleKey: row.sample_key ?? undefined,
		projectId: row.project_id,
		promptId: row.prompt_id,
		prompt: row.question,
		engine: row.platform,
		captureMode: row.capture_mode ?? "consumer_surface",
		attempt: row.attempt,
		capturedAt: new Date(String(row.captured_at)).toISOString(),
		locale: row.language,
		region: row.region,
		status: row.status,
		answerText: row.answer_text,
		brandMatches: parseJsonColumn(row.brand_matches),
		sources: parseJsonColumn(row.sources),
		queryFanOut: parseJsonColumn(row.query_fan_out),
		adapterVersion: row.adapter_version,
		contentHash: row.content_hash,
		failureCode: row.failure_code,
		failureMessage: row.failure_message,
	};
	if (row.capture_mode === "llm_search_api") {
		return queryCaptureSchema.parse({
			...common,
			sourceVisibility: row.source_visibility,
			fanoutVisibility: row.fanout_visibility,
			evidence: {
				endpoint: row.page_url,
				rawResponseObjectKey: row.raw_artifact_key,
				requestId: row.provider_request_id,
			},
			model: row.model,
			protocol: row.protocol,
			searchToolVersion: row.search_tool_version,
			executorId: row.executor_id,
			usage: row.usage ? parseJsonColumn(row.usage) : null,
			costMicros: row.cost_micros === null || row.cost_micros === undefined ? null : Number(row.cost_micros),
			latencyMs: row.latency_ms,
		});
	}
	return queryCaptureSchema.parse({
		...common,
		evidence: {
			captureNodeId: row.collector_node_id,
			screenshotObjectKey: row.screenshot_key,
			traceObjectKey: row.trace_key,
			pageUrl: row.page_url,
		},
	});
}

export async function getBatch(database: Database, batchId: string): Promise<Record<string, unknown> | null> {
	const batch = (
		await database.query<Record<string, unknown>>(
			`SELECT b.*,p.organization_id FROM experiment_batches b JOIN projects p ON p.id=b.project_id WHERE b.id=$1`,
			[batchId],
		)
	).rows[0];
	if (!batch) return null;
	const config = parseJsonColumn<FrozenBatchConfig>(batch.config as FrozenBatchConfig | string);
	const rows = await database.query<Record<string, unknown>>(
		`SELECT c.*, p.question, pr.region, pr.language FROM query_captures c
		 JOIN prompts p ON p.id = c.prompt_id JOIN projects pr ON pr.id = c.project_id
		 WHERE c.batch_id = $1 ORDER BY c.captured_at`,
		[batchId],
	);
	const captures = rows.rows.map(captureFromRow);
	const measurement = await currentMeasurement(database, batchId);
	const compatible = captureContractCurrent(config);
	const executionFailedSamples = Number(
		(
			await database.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM jobs j
   WHERE type='capture' AND payload->>'batchId'=$1 AND status='failed' AND NOT EXISTS(SELECT 1 FROM query_captures c WHERE c.job_id=j.id)`,
				[batchId],
			)
		).rows[0].count,
	);
	return {
		...batch,
		config,
		captures,
		measurement: {
			runId: measurement.runId,
			snapshotId: compatible ? measurement.snapshotId : null,
			status: compatible ? measurement.status : "capture_contract_changed",
			captureContractCurrent: compatible,
		},
		captureProgress: await captureProgress(database, batchId),
		pairedComparison: compatible
			? await readPairedComparisons(
					database,
					measurement.snapshotId,
					batch.compare_to_batch_id ? String(batch.compare_to_batch_id) : null,
				)
			: [],
		metrics:
			(compatible ? measurement.payload : null) ??
			pendingMetrics(
				config,
				captures.filter((c): c is QueryCaptureV2 => c.schemaVersion === "geo.query-capture.v2"),
				executionFailedSamples,
			),
	};
}

async function latestWebsiteAudit(
	database: Database,
	projectId: string,
	domain?: string,
): Promise<{ id: string; result: WebsiteAuditResult } | null> {
	if (domain === "") return null;
	const row = (
		await database.query<Record<string, unknown>>(
			"SELECT id,result,requested_url FROM website_audits WHERE project_id=$1 ORDER BY checked_at DESC LIMIT 100",
			[projectId],
		)
	).rows.find(
		(row) => domain === undefined || tryNormalizeDomain(String(row.requested_url)) === normalizeDomain(domain),
	);
	return row
		? { id: String(row.id), result: parseJsonColumn<WebsiteAuditResult>(row.result as WebsiteAuditResult | string) }
		: null;
}

type BatchMetrics = Parameters<typeof buildReportAnalysis>[0]["metrics"];

export async function getBatchReport(database: Database, batchId: string): Promise<Record<string, unknown> | null> {
	const batch = await getBatch(database, batchId);
	if (!batch) return null;
	const projectId = String(batch.project_id);
	const config = batch.config as FrozenBatchConfig;
	const captures = batch.captures as QueryCapture[];
	const metricId = (batch.measurement as { snapshotId: string | null }).snapshotId;
	const [websiteAudit, findings, tasks, attributionSummary, webEvidence] = await Promise.all([
		latestWebsiteAudit(database, projectId, config.project.domain),
		database.query(
			"SELECT * FROM diagnosis_findings WHERE batch_id=$1 AND metric_snapshot_id=$2 ORDER BY confidence DESC,created_at",
			[batchId, metricId],
		),
		database.query(
			`SELECT t.* FROM remediation_tasks t JOIN diagnosis_findings f ON f.id=t.finding_id
			 WHERE f.batch_id=$1 AND f.metric_snapshot_id=$2 ORDER BY CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,t.created_at`,
			[batchId, metricId],
		),
		database.query(
			`SELECT source_type,metric,sum(value)::float8 AS value,max(observed_at) AS last_observed_at,
			 count(*)::int AS observations FROM attribution_events WHERE project_id=$1
			 GROUP BY source_type,metric ORDER BY source_type,metric`,
			[projectId],
		),
		loadDiagnosisWebEvidence(database, projectId, config, captures),
	]);
	return {
		batchId,
		metricSnapshotId: metricId,
		projectId,
		analysis: buildReportAnalysis({
			projectId,
			config,
			captures,
			metrics: batch.metrics as BatchMetrics,
			websiteAudit,
			webEvidence,
		}),
		findings: findings.rows,
		tasks: tasks.rows,
		attributionSummary: attributionSummary.rows,
	};
}

export async function getProjectTrends(
	database: Database,
	projectId: string,
	batchId?: string | null,
): Promise<Record<string, unknown>> {
	const anchor = (
		await database.query<{ id: string; config_hash: string }>(
			batchId
				? "SELECT id,config_hash FROM experiment_batches WHERE id=$1 AND project_id=$2"
				: "SELECT id,config_hash FROM experiment_batches WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1",
			batchId ? [batchId, projectId] : [projectId],
		)
	).rows[0];
	if (!anchor) return { anchorBatchId: null, comparable: [] };
	const anchorMeasurement = await currentMeasurement(database, anchor.id);
	if (anchorMeasurement.payload?.overall.status !== "ready") return { anchorBatchId: anchor.id, comparable: [] };
	// 可比性按冻结配置的语义相等判断（jsonb 比较），不依赖历史批次写入时的哈希实现。
	const rows = await database.query<{ id: string }>(
		`SELECT b.id FROM experiment_batches b, experiment_batches anchor
		 WHERE anchor.id=$2 AND b.project_id=$1 AND b.config=anchor.config
		 AND b.status IN ('complete','partial') ORDER BY b.created_at DESC LIMIT 50`,
		[projectId, anchor.id],
	);
	const batches = (await Promise.all(rows.rows.map((row) => getBatch(database, row.id)))).filter(Boolean) as Array<
		Record<string, unknown>
	>;
	return {
		anchorBatchId: anchor.id,
		configHash: anchor.config_hash,
		comparable: batches
			.reverse()
			.filter(
				(b) =>
					(b.metrics as { overall: { status?: string } }).overall.status === "ready" &&
					stableJson((b.metrics as { contract?: unknown }).contract) ===
						stableJson(anchorMeasurement.payload?.contract),
			)
			.map((batch) => ({
				id: batch.id,
				kind: batch.kind,
				createdAt: batch.created_at,
				completedAt: batch.completed_at,
				metricSnapshotId: (batch.measurement as { snapshotId: string | null }).snapshotId,
				metrics: batch.metrics,
			})),
	};
}

export async function storeCloudCapture(database: Database, captureInput: unknown): Promise<void> {
	const capture: QueryCaptureV2 = queryCaptureV2Schema.parse(captureInput);
	const job = (await database.query<Record<string, unknown>>("SELECT * FROM jobs WHERE id=$1", [capture.jobId]))
		.rows[0];
	if (!job || job.lease_owner !== capture.executorId || job.status !== "leased")
		throw new HttpInputError("云端采集任务租约无效或已过期", 400);
	const payload = job.payload as CaptureJobPayload;
	if (
		capture.projectId !== payload.projectId ||
		capture.promptId !== payload.promptId ||
		capture.engine !== payload.platform ||
		capture.attempt !== payload.attempt
	)
		throw new HttpInputError("采样结果与冻结任务范围不一致", 409);
	await database.transaction(async (transaction) => {
		const owned = await transaction.query(
			"SELECT id FROM jobs WHERE id=$1 AND lease_owner=$2 AND status='leased' AND lease_expires_at>now() FOR UPDATE",
			[capture.jobId, capture.executorId],
		);
		if (!owned.rows.length) throw new HttpInputError("云端采集任务租约无效或已过期", 400);
		// Raw API evidence is append-only; reparsing creates derived rows and never rewrites this capture.
		await transaction.query(
			`INSERT INTO query_captures
			 (id,job_id,batch_id,project_id,prompt_id,platform,attempt,status,answer_text,brand_matches,sources,
			 query_fan_out,page_url,content_hash,adapter_version,failure_code,failure_message,captured_at,
			 schema_version,capture_mode,model,protocol,search_tool_version,source_visibility,fanout_visibility,
			 raw_artifact_key,provider_request_id,usage,cost_micros,latency_ms,executor_id,sample_key)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,
			 $19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29,$30,$31,$32)`,
			[
				capture.captureId,
				capture.jobId,
				payload.batchId,
				capture.projectId,
				capture.promptId,
				capture.engine,
				capture.attempt,
				capture.status,
				capture.answerText,
				JSON.stringify(capture.brandMatches),
				JSON.stringify(capture.sources),
				JSON.stringify(capture.queryFanOut),
				capture.evidence.endpoint,
				capture.contentHash,
				capture.adapterVersion,
				capture.failureCode,
				capture.failureMessage,
				capture.capturedAt,
				capture.schemaVersion,
				capture.captureMode,
				capture.model,
				capture.protocol,
				capture.searchToolVersion,
				capture.sourceVisibility,
				capture.fanoutVisibility,
				capture.evidence.rawResponseObjectKey,
				capture.evidence.requestId,
				capture.usage ? JSON.stringify(capture.usage) : null,
				capture.costMicros,
				capture.latencyMs,
				capture.executorId,
				payload.sampleKey ?? null,
			],
		);
		await transaction.query(
			"UPDATE jobs SET status='complete',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
			[capture.jobId],
		);
		await transaction.query(
			`INSERT INTO project_costs (id,project_id,batch_id,provider_id,operation,usage,cost_micros)
			 VALUES ($1,$2,$3,$4,'capture',$5::jsonb,$6)`,
			[
				randomUUID(),
				capture.projectId,
				payload.batchId,
				capture.engine,
				capture.usage ? JSON.stringify(capture.usage) : null,
				capture.costMicros,
			],
		);
	});
	await refreshBatchStatus(database, payload.batchId);
}

export async function refreshBatchStatus(database: Database, batchId: string): Promise<void> {
	const counts = (
		await database.query<{ remaining: number; failed: number }>(
			`SELECT count(*) FILTER (WHERE status IN ('pending','leased'))::int AS remaining,
			 (count(*) FILTER (WHERE status = 'failed') +
			  (SELECT count(*) FROM query_captures WHERE batch_id=$1 AND status <> 'complete'))::int AS failed
			 FROM jobs WHERE type='capture' AND payload->>'batchId' = $1`,
			[batchId],
		)
	).rows[0];
	if (!counts) return;
	if (counts.remaining === 0) {
		const finalized = await database.query(
			`UPDATE experiment_batches SET status=$2,completed_at=now() WHERE id=$1 AND status NOT IN ('complete','partial')
			 RETURNING id`,
			[batchId, counts.failed > 0 ? "partial" : "complete"],
		);
		void finalized; // Semantic Worker computes paired drift only after V2 snapshots are frozen.
	} else
		await database.query("UPDATE experiment_batches SET status = 'running' WHERE id = $1 AND status = 'queued'", [
			batchId,
		]);
}

export async function listDriftAlerts(
	database: Database,
	projectId: string,
	input: PaginationInput,
): Promise<Paginated<Record<string, unknown>>> {
	const total = Number(
		(
			await database.query<{ count: number }>("SELECT count(*)::int AS count FROM drift_alerts WHERE project_id=$1", [
				projectId,
			])
		).rows[0]?.count ?? 0,
	);
	const rows = (
		await database.query<Record<string, unknown>>(
			"SELECT * FROM drift_alerts WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
			[projectId, input.pageSize, input.offset],
		)
	).rows;
	return paginated(rows, total, input);
}

export async function getProjectCostSummary(database: Database, projectId: string): Promise<unknown> {
	const rows = (
		await database.query<Record<string, unknown>>(
			"SELECT provider_id,operation,usage,cost_micros,occurred_at FROM project_costs WHERE project_id=$1 ORDER BY occurred_at DESC",
			[projectId],
		)
	).rows;
	const groups = new Map<
		string,
		{
			providerId: string;
			operation: string;
			requests: number;
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
			knownCostMicros: number;
			costKnownRequests: number;
		}
	>();
	for (const row of rows) {
		const key = `${row.provider_id}:${row.operation}`;
		const group = groups.get(key) ?? {
			providerId: String(row.provider_id),
			operation: String(row.operation),
			requests: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			knownCostMicros: 0,
			costKnownRequests: 0,
		};
		const usage = row.usage
			? parseJsonColumn<Record<string, number>>(row.usage as string | Record<string, number>)
			: {};
		group.requests += 1;
		group.inputTokens += Number(usage.inputTokens ?? 0);
		group.outputTokens += Number(usage.outputTokens ?? 0);
		group.totalTokens += Number(usage.totalTokens ?? 0);
		if (row.cost_micros !== null && row.cost_micros !== undefined) {
			group.knownCostMicros += Number(row.cost_micros);
			group.costKnownRequests += 1;
		}
		groups.set(key, group);
	}
	return { records: rows.length, groups: [...groups.values()] };
}

export async function acknowledgeDriftAlert(database: Database, alertId: string): Promise<void> {
	const result = await database.query(
		"UPDATE drift_alerts SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1",
		[alertId],
	);
	if (result.affectedRows !== 1) throw new HttpInputError("漂移告警不存在", 404);
}

async function loadDiagnosisWebEvidence(
	database: Database,
	projectId: string,
	config: FrozenBatchConfig,
	captures: QueryCapture[],
): Promise<DiagnosisWebEvidence[]> {
	const rows = await database.query<Record<string, unknown>>(
		`SELECT DISTINCT ON (url) id,url,domain,title,content_text,structured_data
		 FROM website_snapshots WHERE project_id=$1 ORDER BY url,fetched_at DESC LIMIT 250`,
		[projectId],
	);
	const customerDomain = normalizeDomain(config.project.domain);
	const competitorDomains = new Set(config.competitors.map((item) => normalizeDomain(item.domain)));
	const citationUrls = new Set(
		captures.flatMap((capture) => capture.sources.filter((source) => source.isCitation).map((source) => source.url)),
	);
	return rows.rows.flatMap((row) => {
		const domain = normalizeDomain(String(row.domain));
		const url = String(row.url);
		const role =
			domain === customerDomain
				? "customer"
				: competitorDomains.has(domain)
					? "competitor"
					: citationUrls.has(url)
						? "citation"
						: null;
		if (!role) return [];
		return [
			{
				id: String(row.id),
				role,
				url,
				domain,
				title: row.title ? String(row.title) : null,
				content: String(row.content_text).slice(0, 20_000),
				structuredData: parseJsonColumn<unknown[]>(row.structured_data as unknown[] | string),
			} satisfies DiagnosisWebEvidence,
		];
	});
}

async function collectDiagnosisWebEvidence(
	database: Database,
	projectId: string,
	config: FrozenBatchConfig,
	captures: QueryCapture[],
): Promise<DiagnosisWebEvidence[]> {
	const existingCustomer = await database.query(
		"SELECT id FROM website_snapshots WHERE project_id=$1 AND domain=$2 LIMIT 1",
		[projectId, config.project.domain],
	);
	if (existingCustomer.rows.length === 0) {
		const project = (
			await database.query<{ website_url: string }>("SELECT website_url FROM projects WHERE id=$1", [projectId])
		).rows[0];
		if (project?.website_url)
			try {
				await crawlWebsite(database, projectId, project.website_url, 30);
			} catch {
				// A missing customer crawl remains evidence-insufficient and is never treated as absent content.
			}
	}
	const targets = [
		...config.competitors.map((competitor) => `https://${competitor.domain}/`),
		...[
			...new Set(
				captures.flatMap((capture) =>
					capture.sources.filter((source) => source.isCitation).map((source) => source.url),
				),
			),
		]
			.slice(0, 20)
			.map((url) => url),
	];
	for (let offset = 0; offset < targets.length; offset += 4) {
		await Promise.all(
			targets.slice(offset, offset + 4).map(async (targetUrl) => {
				try {
					const existing = (
						await database.query<Record<string, unknown>>(
							"SELECT id,url,domain,title,content_text,structured_data FROM website_snapshots WHERE project_id=$1 AND url=$2 ORDER BY fetched_at DESC LIMIT 1",
							[projectId, targetUrl],
						)
					).rows[0];
					if (!existing) await crawlPublishedUrl(database, projectId, targetUrl);
				} catch {
					// Unreachable external pages are omitted rather than replaced with inferred content.
				}
			}),
		);
	}
	return loadDiagnosisWebEvidence(database, projectId, config, captures);
}

export async function diagnoseBatch(
	database: Database,
	batchId: string,
): Promise<{ count: number; method: "evidence_rules" }> {
	const batch = await getBatch(database, batchId);
	if (!batch) throw new HttpInputError("采集批次不存在", 404);
	const metricId = (batch.measurement as { snapshotId: string | null }).snapshotId;
	if (!metricId) throw new HttpInputError("请等待 V2 语义指标快照生成", 409);
	const captures = batch.captures as QueryCapture[];
	const valid = captures.filter((capture) => capture.status === "complete");
	if (valid.length === 0) throw new HttpInputError("证据不足：当前批次没有成功采集的真实回答", 409);
	const config = batch.config as FrozenBatchConfig;
	let websiteAudit = await latestWebsiteAudit(database, String(batch.project_id), config.project.domain);
	const currentSite = (
		await database.query<{ domain: string | null }>("SELECT domain FROM projects WHERE id=$1", [batch.project_id])
	).rows[0];
	if (!websiteAudit && config.project.domain && currentSite?.domain === config.project.domain) {
		try {
			websiteAudit = await auditProject(database, String(batch.project_id));
		} catch {
			// Answer evidence stays usable even when a customer domain no longer resolves.
		}
	}
	const webEvidence = await collectDiagnosisWebEvidence(database, String(batch.project_id), config, valid);
	const deterministic = buildDeterministicFindings({
		projectId: String(batch.project_id),
		config,
		captures,
		metrics: batch.metrics as BatchMetrics,
		websiteAudit,
		webEvidence,
	});
	const validIds = new Set([
		...captures.map((capture) => capture.captureId),
		...webEvidence.map((item) => item.id),
		...(websiteAudit ? [websiteAudit.id] : []),
	]);
	const validPromptIds = new Set(config.prompts.map((prompt) => prompt.id));
	const findings = deterministic;
	await database.transaction(async (transaction) => {
		await transaction.query("SELECT id FROM experiment_batches WHERE id=$1 FOR UPDATE", [batchId]);
		if ((await currentMeasurement(transaction, batchId)).snapshotId !== metricId)
			throw new HttpInputError("指标版本已变化，请重新生成诊断", 409);
		const existing = await transaction.query<{ id: string; category: string; title: string }>(
			"SELECT id,category,title FROM diagnosis_findings WHERE batch_id=$1 AND metric_snapshot_id=$2",
			[batchId, metricId],
		);
		const retainedIds: string[] = [];
		for (const finding of findings) {
			if (!finding.evidenceIds.every((id) => validIds.has(id)))
				throw new HttpInputError("诊断引用了不存在的证据，结果已拒绝写入", 404);
			if (!finding.targetPromptIds.every((id) => validPromptIds.has(id)))
				throw new HttpInputError("诊断引用了不存在的问题，结果已拒绝写入", 404);
			const current = existing.rows.find((item) => item.category === finding.category && item.title === finding.title);
			const findingId = current?.id ?? randomUUID();
			retainedIds.push(findingId);
			if (current)
				await transaction.query(
					`UPDATE diagnosis_findings SET detail=$2,confidence=$3,evidence_ids=$4::jsonb,
					 target_prompt_ids=$5::jsonb,recommendation=$6 WHERE id=$1`,
					[
						findingId,
						finding.detail,
						finding.confidence,
						JSON.stringify(finding.evidenceIds),
						JSON.stringify(finding.targetPromptIds),
						finding.recommendation,
						metricId,
					],
				);
			else
				await transaction.query(
					`INSERT INTO diagnosis_findings
					 (id,project_id,batch_id,category,title,detail,confidence,evidence_ids,target_prompt_ids,recommendation,metric_snapshot_id)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
					[
						findingId,
						batch.project_id,
						batchId,
						finding.category,
						finding.title,
						finding.detail,
						finding.confidence,
						JSON.stringify(finding.evidenceIds),
						JSON.stringify(finding.targetPromptIds),
						finding.recommendation,
						metricId,
					],
				);
		}
		if (retainedIds.length)
			await transaction.query(
				"DELETE FROM diagnosis_findings WHERE batch_id=$1 AND metric_snapshot_id=$3 AND NOT (id=ANY($2::text[]))",
				[batchId, retainedIds, metricId],
			);
	});
	return { count: findings.length, method: "evidence_rules" };
}

function expectedMetricForFinding(category: string): string {
	if (category.includes("技术")) return "官网审计阻断项通过，技术可读性分数提高";
	if (category.includes("信源")) return "关联问题的官网引用率提高";
	if (category.includes("内容")) return "关联问题的客户页面主题覆盖增加，并进入同条件复测";
	return "关联问题的品牌首位推荐率或明确推荐名次中位数改善";
}

function acceptanceCriteriaForFinding(category: string): string {
	return category.includes("技术")
		? "修复后重新运行官网审计，HTTPS 与访问阻断项必须有新的通过证据"
		: "发布真实页面并抓取快照验收，再按原批次冻结条件创建复测";
}

export async function createTasksFromFindings(
	database: Database,
	projectId: string,
	batchId: string,
): Promise<{ count: number }> {
	return database.transaction(async (tx) => {
		await tx.query("SELECT id FROM experiment_batches WHERE id=$1 AND project_id=$2 FOR UPDATE", [batchId, projectId]);
		return createTasksFromFindingsLocked(tx, projectId, batchId);
	});
}

async function createTasksFromFindingsLocked(
	database: Database,
	projectId: string,
	batchId: string,
): Promise<{ count: number }> {
	const measurement = await currentMeasurement(database, batchId);
	const findings = await database.query<Record<string, unknown>>(
		"SELECT * FROM diagnosis_findings WHERE project_id = $1 AND batch_id = $2 AND metric_snapshot_id=$3 ORDER BY confidence DESC",
		[projectId, batchId, measurement.snapshotId],
	);
	if (findings.rows.length === 0) throw new HttpInputError("请先生成有证据关联的诊断", 409);
	const captures = await database.query<{ id: string; prompt_id: string }>(
		"SELECT id,prompt_id FROM query_captures WHERE batch_id=$1",
		[batchId],
	);
	let count = 0;
	for (const finding of findings.rows) {
		if (String(finding.category).includes("优势")) continue;
		const evidenceIds = parseJsonColumn<string[]>(finding.evidence_ids as string[] | string);
		const targetPromptIds = [
			...new Set(
				[
					...parseJsonColumn<string[]>((finding.target_prompt_ids ?? []) as string[] | string),
					...captures.rows.filter((capture) => evidenceIds.includes(capture.id)).map((capture) => capture.prompt_id),
				].filter(Boolean),
			),
		];
		const category = String(finding.category);
		const expectedMetric = expectedMetricForFinding(category);
		const acceptanceCriteria = acceptanceCriteriaForFinding(category);
		const existing = (
			await database.query<{ id: string }>("SELECT id FROM remediation_tasks WHERE finding_id = $1", [finding.id])
		).rows[0];
		if (existing) {
			await database.query(
				`UPDATE remediation_tasks SET title=$2,detail=$3,priority=$4,target_prompt_ids=$5::jsonb,
				 evidence_ids=$6::jsonb,expected_metric=$7,acceptance_criteria=$8,updated_at=now() WHERE id=$1`,
				[
					existing.id,
					finding.title,
					finding.recommendation,
					Number(finding.confidence) >= 0.8 ? "high" : "medium",
					JSON.stringify(targetPromptIds),
					JSON.stringify(evidenceIds),
					expectedMetric,
					acceptanceCriteria,
				],
			);
			continue;
		}
		await database.query(
			`INSERT INTO remediation_tasks (id,project_id,finding_id,title,detail,priority,status,target_prompt_ids,evidence_ids,expected_metric,acceptance_criteria,metric_snapshot_id)
			 VALUES ($1,$2,$3,$4,$5,$6,'todo',$7::jsonb,$8::jsonb,$9,$10,$11)`,
			[
				randomUUID(),
				projectId,
				finding.id,
				finding.title,
				finding.recommendation,
				Number(finding.confidence) >= 0.8 ? "high" : "medium",
				JSON.stringify(targetPromptIds),
				JSON.stringify(evidenceIds),
				expectedMetric,
				acceptanceCriteria,
				measurement.snapshotId,
			],
		);
		count += 1;
	}
	return { count };
}

const taskUpdateSchema = z.object({
	status: z.enum(["todo", "in_progress", "published", "verified", "done"]).optional(),
	owner: z.string().nullable().optional(),
	dueDate: z.string().datetime().nullable().optional(),
	publishedUrl: z.url().nullable().optional(),
	contentBrief: z.string().nullable().optional(),
	draftContent: z.string().nullable().optional(),
});

export async function updateTask(database: Database, taskId: string, input: unknown): Promise<void> {
	const data = taskUpdateSchema.parse(input);
	if (data.status === "verified") throw new HttpInputError("「已验收」只能由抓取验收或审计验收写入，不能手工选择", 409);
	await database.query(
		`UPDATE remediation_tasks SET status = COALESCE($2,status), owner = CASE WHEN $3::boolean THEN $4 ELSE owner END,
		 due_date = CASE WHEN $5::boolean THEN $6::timestamptz ELSE due_date END,
		 published_url = CASE WHEN $7::boolean THEN $8 ELSE published_url END,
		 content_brief = CASE WHEN $9::boolean THEN $10 ELSE content_brief END,
		 draft_content = CASE WHEN $11::boolean THEN $12 ELSE draft_content END, updated_at = now() WHERE id = $1`,
		[
			taskId,
			data.status ?? null,
			"owner" in data,
			data.owner ?? null,
			"dueDate" in data,
			data.dueDate ?? null,
			"publishedUrl" in data,
			data.publishedUrl ?? null,
			"contentBrief" in data,
			data.contentBrief ?? null,
			"draftContent" in data,
			data.draftContent ?? null,
		],
	);
}

export async function deleteTask(database: Database, taskId: string): Promise<void> {
	await database.query("DELETE FROM remediation_tasks WHERE id=$1", [taskId]);
}

export type TaskVerificationMode = "audit" | "publish";

/**
 * 验收方式由任务来源决定：官网技术类结论（诊断类别含“技术”，或验收标准要求重跑官网审计）用审计验收，
 * 其余任务必须发布真实页面后抓取快照验收。规则只在这里定义，前端按 `verification_mode` 展示入口。
 */
export function taskVerificationMode(task: {
	acceptance_criteria?: unknown;
	finding_category?: unknown;
}): TaskVerificationMode {
	const category = typeof task.finding_category === "string" ? task.finding_category : "";
	const criteria = typeof task.acceptance_criteria === "string" ? task.acceptance_criteria : "";
	return category.includes("技术") || criteria.includes("官网审计") ? "audit" : "publish";
}

/** 发布地址必须在客户官网域名（含子域名）下：第三方页面抓得通也不能作为官网整改的验收证据。 */
export function publishedUrlBelongsToProject(publishedUrl: string, projectDomain: string): boolean {
	const host = tryNormalizeDomain(publishedUrl);
	const domain = tryNormalizeDomain(projectDomain);
	if (!host || !domain) return false;
	return host === domain || host.endsWith(`.${domain}`);
}

export async function verifyTask(
	database: Database,
	taskId: string,
): Promise<{ mode: TaskVerificationMode; snapshotId: string | null; auditId: string | null }> {
	const task = (
		await database.query<Record<string, unknown>>(
			`SELECT t.*,f.category AS finding_category,p.domain AS project_domain FROM remediation_tasks t
			 LEFT JOIN diagnosis_findings f ON f.id=t.finding_id JOIN projects p ON p.id=t.project_id WHERE t.id=$1`,
			[taskId],
		)
	).rows[0];
	if (!task) throw new HttpInputError("整改任务不存在", 404);
	const projectId = String(task.project_id);
	if (taskVerificationMode(task) === "audit") {
		const audit = await auditProject(database, projectId);
		if (
			audit.result.verdict === "blocked" ||
			audit.result.checks.some((check) => ["A1", "A2", "A3"].includes(check.id) && check.status !== "pass")
		)
			throw new HttpInputError(
				`官网审计仍有阻断项（得分 ${audit.result.score}），技术整改未通过验收，请修复后重试`,
				409,
			);
		await database.query(
			"UPDATE remediation_tasks SET status = 'verified', verified_audit_id = $2, completed_at = now(), updated_at = now() WHERE id = $1",
			[taskId, audit.id],
		);
		return { mode: "audit", snapshotId: null, auditId: audit.id };
	}
	if (!task.published_url) throw new HttpInputError("请先填写真实发布URL", 409);
	const projectDomain = normalizeDomain(String(task.project_domain));
	if (!publishedUrlBelongsToProject(String(task.published_url), projectDomain))
		throw new HttpInputError(`发布地址必须位于客户官网域名 ${projectDomain} 下，第三方页面不能作为验收证据`, 409);
	const snapshot = await crawlPublishedUrl(database, projectId, String(task.published_url));
	if (!publishedUrlBelongsToProject(snapshot.url, projectDomain))
		throw new HttpInputError("发布地址重定向到了客户官网域名以外，不能通过验收", 409);
	await database.query(
		"UPDATE remediation_tasks SET status = 'verified', verified_snapshot_id = $2, completed_at = now(), updated_at = now() WHERE id = $1",
		[taskId, snapshot.id],
	);
	return { mode: "publish", snapshotId: snapshot.id, auditId: null };
}
