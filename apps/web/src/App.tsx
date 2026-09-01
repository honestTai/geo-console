import {
	IconActivity,
	IconAlertTriangle,
	IconArrowLeft,
	IconBolt,
	IconBuilding,
	IconChartLine,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconClipboardCheck,
	IconDatabase,
	IconDownload,
	IconFileAnalytics,
	IconFileText,
	IconGlobe,
	IconHistory,
	IconKey,
	IconLoader2,
	IconPlus,
	IconRefresh,
	IconReportAnalytics,
	IconRoute,
	IconSearch,
	IconSettings,
	IconShieldCheck,
	IconTrash,
	IconUsers,
	IconWorldSearch,
} from "@tabler/icons-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, patch, post, put } from "./api";

type ProviderId = "deepseek_api" | "kimi_api" | "doubao_api" | "qwen_api" | "yuanbao_hunyuan";
const providerIds: ProviderId[] = ["deepseek_api", "kimi_api", "doubao_api", "qwen_api", "yuanbao_hunyuan"];
const providerLabels: Record<string, string> = {
	deepseek_api: "DeepSeek 联网 API",
	kimi_api: "Kimi 联网 API",
	doubao_api: "豆包・火山方舟联网 API",
	qwen_api: "通义千问・DashScope 联网 API",
	yuanbao_hunyuan: "元宝搜索源 + 混元合成",
	deepseek: "DeepSeek 历史消费端",
	kimi: "Kimi 历史消费端",
};
const providerLogoPaths: Record<ProviderId, string> = {
	deepseek_api: `${import.meta.env.BASE_URL}provider-logos/deepseek.svg`,
	kimi_api: `${import.meta.env.BASE_URL}provider-logos/kimi.png`,
	doubao_api: `${import.meta.env.BASE_URL}provider-logos/volcengine.png`,
	qwen_api: `${import.meta.env.BASE_URL}provider-logos/qwen.svg`,
	yuanbao_hunyuan: `${import.meta.env.BASE_URL}provider-logos/yuanbao.png`,
};
const providerLabel = (id: string): string => providerLabels[id] ?? id;
const providerShortLabel = (id: string): string =>
	({
		deepseek_api: "DeepSeek",
		kimi_api: "Kimi",
		doubao_api: "豆包",
		qwen_api: "通义千问",
		yuanbao_hunyuan: "元宝+混元",
	})[id] ?? providerLabel(id);
const shortDate = (value: string): string =>
	new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
const batchKindLabel = (kind: BatchSummary["kind"]): string =>
	kind === "quick_audit" ? "售前快审" : kind === "baseline" ? "正式基线" : "同条件复测";

type UserIdentity = {
	id: string | null;
	email: string;
	displayName: string;
	role: "admin" | "analyst" | "viewer";
	localBypass: boolean;
};

