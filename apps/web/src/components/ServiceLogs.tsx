import { IconDownload, IconRefresh, IconTrash } from "@tabler/icons-react";
import type { TableProps } from "antd";
import {
	Alert,
	Button as AntdButton,
	App,
	Collapse,
	DatePicker,
	Descriptions,
	Input,
	Popconfirm,
	Select,
	Space,
	Switch,
	Table,
	Tag,
} from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";
import { Button, usePermission } from "../access";
import { api, post } from "../api";
import {
	DEFAULT_PAGE_SIZE,
	type ServiceLogFilters,
	type ServiceLogLevel,
	type ServiceLogResponse,
	type ServiceLogRow,
} from "../types";
import { date, Empty, FilterBar, IdChip, Pagination } from "../ui/primitives";
import { LOADING_DELAY_MS, Page } from "./Page";
import "./ServiceLogs.css";

const { RangePicker } = DatePicker;

export const emptyServiceLogFilters: ServiceLogFilters = { service: "", level: "", search: "", from: "", to: "" };
export const serviceLogLabels: Record<string, string> = {
	api: "API",
	"capture-worker": "Capture Worker",
	"agent-worker": "Agent Worker",
	"report-worker": "Report Worker",
	"log-service": "Log Service",
	"local-worker-coordinator": "Local Worker",
};

/** 列表用页码分页（与全站列表同口径）；不传 page 时只带筛选条件，供 CSV 导出整段下载。 */
export function serviceLogParams(filters: ServiceLogFilters, page?: number, pageSize = DEFAULT_PAGE_SIZE): URLSearchParams {
	const params = new URLSearchParams();
	if (filters.service) params.set("service", filters.service);
	if (filters.level) params.set("level", filters.level);
	if (filters.search.trim()) params.set("search", filters.search.trim());
	if (filters.from) params.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
	if (filters.to) params.set("to", new Date(`${filters.to}T23:59:59.999`).toISOString());
	if (page) {
		params.set("page", String(page));
		params.set("pageSize", String(pageSize));
	}
	return params;
}

const SERVICE_OPTIONS = Object.entries(serviceLogLabels).map(([value, label]) => ({ value, label }));
const LEVEL_OPTIONS = (["error", "warn", "info", "debug"] as const).map((level) => ({
	value: level,
	label: level.toUpperCase(),
}));
const RETENTION_OPTIONS = [30, 90, 180, 365].map((days) => ({ value: days, label: `${days} 天前` }));

function LogMetadata({ metadata }: { metadata: Record<string, unknown> }) {
	return (
		<Collapse
			ghost
			size="small"
			items={[
				{
					key: "metadata",
					label: "上下文",
					children: (
						<Descriptions
							column={1}
							size="small"
							items={Object.entries(metadata).map(([key, value]) => ({
								key,
								label: key,
								children: (
									<code>{typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}</code>
								),
							}))}
						/>
					),
				},
			]}
		/>
	);
}

const logColumns: NonNullable<TableProps<ServiceLogRow>["columns"]> = [
	{ title: "时间", dataIndex: "occurred_at", width: 160, render: (value: string) => <time>{date(value)}</time> },
	{
		title: "级别",
		dataIndex: "level",
		width: 90,
		render: (level: ServiceLogLevel) => <Tag>{level}</Tag>,
	},
	{
		title: "服务 / 事件",
		key: "service",
		width: 200,
		render: (_, log) => (
			<>
				<b>{serviceLogLabels[log.service] ?? log.service}</b> <code>{log.event}</code>
			</>
		),
	},
	{
		title: "消息",
		dataIndex: "message",
		render: (message: string, log) => (
			<>
				<p className="service-log-message">{message}</p>
				{Object.keys(log.metadata).length > 0 && <LogMetadata metadata={log.metadata} />}
			</>
		),
	},
	{
		title: "关联",
		key: "relation",
		width: 200,
		render: (_, log) => (
			<Space orientation="vertical" size={2}>
				{log.trace_id && <IdChip value={log.trace_id} label="Trace" />}
				{log.project_id && <IdChip value={log.project_id} label="项目" />}
				{log.organization_id === null && <small className="muted">系统日志</small>}
			</Space>
		),
	},
];

