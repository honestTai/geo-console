/** Isolated visual-test fixture; not imported by the application or included in production builds. */
import { IconActivity, IconArticle, IconDatabase, IconReportAnalytics, IconSparkles } from "@tabler/icons-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AccessContext } from "../src/access";
import { Page } from "../src/components/Page";
import { AppShell } from "../src/components/Shell";
import { Workbench } from "../src/components/Workbench";
import { ThemeProvider } from "../src/theme";
import type { Project, UserIdentity, View } from "../src/types";
import { NavigationContext } from "../src/ui/navigation";
import "../src/styles.css";

const fixtures: Record<string, unknown> = {
	"/api/projects/visual-test/workbench/sessions": { items: [], quickCommands: [], page: 1, total: 0, totalPages: 1 },
	"/api/settings/hrouter/models": { models: [] },
	"/api/settings/hrouter/web-search-status": { defaultModel: null, tests: {} },
	"/api/desktop-local/status": {
		execution: "client",
		storage: "sqlite",
		revision: 0,
		syncing: false,
		syncError: null,
		lastSynced: null,
		credentialsNeedSetup: false,
	},
};
// Native IPC is simulated only in this isolated, unbundled visual fixture.
Object.defineProperty(navigator, "userAgent", { value: `${navigator.userAgent} ZZGeoDesktop/visual-test` });
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	value: {
		invoke: async (command: string, args: { path: string }) => {
			if (command !== "desktop_api_request") throw new Error("隔离夹具不执行原生命令");
			const path = new URL(args.path, window.location.href).pathname;
			return { status: path in fixtures ? 200 : 404, body: fixtures[path] ?? { error: "隔离界面测试没有此接口" } };
		},
	},
});
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const path = new URL(String(input), window.location.href).pathname;
	if (!path.startsWith("/api/")) return originalFetch(input, init);
	return new Response(JSON.stringify(fixtures[path] ?? { error: "隔离界面测试没有此接口" }), {
		status: path in fixtures ? 200 : 404,
		headers: { "content-type": "application/json" },
	});
};
const project = { id: "visual-test", name: "界面验收项目", domain: "", status: "active" } as Project;
const identity = {
	id: "visual-user",
	isSuperAdmin: false,
	permissions: ["workbench.run", "page.workbench", "page.monitor", "page.evidence", "page.report"],
} as UserIdentity;
const navigation = [
	{ id: "workbench" as const, label: "GEO Agent", icon: IconSparkles, group: "客户工作台" },
	{ id: "monitor" as const, label: "AI 监测", icon: IconActivity, group: "监测与诊断" },
	{ id: "evidence" as const, label: "证据中心", icon: IconDatabase, group: "监测与诊断" },
	{ id: "articles" as const, label: "优化文章", icon: IconArticle, group: "内容与整改" },
	{ id: "report" as const, label: "复测报告", icon: IconReportAnalytics, group: "交付与复测" },
];
function Preview() {
	const [view, setView] = useState<View>("workbench");
	return (
		<ThemeProvider>
			<AccessContext.Provider value={identity}>
				<NavigationContext.Provider
					value={{
						openView: setView,
						panelViews: navigation,
						openProjectList() {},
						openBatch() {},
						openEvidence() {},
						openWorkbench() {
							setView("workbench");
						},
					}}
				>
					<AppShell
						project={project}
						view={view}
						navigation={navigation}
						error={null}
						account={<span>隔离验收</span>}
						onSwitchProject={() => {}}
						onSelectView={setView}
					>
						{view === "workbench" ? (
							<Workbench project={project} initialMessage={null} onConsumeInitial={() => {}} refresh={async () => {}} />
						) : (
							<Page eyebrow="独立视图" title={navigation.find((item) => item.id === view)?.label ?? view}>
								<p>独立页面导航验收通过。此测试不提供业务数据。</p>
							</Page>
						)}
					</AppShell>
				</NavigationContext.Provider>
			</AccessContext.Provider>
		</ThemeProvider>
	);
}
createRoot(document.getElementById("root")!).render(<Preview />);