type ProjectSummary = {
	id: string;
	name: string;
	website_url: string;
	domain: string;
	region: string;
	language: string;
	status: string;
	batch_count: number;
	last_batch_at: string | null;
};
type Competitor = { id?: string; name: string; domain: string; aliases: string[] };
type Prompt = {
	id?: string;
	question: string;
	intent: string;
	topic?: string | null;
	persona?: string | null;
	tags: string[];
};
type Finding = {
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
type Task = {
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
type BatchSummary = {
	id: string;
	kind: "quick_audit" | "baseline" | "retest";
	status: string;
	created_at: string;
	completed_at: string | null;
	compare_to_batch_id: string | null;
};
type Project = ProjectSummary & {
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
type MonitoringSchedule = {
	id: string;
	enabled: boolean;
	frequency_days: number;
	platforms: ProviderId[];
	repeats: number;
	next_run_at: string | null;
	last_run_at: string | null;
};
type AuditCheck = {
	id: string;
	label: string;
	status: "pass" | "warning" | "fail" | "skip";
	detail: string;
	weight: number;
};
type WebsiteAuditResult = {
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
type WebsiteAuditRecord = { id: string; checked_at: string; result: WebsiteAuditResult };
type Source = { url: string; domain: string; title: string | null; position: number; isCitation: boolean };
type Capture = {
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
type PlatformMetrics = {
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
type Batch = BatchSummary & {
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
type ReportAnalysis = {
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
type ReportPayload = {
	analysis: ReportAnalysis;
	findings: Finding[];
	tasks: Task[];
	attributionSummary: AttributionPayload["summary"];
};
type TrendResponse = {
	anchorBatchId: string | null;
	comparable: Array<{
		id: string;
		kind: string;
		createdAt: string;
		metrics: Batch["metrics"];
	}>;
};
type AttributionPayload = {
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
};
type AgentRun = {
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
type ReportSnapshot = {
	id: string;
	batch_id: string;
	report_type: "quick_audit" | "remediation" | "retest";
	title: string;
	payload_hash: string;
	pdf_artifact_key: string | null;
	created_at: string;
};
type ReportShare = {
	id: string;
	report_id: string;
	expires_at: string;
	revoked_at: string | null;
	created_at: string;
	created_by_email: string | null;
};
type DriftAlert = {
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
type CostGroup = {
	providerId: string;
	operation: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	knownCostMicros: number;
	costKnownRequests: number;
};
type ProviderSetting = {
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
type ProviderDraft = Partial<ProviderSetting> & { apiKey?: string; secondaryApiKey?: string };
type View =
	| "overview"
	| "monitor"
	| "evidence"
	| "audit"
	| "diagnosis"
	| "remediation"
	| "attribution"
	| "report"
	| "settings"
	| "members"
	| "auditLogs";

const views: Array<{ id: View; label: string; icon: typeof IconActivity }> = [
	{ id: "overview", label: "项目总览", icon: IconBuilding },
	{ id: "monitor", label: "AI监测", icon: IconActivity },
	{ id: "evidence", label: "证据中心", icon: IconDatabase },
	{ id: "audit", label: "官网审计", icon: IconShieldCheck },
	{ id: "diagnosis", label: "差距诊断", icon: IconSearch },
	{ id: "remediation", label: "整改中心", icon: IconClipboardCheck },
	{ id: "attribution", label: "业务归因", icon: IconRoute },
	{ id: "report", label: "复测报告", icon: IconReportAnalytics },
	{ id: "settings", label: "平台设置", icon: IconSettings },
	{ id: "members", label: "机构成员", icon: IconUsers },
	{ id: "auditLogs", label: "审计日志", icon: IconHistory },
];

const percentage = (value: number | null | undefined) => (value == null ? "-" : `${(value * 100).toFixed(1)}%`);
const date = (value: string | null | undefined) =>
	value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";

function downloadText(fileName: string, content: string, type: string): void {
	const href = URL.createObjectURL(new Blob([content], { type }));
	const anchor = document.createElement("a");
	anchor.href = href;
	anchor.download = fileName.replace(/[/\\:*?"<>|]/g, "-");
	anchor.click();
	URL.revokeObjectURL(href);
}

function csvCell(value: unknown): string {
	let text = value == null ? "" : String(value);
	if (/^[=+\-@]/.test(text)) text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
}

function Button({
	children,
	icon,
	variant = "primary",
	busy,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
	icon?: ReactNode;
	variant?: "primary" | "secondary" | "ghost" | "danger";
	busy?: boolean;
}) {
	return (
		<button type={props.type ?? "button"} className={`button ${variant}`} {...props} disabled={busy || props.disabled}>
			{busy ? <IconLoader2 className="spin" size={17} /> : icon}
			{children}
		</button>
	);
}

function useAgentRunPolling(runs: AgentRun[], reload: () => Promise<void>): void {
	const active = runs.some((run) => run.status === "queued" || run.status === "running");
	useEffect(() => {
		if (!active) return;
		const timer = window.setInterval(() => void reload().catch(() => undefined), 2_000);
		return () => window.clearInterval(timer);
	}, [active, reload]);
}

function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
	return (
		<div className="empty">
			<IconFileAnalytics size={30} />
			<h3>{title}</h3>
			<p>{detail}</p>
			{action}
		</div>
	);
}

function Notice({ message, type = "info" }: { message: string; type?: "info" | "error" | "success" }) {
	return (
		<div className={`notice ${type}`}>
			{type === "error" ? (
				<IconAlertTriangle size={17} />
			) : type === "success" ? (
				<IconCheck size={17} />
			) : (
				<IconBolt size={17} />
			)}
			<span>{message}</span>
		</div>
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Top-level application state keeps authentication and project navigation transitions atomic.
export function App() {
	const [user, setUser] = useState<UserIdentity | null>(null);
	const [authReady, setAuthReady] = useState(false);
	const [projects, setProjects] = useState<ProjectSummary[]>([]);
	const [projectId, setProjectId] = useState<string | null>(null);
	const [project, setProject] = useState<Project | null>(null);
	const [view, setView] = useState<View>("overview");
	const [creating, setCreating] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const loadProjects = useCallback(async () => {
		if (!user) return;
		try {
			const result = await api<{ projects: ProjectSummary[] }>("/api/projects");
			setProjects(result.projects);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "项目加载失败");
		} finally {
			setLoading(false);
		}
	}, [user]);
	const loadProject = useCallback(async () => {
		if (!projectId) return;
		try {
			setProject(await api<Project>(`/api/projects/${projectId}`));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "项目加载失败");
		}
	}, [projectId]);
	useEffect(() => {
		api<{ user: UserIdentity }>("/api/auth/me")
			.then((result) => setUser(result.user))
			.catch((reason) => {
				if (!(reason instanceof ApiError) || reason.status !== 401)
					setError(reason instanceof Error ? reason.message : "身份检查失败");
			})
			.finally(() => setAuthReady(true));
	}, []);
	useEffect(() => {
		void loadProjects();
	}, [loadProjects]);
	useEffect(() => {
		void loadProject();
	}, [loadProject]);

	if (!authReady || (user && loading))
		return (
			<main className="center">
				<IconLoader2 className="spin" />
				<span>正在打开 ZZ Geo</span>
			</main>
		);
	if (!user)
		return (
			<Login
				error={error}
				onLogin={(identity) => {
					setError(null);
					setLoading(true);
					setUser(identity);
				}}
			/>
		);
	async function logoutUser() {
		await post("/api/auth/logout");
		setUser(null);
		setProjects([]);
		setProjectId(null);
		setProject(null);
		setLoading(false);
	}
	if (!projectId)
		return (
			<ProjectHome
				account={<AccountControl user={user} onLogout={logoutUser} />}
				projects={projects}
				onOpen={setProjectId}
				onCreate={() => setCreating(true)}
				creating={creating}
				onClose={() => setCreating(false)}
				onCreated={(id) => {
					setCreating(false);
					setProjectId(id);
					void loadProjects();
				}}
				error={error}
			/>
		);

	return (
		<div className="shell">
			<aside className="sidebar">
				<div className="brand">
					<span className="brand-mark">Z</span>
					<div>
						<strong>ZZ Geo</strong>
						<small>真实 AI 可见度工作台</small>
					</div>
				</div>
				<button
					type="button"
					className="project-switch"
					onClick={() => {
						setProjectId(null);
						setProject(null);
					}}
				>
					<IconArrowLeft size={16} />
					<span>{project?.name ?? "客户项目"}</span>
				</button>
				<nav>
					{views
						.filter(
							(item) =>
								!["settings", "members", "auditLogs"].includes(item.id) || user.role === "admin",
						)
						.map((item) => (
							<button
								type="button"
								key={item.id}
								className={view === item.id ? "active" : ""}
								aria-label={item.label}
								title={item.label}
								onClick={() => setView(item.id)}
							>
								<item.icon size={18} />
								<span>{item.label}</span>
							</button>
						))}
				</nav>
				<div className="sidebar-foot">
					<span className="live-dot" />
					真实采集模式
				</div>
			</aside>
			<main className="workspace">
				<header className="topbar">
					<div>
						<span className="eyebrow">{views.find((item) => item.id === view)?.label}</span>
						<h1>{project?.name ?? "加载项目"}</h1>
					</div>
					<div className="topbar-actions">
						<div className="domain">
							<IconGlobe size={16} />
							{project?.domain ?? ""}
						</div>
						<AccountControl user={user} onLogout={logoutUser} />
					</div>
				</header>
				{error && <Notice type="error" message={error} />}
				{!project ? (
					<div className="center">
						<IconLoader2 className="spin" />
					</div>
				) : project.status !== "active" && view !== "settings" ? (
					<Onboarding
						project={project}
						refresh={async () => {
							await loadProject();
							await loadProjects();
						}}
					/>
				) : (
					<>
						{view === "overview" && <Overview project={project} refresh={loadProject} />}
						{view === "monitor" && <Monitoring project={project} refresh={loadProject} />}
						{view === "evidence" && <Evidence project={project} />}
						{view === "audit" && <WebsiteAudit project={project} refresh={loadProject} />}
						{view === "diagnosis" && <Diagnosis project={project} refresh={loadProject} />}
						{view === "remediation" && <Remediation project={project} refresh={loadProject} />}
						{view === "attribution" && <Attribution project={project} />}
						{view === "report" && <Report project={project} />}
						{view === "settings" && user.role === "admin" && <Settings />}
						{view === "members" && user.role === "admin" && <Members localBypass={user.localBypass} />}
						{view === "auditLogs" && user.role === "admin" && <AuditLogs />}
					</>
				)}
			</main>
		</div>
	);
}

function Login({ error, onLogin }: { error: string | null; onLogin(user: UserIdentity): void }) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(error);
	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setMessage(null);
		try {
			const result = await post<{ user: UserIdentity }>("/api/auth/login", { email, password });
			onLogin(result.user);
		} catch (reason) {
			setMessage(reason instanceof Error ? reason.message : "登录失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<main className="login-page">
			<form className="login-panel" onSubmit={submit}>
				<div className="brand">
					<span className="brand-mark">Z</span>
					<div>
						<strong>ZZ Geo</strong>
						<small>机构云端工作台</small>
					</div>
				</div>
				<div>
					<h1>登录机构控制台</h1>
					<p>监测密钥、客户证据和报告仅对机构成员开放。</p>
				</div>
				<label>
					邮箱
					<input
						type="email"
						autoComplete="username"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						required
					/>
				</label>
				<label>
					密码
					<input
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						required
					/>
				</label>
				{message && <Notice type="error" message={message} />}
				<Button type="submit" busy={busy}>
					登录
				</Button>
			</form>
		</main>
	);
}

function AccountControl({ user, onLogout }: { user: UserIdentity; onLogout(): Promise<void> }) {
	return (
		<div className="account-control">
			<div>
				<b>{user.displayName}</b>
				<small>
					{user.role} · {user.email}
				</small>
			</div>
			<Button variant="secondary" onClick={() => void onLogout()}>
				退出
			</Button>
		</div>
	);
}

function ProjectHome({
	account,
	projects,
	onOpen,
	onCreate,
	creating,
	onClose,
	onCreated,
	error,
}: {
	account: ReactNode;
	projects: ProjectSummary[];
	onOpen(id: string): void;
	onCreate(): void;
	creating: boolean;
	onClose(): void;
	onCreated(id: string): void;
	error: string | null;
}) {
	return (
		<main className="project-home">
			<header>
				<div className="brand">
					<span className="brand-mark">Z</span>
					<div>
						<strong>ZZ Geo</strong>
						<small>真实 AI 可见度工作台</small>
					</div>
				</div>
				<div className="home-actions">
					<Button icon={<IconPlus size={17} />} onClick={onCreate}>
						新建客户
					</Button>
					{account}
				</div>
			</header>
			<section className="home-title">
				<span className="eyebrow">客户项目</span>
				<h1>从一个真实客户开始</h1>
				<p>建档、真实采集、证据诊断、整改和同条件复测都保存在同一个项目中。</p>
			</section>
			{error && <Notice type="error" message={error} />}
			{projects.length === 0 ? (
				<Empty
					title="还没有客户项目"
					detail="输入客户与官网，系统将先读取真实网站，再生成待人工确认的竞品和购买问题。"
					action={
						<Button icon={<IconPlus size={17} />} onClick={onCreate}>
							新建第一个客户
						</Button>
					}
				/>
			) : (
				<div className="project-grid">
					{projects.map((project) => (
						<button type="button" className="project-card" key={project.id} onClick={() => onOpen(project.id)}>
							<div>
								<span className={`status ${project.status}`}>{project.status === "active" ? "运行中" : "待建档"}</span>
								<h2>{project.name}</h2>
								<p>{project.domain}</p>
							</div>
							<dl>
								<div>
									<dt>地区</dt>
									<dd>{project.region}</dd>
								</div>
								<div>
									<dt>批次</dt>
									<dd>{project.batch_count ?? 0}</dd>
								</div>
								<div>
									<dt>最近监测</dt>
									<dd>{date(project.last_batch_at)}</dd>
								</div>
							</dl>
							<IconChevronRight className="card-arrow" size={20} />
						</button>
					))}
				</div>
			)}
			{creating && <CreateProject onClose={onClose} onCreated={onCreated} />}
		</main>
	);
}

function CreateProject({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const data = new FormData(event.currentTarget);
		try {
			const result = await post<{ id: string }>("/api/projects", {
				name: data.get("name"),
				websiteUrl: data.get("websiteUrl"),
				region: data.get("region"),
				language: data.get("language"),
				businessFocus: data.get("businessFocus") || null,
				aliases: String(data.get("aliases") || "")
					.split(/[，,]/)
					.map((value) => value.trim())
					.filter(Boolean),
				knownCompetitors: String(data.get("knownCompetitors") || "")
					.split(/[，,]/)
					.map((value) => value.trim())
					.filter(Boolean),
			});
			onCreated(result.id);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "创建失败");
			setBusy(false);
		}
	}
	return (
		<div className="modal-backdrop">
			<section className="modal">
				<header>
					<div>
						<span className="eyebrow">客户建档</span>
						<h2>新建真实客户项目</h2>
					</div>
					<Button variant="ghost" onClick={onClose}>
						关闭
					</Button>
				</header>
				<form onSubmit={submit} className="form-grid">
					<label>
						客户名称
						<input name="name" required placeholder="企业或品牌全称" />
					</label>
					<label>
						官网
						<input name="websiteUrl" required type="url" placeholder="https://example.com" />
					</label>
					<label>
						目标地区
						<input name="region" required placeholder="例如：中国 / 上海" />
					</label>
					<label>
						语言
						<input name="language" required defaultValue="zh-CN" />
					</label>
					<label className="wide">
						业务重点（可选）
						<textarea name="businessFocus" rows={3} placeholder="本阶段希望重点推广的产品或服务" />
					</label>
					<label className="wide">
						品牌别名（可选）
						<input name="aliases" placeholder="用逗号分隔" />
					</label>
					<label className="wide">
						已知竞品（可选）
						<input name="knownCompetitors" placeholder="名称或官网，用逗号分隔" />
					</label>
					{error && (
						<div className="wide">
							<Notice type="error" message={error} />
						</div>
					)}
					<div className="form-actions wide">
						<Button type="submit" busy={busy} icon={<IconChevronRight size={17} />}>
							创建并进入建档
						</Button>
					</div>
				</form>
			</section>
		</div>
	);
}

function Onboarding({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [manualReview, setManualReview] = useState(false);
	const [aliases, setAliases] = useState(project.aliases ?? [project.name]);
	const [competitors, setCompetitors] = useState(project.competitors ?? []);
	const [prompts, setPrompts] = useState(project.prompts ?? []);
	useEffect(() => {
		setAliases(project.aliases ?? []);
		setCompetitors(project.competitors ?? []);
		setPrompts(project.prompts ?? []);
	}, [project]);
	async function analyze() {
		setBusy(true);
		setError(null);
		try {
			await post(`/api/projects/${project.id}/analyze`);
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "分析失败");
		} finally {
			setBusy(false);
		}
	}
	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			await post(`/api/projects/${project.id}/confirm`, { aliases, competitors, prompts });
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "确认失败");
		} finally {
			setBusy(false);
		}
	}
	if (project.status === "draft" && !manualReview)
		return (
			<section className="onboarding">
				<div className="stepper">
					<b>1</b>
					<span>抓取官网</span>
					<i />
					<b>2</b>
					<span>人工确认</span>
					<i />
					<b>3</b>
					<span>建立基线</span>
				</div>
				<div className="action-panel">
					<IconWorldSearch size={34} />
					<h2>读取客户的真实官网</h2>
					<p>
						系统会抓取 Sitemap 及最多 100 个同域页面，再由 DeepSeek 生成客户画像、竞品候选和购买问题。此过程需要已配置的
						API Key。
					</p>
					{error && <Notice type="error" message={error} />}
					<div className="actions">
						<Button busy={busy} icon={<IconSearch size={17} />} onClick={analyze}>
							{busy ? "正在抓取和分析" : "开始官网分析"}
						</Button>
						<Button variant="secondary" icon={<IconClipboardCheck size={17} />} onClick={() => setManualReview(true)}>
							手工配置监测范围
						</Button>
					</div>
				</div>
			</section>
		);
	return (
		<section className="onboarding">
			<div className="stepper">
				<b className="done">
					<IconCheck size={14} />
				</b>
				<span>抓取官网</span>
				<i className="done" />
				<b>2</b>
				<span>人工确认</span>
				<i />
				<b>3</b>
				<span>建立基线</span>
			</div>
			<div className="section-head view-head">
				<div>
					<h2>审核监测范围</h2>
					<p>
						{manualReview
							? "直接填写真实品牌别名、竞品和购买问题。确认前不会创建采集任务。"
							: "删除不真实的竞品，修改问题后再确认。确认前不会创建采集任务。"}
					</p>
				</div>
				<Button busy={busy} icon={<IconCheck size={17} />} onClick={confirm}>
					确认并启用项目
				</Button>
			</div>
			{error && <Notice type="error" message={error} />}
			<div className="review-section">
				<h3>品牌别名</h3>
				<input
					value={aliases.join("，")}
					onChange={(event) =>
						setAliases(
							event.target.value
								.split(/[，,]/)
								.map((value) => value.trim())
								.filter(Boolean),
						)
					}
				/>
			</div>
			<div className="review-section">
				<div className="section-head compact">
					<h3>竞品候选</h3>
					<Button
						variant="secondary"
						icon={<IconPlus size={16} />}
						onClick={() => setCompetitors([...competitors, { name: "", domain: "", aliases: [] }])}
					>
						添加
					</Button>
				</div>
				{competitors.length === 0 ? (
					<p className="muted">当前没有竞品候选，可以添加后再确认。</p>
				) : (
					<div className="editable-list">
						{competitors.map((item, index) => (
							<div className="editable-row" key={item.id ?? index}>
								<input
									aria-label="竞品名称"
									value={item.name}
									onChange={(event) =>
										setCompetitors(
											competitors.map((value, i) => (i === index ? { ...value, name: event.target.value } : value)),
										)
									}
								/>
								<input
									aria-label="竞品域名"
									value={item.domain}
									onChange={(event) =>
										setCompetitors(
											competitors.map((value, i) => (i === index ? { ...value, domain: event.target.value } : value)),
										)
									}
								/>
								<Button variant="ghost" onClick={() => setCompetitors(competitors.filter((_, i) => i !== index))}>
									删除
								</Button>
							</div>
						))}
					</div>
				)}
			</div>
			<div className="review-section">
				<div className="section-head compact">
					<h3>购买问题</h3>
					<Button
						variant="secondary"
						icon={<IconPlus size={16} />}
						onClick={() =>
							setPrompts([...prompts, { question: "", intent: "购买决策", topic: "", persona: "", tags: [] }])
						}
					>
						添加
					</Button>
				</div>
				<div className="editable-list prompts">
					{prompts.map((item, index) => (
						<div className="editable-row" key={item.id ?? index}>
							<span className="row-index">{index + 1}</span>
							<input
								aria-label="监测问题"
								value={item.question}
								onChange={(event) =>
									setPrompts(
										prompts.map((value, i) => (i === index ? { ...value, question: event.target.value } : value)),
									)
								}
							/>
							<input
								aria-label="意图"
								value={item.intent}
								onChange={(event) =>
									setPrompts(
										prompts.map((value, i) => (i === index ? { ...value, intent: event.target.value } : value)),
									)
								}
							/>
							<input
								aria-label="主题"
								placeholder="主题"
								value={item.topic ?? ""}
								onChange={(event) =>
									setPrompts(prompts.map((value, i) => (i === index ? { ...value, topic: event.target.value } : value)))
								}
							/>
							<input
								aria-label="Persona"
								placeholder="购买者角色"
								value={item.persona ?? ""}
								onChange={(event) =>
									setPrompts(
										prompts.map((value, i) => (i === index ? { ...value, persona: event.target.value } : value)),
									)
								}
							/>
							<Button variant="ghost" onClick={() => setPrompts(prompts.filter((_, i) => i !== index))}>
								删除
							</Button>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

function OverviewKpis({ trends, tasks }: { trends: TrendResponse; tasks: Task[] }) {
	const latest = trends.comparable.at(-1);
	const baseline = trends.comparable.length > 1 ? trends.comparable[0] : null;
	if (!latest) return null;
	const openTasks = tasks.filter((task) => task.status === "todo" || task.status === "in_progress").length;
	const draftPending = tasks.some(
		(task) => task.draft_content && task.status !== "published" && task.status !== "verified" && task.status !== "done",
	);
	const deltaPoints = (key: string): number | null => {
		if (!baseline) return null;
		const before = overallMetric(baseline, key);
		const after = overallMetric(latest, key);
		return before == null || after == null ? null : (after - before) * 100;
	};
	const evidenceCount = latest.metrics.validSamples + latest.metrics.failedSamples;
	const evidenceDelta = baseline ? evidenceCount - (baseline.metrics.validSamples + baseline.metrics.failedSamples) : null;
	const deltaChip = (value: number | null, unit: string) =>
		value == null ? (
			<span className="kpi-delta">首个基线</span>
		) : value === 0 ? (
			<span className="kpi-delta">与基线持平</span>
		) : (
			<span className={`kpi-delta ${value >= 0 ? "up" : "down"}`}>
				较基线 {value >= 0 ? "+" : ""}
				{value.toFixed(1)}
				{unit}
			</span>
		);
	return (
		<div className="kpi-grid">
			<div className="kpi-card">
				<span className="kpi-label">品牌提及率</span>
				<div className="kpi-value">{percentage(overallMetric(latest, "brandMentionRate"))}</div>
				{deltaChip(deltaPoints("brandMentionRate"), "")}
			</div>
			<div className="kpi-card">
				<span className="kpi-label">首位推荐率</span>
				<div className="kpi-value">{percentage(overallMetric(latest, "firstRecommendationRate"))}</div>
				{deltaChip(deltaPoints("firstRecommendationRate"), "")}
			</div>
			<div className="kpi-card">
				<span className="kpi-label">官网引用率</span>
				<div className="kpi-value">{percentage(overallMetric(latest, "citationRate"))}</div>
				{deltaChip(deltaPoints("citationRate"), "")}
			</div>
			<div className="kpi-card">
				<span className="kpi-label">证据存证</span>
				<div className="kpi-value">
					{evidenceCount}
					<small> 条</small>
				</div>
				{deltaChip(evidenceDelta, " 条")}
			</div>
			<div className="kpi-card">
				<span className="kpi-label">整改任务</span>
				<div className="kpi-value">
					{openTasks}
					<small> 待审批</small>
				</div>
				<span className="kpi-delta">{draftPending ? "Pi Agent 草稿待审" : openTasks > 0 ? "待人工处理" : "全部已验收"}</span>
			</div>
		</div>
	);
}

function OverviewTrendPanel({
	latest,
	trends,
	loading,
}: {
	latest: BatchSummary | undefined;
	trends: TrendResponse | null;
	loading: boolean;
}) {
	let content: ReactNode;
	if (!latest) {
		content = <p className="muted trend-empty">建立首个基线后，这里会显示关键指标随批次的变化趋势。</p>;
	} else if (loading) {
		content = (
			<div className="chart-loading">
				<IconLoader2 className="spin" size={17} />
				<span>正在加载趋势</span>
			</div>
		);
	} else if (!trends || trends.comparable.length === 0) {
		content = <p className="muted trend-empty">暂无可比较的批次数据。</p>;
	} else {
		const latestComparable = trends.comparable.at(-1);
		content = (
			<>
				{trends.comparable.length < 2 ? (
					<p className="muted trend-empty">当前只有一个同配置批次；完成一次“同条件复测”后显示趋势曲线。</p>
				) : (
					<LineTrendChart
						labels={trends.comparable.map((item) => ({ id: item.id, label: shortDate(item.createdAt) }))}
						series={[
							{
								label: "品牌提及率",
								color: "var(--brand)",
								values: trends.comparable.map((item) => overallPercent(item, "brandMentionRate")),
							},
							{
								label: "首位推荐率",
								color: "var(--info)",
								values: trends.comparable.map((item) => overallPercent(item, "firstRecommendationRate")),
							},
							{
								label: "官网引用率",
								color: "var(--warning)",
								values: trends.comparable.map((item) => overallPercent(item, "citationRate")),
							},
						]}
					/>
				)}
				{latestComparable ? (
					<MentionBarChart
						title="平台覆盖（最新可比批次品牌提及率）"
						items={perPlatformMention(latestComparable.metrics)}
						note="失败平台不进入品牌率分母；未开放来源的平台引用率记为不可用。"
					/>
				) : null}
			</>
		);
	}
	return (
		<div className="overview-trends">
			{content}
		</div>
	);
}

function Overview({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const latest = project.batches[0];
	const latestId = latest?.id;
	const [editingScope, setEditingScope] = useState(false);
	const [trends, setTrends] = useState<TrendResponse | null>(null);
	const [trendsLoading, setTrendsLoading] = useState(false);
	useEffect(() => {
		if (!latestId) {
			setTrends(null);
			return;
		}
		let current = true;
		setTrendsLoading(true);
		api<TrendResponse>(`/api/projects/${project.id}/trends/${latestId}`)
			.then((result) => {
				if (current) setTrends(result);
			})
			.catch(() => {
				if (current) setTrends(null);
			})
			.finally(() => {
				if (current) setTrendsLoading(false);
			});
		return () => {
			current = false;
		};
	}, [project.id, latestId]);
	return (
		<section>
			<div className="overview-head">
				<div>
					<span className="eyebrow">项目总览</span>
					<h2>{project.name} · 可见度总览</h2>
				</div>
				<Button variant="secondary" icon={<IconSettings size={16} />} onClick={() => setEditingScope(true)}>
					编辑监测范围
				</Button>
			</div>
			{trendsLoading ? (
				<div className="kpi-grid" aria-hidden="true">
					<div className="kpi-card kpi-skeleton" />
					<div className="kpi-card kpi-skeleton" />
					<div className="kpi-card kpi-skeleton" />
					<div className="kpi-card kpi-skeleton" />
					<div className="kpi-card kpi-skeleton" />
				</div>
			) : trends ? (
				<OverviewKpis trends={trends} tasks={project.tasks} />
			) : null}
			<OverviewTrendPanel latest={latest} trends={trends} loading={trendsLoading} />
			{editingScope && <ScopeEditor project={project} onClose={() => setEditingScope(false)} refresh={refresh} />}
		</section>
	);
}

function ScopeEditor({ project, onClose, refresh }: { project: Project; onClose(): void; refresh(): Promise<void> }) {
	const [aliases, setAliases] = useState(project.aliases ?? [project.name]);
	const [competitors, setCompetitors] = useState<Competitor[]>(project.competitors ?? []);
	const [prompts, setPrompts] = useState<Prompt[]>(project.prompts ?? []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const splitValues = (value: string) =>
		value
			.split(/[，,]/)
			.map((item) => item.trim())
			.filter(Boolean);
	async function save() {
		setBusy(true);
		setError(null);
		try {
			await post(`/api/projects/${project.id}/confirm`, { aliases, competitors, prompts });
			await refresh();
			onClose();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "保存失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="modal-backdrop">
			<section className="modal scope-modal">
				<header>
					<div>
						<span className="eyebrow">监测范围版本</span>
						<h2>编辑当前监测范围</h2>
						<p className="muted">保存后只影响新基线；历史批次、回答证据和报告继续保留原问题与竞品。</p>
					</div>
					<Button variant="ghost" onClick={onClose}>
						关闭
					</Button>
				</header>
				<div className="review-section">
					<label>
						品牌别名
						<input value={aliases.join("，")} onChange={(event) => setAliases(splitValues(event.target.value))} />
					</label>
				</div>
				<div className="review-section">
					<div className="section-head compact">
						<div>
							<h3>竞品</h3>
							<p>域名用于识别引用来源，别名用于回答中的实体匹配。</p>
						</div>
						<Button
							variant="secondary"
							icon={<IconPlus size={16} />}
							onClick={() => setCompetitors([...competitors, { name: "", domain: "", aliases: [] }])}
						>
							添加竞品
						</Button>
					</div>
					<div className="scope-list">
						{competitors.map((item, index) => (
							<article className="scope-item competitor" key={item.id ?? index}>
								<span className="row-index">{index + 1}</span>
								<label>
									名称
									<input
										value={item.name}
										onChange={(event) =>
											setCompetitors(
												competitors.map((value, itemIndex) =>
													itemIndex === index ? { ...value, name: event.target.value } : value,
												),
											)
										}
									/>
								</label>
								<label>
									域名
									<input
										value={item.domain}
										onChange={(event) =>
											setCompetitors(
												competitors.map((value, itemIndex) =>
													itemIndex === index ? { ...value, domain: event.target.value } : value,
												),
											)
										}
									/>
								</label>
								<label>
									别名
									<input
										value={item.aliases.join("，")}
										onChange={(event) =>
											setCompetitors(
												competitors.map((value, itemIndex) =>
													itemIndex === index ? { ...value, aliases: splitValues(event.target.value) } : value,
												),
											)
										}
									/>
								</label>
								<Button variant="ghost" onClick={() => setCompetitors(competitors.filter((_, i) => i !== index))}>
									删除
								</Button>
							</article>
						))}
					</div>
				</div>
				<div className="review-section">
					<div className="section-head compact">
						<div>
							<h3>购买问题</h3>
							<p>同条件趋势只比较问题、平台、重复次数和版本完全一致的批次。</p>
						</div>
						<Button
							variant="secondary"
							icon={<IconPlus size={16} />}
							onClick={() =>
								setPrompts([...prompts, { question: "", intent: "购买决策", topic: "", persona: "", tags: [] }])
							}
						>
							添加问题
						</Button>
					</div>
					<div className="scope-list">
						{prompts.map((item, index) => (
							<article className="scope-item prompt" key={item.id ?? index}>
								<span className="row-index">{index + 1}</span>
								<label>
									真实用户问题
									<input
										value={item.question}
										onChange={(event) =>
											setPrompts(
												prompts.map((value, itemIndex) =>
													itemIndex === index ? { ...value, question: event.target.value } : value,
												),
											)
										}
									/>
								</label>
								<label>
									意图
									<input
										value={item.intent}
										onChange={(event) =>
											setPrompts(
												prompts.map((value, itemIndex) =>
													itemIndex === index ? { ...value, intent: event.target.value } : value,
												),
											)
										}
									/>
								</label>
								<label>
									标签
									<input
										value={item.tags.join("，")}
										onChange={(event) =>
											setPrompts(
												prompts.map((value, itemIndex) =>
													itemIndex === index ? { ...value, tags: splitValues(event.target.value) } : value,
												),
											)
										}
									/>
								</label>
								<label>
									主题
									<input
										value={item.topic ?? ""}
										onChange={(event) =>
											setPrompts(
												prompts.map((value, itemIndex) =>
													itemIndex === index ? { ...value, topic: event.target.value } : value,
												),
											)
										}
									/>
								</label>
								<label>
									购买者角色
									<input
										value={item.persona ?? ""}
										onChange={(event) =>
											setPrompts(
												prompts.map((value, itemIndex) =>
													itemIndex === index ? { ...value, persona: event.target.value } : value,
												),
											)
										}
									/>
								</label>
								<Button variant="ghost" onClick={() => setPrompts(prompts.filter((_, i) => i !== index))}>
									删除
								</Button>
							</article>
						))}
					</div>
				</div>
				{error && <Notice type="error" message={error} />}
				<div className="scope-actions">
					<Button variant="secondary" onClick={onClose}>
						取消
					</Button>
					<Button busy={busy} icon={<IconCheck size={17} />} onClick={save}>
						保存新范围版本
					</Button>
				</div>
			</section>
		</div>
	);
}

function runActivityStatus(status: string, active: boolean, captured: number): string {
	if (status === "partial") return "采集完成 · 部分平台失败，原始证据已保留";
	if (!active) return "采集完成 · 指标与证据已入库";
	return captured > 0 ? `采集中 · 已写入 ${captured} 条证据` : "任务已创建 · 等待 Capture Worker";
}

function captureLogMessage(capture: Capture): string {
	if (capture.status === "complete") return "回答与原始响应已存证";
	return `${capture.status}${capture.failureMessage ? ` · ${capture.failureMessage}` : ""}`;
}

function RunCaptureLog({
	captures,
	active,
}: {
	captures: Capture[];
	active: boolean;
}) {
	if (!captures.length)
		return (
			<div className="run-log">
				<div>
					<time>--:--:--</time>
					<span>{active ? "冻结批次配置，等待首条采集证据" : "当前批次没有可展示的采集日志"}</span>
				</div>
			</div>
		);
	return (
		<div className="run-log">
			{captures.map((capture) => (
				<div key={capture.captureId}>
					<time>
						{new Intl.DateTimeFormat("zh-CN", {
							hour: "2-digit",
							minute: "2-digit",
							second: "2-digit",
							hour12: false,
						}).format(new Date(capture.capturedAt))}
					</time>
					<span>
						{providerShortLabel(capture.engine)} · {captureLogMessage(capture)}
					</span>
					<b className={capture.status === "complete" ? "ok" : "error"}>
						{capture.status === "complete" ? "✓" : "!"}
					</b>
				</div>
			))}
			{!active ? (
				<div>
					<time>完成</time>
					<span>指标已刷新 · {captures.length} 条近期 capture 已写入证据链</span>
					<b className="ok">✓</b>
				</div>
			) : null}
		</div>
	);
}

function RunActivityPanel({
	batch,
	summary,
	busy,
	onRerun,
}: {
	batch: Batch | null;
	summary: BatchSummary | undefined;
	busy: boolean;
	onRerun(): Promise<void>;
}) {
	if (!summary) return null;
	const expected = batch?.metrics.expectedSamples ?? 0;
	const captured = batch?.captures.length ?? 0;
	const batchStatus = batch?.status ?? summary.status;
	const active = ["queued", "running"].includes(batchStatus);
	const progress = expected > 0 ? Math.min(100, Math.round((captured / expected) * 100)) : active ? 4 : 100;
	const recentCaptures = [...(batch?.captures ?? [])]
		.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
		.slice(-6);
	const status = runActivityStatus(batchStatus, active, captured);
	return (
		<section className="run-activity" aria-live="polite">
			<header>
				<div>
					<h3>监测任务</h3>
					<p>
						{active ? "本次运行" : "上次运行"}：{date(summary.created_at)}
						{expected > 0 ? ` · ${captured}/${expected} 条采集已存证` : ""}
					</p>
				</div>
				{active ? (
					<span className="status running">运行中</span>
				) : (
					<Button variant="secondary" busy={busy} icon={<IconRefresh size={16} />} onClick={() => void onRerun()}>
						再次运行监测
					</Button>
				)}
			</header>
			<div
				className="run-progress"
				role="progressbar"
				aria-label="采集进度"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={progress}
			>
				<i style={{ width: `${progress}%` }} />
			</div>
			<strong className={`run-status ${active ? "running" : "complete"}`}>{status}</strong>
			<RunCaptureLog captures={recentCaptures} active={active} />
		</section>
	);
}

function Monitoring({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [selected, setSelected] = useState(project.batches[0]?.id ?? null);
	const [batch, setBatch] = useState<Batch | null>(null);
	const [trends, setTrends] = useState<TrendResponse | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [alerts, setAlerts] = useState<DriftAlert[]>([]);
	const [costs, setCosts] = useState<CostGroup[]>([]);
	const [runPlatforms, setRunPlatforms] = useState<ProviderId[]>(providerIds);
	const [runRepeats, setRunRepeats] = useState(3);
	const [scheduleEnabled, setScheduleEnabled] = useState(project.monitoringSchedule?.enabled ?? false);
	const [frequencyDays, setFrequencyDays] = useState(project.monitoringSchedule?.frequency_days ?? 7);
	const [schedulePlatforms, setSchedulePlatforms] = useState<ProviderId[]>(
		project.monitoringSchedule?.platforms?.length ? project.monitoringSchedule.platforms : providerIds,
	);
	const [scheduleRepeats, setScheduleRepeats] = useState(project.monitoringSchedule?.repeats ?? 3);
	const selectedBatch = project.batches.find((item) => item.id === selected);
	const load = useCallback(async () => {
		if (selected) setBatch(await api<Batch>(`/api/batches/${selected}`));
	}, [selected]);
	useEffect(() => {
		void load();
		api<{ alerts: DriftAlert[] }>(`/api/projects/${project.id}/drift-alerts`)
			.then((result) => setAlerts(result.alerts))
			.catch(() => setAlerts([]));
		api<{ groups: CostGroup[] }>(`/api/projects/${project.id}/costs`)
			.then((result) => setCosts(result.groups))
			.catch(() => setCosts([]));
		if (selected)
			api<TrendResponse>(`/api/projects/${project.id}/trends/${selected}`)
				.then(setTrends)
				.catch(() => setTrends(null));
		const pollingMs = ["queued", "running"].includes(batch?.status ?? selectedBatch?.status ?? "") ? 3_000 : 8_000;
		const timer = window.setInterval(() => void load(), pollingMs);
		return () => window.clearInterval(timer);
	}, [batch?.status, load, project.id, selected, selectedBatch?.status]);
	async function saveSchedule() {
		setBusy(true);
		setError(null);
		try {
			await put(`/api/projects/${project.id}/monitoring-schedule`, {
				enabled: scheduleEnabled,
				frequencyDays,
				platforms: schedulePlatforms,
				repeats: scheduleRepeats,
			});
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "自动监测设置保存失败");
		} finally {
			setBusy(false);
		}
	}
	async function create(
		kind: "quick_audit" | "baseline" | "retest",
		compareToBatchId: string | null = selected,
	) {
		setBusy(true);
		setError(null);
		try {
			const result = await post<{ id: string }>(
				`/api/projects/${project.id}/batches`,
				kind !== "retest"
					? { kind, platforms: runPlatforms, repeats: kind === "quick_audit" ? 1 : runRepeats }
					: { kind, compareToBatchId },
			);
			setBatch(null);
			setTrends(null);
			setSelected(result.id);
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "创建批次失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<section>
			<div className="overview-head monitor-head">
				<div>
					<span className="eyebrow">AI监测</span>
					<h2>五平台联网监测</h2>
					<p className="muted">快审每题 1 次；正式基线默认分三个时间窗口采样。失败平台不进入品牌率分母。</p>
				</div>
				<div className="monitor-toolbar toolbar">
					<div className="run-config">
						<fieldset className="run-platforms">
							<legend>本次监测平台</legend>
							{providerIds.map((platform) => (
								<label key={platform}>
									<input
										type="checkbox"
										checked={runPlatforms.includes(platform)}
										onChange={(event) =>
											setRunPlatforms(
												event.target.checked
													? [...new Set([...runPlatforms, platform])]
													: runPlatforms.filter((item) => item !== platform),
											)
										}
									/>
									{providerShortLabel(platform)}
								</label>
							))}
						</fieldset>
						<select
							aria-label="基线重复次数"
							value={runRepeats}
							onChange={(event) => setRunRepeats(Number(event.target.value))}
						>
							{[1, 2, 3, 5, 10].map((value) => (
								<option value={value} key={value}>
									每题 {value} 次
								</option>
							))}
						</select>
					</div>
					<div className="run-actions">
						<Button
							className="run-retest"
							variant="secondary"
							busy={busy}
							onClick={() => create("retest")}
							disabled={selectedBatch?.kind !== "baseline"}
							title={selectedBatch?.kind !== "baseline" ? "只能选择正式基线作为复测锚点" : undefined}
						>
							按此条件复测
						</Button>
						<Button
							className="run-audit"
							variant="secondary"
							busy={busy}
							disabled={!runPlatforms.length}
							onClick={() => create("quick_audit")}
						>
							运行售前快审
						</Button>
						<Button
							className="run-baseline"
							busy={busy}
							disabled={!runPlatforms.length}
							icon={<IconPlus size={17} />}
							onClick={() => create("baseline")}
						>
							新建正式基线
						</Button>
					</div>
				</div>
			</div>
			<RunActivityPanel
				batch={batch}
				summary={selectedBatch}
				busy={busy}
				onRerun={() =>
					selectedBatch?.kind === "quick_audit"
						? create("quick_audit")
						: create(
								"retest",
								selectedBatch?.kind === "baseline" ? selectedBatch.id : selectedBatch?.compare_to_batch_id,
							)
				}
			/>
			{error && <Notice type="error" message={error} />}
			{alerts
				.filter((alert) => !alert.acknowledged_at)
				.map((alert) => (
					<div className="drift-alert" key={alert.id}>
						<IconAlertTriangle size={18} />
						<div>
							<b>{providerLabel(alert.provider_id)} 指标漂移</b>
							<span>
								{alert.metric} 从 {percentage(alert.previous_value)} 降至 {percentage(alert.current_value)}，关联{" "}
								{alert.evidence_ids.length} 条证据。
							</span>
						</div>
						<Button
							variant="ghost"
							onClick={() =>
								post(`/api/drift-alerts/${alert.id}/acknowledge`).then(() =>
									setAlerts((current) =>
										current.map((item) =>
											item.id === alert.id ? { ...item, acknowledged_at: new Date().toISOString() } : item,
										),
									),
								)
							}
						>
							确认
						</Button>
					</div>
				))}
			{costs.length > 0 && (
				<div className="cost-strip">
					{costs.map((group) => (
						<div key={`${group.providerId}-${group.operation}`}>
							<span>{providerLabel(group.providerId)}</span>
							<b>
								{group.requests} 次请求 · {group.totalTokens.toLocaleString("zh-CN")} Token
							</b>
							<small>
								{group.costKnownRequests === group.requests
									? `已知费用 $${(group.knownCostMicros / 1_000_000).toFixed(4)}`
									: "供应商未返回完整费用"}
							</small>
						</div>
					))}
				</div>
			)}
			<div className="schedule-band">
				<div>
					<IconChartLine size={24} />
					<h3>周期监测</h3>
					<p>
						云端 Worker 到期后冻结范围和平台配置，按时间窗口调用已启用 API。下一次运行：
						{date(project.monitoringSchedule?.next_run_at)}
					</p>
				</div>
				<div className="schedule-controls">
					<label className="toggle-label">
						<input
							type="checkbox"
							checked={scheduleEnabled}
							onChange={(event) => setScheduleEnabled(event.target.checked)}
						/>
						启用
					</label>
					<label>
						周期
						<select value={frequencyDays} onChange={(event) => setFrequencyDays(Number(event.target.value))}>
							<option value={1}>每天</option>
							<option value={7}>每周</option>
							<option value={14}>每两周</option>
							<option value={30}>每月</option>
						</select>
					</label>
					<label>
						重复次数
						<select value={scheduleRepeats} onChange={(event) => setScheduleRepeats(Number(event.target.value))}>
							{[1, 2, 3, 5].map((value) => (
								<option value={value} key={value}>
									{value} 次
								</option>
							))}
						</select>
					</label>
					<div className="schedule-platforms">
						{providerIds.map((platform) => (
							<label key={platform}>
								<input
									type="checkbox"
									checked={schedulePlatforms.includes(platform)}
									onChange={(event) =>
										setSchedulePlatforms(
											event.target.checked
												? [...new Set([...schedulePlatforms, platform])]
												: schedulePlatforms.filter((item) => item !== platform),
										)
									}
								/>
								{providerLabel(platform)}
							</label>
						))}
					</div>
					<Button variant="secondary" busy={busy} disabled={!schedulePlatforms.length} onClick={saveSchedule}>
						保存计划
					</Button>
				</div>
			</div>
			{project.batches.length === 0 ? (
				<Empty title="还没有采集批次" detail="先在平台设置中配置并启用至少一个联网 API，再运行售前快审或正式基线。" />
			) : (
				<>
					<div className="batch-strip">
						{project.batches.map((item) => (
							<button
								type="button"
								className={selected === item.id ? "active" : ""}
								key={item.id}
								onClick={() => {
									setBatch(null);
									setTrends(null);
									setSelected(item.id);
								}}
							>
								<span>{batchKindLabel(item.kind)}</span>
								<strong>{date(item.created_at)}</strong>
								<small className={`status ${item.status}`}>{item.status}</small>
							</button>
						))}
					</div>
					{batch && <BatchMetrics batch={batch} />}
					{trends && <TrendChart trends={trends} />}
				</>
			)}
		</section>
	);
}

function TrendChart({ trends }: { trends: TrendResponse }) {
	const anchor = trends.comparable.find((item) => item.id === trends.anchorBatchId) ?? trends.comparable.at(-1);
	return (
		<div className="trend-section">
			<div className="section-head compact">
				<div>
					<h3>同配置趋势</h3>
					<p>只纳入冻结配置哈希一致的批次，配置变化不会混入趋势。</p>
				</div>
				<span>{trends.comparable.length} 个可比批次</span>
			</div>
			{trends.comparable.length < 2 ? (
				<p className="muted trend-empty">当前只有一个同配置批次；完成一次“按此条件复测”后显示前后趋势。</p>
			) : (
				<div className="trend-table">
					{trends.comparable.map((item) => {
						const overall = item.metrics.overall;
						return (
							<div className="trend-row" key={item.id}>
								<time>{date(item.createdAt)}</time>
								<div>
									<span>提及</span>
									<i style={{ width: percentage(overall.brandMentionRate as number) }} />
									<b>{percentage(overall.brandMentionRate as number)}</b>
								</div>
								<div>
									<span>首位</span>
									<i style={{ width: percentage(overall.firstRecommendationRate as number) }} />
									<b>{percentage(overall.firstRecommendationRate as number)}</b>
								</div>
								<div>
									<span>官网引用</span>
									<i style={{ width: percentage(overall.citationRate as number) }} />
									<b>{percentage(overall.citationRate as number)}</b>
								</div>
							</div>
						);
					})}
				</div>
			)}
			<div className="trend-charts">
				<MentionBarChart
					title="各批次品牌提及率"
					items={trends.comparable.map((item) => ({
						label: `${batchKindLabel(item.kind as BatchSummary["kind"])} · ${shortDate(item.createdAt)}`,
						value: overallMetric(item, "brandMentionRate"),
					}))}
				/>
				{anchor ? (
					<MentionBarChart
						title="各平台品牌提及率"
						items={perPlatformMention(anchor.metrics)}
						note="取自当前选中批次；失败平台不进入品牌率分母。"
					/>
				) : null}
			</div>
		</div>
	);
}

type ChartSeries = { label: string; color: string; values: Array<number | null> };
type ChartLabel = { id: string; label: string };

const overallMetric = (item: TrendResponse["comparable"][number], key: string): number | null =>
	(item.metrics.overall[key] as number | null | undefined) ?? null;

const overallPercent = (item: TrendResponse["comparable"][number], key: string): number | null => {
	const value = overallMetric(item, key);
	return value == null ? null : value * 100;
};

const perPlatformMention = (metrics: Batch["metrics"]): Array<{ label: string; value: number | null }> =>
	Object.entries(metrics.perPlatform).map(([platform, item]) => ({ label: providerShortLabel(platform), value: item.brandMentionRate }));

function ChartLegend({ series }: { series: ChartSeries[] }) {
	return (
		<div className="chart-legend">
			{series.map((item) => (
				<span key={item.label}>
					<i style={{ background: item.color }} />
					{item.label}
				</span>
			))}
		</div>
	);
}

function LineTrendChart({ series, labels }: { series: ChartSeries[]; labels: ChartLabel[] }) {
	const width = 1000;
	const height = 260;
	const padLeft = 46;
	const padRight = 16;
	const padTop = 16;
	const padBottom = 30;
	const innerWidth = width - padLeft - padRight;
	const innerHeight = height - padTop - padBottom;
	const xAt = (index: number) => (labels.length > 1 ? padLeft + (innerWidth * index) / (labels.length - 1) : width / 2);
	const yAt = (value: number) => padTop + innerHeight * (1 - Math.min(100, Math.max(0, value)) / 100);
	return (
		<div className="chart-card">
			<div className="chart-head">
				<h4>关键指标趋势</h4>
				<ChartLegend series={series} />
			</div>
			<svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="关键指标趋势图">
				{[0, 25, 50, 75, 100].map((tick) => (
					<g key={tick}>
						<line x1={padLeft} y1={yAt(tick)} x2={width - padRight} y2={yAt(tick)} stroke="var(--line)" strokeWidth="1" />
						<text x={padLeft - 8} y={yAt(tick) + 4} textAnchor="end">
							{tick}%
						</text>
					</g>
				))}
				{labels.map((item, index) => (
					<text key={item.id} x={xAt(index)} y={height - 8} textAnchor="middle">
						{item.label}
					</text>
				))}
				{series.map((item) => {
					const segments: string[] = [];
					let current = "";
					item.values.forEach((value, index) => {
						if (value == null) {
							if (current) segments.push(current);
							current = "";
							return;
						}
						current += `${current ? " L" : "M"}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`;
					});
					if (current) segments.push(current);
					return (
						<g key={item.label}>
							{segments.map((d) => (
								<path key={d} d={d} fill="none" stroke={item.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
							))}
							{item.values.map((value, index) =>
								value == null ? null : (
									<circle
										key={`${item.label}-${labels[index]?.id ?? value}`}
										cx={xAt(index)}
										cy={yAt(value)}
										r="3.5"
										fill="var(--surface)"
										stroke={item.color}
										strokeWidth="2"
									/>
								),
							)}
						</g>
					);
				})}
			</svg>
		</div>
	);
}

function MentionBarChart({
	title,
	items,
	note,
}: {
	title: string;
	items: Array<{ label: string; value: number | null }>;
	note?: string;
}) {
	if (!items.length) return null;
	return (
		<div className="chart-card">
			<div className="chart-head">
				<h4>{title}</h4>
			</div>
			<div className="chart-bars">
				{items.map((item) => (
					<div className="chart-bar-row" key={item.label}>
						<span className="chart-bar-label" title={item.label}>
							{item.label}
						</span>
						<span className="chart-bar-track">
							<i className="chart-bar-fill" style={{ width: `${Math.round((item.value ?? 0) * 100)}%` }} />
						</span>
						<span className="chart-bar-value">{percentage(item.value)}</span>
					</div>
				))}
			</div>
			{note ? <p className="chart-note">{note}</p> : null}
		</div>
	);
}

function ComparisonDeltaChart({
	current,
	baseline,
	title = "基线 → 复测变化（百分点）",
}: {
	current: Batch;
	baseline: Batch;
	title?: string;
}) {
	const metrics = [
		{ key: "brandMentionRate", label: "品牌提及率" },
		{ key: "firstRecommendationRate", label: "首位推荐率" },
		{ key: "citationRate", label: "官网引用率" },
	] as const;
	const rows = current.config.platforms.flatMap((platform) =>
		metrics.map((metric) => {
			const before = baseline.metrics.perPlatform[platform]?.[metric.key] ?? null;
			const after = current.metrics.perPlatform[platform]?.[metric.key] ?? null;
			return {
				label: `${providerShortLabel(platform)} · ${metric.label}`,
				value: before == null || after == null ? null : (after - before) * 100,
			};
		}),
	);
	if (!rows.some((row) => row.value != null)) return null;
	return (
		<div className="chart-card">
			<div className="chart-head">
				<h4>{title}</h4>
			</div>
			<div className="chart-bars">
				{rows.map((row) => {
					const widthPercent = Math.min(50, Math.abs(row.value ?? 0) / 2);
					return (
						<div className="chart-bar-row" key={row.label}>
							<span className="chart-bar-label" title={row.label}>
								{row.label}
							</span>
							<span className="chart-delta-track">
								<i className="chart-delta-zero" />
								{row.value == null ? null : (
									<i
										className={`chart-delta-fill ${row.value >= 0 ? "pos" : "neg"}`}
										style={row.value >= 0 ? { left: "50%", width: `${widthPercent}%` } : { right: "50%", width: `${widthPercent}%` }}
									/>
								)}
							</span>
							<span className={`chart-bar-value ${row.value == null ? "" : row.value >= 0 ? "positive" : "negative"}`}>
								{row.value == null ? "-" : `${row.value >= 0 ? "+" : ""}${row.value.toFixed(1)}`}
							</span>
						</div>
					);
				})}
			</div>
			<p className="chart-note">正值表示复测高于基线；数据来自两个冻结批次的平台指标，失败平台不计入分母。</p>
		</div>
	);
}

function ReportExecutiveOverview({
	batch,
	analysis,
	baselineBatch,
	pdfAction,
}: {
	batch: Batch;
	analysis: ReportAnalysis;
	baselineBatch: Batch | null;
	pdfAction?: ReactNode;
}) {
	const overall = batch.metrics.overall;
	return (
		<section className="report-executive-overview">
			<div className="executive-summary">
				<div>
					<span className="eyebrow">管理层摘要</span>
					<h2>{analysis.executive.headline}</h2>
					<p className="ds-sub">{analysis.executive.summary}</p>
				</div>
				<div className={`evidence-level level-${analysis.executive.evidenceLevel}`}>
					<span>证据等级</span>
					<strong>{analysis.executive.evidenceLevel}</strong>
				</div>
			</div>
			<p className="validity-note">{analysis.executive.validityNote}</p>
			<div className="ds-darkstrip">
				<div className="dm">
					<span>品牌提及率</span>
					<b>{percentage(overall.brandMentionRate as number | undefined)}</b>
				</div>
				<div className="dm">
					<span>首位推荐率</span>
					<b>{percentage(overall.firstRecommendationRate as number | undefined)}</b>
				</div>
				<div className="dm">
					<span>官网引用率</span>
					<b>{percentage(overall.citationRate as number | undefined)}</b>
				</div>
				<div className="dm">
					<span>平均提及位置</span>
					<b>
						{typeof overall.averageMentionPosition === "number" ? overall.averageMentionPosition.toFixed(1) : "-"}
					</b>
				</div>
				<div className="dm">
					<span>有效样本</span>
					<b>
						{batch.metrics.validSamples}/{batch.metrics.expectedSamples}
					</b>
				</div>
			</div>
			{baselineBatch ? (
				<div className="report-card report-comparison-card">
					<div className="report-head">
						<div>
							<strong>01 整改前后对比</strong>
							<span>与基线使用完全相同的问法、平台与采样条件</span>
						</div>
						{pdfAction}
					</div>
					<ComparisonDeltaChart current={batch} baseline={baselineBatch} title="整改前后对比（百分点）" />
				</div>
			) : null}
		</section>
	);
}

function BatchMetrics({ batch }: { batch: Batch }) {
	return (
		<div className="metrics-area">
			<div className="sample-line">
				<span>
					有效样本 <b>{batch.metrics.validSamples}</b>
				</span>
				<span>
					失败样本 <b>{batch.metrics.failedSamples}</b>
				</span>
				<span>
					计划样本 <b>{batch.metrics.expectedSamples}</b>
				</span>
				<span>
					条件{" "}
					<b>
						{batch.config.prompts.length}题 × {batch.config.platforms.length}平台 × {batch.config.repeats}次
					</b>
				</span>
			</div>
			<div className="metric-grid">
				{Object.entries(batch.metrics.perPlatform).map(([platform, metrics]) => (
					<article className="metric-card" key={platform}>
						<header>
							<strong>{providerLabel(platform)}</strong>
							<span className="metric-badge">
								{metrics.answeredCaptures}/{metrics.totalCaptures} 有回答
							</span>
						</header>
						<div className="metric-hero">
							<b>{percentage(metrics.brandMentionRate)}</b>
							<span>品牌提及率</span>
						</div>
						<dl>
							<div>
								<dt>首位推荐率</dt>
								<dd>{percentage(metrics.firstRecommendationRate)}</dd>
							</div>
							<div>
								<dt>官网引用率</dt>
								<dd>{percentage(metrics.citationRate)}</dd>
							</div>
							<div>
								<dt>品牌声量份额</dt>
								<dd>{percentage(metrics.brandShareOfVoice)}</dd>
							</div>
							<div>
								<dt>重复一致性</dt>
								<dd>{percentage(metrics.repeatConsistency)}</dd>
							</div>
							<div>
								<dt>平均提及位置</dt>
								<dd>{metrics.averageMentionPosition?.toFixed(1) ?? "-"}</dd>
							</div>
							<div>
								<dt>回答覆盖率</dt>
								<dd>{percentage(metrics.answerCoverage)}</dd>
							</div>
						</dl>
					</article>
				))}
			</div>
			<Notice message="平台指标分别计算；总览只做平台等权汇总。AI答案具有随机性，本系统报告采样变化，不承诺固定排名。" />
		</div>
	);
}

function BatchPicker({
	project,
	selected,
	setSelected,
}: {
	project: Project;
	selected: string | null;
	setSelected(id: string): void;
}) {
	return (
		<select value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}>
			{project.batches.map((batch) => (
				<option value={batch.id} key={batch.id}>
					{batchKindLabel(batch.kind)} · {date(batch.created_at)} · {batch.status}
				</option>
			))}
		</select>
	);
}

function useBatch(project: Project) {
	const [selected, setSelected] = useState(project.batches[0]?.id ?? null);
	const [batch, setBatch] = useState<Batch | null>(null);
	useEffect(() => {
		if (selected)
			api<Batch>(`/api/batches/${selected}`)
				.then(setBatch)
				.catch(() => setBatch(null));
	}, [selected]);
	return { selected, setSelected, batch };
}

function Evidence({ project }: { project: Project }) {
	const { selected, setSelected, batch } = useBatch(project);
	const [platform, setPlatform] = useState("all");
	const captures = useMemo(
		() => batch?.captures.filter((item) => platform === "all" || item.engine === platform) ?? [],
		[batch, platform],
	);
	const [activeCaptureId, setActiveCaptureId] = useState<string | null>(null);
	const activeCapture = captures.find((item) => item.captureId === activeCaptureId) ?? captures[0] ?? null;
	function exportCsv() {
		const headers = [
			"证据ID",
			"平台",
			"问题",
			"采样次数",
			"状态",
			"回答",
			"引用URL",
			"平台检索拆解",
			"原始响应",
			"模型",
			"协议",
			"请求ID",
			"成本(微美元)",
			"采集时间",
			"失败原因",
		];
		const rows = captures.map((capture) => [
			capture.captureId,
			capture.engine,
			capture.prompt,
			capture.attempt,
			capture.status,
			capture.answerText,
			capture.sources.map((source) => source.url).join("\n"),
			capture.queryFanOut.join("\n"),
			capture.evidence.rawResponseObjectKey
				? `/artifacts/${capture.evidence.rawResponseObjectKey}`
				: capture.evidence.screenshotObjectKey
					? `/artifacts/${capture.evidence.screenshotObjectKey}`
					: "",
			capture.model,
			capture.protocol,
			capture.evidence.requestId,
			capture.costMicros,
			capture.capturedAt,
			capture.failureMessage,
		]);
		downloadText(
			`${project.name}-${selected ?? "证据"}.csv`,
			`\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`,
			"text/csv;charset=utf-8",
		);
	}
	if (!project.batches.length)
		return <Empty title="还没有证据" detail="完成至少一个真实采集批次后，回答、来源和原始 API 响应会出现在这里。" />;
	return (
		<section>
			<div className="overview-head evidence-head">
				<div>
					<span className="eyebrow">证据中心</span>
					<h2>回答原文存证</h2>
					<p className="muted">原始回答与 API 响应写入后不可修改；派生指标可以按新规则重算。</p>
				</div>
				<div className="filters">
					<BatchPicker project={project} selected={selected} setSelected={setSelected} />
					<Button variant="secondary" icon={<IconDownload size={16} />} disabled={!captures.length} onClick={exportCsv}>
						导出证据 CSV
					</Button>
				</div>
			</div>
			<div className="filter-chips">
				<button
					type="button"
					className={platform === "all" ? "filter-chip sel" : "filter-chip"}
					onClick={() => setPlatform("all")}
				>
					全部
				</button>
				{[...new Set(batch?.config.platforms ?? providerIds)].map((id) => (
					<button
						type="button"
						className={platform === id ? "filter-chip sel" : "filter-chip"}
						key={id}
						onClick={() => setPlatform(id)}
					>
						{providerLabel(id)}
					</button>
				))}
			</div>
			{captures.length === 0 ? (
				<Empty title="批次尚无采集结果" detail="云端 Worker 可能仍在等待分时窗口，或平台配置需要处理。" />
			) : (
				<>
					<div className="evidence-grid">
						{captures.map((capture) => (
							<button
								type="button"
								className={`evidence-card ${activeCapture?.captureId === capture.captureId ? "selected" : ""}`}
								key={capture.captureId}
								onClick={() => setActiveCaptureId(capture.captureId)}
							>
								<span className="ev-platform">{providerLabel(capture.engine)}</span>
								<strong>“{capture.prompt}”</strong>
								<span className="ev-meta">
									{capture.status === "success" ? "有回答" : capture.status} · 第 {capture.attempt} 次采样 ·{" "}
									{date(capture.capturedAt)}
								</span>
							</button>
						))}
					</div>
					{activeCapture && <EvidenceDetail capture={activeCapture} />}
				</>
			)}
		</section>
	);
}

function EvidenceDetail({ capture }: { capture: Capture }) {
	return (
		<article className="evidence-detail">
			<div className="ed-head">
				<span className="ev-platform">{providerLabel(capture.engine)}</span>
				<div>
					<strong>“{capture.prompt}”</strong>
					<span className="ed-time">
						采集于 {date(capture.capturedAt)} · 第 {capture.attempt} 次采样 · {capture.model ?? "历史页面"} ·{" "}
						{capture.protocol ?? capture.captureMode} · 证据ID {capture.captureId}
					</span>
				</div>
				{capture.evidence.requestId && (
					<span className="ed-hash" title="证据请求 ID，用于校验完整性">
						<IconShieldCheck size={12} />
						<code>{capture.evidence.requestId}</code>
					</span>
				)}
			</div>
			{capture.answerText ? (
				<blockquote className="ed-quote">{capture.answerText}</blockquote>
			) : (
				<Notice type="error" message={capture.failureMessage ?? "本次采集没有回答"} />
			)}
			<div className="ed-foot">
				<span className="ed-status">
					结论：
					{capture.status === "success"
						? capture.brandMatches.length > 0
							? `品牌被提及 ${capture.brandMatches.length} 次`
							: "回答未提及品牌"
						: (capture.failureMessage ?? "本次采集未完成")}
				</span>
				<span className="ed-tags">
					{capture.brandMatches.length > 0
						? `提及位置 ${capture.brandMatches.map((match) => match.position).join("、")}`
						: "未提及"}
					{capture.sources.length > 0 ? ` · 引用来源 ${capture.sources.length} 条` : ""}
					{capture.evidence.rawResponseObjectKey || capture.evidence.screenshotObjectKey ? " · 截图 + 原文已存证" : ""}
				</span>
			</div>
			{capture.sources.length > 0 && (
				<div className="sources">
					<b>引用来源</b>
					{capture.sources.map((source) => (
						<a href={source.url} target="_blank" rel="noreferrer" key={`${source.position}-${source.url}`}>
							{source.position}. {source.title ?? source.domain}
						</a>
					))}
				</div>
			)}
			{capture.sourceVisibility === "unavailable" && (
				<p className="muted">该平台本次未开放来源数据，引用率记为不可用，不按 0 计算。</p>
			)}
			{capture.queryFanOut.length > 0 && (
				<div className="query-fanout">
					<b>平台检索拆解</b>
					<div>
						{capture.queryFanOut.map((query) => (
							<span key={query}>{query}</span>
						))}
					</div>
				</div>
			)}
			{(capture.evidence.rawResponseObjectKey || capture.evidence.screenshotObjectKey) && (
				<a
					className="screenshot-link"
					href={`/artifacts/${capture.evidence.rawResponseObjectKey ?? capture.evidence.screenshotObjectKey}`}
					target="_blank"
					rel="noreferrer"
				>
					<IconFileText size={16} />
					{capture.captureMode === "llm_search_api" ? "查看原始 API 响应" : "查看历史页面截图"}
				</a>
			)}
		</article>
	);
}

function WebsiteAudit({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const audit = project.websiteAudits?.[0];
	async function run() {
		setBusy(true);
		setError(null);
		try {
			await post(`/api/projects/${project.id}/audit`);
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "官网审计失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="audit-page">
			<div className="overview-head audit-head">
				<div>
					<span className="eyebrow">官网审计</span>
					<h2>公开页面的 AI 可读性检查</h2>
					<p className="muted">检查 AI 与搜索系统能否稳定读取官网，以及页面是否提供可理解、可引用的实体和事实结构。</p>
				</div>
				<Button busy={busy} icon={<IconShieldCheck size={17} />} onClick={run}>
					{audit ? "重新审计" : "开始真实审计"}
				</Button>
			</div>
			{error && <Notice type="error" message={error} />}
			{!audit ? (
				<Empty
					title="还没有官网审计证据"
					detail="运行后会真实请求客户官网、robots.txt、Sitemap 和 llms.txt，并保存不可变审计快照。"
				/>
			) : (
				<>
					<div className="audit-overview">
						<div className={`audit-score-hero ${audit.result.verdict}`}>
							<b>{audit.result.score}</b>
							<span>/ 100</span>
						</div>
						<div>
							<strong>
								{audit.result.verdict === "ready"
									? "官网读取基础完整"
									: audit.result.verdict === "blocked"
										? "官网存在读取阻断"
										: "官网可读取，但存在重要缺口"}
							</strong>
							<p>
								最近审计：{date(audit.result.checkedAt)} · {audit.result.checks.length} 项检查 · 审计证据 ID:{audit.id}
							</p>
							<p>
								HTTPS {audit.result.transport.https.ok ? "正常" : "异常"} · Sitemap{" "}
								{audit.result.discovery.sitemap.urlCount} 个 URL · JSON-LD{" "}
								{audit.result.homepage.structuredDataTypes.length || 0} 类
							</p>
						</div>
					</div>
					{!audit.result.transport.https.ok &&
						(audit.result.transport.httpFallback.ok || audit.result.transport.browserFallback.ok) && (
							<Notice
								type="error"
								message="HTTPS 校验失败，普通浏览器方式仍能读取页面。系统用可访问内容完成结构检查；这不代表 HTTPS 或机器人访问问题已通过。"
							/>
						)}
					<div className="audit-facts">
						<div>
							<span>页面标题</span>
							<strong>{audit.result.homepage.title ?? "未检测到"}</strong>
						</div>
						<div>
							<span>Canonical</span>
							<strong>{audit.result.homepage.canonical ?? "未声明"}</strong>
						</div>
						<div>
							<span>标题结构</span>
							<strong>
								H1 {audit.result.homepage.h1Count} · H2 {audit.result.homepage.h2Count}
							</strong>
						</div>
						<div>
							<span>结构化数据</span>
							<strong>{audit.result.homepage.structuredDataTypes.join("、") || "未检测到"}</strong>
						</div>
					</div>
					<div className="audit-checks">
						<header>
							<h3>审计项目</h3>
							<span>{audit.result.checks.filter((check) => check.status === "pass").length} 项通过</span>
						</header>
						<div className="audit-check-grid">
							{audit.result.checks.map((check) => (
								<article className={`audit-check-card ${check.status}`} key={check.id}>
									<span className={`check-state ${check.status}`}>
										{check.status === "pass"
											? "通过"
											: check.status === "fail"
												? "失败"
												: check.status === "warning"
													? "警告"
													: "参考"}
									</span>
									<strong>{check.label}</strong>
									<p>{check.detail}</p>
									<code>{check.id}</code>
								</article>
							))}
						</div>
					</div>
				</>
			)}
		</section>
	);
}

function Diagnosis({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [selected, setSelected] = useState(project.batches[0]?.id ?? null);
	const [busy, setBusy] = useState<"rules" | "model" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
	const findings = project.findings.filter((item) => item.batch_id === selected);
	const loadAgentRuns = useCallback(async () => {
		const result = await api<{ runs: AgentRun[] }>(`/api/projects/${project.id}/agent-runs`);
		setAgentRuns(result.runs.filter((run) => run.batch_id === selected && run.purpose === "diagnosis"));
	}, [project.id, selected]);
	useEffect(() => {
		void loadAgentRuns().catch(() => setAgentRuns([]));
	}, [loadAgentRuns]);
	useAgentRunPolling(agentRuns, loadAgentRuns);
	async function run(enhanceWithModel = false) {
		if (!selected) return;
		setBusy(enhanceWithModel ? "model" : "rules");
		setError(null);
		try {
			await post(`/api/batches/${selected}/diagnose${enhanceWithModel ? "/model" : ""}`);
			if (enhanceWithModel) await loadAgentRuns();
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "诊断失败");
		} finally {
			setBusy(null);
		}
	}
	if (!project.batches.length)
		return <Empty title="尚不能诊断" detail="诊断必须基于成功采集的真实回答。请先建立基线。" />;
	return (
		<section>
			<div className="overview-head">
				<div>
					<span className="eyebrow">差距诊断</span>
					<h2>证据定位的可整改差距</h2>
					<p className="muted">
						确定性规则输出可复核指标；Pi Agent 只能读取项目证据，并通过 HRouter GPT 生成待人工审批草稿。
					</p>
				</div>
				<div className="actions">
					<BatchPicker project={project} selected={selected} setSelected={setSelected} />
					<Button variant="secondary" busy={busy === "model"} onClick={() => run(true)}>
						Pi Agent 诊断草稿
					</Button>
					<Button busy={busy === "rules"} icon={<IconSearch size={17} />} onClick={() => run()}>
						生成证据诊断
					</Button>
				</div>
			</div>
			{error && <Notice type="error" message={error} />}
			{agentRuns.map((run) => (
				<article className="agent-draft" key={run.id}>
					<div>
						<span className="eyebrow">Pi Agent · {run.model}</span>
						<h3>{run.status === "awaiting_approval" ? "诊断草稿待审批" : `Agent 运行：${run.status}`}</h3>
						<p>
							{run.error_message ??
								(["queued", "running"].includes(run.status)
									? "Agent 正在后台读取项目证据；离开页面不会中断任务。"
									: "草稿中的每个结论已通过证据 ID 白名单校验；批准前不会写入正式诊断。")}
						</p>
						{run.draft && <pre>{JSON.stringify(run.draft, null, 2)}</pre>}
					</div>
					{run.status === "awaiting_approval" && (
						<div className="actions">
							<Button variant="secondary" onClick={() => post(`/api/agent-runs/${run.id}/reject`).then(loadAgentRuns)}>
								拒绝
							</Button>
							<Button
								onClick={() =>
									post(`/api/agent-runs/${run.id}/approve`).then(async () => {
										await loadAgentRuns();
										await refresh();
									})
								}
							>
								批准并入库
							</Button>
						</div>
					)}
				</article>
			))}
			{findings.length === 0 ? (
				<Empty
					title="这个批次还没有诊断"
					detail="采集完成后可直接运行证据规则；没有模型密钥也能生成真实诊断和整改任务。"
				/>
			) : (
				<ul className="gap-list">
					{findings.map((finding) => (
						<li className="gap-item" key={finding.id}>
							<span className="gap-level gap-confidence">
								{Math.round(finding.confidence * 100)}
								<small>%</small>
							</span>
							<div>
								<span className="eyebrow">{finding.category}</span>
								<strong>{finding.title}</strong>
								<p>{finding.detail}</p>
							</div>
							<span className="gap-suggest">
								<b>整改建议</b>
								{finding.recommendation}
							</span>
							<small className="gap-evidence">关联证据：{finding.evidence_ids.join("、")}</small>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function Remediation({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
	const latestBatch = project.batches[0]?.id;
	const loadAgentRuns = useCallback(async () => {
		const result = await api<{ runs: AgentRun[] }>(`/api/projects/${project.id}/agent-runs`);
		setAgentRuns(result.runs.filter((run) => ["remediation", "content_brief"].includes(run.purpose)));
	}, [project.id]);
	useEffect(() => {
		void loadAgentRuns().catch(() => setAgentRuns([]));
	}, [loadAgentRuns]);
	useAgentRunPolling(agentRuns, loadAgentRuns);
	async function call(id: string, action: () => Promise<unknown>) {
		setBusy(id);
		setError(null);
		try {
			await action();
			await loadAgentRuns();
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "操作失败");
		} finally {
			setBusy(null);
		}
	}
	return (
		<section>
			<div className="overview-head">
				<div>
					<span className="eyebrow">整改中心</span>
					<h2>证据驱动的待审批任务</h2>
					<p className="muted">
						Pi Agent 只生成草稿；每项任务都要由负责人核对证据、验收标准和发布地址后批准。发布后填写真实
						URL，系统重新抓取页面完成验收。
					</p>
				</div>
				<div className="actions">
					<Button
						variant="secondary"
						disabled={!latestBatch}
						busy={busy === "agent-plan"}
						onClick={() =>
							latestBatch &&
							call("agent-plan", () => post(`/api/batches/${latestBatch}/agent`, { purpose: "remediation" }))
						}
					>
						Pi Agent 规划草稿
					</Button>
					<Button
						disabled={!latestBatch}
						busy={busy === "create"}
						icon={<IconPlus size={17} />}
						onClick={() =>
							latestBatch &&
							call("create", () => post(`/api/projects/${project.id}/tasks/from-findings`, { batchId: latestBatch }))
						}
					>
						从已批准诊断建任务
					</Button>
				</div>
			</div>
			{error && <Notice type="error" message={error} />}
			{agentRuns
				.filter((run) => ["queued", "running", "awaiting_approval", "failed"].includes(run.status))
				.map((run) => (
					<article className="agent-draft" key={run.id}>
						<div>
							<span className="eyebrow">Pi Agent · {run.purpose === "content_brief" ? "内容简报" : "整改规划"}</span>
							<h3>{run.status === "awaiting_approval" ? "草稿待人工审批" : `Agent 运行：${run.status}`}</h3>
							{run.error_message && <p>{run.error_message}</p>}
							{run.draft && <pre>{JSON.stringify(run.draft, null, 2)}</pre>}
						</div>
						{run.status === "awaiting_approval" && (
							<div className="actions">
								<Button
									variant="secondary"
									onClick={() => post(`/api/agent-runs/${run.id}/reject`).then(loadAgentRuns)}
								>
									拒绝
								</Button>
								<Button
									onClick={() =>
										post(`/api/agent-runs/${run.id}/approve`).then(async () => {
											await loadAgentRuns();
											await refresh();
										})
									}
								>
									批准并入库
								</Button>
							</div>
						)}
					</article>
				))}
			{project.tasks.length === 0 ? (
				<Empty title="还没有整改任务" detail="先完成诊断，再把有证据的结论转换为可跟踪任务。" />
			) : (
				<div className="remediation-list">
					{project.tasks.map((task) => (
						<TaskItem key={task.id} task={task} busy={busy === task.id} act={(action) => call(task.id, action)} />
					))}
				</div>
			)}
		</section>
	);
}

const taskStatusLabels: Record<string, string> = {
	todo: "待处理",
	in_progress: "处理中",
	published: "已发布",
	verified: "已验收",
	done: "已完成",
};

function taskPriorityMeta(priority: string): { className: string; label: string } {
	if (priority === "high") return { className: "high", label: "高优先级" };
	if (priority === "medium" || priority === "mid") return { className: "mid", label: "中优先级" };
	return { className: "low", label: "常规" };
}

function TaskItem({ task, busy, act }: { task: Task; busy: boolean; act(action: () => Promise<unknown>): void }) {
	const [url, setUrl] = useState(task.published_url ?? "");
	const [owner, setOwner] = useState(task.owner ?? "");
	const [dueDate, setDueDate] = useState(task.due_date ? task.due_date.slice(0, 10) : "");
	const priority = taskPriorityMeta(task.priority);
	return (
		<article className="task remediation-item">
			<div className="remediation-main">
				<span className={`task-priority ${priority.className}`}>{priority.label}</span>
				<strong>{task.title}</strong>
				<p>{task.detail}</p>
				<small>
					目标：{task.expected_metric} · 关联 {task.target_prompt_ids.length} 个问题
				</small>
			</div>
			<span className={`task-status-badge task-status-${task.status}`}>
				{taskStatusLabels[task.status] ?? task.status}
			</span>
			<div className="task-header-actions">
				<select
					aria-label="任务状态"
					value={task.status}
					onChange={(event) => act(() => patch(`/api/tasks/${task.id}`, { status: event.target.value }))}
				>
					<option value="todo">待处理</option>
					<option value="in_progress">处理中</option>
					<option value="published">已发布</option>
					<option value="verified">已验收</option>
					<option value="done">已完成</option>
				</select>
				<Button
					variant="ghost"
					icon={<IconTrash size={17} />}
					aria-label="删除整改任务"
					title="删除整改任务"
					onClick={() => act(() => api(`/api/tasks/${task.id}`, { method: "DELETE" }))}
				/>
			</div>
			<dl className="task-contract">
				<div>
					<dt>预期指标</dt>
					<dd>{task.expected_metric}</dd>
				</div>
				<div>
					<dt>验收标准</dt>
					<dd>{task.acceptance_criteria}</dd>
				</div>
				<div>
					<dt>关联问题</dt>
					<dd>{task.target_prompt_ids.length} 个</dd>
				</div>
			</dl>
			<div className="task-owner">
				<label>
					负责人
					<input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="负责人" />
				</label>
				<label>
					截止时间
					<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
				</label>
				<Button
					variant="secondary"
					onClick={() =>
						act(() =>
							patch(`/api/tasks/${task.id}`, {
								owner: owner || null,
								dueDate: dueDate ? new Date(`${dueDate}T23:59:59+08:00`).toISOString() : null,
							}),
						)
					}
				>
					保存责任人和日期
				</Button>
			</div>
			<div className="task-actions">
				<Button variant="secondary" busy={busy} onClick={() => act(() => post(`/api/tasks/${task.id}/content`))}>
					<IconFileText size={16} />
					Pi Agent 生成待审批内容
				</Button>
				<div className="url-entry">
					<input
						type="url"
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="https://真实发布地址"
					/>
					<Button
						variant="secondary"
						onClick={() =>
							act(async () => {
								await patch(`/api/tasks/${task.id}`, { publishedUrl: url, status: "published" });
								await post(`/api/tasks/${task.id}/verify`);
							})
						}
					>
						抓取验收
					</Button>
				</div>
			</div>
			{task.content_brief && (
				<details>
					<summary>内容简报</summary>
					<pre>{task.content_brief}</pre>
				</details>
			)}
			{task.draft_content && (
				<details>
					<summary>内容初稿</summary>
					<pre>{task.draft_content}</pre>
				</details>
			)}
			{task.verified_snapshot_id && (
				<Notice type="success" message={`已抓取真实发布页面，快照ID：${task.verified_snapshot_id}`} />
			)}
		</article>
	);
}

const sourceLabels: Record<string, string> = {
	ga4: "GA4",
	gsc: "Search Console",
	form: "表单线索",
	phone: "电话咨询",
	manual: "业务台账",
};
const metricLabels: Record<string, string> = {
	sessions: "会话",
	users: "用户",
	organic_clicks: "自然点击",
	impressions: "搜索曝光",
	leads: "线索",
	qualified_leads: "有效线索",
	phone_calls: "电话咨询",
	revenue: "成交金额",
};

function Attribution({ project }: { project: Project }) {
	const [data, setData] = useState<AttributionPayload | null>(null);
	const [sourceType, setSourceType] = useState("ga4");
	const [file, setFile] = useState<File | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		setData(await api<AttributionPayload>(`/api/projects/${project.id}/attribution`));
	}, [project.id]);
	useEffect(() => {
		void load().catch((reason) => setError(reason instanceof Error ? reason.message : "归因数据加载失败"));
	}, [load]);
	async function importCsv() {
		if (!file) return;
		setBusy(true);
		setError(null);
		try {
			await post(`/api/projects/${project.id}/attribution/import`, {
				sourceType,
				fileName: file.name,
				csv: await file.text(),
			});
			setFile(null);
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "归因数据导入失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="attribution-page">
			<div className="overview-head">
				<div>
					<span className="eyebrow">业务归因</span>
					<h2>业务数据与 GEO 指标并列观察</h2>
					<p className="muted">导入 GA4、Search Console、表单、电话和业务台账；系统防重复计数，但不自动声称因果。</p>
				</div>
			</div>
			{error && <Notice type="error" message={error} />}
			<div className="import-band">
				<div>
					<IconRoute size={25} />
					<h3>导入真实 CSV</h3>
					<p>支持 GA4/GSC 常见宽表，或 observed_at、metric、value、landing_url 标准列；相同文件不会重复计数。</p>
				</div>
				<div className="import-controls">
					<label>
						数据来源
						<select value={sourceType} onChange={(event) => setSourceType(event.target.value)}>
							{Object.entries(sourceLabels).map(([value, label]) => (
								<option value={value} key={value}>
									{label}
								</option>
							))}
						</select>
					</label>
					<label className="file-control">
						CSV 文件
						<input type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
					</label>
					<Button busy={busy} disabled={!file} onClick={importCsv}>
						导入并校验
					</Button>
				</div>
			</div>
			<Notice message="业务数据与 AI 监测并列展示。系统不会仅凭时间上的同步变化宣称 GEO 整改带来了线索；成交与有效咨询仍需业务人员确认。" />
			{!data ? (
				<div className="center">
					<IconLoader2 className="spin" />
				</div>
			) : data.summary.length === 0 ? (
				<Empty
					title="还没有真实归因数据"
					detail="导入客户自己的导出文件后，这里才会显示访问、搜索点击、表单或电话指标。"
				/>
			) : (
				<>
					<div className="attribution-kpis">
						{data.summary.map((item) => (
							<div className="attribution-kpi" key={`${item.source_type}-${item.metric}`}>
								<span className="kpi-label">
									{sourceLabels[item.source_type] ?? item.source_type} · {metricLabels[item.metric] ?? item.metric}
								</span>
								<span className="kpi-value">{item.value.toLocaleString("zh-CN")}</span>
								<span className="kpi-chip">
									{item.observations} 条观察 · 至 {date(item.last_observed_at)}
								</span>
							</div>
						))}
					</div>
					<div className="attribution-columns">
						<div>
							<h3>最近业务观察</h3>
							<div className="attribution-table">
								{data.events.map((event) => (
									<div key={event.id}>
										<strong>{date(event.observed_at)}</strong>
										<span>
											{sourceLabels[event.source_type] ?? event.source_type} ·{" "}
											{metricLabels[event.metric] ?? event.metric}
											{(event.landing_url ?? event.channel) ? ` · ${event.landing_url ?? event.channel}` : ""}
										</span>
										<b>{event.value.toLocaleString("zh-CN")}</b>
									</div>
								))}
							</div>
						</div>
						<aside>
							<h3>导入记录</h3>
							{data.imports.map((item) => (
								<div className="import-record" key={item.id}>
									<b>{item.file_name}</b>
									<span>
										{sourceLabels[item.source_type] ?? item.source_type} · {item.row_count} 行
									</span>
									<small>{date(item.imported_at)}</small>
								</div>
							))}
						</aside>
					</div>
				</>
			)}
		</section>
	);
}

const agentToolLabels: Record<string, string> = {
	read_project_context: "读取项目",
	read_batch_evidence_index: "建立证据索引",
	read_evidence: "核验原始证据",
	submit_draft: "校验草稿",
};

const agentStatusLabels: Record<AgentRun["status"], string> = {
	queued: "排队中",
	running: "分析中",
	awaiting_approval: "待审批",
	approved: "已批准",
	rejected: "已拒绝",
	failed: "执行失败",
};

function agentPurposeLabel(purpose: string): string {
	return purpose === "report_narrative" ? "报告叙述" : purpose === "quality_review" ? "质量检查" : purpose;
}

function agentRunPhase(run: AgentRun): string {
	if (run.status === "queued") return run.error_message ?? "等待 Agent Worker 领取任务";
	if (run.status === "awaiting_approval") return "结构化草稿已完成，等待人工审批";
	if (run.status === "approved") return "草稿已批准，可冻结到新的报告版本";
	if (run.status === "rejected") return "草稿已拒绝，不会进入报告版本";
	if (run.status === "failed") return run.error_message ?? "Agent 执行失败";
	const latest = run.tool_trace.at(-1);
	if (!latest) return "正在连接模型并准备分析";
	if (latest.tool === "submit_draft" && latest.type === "end" && latest.isError)
		return "草稿校验未通过，Agent 正在修正后重新提交";
	if (latest.type === "start") return `正在${agentToolLabels[latest.tool] ?? latest.tool}`;
	if (latest.tool === "read_project_context") return "项目范围已确认，正在建立证据索引";
	if (latest.tool === "read_batch_evidence_index") return "证据索引已建立，正在选择支撑证据";
	if (latest.tool === "read_evidence") return "原始证据已读取，正在形成结论";
	return "正在整理结构化草稿";
}

function agentRunProgress(run: AgentRun): number {
	if (["awaiting_approval", "approved", "rejected"].includes(run.status)) return 100;
	if (run.status === "failed") return Math.max(12, run.tool_trace.filter((item) => item.type === "end").length * 24);
	if (run.status === "queued") return 4;
	const completedTools = new Set(
		run.tool_trace.filter((item) => item.type === "end" && !item.isError).map((item) => item.tool),
	);
	const currentBonus = run.tool_trace.at(-1)?.type === "start" ? 10 : 0;
	return Math.min(92, 8 + completedTools.size * 22 + currentBonus);
}

function agentRunDuration(run: AgentRun): string {
	const seconds = Math.max(
		0,
		Math.round((new Date(run.completed_at ?? Date.now()).getTime() - new Date(run.created_at).getTime()) / 1000),
	);
	return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function AgentDraftContent({ run }: { run: AgentRun }) {
	if (!run.draft) return null;
	if (run.purpose === "report_narrative") {
		const limitations = Array.isArray(run.draft.limitations) ? run.draft.limitations.map(String) : [];
		return (
			<div className="agent-draft-content">
				<div>
					<span>报告摘要</span>
					<p>{String(run.draft.summary ?? "-")}</p>
				</div>
				<div>
					<span>管理层叙述</span>
					<p>{String(run.draft.executiveSummary ?? "-")}</p>
				</div>
				{limitations.length > 0 && (
					<div>
						<span>证据局限</span>
						<ul>
							{limitations.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					</div>
				)}
			</div>
		);
	}
	if (run.purpose === "quality_review") {
		const issues = Array.isArray(run.draft.issues)
			? (run.draft.issues as Array<{ severity?: string; detail?: string }>)
			: [];
		return (
			<div className="agent-draft-content">
				<div>
					<span>检查结论</span>
					<p>{String(run.draft.summary ?? "-")}</p>
				</div>
				<div>
					<span>问题项 · {issues.length}</span>
					{issues.length ? (
						<ul>
							{issues.map((issue) => (
								<li key={`${issue.severity}:${issue.detail}`}>{issue.detail ?? "未说明"}</li>
							))}
						</ul>
					) : (
						<p>未发现需要阻止报告交付的问题。</p>
					)}
				</div>
			</div>
		);
	}
	return <pre>{JSON.stringify(run.draft, null, 2)}</pre>;
}

function ReportAgentRun({
	run,
	onApprove,
	onReject,
}: {
	run: AgentRun;
	onApprove(): Promise<void>;
	onReject(): Promise<void>;
}) {
	const failedChecks = run.tool_trace.filter((item) => item.type === "end" && item.isError);
	const active = run.status === "queued" || run.status === "running";
	const completedTrace = run.tool_trace.filter((item) => item.type === "end");
	const latestTrace = run.tool_trace.at(-1);
	const visibleTrace = latestTrace?.type === "start" ? [...completedTrace, latestTrace] : completedTrace;
	return (
		<article className={`agent-run agent-run-${run.status}`}>
			<div className="agent-run-status-icon" aria-hidden="true">
				{active ? (
					<IconLoader2 className="spin" size={18} />
				) : run.status === "failed" ? (
					<IconAlertTriangle size={18} />
				) : (
					<IconCheck size={18} />
				)}
			</div>
			<div className="agent-run-main">
				<header>
					<div>
						<b>{agentPurposeLabel(run.purpose)}</b>
						<span className={`agent-status status-${run.status}`}>{agentStatusLabels[run.status]}</span>
					</div>
					<small>
						{date(run.created_at)} · {agentRunDuration(run)}
					</small>
				</header>
				<p className="agent-phase">{agentRunPhase(run)}</p>
				<div
					className="agent-progress"
					role="progressbar"
					aria-label="任务进度"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={agentRunProgress(run)}
				>
					<span style={{ width: `${agentRunProgress(run)}%` }} />
				</div>
				<details className="agent-run-details" open={run.status === "failed"}>
					<summary>
						<IconChevronDown size={15} />
						运行详情
						{failedChecks.length > 0 && <span>{failedChecks.length} 次校验修正</span>}
					</summary>
					<div className="agent-run-facts">
						<span>
							模型 <b>{run.model}</b>
						</span>
						<span>
							尝试{" "}
							<b>
								{run.job_attempts ?? 0}/{run.job_max_attempts ?? 0}
							</b>
						</span>
						<span>
							Token <b>{run.usage?.totalTokens?.toLocaleString("zh-CN") ?? "运行中"}</b>
						</span>
					</div>
					{run.error_message && <Notice type="error" message={run.error_message} />}
					{visibleTrace.length > 0 && (
						<ol className="agent-tool-trace">
							{visibleTrace.map((trace) => (
								<li className={trace.isError ? "error" : ""} key={`${trace.at}-${trace.tool}-${trace.type}`}>
									<IconCheck size={14} />
									<div>
										<b>{agentToolLabels[trace.tool] ?? trace.tool}</b>
										<span>
											{trace.type === "start" ? "开始" : trace.isError ? "校验未通过" : "完成"} · {date(trace.at)}
										</span>
										{trace.detail && <p>{trace.detail}</p>}
									</div>
								</li>
							))}
						</ol>
					)}
					<AgentDraftContent run={run} />
				</details>
			</div>
			{run.status === "awaiting_approval" && (
				<div className="agent-run-actions">
					<Button variant="ghost" onClick={() => void onReject()}>
						拒绝
					</Button>
					<Button icon={<IconCheck size={16} />} onClick={() => void onApprove()}>
						批准
					</Button>
				</div>
			)}
		</article>
	);
}

// The printable document stays in one component so its section numbering and conditional retest blocks remain auditable.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: report composition intentionally mirrors the printed document
function Report({ project }: { project: Project }) {
	const { selected, setSelected, batch } = useBatch(project);
	const [baselineBatch, setBaselineBatch] = useState<Batch | null>(null);
	const [report, setReport] = useState<ReportPayload | null>(null);
	const [reportError, setReportError] = useState<string | null>(null);
	const [snapshots, setSnapshots] = useState<ReportSnapshot[]>([]);
	const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
	const [reportBusy, setReportBusy] = useState<string | null>(null);
	const [shareUrl, setShareUrl] = useState<string | null>(null);
	const [shares, setShares] = useState<ReportShare[]>([]);
	const latestSnapshotId = snapshots.find((item) => item.batch_id === selected)?.id ?? null;
	const loadSnapshots = useCallback(async () => {
		const result = await api<{ reports: ReportSnapshot[] }>(`/api/projects/${project.id}/reports`);
		setSnapshots(result.reports);
	}, [project.id]);
	const loadAgentRuns = useCallback(async () => {
		const result = await api<{ runs: AgentRun[] }>(`/api/projects/${project.id}/agent-runs`);
		setAgentRuns(
			result.runs.filter(
				(run) => run.batch_id === selected && ["report_narrative", "quality_review"].includes(run.purpose),
			),
		);
	}, [project.id, selected]);
	const loadShares = useCallback(async (reportId: string) => {
		const result = await api<{ shares: ReportShare[] }>(`/api/reports/${reportId}/shares`);
		setShares(result.shares);
	}, []);
	useEffect(() => {
		void loadSnapshots().catch(() => setSnapshots([]));
		void loadAgentRuns().catch(() => setAgentRuns([]));
	}, [loadSnapshots, loadAgentRuns]);
	const hasActiveAgentRuns = agentRuns.some((run) => run.status === "queued" || run.status === "running");
	useEffect(() => {
		if (!hasActiveAgentRuns) return;
		const timer = window.setInterval(() => void loadAgentRuns().catch(() => undefined), 2_000);
		return () => window.clearInterval(timer);
	}, [hasActiveAgentRuns, loadAgentRuns]);
	useEffect(() => {
		setShareUrl(null);
		if (!latestSnapshotId) {
			setShares([]);
			return;
		}
		void loadShares(latestSnapshotId).catch(() => setShares([]));
	}, [latestSnapshotId, loadShares]);
	useEffect(() => {
		if (!selected) return;
		setReport(null);
		setReportError(null);
		api<ReportPayload>(`/api/batches/${selected}/report`)
			.then(setReport)
			.catch((reason) => setReportError(reason instanceof Error ? reason.message : "报告分析加载失败"));
	}, [selected]);
	useEffect(() => {
		if (!batch?.compare_to_batch_id) {
			setBaselineBatch(null);
			return;
		}
		api<Batch>(`/api/batches/${batch.compare_to_batch_id}`)
			.then(setBaselineBatch)
			.catch(() => setBaselineBatch(null));
	}, [batch?.compare_to_batch_id]);
	if (!project.batches.length)
		return <Empty title="还没有报告数据" detail="完成基线后可打印单批次报告；完成同条件复测后可展示前后变化。" />;
	const analysis = report?.analysis;
	const selectedSnapshots = snapshots.filter((item) => item.batch_id === selected);
	const latestSnapshot = selectedSnapshots[0];
	const activeAgentPurposes = new Set(
		agentRuns.filter((run) => run.status === "queued" || run.status === "running").map((run) => run.purpose),
	);
	async function createSnapshot() {
		if (!batch) return;
		setReportBusy("snapshot");
		setReportError(null);
		try {
			await post(`/api/batches/${batch.id}/reports`, {
				reportType: batch.kind === "quick_audit" ? "quick_audit" : batch.kind === "retest" ? "retest" : "remediation",
				compareToBatchId: batch.compare_to_batch_id,
			});
			await loadSnapshots();
		} catch (reason) {
			setReportError(reason instanceof Error ? reason.message : "报告快照生成失败");
		} finally {
			setReportBusy(null);
		}
	}
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Polling preserves each explicit server-side PDF terminal state for the user.
	async function createPdf() {
		if (!latestSnapshot) return;
		setReportBusy("pdf");
		try {
			let result = await post<{ status: "ready" | "queued"; artifactKey: string | null }>(
				`/api/reports/${latestSnapshot.id}/pdf`,
			);
			for (let attempt = 0; result.status !== "ready" && attempt < 120; attempt += 1) {
				await new Promise((resolve) => window.setTimeout(resolve, 1_000));
				const status = await api<{
					status: "ready" | "queued" | "failed" | "missing";
					artifactKey: string | null;
					error: string | null;
				}>(`/api/reports/${latestSnapshot.id}/pdf`);
				if (status.status === "failed" || status.status === "missing") throw new Error(status.error ?? "PDF 生成失败");
				result = { status: status.status === "ready" ? "ready" : "queued", artifactKey: status.artifactKey };
			}
			if (!result.artifactKey) throw new Error("Report Worker 尚未在 2 分钟内完成 PDF");
			await loadSnapshots();
			window.open(`/artifacts/${result.artifactKey}`, "_blank", "noopener,noreferrer");
		} catch (reason) {
			setReportError(reason instanceof Error ? reason.message : "PDF 生成失败");
		} finally {
			setReportBusy(null);
		}
	}
	async function createShare() {
		if (!latestSnapshot) return;
		setReportBusy("share");
		try {
			const result = await post<{ id: string; token: string }>(`/api/reports/${latestSnapshot.id}/shares`, {
				expiresInDays: 30,
			});
			const url = `${window.location.origin}/share/${result.token}`;
			setShareUrl(url);
			await navigator.clipboard?.writeText(url);
			await loadShares(latestSnapshot.id);
		} catch (reason) {
			setReportError(reason instanceof Error ? reason.message : "分享链接创建失败");
		} finally {
			setReportBusy(null);
		}
	}
	async function runReportAgent(purpose: "report_narrative" | "quality_review") {
		if (!batch) return;
		setReportBusy(purpose);
		setReportError(null);
		try {
			await post(`/api/batches/${batch.id}/agent`, { purpose });
			await loadAgentRuns();
		} catch (reason) {
			setReportError(reason instanceof Error ? reason.message : "Agent 运行失败");
		} finally {
			setReportBusy(null);
		}
	}
	return (
		<section className="report">
			<div className="report-workspace no-print">
				<div className="overview-head">
					<div>
						<span className="eyebrow">报告工作台</span>
						<h2>中文效果报告</h2>
						<p className="muted">
							{batch ? `${batchKindLabel(batch.kind)} · ${date(batch.created_at)} · ${batch.status}` : "未选择批次"}
						</p>
					</div>
					<BatchPicker project={project} selected={selected} setSelected={setSelected} />
				</div>
				<div className="report-command-bar">
					<div className="report-command-group">
						<span>Agent 分析</span>
						<div>
							<Button
								variant="secondary"
								icon={<IconFileText size={17} />}
								busy={reportBusy === "report_narrative"}
								disabled={!batch || activeAgentPurposes.has("report_narrative")}
								onClick={() => runReportAgent("report_narrative")}
							>
								生成报告叙述
							</Button>
							<Button
								variant="secondary"
								icon={<IconShieldCheck size={17} />}
								busy={reportBusy === "quality_review"}
								disabled={!batch || activeAgentPurposes.has("quality_review")}
								onClick={() => runReportAgent("quality_review")}
							>
								运行质量检查
							</Button>
						</div>
					</div>
					<div className="report-command-group">
						<span>版本</span>
						<div>
							<Button
								variant="secondary"
								icon={<IconDatabase size={17} />}
								busy={reportBusy === "snapshot"}
								disabled={!batch || ["queued", "running"].includes(batch.status)}
								onClick={createSnapshot}
							>
								冻结新版本
							</Button>
						</div>
					</div>
					<div className="report-command-group report-command-delivery">
						<span>交付</span>
						<div>
							<Button
								variant="secondary"
								icon={<IconRoute size={17} />}
								busy={reportBusy === "share"}
								disabled={!latestSnapshot}
								onClick={createShare}
							>
								创建分享链接
							</Button>
						</div>
					</div>
				</div>
			</div>
			{reportError && <Notice type="error" message={reportError} />}
			{batch && analysis ? (
				<ReportExecutiveOverview
					batch={batch}
					analysis={analysis}
					baselineBatch={baselineBatch}
					pdfAction={
						<Button icon={<IconDownload size={17} />} busy={reportBusy === "pdf"} disabled={!latestSnapshot} onClick={createPdf}>
							导出 PDF
						</Button>
					}
				/>
			) : null}
			<section className="agent-activity no-print">
				<header>
					<div>
						<span className="eyebrow">Agent 任务</span>
						<h3>分析活动</h3>
					</div>
					<span>
						{hasActiveAgentRuns
							? `${agentRuns.filter((run) => run.status === "queued" || run.status === "running").length} 个进行中`
							: `${agentRuns.length} 条记录`}
					</span>
				</header>
				{agentRuns.length ? (
					<div className="agent-run-list">
						{agentRuns.slice(0, 8).map((run) => (
							<ReportAgentRun
								key={run.id}
								run={run}
								onApprove={async () => {
									await post(`/api/agent-runs/${run.id}/approve`);
									await loadAgentRuns();
								}}
								onReject={async () => {
									await post(`/api/agent-runs/${run.id}/reject`);
									await loadAgentRuns();
								}}
							/>
						))}
					</div>
				) : (
					<p className="agent-activity-empty">当前批次暂无 Agent 任务。</p>
				)}
			</section>
			<section className="report-assets no-print">
				<header>
					<div>
						<span className="eyebrow">交付资产</span>
						<h3>报告版本与分享</h3>
					</div>
					<span>{selectedSnapshots.length} 个冻结版本</span>
				</header>
				{shareUrl && <Notice type="success" message={`分享链接已复制：${shareUrl}`} />}
				{selectedSnapshots.length > 0 ? (
					<div className="snapshot-strip">
						{selectedSnapshots.map((snapshot) => (
							<article key={snapshot.id}>
								<div>
									<b>{snapshot.title}</b>
									<small>
										{date(snapshot.created_at)} · 哈希 {snapshot.payload_hash.slice(0, 12)}
									</small>
								</div>
								<div className="actions">
									<a className="button secondary" href={`/api/reports/${snapshot.id}/export.csv`}>
										CSV
									</a>
									<Button
										variant="ghost"
										onClick={() =>
											api(`/api/reports/${snapshot.id}`).then((value) =>
												downloadText(
													`${snapshot.title}.json`,
													JSON.stringify(value, null, 2),
													"application/json;charset=utf-8",
												),
											)
										}
									>
										JSON
									</Button>
									{snapshot.pdf_artifact_key && (
										<a
											className="button secondary"
											href={`/artifacts/${snapshot.pdf_artifact_key}`}
											target="_blank"
											rel="noreferrer"
										>
											查看 PDF
										</a>
									)}
								</div>
							</article>
						))}
					</div>
				) : (
					<p className="report-assets-empty">当前批次尚未冻结报告版本。</p>
				)}
				{shares.length > 0 && latestSnapshot && (
					<div className="share-list">
						{shares.map((share) => {
							const expired = new Date(share.expires_at).getTime() <= Date.now();
							const active = !share.revoked_at && !expired;
							return (
								<article key={share.id}>
									<div>
										<b>{active ? "分享中" : share.revoked_at ? "已撤销" : "已过期"}</b>
										<small>
											{share.created_by_email ?? "系统"} · 创建 {date(share.created_at)} · 到期 {date(share.expires_at)}
										</small>
									</div>
									{active && (
										<Button
											variant="ghost"
											onClick={() =>
												api(`/api/report-shares/${share.id}`, { method: "DELETE" }).then(() =>
													loadShares(latestSnapshot.id),
												)
											}
										>
											撤销
										</Button>
									)}
								</article>
							);
						})}
					</div>
				)}
			</section>
			{batch && analysis ? (
				<>
					<div className="report-section">
						<div className="report-title-row">
							<div>
								<span>01</span>
								<h2>采样条件与平台表现</h2>
							</div>
							<small>所有条件写入冻结批次，不随项目后续编辑变化</small>
						</div>
						<dl className="report-facts">
							<div>
								<dt>平台</dt>
								<dd>{batch.config.platforms.join(" / ")}</dd>
							</div>
							<div>
								<dt>问题数</dt>
								<dd>{batch.config.prompts.length}</dd>
							</div>
							<div>
								<dt>每题重复</dt>
								<dd>{batch.config.repeats}</dd>
							</div>
							<div>
								<dt>有效 / 失败</dt>
								<dd>
									{batch.metrics.validSamples} / {batch.metrics.failedSamples}
								</dd>
							</div>
						</dl>
						<BatchMetrics batch={batch} />
					</div>
					<div className="report-section">
						<div className="report-title-row">
							<div>
								<span>02</span>
								<h2>逐问题竞争矩阵</h2>
							</div>
							<small>不是总分平均值，直接显示具体问题的输赢</small>
						</div>
						<table className="comparison-table prompt-matrix">
							<thead>
								<tr>
									<th>购买问题</th>
									<th>客户位置</th>
									<th>提及 / 首位</th>
									<th>竞品位置</th>
									<th>来源</th>
									<th>样本</th>
								</tr>
							</thead>
							<tbody>
								{analysis.promptRows.map((row) => (
									<tr key={row.promptId}>
										<td>
											<strong>{row.question}</strong>
											<small>{row.intent}</small>
										</td>
										<td>
											<span className={`rank rank-${row.bestTargetPosition ?? "none"}`}>
												{row.bestTargetPosition ? `第 ${row.bestTargetPosition}` : "未出现"}
											</span>
										</td>
										<td>
											{percentage(row.targetMentionRate)} / {percentage(row.firstRecommendationRate)}
										</td>
										<td>
											{row.competitors.map((competitor) => (
												<span className="competitor-rank" key={competitor.id}>
													{competitor.name}：{competitor.bestPosition ? `第 ${competitor.bestPosition}` : "未出现"}
												</span>
											))}
										</td>
										<td>{row.sourceCount}</td>
										<td>
											{row.completeSamples}/{row.plannedSamples}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<div className="report-section split-report-section">
						<div>
							<div className="report-title-row">
								<div>
									<span>03</span>
									<h2>引用信源榜</h2>
								</div>
							</div>
							{analysis.sourceDomains.length ? (
								<div className="source-ranking">
									{analysis.sourceDomains.slice(0, 10).map((source, index) => (
										<div key={source.domain}>
											<span>{index + 1}</span>
											<b>{source.domain}</b>
											<small>{source.isOwned ? "客户官网" : `${source.category} · ${source.promptCount} 个问题`}</small>
											<strong>{source.citationCount}</strong>
										</div>
									))}
								</div>
							) : (
								<p className="muted">本批次回答没有展示可提取来源，系统没有补造引用。</p>
							)}
						</div>
						<div>
							<div className="report-title-row">
								<div>
									<span>04</span>
									<h2>AI 如何描述品牌</h2>
								</div>
							</div>
							{analysis.perceptionExcerpts.length ? (
								<div className="perception-list">
									{analysis.perceptionExcerpts.map((excerpt) => (
										<blockquote key={`${excerpt.captureId}-${excerpt.text}`}>
											{excerpt.text}
											<footer>
												{excerpt.platform === "kimi" ? "Kimi" : "DeepSeek"} · 证据 {excerpt.captureId}
											</footer>
										</blockquote>
									))}
								</div>
							) : (
								<p className="muted">回答中没有可直接截取的品牌描述。</p>
							)}
						</div>
					</div>
					<div className="report-section">
						<div className="report-title-row">
							<div>
								<span>05</span>
								<h2>客户、竞品与引用页主题覆盖</h2>
							</div>
							<small>
								客户页 {analysis.webEvidenceSummary.customerPages} · 竞品页{" "}
								{analysis.webEvidenceSummary.competitorPages} · 引用页 {analysis.webEvidenceSummary.citationPages}
							</small>
						</div>
						{analysis.topicCoverage.some((row) => row.terms.length) ? (
							<table className="comparison-table topic-coverage-table">
								<thead>
									<tr>
										<th>购买问题</th>
										<th>已确认主题</th>
										<th>客户已保存页面</th>
										<th>竞品 / 引用页面</th>
									</tr>
								</thead>
								<tbody>
									{analysis.topicCoverage.map((row) => (
										<tr key={row.promptId}>
											<td>{row.question}</td>
											<td>{row.terms.map((term) => term.term).join("、") || "未设置标签"}</td>
											<td>
												{row.terms.map((term) => (
													<span className="coverage-state" key={term.term}>
														{term.term}：
														{term.customerEvidenceIds.length ? `${term.customerEvidenceIds.length} 页` : "未检出"}
													</span>
												))}
											</td>
											<td>
												{row.terms.map((term) => (
													<span className="coverage-state" key={term.term}>
														{term.term}：
														{term.externalEvidenceIds.length ? `${term.externalEvidenceIds.length} 页` : "未检出"}
													</span>
												))}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						) : (
							<p className="muted">当前问题没有已确认标签，系统不从问题文本猜测主题。</p>
						)}
						<p className="limitation">
							{analysis.webEvidenceSummary.customerPages
								? "这里是已保存网页快照的精确文本覆盖对比，用于定位可核验的内容缺口，不解释平台排序算法。"
								: "客户网页证据不足：系统尚未成功保存客户页面，因此只展示外部页面命中，不判定官网内容缺失。"}
						</p>
					</div>
					{analysis.websiteAudit && (
						<div className="report-section">
							<div className="report-title-row">
								<div>
									<span>06</span>
									<h2>官网 GEO 技术基础</h2>
								</div>
								<strong className="inline-score">{analysis.websiteAudit.result.score}/100</strong>
							</div>
							<div className="report-audit-checks">
								{analysis.websiteAudit.result.checks
									.filter((check) => check.status !== "skip")
									.map((check) => (
										<div key={check.id}>
											<span className={`check-state ${check.status}`}>
												{check.status === "pass" ? "通过" : check.status === "fail" ? "失败" : "警告"}
											</span>
											<b>{check.label}</b>
											<p>{check.detail}</p>
										</div>
									))}
							</div>
							<small>官网审计证据：{analysis.websiteAudit.id}</small>
						</div>
					)}
					{baselineBatch && (
						<div className="report-section">
							<div className="report-title-row">
								<div>
									<span>07</span>
									<h2>基线与复测变化</h2>
								</div>
							</div>
							<p>
								本次复测冻结并复用了基线批次 <code>{baselineBatch.id}</code>{" "}
								的客户、竞品、问题、平台、地区、重复次数和采集版本。
							</p>
							<table className="comparison-table">
								<thead>
									<tr>
										<th>平台</th>
										<th>指标</th>
										<th>基线</th>
										<th>复测</th>
										<th>变化</th>
									</tr>
								</thead>
								<tbody>
									{batch.config.platforms.flatMap((platform) => {
										const before = baselineBatch.metrics.perPlatform[platform];
										const after = batch.metrics.perPlatform[platform];
										return (
											[
												["品牌提及率", "brandMentionRate"],
												["首位推荐率", "firstRecommendationRate"],
												["官网引用率", "citationRate"],
											] as const
										).map(([label, key]) => (
											<tr key={`${platform}-${key}`}>
												<td>{providerLabel(platform)}</td>
												<td>{label}</td>
												<td>{percentage(before?.[key])}</td>
												<td>{percentage(after?.[key])}</td>
												<td className={(after?.[key] ?? 0) - (before?.[key] ?? 0) >= 0 ? "positive" : "negative"}>
													{before?.[key] != null && after?.[key] != null
														? `${(((after[key] ?? 0) - (before[key] ?? 0)) * 100).toFixed(1)} 个百分点`
														: "-"}
												</td>
											</tr>
										));
									})}
								</tbody>
							</table>
						</div>
					)}
					<div className="report-section">
						<div className="report-title-row">
							<div>
								<span>{baselineBatch ? "08" : "07"}</span>
								<h2>证据诊断与整改路线</h2>
							</div>
						</div>
						{report.findings.length ? (
							report.findings.map((finding) => (
								<div className="report-finding" key={finding.id}>
									<span>{finding.category}</span>
									<b>{finding.title}</b>
									<p>{finding.detail}</p>
									<p className="report-recommendation">建议：{finding.recommendation}</p>
									<small>
										证据充分度 {Math.round(finding.confidence * 100)}% · 证据 {finding.evidence_ids.join("、")}
									</small>
								</div>
							))
						) : (
							<p>报告已计算可见度与问题差距，但尚未把结论写入整改流程。进入“差距诊断”生成后即可转任务。</p>
						)}
						{report.tasks.length > 0 && (
							<table className="comparison-table task-report-table">
								<thead>
									<tr>
										<th>整改项</th>
										<th>优先级</th>
										<th>状态</th>
										<th>负责人</th>
										<th>发布与验收</th>
									</tr>
								</thead>
								<tbody>
									{report.tasks.map((task) => (
										<tr key={task.id}>
											<td>{task.title}</td>
											<td>{task.priority === "high" ? "高" : "中"}</td>
											<td>{task.status}</td>
											<td>{task.owner ?? "未分配"}</td>
											<td>{task.verified_snapshot_id ? "已验收" : task.published_url ? "待验收" : "未发布"}</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</div>
					<div className="report-section">
						<div className="report-title-row">
							<div>
								<span>{baselineBatch ? "09" : "08"}</span>
								<h2>真实业务结果</h2>
							</div>
							<small>与 AI 指标并列，不自动推断因果</small>
						</div>
						{report.attributionSummary.length ? (
							<div className="report-attribution">
								{report.attributionSummary.map((item) => (
									<div key={`${item.source_type}-${item.metric}`}>
										<span>{sourceLabels[item.source_type] ?? item.source_type}</span>
										<strong>{item.value.toLocaleString("zh-CN")}</strong>
										<b>{metricLabels[item.metric] ?? item.metric}</b>
										<small>
											{item.observations} 条真实观察 · 至 {date(item.last_observed_at)}
										</small>
									</div>
								))}
							</div>
						) : (
							<p className="muted">尚未导入 GA4、Search Console、表单或电话数据，本报告不声称已经带来访问或咨询。</p>
						)}
					</div>
					<div className="report-section">
						<div className="report-title-row">
							<div>
								<span>{baselineBatch ? "10" : "09"}</span>
								<h2>原始证据索引</h2>
							</div>
						</div>
						<table className="comparison-table evidence-index">
							<thead>
								<tr>
									<th>证据ID</th>
									<th>平台</th>
									<th>问题</th>
									<th>采样</th>
									<th>状态</th>
								</tr>
							</thead>
							<tbody>
								{batch.captures.map((capture) => (
									<tr key={capture.captureId}>
										<td>
											<code>{capture.captureId}</code>
										</td>
										<td>{providerLabel(capture.engine)}</td>
										<td>{capture.prompt}</td>
										<td>{capture.attempt}</td>
										<td>{capture.status}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<div className="report-section limitation">
						<h2>方法与局限</h2>
						<p>
							联网 API
							的模型、索引与搜索策略属于平台黑盒，并具有随机性。报告仅描述冻结模型、问题集、地区和采样窗口下的真实结果；API
							回答不等同于对应 App 页面回答，也不证明单一整改与排名变化之间的因果关系。
						</p>
					</div>
				</>
			) : (
				<div className="center">
					<IconLoader2 className="spin" />
					正在从真实证据生成报告
				</div>
			)}
		</section>
	);
}

function ProviderPanel({
	provider,
	draft,
	busy,
	update,
	runAction,
}: {
	provider: ProviderSetting;
	draft: ProviderDraft;
	busy: string | null;
	update(values: ProviderDraft): void;
	runAction(name: string, run: () => Promise<unknown>): Promise<void>;
}) {
	return (
		<article
			id="active-provider-panel"
			role="tabpanel"
			aria-labelledby={`provider-tab-${provider.providerId}`}
		>
			<header>
				<div>
					<span className="platform-logo">
						<img src={providerLogoPaths[provider.providerId]} alt="" aria-hidden="true" />
					</span>
					<div>
						<h3>{provider.label}</h3>
						<p>{provider.disclosure}</p>
					</div>
				</div>
				<label className="toggle-label">
					<input
						type="checkbox"
						checked={Boolean(draft.enabled)}
						onChange={(event) => update({ enabled: event.target.checked })}
					/>
					启用
				</label>
			</header>
			<div className="provider-contract">
				<code>{provider.protocol}</code>
				<span>搜索工具 {provider.searchToolVersion}</span>
				<span>密钥 {provider.configured ? "已配置" : "未配置"}</span>
				{provider.secondaryConfigured !== null ? (
					<span>混元密钥 {provider.secondaryConfigured ? "已配置" : "未配置"}</span>
				) : null}
			</div>
			<div className="provider-form">
				<label>
					模型
					<input value={String(draft.model ?? "")} onChange={(event) => update({ model: event.target.value })} />
				</label>
				<label>
					API 地址
					<input value={String(draft.endpoint ?? "")} onChange={(event) => update({ endpoint: event.target.value })} />
				</label>
				{provider.secondaryEndpoint !== null ? (
					<label>
						混元合成地址
						<input
							value={String(draft.secondaryEndpoint ?? "")}
							onChange={(event) => update({ secondaryEndpoint: event.target.value })}
						/>
					</label>
				) : null}
				<label>
					API Key
					<input
						type="password"
						value={draft.apiKey ?? ""}
						onChange={(event) => update({ apiKey: event.target.value })}
						placeholder={provider.configured ? "留空保持现有密钥" : "必填"}
					/>
				</label>
				{provider.secondaryConfigured !== null ? (
					<label>
						混元 API Key
						<input
							type="password"
							value={draft.secondaryApiKey ?? ""}
							onChange={(event) => update({ secondaryApiKey: event.target.value })}
							placeholder={provider.secondaryConfigured ? "留空保持现有密钥" : "必填"}
						/>
					</label>
				) : null}
			</div>
			<footer>
				<span className={`status ${provider.lastTestStatus ?? "idle"}`}>
					{provider.lastTestStatus ?? "未测试"} {provider.lastTestMessage ?? ""}
				</span>
				<div className="actions">
					<Button
						variant="secondary"
						busy={busy === `${provider.providerId}-test`}
						onClick={() =>
							runAction(`${provider.providerId}-test`, () =>
								post(`/api/settings/providers/${provider.providerId}/test`),
							)
						}
					>
						测试连接
					</Button>
					<Button
						busy={busy === `${provider.providerId}-save`}
						onClick={() =>
							runAction(`${provider.providerId}-save`, () =>
								put(`/api/settings/providers/${provider.providerId}`, {
									enabled: Boolean(draft.enabled),
									model: draft.model,
									endpoint: draft.endpoint,
									secondaryEndpoint: draft.secondaryEndpoint,
									...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
									...(draft.secondaryApiKey ? { secondaryApiKey: draft.secondaryApiKey } : {}),
									options: {},
								}),
							)
						}
					>
						保存平台
					</Button>
				</div>
			</footer>
		</article>
	);
}

function Settings() {
	const [providers, setProviders] = useState<ProviderSetting[]>([]);
	const [activeProviderId, setActiveProviderId] = useState<ProviderId>("deepseek_api");
	const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
	const [analysis, setAnalysis] = useState({ baseUrl: "https://hrouter.net/v1", model: "", configured: false });
	const [analysisKey, setAnalysisKey] = useState("");
	const [models, setModels] = useState<Array<{ id: string }>>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const load = useCallback(async () => {
		const value = await api<{
			providers: ProviderSetting[];
			analysis: { baseUrl: string; model: string | null; configured: boolean };
		}>("/api/settings");
		setProviders(value.providers);
		setActiveProviderId((current) =>
			value.providers.some((provider) => provider.providerId === current)
				? current
				: (value.providers[0]?.providerId ?? "deepseek_api"),
		);
		setDrafts(Object.fromEntries(value.providers.map((provider) => [provider.providerId, { ...provider }])));
		setAnalysis({ ...value.analysis, model: value.analysis.model ?? "" });
	}, []);
	useEffect(() => {
		void load().catch((reason) => setMessage(reason instanceof Error ? reason.message : "设置加载失败"));
	}, [load]);
	async function action(name: string, run: () => Promise<unknown>) {
		setBusy(name);
		setMessage(null);
		try {
			await run();
			setMessage("操作成功");
			await load();
		} catch (reason) {
			setMessage(reason instanceof Error ? reason.message : "操作失败");
		} finally {
			setBusy(null);
		}
	}
	function updateProvider(
		id: ProviderId,
		values: ProviderDraft,
	) {
		setDrafts((current) => ({ ...current, [id]: { ...current[id], ...values } }));
	}
	const activeProvider = providers.find((provider) => provider.providerId === activeProviderId) ?? providers[0];
	const activeDraft = activeProvider ? (drafts[activeProvider.providerId] ?? activeProvider) : null;
	function moveProviderFocus(offset: number): void {
		const currentIndex = providers.findIndex((provider) => provider.providerId === activeProviderId);
		const nextIndex = (currentIndex + offset + providers.length) % providers.length;
		const next = providers[nextIndex];
		if (!next) return;
		setActiveProviderId(next.providerId);
		window.requestAnimationFrame(() => document.getElementById(`provider-tab-${next.providerId}`)?.focus());
	}
	return (
		<section>
			<div className="overview-head">
				<div>
					<span className="eyebrow">平台设置</span>
					<h2>平台与 GPT 设置</h2>
					<p className="muted">
						五个平台使用云端联网 API；HRouter GPT 与 Pi Agent 只生成待审批草稿。密钥以主密钥信封加密保存。
					</p>
				</div>
				<Button variant="secondary" icon={<IconRefresh size={17} />} onClick={() => void load()}>
					刷新状态
				</Button>
			</div>
			{message && <Notice type={message === "操作成功" ? "success" : "error"} message={message} />}
			<div className="settings-band hrouter-settings">
				<div>
					<IconKey size={24} />
					<h3>HRouter GPT 分析模型</h3>
					<p>Pi SDK 通过受限领域工具调用管理员选定的 GPT。密钥：{analysis.configured ? "已配置" : "未配置"}</p>
				</div>
				<div className="key-form settings-form">
					<label>
						API 地址
						<input
							value={analysis.baseUrl}
							onChange={(event) => setAnalysis({ ...analysis, baseUrl: event.target.value })}
						/>
					</label>
					<label htmlFor="hrouter-model">
						GPT 模型
						{models.length ? (
							<select
								id="hrouter-model"
								value={analysis.model}
								onChange={(event) => setAnalysis({ ...analysis, model: event.target.value })}
							>
								<option value="">请选择</option>
								{models.map((item) => (
									<option value={item.id} key={item.id}>
										{item.id}
									</option>
								))}
							</select>
						) : (
							<input
								id="hrouter-model"
								value={analysis.model}
								onChange={(event) => setAnalysis({ ...analysis, model: event.target.value })}
								placeholder="gpt-*"
							/>
						)}
					</label>
					<label>
						API Key
						<input
							type="password"
							value={analysisKey}
							onChange={(event) => setAnalysisKey(event.target.value)}
							placeholder={analysis.configured ? "留空保持现有密钥" : "输入 HRouter API Key"}
						/>
					</label>
					<div className="actions">
						<Button
							busy={busy === "hrouter-save"}
							disabled={!analysis.model}
							onClick={() =>
								action("hrouter-save", () =>
									put("/api/settings/hrouter", {
										baseUrl: analysis.baseUrl,
										model: analysis.model,
										...(analysisKey ? { apiKey: analysisKey } : {}),
									}),
								)
							}
						>
							保存 GPT 配置
						</Button>
						<Button
							variant="secondary"
							busy={busy === "hrouter-models"}
							onClick={() =>
								action("hrouter-models", async () => {
									const result = await api<{ models: Array<{ id: string }> }>("/api/settings/hrouter/models");
									setModels(result.models);
								})
							}
						>
							读取可用 GPT
						</Button>
						<Button
							variant="secondary"
							busy={busy === "hrouter-test"}
							onClick={() => action("hrouter-test", () => post("/api/settings/hrouter/test"))}
						>
							测试连接
						</Button>
					</div>
				</div>
			</div>
			<div className="provider-settings">
				<nav className="provider-breadcrumb" aria-label="平台设置路径">
					<ol>
						<li>平台设置</li>
						<li>联网平台</li>
						<li aria-current="page">{activeProvider ? providerShortLabel(activeProvider.providerId) : "加载中"}</li>
					</ol>
				</nav>
				<div className="provider-tabs" role="tablist" aria-label="联网平台">
					{providers.map((provider) => (
						<button
							type="button"
							role="tab"
							id={`provider-tab-${provider.providerId}`}
							aria-controls="active-provider-panel"
							aria-selected={provider.providerId === activeProvider?.providerId}
							tabIndex={provider.providerId === activeProvider?.providerId ? 0 : -1}
							className={provider.providerId === activeProvider?.providerId ? "active" : ""}
							key={provider.providerId}
							onClick={() => setActiveProviderId(provider.providerId)}
							onKeyDown={(event) => {
								if (event.key === "ArrowRight" || event.key === "ArrowDown") {
									event.preventDefault();
									moveProviderFocus(1);
								}
								if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
									event.preventDefault();
									moveProviderFocus(-1);
								}
							}}
						>
							<img src={providerLogoPaths[provider.providerId]} alt="" aria-hidden="true" />
							<span>
								<strong>{providerShortLabel(provider.providerId)}</strong>
								<small>{provider.enabled ? "已启用" : provider.configured ? "已配置" : "未配置"}</small>
							</span>
							<i className={provider.lastTestStatus ?? "idle"} aria-hidden="true" />
						</button>
					))}
				</div>
				{activeProvider && activeDraft ? (
					<ProviderPanel
						provider={activeProvider}
						draft={activeDraft}
						busy={busy}
						update={(values) => updateProvider(activeProvider.providerId, values)}
						runAction={action}
					/>
				) : (
					<div className="chart-loading">
						<IconLoader2 className="spin" size={17} />
						<span>正在加载平台配置</span>
					</div>
				)}
			</div>
		</section>
	);
}

function Members({ localBypass }: { localBypass: boolean }) {
	return (
		<section>
			<div className="overview-head">
				<div>
					<span className="eyebrow">机构成员</span>
					<h2>角色与访问状态</h2>
					<p className="muted">管理员维护机构成员、角色和访问状态；成员停用后其现有会话会被撤销。</p>
				</div>
			</div>
			{localBypass ? (
				<div className="settings-band member-mode-note">
					<div>
						<IconKey size={24} />
						<h3>本机免登录开发模式</h3>
						<p>
							配置 GEO_ADMIN_EMAIL 和 GEO_ADMIN_PASSWORD
							后重启，即可启用管理员、分析师和只读成员管理。
						</p>
					</div>
				</div>
			) : (
				<UserManagement />
			)}
		</section>
	);
}

function AuditLogs() {
	return (
		<section>
			<div className="overview-head">
				<div>
					<span className="eyebrow">审计日志</span>
					<h2>写操作与审批记录</h2>
					<p className="muted">查看机构成员的写操作、审批、成员变更与平台设置记录。</p>
				</div>
			</div>
			<AuditLogPanel />
		</section>
	);
}

type AuditLogRow = {
	id: string;
	action: string;
	target_type: string;
	target_id: string | null;
	metadata: Record<string, unknown>;
	actor_email: string | null;
	created_at: string;
};
function AuditLogPanel() {
	const [logs, setLogs] = useState<AuditLogRow[]>([]);
	useEffect(() => {
		void api<{ logs: AuditLogRow[] }>("/api/audit-logs")
			.then((result) => setLogs(result.logs))
			.catch(() => setLogs([]));
	}, []);
	return (
		<div className="audit-log-panel">
			<p>保留最近 200 条成员写操作、审批和设置变更。</p>
			<div className="audit-log-list">
				{logs.slice(0, 50).map((log) => (
					<article key={log.id}>
						<time>{date(log.created_at)}</time>
						<b>{log.action}</b>
						<span>
							{log.actor_email ?? "系统"} · {log.target_type}
							{log.target_id ? ` · ${log.target_id}` : ""}
						</span>
						<code>{JSON.stringify(log.metadata)}</code>
					</article>
				))}
			</div>
		</div>
	);
}

type ManagedUser = {
	id: string;
	email: string;
	display_name: string;
	role: string;
	disabled_at: string | null;
	created_at: string;
};
function UserManagement() {
	const [users, setUsers] = useState<ManagedUser[]>([]);
	const [form, setForm] = useState({ email: "", displayName: "", role: "analyst", password: "" });
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(
		() => api<{ users: ManagedUser[] }>("/api/users").then((result) => setUsers(result.users)),
		[],
	);
	useEffect(() => {
		void load().catch(() => setUsers([]));
	}, [load]);
	async function create() {
		setError(null);
		try {
			await post("/api/users", form);
			setForm({ email: "", displayName: "", role: "analyst", password: "" });
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "成员创建失败");
		}
	}
	return (
		<div className="user-management">
			{error && <Notice type="error" message={error} />}
			<div className="user-create">
				<input
					type="email"
					placeholder="邮箱"
					value={form.email}
					onChange={(event) => setForm({ ...form, email: event.target.value })}
				/>
				<input
					placeholder="姓名"
					value={form.displayName}
					onChange={(event) => setForm({ ...form, displayName: event.target.value })}
				/>
				<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
					<option value="admin">管理员</option>
					<option value="analyst">分析师</option>
					<option value="viewer">只读</option>
				</select>
				<input
					type="password"
					placeholder="至少12位初始密码"
					value={form.password}
					onChange={(event) => setForm({ ...form, password: event.target.value })}
				/>
				<Button disabled={!form.email || !form.displayName || form.password.length < 12} onClick={create}>
					添加成员
				</Button>
			</div>
			<div className="user-list">
				{users.map((user) => (
					<article key={user.id}>
						<span className="member-avatar" aria-hidden="true">
							{user.display_name.slice(0, 1)}
						</span>
						<div>
							<b>{user.display_name}</b>
							<small>
								{user.email} · {user.role}
							</small>
						</div>
						<div className="user-row-side">
							<b className={user.disabled_at ? "user-status is-disabled" : "user-status"}>
								{user.disabled_at ? "已停用" : "有效"}
							</b>
							<Button
								variant="ghost"
								disabled={Boolean(user.disabled_at)}
								onClick={() => api(`/api/users/${user.id}`, { method: "DELETE" }).then(load)}
							>
								停用
							</Button>
						</div>
					</article>
				))}
			</div>
		</div>
	);
}
