import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type CaptureJobPayload,
	type Database,
	enqueueCaptureJob,
	type FrozenBatchConfig,
	geoPaths,
	type WebsiteAuditResult,
} from "@geo/core";
import { type QueryCapture, queryCaptureSchema } from "@geo/evidence";
import { calculateEqualWeightedOverall, calculateVisibilityMetrics } from "@geo/metrics";
import { currentCollectorVersion } from "@geo/surface-adapters";
import { z } from "zod";
import { auditWebsite, crawlPublishedUrl, crawlWebsite } from "./crawler";
import { analyzeCustomer, deepSeekStructured } from "./deepseek";
import {
	buildDeterministicFindings,
	buildReportAnalysis,
	type DiagnosisWebEvidence,
	type ReportFinding,
} from "./report";
import { normalizeDomain, parseJsonColumn, sha256, stableJson } from "./utils";

const projectInputSchema = z.object({
	name: z.string().trim().min(1),
	websiteUrl: z.url(),
	region: z.string().trim().min(1),
	language: z.string().trim().min(1),
	businessFocus: z.string().trim().optional().nullable(),
	aliases: z.array(z.string().trim().min(1)).default([]),
	knownCompetitors: z.array(z.string().trim().min(1)).default([]),
});

export async function listProjects(database: Database): Promise<unknown[]> {
	const result = await database.query(
		`SELECT p.*, count(DISTINCT b.id)::int AS batch_count, max(b.created_at) AS last_batch_at
		 FROM projects p LEFT JOIN experiment_batches b ON b.project_id = p.id
		 GROUP BY p.id ORDER BY p.updated_at DESC`,
	);
	return result.rows;
}

export async function createProject(database: Database, input: unknown): Promise<{ id: string }> {
	const data = projectInputSchema.parse(input);
	const id = randomUUID();
	const url = new URL(data.websiteUrl);
	await database.query(
		`INSERT INTO projects (id,name,website_url,domain,region,language,business_focus,aliases,status)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'draft')`,
		[
			id,
			data.name,
			url.href,
			normalizeDomain(url.href),
			data.region,
			data.language,
			data.businessFocus || null,
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
	const analysis = await analyzeCustomer({
		name: String(project.name),
		websiteUrl: String(project.website_url),
		region: String(project.region),
		language: String(project.language),
		businessFocus: project.business_focus ? String(project.business_focus) : null,
		knownCompetitors: knownSetting ? parseJsonColumn<string[]>(knownSetting.value) : [],
		pages,
	});
	await database.transaction(async (transaction) => {
		await transaction.query("DELETE FROM competitors WHERE project_id = $1", [id]);
		await transaction.query("DELETE FROM prompts WHERE project_id = $1", [id]);
		for (const competitor of analysis.competitors) {
			await transaction.query(
				"INSERT INTO competitors (id,project_id,name,domain,aliases,approved) VALUES ($1,$2,$3,$4,$5::jsonb,false)",
				[randomUUID(), id, competitor.name, normalizeDomain(competitor.domain), JSON.stringify(competitor.aliases)],
			);
		}
		for (const [position, prompt] of analysis.prompts.entries()) {
			await transaction.query(
				"INSERT INTO prompts (id,project_id,question,intent,tags,approved,position) VALUES ($1,$2,$3,$4,$5::jsonb,false,$6)",
				[randomUUID(), id, prompt.question, prompt.intent, JSON.stringify(prompt.tags), position],
			);
		}
		await transaction.query(
			"UPDATE projects SET profile = $2::jsonb, status = 'review', updated_at = now() WHERE id = $1",
			[id, JSON.stringify(analysis.profile)],
		);
	});
	return { ...analysis, crawledPages: pages.length };
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
				question: z.string().trim().min(4),
				intent: z.string().trim().min(1),
				tags: z.array(z.string().trim().min(1)).default([]),
			}),
		)
		.min(1)
		.max(100),
});

export async function confirmProject(database: Database, id: string, input: unknown): Promise<void> {
	const data = reviewSchema.parse(input);
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
				"INSERT INTO prompts (id,project_id,question,intent,tags,approved,position) VALUES ($1,$2,$3,$4,$5::jsonb,true,$6)",
				[randomUUID(), id, prompt.question, prompt.intent, JSON.stringify(prompt.tags), position],
			);
		}
		await transaction.query(
			"UPDATE projects SET aliases = $2::jsonb, status = 'active', confirmed_at = now(), updated_at = now() WHERE id = $1",
			[id, JSON.stringify(data.aliases)],
		);
	});
}

