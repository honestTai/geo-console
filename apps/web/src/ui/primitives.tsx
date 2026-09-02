import { IconAlertTriangle, IconBolt, IconCheck, IconCopy, IconFileAnalytics } from "@tabler/icons-react";
import { Pagination as AntdPagination, App, Select, Statistic, Tooltip, Typography } from "antd";
import type { ReactNode } from "react";
import { batchKindLabel, type EvidenceIndexEntry, type Project, providerShortLabel } from "../types";
import "./primitives.css";

export const percentage = (value: number | null | undefined) => (value == null ? "-" : `${(value * 100).toFixed(1)}%`);
export const date = (value: string | null | undefined) =>
	value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";
/** 短日期：卡片/表格里避免换行截断，如 “9月2日 09:38”。 */
export const shortDate = (value: string | null | undefined) =>
	value
		? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(
				new Date(value),
			)
		: "-";

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
			showSizeChanger={!!onPageSize && total > 10}
			pageSizeOptions={[10, 20, 50]}
			showTotal={(t) => `共 ${t} 条`}
			onChange={(nextPage, nextPageSize) => {
				if (nextPageSize !== pageSize) onPageSize?.(nextPageSize);
				if (nextPage !== page || nextPageSize === pageSize) onPage(nextPage);
			}}
		/>
	);
}

