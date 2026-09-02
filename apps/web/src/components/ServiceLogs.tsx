import { IconDownload, IconRefresh, IconTrash } from "@tabler/icons-react";
import type { TableProps } from "antd";
import {
	Alert,
	Button as AntdButton,
	App,
	Checkbox,
	Collapse,
	DatePicker,
	Descriptions,
	Input,
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
import type { ServiceLogFilters, ServiceLogLevel, ServiceLogResponse, ServiceLogRow } from "../types";
import { date, Empty } from "../ui/primitives";
import { Page } from "./Page";
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

export function serviceLogParams(filters: ServiceLogFilters, cursor?: string | null): URLSearchParams {
	const params = new URLSearchParams();
	if (filters.service) params.set("service", filters.service);
	if (filters.level) params.set("level", filters.level);
	if (filters.search.trim()) params.set("search", filters.search.trim());
	if (filters.from) params.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
	if (filters.to) params.set("to", new Date(`${filters.to}T23:59:59.999`).toISOString());
	if (cursor) params.set("cursor", cursor);
	params.set("limit", "100");
	return params;
}

const LEVEL_COLORS: Record<ServiceLogLevel, string> = { error: "red", warn: "orange", info: "blue", debug: "default" };
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
		render: (level: ServiceLogLevel) => <Tag color={LEVEL_COLORS[level]}>{level}</Tag>,
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
			<Space direction="vertical" size={0}>
				{log.trace_id && <code title="Trace ID">{log.trace_id}</code>}
				{log.project_id && <small>项目 {log.project_id}</small>}
				{log.organization_id === null && <small>系统日志</small>}
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
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [cursorHistory, setCursorHistory] = useState<string[]>([]);
	const [loadingLogs, setLoadingLogs] = useState(false);
	const [autoRefresh, setAutoRefresh] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [health, setHealth] = useState<Record<string, unknown> | null>(null);
	const [retentionDays, setRetentionDays] = useState(90);
	const [retentionConfirmed, setRetentionConfirmed] = useState(false);
	const [retentionBusy, setRetentionBusy] = useState(false);
	const canExport = usePermission("logs.export");
	const canRetention = usePermission("logs.retention");

	const load = useCallback(
		async (cursor: string | null = null) => {
			setLoadingLogs(true);
			setError(null);
			try {
				const params = serviceLogParams(filters, cursor);
				const result = await api<ServiceLogResponse>(`/api/service-logs?${params}`);
				setLogs(result.logs);
				setCounts(result.counts);
				setNextCursor(result.nextCursor);
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : "运行日志加载失败");
			} finally {
				setLoadingLogs(false);
			}
		},
		[filters],
	);
	useEffect(() => {
		setCursorHistory([]);
		void load(null);
	}, [load]);
	useEffect(() => {
		void api<{ logService?: Record<string, unknown> }>("/api/health")
			.then((result) => setHealth(result.logService ?? null))
			.catch(() => setHealth({ status: "unavailable" }));
	}, []);
	useEffect(() => {
		if (!autoRefresh) return;
		const timer = window.setInterval(() => {
			setCursorHistory([]);
			void load(null);
		}, 10_000);
		return () => window.clearInterval(timer);
	}, [autoRefresh, load]);
	const exportParams = serviceLogParams(filters);
	exportParams.delete("limit");
	const rangeValue: [dayjs.Dayjs | null, dayjs.Dayjs | null] | null =
		draftFilters.from || draftFilters.to
			? [draftFilters.from ? dayjs(draftFilters.from) : null, draftFilters.to ? dayjs(draftFilters.to) : null]
			: null;
	async function prune() {
		setRetentionBusy(true);
		setError(null);
		try {
			const result = await post<{ deleted: number }>("/api/service-logs/retention", { olderThanDays: retentionDays });
			setRetentionConfirmed(false);
			setCursorHistory([]);
			await load(null);
			message.success(`已清理 ${result.deleted} 条过期运行日志`);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "日志清理失败");
		} finally {
			setRetentionBusy(false);
		}
	}
	function goPrevPage() {
		const history = cursorHistory.slice(0, -1);
		setCursorHistory(history);
		void load(history.at(-1) ?? null);
	}
	function goNextPage() {
		if (!nextCursor) return;
		setCursorHistory([...cursorHistory, nextCursor]);
		void load(nextCursor);
	}
	return (
		<Page
			className="service-logs-view"
			eyebrow="独立日志服务"
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
						<a className="button secondary" href={`/api/service-logs/export.csv?${exportParams}`}>
							<IconDownload size={16} />
							CSV
						</a>
					)}
					<Button
						variant="secondary"
						icon={<IconRefresh size={16} />}
						busy={loadingLogs}
						onClick={() => {
							setCursorHistory([]);
							void load(null);
						}}
					>
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
						<Tag color={LEVEL_COLORS[level]} style={{ marginInlineEnd: 4 }}>
							{level.toUpperCase()}
						</Tag>
						{counts[level].toLocaleString("zh-CN")}
					</AntdButton>
				))}
			</Space>
			<Space wrap size={8} className="service-log-filters">
				<Select
					style={{ minWidth: 160 }}
					value={draftFilters.service}
					onChange={(value) => setDraftFilters({ ...draftFilters, service: value })}
					options={[{ value: "", label: "全部服务" }, ...SERVICE_OPTIONS]}
				/>
				<Select
					style={{ minWidth: 120 }}
					value={draftFilters.level}
					onChange={(value) => setDraftFilters({ ...draftFilters, level: value })}
					options={[{ value: "", label: "全部级别" }, ...LEVEL_OPTIONS]}
				/>
				<RangePicker
					style={{ minWidth: 240 }}
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
					style={{ width: 240 }}
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
			</Space>
			{error && <Alert type="error" showIcon message={error} />}
			<Table<ServiceLogRow>
				rowKey="id"
				size="small"
				loading={loadingLogs}
				dataSource={logs}
				columns={logColumns}
				pagination={false}
				scroll={{ x: 900 }}
				locale={{ emptyText: <Empty title="当前筛选没有日志" detail="调整时间、服务、级别或关键字后重新筛选。" /> }}
				footer={() => (
					<div className="service-log-cursor-bar">
						<span>第 {cursorHistory.length + 1} 页</span>
						<Space size={8}>
							<AntdButton size="small" disabled={!cursorHistory.length || loadingLogs} onClick={goPrevPage}>
								上一页
							</AntdButton>
							<AntdButton size="small" disabled={!nextCursor || loadingLogs} onClick={goNextPage}>
								下一页
							</AntdButton>
						</Space>
					</div>
				)}
			/>
			{canRetention && (
				<Collapse
					className="service-log-retention"
					items={[
						{
							key: "retention",
							label: "日志保留操作（仅清理当前机构的运行日志，业务审计和证据不受影响）",
							children: (
								<Space wrap size={12}>
									<Select
										style={{ minWidth: 120 }}
										value={retentionDays}
										onChange={setRetentionDays}
										options={RETENTION_OPTIONS}
									/>
									<Checkbox
										checked={retentionConfirmed}
										onChange={(event) => setRetentionConfirmed(event.target.checked)}
									>
										确认清理
									</Checkbox>
									<Button
										variant="danger"
										icon={<IconTrash size={16} />}
										busy={retentionBusy}
										disabled={!retentionConfirmed}
										onClick={() => void prune()}
									>
										清理过期日志
									</Button>
								</Space>
							),
						},
					]}
				/>
			)}
		</Page>
	);
}
