import { IconArrowLeft, IconChevronDown, IconGlobe, IconHelpCircle, IconMenu2 } from "@tabler/icons-react";
import {
	Alert,
	Button as AntdButton,
	ConfigProvider,
	Drawer,
	Dropdown,
	Layout,
	Menu,
	type MenuProps,
	Tag,
	Tooltip,
} from "antd";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { Project, View } from "../types";
import "./Shell.css";

export type ShellNavigationItem = { id: View; label: string; icon: typeof IconGlobe; group?: string };

const groupOrder = ["客户工作台", "监测与诊断", "内容与整改", "交付与复测", "机构管理", "系统管理"];

function useNarrow(): boolean {
	const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 900px)").matches);
	useEffect(() => {
		const query = window.matchMedia("(max-width: 900px)");
		const listener = (event: MediaQueryListEvent) => setNarrow(event.matches);
		query.addEventListener("change", listener);
		return () => query.removeEventListener("change", listener);
	}, []);
	return narrow;
}

function buildMenuItems(navigation: ShellNavigationItem[], collapsed: boolean): MenuProps["items"] {
	const groups = new Map<string, ShellNavigationItem[]>();
	for (const item of navigation) {
		const group = item.group ?? "客户工作台";
		groups.set(group, [...(groups.get(group) ?? []), item]);
	}
	const ordered = [...groups.entries()].sort(
		([left], [right]) =>
			(groupOrder.indexOf(left) === -1 ? 99 : groupOrder.indexOf(left)) -
			(groupOrder.indexOf(right) === -1 ? 99 : groupOrder.indexOf(right)),
	);
	if (ordered.length <= 1 || collapsed)
		return navigation.map((item) => ({ key: item.id, icon: <item.icon size={18} />, label: item.label }));
	return ordered.map(([group, items]) => ({
		type: "group" as const,
		key: `group:${group}`,
		label: group,
		children: items.map((item) => ({ key: item.id, icon: <item.icon size={18} />, label: item.label })),
	}));
}

export function AppShell({
	project,
	view,
	navigation,
	error,
	account,
	title,
	subtitle,
	switchLabel,
	onSwitchProject,
	onSelectView,
	children,
}: {
	project: Project | null;
	view: View;
	navigation: ShellNavigationItem[];
	error: string | null;
	account: ReactNode;
	/** 没有客户项目时（机构管理）顶栏显示的标题与说明 */
	title?: string;
	subtitle?: string;
	/** 侧栏返回按钮文案；默认显示当前客户名 */
	switchLabel?: string;
	onSwitchProject(): void;
	onSelectView(view: View): void;
	children: ReactNode;
}) {
	const narrow = useNarrow();
	const [collapsed, setCollapsed] = useState(false);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const menuItems = useMemo(() => buildMenuItems(navigation, collapsed && !narrow), [navigation, collapsed, narrow]);
	const menu = (
		<ConfigProvider
			theme={{
				components: {
					Menu: {
						itemBg: "#ffffff",
						subMenuItemBg: "#ffffff",
						itemColor: "#475467",
						itemHoverBg: "#f2f4f7",
						itemSelectedBg: "#dbeafe",
						itemSelectedColor: "#1d4ed8",
						groupTitleColor: "#98a2b3",
						itemMarginInline: 0,
						itemHeight: 36,
						iconMarginInlineEnd: 10,
					},
				},
			}}
		>
			<Menu
				className="app-sider-menu"
				theme="light"
				mode="inline"
				inlineIndent={12}
				selectedKeys={[view]}
				items={menuItems}
				onClick={({ key }) => {
					onSelectView(key as View);
					setDrawerOpen(false);
				}}
			/>
		</ConfigProvider>
	);
	const siderBody = (
		<div className="app-sider-inner">
			<div className="brand app-sider-brand">
				<span className="brand-mark">Z</span>
				{(!collapsed || narrow) && (
					<div>
						<strong>ZZ Geo</strong>
						<small>AI 搜索监测</small>
					</div>
				)}
			</div>
			<Tooltip
				title={collapsed && !narrow ? (switchLabel ?? project?.name ?? "客户项目") : undefined}
				placement="right"
			>
				<button type="button" className="project-switch app-sider-switch" onClick={onSwitchProject}>
					<IconArrowLeft size={16} />
					{(!collapsed || narrow) && <span>{switchLabel ?? project?.name ?? "客户项目"}</span>}
				</button>
			</Tooltip>
			{menu}
		</div>
	);
	return (
		<Layout className="app-shell">
			{narrow ? (
				<Drawer
					className="app-sider-drawer"
					placement="left"
					open={drawerOpen}
					onClose={() => setDrawerOpen(false)}
					size={264}
					styles={{ body: { padding: 0, background: "#ffffff" }, header: { display: "none" } }}
				>
					{siderBody}
				</Drawer>
			) : (
				<Layout.Sider
					className="app-sider"
					theme="light"
					width={256}
					collapsedWidth={64}
					collapsible
					collapsed={collapsed}
					onCollapse={setCollapsed}
				>
					{siderBody}
				</Layout.Sider>
			)}
			<Layout className="app-main">
				<header className="topbar">
					<div className="topbar-left">
						{narrow && (
							<button type="button" className="topbar-menu" onClick={() => setDrawerOpen(true)} aria-label="打开菜单">
								<IconMenu2 size={20} />
							</button>
						)}
						<div className="topbar-project">
							<button
								className="topbar-customer"
								type="button"
								onClick={onSwitchProject}
								title="切换客户"
								aria-label={project ? `切换客户：${project.name}` : "返回客户列表"}
							>
								<strong>{title ?? project?.name ?? "加载项目"}</strong>
							</button>
							{project?.domain && (
								<Tag className="topbar-domain" icon={<IconGlobe size={13} />}>
									{project.domain || "暂未填写官网"}
								</Tag>
							)}
							{!project && subtitle && <span className="topbar-subtitle">{subtitle}</span>}
							{navigation.length > 0 && (
								<Dropdown
									menu={{
										items: navigation.map((item) => ({ key: item.id, label: item.label })),
										onClick: ({ key }) => onSelectView(key as View),
									}}
								>
									<button className="topbar-view" type="button">
										{navigation.find((item) => item.id === view)?.label ?? "工作台"}
										<IconChevronDown size={14} />
									</button>
								</Dropdown>
							)}
						</div>
					</div>
					<div className="topbar-right">
						<Tooltip title="打开操作手册与帮助中心">
							<AntdButton
								className="topbar-help"
								type="text"
								icon={<IconHelpCircle size={19} />}
								href="/help/"
								target="_blank"
								aria-label="打开帮助中心"
							/>
						</Tooltip>
						{account}
					</div>
				</header>
				<main className={view === "workbench" ? "workspace workspace-wide" : "workspace"}>
					{error && <Alert className="app-shell-alert" type="error" title={error} showIcon />}
					{children}
				</main>
			</Layout>
		</Layout>
	);
}