const batchInputSchema = z.object({
	kind: z.enum(["baseline", "retest"]),
	compareToBatchId: z.string().optional().nullable(),
	platforms: z
		.array(z.enum(["deepseek", "kimi"]))
		.min(1)
		.default(["deepseek", "kimi"]),
	repeats: z.number().int().min(1).max(10).default(3),
});

export async function createBatch(
	database: Database,
	projectId: string,
	input: unknown,
): Promise<{ id: string; jobCount: number }> {
	const data = batchInputSchema.parse(input);
	const project = (await database.query<Record<string, unknown>>("SELECT * FROM projects WHERE id = $1", [projectId]))
		.rows[0];
	if (project?.status !== "active") throw new Error("客户配置尚未人工确认，不能开始采集");
	let config: FrozenBatchConfig;
	if (data.kind === "retest") {
		if (!data.compareToBatchId) throw new Error("复测必须选择一个基线批次");
		const baseline = (
			await database.query<{ config: FrozenBatchConfig | string }>(
				"SELECT config FROM experiment_batches WHERE id = $1 AND project_id = $2",
				[data.compareToBatchId, projectId],
			)
		).rows[0];
		if (!baseline) throw new Error("对比批次不存在");
		config = parseJsonColumn(baseline.config);
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
		config = {
			project: {
				name: String(project.name),
				domain: String(project.domain),
				region: String(project.region),
				language: String(project.language),
				aliases: parseJsonColumn<string[]>(project.aliases as string | string[]),
			},
			competitors: competitors.rows.map((row) => ({
				id: String(row.id),
				name: String(row.name),
				domain: String(row.domain),
				aliases: parseJsonColumn<string[]>(row.aliases as string | string[]),
			})),
			prompts: prompts.rows.map((row) => ({
				id: String(row.id),
				question: String(row.question),
				intent: String(row.intent),
				tags: parseJsonColumn<string[]>(row.tags as string | string[]),
			})),
			platforms: [...new Set(data.platforms)],
			repeats: data.repeats,
			collectorVersion: currentCollectorVersion,
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
				await enqueueCaptureJob(database, payload);
				jobCount += 1;
			}
	return { id, jobCount };
}

const scheduleSchema = z.object({
	enabled: z.boolean(),
	frequencyDays: z.number().int().min(1).max(90),
	platforms: z.array(z.enum(["deepseek", "kimi"])).min(1),
	repeats: z.number().int().min(1).max(10),
});

export async function saveMonitoringSchedule(database: Database, projectId: string, input: unknown): Promise<void> {
	const data = scheduleSchema.parse(input);
	const project = (await database.query<{ status: string }>("SELECT status FROM projects WHERE id=$1", [projectId]))
		.rows[0];
	if (project?.status !== "active") throw new Error("客户项目未启用，不能设置自动监测");
	const nextRunAt = data.enabled ? new Date(Date.now() + data.frequencyDays * 86_400_000).toISOString() : null;
	await database.query(
		`INSERT INTO monitoring_schedules (id,project_id,enabled,frequency_days,platforms,repeats,next_run_at)
		 VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
		 ON CONFLICT (project_id) DO UPDATE SET enabled=excluded.enabled,frequency_days=excluded.frequency_days,
		 platforms=excluded.platforms,repeats=excluded.repeats,next_run_at=CASE
		 WHEN monitoring_schedules.enabled=false AND excluded.enabled=true THEN excluded.next_run_at
		 WHEN excluded.enabled=false THEN NULL ELSE monitoring_schedules.next_run_at END,updated_at=now()`,
		[
			randomUUID(),
			projectId,
			data.enabled,
			data.frequencyDays,
			JSON.stringify(data.platforms),
			data.repeats,
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
			const batch = await createBatch(database, projectId, {
				kind: "baseline",
				platforms: parseJsonColumn<Array<"deepseek" | "kimi">>(schedule.platforms as string),
				repeats: Number(schedule.repeats),
			});
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
	return queryCaptureSchema.parse({
		schemaVersion: "geo.query-capture.v1",
		captureId: row.id,
		jobId: row.job_id,
		projectId: row.project_id,
		promptId: row.prompt_id,
		prompt: row.question,
		engine: row.platform,
		captureMode: "consumer_surface",
		attempt: row.attempt,
		capturedAt: new Date(String(row.captured_at)).toISOString(),
		locale: row.language,
		region: row.region,
		status: row.status,
		answerText: row.answer_text,
		brandMatches: parseJsonColumn(row.brand_matches),
		sources: parseJsonColumn(row.sources),
		queryFanOut: parseJsonColumn(row.query_fan_out),
		evidence: {
			captureNodeId: row.collector_node_id,
			screenshotObjectKey: row.screenshot_key,
			traceObjectKey: row.trace_key,
			pageUrl: row.page_url,
		},
		adapterVersion: row.adapter_version,
		contentHash: row.content_hash,
		failureCode: row.failure_code,
		failureMessage: row.failure_message,
	});
}

export async function getBatch(database: Database, batchId: string): Promise<Record<string, unknown> | null> {
	const batch = (
		await database.query<Record<string, unknown>>("SELECT * FROM experiment_batches WHERE id = $1", [batchId])
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

export async function storeCapture(
	database: Database,
	captureInput: unknown,
	screenshotBase64?: string,
): Promise<void> {
	const capture = queryCaptureSchema.parse(captureInput);
	const job = (await database.query<Record<string, unknown>>("SELECT * FROM jobs WHERE id = $1", [capture.jobId]))
		.rows[0];
	if (!job || job.lease_owner !== capture.evidence.captureNodeId || job.status !== "leased")
		throw new Error("采集任务租约无效或已过期");
	let screenshotKey = capture.evidence.screenshotObjectKey;
	if (screenshotBase64) {
		await mkdir(join(geoPaths.artifacts, "captures", capture.projectId), { recursive: true });
		screenshotKey = join("captures", capture.projectId, `${capture.captureId}.png`);
		await writeFile(join(geoPaths.artifacts, screenshotKey), Buffer.from(screenshotBase64, "base64"), { flag: "wx" });
	}
	await database.transaction(async (transaction) => {
		// Raw evidence is append-only: duplicate job submissions are rejected by the unique job constraint.
		await transaction.query(
			`INSERT INTO query_captures
			(id,job_id,batch_id,project_id,prompt_id,platform,attempt,status,answer_text,brand_matches,sources,query_fan_out,page_url,screenshot_key,trace_key,content_hash,adapter_version,collector_node_id,failure_code,failure_message,captured_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
			[
				capture.captureId,
				capture.jobId,
				(job.payload as CaptureJobPayload).batchId,
				capture.projectId,
				capture.promptId,
				capture.engine,
				capture.attempt,
				capture.status,
				capture.answerText,
				JSON.stringify(capture.brandMatches),
				JSON.stringify(capture.sources),
				JSON.stringify(capture.queryFanOut),
				capture.evidence.pageUrl,
				screenshotKey,
				capture.evidence.traceObjectKey,
				capture.contentHash,
				capture.adapterVersion,
				capture.evidence.captureNodeId,
				capture.failureCode,
				capture.failureMessage,
				capture.capturedAt,
			],
		);
		await transaction.query(
			"UPDATE jobs SET status = 'complete', lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1",
			[capture.jobId],
		);
	});
	await refreshBatchStatus(database, (job.payload as CaptureJobPayload).batchId);
}

export async function refreshBatchStatus(database: Database, batchId: string): Promise<void> {
	const counts = (
		await database.query<{ remaining: number; failed: number }>(
			`SELECT count(*) FILTER (WHERE status IN ('pending','leased'))::int AS remaining,
		 count(*) FILTER (WHERE status = 'failed')::int AS failed FROM jobs WHERE payload->>'batchId' = $1`,
			[batchId],
		)
	).rows[0];
	if (!counts) return;
	if (counts.remaining === 0)
		await database.query("UPDATE experiment_batches SET status = $2, completed_at = now() WHERE id = $1", [
			batchId,
			counts.failed > 0 ? "partial" : "complete",
		]);
	else
		await database.query("UPDATE experiment_batches SET status = 'running' WHERE id = $1 AND status = 'queued'", [
			batchId,
		]);
}

const diagnosisResultSchema = z.object({
	findings: z
		.array(
			z.object({
				category: z.string(),
				title: z.string(),
				detail: z.string(),
				confidence: z.number().min(0).max(1),
				evidenceIds: z.array(z.string()).min(1),
				targetPromptIds: z.array(z.string()).default([]),
				recommendation: z.string(),
			}),
		)
		.max(30),
});

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
	options: { enhanceWithModel?: boolean } = {},
): Promise<{ count: number; method: "evidence_rules" | "evidence_rules_and_model" }> {
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
	let modelFindings: ReportFinding[] = [];
	const webEvidence = await collectDiagnosisWebEvidence(database, String(batch.project_id), config, valid);
	const deterministic = buildDeterministicFindings({
		projectId: String(batch.project_id),
		config,
		captures,
		metrics: batch.metrics as BatchMetrics,
		websiteAudit,
		webEvidence,
	});
	if (options.enhanceWithModel) {
		const answerEvidence = valid.map((capture) => ({
			id: capture.captureId,
			platform: capture.engine,
			question: capture.prompt,
			answer: capture.answerText?.slice(0, 6000),
			sources: capture.sources,
		}));
		const result = await deepSeekStructured({
			name: "geo_diagnosis",
			validate: diagnosisResultSchema,
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["findings"],
				properties: {
					findings: {
						type: "array",
						maxItems: 30,
						items: {
							type: "object",
							additionalProperties: false,
							required: [
								"category",
								"title",
								"detail",
								"confidence",
								"evidenceIds",
								"targetPromptIds",
								"recommendation",
							],
							properties: {
								category: { type: "string" },
								title: { type: "string" },
								detail: { type: "string" },
								confidence: { type: "number", minimum: 0, maximum: 1 },
								evidenceIds: { type: "array", minItems: 1, items: { type: "string" } },
								targetPromptIds: { type: "array", items: { type: "string" } },
								recommendation: { type: "string" },
							},
						},
					},
				},
			},
			instructions:
				"你是严谨的GEO证据分析师。只能依据给定回答或网页快照的证据ID得出结论。比较客户官网、竞品官网和AI真实引用页的内容覆盖、第三方来源、实体一致性、Schema和可引用事实。每条结论必须引用至少一个真实证据ID，并只填写输入中存在的关联问题ID targetPromptIds；不能从黑盒排名反推出未经证实的因果。证据不足的领域不输出结论。建议必须可执行、可验收。",
			input: JSON.stringify({ project: config, metrics: batch.metrics, answerEvidence, webEvidence }),
		});
		modelFindings = result.findings;
	}
	const validIds = new Set([
		...captures.map((capture) => capture.captureId),
		...webEvidence.map((item) => item.id),
		...(websiteAudit ? [websiteAudit.id] : []),
	]);
	const validPromptIds = new Set(config.prompts.map((prompt) => prompt.id));
	const findings = [...deterministic, ...modelFindings].filter(
		(finding, index, all) => all.findIndex((candidate) => candidate.title === finding.title) === index,
	);
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
	return { count: findings.length, method: options.enhanceWithModel ? "evidence_rules_and_model" : "evidence_rules" };
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

export async function generateTaskContent(database: Database, taskId: string): Promise<void> {
	const task = (
		await database.query<Record<string, unknown>>(
			`SELECT t.*, p.name AS project_name, p.website_url, f.detail AS finding_detail,
			 f.category AS finding_category, f.evidence_ids AS finding_evidence_ids
	 FROM remediation_tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN diagnosis_findings f ON f.id=t.finding_id WHERE t.id=$1`,
			[taskId],
		)
	).rows[0];
	if (!task) throw new Error("整改任务不存在");
	const promptIds = parseJsonColumn<string[]>(task.target_prompt_ids as string[] | string);
	const prompts = promptIds.length
		? await database.query<{ question: string }>(
				"SELECT question FROM prompts WHERE id=ANY($1::text[]) ORDER BY position",
				[promptIds],
			)
		: { rows: [] };
	const evidenceIds = parseJsonColumn<string[]>((task.finding_evidence_ids ?? task.evidence_ids) as string[] | string);
	const questions = prompts.rows.map((row) => row.question);
	const isTechnical = String(task.finding_category ?? "").includes("技术");
	const brief = [
		`整改目标：${task.title}`,
		`客户：${task.project_name}`,
		`官网：${task.website_url}`,
		`证据结论：${task.finding_detail ?? task.detail}`,
		`关联问题：${questions.length ? questions.join("；") : "适用于该诊断关联的全部问题"}`,
		`证据 ID：${evidenceIds.join("、")}`,
		"事实边界：所有资质、参数、价格、案例、效果和第三方评价必须由客户提供可公开核验的来源；没有来源的内容保持“待补充”，不得猜测。",
		`验收：${task.acceptance_criteria}`,
	].join("\n\n");
	const draft = isTechnical
		? [
				`# ${task.project_name} 官网技术整改执行单`,
				"",
				"## 当前证据",
				String(task.finding_detail ?? task.detail),
				"",
				"## 实施步骤",
				"1. [待负责人填写] 修复证据中列出的访问、抓取或页面结构问题。",
				"2. [待技术人员填写] 记录修改文件、配置、发布时间和回滚方式。",
				"3. 使用线上公开 URL 重新运行官网审计，保留新的审计证据 ID。",
				"4. 只有审计项通过后，才进入同条件 AI 复测。",
				"",
				"## 验收记录",
				"- 发布 URL：[待补充]",
				"- 变更时间：[待补充]",
				"- 负责人：[待补充]",
				"- 新审计证据 ID：[待补充]",
			].join("\n")
		: [
				`# ${questions[0] ?? `${task.project_name} 选购与事实说明`}`,
				"",
				`> 本稿依据真实监测证据生成结构，所有方括号内容必须由 ${task.project_name} 审核并补充公开来源后才能发布。`,
				"",
				"## 先给结论",
				`[待补充：用 2-3 句话说明 ${task.project_name} 在什么真实条件下适合被选择，并附事实来源。]`,
				"",
				"## 适合哪些需求",
				...questions.map((question) => `- ${question}：[待补充可核验回答]`),
				"",
				"## 可核验事实",
				"| 事实维度 | 客户确认内容 | 公开来源 URL | 更新时间 |",
				"| --- | --- | --- | --- |",
				"| 产品或服务范围 | [待补充] | [待补充] | [待补充] |",
				"| 适用地区与人群 | [待补充] | [待补充] | [待补充] |",
				"| 资质、标准或检测 | [待补充] | [待补充] | [待补充] |",
				"| 价格与服务条件 | [待补充] | [待补充] | [待补充] |",
				"",
				"## 如何选择",
				"[待补充：按使用条件、预算、限制和售后写可比较标准；只写客户真实具备的差异。]",
				"",
				"## 常见问题",
				...questions.map((question) => `### ${question}\n[待补充有来源的简明回答]`),
				"",
				"## 联系与主体信息",
				`官网：${task.website_url}`,
				"主体、地址、电话及更新时间：[待补充并与官网其他页面保持一致]",
			].join("\n");
	await database.query("UPDATE remediation_tasks SET content_brief=$2,draft_content=$3,updated_at=now() WHERE id=$1", [
		taskId,
		brief,
		draft,
	]);
}

export async function createCollectorNode(database: Database, name: string): Promise<{ id: string; token: string }> {
	const id = randomUUID();
	const token = randomBytes(32).toString("base64url");
	await database.query(
		"INSERT INTO collector_nodes (id,name,token_hash,version,capabilities) VALUES ($1,$2,$3,$4,$5::jsonb)",
		[id, name, sha256(token), currentCollectorVersion, JSON.stringify(["deepseek", "kimi"])],
	);
	return { id, token };
}

export async function listCollectorNodes(database: Database): Promise<unknown[]> {
	return (
		await database.query(
			`SELECT id,name,version,capabilities,last_seen_at,revoked_at,created_at
			 FROM collector_nodes ORDER BY revoked_at NULLS FIRST,last_seen_at DESC NULLS LAST,created_at DESC`,
		)
	).rows;
}

export async function revokeCollectorNode(database: Database, nodeId: string): Promise<void> {
	const result = await database.query("UPDATE collector_nodes SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1", [
		nodeId,
	]);
	if (result.affectedRows === 0) throw new Error("Collector 节点不存在");
}

export async function authenticateCollector(database: Database, token: string): Promise<{ id: string } | null> {
	const row = (
		await database.query<{ id: string }>("SELECT id FROM collector_nodes WHERE token_hash=$1 AND revoked_at IS NULL", [
			sha256(token),
		])
	).rows[0];
	return row ?? null;
}
