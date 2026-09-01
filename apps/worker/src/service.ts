import { randomUUID } from "node:crypto";
import {
	areBatchConfigsComparable,
	type CaptureJobPayload,
	type Database,
	enqueueCaptureJob,
	type FrozenBatchConfig,
	type SearchProviderId,
	searchProviderIds,
	type WebsiteAuditResult,
} from "@geo/core";
import { type QueryCapture, type QueryCaptureV2, queryCaptureSchema, queryCaptureV2Schema } from "@geo/evidence";
import { calculateEqualWeightedOverall, calculateVisibilityMetrics } from "@geo/metrics";
import { z } from "zod";
import { auditWebsite, crawlPublishedUrl, crawlWebsite } from "./crawler";
import { analyzeCustomer } from "./hrouter";
import { type Paginated, type PaginationInput, paginated } from "./pagination";
import { providerDefinitions } from "./providers";
import { buildDeterministicFindings, buildReportAnalysis, type DiagnosisWebEvidence } from "./report";
import { normalizeDomain, parseJsonColumn, sha256, stableJson } from "./utils";

export const currentRunnerVersion = "cloud-runner.v1";

const projectInputSchema = z.object({
	name: z.string().trim().min(1),
	websiteUrl: z.url(),
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
): Promise<{ id: string }> {
	const data = projectInputSchema.parse(input);
	const id = randomUUID();
	const url = new URL(data.websiteUrl);
	await database.query(
		`INSERT INTO projects (id,organization_id,name,website_url,domain,region,language,business_focus,industry,aliases,status)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'draft')`,
		[
			id,
			organizationId,
			data.name,
			url.href,
			normalizeDomain(url.href),
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
	return { id };
}

export async function getProject(database: Database, id: string): Promise<Record<string, unknown> | null> {
	const project = (await database.query<Record<string, unknown>>("SELECT * FROM projects WHERE id = $1", [id])).rows[0];
	if (!project) return null;
	const [competitors, prompts, batches, tasks, findings, audits, schedule] = await Promise.all([
		database.query("SELECT * FROM competitors WHERE project_id = $1 AND archived_at IS NULL ORDER BY created_at", [id]),
		database.query("SELECT * FROM prompts WHERE project_id = $1 AND archived_at IS NULL ORDER BY position", [id]),
		database.query("SELECT * FROM experiment_batches WHERE project_id = $1 ORDER BY created_at DESC", [id]),
		database.query("SELECT * FROM remediation_tasks WHERE project_id = $1 ORDER BY created_at DESC", [id]),
		database.query("SELECT * FROM diagnosis_findings WHERE project_id = $1 ORDER BY created_at DESC", [id]),
		database.query("SELECT * FROM website_audits WHERE project_id = $1 ORDER BY checked_at DESC LIMIT 10", [id]),
		database.query("SELECT * FROM monitoring_schedules WHERE project_id=$1", [id]),
	]);
	return {
		...project,
		competitors: competitors.rows,
		prompts: prompts.rows,
		batches: batches.rows,
		tasks: tasks.rows,
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
	if (!project) throw new Error("客户项目不存在");
	const aliases = parseJsonColumn<string[]>(project.aliases as string[] | string);
	return auditWebsite(database, projectId, String(project.website_url), [
		...new Set([String(project.name), ...aliases]),
	]);
}

export async function analyzeProject(database: Database, id: string): Promise<Record<string, unknown>> {
	const project = (await database.query<Record<string, unknown>>("SELECT * FROM projects WHERE id = $1", [id])).rows[0];
	if (!project) throw new Error("客户项目不存在");
	if (project.status === "active") throw new Error("运行中的项目请在项目总览更新监测范围，旧证据不会被覆盖");
	const knownSetting = (
		await database.query<{ value: string[] | string }>("SELECT value FROM settings WHERE key = $1", [
			`project:${id}:known_competitors`,
		])
	).rows[0];
	const pages = await crawlWebsite(database, id, String(project.website_url), 100);
	const analysis = await analyzeCustomer(database, {
		organizationId: String(project.organization_id),
		name: String(project.name),
		websiteUrl: String(project.website_url),
		region: String(project.region),
		language: String(project.language),
		businessFocus: project.business_focus ? String(project.business_focus) : null,
		knownCompetitors: knownSetting ? parseJsonColumn<string[]>(knownSetting.value) : [],
		pages,
	});
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
		for (const competitor of analysis.competitors) {
			await transaction.query(
				"INSERT INTO competitors (id,project_id,name,domain,aliases,approved) VALUES ($1,$2,$3,$4,$5::jsonb,false)",
				[randomUUID(), id, competitor.name, normalizeDomain(competitor.domain), JSON.stringify(competitor.aliases)],
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
	return {
		...analysis,
		prompts: proposedPrompts,
		libraryQuestionCount: libraryQuestions.length,
		crawledPages: pages.length,
	};
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

export async function confirmProject(database: Database, id: string, input: unknown): Promise<void> {
	const data = reviewSchema.parse(input);
	const referencedLibraryIds = data.prompts.flatMap((prompt) => {
		const questionId = prompt.libraryQuestionId ?? prompt.library_question_id;
		return questionId ? [questionId] : [];
	});
	if (referencedLibraryIds.length) {
		const allowed = await database.query<{ id: string }>(
			`SELECT q.id FROM prompt_library_questions q JOIN projects p ON p.organization_id=q.organization_id
			 WHERE p.id=$1 AND q.archived_at IS NULL AND q.id=ANY($2::text[])`,
			[id, referencedLibraryIds],
		);
		if (new Set(allowed.rows.map((row) => row.id)).size !== new Set(referencedLibraryIds).size)
			throw new Error("监测问题引用了其他机构或已归档的知识库记录");
	}
	await database.transaction(async (transaction) => {
		// Monitoring scope is versioned: old rows stay available to immutable captures and frozen batches.
		await transaction.query(
			"UPDATE competitors SET approved=false,archived_at=now() WHERE project_id=$1 AND archived_at IS NULL",
			[id],
		);
		await transaction.query(
			"UPDATE prompts SET approved=false,archived_at=now() WHERE project_id=$1 AND archived_at IS NULL",
			[id],
		);
		for (const competitor of data.competitors) {
			await transaction.query(
				"INSERT INTO competitors (id,project_id,name,domain,aliases,approved) VALUES ($1,$2,$3,$4,$5::jsonb,true)",
				[randomUUID(), id, competitor.name, normalizeDomain(competitor.domain), JSON.stringify(competitor.aliases)],
			);
		}
		for (const [position, prompt] of data.prompts.entries()) {
			await transaction.query(
				`INSERT INTO prompts (id,project_id,library_question_id,question,intent,topic,persona,tags,approved,position)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true,$9)`,
				[
					randomUUID(),
					id,
					prompt.libraryQuestionId ?? prompt.library_question_id ?? null,
					prompt.question,
					prompt.intent,
					prompt.topic ?? null,
					prompt.persona ?? null,
					JSON.stringify(prompt.tags),
					position,
				],
			);
		}
		await transaction.query(
			"UPDATE projects SET aliases = $2::jsonb, status = 'active', confirmed_at = now(), updated_at = now() WHERE id = $1",
			[id, JSON.stringify(data.aliases)],
		);
	});
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Baseline and retest invariants must be evaluated together before any jobs are created.
export async function createBatch(
	database: Database,
	projectId: string,
	input: unknown,
): Promise<{ id: string; jobCount: number }> {
	const data = batchInputSchema.parse(input);
	const repeats = data.repeats ?? (data.kind === "quick_audit" ? 1 : 3);
	if (data.kind === "quick_audit" && repeats !== 1) throw new Error("售前快审固定每平台每题采样 1 次");
	const project = (await database.query<Record<string, unknown>>("SELECT * FROM projects WHERE id = $1", [projectId]))
		.rows[0];
	if (project?.status !== "active") throw new Error("客户配置尚未人工确认，不能开始采集");
	let config: FrozenBatchConfig;
	if (data.kind === "retest") {
		if (!data.compareToBatchId) throw new Error("复测必须选择一个基线批次");
		const baseline = (
			await database.query<{ config: FrozenBatchConfig | string }>(
				"SELECT config FROM experiment_batches WHERE id = $1 AND project_id = $2 AND kind='baseline'",
				[data.compareToBatchId, projectId],
			)
		).rows[0];
		if (!baseline) throw new Error("复测只能选择正式基线批次");
		config = parseJsonColumn(baseline.config);
		if (
			!config.providers?.length ||
			config.providers.some((provider) => !provider.endpoint || !provider.adapterVersion)
		)
			throw new Error("所选基线缺少完整的云端 Provider 冻结契约，请先创建新的正式基线");
	} else {
		const competitors = await database.query<Record<string, unknown>>(
			"SELECT * FROM competitors WHERE project_id = $1 AND approved = true AND archived_at IS NULL ORDER BY created_at",
			[projectId],
		);
		const prompts = await database.query<Record<string, unknown>>(
			"SELECT * FROM prompts WHERE project_id = $1 AND approved = true AND archived_at IS NULL ORDER BY position",
			[projectId],
		);
		if (prompts.rows.length === 0) throw new Error("至少确认一个监测问题");
		const enabledProviders = await database.query<Record<string, unknown>>(
			"SELECT * FROM provider_configs WHERE organization_id=$1 AND enabled=true AND provider_id=ANY($2::text[])",
			[project.organization_id, data.platforms],
		);
		const enabledIds = new Set(enabledProviders.rows.map((row) => String(row.provider_id)));
		const missing = data.platforms.filter((providerId) => !enabledIds.has(providerId));
		if (missing.length)
			throw new Error(`以下监测平台尚未启用：${missing.map((id) => providerDefinitions[id].label).join("、")}`);
		const windowMinutes =
			data.kind === "quick_audit"
				? [0]
				: data.executionWindowMinutes?.length === repeats
					? data.executionWindowMinutes
					: Array.from({ length: repeats }, (_, index) => [0, 240, 1440][index] ?? index * 1440);
		config = {
			project: {
				name: String(project.name),
				domain: String(project.domain),
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
			platforms: [...new Set(data.platforms)],
			repeats,
			runnerVersion: currentRunnerVersion,
			samplingMode: data.kind === "quick_audit" ? "quick" : "formal",
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
					adapterVersion: String(row.adapter_version),
				};
			}),
		};
	}
	const id = randomUUID();
	const configHash = sha256(stableJson(config));
	await database.query(
		"INSERT INTO experiment_batches (id,project_id,kind,compare_to_batch_id,status,config,config_hash,started_at) VALUES ($1,$2,$3,$4,'queued',$5::jsonb,$6,now())",
		[id, projectId, data.kind, data.compareToBatchId ?? null, JSON.stringify(config), configHash],
	);
	let jobCount = 0;
	const brands = [
		{ id: projectId, name: config.project.name, aliases: config.project.aliases },
		...config.competitors.map((item) => ({ id: item.id, name: item.name, aliases: item.aliases })),
	];
	for (const prompt of config.prompts)
		for (const platform of config.platforms)
			for (let attempt = 1; attempt <= config.repeats; attempt += 1) {
				const payload: CaptureJobPayload = {
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

export async function saveMonitoringSchedule(database: Database, projectId: string, input: unknown): Promise<void> {
	const data = scheduleSchema.parse(input);
	const project = (await database.query<{ status: string }>("SELECT status FROM projects WHERE id=$1", [projectId]))
		.rows[0];
	if (project?.status !== "active") throw new Error("客户项目未启用，不能设置自动监测");
	const nextRunAt = data.enabled ? new Date(Date.now() + data.frequencyDays * 86_400_000).toISOString() : null;
	await database.query(
		`INSERT INTO monitoring_schedules (id,project_id,enabled,frequency_days,platforms,repeats,sampling_mode,execution_windows,next_run_at)
		 VALUES ($1,$2,$3,$4,$5::jsonb,$6,'formal',$7::jsonb,$8)
		 ON CONFLICT (project_id) DO UPDATE SET enabled=excluded.enabled,frequency_days=excluded.frequency_days,
		 platforms=excluded.platforms,repeats=excluded.repeats,sampling_mode='formal',execution_windows=excluded.execution_windows,next_run_at=CASE
		 WHEN monitoring_schedules.enabled=false AND excluded.enabled=true THEN excluded.next_run_at
		 WHEN excluded.enabled=false THEN NULL ELSE monitoring_schedules.next_run_at END,updated_at=now()`,
		[
			randomUUID(),
			projectId,
			data.enabled,
			data.frequencyDays,
			JSON.stringify(data.platforms),
			data.repeats,
			JSON.stringify(
				(
					data.executionWindowMinutes ??
					Array.from({ length: data.repeats }, (_, index) => [0, 240, 1440][index] ?? index * 1440)
				).map((minutes) => `PT${minutes}M`),
			),
			nextRunAt,
		],
	);
}

export async function processDueSchedules(database: Database): Promise<number> {
	const due = await database.query<Record<string, unknown>>(
		`SELECT * FROM monitoring_schedules WHERE enabled=true AND next_run_at<=now()
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
			const scheduledPlatforms = parseJsonColumn<SearchProviderId[]>(schedule.platforms as string);
			const repeats = Number(schedule.repeats);
			const latestBaseline = (
				await database.query<{ id: string; config: FrozenBatchConfig | string }>(
					`SELECT id,config FROM experiment_batches
					 WHERE project_id=$1 AND kind='baseline' AND status='complete' ORDER BY completed_at DESC LIMIT 1`,
					[projectId],
				)
			).rows[0];
			const baselineConfig = latestBaseline ? parseJsonColumn<FrozenBatchConfig>(latestBaseline.config) : null;
			const matchesSchedule =
				baselineConfig?.repeats === repeats &&
				JSON.stringify([...baselineConfig.platforms].sort()) === JSON.stringify([...scheduledPlatforms].sort());
			const batch = await createBatch(
				database,
				projectId,
				matchesSchedule && latestBaseline
					? { kind: "retest", compareToBatchId: latestBaseline.id }
					: {
							kind: "baseline",
							platforms: scheduledPlatforms,
							repeats,
							executionWindowMinutes: parseJsonColumn<string[]>(schedule.execution_windows as string).map((value) =>
								Number(value.match(/^PT(\d+)M$/)?.[1] ?? 0),
							),
						},
			);
			await database.query(
				`UPDATE monitoring_schedules SET last_run_at=now(),last_batch_id=$2,
				 next_run_at=now()+($3::text||' days')::interval,updated_at=now() WHERE id=$1`,
				[schedule.id, batch.id, Number(schedule.frequency_days)],
			);
			created += 1;
		} catch {
			await database.query(
				"UPDATE monitoring_schedules SET next_run_at=now()+interval '1 hour',updated_at=now() WHERE id=$1",
				[schedule.id],
			);
		}
	}
	return created;
}

function captureFromRow(row: Record<string, unknown>): QueryCapture {
	const common = {
		schemaVersion: row.schema_version ?? "geo.query-capture.v1",
		captureId: row.id,
		jobId: row.job_id,
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
	const perPlatform = Object.fromEntries(
		config.platforms.map((surface) => [
			surface,
			calculateVisibilityMetrics({
				captures: captures.filter((capture) => capture.engine === surface),
				targetBrandId: String(batch.project_id),
				targetDomains: [config.project.domain],
				competitorBrandIds: config.competitors.map((item) => item.id),
			}),
		]),
	);
	return {
		...batch,
		config,
		captures,
		metrics: {
			perPlatform,
			overall: calculateEqualWeightedOverall(Object.values(perPlatform)),
			validSamples: captures.filter((capture) => capture.status === "complete").length,
			failedSamples: captures.filter((capture) => capture.status !== "complete").length,
			expectedSamples: config.prompts.length * config.platforms.length * config.repeats,
		},
	};
}

async function latestWebsiteAudit(
	database: Database,
	projectId: string,
): Promise<{ id: string; result: WebsiteAuditResult } | null> {
	const row = (
		await database.query<Record<string, unknown>>(
			"SELECT id,result FROM website_audits WHERE project_id=$1 ORDER BY checked_at DESC LIMIT 1",
			[projectId],
		)
	).rows[0];
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
	const [websiteAudit, findings, tasks, attributionSummary, webEvidence] = await Promise.all([
		latestWebsiteAudit(database, projectId),
		database.query("SELECT * FROM diagnosis_findings WHERE batch_id=$1 ORDER BY confidence DESC,created_at", [batchId]),
		database.query(
			`SELECT t.* FROM remediation_tasks t JOIN diagnosis_findings f ON f.id=t.finding_id
			 WHERE f.batch_id=$1 ORDER BY CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,t.created_at`,
			[batchId],
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
	const rows = await database.query<{ id: string }>(
		`SELECT id FROM experiment_batches WHERE project_id=$1 AND config_hash=$2
		 AND status IN ('complete','partial') ORDER BY created_at ASC LIMIT 50`,
		[projectId, anchor.config_hash],
	);
	const batches = (await Promise.all(rows.rows.map((row) => getBatch(database, row.id)))).filter(Boolean) as Array<
		Record<string, unknown>
	>;
	return {
		anchorBatchId: anchor.id,
		configHash: anchor.config_hash,
		comparable: batches.map((batch) => ({
			id: batch.id,
			kind: batch.kind,
			createdAt: batch.created_at,
			completedAt: batch.completed_at,
			metrics: batch.metrics,
		})),
	};
}

export async function storeCloudCapture(database: Database, captureInput: unknown): Promise<void> {
	const capture: QueryCaptureV2 = queryCaptureV2Schema.parse(captureInput);
	const job = (await database.query<Record<string, unknown>>("SELECT * FROM jobs WHERE id=$1", [capture.jobId]))
		.rows[0];
	if (!job || job.lease_owner !== capture.executorId || job.status !== "leased")
		throw new Error("云端采集任务租约无效或已过期");
	const payload = job.payload as CaptureJobPayload;
	await database.transaction(async (transaction) => {
		// Raw API evidence is append-only; reparsing creates derived rows and never rewrites this capture.
		await transaction.query(
			`INSERT INTO query_captures
			 (id,job_id,batch_id,project_id,prompt_id,platform,attempt,status,answer_text,brand_matches,sources,
			 query_fan_out,page_url,content_hash,adapter_version,failure_code,failure_message,captured_at,
			 schema_version,capture_mode,model,protocol,search_tool_version,source_visibility,fanout_visibility,
			 raw_artifact_key,provider_request_id,usage,cost_micros,latency_ms,executor_id)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,
			 $19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29,$30,$31)`,
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
			 FROM jobs WHERE payload->>'batchId' = $1`,
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
		if (finalized.rows.length) await detectDriftAlerts(database, batchId);
	} else
		await database.query("UPDATE experiment_batches SET status = 'running' WHERE id = $1 AND status = 'queued'", [
			batchId,
		]);
}

async function detectDriftAlerts(database: Database, batchId: string): Promise<void> {
	const current = await getBatch(database, batchId);
	if (!current || current.kind !== "retest" || !current.compare_to_batch_id) return;
	const baseline = await getBatch(database, String(current.compare_to_batch_id));
	if (
		!baseline ||
		!areBatchConfigsComparable(current.config as FrozenBatchConfig, baseline.config as FrozenBatchConfig)
	)
		return;
	const currentMetrics = (current.metrics as { perPlatform: Record<string, Record<string, number | null>> })
		.perPlatform;
	const baselineMetrics = (baseline.metrics as { perPlatform: Record<string, Record<string, number | null>> })
		.perPlatform;
	for (const providerId of (current.config as FrozenBatchConfig).platforms) {
		for (const metric of ["brandMentionRate", "brandShareOfVoice", "citationRate"] as const) {
			const previous = baselineMetrics[providerId]?.[metric];
			const next = currentMetrics[providerId]?.[metric];
			if (typeof previous !== "number" || typeof next !== "number") continue;
			const delta = next - previous;
			if (delta > -0.1) continue;
			const evidenceIds = (current.captures as QueryCapture[])
				.filter((capture) => capture.engine === providerId)
				.map((capture) => capture.captureId);
			await database.query(
				`INSERT INTO drift_alerts
				 (id,project_id,batch_id,provider_id,metric,previous_value,current_value,severity,evidence_ids)
				 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
				 WHERE NOT EXISTS (SELECT 1 FROM drift_alerts WHERE batch_id=$3 AND provider_id=$4 AND metric=$5)`,
				[
					randomUUID(),
					current.project_id,
					batchId,
					providerId,
					metric,
					previous,
					next,
					delta <= -0.2 ? "high" : "warning",
					JSON.stringify(evidenceIds),
				],
			);
		}
	}
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
	if (result.affectedRows !== 1) throw new Error("漂移告警不存在");
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
	const citationUrls = new Set(captures.flatMap((capture) => capture.sources.map((source) => source.url)));
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
		if (project)
			try {
				await crawlWebsite(database, projectId, project.website_url, 30);
			} catch {
				// A missing customer crawl remains evidence-insufficient and is never treated as absent content.
			}
	}
	const targets = [
		...config.competitors.map((competitor) => `https://${competitor.domain}/`),
		...[...new Set(captures.flatMap((capture) => capture.sources.map((source) => source.url)))]
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
	if (!batch) throw new Error("采集批次不存在");
	const captures = batch.captures as QueryCapture[];
	const valid = captures.filter((capture) => capture.status === "complete");
	if (valid.length === 0) throw new Error("证据不足：当前批次没有成功采集的真实回答");
	const config = batch.config as FrozenBatchConfig;
	let websiteAudit = await latestWebsiteAudit(database, String(batch.project_id));
	if (!websiteAudit) {
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
		const existing = await transaction.query<{ id: string; category: string; title: string }>(
			"SELECT id,category,title FROM diagnosis_findings WHERE batch_id=$1",
			[batchId],
		);
		const retainedIds: string[] = [];
		for (const finding of findings) {
			if (!finding.evidenceIds.every((id) => validIds.has(id)))
				throw new Error("诊断引用了不存在的证据，结果已拒绝写入");
			if (!finding.targetPromptIds.every((id) => validPromptIds.has(id)))
				throw new Error("诊断引用了不存在的问题，结果已拒绝写入");
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
					],
				);
			else
				await transaction.query(
					`INSERT INTO diagnosis_findings
					 (id,project_id,batch_id,category,title,detail,confidence,evidence_ids,target_prompt_ids,recommendation)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
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
					],
				);
		}
		if (retainedIds.length)
			await transaction.query("DELETE FROM diagnosis_findings WHERE batch_id=$1 AND NOT (id=ANY($2::text[]))", [
				batchId,
				retainedIds,
			]);
	});
	return { count: findings.length, method: "evidence_rules" };
}

function expectedMetricForFinding(category: string): string {
	if (category.includes("技术")) return "官网审计阻断项通过，技术可读性分数提高";
	if (category.includes("信源")) return "关联问题的官网引用率提高";
	if (category.includes("内容")) return "关联问题的客户页面主题覆盖增加，并进入同条件复测";
	return "关联问题的品牌首位推荐率或平均位置改善";
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
	const findings = await database.query<Record<string, unknown>>(
		"SELECT * FROM diagnosis_findings WHERE project_id = $1 AND batch_id = $2 ORDER BY confidence DESC",
		[projectId, batchId],
	);
	if (findings.rows.length === 0) throw new Error("请先生成有证据关联的诊断");
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
			`INSERT INTO remediation_tasks (id,project_id,finding_id,title,detail,priority,status,target_prompt_ids,evidence_ids,expected_metric,acceptance_criteria)
			 VALUES ($1,$2,$3,$4,$5,$6,'todo',$7::jsonb,$8::jsonb,$9,$10)`,
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

export async function verifyTask(database: Database, taskId: string): Promise<{ snapshotId: string }> {
	const task = (
		await database.query<Record<string, unknown>>("SELECT * FROM remediation_tasks WHERE id = $1", [taskId])
	).rows[0];
	if (!task?.published_url) throw new Error("请先填写真实发布URL");
	const snapshot = await crawlPublishedUrl(database, String(task.project_id), String(task.published_url));
	await database.query(
		"UPDATE remediation_tasks SET status = 'verified', verified_snapshot_id = $2, completed_at = now(), updated_at = now() WHERE id = $1",
		[taskId, snapshot.id],
	);
	return { snapshotId: snapshot.id };
}
