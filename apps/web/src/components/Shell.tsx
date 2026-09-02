import { IconArrowLeft, IconGlobe } from "@tabler/icons-react";
import { Alert, ConfigProvider, Layout, Menu, Space, Tooltip } from "antd";
import { type ReactNode, useMemo, useState } from "react";
import type { Project, View } from "../types";
import "./Shell.css";

export type ShellNavigationItem = { id: View; label: string; icon: typeof IconGlobe };

export function AppShell({
	project,
	view,
	navigation,
	error,
	account,
	onSwitchProject,
	onSelectView,
	children,
}: {
	project: Project | null;
	view: View;
	navigation: ShellNavigationItem[];
	error: string | null;
	account: ReactNode;
	onSwitchProject(): void;
	onSelectView(view: View): void;
	children: ReactNode;
}) {
	const [collapsed, setCollapsed] = useState(false);
	const menuItems = useMemo(
		() => navigation.map((item) => ({ key: item.id, icon: <item.icon size={18} />, label: item.label })),
		[navigation],
	);
	const currentView = navigation.find((item) => item.id === view);
	return (
		<Layout className="app-shell" style={{ minHeight: "100vh" }}>
			<Layout.Sider
				className="app-sider"
				theme="dark"
				width={236}
				collapsedWidth={60}
				collapsible
				collapsed={collapsed}
				onCollapse={setCollapsed}
			>
				<div className="app-sider-inner">
					<div className="brand app-sider-brand">
						<span className="brand-mark">Z</span>
						{!collapsed && (
							<div>
								<strong>ZZ Geo</strong>
								<small>真实 AI 可见度工作台</small>
							</div>
						)}
					</div>
					<Tooltip title={collapsed ? (project?.name ?? "客户项目") : undefined} placement="right">
						<button type="button" className="project-switch app-sider-switch" onClick={onSwitchProject}>
							<IconArrowLeft size={16} />
							{!collapsed && <span>{project?.name ?? "客户项目"}</span>}
						</button>
					</Tooltip>
					<ConfigProvider
						theme={{
							components: {
								Menu: {
									darkItemBg: "#101828",
									darkItemColor: "rgba(255, 255, 255, 0.68)",
									darkItemHoverBg: "rgba(255, 255, 255, 0.08)",
									darkItemSelectedBg: "#16a34a",
									darkItemSelectedColor: "#ffffff",
								},
							},
						}}
					>
						<Menu
							className="app-sider-menu"
							theme="dark"
							mode="inline"
							selectedKeys={[view]}
							items={menuItems}
							onClick={({ key }) => onSelectView(key as View)}
						/>
					</ConfigProvider>
					{!collapsed && (
						<div className="app-sider-foot">
							<span className="live-dot" />
							真实采集模式
						</div>
					)}
				</div>
			</Layout.Sider>
			<Layout className="app-main">
				<main className="workspace">
					<header className="topbar">
						<div>
							<span className="eyebrow">{currentView?.label}</span>
							<h1>{project?.name ?? "加载项目"}</h1>
						</div>
						<Space size="middle" align="center" wrap>
							<span className="domain">
								<IconGlobe size={16} />
								{project?.domain ?? ""}
							</span>
							{account}
						</Space>
					</header>
					{error && <Alert className="app-shell-alert" type="error" message={error} showIcon />}
					{children}
				</main>
			</Layout>
		</Layout>
	);
}
