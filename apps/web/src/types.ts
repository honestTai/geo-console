export type ProviderId = "deepseek_api" | "kimi_api" | "doubao_api" | "qwen_api" | "yuanbao_hunyuan";
export const providerIds: ProviderId[] = ["deepseek_api", "kimi_api", "doubao_api", "qwen_api", "yuanbao_hunyuan"];
export const providerLabels: Record<string, string> = {
	deepseek_api: "DeepSeek 联网 API",
	kimi_api: "Kimi 联网 API",
	doubao_api: "豆包・火山方舟联网 API",
	qwen_api: "通义千问・DashScope 联网 API",
	yuanbao_hunyuan: "元宝搜索源 + 混元合成",
	deepseek: "DeepSeek 历史消费端",
	kimi: "Kimi 历史消费端",
};
export const providerLogoPaths: Record<ProviderId, string> = {
	deepseek_api: `${import.meta.env.BASE_URL}provider-logos/deepseek.svg`,
	kimi_api: `${import.meta.env.BASE_URL}provider-logos/kimi.png`,
	doubao_api: `${import.meta.env.BASE_URL}provider-logos/volcengine.png`,
	qwen_api: `${import.meta.env.BASE_URL}provider-logos/qwen.svg`,
	yuanbao_hunyuan: `${import.meta.env.BASE_URL}provider-logos/yuanbao.png`,
};
export const providerLabel = (id: string): string => providerLabels[id] ?? id;
export const providerShortLabel = (id: string): string =>
	({
		deepseek_api: "DeepSeek",
		kimi_api: "Kimi",
		doubao_api: "豆包",
		qwen_api: "通义千问",
		yuanbao_hunyuan: "元宝+混元",
	})[id] ?? providerLabel(id);
export const shortDate = (value: string): string =>
	new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
export const batchKindLabel = (kind: BatchSummary["kind"]): string =>
	kind === "quick_audit" ? "售前快审" : kind === "baseline" ? "正式基线" : "同条件复测";
export type UserIdentity = {
	id: string | null;
	email: string;
	displayName: string;
	role: "admin" | "analyst" | "viewer";
	homeOrganizationId: string;
	organizationId: string;
	organizationName: string;
	isSuperAdmin: boolean;
	localBypass: boolean;
	organizationSuspended: boolean;
	roles: Array<{ id: string; name: string }>;
	permissions: string[];
	allProjects: boolean;
	projectIds: string[];
};

export type Paginated<T> = { items: T[]; page: number; pageSize: number; total: number; totalPages: number };
export type NavigationItem = {
	key: string;
	group_label: string;
	label: string;
	navigation_key: View;
	icon_key: string;
	position: number;
};

