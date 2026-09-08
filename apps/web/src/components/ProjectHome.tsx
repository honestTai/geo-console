import { IconChevronRight, IconHelpCircle, IconPlus, IconSearch, IconSettings } from "@tabler/icons-react";
import { Card, Input, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import { Button, usePermission } from "../access";
import type { Paginated, ProjectSummary, View } from "../types";
import { managementViews } from "../types";
import { Empty, FilterBar, Notice, Pagination, shortDate } from "../ui/primitives";
import { CreateProject } from "./CreateProject";
import "./ProjectHome.css";

export function ProjectHome({
	account,
	projects,
	navigation,
	pagination,
	search,
	onSearch,
	onPage,
	onPageSize,
	onOpen,
	onManage,
	onCreate,
	creating,
	onClose,
	onCreated,
	error,
}: {
	account: ReactNode;
	projects: ProjectSummary[];
	navigation: Array<{ id: View; label: string }>;
	pagination: Paginated<ProjectSummary>;
	search: string;
	onSearch(value: string): void;
	onPage(page: number): void;
	onPageSize(pageSize: number): void;
	onOpen(id: string): void;
	onManage(view: View): void;
	onCreate(): void;
	creating: boolean;
	onClose(): void;
	onCreated(id: string): void;
	error: string | null;
}) {
	const managementEntry = navigation.find((item) => managementViews.includes(item.id));
	const canCreate = usePermission("project.create");
	return (
		<main className="project-home">
			<header>
				<div className="brand">
					<span className="brand-mark">Z</span>
					<div>
						<strong>ZZ Geo</strong>
						<small>AI 搜索监测</small>
					</div>
				</div>
				<div className="home-actions">
					<Space size="middle" wrap>
						<Button variant="secondary" icon={<IconHelpCircle size={17} />} href="/help/" target="_blank">
							帮助
						</Button>
						{managementEntry && (
							<Button
								variant="secondary"
								icon={<IconSettings size={17} />}
								onClick={() => onManage(managementEntry.id)}
							>
								机构管理
							</Button>
						)}
						<Button permission="project.create" icon={<IconPlus size={17} />} onClick={onCreate}>
							新建客户
						</Button>
						{account}
					</Space>
				</div>
			</header>
			<section className="home-title">
				<h1>客户项目</h1>
			</section>
			<FilterBar
				extra={<span className="project-home-count">{pagination.total ? `共 ${pagination.total} 个客户` : ""}</span>}
			>
				<Input
					className="project-home-search"
					allowClear
					prefix={<IconSearch size={16} />}
					value={search}
					onChange={(event) => onSearch(event.target.value)}
					placeholder="按客户名或域名筛选"
				/>
			</FilterBar>
			{error && <Notice type="error" message={error} />}
			{projects.length === 0 ? (
				<Empty
					title={search ? "没有找到匹配的客户" : "还没有客户项目"}
					detail={search ? "请换个名称或域名搜索。" : "新建客户后即可设置监测问题，官网可稍后补充。"}
					action={
						<Button permission="project.create" icon={<IconPlus size={17} />} onClick={onCreate}>
							新建第一个客户
						</Button>
					}
				/>
			) : (
				<div className="project-grid">
					{projects.map((project) => (
						<Card
							key={project.id}
							className="project-home-card"
							hoverable
							role="button"
							tabIndex={0}
							aria-label={`打开客户 ${project.name}`}
							onClick={() => onOpen(project.id)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onOpen(project.id);
								}
							}}
						>
							<div className="project-home-card-head">
								<Tag>
									{project.status === "archived" ? "已封档" : project.status === "active" ? "已建档" : "待建档"}
								</Tag>
								<IconChevronRight className="card-arrow" size={20} />
							</div>
							<Typography.Title level={5} className="project-home-card-name" ellipsis={{ tooltip: project.name }}>
								{project.name}
							</Typography.Title>
							<Typography.Text type="secondary">{project.domain || "暂未填写官网"}</Typography.Text>
							<div className="project-home-card-stats">
								<div>
									<span>地区</span>
									<b>{project.region}</b>
								</div>
								<div>
									<span>批次</span>
									<b>{project.batch_count ?? 0}</b>
								</div>
								<div>
									<span>最近监测</span>
									<b>{shortDate(project.last_batch_at)}</b>
								</div>
							</div>
						</Card>
					))}
					{canCreate && (
						<Card
							className="project-home-card project-home-card-new"
							role="button"
							tabIndex={0}
							aria-label="新建客户"
							onClick={onCreate}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onCreate();
								}
							}}
						>
							<IconPlus size={30} strokeWidth={1.6} />
							<Typography.Text strong>新建客户</Typography.Text>
							<Typography.Text type="secondary">添加客户资料</Typography.Text>
						</Card>
					)}
				</div>
			)}
			<Pagination {...pagination} onPage={onPage} onPageSize={onPageSize} />
			<CreateProject open={creating} onClose={onClose} onCreated={onCreated} />
		</main>
	);
}
