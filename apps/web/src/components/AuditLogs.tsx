import { Descriptions, Table } from "antd";
import { api } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { AuditLogRow, Paginated } from "../types";
import { date, IdChip, Pagination } from "../ui/primitives";
import { Page } from "./Page";

export function AuditLogs() {
	return (
		<Page
			eyebrow="审计日志"
			title="审计日志"
			description="机构内的写操作、审批与设置变更记录。"
		>
			<AuditLogPanel />
		</Page>
	);
}

const actionLabels: Record<string, string> = {
	"agent.approve": "批准 Agent 草稿",
	"agent.reject": "拒绝 Agent 草稿",
	"POST /api/projects": "新建客户",
	"POST /api/users": "添加成员",
	"DELETE /api/users/:id": "停用成员",
};

const targetLabels: Record<string, string> = {
	agent_run: "Agent 运行",
	project: "客户项目",
	user: "成员",
	organization: "机构",
	role: "角色",
	report_snapshot: "报告版本",
	http: "接口调用",
};

export function AuditLogPanel() {
	const logs = usePaginated<AuditLogRow>(
		(page, pageSize) => api<Paginated<AuditLogRow>>(`/api/audit-logs?page=${page}&pageSize=${pageSize}`),
		[],
	);
	return (
		<div className="audit-log-panel">
			<Table
				size="middle"
				rowKey="id"
				loading={logs.loading}
				pagination={false}
				dataSource={logs.items}
				columns={[
					{ title: "时间", key: "created_at", width: 180, render: (_, log) => date(log.created_at) },
					{ title: "操作者", key: "actor", render: (_, log) => log.actor_email ?? "系统" },
					{
						title: "动作",
						key: "action",
						render: (_, log) => (
							<span>
								<b>{actionLabels[log.action] ?? log.action}</b> <small className="muted">{log.action}</small>
							</span>
						),
					},
					{
						title: "对象",
						key: "target",
						render: (_, log) => (
							<span className="audit-target">
								{targetLabels[log.target_type] ?? log.target_type}
								{log.target_id ? <IdChip value={log.target_id} /> : null}
							</span>
						),
					},
				]}
				expandable={{
					rowExpandable: (log) => Object.keys(log.metadata).length > 0,
					expandedRowRender: (log) => (
						<Descriptions column={1} size="small">
							{Object.entries(log.metadata).map(([key, value]) => (
								<Descriptions.Item key={key} label={key}>
									{typeof value === "object" ? JSON.stringify(value) : String(value)}
								</Descriptions.Item>
							))}
						</Descriptions>
					),
				}}
			/>
			<Pagination {...logs} onPage={(page) => void logs.reload(page)} onPageSize={logs.setPageSize} />
		</div>
	);
}