export type ProjectSummary = {
	id: string;
	name: string;
	website_url: string;
	domain: string;
	region: string;
	language: string;
	industry: string | null;
	status: string;
	batch_count: number;
	last_batch_at: string | null;
};
export type Competitor = { id?: string; name: string; domain: string; aliases: string[] };
export type Prompt = {
	id?: string;
	library_question_id?: string | null;
	question: string;
	intent: string;
	topic?: string | null;
	persona?: string | null;
	tags: string[];
};
export type Finding = {
	id: string;
	batch_id: string;
	category: string;
	title: string;
	detail: string;
	confidence: number;
	evidence_ids: string[];
	target_prompt_ids: string[];
	recommendation: string;
};
export type Task = {
	id: string;
	title: string;
	detail: string;
	priority: string;
	status: string;
	owner: string | null;
	due_date: string | null;
	target_prompt_ids: string[];
	expected_metric: string;
	acceptance_criteria: string;
	published_url: string | null;
	content_brief: string | null;
	draft_content: string | null;
	verified_snapshot_id: string | null;
};
export type BatchSummary = {
	id: string;
	kind: "quick_audit" | "baseline" | "retest";
	status: string;
	created_at: string;
	completed_at: string | null;
	compare_to_batch_id: string | null;
};
export type Project = ProjectSummary & {
	aliases: string[];
	profile: Record<string, unknown> | null;
	competitors: Competitor[];
	prompts: Prompt[];
	batches: BatchSummary[];
	findings: Finding[];
	tasks: Task[];
	websiteAudits: WebsiteAuditRecord[];
	monitoringSchedule: MonitoringSchedule | null;
};
export type MonitoringSchedule = {
	id: string;
	enabled: boolean;
	frequency_days: number;
	platforms: ProviderId[];
	repeats: number;
	next_run_at: string | null;
	last_run_at: string | null;
};
export type AuditCheck = {
	id: string;
	label: string;
	status: "pass" | "warning" | "fail" | "skip";
	detail: string;
	weight: number;
};
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
	};
	discovery: {
		robots: { ok: boolean; status: number | null; blockedBots: string[]; error: string | null };
		sitemap: { ok: boolean; status: number | null; urlCount: number; error: string | null };
		llmsTxt: { ok: boolean; status: number | null; error: string | null };
	};
	checks: AuditCheck[];
};
export type WebsiteAuditRecord = { id: string; checked_at: string; result: WebsiteAuditResult };
export type Source = { url: string; domain: string; title: string | null; position: number; isCitation: boolean };
export type Capture = {
	captureId: string;
	prompt: string;
	engine: ProviderId | "deepseek" | "kimi";
	captureMode: "consumer_surface" | "llm_search_api";
	attempt: number;
	status: string;
	answerText: string | null;
	sources: Source[];
	queryFanOut: string[];
	brandMatches: Array<{ brandId: string; matchedAlias: string; position: number }>;
	sourceVisibility?: "available" | "partial" | "unavailable";
	fanoutVisibility?: "available" | "partial" | "unavailable";
	model?: string;
	protocol?: string;
	searchToolVersion?: string;
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
	costMicros?: number | null;
	latencyMs?: number | null;
	evidence: { screenshotObjectKey?: string | null; rawResponseObjectKey?: string | null; requestId?: string | null };
	failureMessage: string | null;
	capturedAt: string;
};
export type PlatformMetrics = {
	totalCaptures: number;
	answeredCaptures: number;
	answerCoverage: number;
	brandMentionRate: number;
	firstRecommendationRate: number;
	citationRate: number | null;
	averageMentionPosition: number | null;
	brandShareOfVoice?: number;
	repeatConsistency?: number | null;
	sourceCoverage?: number | null;
	competitorMentionRates: Record<string, number>;
};
export type Batch = BatchSummary & {
	project_id: string;
	config: {
		project: { name: string; domain: string };
		competitors: Competitor[];
		prompts: Prompt[];
		platforms: string[];
		repeats: number;
	};
	captures: Capture[];
	metrics: {
		perPlatform: Record<string, PlatformMetrics>;
		overall: Record<string, number | null>;
		validSamples: number;
		failedSamples: number;
		expectedSamples: number;
	};
};
export type ReportAnalysis = {
	generatedAt: string;
	executive: { headline: string; summary: string; evidenceLevel: "高" | "中" | "低"; validityNote: string };
	promptRows: Array<{
		promptId: string;
		question: string;
		intent: string;
		tags: string[];
		completeSamples: number;
		plannedSamples: number;
		targetMentionRate: number;
		firstRecommendationRate: number;
		bestTargetPosition: number | null;
		sourceCount: number;
		competitors: Array<{ id: string; name: string; mentionRate: number; bestPosition: number | null }>;
		captures: Array<{
			captureId: string;
			platform: string;
			attempt: number;
			status: string;
			targetPosition: number | null;
			sourceCount: number;
			screenshotKey: string | null;
		}>;
	}>;
	sourceDomains: Array<{
		domain: string;
		category: "owned" | "competitor" | "government" | "social" | "review" | "encyclopedia" | "other";
		citationCount: number;
		promptCount: number;
		isOwned: boolean;
		urls: Array<{ url: string; title: string | null; count: number }>;
	}>;
	perceptionExcerpts: Array<{ text: string; captureId: string; question: string; platform: string }>;
	topicCoverage: Array<{
		promptId: string;
		question: string;
		terms: Array<{ term: string; customerEvidenceIds: string[]; externalEvidenceIds: string[] }>;
	}>;
	webEvidenceSummary: { customerPages: number; competitorPages: number; citationPages: number };
	strengths: Array<{ title: string; detail: string; evidenceIds: string[] }>;
	gaps: Array<{ category: string; title: string; detail: string; recommendation: string; evidenceIds: string[] }>;
	websiteAudit: { id: string; result: WebsiteAuditResult } | null;
};
export type ReportPayload = {
	analysis: ReportAnalysis;
	findings: Finding[];
	tasks: Task[];
	attributionSummary: AttributionPayload["summary"];
};
export type TrendResponse = {
	anchorBatchId: string | null;
	comparable: Array<{
		id: string;
		kind: string;
		createdAt: string;
		metrics: Batch["metrics"];
	}>;
};
export type AttributionPayload = {
	summary: Array<{
		source_type: string;
		metric: string;
		value: number;
		first_observed_at: string;
		last_observed_at: string;
		observations: number;
	}>;
	events: Array<{
		id: string;
		source_type: string;
		metric: string;
		value: number;
		observed_at: string;
		landing_url: string | null;
		channel: string | null;
	}>;
	imports: Array<{
		id: string;
		source_type: string;
		file_name: string;
		row_count: number;
		imported_at: string;
	}>;
	eventsPagination: Omit<Paginated<never>, "items">;
	importsPagination: Omit<Paginated<never>, "items">;
};
export type AgentRun = {
	id: string;
	batch_id: string | null;
	purpose: string;
	status: "queued" | "running" | "awaiting_approval" | "approved" | "rejected" | "failed";
	model: string;
	draft: Record<string, unknown> | null;
	error_message: string | null;
	tool_trace: Array<{
		type: "start" | "end";
		tool: string;
		isError?: boolean;
		detail?: string | null;
		at: string;
	}>;
	usage: { input?: number; output?: number; totalTokens?: number } | null;
	job_attempts: number | null;
	job_max_attempts: number | null;
	created_at: string;
	completed_at: string | null;
};
export type ReportSnapshot = {
	id: string;
	batch_id: string;
	report_type: "quick_audit" | "remediation" | "retest";
	title: string;
	payload_hash: string;
	pdf_artifact_key: string | null;
	word_artifact_key: string | null;
	created_at: string;
};
export type ReportShare = {
	id: string;
	report_id: string;
	expires_at: string;
	revoked_at: string | null;
	created_at: string;
	created_by_email: string | null;
};
export type ReportWorkflowState =
	| "narrative_queued"
	| "narrative_running"
	| "narrative_approval"
	| "quality_queued"
	| "quality_running"
	| "quality_approval"
	| "quality_blocked"
	| "documents_queued"
	| "ready";
