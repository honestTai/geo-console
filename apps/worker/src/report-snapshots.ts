import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { ExecutionActor } from "@geo/authorization";
import { areBatchConfigsComparable, type Database, type ReportType, type WebsiteAuditResult } from "@geo/core";
import type { QueryCapture } from "@geo/evidence";
import { StructuredLogger, safeErrorMessage } from "@geo/logging";
import { rateKeys } from "@geo/metrics";
import { chromium } from "playwright";
import { z } from "zod";
import { enqueueAgentDraft } from "./agent";
import { assertBatchCaptureContract } from "./capture-contract";
import { renderReportDocx } from "./docx";
import {
	PRODUCT_NAME,
	priorityLabel,
	reportTypeLabel,
	reputationLabel,
	sourceCategoryLabel,
	taskStatusLabel,
} from "./labels";
import { currentMeasurement, readPairedComparisons } from "./measurement";
import { artifactExists, putArtifact, readArtifact } from "./object-store";
import { type Paginated, type PaginationInput, paginated } from "./pagination";
import { providerDefinitions } from "./providers";
import { sweepTerminalLeases } from "./queue-recovery";
import { type EvidenceIndexEntry, evidencePlatformLabel, stripTrackingFragment } from "./report";
import { customerBlock, reportBrandStyles, reportLogo, reportWatermark } from "./report-branding";
import { getBatch, getBatchReport } from "./service";
import { HttpInputError, parseJsonColumn, sha256, stableJson } from "./utils";
import { websiteAuditSection } from "./website-report";

const reportTypeSchema = z.enum(["quick_audit", "remediation", "retest"]);
const reportLogger = new StructuredLogger("report-worker");

export type ReportWorkflowResult = {
	state:
		| "analysis_pending"
		| "analysis_unavailable"
		| "narrative_queued"
		| "narrative_running"
		| "narrative_approval"
		| "quality_queued"
		| "quality_running"
		| "quality_approval"
		| "quality_blocked"
		| "documents_queued"
		| "ready";
	runId: string | null;
	reportId: string | null;
};

type WorkflowRun = {
	id: string;
	purpose: string;
	status: string;
	draft: unknown;
	created_at: string;
	approved_at: string | null;
};

function activeRunState(run: WorkflowRun, purpose: "narrative" | "quality"): ReportWorkflowResult["state"] {
	if (run.status === "awaiting_approval") return purpose === "narrative" ? "narrative_approval" : "quality_approval";
	if (run.status === "running") return purpose === "narrative" ? "narrative_running" : "quality_running";
	return purpose === "narrative" ? "narrative_queued" : "quality_queued";
}

