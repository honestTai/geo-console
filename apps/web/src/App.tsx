import {
	IconActivity,
	IconArticle,
	IconBook2,
	IconBuilding,
	IconBuildingCommunity,
	IconClipboardCheck,
	IconDatabase,
	IconHistory,
	IconLoader2,
	IconLockAccess,
	IconReportAnalytics,
	IconRoute,
	IconSearch,
	IconSettings,
	IconShieldCheck,
	IconSparkles,
	IconUsers,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AccessContext, hasPermission } from "./access";
import { ApiError, api, post } from "./api";
import { AccountControl, Login } from "./components/Login";
import { ManagementWorkspace } from "./components/Management";
import { ProjectHome } from "./components/ProjectHome";
import { AppShell, type ShellNavigationItem } from "./components/Shell";
import { ViewBoundary } from "./components/ViewBoundary";
import { WebsiteAudit } from "./components/WebsiteAudit";
import {
	Articles,
	Attribution,
	AuditLogs,
	Diagnosis,
	Evidence,
	KnowledgeBase,
	Members,
	Monitoring,
	Onboarding,
	OrganizationManagement,
	Overview,
	RbacManagement,
	Remediation,
	Report,
	ServiceLogs,
	Settings,
	Workbench,
} from "./lazy-views";
import {
	DEFAULT_PAGE_SIZE,
	managementViews,
	type NavigationItem,
	type Paginated,
	type Project,
	type ProjectSummary,
	type UserIdentity,
	type View,
} from "./types";
import { type EvidenceFocus, NavigationContext, type WorkspaceNavigation } from "./ui/navigation";

