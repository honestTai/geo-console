import { sql } from "drizzle-orm";
import {
	bigint,
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
export const batchKind = pgEnum("batch_kind", ["quick_audit", "baseline", "retest"]);
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
	"auth_required",
	"search_not_triggered",
	"model_unavailable",
	"protocol_changed",
	"failed",
]);

export const searchProviderIds = ["deepseek_api", "kimi_api", "doubao_api", "qwen_api", "yuanbao_hunyuan"] as const;
export type SearchProviderId = (typeof searchProviderIds)[number];
export type LegacyConsumerSurface = "deepseek" | "kimi";
export type CapturePlatform = SearchProviderId | LegacyConsumerSurface;
export type CaptureMode = "consumer_surface" | "llm_search_api";
export type CapabilityVisibility = "available" | "partial" | "unavailable";

export const organizations = pgTable("organizations", {
	id: id("id"),
	name: text("name").notNull(),
	createdAt,
	updatedAt,
});

export const projects = pgTable("projects", {
	id: id("id"),
	organizationId: text("organization_id")
		.notNull()
		.default("default")
		.references(() => organizations.id),
	name: text("name").notNull(),
	websiteUrl: text("website_url").notNull(),
	domain: text("domain").notNull(),
	region: text("region").notNull(),
	language: text("language").notNull(),
	businessFocus: text("business_focus"),
	industry: text("industry"),
	aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
	profile: jsonb("profile").$type<Record<string, unknown> | null>(),
	status: projectStatus("status").notNull().default("draft"),
	confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
	createdAt,
	updatedAt,
});

export const promptLibraryQuestions = pgTable(
	"prompt_library_questions",
	{
		id: id("id"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		industry: text("industry").notNull(),
		question: text("question").notNull(),
		intent: text("intent").notNull(),
		topic: text("topic"),
		persona: text("persona"),
		tags: jsonb("tags").$type<string[]>().notNull().default([]),
		createdBy: text("created_by"),
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		createdAt,
		updatedAt,
	},
	(table) => [
		uniqueIndex("prompt_library_active_question_unique")
			.on(table.organizationId, table.industry, table.question)
			.where(sql`${table.archivedAt} IS NULL`),
		index("prompt_library_organization_industry_idx").on(table.organizationId, table.industry, table.createdAt),
	],
);

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
		libraryQuestionId: text("library_question_id").references(() => promptLibraryQuestions.id, {
			onDelete: "set null",
		}),
		question: text("question").notNull(),
		intent: text("intent").notNull(),
		topic: text("topic"),
		persona: text("persona"),
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
	project: {
		name: string;
		domain: string;
		region: string;
		language: string;
		industry?: string | null;
		aliases: string[];
	};
	competitors: Array<{ id: string; name: string; domain: string; aliases: string[] }>;
	prompts: Array<{
		id: string;
		question: string;
		intent: string;
		topic?: string | null;
		persona?: string | null;
		tags: string[];
	}>;
	platforms: CapturePlatform[];
	repeats: number;
	collectorVersion?: string;
	runnerVersion?: string;
	samplingMode?: "quick" | "formal";
	executionWindows?: string[];
	providers?: Array<{
		id: SearchProviderId;
		endpoint?: string;
		secondaryEndpoint?: string;
		model: string;
		protocol: string;
		searchToolVersion: string;
		searchStrategy: Record<string, unknown>;
		adapterVersion?: string;
	}>;
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
	platform: CapturePlatform;
	attempt: number;
	region: string;
	locale: string;
	brands: Array<{ id: string; name: string; aliases: string[] }>;
};

export type AgentPurpose =
	| "customer_profile"
	| "prompt_research"
	| "diagnosis"
	| "remediation"
	| "content_brief"
	| "report_narrative"
	| "quality_review";

export type AgentJobPayload = {
	runId: string;
	targetTaskId: string | null;
};

export type JobPayload = CaptureJobPayload | AgentJobPayload | { reportId: string };

