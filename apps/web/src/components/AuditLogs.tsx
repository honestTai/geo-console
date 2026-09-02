import { Descriptions, Table } from "antd";
import { api } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { AuditLogRow, Paginated } from "../types";
import { date, Pagination } from "../ui/primitives";

export function AuditLogs() {
	return (
		<section>
			<div className="overview-head">
				<div>
					<span className="eyebrow">审计日志</span>
					<h2>写操作与审批记录</h2>
					<p className="muted">查看机构成员的写操作、审批、成员变更与平台设置记录。</p>
				</div>
			</div>
			<AuditLogPanel />
		</section>
	);
}

export function AuditLogPanel() {
	const logs = usePaginated<AuditLogRow>(
		(page, pageSize) => api<Paginated<AuditLogRow>>(`/api/audit-logs?page=${page}&pageSize=${pageSize}`),
		[],
		{ pageSize: 20 },
	);
	return (
		<div className="audit-log-panel">
			<Table
				size="small"
				rowKey="id"
				loading={logs.loading}
				pagination={false}
				dataSource={logs.items}
				columns={[
					{ title: "时间", key: "created_at", width: 180, render: (_, log) => date(log.created_at) },
					{ title: "操作者", key: "actor", render: (_, log) => log.actor_email ?? "系统" },
					{ title: "动作", key: "action", render: (_, log) => <b>{log.action}</b> },
					{
						title: "对象",
						key: "target",
						render: (_, log) => `${log.target_type}${log.target_id ? ` · ${log.target_id}` : ""}`,
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
