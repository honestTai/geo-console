import { IconArchive, IconDots, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { Alert, App, Dropdown, Input, Segmented, Table, Tag } from "antd";
import { useState } from "react";
import { Button, usePermission } from "../access";
import { api } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { Paginated, ProjectSummary } from "../types";
import { FilterBar, Pagination, shortDate } from "../ui/primitives";
import { CreateProject } from "./CreateProject";
import { Page } from "./Page";
import { ProjectLifecycleDialog } from "./ProjectLifecycleDialog";
import { ProjectProfileEditor } from "./ProjectProfileEditor";
import "./CustomerManagement.css";

export function CustomerManagement({
	organizationName,
	canOpenWorkspace,
	onOpenProject,
	onCreated,
	onChanged,
}: {
	organizationName: string;
	canOpenWorkspace: boolean;
	onOpenProject(id: string): void;
	onCreated(): Promise<void>;
	onChanged(): Promise<void>;
}) {
	const { message } = App.useApp();
	const [search, setSearch] = useState("");
	const [creating, setCreating] = useState(false);
	const [editing, setEditing] = useState<ProjectSummary | null>(null);
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const [status, setStatus] = useState("all");
	const [lifecycle, setLifecycle] = useState<{ project: ProjectSummary; operation: "archive" | "delete" } | null>(null);
	const canArchive = usePermission("project.archive");
	const canDelete = usePermission("project.delete");
	const customers = usePaginated<ProjectSummary>(
		(page, pageSize) => {
			const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
			query.set("status", status);
			if (search.trim()) query.set("search", search.trim());
			return api<Paginated<ProjectSummary>>(`/api/projects?${query}`);
		},
		[search, status],
	);
	async function created() {
		setCreating(false);
		setRefreshError(null);
		message.success("客户已创建");
		try {
			await onCreated();
			await customers.reload(1);
		} catch {
			setRefreshError("客户已创建，但列表或访问权限刷新失败，请刷新页面；不要重复创建。");
		}
	}
	return (
		<Page
			eyebrow="机构管理"
			title="客户管理"
			breadcrumb={organizationName}
			extra={
				<Button permission="project.create" icon={<IconPlus size={17} />} onClick={() => setCreating(true)}>
					新建客户
				</Button>
			}
		>
			{(customers.error || refreshError) && (
				<Alert
					showIcon
					type="error"
					title={refreshError ?? (customers.error instanceof Error ? customers.error.message : "客户列表读取失败")}
					action={
						<Button
							variant="secondary"
							onClick={() =>
								void customers
									.reload()
									.then(() => setRefreshError(null))
									.catch(() => undefined)
							}
						>
							重试列表
						</Button>
					}
				/>
			)}
			<FilterBar extra={<span className="muted">共 {customers.total} 个客户</span>}>
				<Segmented
					aria-label="客户状态"
					value={status}
					onChange={setStatus}
					options={[
						{ value: "all", label: "全部" },
						{ value: "open", label: "未封档" },
						{ value: "archived", label: "已封档" },
					]}
				/>
				<Input
					aria-label="搜索客户"
					placeholder="搜索客户名称、官网域名或行业"
					prefix={<IconSearch size={16} />}
					allowClear
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</FilterBar>
			<Table<ProjectSummary>
				className="customer-table"
				scroll={{ x: 960 }}
				rowKey="id"
				dataSource={customers.items}
				loading={customers.loading}
				pagination={false}
				locale={{ emptyText: search ? "没有找到匹配的客户" : "当前机构下暂无可访问客户" }}
				columns={[
					{
						title: "客户名称",
						dataIndex: "name",
						key: "name",
						render: (name: string, row) =>
							canOpenWorkspace ? (
								<Button variant="link" onClick={() => onOpenProject(row.id)}>
									{name}
								</Button>
							) : (
								name
							),
					},
					{
						title: "官网",
						dataIndex: "website_url",
						key: "website",
						render: (value: string | null) => value || <span className="muted">未填写</span>,
					},
					{
						title: "行业 / 地区",
						key: "profile",
						render: (_, row) => (
							<>
								{row.industry || "未填写行业"}
								<br />
								<span className="muted">{row.region}</span>
							</>
						),
					},
					{
						title: "状态",
						dataIndex: "status",
						key: "status",
						render: (status: string) => (
							<Tag color="default">
								{status === "archived"
									? "已封档"
									: status === "active"
										? "已建档"
										: status === "draft"
											? "待建档"
											: "待确认"}
							</Tag>
						),
					},
					{
						title: "监测记录",
						key: "batches",
						render: (_, row) => (
							<>
								{row.batch_count} 批次
								<br />
								<span className="muted">{row.last_batch_at ? shortDate(row.last_batch_at) : "尚未运行"}</span>
							</>
						),
					},
					{
						title: "操作",
						key: "actions",
						render: (_, row) => (
							<div className="customer-actions">
								{row.status !== "archived" && (
									<Button permission="project.onboard" variant="link" onClick={() => setEditing(row)}>
										编辑客户信息
									</Button>
								)}
								{canOpenWorkspace && (
									<Button variant="link" onClick={() => onOpenProject(row.id)}>
										{row.status === "archived" ? "查看资料" : "进入工作台"}
									</Button>
								)}
								{((canArchive && row.status !== "archived") || canDelete) && (
									<Dropdown
										trigger={["click"]}
										menu={{
											items: [
												...(canArchive && row.status !== "archived"
													? [{ key: "archive", label: "封档客户", icon: <IconArchive size={16} /> }]
													: []),
												...(canDelete
													? [{ key: "delete", label: "删除客户", danger: true, icon: <IconTrash size={16} /> }]
													: []),
											],
											onClick: ({ key }) => setLifecycle({ project: row, operation: key as "archive" | "delete" }),
										}}
									>
										<Button
											variant="ghost"
											title="更多操作"
											aria-label={`${row.name}的更多操作`}
											icon={<IconDots size={18} />}
										/>
									</Dropdown>
								)}
							</div>
						),
					},
				]}
			/>
			<Pagination {...customers} onPage={customers.setPage} onPageSize={customers.setPageSize} />
			{lifecycle && (
				<ProjectLifecycleDialog
					key={`${lifecycle.project.id}:${lifecycle.operation}`}
					{...lifecycle}
					onClose={() => setLifecycle(null)}
					onChanged={async () => {
						message.success(lifecycle.operation === "archive" ? "客户已封档" : "客户已删除");
						try {
							await customers.reload();
							await onChanged();
						} catch {
							setRefreshError("操作已完成，列表刷新失败，请重试刷新。");
						}
					}}
				/>
			)}
			{creating && (
				<CreateProject
					open
					onClose={() => setCreating(false)}
					onCreated={() => void created()}
					submitLabel="创建客户"
				/>
			)}
			{editing && (
				<ProjectProfileEditor
					key={editing.id}
					project={editing}
					onClose={() => setEditing(null)}
					refresh={async () => {
						await customers.reload();
						await onChanged();
						message.success("客户资料已更新");
					}}
				/>
			)}
		</Page>
	);
}
