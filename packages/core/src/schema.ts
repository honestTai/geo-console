import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	real,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

const id = (name: string) => text(name).primaryKey();
const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const projectStatus = pgEnum("project_status", ["draft", "review", "active", "archived"]);
export const platform = pgEnum("platform", ["deepseek", "kimi"]);
export const batchKind = pgEnum("batch_kind", ["baseline", "retest"]);
export const batchStatus = pgEnum("batch_status", ["draft", "queued", "running", "complete", "partial"]);
export const jobStatus = pgEnum("job_status", ["pending", "leased", "complete", "failed"]);
export const captureStatus = pgEnum("capture_status", [
	"complete",
	"no_answer",
	"login_required",
	"challenge_required",
	"rate_limited",
	"page_contract_changed",
	"timeout",
	"failed",
]);

export const projects = pgTable("projects", {
	id: id("id"),
	name: text("name").notNull(),
	websiteUrl: text("website_url").notNull(),
	domain: text("domain").notNull(),
	region: text("region").notNull(),
	language: text("language").notNull(),
	businessFocus: text("business_focus"),
	aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
	profile: jsonb("profile").$type<Record<string, unknown> | null>(),
	status: projectStatus("status").notNull().default("draft"),
	confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
	createdAt,
	updatedAt,
});

export const competitors = pgTable(
	"competitors",
	{
		id: id("id"),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		domain: text("domain").notNull(),
		aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
		approved: boolean("approved").notNull().default(false),
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		createdAt,
	},
	(table) => [
		uniqueIndex("competitors_active_project_domain_unique")
			.on(table.projectId, table.domain)
			.where(sql`${table.archivedAt} IS NULL`),
	],
);

export const prompts = pgTable(
	"prompts",
	{
		id: id("id"),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		question: text("question").notNull(),
		intent: text("intent").notNull(),
		tags: jsonb("tags").$type<string[]>().notNull().default([]),
		approved: boolean("approved").notNull().default(false),
		position: integer("position").notNull(),
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		createdAt,
	},
	(table) => [index("prompts_project_idx").on(table.projectId)],
);

export const websiteSnapshots = pgTable(
	"website_snapshots",
	{
		id: id("id"),
		projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
		url: text("url").notNull(),
		domain: text("domain").notNull(),
		title: text("title"),
		contentText: text("content_text").notNull(),
		structuredData: jsonb("structured_data").$type<unknown[]>().notNull().default([]),
		contentHash: text("content_hash").notNull(),
		artifactKey: text("artifact_key"),
		fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
		createdAt,
	},
	(table) => [index("website_snapshots_project_idx").on(table.projectId)],
);

export type WebsiteAuditResult = {
	requestedUrl: string;
	checkedAt: string;
	verdict: "ready" | "ready_with_warnings" | "blocked";
	score: number;
	transport: {
		https: { ok: boolean; status: number | null; error: string | null };
		httpFallback: { checked: boolean; ok: boolean; status: number | null; error: string | null };
		browserFallback: { checked: boolean; ok: boolean; status: number | null; error: string | null };
	};
	homepage: {
		auditedUrl: string | null;
		auditedWith: "standard_audit" | "browser_fallback" | null;
		title: string | null;
		description: string | null;
		canonical: string | null;
		language: string | null;
		h1Count: number;
		h2Count: number;
		wordCount: number;
		structuredDataTypes: string[];
		hasContactSignals: boolean;
		hasBrandMention: boolean;
		contentHash: string | null;
	};
	discovery: {
		robots: { ok: boolean; status: number | null; blockedBots: string[]; error: string | null };
		sitemap: { ok: boolean; status: number | null; urlCount: number; error: string | null };
		llmsTxt: { ok: boolean; status: number | null; error: string | null };
	};
	checks: Array<{
		id: string;
		label: string;
		status: "pass" | "warning" | "fail" | "skip";
		detail: string;
		weight: number;
	}>;
};

export const websiteAudits = pgTable(
	"website_audits",
	{
		id: id("id"),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		requestedUrl: text("requested_url").notNull(),
		result: jsonb("result").$type<WebsiteAuditResult>().notNull(),
		resultHash: text("result_hash").notNull(),
		checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
		createdAt,
	},
	(table) => [index("website_audits_project_idx").on(table.projectId, table.checkedAt)],
);

export type FrozenBatchConfig = {
	project: { name: string; domain: string; region: string; language: string; aliases: string[] };
	competitors: Array<{ id: string; name: string; domain: string; aliases: string[] }>;
	prompts: Array<{ id: string; question: string; intent: string; tags: string[] }>;
	platforms: Array<"deepseek" | "kimi">;
	repeats: number;
	collectorVersion: string;
};