export type ReportWorkflowResult = {
	state: ReportWorkflowState;
	runId: string | null;
	reportId: string | null;
};
export type ServiceLogLevel = "debug" | "info" | "warn" | "error";
export type ServiceLogRow = {
	id: string;
	organization_id: string | null;
	service: string;
	level: ServiceLogLevel;
	event: string;
	message: string;
	trace_id: string | null;
	project_id: string | null;
	metadata: Record<string, unknown>;
	occurred_at: string;
};
export type ServiceLogResponse = {
	logs: ServiceLogRow[];
	nextCursor: string | null;
	counts: Record<ServiceLogLevel, number>;
};
export type DriftAlert = {
	id: string;
	provider_id: string;
	metric: string;
	previous_value: number | null;
	current_value: number | null;
	severity: string;
	evidence_ids: string[];
	acknowledged_at: string | null;
	created_at: string;
};
export type CostGroup = {
	providerId: string;
	operation: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	knownCostMicros: number;
	costKnownRequests: number;
};
export type ProviderSetting = {
	providerId: ProviderId;
	label: string;
	disclosure: string;
	enabled: boolean;
	configured: boolean;
	secondaryConfigured: boolean | null;
	model: string;
	endpoint: string;
	secondaryEndpoint: string | null;
	protocol: string;
	searchToolVersion: string;
	lastTestStatus: string | null;
	lastTestMessage: string | null;
	lastTestedAt: string | null;
};
export type ProviderDraft = Partial<ProviderSetting> & { apiKey?: string; secondaryApiKey?: string };
export type View =
	| "overview"
	| "monitor"
	| "evidence"
	| "audit"
	| "diagnosis"
	| "remediation"
	| "attribution"
	| "report"
	| "knowledge"
	| "settings"
	| "members"
	| "auditLogs"
	| "serviceLogs"
	| "rbac"
	| "organizations";
export const managementViews: View[] = [
	"knowledge",
	"settings",
	"members",
	"auditLogs",
	"serviceLogs",
	"rbac",
	"organizations",
];
export type OrganizationSummary = {
	id: string;
	name: string;
	project_count: number;
	user_count: number;
	created_at: string;
	suspended_at: string | null;
	suspended_reason: string | null;
};
export const sourceLabels: Record<string, string> = {
	ga4: "GA4",
	gsc: "Search Console",
	form: "表单线索",
	phone: "电话咨询",
	manual: "业务台账",
};
export const metricLabels: Record<string, string> = {
	sessions: "会话",
	users: "用户",
	organic_clicks: "自然点击",
	impressions: "搜索曝光",
	leads: "线索",
	qualified_leads: "有效线索",
	phone_calls: "电话咨询",
	revenue: "成交金额",
};
export type ServiceLogFilters = {
	service: string;
	level: string;
	search: string;
	from: string;
	to: string;
};
export type AuditLogRow = {
	id: string;
	action: string;
	target_type: string;
	target_id: string | null;
	metadata: Record<string, unknown>;
	actor_email: string | null;
	created_at: string;
};

export type LibraryQuestion = {
	id: string;
	industry: string;
	question: string;
	intent: string;
	topic: string | null;
	persona: string | null;
	tags: string[];
	created_by_email: string | null;
	created_at: string;
};
export type PermissionRecord = {
	key: string;
	kind: "page" | "action";
	group_label: string;
	label: string;
	system_only: boolean;
	desktop_only: boolean;
	position: number;
};

export type RoleRecord = {
	id: string;
	name: string;
	description: string | null;
	is_system: boolean;
	user_count: number;
	permission_keys: string[];
};
export type ManagedUser = {
	id: string;
	email: string;
	display_name: string;
	role: string;
	is_super_admin: boolean;
	disabled_at: string | null;
	created_at: string;
	all_projects: boolean;
	roles: Array<{ id: string; name: string }>;
	permission_keys: string[];
	project_ids: string[];
};
