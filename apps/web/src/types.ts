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
/** 全站列表统一的默认每页条数；服务端 parsePagination 的默认值与此一致。 */
export const DEFAULT_PAGE_SIZE = 20;
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
	website_url: string | null;
	domain: string | null;
	region: string;
	language: string;
	industry: string | null;
	business_focus?: string | null;
	status: string;
	batch_count: number;
	last_batch_at: string | null;
};
/** 建档分析后的竞品联网核实结论；`pending` 表示仍在后台核实，`confirmed` 之外在建档页显示为“待确认”。 */
export type CompetitorVerification = {
	status: "pending" | "confirmed" | "domain_mismatch" | "industry_mismatch" | "unverified";
	note: string | null;
	evidenceId: string | null;
	checkedAt: string;
};
/** 后台核实超过这个时长仍是 pending，多半是 API 进程中途重启，按“未核实”展示并停止轮询。 */
export const COMPETITOR_VERIFICATION_PENDING_MAX_MS = 10 * 60_000;
export const isCompetitorVerificationPending = (
	verification: CompetitorVerification | null | undefined,
	now = Date.now(),
): boolean =>
	verification?.status === "pending" &&
	now - new Date(verification.checkedAt).getTime() < COMPETITOR_VERIFICATION_PENDING_MAX_MS;
export const competitorVerificationLabel = (verification: CompetitorVerification | null | undefined): string =>
	!verification
		? "未联网核实"
		: verification.status === "pending"
			? isCompetitorVerificationPending(verification)
				? "联网核实中"
				: "待确认 · 未核实"
			: verification.status === "confirmed"
				? "已联网核实"
				: verification.status === "domain_mismatch"
					? "待确认 · 域名未核实"
					: verification.status === "industry_mismatch"
						? "待确认 · 行业不符"
						: "待确认 · 未核实";