export async function advanceReportWorkflow(
	database: Database,
	batchId: string,
	options: { createdBy?: string | null; actor?: ExecutionActor; allowRetry?: boolean; restart?: boolean } = {},
): Promise<ReportWorkflowResult> {
	return database.transaction((tx) => advanceReportWorkflowLocked(tx, batchId, options));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The workflow advances evidence-bound approval gates idempotently in one transactionally observable decision.
async function advanceReportWorkflowLocked(
	database: Database,
	batchId: string,
	options: { createdBy?: string | null; actor?: ExecutionActor; allowRetry?: boolean; restart?: boolean } = {},
): Promise<ReportWorkflowResult> {
	const batch = (
		await database.query<{
			project_id: string;
			kind: ReportType | "baseline";
			status: string;
			compare_to_batch_id: string | null;
		}>("SELECT project_id,kind,status,compare_to_batch_id FROM experiment_batches WHERE id=$1 FOR UPDATE", [batchId])
	).rows[0];
	if (!batch) throw new HttpInputError("采集批次不存在", 404);
	await assertBatchCaptureContract(database, batchId);
	if (!["complete", "partial"].includes(batch.status))
		throw new HttpInputError("报告工作流只能基于已完成或部分完成的批次", 409);
	const measurement = await currentMeasurement(database, batchId);
	if (!measurement.snapshotId)
		return {
			state: ["queued", "running"].includes(measurement.status) ? "analysis_pending" : "analysis_unavailable",
			runId: null,
			reportId: null,
		};
	if (!measurement.payload || measurement.payload.overall.status === "unavailable")
		return { state: "analysis_unavailable", runId: null, reportId: null };
	let baselineMetricId: string | null = null;
	if (batch.kind === "retest" && batch.compare_to_batch_id) {
		await database.query("SELECT id FROM experiment_batches WHERE id=$1 FOR UPDATE", [batch.compare_to_batch_id]);
		const baseline = await currentMeasurement(database, batch.compare_to_batch_id);
		baselineMetricId = baseline.snapshotId;
		if (!baselineMetricId)
			return {
				state: baseline.status === "failed" ? "analysis_unavailable" : "analysis_pending",
				runId: null,
				reportId: null,
			};
		const paired = await database.query(
			"SELECT id FROM measurement_drift_observations WHERE metric_id=$1 AND baseline_metric_id=$2",
			[measurement.snapshotId, baselineMetricId],
		);
		if (paired.rows.length < Object.keys(measurement.payload.perPlatform).length * rateKeys.length)
			return { state: "analysis_pending", runId: null, reportId: null };
	}
	const runs = (
		await database.query<WorkflowRun>(
			`SELECT id,purpose,status,draft,created_at,approved_at FROM agent_runs WHERE batch_id=$1 AND metric_snapshot_id=$2 AND baseline_metric_snapshot_id IS NOT DISTINCT FROM $3
			 AND purpose IN ('report_narrative','quality_review') ORDER BY created_at DESC`,
			[batchId, measurement.snapshotId, baselineMetricId],
		)
	).rows;
	const activeNarrative = runs.find(
		(run) => run.purpose === "report_narrative" && ["queued", "running", "awaiting_approval"].includes(run.status),
	);
	// 正在生成的新叙述优先于已批准的旧叙述：重启或质检未通过后的重生成期间，不能再拿旧叙述往下冻结。
	if (activeNarrative)
		return { state: activeRunState(activeNarrative, "narrative"), runId: activeNarrative.id, reportId: null };
	const queueNarrative = async (): Promise<ReportWorkflowResult> => {
		const queued = await enqueueAgentDraft(database, {
			projectId: batch.project_id,
			batchId,
			purpose: "report_narrative",
			actor:
				options.actor ?? (options.createdBy ? { kind: "user", userId: options.createdBy } : { kind: "unassigned" }),
		});
		return { state: "narrative_queued", runId: queued.id, reportId: null };
	};
	if (options.restart) return queueNarrative();
	const narrative = runs.find((run) => run.purpose === "report_narrative" && run.status === "approved");
	if (!narrative) return queueNarrative();
	const qualityRuns = runs.filter(
		(run) =>
			run.purpose === "quality_review" &&
			new Date(run.created_at).getTime() >= new Date(narrative.approved_at ?? 0).getTime(),
	);
	const approvedQuality = qualityRuns.find((run) => {
		if (run.status !== "approved" || !run.draft) return false;
		return (
			(parseJsonColumn(run.draft as string | Record<string, unknown>) as { reviewedNarrativeRunId?: unknown })
				.reviewedNarrativeRunId === narrative.id
		);
	});
	if (!approvedQuality) {
		const activeQuality = qualityRuns.find((run) => ["queued", "running", "awaiting_approval"].includes(run.status));
		if (activeQuality)
			return { state: activeRunState(activeQuality, "quality"), runId: activeQuality.id, reportId: null };
		const queued = await enqueueAgentDraft(database, {
			projectId: batch.project_id,
			batchId,
			purpose: "quality_review",
			actor:
				options.actor ?? (options.createdBy ? { kind: "user", userId: options.createdBy } : { kind: "unassigned" }),
		});
		return { state: "quality_queued", runId: queued.id, reportId: null };
	}
	const qualityDraft = parseJsonColumn(approvedQuality.draft as string | Record<string, unknown>) as {
		verdict?: unknown;
	};
	if (qualityDraft.verdict !== "pass") {
		if (!options.allowRetry) return { state: "quality_blocked", runId: approvedQuality.id, reportId: null };
		// 质检未通过说明叙述本身有问题：重试是重新生成叙述（批准后自动绑定新的质检），而不是对同一份叙述反复质检。
		return queueNarrative();
	}
	const existing = (
		await database.query<{ id: string; pdf_artifact_key: string | null; word_artifact_key: string | null }>(
			`SELECT id,pdf_artifact_key,word_artifact_key FROM report_snapshots
			 WHERE batch_id=$1 AND payload->>'agentNarrativeRunId'=$2 ORDER BY created_at DESC LIMIT 1`,
			[batchId, narrative.id],
		)
	).rows[0];
	let reportId = existing?.id ?? null;
	if (!reportId) {
		const reportType: ReportType =
			batch.kind === "retest" ? "retest" : batch.kind === "quick_audit" ? "quick_audit" : "remediation";
		reportId = (await createReportSnapshot(database, { batchId, reportType, createdBy: options.createdBy ?? null })).id;
	}
	const queued = await requestReportPdf(database, reportId);
	return {
		state: queued.status === "ready" ? "ready" : "documents_queued",
		runId: approvedQuality.id,
		reportId,
	};
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
const percent = (value: unknown): string => (typeof value === "number" ? `${Math.round(value * 100)}%` : "不可用");
export function safeReportLink(value: string): string {
	try {
		if (["http:", "https:"].includes(new URL(value).protocol))
			return `<a href="${escapeHtml(value)}" rel="noreferrer noopener" target="_blank">${escapeHtml(value)}</a>`;
	} catch {
		/* Untrusted or historical non-web URLs are rendered as inert text. */
	}
	return escapeHtml(value);
}
const reportDate = (value: unknown): string => {
	const parsed = new Date(String(value ?? ""));
	return Number.isNaN(parsed.getTime())
		? "时间不可用"
		: new Intl.DateTimeFormat("zh-CN", {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}).format(parsed);
};

async function reportBrowserExecutable(): Promise<string | undefined> {
	const configured = process.env.GEO_PLAYWRIGHT_EXECUTABLE_PATH?.trim();
	if (configured) {
		await access(configured);
		return configured;
	}
	try {
		await access(chromium.executablePath());
		return undefined;
	} catch {
		const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		if (process.platform === "darwin") {
			await access(macChrome);
			return macChrome;
		}
		throw new Error("Report Worker 缺少 Chromium；请安装 Playwright Chromium 或配置 GEO_PLAYWRIGHT_EXECUTABLE_PATH");
	}
}

function sourceSet(captures: QueryCapture[]): Set<string> {
	return new Set(captures.flatMap((capture) => capture.sources.map((source) => source.url)));
}

export async function createReportSnapshot(
	database: Database,
	input: { batchId: string; reportType: ReportType; compareToBatchId?: string | null; createdBy?: string | null },
): Promise<{ id: string }> {
	return database.transaction(async (tx) => {
		await tx.query("SELECT id FROM experiment_batches WHERE id=$1 FOR UPDATE", [input.batchId]);
		return createReportSnapshotLocked(tx, input);
	});
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Snapshot freezing validates type, comparison, narrative, and quality gates together.
async function createReportSnapshotLocked(
	database: Database,
	input: { batchId: string; reportType: ReportType; compareToBatchId?: string | null; createdBy?: string | null },
): Promise<{ id: string }> {
	const reportType = reportTypeSchema.parse(input.reportType);
	const batch = await getBatch(database, input.batchId);
	if (!batch) throw new HttpInputError("采集批次不存在", 404);
	await assertBatchCaptureContract(database, input.batchId);
	if (reportType === "quick_audit" && batch.kind !== "quick_audit")
		throw new HttpInputError("售前快审报告只能由快审批次生成", 409);
	if (reportType === "retest" && batch.kind !== "retest")
		throw new HttpInputError("周期复测报告只能由复测批次生成", 409);
	const report = await getBatchReport(database, input.batchId);
	if (!report) throw new HttpInputError("报告数据不存在", 404);
	const measurement = await currentMeasurement(database, input.batchId);
	if (!measurement.snapshotId || measurement.payload?.overall.status === "unavailable")
		throw new HttpInputError("V2 语义证据不足，不能冻结报告", 409);
	if ((batch.measurement as { snapshotId?: string }).snapshotId !== measurement.snapshotId)
		throw new HttpInputError("测量版本已变化，请重新生成报告", 409);
	let comparison: Record<string, unknown> | null = null;
	if (reportType === "retest") {
		const compareToBatchId = input.compareToBatchId ?? String(batch.compare_to_batch_id ?? "");
		if (compareToBatchId !== String(batch.compare_to_batch_id ?? ""))
			throw new Error("复测报告必须使用采集时绑定的基线");
		await database.query("SELECT id FROM experiment_batches WHERE id=$1 FOR UPDATE", [compareToBatchId]);
		const baseline = await getBatch(database, compareToBatchId);
		if (!baseline) throw new HttpInputError("复测报告缺少正式基线", 409);
		if (baseline.project_id !== batch.project_id) throw new HttpInputError("复测报告基线不属于当前客户项目", 404);
		if (!areBatchConfigsComparable(batch.config as never, baseline.config as never))
			throw new HttpInputError("复测与基线冻结条件不一致，禁止生成前后对比", 409);
		const baseMeasurement = await currentMeasurement(database, compareToBatchId);
		if (
			measurement.payload?.overall.status !== "ready" ||
			baseMeasurement.payload?.overall.status !== "ready" ||
			stableJson(measurement.payload.contract) !== stableJson(baseMeasurement.payload.contract)
		)
			throw new Error("复测对比必须使用同一 V2 测量契约且双方达到 ready");
		const pairedResults = await readPairedComparisons(database, measurement.snapshotId, compareToBatchId);
		if (
			!pairedResults.some(
				(row) => row.metric === "brandMentionRate" && (row.result as { status?: string }).status === "ready",
			)
		)
			throw new HttpInputError("共同有效问题未达到 V2 门槛，不能生成正式复测对比报告", 409);
		const currentSources = sourceSet(batch.captures as QueryCapture[]);
		const baselineSources = sourceSet(baseline.captures as QueryCapture[]);
		comparison = {
			baselineBatchId: baseline.id,
			baselineMetricSnapshotId: baseMeasurement.snapshotId,
			pairedResults,
			baselineMetrics: baseline.metrics,
			currentMetrics: batch.metrics,
			newSources: [...currentSources].filter((url) => !baselineSources.has(url)),
			lostSources: [...baselineSources].filter((url) => !currentSources.has(url)),
		};
	}
	const approvedNarrative = (
		await database.query<Record<string, unknown>>(
			`SELECT id,draft,approved_at FROM agent_runs WHERE batch_id=$1 AND metric_snapshot_id=$2 AND baseline_metric_snapshot_id IS NOT DISTINCT FROM $3 AND purpose='report_narrative' AND status='approved'
			 ORDER BY approved_at DESC LIMIT 1`,
			[input.batchId, measurement.snapshotId, comparison?.baselineMetricSnapshotId ?? null],
		)
	).rows[0];
	if (!approvedNarrative)
		throw new HttpInputError("冻结报告前必须先运行并批准 HRouter Agent 报告叙述（含口碑检测与 GEO 建议）", 409);
	const approvedQuality = (
		await database.query<Record<string, unknown>>(
			`SELECT id,draft,approved_at FROM agent_runs WHERE batch_id=$1 AND metric_snapshot_id=$2 AND baseline_metric_snapshot_id IS NOT DISTINCT FROM $3 AND purpose='quality_review' AND status='approved'
			 ORDER BY approved_at DESC LIMIT 20`,
			[input.batchId, measurement.snapshotId, comparison?.baselineMetricSnapshotId ?? null],
		)
	).rows
		.map((row) => ({
			id: String(row.id),
			parsedDraft: parseJsonColumn(row.draft as string | Record<string, unknown>),
		}))
		.find(
			(row) =>
				(row.parsedDraft as { reviewedNarrativeRunId?: unknown }).reviewedNarrativeRunId === approvedNarrative.id,
		);
	if (!approvedQuality)
		throw new HttpInputError("冻结报告前必须先运行并批准针对当前报告叙述的 HRouter Agent 质量检查", 409);
	if ((approvedQuality.parsedDraft as { verdict?: unknown }).verdict !== "pass")
		throw new HttpInputError("HRouter Agent 质量检查未通过，禁止冻结或导出正式报告", 409);
	const providerDisclosures = (batch.config as { platforms: string[] }).platforms.map((providerId) => ({
		providerId,
		disclosure:
			providerId in providerDefinitions
				? providerDefinitions[providerId as keyof typeof providerDefinitions].disclosure
				: "历史消费端证据，仅用于只读追溯。",
	}));
	const createdAt = new Date().toISOString();
	const payload = {
		schemaVersion: "geo.report-snapshot.v2",
		renderContract: { brand: "ZZGEO", templateVersion: "zzgeo.report.v3" },
		metricSnapshotId: measurement.snapshotId,
		reportType,
		createdAt,
		batch,
		report,
		comparison,
		providerDisclosures,
		agentNarrativeRunId: approvedNarrative.id,
		agentNarrative: parseJsonColumn(approvedNarrative.draft as string | Record<string, unknown>),
		agentQualityRunId: approvedQuality.id,
		agentQualityReview: approvedQuality.parsedDraft,
		blackBoxStatement:
			"本报告记录指定模型、协议、地区、问题集与采样窗口下的联网 API 结果。API 回答不等同于对应消费端 App；结果可能随模型、索引、搜索策略和时间变化，不构成固定排名承诺。",
	};
	const id = randomUUID();
	const projectName = (batch.config as { project: { name: string } }).project.name;
	const title = `${projectName} - ${reportType === "quick_audit" ? "售前快审" : reportType === "remediation" ? "整改方案" : "周期复测"}`;
	await database.query(
		`INSERT INTO report_snapshots
		 (id,organization_id,project_id,batch_id,compare_to_batch_id,report_type,schema_version,title,payload,payload_hash,created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,'geo.report-snapshot.v2',$7,$8::jsonb,$9,$10)`,
		[
			id,
			batch.organization_id,
			batch.project_id,
			input.batchId,
			comparison ? (comparison.baselineBatchId as string) : null,
			reportType,
			title,
			JSON.stringify(payload),
			sha256(stableJson(payload)),
			input.createdBy ?? null,
		],
	);
	return { id };
}

export async function listReportSnapshots(
	database: Database,
	projectId: string,
	input: PaginationInput,
	batchId: string | null = null,
): Promise<Paginated<Record<string, unknown>>> {
	const total = Number(
		(
			await database.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM report_snapshots WHERE project_id=$1 AND ($2::text IS NULL OR batch_id=$2)",
				[projectId, batchId],
			)
		).rows[0]?.count ?? 0,
	);
	const rows = (
		await database.query<Record<string, unknown>>(
			`SELECT id,project_id,batch_id,compare_to_batch_id,report_type,schema_version,title,payload_hash,
				 pdf_artifact_key,word_artifact_key,created_at FROM report_snapshots WHERE project_id=$1
				 AND ($2::text IS NULL OR batch_id=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
			[projectId, batchId, input.pageSize, input.offset],
		)
	).rows;
	return paginated(rows, total, input);
}

export async function getReportSnapshot(database: Database, reportId: string): Promise<Record<string, unknown> | null> {
	const row = (await database.query<Record<string, unknown>>("SELECT * FROM report_snapshots WHERE id=$1", [reportId]))
		.rows[0];
	if (!row) return null;
	return { ...row, payload: parseJsonColumn(row.payload as string | Record<string, unknown>) };
}

type EvidenceLookup = { byId: Map<string, EvidenceIndexEntry>; entries: EvidenceIndexEntry[] };

/** 快照 payload 里的证据索引；旧快照没有索引时按证据 ID 出现顺序即时编号。 */
export function evidenceLookup(payload: Record<string, unknown>): EvidenceLookup {
	const analysis = (payload.report as { analysis?: { evidenceIndex?: EvidenceIndexEntry[] } } | undefined)?.analysis;
	const entries = Array.isArray(analysis?.evidenceIndex) ? analysis.evidenceIndex : [];
	return { byId: new Map(entries.map((entry) => [entry.id, entry])), entries };
}

export function citationMarks(evidenceIds: unknown, lookup: EvidenceLookup): string {
	const ids = Array.isArray(evidenceIds) ? evidenceIds.map(String) : [];
	const marks = ids.map((id) => {
		const entry = lookup.byId.get(id);
		return entry ? `[${entry.n}]` : `[${id.slice(0, 8)}]`;
	});
	return marks.length ? `<sup class="cite">${escapeHtml(marks.join(""))}</sup>` : "";
}

export function describeEvidenceEntry(entry: EvidenceIndexEntry): string {
	if (entry.kind === "capture")
		return `${entry.platformLabel ?? entry.platform ?? "联网回答"} · “${entry.question ?? ""}” · 第 ${entry.attempt ?? 1} 次采样 · ${reportDate(entry.capturedAt)}`;
	if (entry.kind === "snapshot") return `${entry.platformLabel ?? "网页快照"} · ${entry.title ?? entry.url ?? ""}`;
	return `${entry.platformLabel ?? "官网审计"} · ${reportDate(entry.capturedAt)}`;
}

function evidenceIndexTable(lookup: EvidenceLookup, prompts: Array<Record<string, unknown>>): string {
	if (!lookup.entries.length)
		return prompts
			.flatMap((row) =>
				(row.captures as Array<Record<string, unknown>>).map(
					(capture) =>
						`<p>${escapeHtml(capture.captureId)} · ${escapeHtml(evidencePlatformLabel(String(capture.platform)) ?? capture.platform)} · 第 ${escapeHtml(capture.attempt)} 次 · ${escapeHtml(capture.status)}</p>`,
				),
			)
			.join("");
	return `<table class="evidence-index"><thead><tr><th>编号</th><th>来源</th><th>问题 / 页面</th><th>采样</th><th>时间</th><th>引用网址</th></tr></thead><tbody>${lookup.entries
		.map(
			(entry) =>
				`<tr><td>[${entry.n}]</td><td>${escapeHtml(entry.platformLabel ?? entry.platform ?? "-")}</td><td>${escapeHtml(entry.question ?? entry.title ?? entry.url ?? "-")}</td><td>${entry.attempt ? `第 ${entry.attempt} 次${entry.status && entry.status !== "complete" ? ` · ${escapeHtml(entry.status)}` : ""}` : "-"}</td><td>${entry.capturedAt ? escapeHtml(reportDate(entry.capturedAt)) : "-"}</td><td>${
					entry.sourceUrls.length
						? entry.sourceUrls
								.slice(0, 5)
								.map((url) => safeReportLink(url))
								.join("<br>")
						: entry.url
							? safeReportLink(entry.url)
							: "平台未展示最终引用 URL"
				}</td></tr>`,
		)
		.join("")}</tbody></table>`;
}

function platformRows(payload: Record<string, unknown>): string {
	const batch = payload.batch as { metrics?: { perPlatform?: Record<string, Record<string, unknown>> } };
	const entries = Object.entries(batch.metrics?.perPlatform ?? {});
	return entries
		.map(
			([provider, metrics]) =>
				`<tr><td>${escapeHtml(provider in providerDefinitions ? providerDefinitions[provider as keyof typeof providerDefinitions].label : provider)}</td><td>${escapeHtml(percent(metrics.captureCoverage))}</td><td>${escapeHtml(percent(metrics.brandMentionRate))}</td><td>${escapeHtml(percent(metrics.firstRecommendationRate))}</td><td>${escapeHtml(percent(metrics.monitoredBrandShare))}</td><td>${escapeHtml(percent(metrics.citationRate))}</td></tr>`,
		)
		.join("");
}

function pairedResultsHtml(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return `<h3>共同有效问题的配对变化</h3><table><thead><tr><th>平台 / 指标</th><th>基线 / 复测</th><th>变化及95%区间（百分点）</th><th>共同问题 / 状态</th></tr></thead><tbody>${value
		.map((row) => {
			const r = row.result as {
				previous: number | null;
				current: number | null;
				delta: number | null;
				interval: [number, number] | null;
				promptIds: string[];
				status: string;
			};
			return `<tr><td>${escapeHtml(row.provider_id)} / ${escapeHtml(row.metric)}</td><td>${percent(r.previous)} / ${percent(r.current)}</td><td>${r.delta === null ? "不可用" : escapeHtml((r.delta * 100).toFixed(1))} / ${escapeHtml(r.interval?.map((x) => (x * 100).toFixed(1)).join(" – ") ?? "不可用")}</td><td>${r.promptIds.length} / ${escapeHtml(r.status)}</td></tr>`;
		})
		.join("")}</tbody></table>`;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Report sections intentionally mirror the immutable document contract.
function renderReportBody(snapshot: Record<string, unknown>): string {
	const payload = snapshot.payload as Record<string, unknown>;
	const report = payload.report as {
		analysis?: {
			executive?: Record<string, unknown>;
			promptRows?: Array<Record<string, unknown>>;
			sourceDomains?: Array<Record<string, unknown>>;
			gaps?: Array<Record<string, unknown>>;
		};
		findings?: Array<Record<string, unknown>>;
		tasks?: Array<Record<string, unknown>>;
		attributionSummary?: Array<Record<string, unknown>>;
	};
	const batch = payload.batch as {
		metrics?: {
			overall?: Record<string, unknown>;
			validSamples?: number;
			failedSamples?: number;
			expectedSamples?: number;
		};
	};
	const overall = batch.metrics?.overall ?? {};
	const analysis = report.analysis ?? {};
	const prompts = analysis.promptRows ?? [];
	const sources = analysis.sourceDomains ?? [];
	const findings = report.findings ?? analysis.gaps ?? [];
	const tasks = report.tasks ?? [];
	const disclosures = (payload.providerDisclosures as Array<{ providerId: string; disclosure: string }>) ?? [];
	const narrative = payload.agentNarrative as
		| {
				reputation?: {
					overall?: string;
					summary?: string;
					positiveSignals?: Array<Record<string, unknown>>;
					negativeSignals?: Array<Record<string, unknown>>;
				};
				geoRecommendations?: Array<Record<string, unknown>>;
				limitations?: string[];
		  }
		| undefined;
	const reputation = narrative?.reputation;
	const lookup = evidenceLookup(payload);
	const reputationSignal = (signal: Record<string, unknown>, polarity: "positive" | "negative"): string => {
		const urls = Array.isArray(signal.sourceUrls)
			? signal.sourceUrls.map((url) => stripTrackingFragment(String(url)))
			: [];
		return `<article class="reputation-signal ${polarity}"><strong>${polarity === "positive" ? "正面" : "负面"}</strong><p>${escapeHtml(signal.statement)}${citationMarks(signal.evidenceIds, lookup)}</p><small>来源：${urls.length ? [...new Set(urls)].map((url) => safeReportLink(url)).join("、") : "平台未展示最终引用 URL"}</small></article>`;
	};
	const comparison = payload.comparison as Record<string, unknown> | null;
	const chart = Object.entries(
		(payload.batch as { metrics?: { perPlatform?: Record<string, { brandMentionRate?: number }> } }).metrics
			?.perPlatform ?? {},
	)
		.map(
			([provider, metrics]) =>
				`<div class="bar-row"><span>${escapeHtml(provider in providerDefinitions ? providerDefinitions[provider as keyof typeof providerDefinitions].label : provider)}</span><div class="bar"><i style="width:${Math.round((metrics.brandMentionRate ?? 0) * 100)}%"></i></div><b>${percent(metrics.brandMentionRate)}</b></div>`,
		)
		.join("");
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(snapshot.title)}</title><style>
		@page{size:A4;margin:20mm 14mm 18mm}*{box-sizing:border-box}body{margin:0;color:#18201d;font:14px/1.65 "Noto Sans CJK SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif;background:#fff}main{max-width:1080px;margin:auto;padding:32px}.cover{min-height:240px;border-bottom:4px solid #117a65;padding:40px 0}.eyebrow{color:#117a65;font-weight:700}.cover h1{font-size:32px;margin:14px 0 10px;letter-spacing:0}.muted{color:#66716d}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0}.kpi{border:1px solid #d9e1de;border-radius:6px;padding:14px}.kpi strong{display:block;font-size:24px;color:#0d584a}.section{break-inside:avoid;margin:28px 0}.section h2{font-size:20px;border-bottom:1px solid #ccd7d3;padding-bottom:7px}.toc a{display:block;color:#117a65;text-decoration:none;padding:3px 0}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #d9e1de;padding:7px;text-align:left;vertical-align:top}th{background:#eff5f2}.bar-row{display:grid;grid-template-columns:150px 1fr 52px;gap:10px;align-items:center;margin:8px 0}.bar{height:12px;background:#e5ece9}.bar i{display:block;height:100%;background:#117a65}.finding{border-left:3px solid #117a65;padding:8px 12px;margin:12px 0;background:#f7faf9}.reputation-signal{padding:10px 12px;margin:10px 0;border-left:3px solid #188b66;background:#f1f9f5}.reputation-signal.negative{border-color:#c43d46;background:#fff3f3}.reputation-signal p{margin:4px 0}.reputation-signal a{color:#0d584a;word-break:break-all}.recommendation{border:1px solid #d9e1de;padding:10px 12px;margin:9px 0}.warning{border:1px solid #d4a72c;background:#fff9e8;padding:12px}.appendix{font-size:11px;word-break:break-all}.cite{color:#117a65;font-size:10px;margin-left:2px}.evidence-index td{font-size:10.5px}.evidence-index a{color:#0d584a}@media(max-width:700px){main{padding:18px}.kpis{grid-template-columns:1fr 1fr}.cover h1{font-size:25px}.bar-row{grid-template-columns:100px 1fr 46px}table{display:block;overflow:auto}}
		</style></head><body><main><section class="cover"><div class="eyebrow">${PRODUCT_NAME} / ${escapeHtml(reportTypeLabel(snapshot.report_type))}</div><h1>${escapeHtml(snapshot.title)}</h1><p>${escapeHtml((analysis.executive ?? {}).headline)}</p><p class="muted">快照 ${escapeHtml(snapshot.id)} · ${escapeHtml(reportDate(snapshot.created_at))}</p></section>
		<section class="kpis"><div class="kpi">品牌提及率<strong>${percent(overall.brandMentionRate)}</strong></div><div class="kpi">首位推荐率<strong>${percent(overall.firstRecommendationRate)}</strong></div><div class="kpi">监测品牌出现份额<strong>${percent(overall.monitoredBrandShare)}</strong></div><div class="kpi">采集覆盖率<strong>${percent(overall.captureCoverage)}</strong></div></section>
		<section class="section toc"><h2>目录</h2><a href="#summary">1. 执行摘要</a><a href="#reputation">2. AI 口碑检测</a><a href="#platforms">3. 平台指标</a><a href="#questions">4. 问题与竞品</a><a href="#sources">5. 信源</a><a href="#remediation">6. GEO 优化与整改</a><a href="#evidence">7. 证据与局限</a></section>
		<section class="section" id="summary"><h2>1. 执行摘要</h2><p>${escapeHtml((analysis.executive ?? {}).validityNote)}</p><p>${escapeHtml((analysis.executive ?? {}).summary)}</p><p>${escapeHtml((payload.agentNarrative as Record<string, unknown> | null)?.executiveSummary ?? "")}</p>${chart}</section>
		<section class="section" id="reputation"><h2>2. AI 口碑检测</h2><p><strong>${escapeHtml(reputationLabel(reputation?.overall ?? "not_observed"))}</strong> · ${escapeHtml(reputation?.summary ?? "AI 搜索回答中未观察到可报告的口碑评价。")}</p>${(reputation?.positiveSignals ?? []).map((signal) => reputationSignal(signal, "positive")).join("")}${(reputation?.negativeSignals ?? []).map((signal) => reputationSignal(signal, "negative")).join("") || "<p>本批次未观察到负面口碑信号。</p>"}</section>
		<section class="section" id="platforms"><h2>3. 平台指标</h2><table><thead><tr><th>平台口径</th><th>回答覆盖</th><th>品牌提及</th><th>首位推荐</th><th>监测品牌出现份额</th><th>官网引用</th></tr></thead><tbody>${platformRows(payload)}</tbody></table></section>
		<section class="section" id="questions"><h2>4. 问题与竞品</h2><table><thead><tr><th>问题</th><th>有效/计划</th><th>提及率</th><th>首位率</th><th>明确推荐名次中位数</th><th>来源数</th></tr></thead><tbody>${prompts.map((row) => `<tr><td>${escapeHtml(row.question)}</td><td>${escapeHtml(row.completeSamples)}/${escapeHtml(row.plannedSamples)}</td><td>${percent(row.targetMentionRate)}</td><td>${percent(row.firstRecommendationRate)}</td><td>${escapeHtml(row.bestTargetPosition ?? "无明确排名")}</td><td>${escapeHtml(row.sourceCount)}</td></tr>`).join("")}</tbody></table></section>
		<section class="section" id="sources"><h2>5. 信源与变化</h2>${pairedResultsHtml(comparison?.pairedResults)}<table><thead><tr><th>域名</th><th>引用次数</th><th>覆盖问题</th><th>分类</th></tr></thead><tbody>${sources.map((source) => `<tr><td>${escapeHtml(source.domain)}</td><td>${escapeHtml(source.citationCount)}</td><td>${escapeHtml(source.promptCount)}</td><td>${escapeHtml(sourceCategoryLabel(source.category ?? (source.isOwned ? "owned" : "other")))}</td></tr>`).join("")}</tbody></table>${comparison ? `<p>新增信源：${escapeHtml((comparison.newSources as string[]).join("、") || "无")}</p><p>丢失信源：${escapeHtml((comparison.lostSources as string[]).join("、") || "无")}</p>` : ""}</section>
		<section class="section" id="remediation"><h2>6. GEO 优化与整改</h2>${(narrative?.geoRecommendations ?? []).map((item) => `<article class="recommendation"><strong>${escapeHtml(priorityLabel(item.priority))} · ${escapeHtml(item.title)}</strong><p>${escapeHtml(item.action)}</p><small>${escapeHtml(item.rationale)}${citationMarks(item.evidenceIds, lookup)}</small></article>`).join("")}${findings.map((finding) => `<article class="finding"><strong>${escapeHtml(finding.title)}</strong><p>${escapeHtml(finding.detail)}</p><p>建议：${escapeHtml(finding.recommendation)}${citationMarks(parseJsonColumn<string[]>((finding.evidence_ids ?? finding.evidenceIds ?? []) as string | string[]), lookup)}</p></article>`).join("") || "<p>尚无已批准诊断。</p>"}<table><thead><tr><th>任务</th><th>优先级</th><th>状态</th><th>负责人</th><th>验收</th></tr></thead><tbody>${tasks.map((task) => `<tr><td>${escapeHtml(task.title)}</td><td>${escapeHtml(priorityLabel(task.priority))}</td><td>${escapeHtml(taskStatusLabel(task.status))}</td><td>${escapeHtml(task.owner ?? "待分配")}</td><td>${escapeHtml(task.acceptance_criteria)}</td></tr>`).join("")}</tbody></table></section>
		<section class="section appendix" id="evidence"><h2>7. 证据索引与口径声明</h2><p>正文中的 [n] 对应下表编号；每条证据都是指定时间、平台、问题下的真实采样或官网快照。</p>${evidenceIndexTable(lookup, prompts)}<div class="warning"><strong>证据与黑盒局限</strong>${(narrative?.limitations ?? []).map((item) => `<p>${escapeHtml(item)}</p>`).join("")}<p>${escapeHtml(payload.blackBoxStatement)}</p>${disclosures.map((item) => `<p><b>${escapeHtml(item.providerId in providerDefinitions ? providerDefinitions[item.providerId as keyof typeof providerDefinitions].label : item.providerId)}</b>：${escapeHtml(item.disclosure)}</p>`).join("")}</div></section>
		</main></body></html>`;
}

/** Branding and customer details come from the frozen batch, never from today's mutable customer profile. */
export function renderReportHtml(snapshot: Record<string, unknown>, auditScreenshot?: string): string {
	const payload = snapshot.payload as {
		batch?: { config?: { project?: Record<string, unknown> } };
		report?: { analysis?: { websiteAudit?: { result: WebsiteAuditResult } | null } };
	};
	const customer = payload.batch?.config?.project ?? {};
	const audit = payload.report?.analysis?.websiteAudit;
	const auditSection = audit
		? websiteAuditSection(audit.result, auditScreenshot)
		: `<section class="section" id="website-audit"><h2>官网审计</h2><p>${customer.domain ? "本报告没有对应的官网审计证据，不能推断官网存在或不存在技术问题。" : "客户未提供官网，本项不适用，官网引用率不可用（不记为 0）；其他 AI 监测结果仍独立成立。"}</p></section>`;
	return renderReportBody(snapshot)
		.replace("</style>", `${reportBrandStyles}</style>`)
		.replace("<body><main>", `<body>${reportWatermark(String(customer.name ?? ""))}<main class="zz-content">`)
		.replace('<section class="cover">', `<section class="cover">${reportLogo}`)
		.replace(
			'<section class="kpis">',
			`${customerBlock(customer, String(snapshot.created_at ?? ""))}<section class="kpis">`,
		)
		.replace('<section class="section" id="remediation">', `${auditSection}<section class="section" id="remediation">`)
		.replace('<a href="#remediation">', '<a href="#website-audit">5.1 官网技术诊断与证据</a><a href="#remediation">');
}

export async function generateReportPdf(database: Database, reportId: string): Promise<{ artifactKey: string }> {
	const snapshot = await getReportSnapshot(database, reportId);
	if (!snapshot) throw new HttpInputError("报告快照不存在", 404);
	const artifactKey = `reports/${reportId}.pdf`;
	// The object may have been committed before a worker crashed. Reconcile the row instead of overwriting immutable evidence.
	if (await artifactExists(artifactKey)) {
		await database.query("UPDATE report_snapshots SET pdf_artifact_key=COALESCE(pdf_artifact_key,$2) WHERE id=$1", [
			reportId,
			artifactKey,
		]);
		return { artifactKey };
	}
	const executablePath = await reportBrowserExecutable();
	const browser = await chromium.launch({ headless: true, executablePath });
	try {
		const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
		await context.route("**/*", (route) => route.abort());
		const page = await context.newPage();
		const payload = snapshot.payload as {
			batch?: { config?: { project?: { name?: string } } };
			report?: { analysis?: { websiteAudit?: { result: WebsiteAuditResult } } };
		};
		const screenshot = payload.report?.analysis?.websiteAudit?.result.evidence?.find(
			(item) => item.kind === "screenshot" && item.objectKey,
		);
		let screenshotData: string | undefined;
		if (screenshot?.objectKey)
			try {
				const asset = await readArtifact(screenshot.objectKey);
				if (
					asset.contentType === "image/png" &&
					createHash("sha256").update(asset.body).digest("hex") === screenshot.contentHash
				)
					screenshotData = `data:image/png;base64,${Buffer.from(asset.body).toString("base64")}`;
			} catch {
				/* Missing screenshot is disclosed in the report; never fetch the live site to replace evidence. */
			}
		await page.setContent(renderReportHtml(snapshot, screenshotData), { waitUntil: "load", timeout: 15_000 });
		const pdf = await page.pdf({
			format: "A4",
			printBackground: true,
			displayHeaderFooter: true,
			headerTemplate: `<div style="font-size:8px;width:100%;padding:0 14mm;color:#66716d">ZZGEO · ${escapeHtml(payload.batch?.config?.project?.name ?? snapshot.title)}</div>`,
			footerTemplate:
				'<div style="font-size:8px;width:100%;padding:0 14mm;text-align:right;color:#66716d">ZZGEO · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
			margin: { top: "20mm", right: "14mm", bottom: "18mm", left: "14mm" },
		});
		await putArtifact(artifactKey, pdf, "application/pdf");
	} finally {
		await browser.close();
	}
	await database.query("UPDATE report_snapshots SET pdf_artifact_key=COALESCE(pdf_artifact_key,$2) WHERE id=$1", [
		reportId,
		artifactKey,
	]);
	return { artifactKey };
}

export async function generateReportWord(database: Database, reportId: string): Promise<{ artifactKey: string }> {
	const snapshot = await getReportSnapshot(database, reportId);
	if (!snapshot) throw new HttpInputError("报告快照不存在", 404);
	const artifactKey = `reports/${reportId}.docx`;
	if (!(await artifactExists(artifactKey)))
		await putArtifact(
			artifactKey,
			renderReportDocx(snapshot),
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
	await database.query("UPDATE report_snapshots SET word_artifact_key=COALESCE(word_artifact_key,$2) WHERE id=$1", [
		reportId,
		artifactKey,
	]);
	return { artifactKey };
}

export async function requestReportPdf(
	database: Database,
	reportId: string,
): Promise<{ status: "ready" | "queued"; artifactKey: string | null }> {
	await sweepTerminalLeases(database);
	const report = await getReportSnapshot(database, reportId);
	if (!report) throw new HttpInputError("报告快照不存在", 404);
	if (report.pdf_artifact_key && report.word_artifact_key)
		return { status: "ready", artifactKey: String(report.pdf_artifact_key) };
	const active = (
		await database.query(
			"SELECT id FROM jobs WHERE type IN ('report_document','report_pdf') AND payload->>'reportId'=$1 AND status IN ('pending','leased') LIMIT 1",
			[reportId],
		)
	).rows[0];
	if (!active)
		await database.query(
			"INSERT INTO jobs (id,type,payload,status,available_at,created_at,updated_at) VALUES ($1,'report_document',$2::jsonb,'pending',now(),now(),now())",
			[randomUUID(), JSON.stringify({ reportId })],
		);
	return { status: "queued", artifactKey: null };
}

export async function getReportPdfStatus(
	database: Database,
	reportId: string,
): Promise<{
	status: "ready" | "queued" | "failed" | "missing";
	artifactKey: string | null;
	wordArtifactKey: string | null;
	error: string | null;
}> {
	const report = await getReportSnapshot(database, reportId);
	if (!report) return { status: "missing", artifactKey: null, wordArtifactKey: null, error: "报告快照不存在" };
	if (report.pdf_artifact_key && report.word_artifact_key)
		return {
			status: "ready",
			artifactKey: String(report.pdf_artifact_key),
			wordArtifactKey: String(report.word_artifact_key),
			error: null,
		};
	const job = (
		await database.query<Record<string, unknown>>(
			"SELECT status,last_error FROM jobs WHERE type IN ('report_document','report_pdf') AND payload->>'reportId'=$1 ORDER BY created_at DESC LIMIT 1",
			[reportId],
		)
	).rows[0];
	return job?.status === "failed"
		? {
				status: "failed",
				artifactKey: report.pdf_artifact_key ? String(report.pdf_artifact_key) : null,
				wordArtifactKey: report.word_artifact_key ? String(report.word_artifact_key) : null,
				error: String(job.last_error ?? "报告文档生成失败"),
			}
		: {
				status: "queued",
				artifactKey: report.pdf_artifact_key ? String(report.pdf_artifact_key) : null,
				wordArtifactKey: report.word_artifact_key ? String(report.word_artifact_key) : null,
				error: null,
			};
}

export async function queueScheduledReportSnapshots(database: Database): Promise<number> {
	const batches = await database.query<{ batch_id: string; report_id: string | null }>(
		`SELECT b.id AS batch_id,
			(SELECT id FROM report_snapshots WHERE batch_id=b.id ORDER BY created_at DESC LIMIT 1) AS report_id
		 FROM monitoring_schedules s
		 JOIN experiment_batches b ON b.id=s.last_batch_id
		 JOIN projects p ON p.id=b.project_id JOIN organizations o ON o.id=p.organization_id
 WHERE b.status IN ('complete','partial') AND o.suspended_at IS NULL`,
	);
	let created = 0;
	for (const batch of batches.rows) {
		try {
			const result = await advanceReportWorkflow(database, batch.batch_id, {
				actor: { kind: "service", serviceId: "report-scheduler" },
			});
			if (!batch.report_id && result.reportId) created += 1;
		} catch (error) {
			reportLogger.error("report.workflow_failed", safeErrorMessage(error), {
				traceId: batch.batch_id,
				metadata: { batchId: batch.batch_id, scheduled: true },
			});
		}
	}
	return created;
}

export async function runOneReportJob(database: Database, owner: string): Promise<boolean> {
	await sweepTerminalLeases(database);
	const job = await database.transaction(async (transaction) => {
		const result = await transaction.query<{ id: string; payload: { reportId: string } }>(
			`WITH candidate AS (
				SELECT id FROM jobs WHERE type IN ('report_document','report_pdf') AND attempts<max_attempts
				 AND available_at<=now() AND (status='pending' OR (status='leased' AND lease_expires_at<now()))
				 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
			) UPDATE jobs SET status='leased',lease_owner=$1,lease_expires_at=now()+interval '5 minutes',
			 attempts=attempts+1,updated_at=now() WHERE id=(SELECT id FROM candidate) RETURNING id,payload`,
			[owner],
		);
		return result.rows[0] ?? null;
	});
	if (!job) return false;
	const leaseTimer = setInterval(
		() =>
			void database
				.query(
					"UPDATE jobs SET lease_expires_at=now()+interval '5 minutes' WHERE id=$1 AND lease_owner=$2 AND status='leased'",
					[job.id, owner],
				)
				.catch(() => undefined),
		30_000,
	);
	const reportContext = (
		await database.query<{ organization_id: string; project_id: string }>(
			"SELECT organization_id,project_id FROM report_snapshots WHERE id=$1",
			[job.payload.reportId],
		)
	).rows[0];
	reportLogger.info("report.document_started", "开始生成 PDF 与 Word", {
		organizationId: reportContext?.organization_id ?? null,
		projectId: reportContext?.project_id ?? null,
		traceId: job.id,
		metadata: { reportId: job.payload.reportId },
	});
	try {
		await generateReportPdf(database, job.payload.reportId);
		await generateReportWord(database, job.payload.reportId);
		await database.query(
			"UPDATE jobs SET status='complete',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2",
			[job.id, owner],
		);
		reportLogger.info("report.document_completed", "PDF 与 Word 生成完成", {
			organizationId: reportContext?.organization_id ?? null,
			projectId: reportContext?.project_id ?? null,
			traceId: job.id,
			metadata: { reportId: job.payload.reportId },
		});
	} catch (error) {
		await database.query(
			`UPDATE jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed'::job_status ELSE 'pending'::job_status END,
			 lease_owner=NULL,lease_expires_at=NULL,last_error=$3,available_at=now()+interval '30 seconds',updated_at=now()
			 WHERE id=$1 AND lease_owner=$2`,
			[job.id, owner, error instanceof Error ? error.message.slice(0, 2000) : "PDF 生成失败"],
		);
		reportLogger.error("report.document_failed", safeErrorMessage(error), {
			organizationId: reportContext?.organization_id ?? null,
			projectId: reportContext?.project_id ?? null,
			traceId: job.id,
			metadata: { reportId: job.payload.reportId },
		});
	} finally {
		clearInterval(leaseTimer);
	}
	return true;
}

export async function flushReportLogs(): Promise<void> {
	await reportLogger.flush();
}

export async function createReportShare(
	database: Database,
	reportId: string,
	expiresInDays: number,
	createdBy: string | null = null,
): Promise<{ id: string; token: string; expiresAt: string }> {
	if (!(await getReportSnapshot(database, reportId))) throw new HttpInputError("报告快照不存在", 404);
	const id = randomUUID();
	const token = randomBytes(32).toString("base64url");
	const expiresAt = new Date(Date.now() + Math.max(1, Math.min(365, expiresInDays)) * 86_400_000).toISOString();
	await database.query(
		"INSERT INTO report_shares (id,report_id,token_hash,expires_at,created_by) VALUES ($1,$2,$3,$4,$5)",
		[id, reportId, hashToken(token), expiresAt, createdBy],
	);
	return { id, token, expiresAt };
}

export async function listReportShares(
	database: Database,
	reportId: string,
	input: PaginationInput,
): Promise<Paginated<Record<string, unknown>>> {
	const total = Number(
		(
			await database.query<{ count: number }>("SELECT count(*)::int AS count FROM report_shares WHERE report_id=$1", [
				reportId,
			])
		).rows[0]?.count ?? 0,
	);
	const rows = (
		await database.query<Record<string, unknown>>(
			`SELECT s.id,s.report_id,s.expires_at,s.revoked_at,s.created_at,u.email AS created_by_email
			 FROM report_shares s LEFT JOIN users u ON u.id=s.created_by
			 WHERE s.report_id=$1 ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`,
			[reportId, input.pageSize, input.offset],
		)
	).rows;
	return paginated(rows, total, input);
}

export async function revokeReportShare(database: Database, shareId: string): Promise<void> {
	const result = await database.query("UPDATE report_shares SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1", [
		shareId,
	]);
	if (result.affectedRows !== 1) throw new HttpInputError("分享链接不存在", 404);
}

export async function getSharedReport(database: Database, token: string): Promise<Record<string, unknown> | null> {
	const row = (
		await database.query<{ report_id: string }>(
			"SELECT s.report_id FROM report_shares s JOIN report_snapshots r ON r.id=s.report_id JOIN organizations o ON o.id=r.organization_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND o.suspended_at IS NULL",
			[hashToken(token)],
		)
	).rows[0];
	return row ? getReportSnapshot(database, row.report_id) : null;
}

export function reportCsv(snapshot: Record<string, unknown>): string {
	const payload = snapshot.payload as {
		report?: { analysis?: { promptRows?: Array<Record<string, unknown>>; evidenceIndex?: EvidenceIndexEntry[] } };
	};
	const rows = payload.report?.analysis?.promptRows ?? [];
	const index = payload.report?.analysis?.evidenceIndex ?? [];
	const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
	const metrics =
		(snapshot.payload as { batch?: { metrics?: { overall?: Record<string, unknown> } } }).batch?.metrics?.overall ?? {};
	const intervals = metrics.confidenceIntervals as Record<string, unknown> | undefined;
	const lines = [
		["测量版本", "V2"],
		["可报告状态", metrics.status ?? "unavailable"],
		["采集覆盖", metrics.captureCoverage ?? null],
		["解析覆盖", metrics.parseCoverage ?? null],
		["问题覆盖", metrics.promptCoverage ?? null],
		["提及率95%区间", JSON.stringify(intervals?.brandMentionRate ?? null)],
		[],
		["问题", "意图", "有效样本", "计划样本", "品牌提及率", "首位推荐率", "明确推荐名次中位数", "来源数"],
		...rows.map((row) => [
			row.question,
			row.intent,
			row.completeSamples,
			row.plannedSamples,
			row.targetMentionRate,
			row.firstRecommendationRate,
			row.bestTargetPosition,
			row.sourceCount,
		]),
	];
	const comparisonRows = (
		snapshot.payload as {
			comparison?: {
				pairedResults?: Array<{
					provider_id: string;
					metric: string;
					result: {
						previous: number | null;
						current: number | null;
						delta: number | null;
						interval: unknown;
						promptIds: string[];
						status: string;
					};
				}>;
			};
		}
	).comparison?.pairedResults;
	if (comparisonRows?.length)
		lines.push(
			[],
			["平台", "指标", "基线（共同问题）", "复测（共同问题）", "配对变化", "95%区间", "共同问题数", "状态"],
			...comparisonRows.map((row) => [
				row.provider_id,
				row.metric,
				row.result.previous,
				row.result.current,
				row.result.delta,
				JSON.stringify(row.result.interval),
				row.result.promptIds.length,
				row.result.status,
			]),
		);

	if (index.length) {
		lines.push([], ["证据编号", "来源", "问题/页面", "采样", "时间", "引用网址", "证据 ID"]);
		for (const entry of index)
			lines.push([
				`[${entry.n}]`,
				entry.platformLabel ?? entry.platform ?? "",
				entry.question ?? entry.title ?? entry.url ?? "",
				entry.attempt ? `第 ${entry.attempt} 次` : "",
				entry.capturedAt ?? "",
				entry.sourceUrls.join(" | ") || entry.url || "",
				entry.id,
			]);
	}
	return lines.map((row) => row.map(quote).join(",")).join("\n");
}
