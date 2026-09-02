import { type IconActivity, IconArrowLeft } from "@tabler/icons-react";
import { Tabs } from "antd";
import { Button, hasPermission } from "../access";
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
import "./Management.css";

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
	navigation: Array<{ id: View; label: string; icon: typeof IconActivity }>;
	onBack(): void;
	onSelectView(view: View): void;
	onLogout(): Promise<void>;
	onIdentityChange(user: UserIdentity): void;
}) {
	const available = navigation.filter((item) => managementViews.includes(item.id));
	const tabs = available.map((item) => ({
		key: item.id,
		label: (
			<span className="management-tab">
				<item.icon size={16} />
				{item.label}
			</span>
		),
	}));
	return (
		<div className="management-shell">
			<header>
				<div className="brand">
					<span className="brand-mark">Z</span>
					<div>
						<strong>ZZ Geo</strong>
						<small>{user.organizationName}</small>
					</div>
				</div>
				<div className="home-actions">
					<Button variant="secondary" icon={<IconArrowLeft size={16} />} onClick={onBack}>
						客户项目
					</Button>
					<AccountControl user={user} onLogout={onLogout} />
				</div>
			</header>
			<Tabs className="management-tabs" activeKey={view} items={tabs} onChange={(key) => onSelectView(key as View)} />
			<main className="management-workspace">
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
			</main>
		</div>
	);
}