export type Competitor = {
	id?: string;
	name: string;
	domain: string;
	aliases: string[];
	verification?: CompetitorVerification | null;
};
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
	verified_audit_id?: string | null;
	/** 服务端按任务来源决定：技术类结论重跑官网审计验收，其余发布真实页面后抓取验收。 */
	verification_mode: "audit" | "publish";
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
	organization_id?: string;
	enabledPlatforms?: ProviderId[];
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
	/** 最近一次到期创建批次失败的原因；成功或重新保存计划后清空。 */
	last_error?: string | null;
	last_error_at?: string | null;
	failure_count?: number;
};
export type AuditCheck = {
	id: string;
	label: string;
	status: "pass" | "warning" | "fail" | "skip";
	detail: string;
	weight: number;
	selector?: string;
	recommendation?: string;
	verification?: string;
	evidenceIds?: string[];
};
export type WebsiteAuditResult = {
	schemaVersion?: "geo.website-audit.v2";
	customer?: { name: string; websiteUrl: string | null; region: string; language: string; industry: string | null };
	evidence?: Array<{
		id: string;
		kind: "homepage" | "robots" | "sitemap" | "llms" | "screenshot" | "report";
		url: string | null;
		objectKey: string | null;
		contentType: string;
		contentHash: string | null;
		status: number | null;
		error: string | null;
		excerpt?: string;
	}>;
	screenshotMode?: "static_html_scripts_disabled" | "restricted_browser_render";
	limitations?: string[];
	requestedUrl: string;
	checkedAt: string;
	verdict: "ready" | "ready_with_warnings" | "blocked";
	score: number | null;
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
		sitemap: {
			ok: boolean;
			status: number | null;
			urlCount: number;
			error: string | null;
			urls?: string[];
			documents?: Array<{ url: string; kind: string; status: number | null; error: string | null; urlCount: number }>;
			limited?: boolean;
			htmlSitemapUrls?: string[];
			navigationLinkCount?: number;
		};
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
	status?: "ready" | "limited" | "unavailable";
	parseCoverage?: number | null;
	promptCoverage?: number;
	eligiblePromptCount?: number;
	plannedPromptCount?: number;
	recommendationRate?: number | null;
	explicitRecommendationRate?: number | null;
	confidenceIntervals?: Record<string, [number, number] | null>;
	totalCaptures: number;
	answeredCaptures: number;
	captureCoverage: number;
	brandMentionRate: number | null;
	firstRecommendationRate: number | null;
	citationRate: number | null;
	medianRecommendationRank: number | null;
	monitoredBrandShare?: number | null;
	pairwiseAgreement?: number | null;
	sourceCoverage?: number | null;
	competitorMentionRates: Record<string, number | null>;
};
export type Batch = BatchSummary & {
	metricExplanation?: import("@geo/metrics").MeasurementExplanation | null;
	captureProgress?: {
		pending: number;
		active: number;
		completed: number;
		failed: number;
		next_at: string | null;
		blockedProviders: ProviderId[];
	};
	pairedComparison?: Array<{
		provider_id: string;
		metric: string;
		result: {
			status?: "ready" | "limited" | "unavailable";
			previous: number | null;
			current: number | null;
			delta: number | null;
			interval: [number, number] | null;
			severity: string;
			promptIds: string[];
		};
	}>;
	measurement?: { runId: string | null; snapshotId: string | null; status: string; captureContractCurrent?: boolean };
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
		overall: Record<string, unknown> & {
			brandMentionRate: number | null;
			firstRecommendationRate: number | null;
			citationRate: number | null;
			recommendationRate?: number | null;
			explicitRecommendationRate?: number | null;
			status?: "ready" | "limited" | "unavailable";
			confidenceIntervals?: Record<string, [number, number] | null>;
		};
		validSamples: number;
		failedSamples: number;
		expectedSamples: number;
	};
};
export type ReportAnalysis = {
	readerGuide?: import("@geo/metrics").MeasurementExplanation;
	generatedAt: string;
	executive: { headline: string; summary: string; evidenceLevel: "高" | "中" | "低"; validityNote: string };
	promptRows: Array<{
		promptId: string;
		question: string;
		intent: string;
		tags: string[];
		completeSamples: number;
		plannedSamples: number;
		targetMentionRate: number | null;
		firstRecommendationRate: number | null;
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
	evidenceIndex?: EvidenceIndexEntry[];
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
	metricSnapshotId?: string | null;
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
export type EvidenceIndexEntry = {
	/** 报告内编号；联网搜索等不进入冻结报告的证据为 0，引用按 kind 显示标签。 */
	n: number;
	id: string;
	kind: "capture" | "snapshot" | "audit" | "web_search";
	platform: string | null;
	platformLabel: string | null;
	question: string | null;
	attempt: number | null;
	status: string | null;
	capturedAt: string | null;
	sourceUrls: string[];
	url: string | null;
	title: string | null;
};

export type AgentThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
export const thinkingLevelOptions: Array<{ value: AgentThinkingLevel; label: string; hint: string }> = [
	{ value: "minimal", label: "最低", hint: "最快最省，适合简单核对" },
	{ value: "low", label: "低", hint: "默认；报告与草稿的推荐档" },
	{ value: "medium", label: "中", hint: "更完整的证据比对" },
	{ value: "high", label: "高", hint: "复杂多平台分析，耗时更长" },
	{ value: "xhigh", label: "极高", hint: "只在需要深度核验时使用" },
];

export type AgentSessionStatus = "idle" | "running" | "waiting_user" | "waiting_job" | "done" | "failed";
export type AgentSessionPlanStep = {
	key: string;
	label: string;
	status: "pending" | "running" | "done" | "failed" | "skipped";
	ref?: string | null;
	detail?: string | null;
};
/** 工作台 Agent 交给成员确认的候选问题；表格里可改字、删行、加行。 */
export type ScopeProposalQuestion = {
	key: string;
	id: string | null;
	libraryQuestionId: string | null;
	question: string;
	intent: string;
	topic: string | null;
	persona: string | null;
	tags: string[];
	source: "existing" | "pending" | "library" | "research";
	evidenceIds: string[];
	selected: boolean;
};
export type ScopeProposalCompetitor = {
	key: string;
	id: string | null;
	name: string;
	domain: string;
	aliases: string[];
	selected: boolean;
};
export type ScopeProposal = {
	intro: string;
	questions: ScopeProposalQuestion[];
	competitors: ScopeProposalCompetitor[];
	industry: string | null;
	evidence?: EvidenceIndexEntry[];
};
export const proposalSourceLabels: Record<ScopeProposalQuestion["source"], string> = {
	existing: "现有",
	pending: "建档候选",
	library: "知识库",
	research: "联网研究",
};
export type AgentSessionWaiting =
	| {
			kind: "user";
			question: string;
			options: string[];
			multiple: boolean;
			toolCallId: string;
			proposal?: ScopeProposal;
	  }
	| { kind: "batch" | "agent_run" | "report"; id: string; label: string; toolCallId: string; stepKey?: string };
export type WorkbenchSession = {
	id: string;
	title: string;
	status: AgentSessionStatus;
	execution_target: "server" | "desktop";
	desktop_pending_trigger?: "user" | "resume" | "answer" | null;
	desktop_turn_start_index?: number | null;
	desktop_run_id?: string | null;
	desktop_lease_expires_at?: string | null;
	auto_approve: boolean;
	model: string | null;
	thinking_level: AgentThinkingLevel | null;
	web_search_enabled: boolean;
	plan: AgentSessionPlanStep[];
	waiting: AgentSessionWaiting | null;
	current_batch_id: string | null;
	usage: { input?: number; output?: number; totalTokens?: number } | null;
	error_message: string | null;
	created_at: string;
	updated_at: string;
	last_turn_at: string | null;
};
export type WorkbenchEvent = {
	seq: number;
	type: string;
	payload: Record<string, unknown>;
	created_at: string;
};
export type WorkbenchQuickCommand = { key: string; label: string; message: string };
export type WebSearchStatus = "complete" | "search_not_triggered" | "no_answer" | "failed";
export const webSearchStatusLabels: Record<WebSearchStatus, string> = {
	complete: "已完成",
	search_not_triggered: "未触发搜索",
	no_answer: "无归纳正文",
	failed: "失败",
};
/** 证据中心“联网搜索”分区的一条记录（不含原始响应）。 */
export type WebSearchRecord = {
	id: string;
	query: string;
	status: WebSearchStatus;
	model: string;
	answer_text: string | null;
	sources: Array<{ url: string; title: string | null }>;
	search_queries: string[];
	session_id: string | null;
	agent_run_id: string | null;
	latency_ms: number | null;
	failure_message: string | null;
	created_at: string;
};
/** 平台设置“测试联网搜索”按模型记住的结果。 */
export type WebSearchModelTest = {
	status: "ok" | "failed";
	searchStatus: WebSearchStatus;
	toolChoice: "forced" | "auto";
	message: string | null;
	sourceCount: number;
	latencyMs: number;
	testedAt: string;
};
export type WebSearchTestStatus = { defaultModel: string | null; tests: Record<string, WebSearchModelTest> };
export const sessionStatusLabel: Record<AgentSessionStatus, string> = {
	idle: "待指令",
	running: "执行中",
	waiting_user: "等待你回答",
	waiting_job: "等待后台任务",
	done: "已完成",
	failed: "已终止",
};

export type ArticleStatus = "draft" | "reviewing" | "published";
export const articleStatusLabel: Record<ArticleStatus, string> = {
	draft: "草稿",
	reviewing: "审校中",
	published: "已发布",
};
export type ArticleSummary = {
	project_id: string;
	id: string;
	batch_id: string | null;
	source_run_id: string | null;
	narrative_run_id: string | null;
	recommendation_index: number;
	recommendation_title: string;
	recommendation_priority: string | null;
	title: string;
	summary: string | null;
	status: ArticleStatus;
	quality_status?: import("@geo/evidence").ArticleQualityStatus;
	review_status?: import("@geo/evidence").ArticleEditorialStatus;
	publication_status?: string;
	published_url: string | null;
	version: number;
	content_length: number;
	created_at: string;
	updated_at: string;
};
export type Article = ArticleSummary & {
	publication_plan: import("@geo/evidence").PublicationPlan | null;
	target_questions?: Array<{ id: string; question: string }>;
	recommendation_action: string | null;
	content_markdown: string;
	outline: string[];
	fact_gaps: string[];
	evidence_ids: string[];
	target_prompt_ids: string[];
};

export type AgentRun = {
	id: string;
	batch_id: string | null;
	session_id?: string | null;
	approved_via?: string | null;
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
export const agentStatusLabels: Record<AgentRun["status"], string> = {
	queued: "排队中",
	running: "分析中",
	awaiting_approval: "待审批",
	approved: "已批准",
	rejected: "已拒绝",
	failed: "执行失败",
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
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
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
	| "customerKnowledge"
	| "publications"
	| "workbench"
	| "articles"
	| "overview"
	| "monitor"
	| "evidence"
	| "audit"
	| "diagnosis"
	| "remediation"
	| "attribution"
	| "report"
	| "customers"
	| "knowledge"
	| "settings"
	| "members"
	| "auditLogs"
	| "serviceLogs"
	| "rbac"
	| "organizations";
export const managementViews: View[] = [
	"customers",
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
/** 采集状态：界面不出现英文枚举值。 */
export const captureStatusLabels: Record<string, string> = {
	complete: "有回答",
	no_answer: "无回答",
	login_required: "需要登录",
	challenge_required: "需要安全验证",
	captcha_required: "需要安全验证",
	auth_required: "鉴权失败",
	rate_limited: "触发限流",
	timeout: "请求超时",
	page_contract_changed: "页面结构变化",
	model_unavailable: "模型不可用",
	protocol_changed: "协议已变化",
	search_not_triggered: "未触发联网搜索",
	failed: "采集失败",
};
export const captureStatusLabel = (status: string): string => captureStatusLabels[status] ?? status;
export const taskStatusLabels: Record<string, string> = {
	todo: "待处理",
	in_progress: "处理中",
	published: "已发布",
	verified: "已验收",
	done: "已完成",
};
export const taskStatusLabel = (status: string): string => taskStatusLabels[status] ?? status;
export const sourceCategoryLabels: Record<string, string> = {
	owned: "客户官网",
	competitor: "竞品站点",
	government: "政府/机构",
	social: "社交与内容平台",
	review: "点评/问答",
	encyclopedia: "百科",
	other: "其他网站",
};
export const sourceCategoryLabel = (category: string): string => sourceCategoryLabels[category] ?? category;
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
	enabled?: boolean;
	built_in?: boolean;
	navigation_key?: string | null;
	key: string;
	kind: "page" | "action";
	group_label: string;
	label: string;
	parent_key?: string | null;
	system_only: boolean;
	desktop_only: boolean;
	position: number;
};

export type RoleRecord = {
	system_key?: "admin" | "analyst" | "viewer" | null;
	id: string;
	name: string;
	description: string | null;
	is_system: boolean;
	user_count: number;
	permission_keys: string[];
};
export type ManagedUser = {
	can_manage?: boolean;
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