const views: Array<{ id: View; label: string; icon: typeof IconActivity }> = [
	{ id: "workbench", label: "AI 工作台", icon: IconSparkles },
	{ id: "overview", label: "项目总览", icon: IconBuilding },
	{ id: "monitor", label: "AI 监测", icon: IconActivity },
	{ id: "evidence", label: "证据中心", icon: IconDatabase },
	{ id: "audit", label: "官网审计", icon: IconShieldCheck },
	{ id: "diagnosis", label: "差距诊断", icon: IconSearch },
	{ id: "remediation", label: "整改中心", icon: IconClipboardCheck },
	{ id: "attribution", label: "业务归因", icon: IconRoute },
	{ id: "report", label: "复测报告", icon: IconReportAnalytics },
	{ id: "articles", label: "优化文章", icon: IconArticle },
	{ id: "knowledge", label: "问题知识库", icon: IconBook2 },
	{ id: "settings", label: "平台设置", icon: IconSettings },
	{ id: "members", label: "机构成员", icon: IconUsers },
	{ id: "auditLogs", label: "审计日志", icon: IconHistory },
	{ id: "serviceLogs", label: "运行日志", icon: IconActivity },
	{ id: "rbac", label: "权限配置", icon: IconLockAccess },
	{ id: "organizations", label: "多租户管理", icon: IconBuildingCommunity },
];
const navigationIcons: Record<string, typeof IconActivity> = {
	activity: IconActivity,
	article: IconArticle,
	sparkles: IconSparkles,
	book: IconBook2,
	building: IconBuilding,
	checklist: IconClipboardCheck,
	database: IconDatabase,
	history: IconHistory,
	lock: IconLockAccess,
	organizations: IconBuildingCommunity,
	report: IconReportAnalytics,
	route: IconRoute,
	search: IconSearch,
	settings: IconSettings,
	shield: IconShieldCheck,
	users: IconUsers,
};
const projectPagePermissions = [
	"page.workbench",
	"page.overview",
	"page.monitor",
	"page.evidence",
	"page.audit",
	"page.diagnosis",
	"page.remediation",
	"page.attribution",
	"page.report",
	"page.articles",
];

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Top-level application state keeps authentication and project navigation transitions atomic.
export function App() {
	const [user, setUser] = useState<UserIdentity | null>(null);
	const [authReady, setAuthReady] = useState(false);
	const [navigation, setNavigation] = useState<NavigationItem[]>([]);
	const [projects, setProjects] = useState<ProjectSummary[]>([]);
	const [projectPagination, setProjectPagination] = useState<Paginated<ProjectSummary>>({
		items: [],
		page: 1,
		pageSize: DEFAULT_PAGE_SIZE,
		total: 0,
		totalPages: 1,
	});
	const [projectSearch, setProjectSearch] = useState("");
	const [projectId, setProjectId] = useState<string | null>(null);
	const [project, setProject] = useState<Project | null>(null);
	const [view, setView] = useState<View>("overview");
	const [creating, setCreating] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [evidenceFocus, setEvidenceFocus] = useState<EvidenceFocus>(null);
	const [batchFocus, setBatchFocus] = useState<string | null>(null);
	const [workbenchDraft, setWorkbenchDraft] = useState<string | null>(null);
	const availableViews = useMemo(
		() =>
			navigation
				.map((item) => {
					const registered = views.find((viewItem) => viewItem.id === item.navigation_key);
					const entry: ShellNavigationItem | null = registered
						? {
								...registered,
								label: item.label,
								icon: navigationIcons[item.icon_key] ?? registered.icon,
								group: item.group_label,
							}
						: null;
					return entry;
				})
				.filter((item): item is ShellNavigationItem => item !== null),
		[navigation],
	);
	const workspaceNavigation = useMemo<WorkspaceNavigation>(
		() => ({
			openView: setView,
			openProjectList: () => {
				setProjectId(null);
				setProject(null);
			},
			panelViews: availableViews
				.filter((item) => !managementViews.includes(item.id))
				.map((item) => ({ id: item.id, label: item.label })),
			openEvidence: (evidenceId, batchId = null, kind = "capture") => {
				setEvidenceFocus({ evidenceId, batchId, kind });
				setView("evidence");
			},
			openBatch: (batchId) => {
				setBatchFocus(batchId);
				setView("monitor");
			},
			openWorkbench: (message) => {
				setWorkbenchDraft(message ?? null);
				setView("workbench");
			},
		}),
		[availableViews],
	);

	const loadProjects = useCallback(async () => {
		if (!user) return;
		const canReadProjects =
			user.isSuperAdmin || projectPagePermissions.some((permission) => user.permissions.includes(permission));
		if (!canReadProjects) {
			setProjects([]);
			setLoading(false);
			return;
		}
		try {
			const params = new URLSearchParams({
				page: String(projectPagination.page),
				pageSize: String(projectPagination.pageSize),
			});
			if (projectSearch.trim()) params.set("search", projectSearch.trim());
			const result = await api<Paginated<ProjectSummary>>(`/api/projects?${params}`);
			setProjects(result.items);
			setProjectPagination(result);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "项目加载失败");
		} finally {
			setLoading(false);
		}
	}, [projectPagination.page, projectPagination.pageSize, projectSearch, user]);
	const loadNavigation = useCallback(async () => {
		if (!user) return;
		try {
			const result = await api<{ items: NavigationItem[] }>("/api/rbac/navigation");
			setNavigation(result.items);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "导航权限加载失败");
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
		void loadNavigation();
	}, [loadNavigation]);
	const signedInId = user?.id;
	useEffect(() => {
		if (!signedInId) return;
		const controller = new AbortController();
		let pending = false;
		const refreshIdentity = async () => {
			if (pending || document.visibilityState === "hidden") return;
			pending = true;
			try {
				const result = await api<{ user: UserIdentity }>("/api/auth/me", { signal: controller.signal });
				if (controller.signal.aborted) return;
				setUser((current) => (JSON.stringify(current) === JSON.stringify(result.user) ? current : result.user));
			} catch (reason) {
				if (!controller.signal.aborted && reason instanceof ApiError && reason.status === 401) {
					setUser(null);
					setNavigation([]);
					setProjectId(null);
					setProject(null);
				}
			} finally {
				pending = false;
			}
		};
		const timer = window.setInterval(() => void refreshIdentity(), 15_000);
		const onFocus = () => void refreshIdentity();
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onFocus);
		return () => {
			controller.abort();
			clearInterval(timer);
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onFocus);
		};
	}, [signedInId]);
	useEffect(() => {
		if (!user || !projectId) return;
		if (
			(project && project.organization_id !== undefined && project.organization_id !== user.organizationId) ||
			(!user.isSuperAdmin && !projectPagePermissions.some((permission) => user.permissions.includes(permission))) ||
			(!user.allProjects && !user.projectIds.includes(projectId))
		) {
			setProjectId(null);
			setProject(null);
		}
	}, [user, projectId, project]);
	useEffect(() => {
		void loadProjects();
	}, [loadProjects]);
	useEffect(() => {
		void loadProject();
	}, [loadProject]);
	useEffect(() => {
		if (availableViews.length && !availableViews.some((item) => item.id === view))
			setView(availableViews[0]?.id ?? "overview");
	}, [availableViews, view]);
	// 切换业务视图时重新拉取项目：Agent、周期监测或其他成员在别的页面创建的批次/任务不能停留在打开项目时的快照里
	const projectLoaded = project !== null && project.id === projectId;
	// biome-ignore lint/correctness/useExhaustiveDependencies: view 是触发时机；首次加载由 loadProject 的 effect 负责
	useEffect(() => {
		if (projectLoaded && !managementViews.includes(view)) void loadProject();
	}, [view]);
	// 切换视图时清掉报告页 Anchor 留下的 location.hash，避免残留到其他页面
	// biome-ignore lint/correctness/useExhaustiveDependencies: view 是触发时机，effect 只操作 window.location
	useEffect(() => {
		if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
	}, [view]);

	async function logoutUser() {
		await post("/api/auth/logout");
		setUser(null);
		setNavigation([]);
		setProjects([]);
		setProjectId(null);
		setProject(null);
		setLoading(false);
	}
	function applyIdentity(identity: UserIdentity) {
		setUser(identity);
		setNavigation([]);
		setProjects([]);
		setProjectId(null);
		setProject(null);
		setView("overview");
		setProjectPagination((current) => ({ ...current, page: 1, total: 0, totalPages: 1, items: [] }));
		setLoading(true);
	}

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
	if (!user.isSuperAdmin && !user.permissions.some((permission) => permission.startsWith("page.")))
		return (
			<main className="center">
				<h1>当前账号尚未获得页面权限</h1>
				<p>请联系系统超管分配机构角色；角色或机构授权更新后页面会自动刷新。</p>
				<AccountControl user={user} onLogout={logoutUser} />
			</main>
		);
	if (!projectId && managementViews.includes(view))
		return (
			<AccessContext.Provider value={user}>
				<ViewBoundary resetKey={view}>
					<ManagementWorkspace
						view={view}
						user={user}
						navigation={availableViews}
						onBack={() => setView(availableViews.find((item) => !managementViews.includes(item.id))?.id ?? "overview")}
						onSelectView={setView}
						onLogout={logoutUser}
						onIdentityChange={applyIdentity}
					/>
				</ViewBoundary>
			</AccessContext.Provider>
		);
	if (!projectId)
		return (
			<AccessContext.Provider value={user}>
				<ProjectHome
					account={<AccountControl user={user} onLogout={logoutUser} />}
					projects={projects}
					navigation={availableViews}
					pagination={projectPagination}
					search={projectSearch}
					onSearch={(value) => {
						setProjectSearch(value);
						setProjectPagination((current) => ({ ...current, page: 1 }));
					}}
					onPage={(page) => setProjectPagination((current) => ({ ...current, page }))}
					onPageSize={(pageSize) => setProjectPagination((current) => ({ ...current, page: 1, pageSize }))}
					onOpen={(id) => {
						setView(availableViews.find((item) => !managementViews.includes(item.id))?.id ?? "overview");
						setProjectId(id);
					}}
					onManage={setView}
					onCreate={() => setCreating(true)}
					creating={creating}
					onClose={() => setCreating(false)}
					onCreated={(id) => {
						setCreating(false);
						void api<{ user: UserIdentity }>("/api/auth/me")
							.then((result) => {
								setUser(result.user);
								setProjectId(id);
								void loadProjects();
							})
							.catch((reason) => setError(reason instanceof Error ? reason.message : "新客户已创建，请刷新访问权限"));
					}}
					error={error}
				/>
			</AccessContext.Provider>
		);

	return (
		<AccessContext.Provider value={user}>
			<NavigationContext.Provider value={workspaceNavigation}>
				<AppShell
					project={project}
					view={view}
					navigation={availableViews}
					error={error}
					account={<AccountControl user={user} onLogout={logoutUser} />}
					onSwitchProject={() => {
						setProjectId(null);
						setProject(null);
					}}
					onSelectView={setView}
				>
					<ViewBoundary resetKey={`${projectId}:${view}`}>
						{!project ? (
							<div className="center">
								<IconLoader2 className="spin" />
							</div>
						) : project.status !== "active" && !managementViews.includes(view) && view !== "workbench" ? (
							<Onboarding
								project={project}
								refresh={async () => {
									await loadProject();
									await loadProjects();
								}}
							/>
						) : (
							<>
								{view === "workbench" && (
									<Workbench
										project={project}
										initialMessage={workbenchDraft}
										onConsumeInitial={() => setWorkbenchDraft(null)}
										refresh={loadProject}
									/>
								)}
								{view === "overview" && <Overview project={project} refresh={loadProject} />}
								{view === "monitor" && (
									<Monitoring
										project={project}
										refresh={loadProject}
										focusBatchId={batchFocus}
										onConsumeFocus={() => setBatchFocus(null)}
									/>
								)}
								{view === "evidence" && (
									<Evidence project={project} focus={evidenceFocus} onConsumeFocus={() => setEvidenceFocus(null)} />
								)}
								{view === "audit" && <WebsiteAudit project={project} refresh={loadProject} />}
								{view === "diagnosis" && <Diagnosis project={project} refresh={loadProject} />}
								{view === "remediation" && <Remediation project={project} refresh={loadProject} />}
								{view === "attribution" && <Attribution project={project} />}
								{view === "report" && <Report project={project} />}
								{view === "articles" && <Articles project={project} />}
								{view === "knowledge" && (
									<KnowledgeBase project={project} canWrite={hasPermission(user, "knowledge.manage")} />
								)}
								{view === "settings" && <Settings />}
								{view === "members" && <Members localBypass={user.localBypass} />}
								{view === "auditLogs" && <AuditLogs />}
								{view === "serviceLogs" && <ServiceLogs />}
								{view === "rbac" && <RbacManagement user={user} onOpenMembers={() => setView("members")} />}
								{view === "organizations" && user.isSuperAdmin && (
									<OrganizationManagement user={user} onIdentityChange={applyIdentity} />
								)}
							</>
						)}
					</ViewBoundary>
				</AppShell>
			</NavigationContext.Provider>
		</AccessContext.Provider>
	);
}
