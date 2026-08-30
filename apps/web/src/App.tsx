import {
	IconActivity,
	IconAlertTriangle,
	IconArrowLeft,
	IconBolt,
	IconBrandChrome,
	IconBuilding,
	IconChartLine,
	IconCheck,
	IconChevronRight,
	IconClipboardCheck,
	IconDatabase,
	IconDownload,
	IconFileAnalytics,
	IconFileText,
	IconGlobe,
	IconKey,
	IconLoader2,
	IconPlus,
	IconPrinter,
	IconRefresh,
	IconReportAnalytics,
	IconRoute,
	IconSearch,
	IconServer,
	IconSettings,
	IconShieldCheck,
	IconTrash,
	IconWorldSearch,
} from "@tabler/icons-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api, patch, post, put } from "./api";

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
type Prompt = { id?: string; question: string; intent: string; tags: string[] };
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
	kind: "baseline" | "retest";
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
	platforms: Array<"deepseek" | "kimi">;
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
	engine: "deepseek" | "kimi";
	attempt: number;
	status: string;
	answerText: string | null;
	sources: Source[];
	queryFanOut: string[];
	brandMatches: Array<{ brandId: string; matchedAlias: string; position: number }>;
	evidence: { screenshotObjectKey: string | null };
	failureMessage: string | null;
	capturedAt: string;
};
type PlatformMetrics = {
	totalCaptures: number;
	answeredCaptures: number;
	answerCoverage: number;
	brandMentionRate: number;
	firstRecommendationRate: number;
	citationRate: number;
	averageMentionPosition: number | null;
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
type CollectorNode = {
	id: string;
	name: string;
	version: string;
	capabilities: string[];
	last_seen_at: string | null;
	revoked_at: string | null;
	created_at: string;
};
type View =
	| "overview"
	| "monitor"
	| "evidence"
	| "audit"
	| "diagnosis"
	| "remediation"
	| "attribution"
	| "report"
	| "settings";

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

export function App() {
	const [projects, setProjects] = useState<ProjectSummary[]>([]);
	const [projectId, setProjectId] = useState<string | null>(null);
	const [project, setProject] = useState<Project | null>(null);
	const [view, setView] = useState<View>("overview");
	const [creating, setCreating] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const loadProjects = useCallback(async () => {
		try {
			const result = await api<{ projects: ProjectSummary[] }>("/api/projects");
			setProjects(result.projects);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "项目加载失败");
		} finally {
			setLoading(false);
		}
	}, []);
	const loadProject = useCallback(async () => {
		if (!projectId) return;
		try {
			setProject(await api<Project>(`/api/projects/${projectId}`));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "项目加载失败");
		}
	}, [projectId]);
	useEffect(() => {
		void loadProjects();
	}, [loadProjects]);
	useEffect(() => {
		void loadProject();
	}, [loadProject]);

	if (loading)
		return (
			<main className="center">
				<IconLoader2 className="spin" />
				<span>正在打开 GEO Console</span>
			</main>
		);
	if (!projectId)
		return (
			<ProjectHome
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
					<span className="brand-mark">G</span>
					<div>
						<strong>GEO Console</strong>
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
					{views.map((item) => (
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
					<div className="domain">
						<IconGlobe size={16} />
						{project?.domain ?? ""}
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
						{view === "overview" && <Overview project={project} onNavigate={setView} refresh={loadProject} />}
						{view === "monitor" && <Monitoring project={project} refresh={loadProject} />}
						{view === "evidence" && <Evidence project={project} />}
						{view === "audit" && <WebsiteAudit project={project} refresh={loadProject} />}
						{view === "diagnosis" && <Diagnosis project={project} refresh={loadProject} />}
						{view === "remediation" && <Remediation project={project} refresh={loadProject} />}
						{view === "attribution" && <Attribution project={project} />}
						{view === "report" && <Report project={project} />}
						{view === "settings" && <Settings />}
					</>
				)}
			</main>
		</div>
	);
}

