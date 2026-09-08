import type { ReactNode } from "react";
import { hasPermission } from "../access";
import {
	AuditLogs,
	KnowledgeBase,
	Members,
	OrganizationManagement,
	RbacManagement,
	ServiceLogs,
	Settings,
} from "../lazy-views";
import type { UserIdentity, View } from "../types";
import { managementViews } from "../types";
import { AccountControl } from "./Login";
import { AppShell, type ShellNavigationItem } from "./Shell";
import "./Management.css";

/**
 * 机构管理工作区：不选客户时也能进入的机构级页面（客户管理、知识库、平台设置、成员、日志、权限、租户）。
 * 复用客户工作台的外壳，只保留“机构管理 / 系统管理”两组菜单，避免出现第二套导航。
 */
export function ManagementWorkspace({
	view,
	user,
	navigation,
	onBack,
	onSelectView,
	onLogout,
	onIdentityChange,
	customerContent,
}: {
	view: View;
	user: UserIdentity;
	navigation: ShellNavigationItem[];
	onBack(): void;
	onSelectView(view: View): void;
	onLogout(): Promise<void>;
	onIdentityChange(user: UserIdentity): void;
	customerContent: ReactNode;
}) {
	const available = navigation.filter((item) => managementViews.includes(item.id));
	return (
		<AppShell
			project={null}
			view={view}
			navigation={available}
			error={null}
			title="机构管理"
			subtitle={`${user.organizationName} · 客户、成员与机构级设置`}
			switchLabel="返回客户列表"
			account={<AccountControl user={user} onLogout={onLogout} />}
			onSwitchProject={onBack}
			onSelectView={onSelectView}
		>
			{view === "customers" && customerContent}
			{view === "knowledge" && (
				<KnowledgeBase initialIndustry={null} canWrite={hasPermission(user, "knowledge.manage")} />
			)}
			{view === "settings" && <Settings />}
			{view === "members" && <Members localBypass={user.localBypass} />}
			{view === "auditLogs" && <AuditLogs />}
			{view === "serviceLogs" && <ServiceLogs />}
			{view === "rbac" && <RbacManagement user={user} onOpenMembers={() => onSelectView("members")} />}
			{view === "organizations" && user.isSuperAdmin && (
				<OrganizationManagement user={user} onIdentityChange={onIdentityChange} />
			)}
		</AppShell>
	);
}
