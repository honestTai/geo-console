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
import { Articles } from "./components/Articles";
import { Attribution } from "./components/Attribution";
import { AuditLogs } from "./components/AuditLogs";
import { Diagnosis } from "./components/Diagnosis";
import { Evidence } from "./components/Evidence";
import { KnowledgeBase } from "./components/KnowledgeBase";
import { AccountControl, Login } from "./components/Login";
import { ManagementWorkspace } from "./components/Management";
import { Members } from "./components/Members";
import { Monitoring } from "./components/Monitoring";
import { Onboarding } from "./components/Onboarding";
import { OrganizationManagement } from "./components/OrganizationManagement";
import { Overview } from "./components/Overview";
import { ProjectHome } from "./components/ProjectHome";
import { RbacManagement } from "./components/RbacManagement";
import { Remediation } from "./components/Remediation";
import { Report } from "./components/Report";
import { ServiceLogs } from "./components/ServiceLogs";
import { Settings } from "./components/Settings";
import { AppShell, type ShellNavigationItem } from "./components/Shell";
import { WebsiteAudit } from "./components/WebsiteAudit";
import { Workbench } from "./components/Workbench";
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
	const [workbenchDraft, setWorkbenchDraft] = useState<string | null>(null);
	const workspaceNavigation = useMemo<WorkspaceNavigation>(
		() => ({
			openView: setView,
			openEvidence: (captureId, batchId = null) => {
				setEvidenceFocus({ captureId, batchId });
				setView("evidence");
			},
			openWorkbench: (message) => {
				setWorkbenchDraft(message ?? null);
				setView("workbench");
			},
		}),
		[],
	);
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
	if (!projectId && managementViews.includes(view))
		return (
			<AccessContext.Provider value={user}>
				<ManagementWorkspace
					view={view}
					user={user}
					navigation={availableViews}
					onBack={() => setView(availableViews.find((item) => !managementViews.includes(item.id))?.id ?? "overview")}
					onSelectView={setView}
					onLogout={logoutUser}
					onIdentityChange={applyIdentity}
				/>
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
						setProjectId(id);
						void loadProjects();
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
					{!project ? (
						<div className="center">
							<IconLoader2 className="spin" />
						</div>
					) : project.status !== "active" && !managementViews.includes(view) ? (
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
							{view === "monitor" && <Monitoring project={project} refresh={loadProject} />}
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
							{view === "rbac" && <RbacManagement user={user} />}
							{view === "organizations" && user.isSuperAdmin && (
								<OrganizationManagement user={user} onIdentityChange={applyIdentity} />
							)}
						</>
					)}
				</AppShell>
			</NavigationContext.Provider>
		</AccessContext.Provider>
	);
}