function ProjectHome({
	projects,
	onOpen,
	onCreate,
	creating,
	onClose,
	onCreated,
	error,
}: {
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
					<span className="brand-mark">G</span>
					<div>
						<strong>GEO Console</strong>
						<small>真实 AI 可见度工作台</small>
					</div>
				</div>
				<Button icon={<IconPlus size={17} />} onClick={onCreate}>
					新建客户
				</Button>
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
			<div className="section-head">
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
						onClick={() => setPrompts([...prompts, { question: "", intent: "购买决策", tags: [] }])}
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

function Overview({
	project,
	onNavigate,
	refresh,
}: {
	project: Project;
	onNavigate(view: View): void;
	refresh(): Promise<void>;
}) {
	const latest = project.batches[0];
	const [editingScope, setEditingScope] = useState(false);
	return (
		<section>
			<div className="workflow">
				<button type="button" onClick={() => onNavigate("monitor")}>
					<span>01</span>
					<IconActivity />
					<strong>建立基线</strong>
					<small>DeepSeek / Kimi</small>
				</button>
				<i />
				<button type="button" onClick={() => onNavigate("evidence")}>
					<span>02</span>
					<IconDatabase />
					<strong>检查证据</strong>
					<small>回答、来源、截图</small>
				</button>
				<i />
				<button type="button" onClick={() => onNavigate("diagnosis")}>
					<span>03</span>
					<IconSearch />
					<strong>诊断差距</strong>
					<small>仅基于证据ID</small>
				</button>
				<i />
				<button type="button" onClick={() => onNavigate("remediation")}>
					<span>04</span>
					<IconClipboardCheck />
					<strong>整改发布</strong>
					<small>真实URL验收</small>
				</button>
				<i />
				<button type="button" onClick={() => onNavigate("report")}>
					<span>05</span>
					<IconReportAnalytics />
					<strong>同条件复测</strong>
					<small>前后变化报告</small>
				</button>
			</div>
			<div className="overview-grid">
				<div className="plain-section">
					<span className="eyebrow">客户画像</span>
					<div className="overview-title">
						<h2>{project.name}</h2>
						<Button variant="secondary" icon={<IconSettings size={16} />} onClick={() => setEditingScope(true)}>
							编辑监测范围
						</Button>
					</div>
					<p>{String(project.profile?.businessSummary ?? "官网分析已完成，画像详情以已保存的真实分析结果为准。")}</p>
					<dl className="facts">
						<div>
							<dt>官网</dt>
							<dd>
								<a href={project.website_url} target="_blank" rel="noreferrer">
									{project.domain}
								</a>
							</dd>
						</div>
						<div>
							<dt>地区 / 语言</dt>
							<dd>
								{project.region} · {project.language}
							</dd>
						</div>
						<div>
							<dt>监测问题</dt>
							<dd>{project.prompts.length}</dd>
						</div>
						<div>
							<dt>竞品</dt>
							<dd>{project.competitors.length}</dd>
						</div>
					</dl>
				</div>
				<div className="plain-section">
					<span className="eyebrow">当前状态</span>
					<h2>{latest ? `最近批次：${latest.status}` : "等待建立首个基线"}</h2>
					<p>
						{latest
							? `创建于 ${date(latest.created_at)}。进入 AI 监测查看有效样本和失败样本。`
							: "建档已经确认。下一步创建基线，Collector 才会向真实页面逐题提问。"}
					</p>
					<Button onClick={() => onNavigate("monitor")} icon={<IconChevronRight size={17} />}>
						{latest ? "查看监测" : "建立基线"}
					</Button>
				</div>
			</div>
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
							onClick={() => setPrompts([...prompts, { question: "", intent: "购买决策", tags: [] }])}
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

function Monitoring({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [selected, setSelected] = useState(project.batches[0]?.id ?? null);
	const [batch, setBatch] = useState<Batch | null>(null);
	const [trends, setTrends] = useState<TrendResponse | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [runPlatforms, setRunPlatforms] = useState<Array<"deepseek" | "kimi">>(["deepseek", "kimi"]);
	const [runRepeats, setRunRepeats] = useState(3);
	const [scheduleEnabled, setScheduleEnabled] = useState(project.monitoringSchedule?.enabled ?? false);
	const [frequencyDays, setFrequencyDays] = useState(project.monitoringSchedule?.frequency_days ?? 7);
	const [schedulePlatforms, setSchedulePlatforms] = useState<Array<"deepseek" | "kimi">>(
		project.monitoringSchedule?.platforms?.length ? project.monitoringSchedule.platforms : ["deepseek", "kimi"],
	);
	const [scheduleRepeats, setScheduleRepeats] = useState(project.monitoringSchedule?.repeats ?? 3);
	const load = useCallback(async () => {
		if (selected) setBatch(await api<Batch>(`/api/batches/${selected}`));
	}, [selected]);
	useEffect(() => {
		void load();
		if (selected)
			api<TrendResponse>(`/api/projects/${project.id}/trends/${selected}`)
				.then(setTrends)
				.catch(() => setTrends(null));
		const timer = window.setInterval(() => void load(), 8000);
		return () => window.clearInterval(timer);
	}, [load, project.id, selected]);
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
	async function create(kind: "baseline" | "retest") {
		setBusy(true);
		setError(null);
		try {
			const result = await post<{ id: string }>(
				`/api/projects/${project.id}/batches`,
				kind === "baseline"
					? { kind, platforms: runPlatforms, repeats: runRepeats }
					: { kind, compareToBatchId: selected },
			);
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
			<div className="section-head">
				<div>
					<h2>真实 AI 监测</h2>
					<p>默认每题每平台重复 3 次。失败样本保留并计入失败率。</p>
				</div>
				<div className="actions">
					<div className="run-config">
						{(["deepseek", "kimi"] as const).map((platform) => (
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
								{platform === "deepseek" ? "DeepSeek" : "Kimi"}
							</label>
						))}
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
					<Button variant="secondary" busy={busy} onClick={() => create("retest")} disabled={!selected}>
						按此条件复测
					</Button>
					<Button
						busy={busy}
						disabled={!runPlatforms.length}
						icon={<IconPlus size={17} />}
						onClick={() => create("baseline")}
					>
						新建基线
					</Button>
				</div>
			</div>
			{error && <Notice type="error" message={error} />}
			<div className="schedule-band">
				<div>
					<IconChartLine size={24} />
					<h3>周期监测</h3>
					<p>
						Worker 到期后自动冻结问题并创建真实采集批次；Collector 和登录会话必须在线。下一次运行：
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
						{(["deepseek", "kimi"] as const).map((platform) => (
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
								{platform === "deepseek" ? "DeepSeek" : "Kimi"}
							</label>
						))}
					</div>
					<Button variant="secondary" busy={busy} disabled={!schedulePlatforms.length} onClick={saveSchedule}>
						保存计划
					</Button>
				</div>
			</div>
			{project.batches.length === 0 ? (
				<Empty
					title="还没有采集批次"
					detail="先确认 DeepSeek 和 Kimi 已登录，再创建基线。Collector 会按冻结问题集开始真实采集。"
				/>
			) : (
				<>
					<div className="batch-strip">
						{project.batches.map((item) => (
							<button
								type="button"
								className={selected === item.id ? "active" : ""}
								key={item.id}
								onClick={() => setSelected(item.id)}
							>
								<span>{item.kind === "baseline" ? "基线" : "复测"}</span>
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
		</div>
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
							<strong>{platform === "deepseek" ? "DeepSeek" : "Kimi"}</strong>
							<span>
								{metrics.answeredCaptures}/{metrics.totalCaptures} 有回答
							</span>
						</header>
						<dl>
							<div>
								<dt>回答覆盖率</dt>
								<dd>{percentage(metrics.answerCoverage)}</dd>
							</div>
							<div>
								<dt>品牌提及率</dt>
								<dd>{percentage(metrics.brandMentionRate)}</dd>
							</div>
							<div>
								<dt>首位推荐率</dt>
								<dd>{percentage(metrics.firstRecommendationRate)}</dd>
							</div>
							<div>
								<dt>官网引用率</dt>
								<dd>{percentage(metrics.citationRate)}</dd>
							</div>
							<div>
								<dt>平均提及位置</dt>
								<dd>{metrics.averageMentionPosition?.toFixed(1) ?? "-"}</dd>
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
					{batch.kind === "baseline" ? "基线" : "复测"} · {date(batch.created_at)} · {batch.status}
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
			"截图",
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
			capture.evidence.screenshotObjectKey ? `/artifacts/${capture.evidence.screenshotObjectKey}` : "",
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
		return <Empty title="还没有证据" detail="完成至少一个真实采集批次后，回答、来源和截图会出现在这里。" />;
	return (
		<section>
			<div className="section-head">
				<div>
					<h2>原始证据索引</h2>
					<p>原始回答与截图写入后不可修改；解析规则可版本化重算。</p>
				</div>
				<div className="filters">
					<BatchPicker project={project} selected={selected} setSelected={setSelected} />
					<select value={platform} onChange={(event) => setPlatform(event.target.value)}>
						<option value="all">全部平台</option>
						<option value="deepseek">DeepSeek</option>
						<option value="kimi">Kimi</option>
					</select>
					<Button variant="secondary" icon={<IconDownload size={16} />} disabled={!captures.length} onClick={exportCsv}>
						导出证据 CSV
					</Button>
				</div>
			</div>
			{captures.length === 0 ? (
				<Empty title="批次尚无采集结果" detail="Collector 可能仍在运行，或平台登录状态需要处理。" />
			) : (
				<div className="evidence-list">
					{captures.map((capture) => (
						<article className="evidence-item" key={capture.captureId}>
							<header>
								<div>
									<span className={`platform ${capture.engine}`}>
										{capture.engine === "deepseek" ? "DeepSeek" : "Kimi"}
									</span>
									<strong>{capture.prompt}</strong>
								</div>
								<span className={`status ${capture.status}`}>{capture.status}</span>
							</header>
							<div className="evidence-meta">
								第 {capture.attempt} 次采样 · {date(capture.capturedAt)} · 证据ID {capture.captureId}
							</div>
							{capture.answerText ? (
								<p className="answer">{capture.answerText}</p>
							) : (
								<Notice type="error" message={capture.failureMessage ?? "本次采集没有回答"} />
							)}
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
							{capture.evidence.screenshotObjectKey && (
								<a
									className="screenshot-link"
									href={`/artifacts/${capture.evidence.screenshotObjectKey}`}
									target="_blank"
									rel="noreferrer"
								>
									<IconBrandChrome size={16} />
									查看全页截图
								</a>
							)}
						</article>
					))}
				</div>
			)}
		</section>
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
			<div className="section-head">
				<div>
					<h2>官网 GEO 技术审计</h2>
					<p>检查 AI 与搜索系统能否稳定读取官网，以及页面是否提供可理解、可引用的实体和事实结构。</p>
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
					<div className="audit-summary">
						<div className={`audit-score ${audit.result.verdict}`}>
							<strong>{audit.result.score}</strong>
							<span>/ 100</span>
						</div>
						<div>
							<span className="eyebrow">最新审计 · {date(audit.result.checkedAt)}</span>
							<h3>
								{audit.result.verdict === "ready"
									? "官网读取基础完整"
									: audit.result.verdict === "blocked"
										? "官网存在读取阻断"
										: "官网可读取，但存在重要缺口"}
							</h3>
							<p>
								HTTPS {audit.result.transport.https.ok ? "正常" : "异常"} · Sitemap{" "}
								{audit.result.discovery.sitemap.urlCount} 个 URL · JSON-LD{" "}
								{audit.result.homepage.structuredDataTypes.length || 0} 类
							</p>
							<small>审计证据 ID：{audit.id}</small>
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
						{audit.result.checks.map((check) => (
							<div className="audit-check" key={check.id}>
								<span className={`check-state ${check.status}`}>
									{check.status === "pass"
										? "通过"
										: check.status === "fail"
											? "失败"
											: check.status === "warning"
												? "警告"
												: "参考"}
								</span>
								<b>{check.label}</b>
								<p>{check.detail}</p>
								<code>{check.id}</code>
							</div>
						))}
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
	const findings = project.findings.filter((item) => item.batch_id === selected);
	async function run(enhanceWithModel = false) {
		if (!selected) return;
		setBusy(enhanceWithModel ? "model" : "rules");
		setError(null);
		try {
			await post(`/api/batches/${selected}/diagnose${enhanceWithModel ? "/model" : ""}`);
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
			<div className="section-head">
				<div>
					<h2>证据约束诊断</h2>
					<p>确定性规则先输出可复核差距；模型增强只能使用已存在的证据 ID，且不是完成诊断的前置条件。</p>
				</div>
				<div className="actions">
					<BatchPicker project={project} selected={selected} setSelected={setSelected} />
					<Button variant="secondary" busy={busy === "model"} onClick={() => run(true)}>
						DeepSeek 证据增强
					</Button>
					<Button busy={busy === "rules"} icon={<IconSearch size={17} />} onClick={() => run()}>
						生成证据诊断
					</Button>
				</div>
			</div>
			{error && <Notice type="error" message={error} />}
			{findings.length === 0 ? (
				<Empty
					title="这个批次还没有诊断"
					detail="采集完成后可直接运行证据规则；没有模型密钥也能生成真实诊断和整改任务。"
				/>
			) : (
				<div className="finding-list">
					{findings.map((finding) => (
						<article className="finding" key={finding.id}>
							<div className="finding-score">
								{Math.round(finding.confidence * 100)}
								<small>%证据充分度</small>
							</div>
							<div>
								<span className="eyebrow">{finding.category}</span>
								<h3>{finding.title}</h3>
								<p>{finding.detail}</p>
								<div className="recommendation">
									<b>整改建议</b>
									{finding.recommendation}
								</div>
								<small>关联证据：{finding.evidence_ids.join("、")}</small>
							</div>
						</article>
					))}
				</div>
			)}
		</section>
	);
}

function Remediation({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const latestBatch = project.batches[0]?.id;
	async function call(id: string, action: () => Promise<unknown>) {
		setBusy(id);
		setError(null);
		try {
			await action();
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "操作失败");
		} finally {
			setBusy(null);
		}
	}
	return (
		<section>
			<div className="section-head">
				<div>
					<h2>整改任务</h2>
					<p>初稿需要人工审核；发布后填写真实 URL，系统重新抓取页面完成验收。</p>
				</div>
				<Button
					disabled={!latestBatch}
					busy={busy === "create"}
					icon={<IconPlus size={17} />}
					onClick={() =>
						latestBatch &&
						call("create", () => post(`/api/projects/${project.id}/tasks/from-findings`, { batchId: latestBatch }))
					}
				>
					从最新诊断建任务
				</Button>
			</div>
			{error && <Notice type="error" message={error} />}
			{project.tasks.length === 0 ? (
				<Empty title="还没有整改任务" detail="先完成诊断，再把有证据的结论转换为可跟踪任务。" />
			) : (
				<div className="task-list">
					{project.tasks.map((task) => (
						<TaskItem key={task.id} task={task} busy={busy === task.id} act={(action) => call(task.id, action)} />
					))}
				</div>
			)}
		</section>
	);
}

function TaskItem({ task, busy, act }: { task: Task; busy: boolean; act(action: () => Promise<unknown>): void }) {
	const [url, setUrl] = useState(task.published_url ?? "");
	const [owner, setOwner] = useState(task.owner ?? "");
	const [dueDate, setDueDate] = useState(task.due_date ? task.due_date.slice(0, 10) : "");
	return (
		<article className="task">
			<header>
				<div>
					<span className={`priority ${task.priority}`}>{task.priority === "high" ? "高优先级" : "中优先级"}</span>
					<h3>{task.title}</h3>
				</div>
				<div className="task-header-actions">
					<select
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
			</header>
			<p>{task.detail}</p>
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
					生成简报和初稿
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
			<div className="section-head">
				<div>
					<h2>真实业务归因</h2>
					<p>汇总 GA4、Search Console、表单、电话和业务台账，检查 AI 可见度之外是否出现真实访问与咨询。</p>
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
					<div className="attribution-summary">
						{data.summary.map((item) => (
							<div key={`${item.source_type}-${item.metric}`}>
								<span>{sourceLabels[item.source_type] ?? item.source_type}</span>
								<strong>{item.value.toLocaleString("zh-CN")}</strong>
								<b>{metricLabels[item.metric] ?? item.metric}</b>
								<small>
									{item.observations} 条观察 · 至 {date(item.last_observed_at)}
								</small>
							</div>
						))}
					</div>
					<div className="attribution-columns">
						<div>
							<h3>最近业务观察</h3>
							<table className="comparison-table">
								<thead>
									<tr>
										<th>日期</th>
										<th>来源</th>
										<th>指标</th>
										<th>数值</th>
										<th>落地页 / 渠道</th>
									</tr>
								</thead>
								<tbody>
									{data.events.map((event) => (
										<tr key={event.id}>
											<td>{date(event.observed_at)}</td>
											<td>{sourceLabels[event.source_type] ?? event.source_type}</td>
											<td>{metricLabels[event.metric] ?? event.metric}</td>
											<td>{event.value.toLocaleString("zh-CN")}</td>
											<td>{event.landing_url ?? event.channel ?? "-"}</td>
										</tr>
									))}
								</tbody>
							</table>
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

// The printable document stays in one component so its section numbering and conditional retest blocks remain auditable.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: report composition intentionally mirrors the printed document
function Report({ project }: { project: Project }) {
	const { selected, setSelected, batch } = useBatch(project);
	const [baselineBatch, setBaselineBatch] = useState<Batch | null>(null);
	const [report, setReport] = useState<ReportPayload | null>(null);
	const [reportError, setReportError] = useState<string | null>(null);
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
	const overall = batch?.metrics.overall;
	return (
		<section className="report">
			<div className="section-head no-print">
				<div>
					<h2>中文效果报告</h2>
					<p>可使用浏览器打印为 PDF。报告保留样本数、失败率和黑盒局限。</p>
				</div>
				<div className="actions">
					<BatchPicker project={project} selected={selected} setSelected={setSelected} />
					<Button
						variant="secondary"
						icon={<IconDownload size={17} />}
						disabled={!report}
						onClick={() =>
							report &&
							downloadText(
								`${project.name}-${selected ?? "报告"}.json`,
								JSON.stringify({ ...report, batch }, null, 2),
								"application/json;charset=utf-8",
							)
						}
					>
						导出 JSON
					</Button>
					<Button icon={<IconPrinter size={17} />} onClick={() => window.print()}>
						打印 / 导出PDF
					</Button>
				</div>
			</div>
			{reportError && <Notice type="error" message={reportError} />}
			{batch && analysis ? (
				<>
					<header className="report-cover">
						<span>真实消费端 GEO 可见度报告</span>
						<h1>{project.name}</h1>
						<p>
							{batch.kind === "retest" ? "同条件复测" : "基线监测"} · {date(batch.created_at)}
						</p>
					</header>
					<div className="executive-summary">
						<div>
							<span className="eyebrow">管理层摘要</span>
							<h2>{analysis.executive.headline}</h2>
							<p>{analysis.executive.summary}</p>
						</div>
						<div className={`evidence-level level-${analysis.executive.evidenceLevel}`}>
							<span>证据等级</span>
							<strong>{analysis.executive.evidenceLevel}</strong>
						</div>
					</div>
					<p className="validity-note">{analysis.executive.validityNote}</p>
					<div className="report-kpis">
						<div>
							<span>品牌提及率</span>
							<strong>{percentage(overall?.brandMentionRate as number | undefined)}</strong>
						</div>
						<div>
							<span>首位推荐率</span>
							<strong>{percentage(overall?.firstRecommendationRate as number | undefined)}</strong>
						</div>
						<div>
							<span>官网引用率</span>
							<strong>{percentage(overall?.citationRate as number | undefined)}</strong>
						</div>
						<div>
							<span>平均提及位置</span>
							<strong>
								{typeof overall?.averageMentionPosition === "number" ? overall.averageMentionPosition.toFixed(1) : "-"}
							</strong>
						</div>
						<div>
							<span>有效样本</span>
							<strong>
								{batch.metrics.validSamples}/{batch.metrics.expectedSamples}
							</strong>
						</div>
					</div>
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
											<small>{source.isOwned ? "客户官网" : `${source.promptCount} 个问题`}</small>
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
												<td>{platform === "deepseek" ? "DeepSeek" : "Kimi"}</td>
												<td>{label}</td>
												<td>{percentage(before?.[key])}</td>
												<td>{percentage(after?.[key])}</td>
												<td className={(after?.[key] ?? 0) - (before?.[key] ?? 0) >= 0 ? "positive" : "negative"}>
													{before && after ? `${((after[key] - before[key]) * 100).toFixed(1)} 个百分点` : "-"}
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
										<td>{capture.engine === "deepseek" ? "DeepSeek" : "Kimi"}</td>
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
							AI消费端答案和联网搜索属于平台黑盒，并具有随机性。报告仅描述本批次真实样本中的品牌提及、引用和位置变化，不证明单一整改与排名变化之间的因果关系，也不承诺固定推荐位置。
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

function Settings() {
	const [configured, setConfigured] = useState(false);
	const [model, setModel] = useState("");
	const [key, setKey] = useState("");
	const [statuses, setStatuses] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [nodes, setNodes] = useState<CollectorNode[]>([]);
	const [nodeName, setNodeName] = useState("");
	const [newNodeToken, setNewNodeToken] = useState<string | null>(null);
	const load = useCallback(async () => {
		const [value, nodeResult] = await Promise.all([
			api<{ deepseek: { configured: boolean; model: string } }>("/api/settings"),
			api<{ nodes: CollectorNode[] }>("/api/collector-nodes"),
		]);
		setConfigured(value.deepseek.configured);
		setModel(value.deepseek.model);
		setNodes(nodeResult.nodes);
		try {
			const collector = await api<{ platforms: Record<string, string> }>("/collector/status");
			setStatuses(collector.platforms);
		} catch {
			setStatuses({ deepseek: "collector_offline", kimi: "collector_offline" });
		}
	}, []);
	useEffect(() => {
		void load();
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
	return (
		<section>
			<div className="section-head">
				<div>
					<h2>平台与模型设置</h2>
					<p>API Key 只用于分析和内容生成；真实回答由本机浏览器页面采集。</p>
				</div>
				<Button variant="secondary" icon={<IconRefresh size={17} />} onClick={() => load()}>
					刷新状态
				</Button>
			</div>
			{message && <Notice type={message === "操作成功" ? "success" : "error"} message={message} />}
			<div className="settings-band">
				<div>
					<IconKey size={24} />
					<h3>DeepSeek 分析模型</h3>
					<p>
						当前模型：<code>{model || "读取中"}</code>
						<br />
						密钥状态：{configured ? "已配置" : "未配置"}
					</p>
				</div>
				<div className="key-form">
					<input
						type="password"
						value={key}
						onChange={(event) => setKey(event.target.value)}
						placeholder="输入新的 DeepSeek API Key"
					/>
					<Button
						busy={busy === "save"}
						onClick={() => action("save", () => put("/api/settings/deepseek", { apiKey: key }))}
					>
						保存到系统密钥库
					</Button>
					<Button
						variant="secondary"
						busy={busy === "test"}
						onClick={() => action("test", () => post("/api/settings/deepseek/test"))}
					>
						测试连接
					</Button>
				</div>
			</div>
			<div className="platform-settings">
				{(["deepseek", "kimi"] as const).map((platform) => (
					<article key={platform}>
						<div className={`platform-logo ${platform}`}>{platform === "deepseek" ? "D" : "K"}</div>
						<div>
							<h3>{platform === "deepseek" ? "DeepSeek 真实页面" : "Kimi 真实页面"}</h3>
							<p>
								浏览器状态：<b>{statuses[platform] ?? "检查中"}</b>。Cookie 仅保存在本机专用 Profile。
							</p>
						</div>
						<Button
							variant="secondary"
							icon={<IconBrandChrome size={17} />}
							busy={busy === platform}
							onClick={() => action(platform, () => post(`/collector/login/${platform}`))}
						>
							打开登录页
						</Button>
					</article>
				))}
			</div>
			<div className="collector-settings">
				<div>
					<IconServer size={24} />
					<h3>Collector 节点</h3>
					<p>服务器可配对独立采集机。节点令牌只显示一次；平台 Cookie 仍只保存在采集机。</p>
				</div>
				<div>
					<div className="node-create">
						<input value={nodeName} onChange={(event) => setNodeName(event.target.value)} placeholder="采集机名称" />
						<Button
							variant="secondary"
							busy={busy === "node-create"}
							disabled={!nodeName.trim()}
							onClick={() =>
								action("node-create", async () => {
									const created = await post<{ id: string; token: string }>("/api/collector-nodes", {
										name: nodeName,
									});
									setNewNodeToken(created.token);
									setNodeName("");
								})
							}
						>
							创建配对令牌
						</Button>
					</div>
					{newNodeToken && (
						<div className="pairing-token">
							<b>只显示一次，请配置为采集机的 GEO_COLLECTOR_TOKEN</b>
							<code>{newNodeToken}</code>
						</div>
					)}
					<div className="collector-node-list">
						{nodes.map((node) => {
							const live =
								!node.revoked_at &&
								Boolean(node.last_seen_at && Date.now() - new Date(node.last_seen_at).getTime() < 90_000);
							return (
								<article key={node.id}>
									<span className={node.revoked_at ? "node-state revoked" : live ? "node-state live" : "node-state"}>
										{node.revoked_at ? "已撤销" : live ? "在线" : "离线"}
									</span>
									<div>
										<b>{node.name}</b>
										<small>
											{node.capabilities.join(" / ")} · v{node.version} · 最近心跳 {date(node.last_seen_at)}
										</small>
									</div>
									<Button
										variant="ghost"
										disabled={Boolean(node.revoked_at)}
										busy={busy === node.id}
										onClick={() => action(node.id, () => api(`/api/collector-nodes/${node.id}`, { method: "DELETE" }))}
									>
										撤销
									</Button>
								</article>
							);
						})}
					</div>
				</div>
			</div>
		</section>
	);
}