export function Empty({
	title,
	detail,
	action,
	compact,
}: {
	title: string;
	detail: string;
	action?: ReactNode;
	compact?: boolean;
}) {
	return (
		<div className={compact ? "empty compact" : "empty"}>
			<IconFileAnalytics size={compact ? 24 : 30} />
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

const batchStatusLabels: Record<string, string> = {
	draft: "草稿",
	queued: "排队中",
	running: "采集中",
	complete: "已完成",
	partial: "部分完成",
};
export const batchStatusLabel = (status: string): string => batchStatusLabels[status] ?? status;

export function BatchPicker({
	project,
	selected,
	setSelected,
	className,
}: {
	project: Project;
	selected: string | null;
	setSelected(id: string): void;
	className?: string;
}) {
	return (
		<Select
			className={["batch-picker", className].filter(Boolean).join(" ")}
			value={selected ?? undefined}
			placeholder="选择批次"
			onChange={(value) => setSelected(value)}
			popupMatchSelectWidth={false}
			options={project.batches.map((batch) => ({
				value: batch.id,
				label: `${batchKindLabel(batch.kind)} · ${shortDate(batch.created_at)} · ${batchStatusLabel(batch.status)}`,
			}))}
		/>
	);
}

/** 内容区二级分组标题：h3 + 副文案 + 右侧操作，平铺替代嵌套卡片/Collapse。 */
export function SectionTitle({
	title,
	description,
	extra,
	count,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	extra?: ReactNode;
	count?: ReactNode;
	className?: string;
}) {
	return (
		<header className={["section-title", className].filter(Boolean).join(" ")}>
			<div className="section-title-text">
				<h3>
					{title}
					{count !== undefined && count !== null && <span className="section-title-count">{count}</span>}
				</h3>
				{description && <p>{description}</p>}
			</div>
			{extra && <div className="section-title-extra">{extra}</div>}
		</header>
	);
}

/** 筛选/搜索行：一行放搜索框、下拉、开关和右侧操作，避免输入框套卡片。 */
export function FilterBar({
	children,
	extra,
	className,
}: {
	children: ReactNode;
	extra?: ReactNode;
	className?: string;
}) {
	return (
		<div className={["filter-bar", className].filter(Boolean).join(" ")}>
			<div className="filter-bar-fields">{children}</div>
			{extra && <div className="filter-bar-extra">{extra}</div>}
		</div>
	);
}

export function KpiGrid({ children, columns }: { children: ReactNode; columns?: number }) {
	return (
		<div className="kpi-grid" style={columns ? ({ "--kpi-columns": columns } as React.CSSProperties) : undefined}>
			{children}
		</div>
	);
}

export function KpiCard({
	label,
	value,
	suffix,
	hint,
	delta,
	tone,
	loading,
}: {
	label: ReactNode;
	value: ReactNode;
	suffix?: ReactNode;
	hint?: ReactNode;
	delta?: { value: number; label?: string } | null;
	tone?: "default" | "muted";
	loading?: boolean;
}) {
	return (
		<article className={tone === "muted" ? "kpi-card muted" : "kpi-card"}>
			<Statistic
				title={label}
				value={typeof value === "number" ? value : undefined}
				formatter={() => value}
				suffix={suffix}
				loading={loading}
			/>
			{delta && delta.value !== 0 && (
				<span className={`kpi-delta ${delta.value > 0 ? "up" : "down"}`}>
					{delta.value > 0 ? "+" : ""}
					{delta.label ?? delta.value}
				</span>
			)}
			{hint && <small className="kpi-hint">{hint}</small>}
		</article>
	);
}

/** 短 ID 芯片：显示前 8 位，悬停看全文，点击复制。 */
export function IdChip({ value, label, length = 8 }: { value: string; label?: string; length?: number }) {
	const { message } = App.useApp();
	const short = value.length > length ? `${value.slice(0, length)}…` : value;
	return (
		<Tooltip title={value}>
			<button
				type="button"
				className="id-chip"
				onClick={() => {
					void navigator.clipboard?.writeText(value).then(() => message.success("已复制"));
				}}
			>
				{label && <span className="id-chip-label">{label}</span>}
				<code>{short}</code>
				<IconCopy size={12} />
			</button>
		</Tooltip>
	);
}

export type EvidenceOpener = (captureId: string) => void;

/** 报告/诊断里的证据引用：把 UUID 变成 “[3] DeepSeek · 问题 · 第1次 · 时间”，可点击跳到证据中心。 */
export function EvidenceRef({
	ids,
	index,
	onOpen,
	compact,
}: {
	ids: string[];
	index: Map<string, EvidenceIndexEntry> | EvidenceIndexEntry[] | undefined;
	onOpen?: EvidenceOpener;
	compact?: boolean;
}) {
	const lookup = Array.isArray(index) ? new Map(index.map((entry) => [entry.id, entry])) : index;
	if (!ids.length) return null;
	return (
		<span className={compact ? "evidence-refs compact" : "evidence-refs"}>
			{/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Each reference resolves capture/snapshot/audit variants inline. */}
			{ids.map((id) => {
				const entry = lookup?.get(id);
				if (!entry)
					return (
						<Tooltip key={id} title={`证据 ${id}`}>
							<span className="evidence-ref">
								<b>[{id.slice(0, 6)}]</b>
							</span>
						</Tooltip>
					);
				const title =
					entry.kind === "capture"
						? `${entry.platformLabel ?? providerShortLabel(entry.platform ?? "")} · “${entry.question ?? ""}” · 第 ${entry.attempt ?? 1} 次采样 · ${shortDate(entry.capturedAt)}`
						: `${entry.platformLabel ?? ""} · ${entry.title ?? entry.url ?? ""}`;
				const clickable = entry.kind === "capture" && onOpen;
				const body = (
					<span className="evidence-ref">
						<b>[{entry.n}]</b>
						{!compact && (
							<span className="evidence-ref-text">
								{entry.kind === "capture" ? providerShortLabel(entry.platform ?? "") : (entry.platformLabel ?? "快照")}
								{entry.question
									? ` · ${entry.question.length > 22 ? `${entry.question.slice(0, 22)}…` : entry.question}`
									: ""}
							</span>
						)}
					</span>
				);
				return (
					<Tooltip
						key={id}
						title={
							<span>
								{title}
								{entry.sourceUrls.length ? (
									<>
										<br />
										引用网址：{entry.sourceUrls.slice(0, 3).join("、")}
										{entry.sourceUrls.length > 3 ? " …" : ""}
									</>
								) : null}
							</span>
						}
					>
						{clickable ? (
							<button type="button" className="evidence-ref-button" onClick={() => onOpen(entry.id)}>
								{body}
							</button>
						) : (
							body
						)}
					</Tooltip>
				);
			})}
		</span>
	);
}

export const { Text: TypographyText } = Typography;