export const experimentBatches = pgTable(
	"experiment_batches",
	{
		id: id("id"),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		kind: batchKind("kind").notNull(),
		compareToBatchId: text("compare_to_batch_id"),
		status: batchStatus("status").notNull().default("draft"),
		config: jsonb("config").$type<FrozenBatchConfig>().notNull(),
		configHash: text("config_hash").notNull(),
		startedAt: timestamp("started_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt,
	},
	(table) => [index("batches_project_idx").on(table.projectId)],
);

export const collectorNodes = pgTable("collector_nodes", {
	id: id("id"),
	name: text("name").notNull(),
	tokenHash: text("token_hash").notNull(),
	version: text("version").notNull(),
	capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
	revokedAt: timestamp("revoked_at", { withTimezone: true }),
	createdAt,
});

export type CaptureJobPayload = {
	projectId: string;
	batchId: string;
	promptId: string;
	prompt: string;
	platform: "deepseek" | "kimi";
	attempt: number;
	region: string;
	locale: string;
	brands: Array<{ id: string; name: string; aliases: string[] }>;
};

export const jobs = pgTable(
	"jobs",
	{
		id: id("id"),
		type: text("type").notNull(),
		payload: jsonb("payload").$type<CaptureJobPayload>().notNull(),
		status: jobStatus("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull().default(3),
		availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
		leaseOwner: text("lease_owner"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		lastError: text("last_error"),
		createdAt,
		updatedAt,
	},
	(table) => [index("jobs_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt)],
);

export const queryCaptures = pgTable(
	"query_captures",
	{
		id: id("id"),
		jobId: text("job_id")
			.notNull()
			.references(() => jobs.id),
		batchId: text("batch_id")
			.notNull()
			.references(() => experimentBatches.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		promptId: text("prompt_id")
			.notNull()
			.references(() => prompts.id),
		platform: platform("platform").notNull(),
		attempt: integer("attempt").notNull(),
		status: captureStatus("status").notNull(),
		answerText: text("answer_text"),
		brandMatches: jsonb("brand_matches").$type<unknown[]>().notNull().default([]),
		sources: jsonb("sources").$type<unknown[]>().notNull().default([]),
		queryFanOut: jsonb("query_fan_out").$type<string[]>().notNull().default([]),
		pageUrl: text("page_url").notNull(),
		screenshotKey: text("screenshot_key"),
		traceKey: text("trace_key"),
		contentHash: text("content_hash"),
		adapterVersion: text("adapter_version").notNull(),
		collectorNodeId: text("collector_node_id").notNull(),
		failureCode: text("failure_code"),
		failureMessage: text("failure_message"),
		capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
		createdAt,
	},
	(table) => [
		uniqueIndex("captures_job_unique").on(table.jobId),
		index("captures_batch_platform_idx").on(table.batchId, table.platform),
	],
);

export const diagnosisFindings = pgTable(
	"diagnosis_findings",
	{
		id: id("id"),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		batchId: text("batch_id")
			.notNull()
			.references(() => experimentBatches.id, { onDelete: "cascade" }),
		category: text("category").notNull(),
		title: text("title").notNull(),
		detail: text("detail").notNull(),
		confidence: real("confidence").notNull(),
		evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull(),
		targetPromptIds: jsonb("target_prompt_ids").$type<string[]>().notNull().default([]),
		recommendation: text("recommendation").notNull(),
		createdAt,
	},
	(table) => [index("findings_batch_idx").on(table.batchId)],
);

export const remediationTasks = pgTable(
	"remediation_tasks",
	{
		id: id("id"),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		findingId: text("finding_id").references(() => diagnosisFindings.id, { onDelete: "set null" }),
		title: text("title").notNull(),
		detail: text("detail").notNull(),
		priority: text("priority").notNull(),
		status: text("status").notNull().default("todo"),
		owner: text("owner"),
		dueDate: timestamp("due_date", { withTimezone: true }),
		targetPromptIds: jsonb("target_prompt_ids").$type<string[]>().notNull().default([]),
		evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default([]),
		expectedMetric: text("expected_metric").notNull(),
		acceptanceCriteria: text("acceptance_criteria").notNull(),
		contentBrief: text("content_brief"),
		draftContent: text("draft_content"),
		publishedUrl: text("published_url"),
		verifiedSnapshotId: text("verified_snapshot_id").references(() => websiteSnapshots.id),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt,
		updatedAt,
	},
	(table) => [index("tasks_project_idx").on(table.projectId)],
);

export const monitoringSchedules = pgTable(
	"monitoring_schedules",
	{
		id: id("id"),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		enabled: boolean("enabled").notNull().default(false),
		frequencyDays: integer("frequency_days").notNull().default(7),
		platforms: jsonb("platforms").$type<Array<"deepseek" | "kimi">>().notNull().default([]),
		repeats: integer("repeats").notNull().default(3),
		nextRunAt: timestamp("next_run_at", { withTimezone: true }),
		lastRunAt: timestamp("last_run_at", { withTimezone: true }),
		lastBatchId: text("last_batch_id").references(() => experimentBatches.id, { onDelete: "set null" }),
		createdAt,
		updatedAt,
	},
	(table) => [
		uniqueIndex("monitoring_schedules_project_unique").on(table.projectId),
		index("monitoring_schedules_due_idx").on(table.enabled, table.nextRunAt),
	],
);

export const attributionImports = pgTable(
	"attribution_imports",
	{
		id: id("id"),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		sourceType: text("source_type").notNull(),
		fileName: text("file_name").notNull(),
		rowCount: integer("row_count").notNull(),
		contentHash: text("content_hash").notNull(),
		importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("attribution_imports_project_hash_unique").on(table.projectId, table.contentHash),
		index("attribution_imports_project_idx").on(table.projectId, table.importedAt),
	],
);

export const attributionEvents = pgTable(
	"attribution_events",
	{
		id: id("id"),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		importId: text("import_id")
			.notNull()
			.references(() => attributionImports.id, { onDelete: "cascade" }),
		sourceType: text("source_type").notNull(),
		metric: text("metric").notNull(),
		value: real("value").notNull(),
		observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
		landingUrl: text("landing_url"),
		externalId: text("external_id"),
		channel: text("channel"),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
		createdAt,
	},
	(table) => [index("attribution_events_project_date_idx").on(table.projectId, table.observedAt)],
);

export const settings = pgTable("settings", {
	key: text("key").primaryKey(),
	value: jsonb("value").$type<unknown>().notNull(),
	updatedAt,
});
