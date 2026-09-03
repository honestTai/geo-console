import { Alert } from "antd";
import { hasPermission } from "../access";
import type { UserIdentity, View } from "../types";
import { managementViews } from "../types";
import { AuditLogs } from "./AuditLogs";
import { KnowledgeBase } from "./KnowledgeBase";
import { AccountControl } from "./Login";
import { Members } from "./Members";
import { OrganizationManagement } from "./OrganizationManagement";
import { RbacManagement } from "./RbacManagement";
import { ServiceLogs } from "./ServiceLogs";
import { Settings } from "./Settings";
import { AppShell, type ShellNavigationItem } from "./Shell";
import "./Management.css";

/**
 * 机构管理工作区：不选客户时也能进入的机构级页面（知识库、平台设置、成员、日志、权限、租户）。
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
}: {
	view: View;
	user: UserIdentity;
	navigation: ShellNavigationItem[];
	onBack(): void;
	onSelectView(view: View): void;
	onLogout(): Promise<void>;
	onIdentityChange(user: UserIdentity): void;
}) {
	const available = navigation.filter((item) => managementViews.includes(item.id));
	return (
		<AppShell
			project={null}
			view={view}
			navigation={available}
			error={null}
			title="机构管理"
			subtitle={`${user.organizationName} · 机构级设置，对该机构下所有客户生效`}
			switchLabel="返回客户列表"
			account={<AccountControl user={user} onLogout={onLogout} />}
			onSwitchProject={onBack}
			onSelectView={onSelectView}
		>
			<Alert
				className="management-notice"
				type="info"
				showIcon
				title="这里是机构级设置：模型与平台密钥、问题知识库、成员与权限、日志。客户项目的监测、报告与文章请返回客户列表后进入对应客户。"
			/>
			{view === "knowledge" && (
				<KnowledgeBase initialIndustry={null} canWrite={hasPermission(user, "knowledge.manage")} />
			)}
			{view === "settings" && <Settings />}
			{view === "members" && <Members localBypass={user.localBypass} />}
			{view === "auditLogs" && <AuditLogs />}
			{view === "serviceLogs" && <ServiceLogs />}
			{view === "rbac" && <RbacManagement user={user} />}
			{view === "organizations" && user.isSuperAdmin && (
				<OrganizationManagement user={user} onIdentityChange={onIdentityChange} />
			)}
		</AppShell>
	);
}
