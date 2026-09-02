import { IconAlertTriangle, IconBolt, IconCheck, IconFileAnalytics } from "@tabler/icons-react";
import { Pagination as AntdPagination } from "antd";
import type { ReactNode } from "react";
import { batchKindLabel, type Project } from "../types";

export const percentage = (value: number | null | undefined) => (value == null ? "-" : `${(value * 100).toFixed(1)}%`);
export const date = (value: string | null | undefined) =>
	value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";

export function downloadText(fileName: string, content: string, type: string): void {
	const href = URL.createObjectURL(new Blob([content], { type }));
	const anchor = document.createElement("a");
	anchor.href = href;
	anchor.download = fileName.replace(/[/\\:*?"<>|]/g, "-");
	anchor.click();
	URL.revokeObjectURL(href);
}

export function csvCell(value: unknown): string {
	let text = value == null ? "" : String(value);
	if (/^[=+\-@]/.test(text)) text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
}
export function Pagination({
	page,
	pageSize,
	total,
	onPage,
	onPageSize,
}: {
	page: number;
	pageSize: number;
	total: number;
	totalPages: number;
	onPage(page: number): void;
	onPageSize?(pageSize: number): void;
}) {
	if (total === 0) return null;
	return (
		<AntdPagination
			className="pagination-bar"
			current={page}
			pageSize={pageSize}
			total={total}
			size="small"
			showSizeChanger={!!onPageSize}
			pageSizeOptions={[10, 20, 50]}
			showTotal={(t) => `共 ${t} 条`}
			onChange={(nextPage, nextPageSize) => {
				if (nextPageSize !== pageSize) onPageSize?.(nextPageSize);
				if (nextPage !== page || nextPageSize === pageSize) onPage(nextPage);
			}}
		/>
	);
}
export function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
	return (
		<div className="empty">
			<IconFileAnalytics size={30} />
			<h3>{title}</h3>
			<p>{detail}</p>
			{action}
		</div>
	);
}

export function Notice({ message, type = "info" }: { message: string; type?: "info" | "error" | "success" }) {
	return (
		<div className={`notice ${type}`}>
			{type === "error" ? (
				<IconAlertTriangle size={17} />
			) : type === "success" ? (
				<IconCheck size={17} />
			) : (
				<IconBolt size={17} />
			)}
			<span>{message}</span>
		</div>
	);
}
export function BatchPicker({
	project,
	selected,
	setSelected,
}: {
	project: Project;
	selected: string | null;
	setSelected(id: string): void;
}) {
	return (
		<select value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}>
			{project.batches.map((batch) => (
				<option value={batch.id} key={batch.id}>
					{batchKindLabel(batch.kind)} · {date(batch.created_at)} · {batch.status}
				</option>
			))}
		</select>
	);
}