export function ServiceLogs() {
	const { message } = App.useApp();
	const [draftFilters, setDraftFilters] = useState<ServiceLogFilters>(emptyServiceLogFilters);
	const [filters, setFilters] = useState<ServiceLogFilters>(emptyServiceLogFilters);
	const [logs, setLogs] = useState<ServiceLogRow[]>([]);
	const [counts, setCounts] = useState<Record<ServiceLogLevel, number>>({ debug: 0, info: 0, warn: 0, error: 0 });
	const [pagination, setPagination] = useState({ page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 0, totalPages: 1 });
	const [loadingLogs, setLoadingLogs] = useState(false);
	const [autoRefresh, setAutoRefresh] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [health, setHealth] = useState<Record<string, unknown> | null>(null);
	const [retentionDays, setRetentionDays] = useState(90);
	const [retentionBusy, setRetentionBusy] = useState(false);
	const canExport = usePermission("logs.export");
	const canRetention = usePermission("logs.retention");

	const load = useCallback(
		async (page = 1) => {
			setLoadingLogs(true);
			setError(null);
			try {
				const params = serviceLogParams(filters, page);
				const result = await api<ServiceLogResponse>(`/api/service-logs?${params}`);
				setLogs(result.logs);
				setCounts(result.counts);
				setPagination({ page: result.page, pageSize: result.pageSize, total: result.total, totalPages: result.totalPages });
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : "运行日志加载失败");
			} finally {
				setLoadingLogs(false);
			}
		},
		[filters],
	);
	useEffect(() => {
		void load(1);
	}, [load]);
	useEffect(() => {
		void api<{ logService?: Record<string, unknown> }>("/api/health")
			.then((result) => setHealth(result.logService ?? null))
			.catch(() => setHealth({ status: "unavailable" }));
	}, []);
	useEffect(() => {
		if (!autoRefresh) return;
		const timer = window.setInterval(() => void load(1), 10_000);
		return () => window.clearInterval(timer);
	}, [autoRefresh, load]);
	const exportParams = serviceLogParams(filters);
	const rangeValue: [dayjs.Dayjs | null, dayjs.Dayjs | null] | null =
		draftFilters.from || draftFilters.to
			? [draftFilters.from ? dayjs(draftFilters.from) : null, draftFilters.to ? dayjs(draftFilters.to) : null]
			: null;
	async function prune() {
		setRetentionBusy(true);
		setError(null);
		try {
			const result = await post<{ deleted: number }>("/api/service-logs/retention", { olderThanDays: retentionDays });
			await load(1);
			message.success(`已清理 ${result.deleted} 条过期运行日志`);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "日志清理失败");
		} finally {
			setRetentionBusy(false);
		}
	}
	return (
		<Page
			className="service-logs-view"
			eyebrow="运行日志"
			title="运行日志"
			description={
				health?.status === "ok"
					? `服务正常 · ${Number(health.storedLogs ?? 0).toLocaleString("zh-CN")} 条 · 保留 ${health.retentionDays} 天`
					: health?.status === "unconfigured"
						? "日志服务未配置"
						: "日志服务暂不可用"
			}
			extra={
				<div className="actions">
					<Space size={8}>
						<Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
						<span className="muted">自动刷新</span>
					</Space>
					{canExport && (
						<AntdButton icon={<IconDownload size={16} />} href={`/api/service-logs/export.csv?${exportParams}`}>
							导出 CSV
						</AntdButton>
					)}
					<Button variant="secondary" icon={<IconRefresh size={16} />} busy={loadingLogs} onClick={() => void load(1)}>
						刷新
					</Button>
				</div>
			}
		>
			<Space wrap size={8} className="service-log-counts">
				{(["error", "warn", "info", "debug"] as const).map((level) => (
					<AntdButton
						key={level}
						size="small"
						type={filters.level === level ? "primary" : "default"}
						onClick={() => {
							const next = { ...draftFilters, level: filters.level === level ? "" : level };
							setDraftFilters(next);
							setFilters(next);
						}}
					>
						<Tag className="service-log-level-tag">{level.toUpperCase()}</Tag>
						{counts[level].toLocaleString("zh-CN")}
					</AntdButton>
				))}
			</Space>
			<FilterBar className="service-log-filters">
				<Select
					className="service-log-select"
					value={draftFilters.service}
					onChange={(value) => setDraftFilters({ ...draftFilters, service: value })}
					options={[{ value: "", label: "全部服务" }, ...SERVICE_OPTIONS]}
				/>
				<Select
					className="service-log-select narrow"
					value={draftFilters.level}
					onChange={(value) => setDraftFilters({ ...draftFilters, level: value })}
					options={[{ value: "", label: "全部级别" }, ...LEVEL_OPTIONS]}
				/>
				<RangePicker
					className="service-log-range"
					value={rangeValue}
					onChange={(values) =>
						setDraftFilters({
							...draftFilters,
							from: values?.[0] ? values[0].format("YYYY-MM-DD") : "",
							to: values?.[1] ? values[1].format("YYYY-MM-DD") : "",
						})
					}
				/>
				<Input
					allowClear
					placeholder="消息、事件、Trace ID 或项目 ID"
					value={draftFilters.search}
					onChange={(event) => setDraftFilters({ ...draftFilters, search: event.target.value })}
				/>
				<Button onClick={() => setFilters({ ...draftFilters })}>筛选</Button>
				<Button
					variant="ghost"
					onClick={() => {
						setDraftFilters(emptyServiceLogFilters);
						setFilters(emptyServiceLogFilters);
					}}
				>
					重置
				</Button>
			</FilterBar>
			{canRetention && (
				<div className="service-log-retention-row">
					<span className="muted">默认保留 90 天，只清理当前机构的运行日志：</span>
					<span>清理</span>
					<Select
						className="service-log-select narrow"
						value={retentionDays}
						onChange={setRetentionDays}
						options={RETENTION_OPTIONS}
					/>
					<span>的日志</span>
					<Popconfirm
						title={`清理 ${retentionDays} 天前的运行日志？`}
						description="删除后不可恢复；清理动作本身会写入业务审计。"
						okText="确认清理"
						okButtonProps={{ danger: true }}
						cancelText="取消"
						onConfirm={() => void prune()}
					>
						<span>
							<Button variant="danger" icon={<IconTrash size={16} />} busy={retentionBusy}>
								清理过期日志
							</Button>
						</span>
					</Popconfirm>
				</div>
			)}
			{error && <Alert type="error" showIcon title={error} />}
			<Table<ServiceLogRow>
				rowKey="id"
				size="small"
				loading={{ spinning: loadingLogs, delay: LOADING_DELAY_MS }}
				dataSource={logs}
				columns={logColumns}
				pagination={false}
				scroll={{ x: 900 }}
				locale={{ emptyText: <Empty title="当前筛选没有日志" detail="调整时间、服务、级别或关键字后重新筛选。" /> }}
			/>
			<Pagination {...pagination} onPage={(page) => void load(page)} />
		</Page>
	);
}