export const jobs = pgTable(
	"jobs",
	{
		id: id("id"),
		type: text("type").notNull(),
		payload: jsonb("payload").$type<JobPayload>().notNull(),
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
		platform: text("platform").$type<CapturePlatform>().notNull(),
		attempt: integer("attempt").notNull(),
		status: captureStatus("status").notNull(),
		answerText: text("answer_text"),
		brandMatches: jsonb("brand_matches").$type<unknown[]>().notNull().default([]),
		sources: jsonb("sources").$type<unknown[]>().notNull().default([]),
		queryFanOut: jsonb("query_fan_out").$type<string[]>().notNull().default([]),
		pageUrl: text("page_url"),
		screenshotKey: text("screenshot_key"),
		traceKey: text("trace_key"),
		contentHash: text("content_hash"),
		adapterVersion: text("adapter_version").notNull(),
		collectorNodeId: text("collector_node_id"),
		schemaVersion: text("schema_version").notNull().default("geo.query-capture.v1"),
		captureMode: text("capture_mode").$type<CaptureMode>().notNull().default("consumer_surface"),
		model: text("model"),
		protocol: text("protocol"),
		searchToolVersion: text("search_tool_version"),
		sourceVisibility: text("source_visibility").$type<CapabilityVisibility>().notNull().default("available"),
		fanoutVisibility: text("fanout_visibility").$type<CapabilityVisibility>().notNull().default("available"),
		rawArtifactKey: text("raw_artifact_key"),
		providerRequestId: text("provider_request_id"),
		usage: jsonb("usage").$type<Record<string, number> | null>(),
		costMicros: bigint("cost_micros", { mode: "number" }),
		latencyMs: integer("latency_ms"),
		executorId: text("executor_id"),
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
		platforms: jsonb("platforms").$type<CapturePlatform[]>().notNull().default([]),
		repeats: integer("repeats").notNull().default(3),
		samplingMode: text("sampling_mode").$type<"quick" | "formal">().notNull().default("formal"),
		executionWindows: jsonb("execution_windows").$type<string[]>().notNull().default([]),
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

export type ProviderSearchStrategy = {
	forced: boolean;
	returnSources: boolean;
	options?: Record<string, unknown>;
};

export const providerConfigs = pgTable(
	"provider_configs",
	{
		id: id("id"),
		organizationId: text("organization_id")
			.notNull()
			.default("default")
			.references(() => organizations.id, { onDelete: "cascade" }),
		providerId: text("provider_id").$type<SearchProviderId>().notNull(),
		enabled: boolean("enabled").notNull().default(false),
		model: text("model").notNull(),
		endpoint: text("endpoint").notNull(),
		protocol: text("protocol").notNull(),
		searchStrategy: jsonb("search_strategy").$type<ProviderSearchStrategy>().notNull().default({
			forced: true,
			returnSources: true,
		}),
		adapterVersion: text("adapter_version").notNull(),
		lastTestStatus: text("last_test_status"),
		lastTestMessage: text("last_test_message"),
		lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
		createdAt,
		updatedAt,
	},
	(table) => [uniqueIndex("provider_configs_organization_provider_unique").on(table.organizationId, table.providerId)],
);

export const encryptedCredentials = pgTable(
	"encrypted_credentials",
	{
		id: id("id"),
		organizationId: text("organization_id")
			.notNull()
			.default("default")
			.references(() => organizations.id, { onDelete: "cascade" }),
		credentialKey: text("credential_key").notNull(),
		ciphertext: text("ciphertext").notNull(),
		iv: text("iv").notNull(),
		authTag: text("auth_tag").notNull(),
		keyVersion: text("key_version").notNull(),
		createdAt,
		updatedAt,
	},
	(table) => [
		uniqueIndex("encrypted_credentials_organization_key_unique").on(table.organizationId, table.credentialKey),
	],
);

export type OrganizationRole = "admin" | "analyst" | "viewer";

export const users = pgTable(
	"users",
	{
		id: id("id"),
		organizationId: text("organization_id")
			.notNull()
			.default("default")
			.references(() => organizations.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		displayName: text("display_name").notNull(),
		role: text("role").$type<OrganizationRole>().notNull(),
		isSuperAdmin: boolean("is_super_admin").notNull().default(false),
		passwordHash: text("password_hash").notNull(),
		disabledAt: timestamp("disabled_at", { withTimezone: true }),
		createdAt,
		updatedAt,
	},
	(table) => [uniqueIndex("users_organization_email_unique").on(table.organizationId, table.email)],
);

export const sessions = pgTable(
	"sessions",
	{
		id: id("id"),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt,
	},
	(table) => [
		uniqueIndex("sessions_token_unique").on(table.tokenHash),
		index("sessions_lookup_idx").on(table.expiresAt),
	],
);

export const auditLogs = pgTable(
	"audit_logs",
	{
		id: id("id"),
		organizationId: text("organization_id")
			.notNull()
			.default("default")
			.references(() => organizations.id, { onDelete: "cascade" }),
		actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
		action: text("action").notNull(),
		targetType: text("target_type").notNull(),
		targetId: text("target_id"),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
		createdAt,
	},
	(table) => [index("audit_logs_organization_idx").on(table.organizationId, table.createdAt)],
);

export type ServiceLogLevel = "debug" | "info" | "warn" | "error";

export const serviceLogs = pgTable(
	"service_logs",
	{
		id: id("id"),
		organizationId: text("organization_id"),
		service: text("service").notNull(),
		level: text("level").$type<ServiceLogLevel>().notNull(),
		event: text("event").notNull(),
		message: text("message").notNull(),
		traceId: text("trace_id"),
		projectId: text("project_id"),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		createdAt,
	},
	(table) => [
		index("service_logs_organization_time_idx").on(table.organizationId, table.occurredAt),
		index("service_logs_service_level_time_idx").on(table.service, table.level, table.occurredAt),
		index("service_logs_trace_idx").on(table.traceId),
	],
);

export const agentRuns = pgTable(
	"agent_runs",
	{
		id: id("id"),
		organizationId: text("organization_id")
			.notNull()
			.default("default")
			.references(() => organizations.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		batchId: text("batch_id").references(() => experimentBatches.id, { onDelete: "set null" }),
		purpose: text("purpose").$type<AgentPurpose>().notNull(),
		status: text("status").notNull(),
		model: text("model").notNull(),
		promptVersion: text("prompt_version").notNull(),
		evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default([]),
		toolTrace: jsonb("tool_trace").$type<unknown[]>().notNull().default([]),
		usage: jsonb("usage").$type<Record<string, number> | null>(),
		costMicros: bigint("cost_micros", { mode: "number" }),
		draft: jsonb("draft").$type<Record<string, unknown> | null>(),
		errorMessage: text("error_message"),
		approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
		approvedAt: timestamp("approved_at", { withTimezone: true }),
		createdAt,
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [index("agent_runs_project_idx").on(table.projectId, table.createdAt)],
);

export type ReportType = "quick_audit" | "remediation" | "retest";

export const reportSnapshots = pgTable(
	"report_snapshots",
	{
		id: id("id"),
		organizationId: text("organization_id")
			.notNull()
			.default("default")
			.references(() => organizations.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		batchId: text("batch_id").references(() => experimentBatches.id, { onDelete: "set null" }),
		compareToBatchId: text("compare_to_batch_id").references(() => experimentBatches.id, { onDelete: "set null" }),
		reportType: text("report_type").$type<ReportType>().notNull(),
		schemaVersion: text("schema_version").notNull(),
		title: text("title").notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		payloadHash: text("payload_hash").notNull(),
		pdfArtifactKey: text("pdf_artifact_key"),
		wordArtifactKey: text("word_artifact_key"),
		createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
		createdAt,
	},
	(table) => [index("report_snapshots_project_idx").on(table.projectId, table.createdAt)],
);

export const reportShares = pgTable("report_shares", {
	id: id("id"),
	reportId: text("report_id")
		.notNull()
		.references(() => reportSnapshots.id, { onDelete: "cascade" }),
	tokenHash: text("token_hash").notNull().unique(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true }),
	createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
	createdAt,
});

export const driftAlerts = pgTable(
	"drift_alerts",
	{
		id: id("id"),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		batchId: text("batch_id")
			.notNull()
			.references(() => experimentBatches.id, { onDelete: "cascade" }),
		providerId: text("provider_id").$type<SearchProviderId>().notNull(),
		metric: text("metric").notNull(),
		previousValue: real("previous_value"),
		currentValue: real("current_value"),
		severity: text("severity").notNull(),
		evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default([]),
		acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
		createdAt,
	},
	(table) => [index("drift_alerts_project_idx").on(table.projectId, table.createdAt)],
);

export const projectCosts = pgTable(
	"project_costs",
	{
		id: id("id"),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		batchId: text("batch_id").references(() => experimentBatches.id, { onDelete: "set null" }),
		providerId: text("provider_id").notNull(),
		operation: text("operation").notNull(),
		usage: jsonb("usage").$type<Record<string, number> | null>(),
		costMicros: bigint("cost_micros", { mode: "number" }),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("project_costs_project_idx").on(table.projectId, table.occurredAt)],
);
