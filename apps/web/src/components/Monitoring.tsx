import {
	IconAdjustmentsHorizontal,
	IconAlertTriangle,
	IconChartLine,
	IconPlus,
	IconRefresh,
} from "@tabler/icons-react";
import {
	Alert,
	Button as AntdButton,
	App,
	Checkbox,
	Collapse,
	Form,
	Popover,
	Progress,
	Select,
	Switch,
	Table,
	type TableProps,
	Tag,
	Timeline,
	type TimelineProps,
} from "antd";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../access";
import { api, post, put } from "../api";
import {
	type Batch,
	type BatchSummary,
	batchKindLabel,
	type Capture,
	type CostGroup,
	type DriftAlert,
	type Paginated,
	type Project,
	type ProviderId,
	providerIds,
	providerLabel,
	providerShortLabel,
	type TrendResponse,
} from "../types";
import { date, Empty, Pagination, percentage } from "../ui/primitives";
import { BatchMetrics, TrendChart } from "./charts";
import "./Monitoring.css";
import { Page } from "./Page";

function formatClock(value: string): string {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date(value));
}

/** 平台 checkbox 组：运行配置与计划配置复用。 */
function PlatformCheckboxes({ value, onChange }: { value: ProviderId[]; onChange(value: ProviderId[]): void }) {
	return (
		<Checkbox.Group
			value={value}
			onChange={(next) => onChange(next as ProviderId[])}
			options={providerIds.map((platform) => ({ label: providerShortLabel(platform), value: platform }))}
		/>
	);
}

export function runActivityStatus(status: string, active: boolean, captured: number): string {
	if (status === "partial") return "采集完成 · 部分平台失败，原始证据已保留";
	if (!active) return "采集完成 · 指标与证据已入库";
	return captured > 0 ? `采集中 · 已写入 ${captured} 条证据` : "任务已创建 · 等待 Capture Worker";
}

export function captureLogMessage(capture: Capture): string {
	if (capture.status === "complete") return "回答与原始响应已存证";
	return `${capture.status}${capture.failureMessage ? ` · ${capture.failureMessage}` : ""}`;
}

export function RunCaptureLog({ captures, active }: { captures: Capture[]; active: boolean }) {
	if (!captures.length)
		return (
			<Timeline
				items={[
					{
						color: "gray",
						children: <span>{active ? "冻结批次配置，等待首条采集证据" : "当前批次没有可展示的采集日志"}</span>,
					},
				]}
			/>
		);
	const items: NonNullable<TimelineProps["items"]> = captures.map((capture) => ({
		color: "gray",
		children: (
			<span>
				<time>{formatClock(capture.capturedAt)}</time> · {providerShortLabel(capture.engine)} ·{" "}
				{captureLogMessage(capture)}
			</span>
		),
	}));
	if (!active)
		items.push({
			color: "gray",
			children: <span>指标已刷新 · {captures.length} 条近期 capture 已写入证据链</span>,
		});
	return <Timeline items={items} />;
}

export function RunActivityPanel({
	batch,
	summary,
	busy,
	onRerun,
}: {
	batch: Batch | null;
	summary: BatchSummary | undefined;
	busy: boolean;
	onRerun(): Promise<void>;
}) {
	if (!summary) return null;
	const expected = batch?.metrics.expectedSamples ?? 0;
	const captured = batch?.captures.length ?? 0;
	const batchStatus = batch?.status ?? summary.status;
	const active = ["queued", "running"].includes(batchStatus);
	const progress = expected > 0 ? Math.min(100, Math.round((captured / expected) * 100)) : active ? 4 : 100;
	const recentCaptures = [...(batch?.captures ?? [])]
		.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
		.slice(-6);
	const status = runActivityStatus(batchStatus, active, captured);
	return (
		<section className="run-activity" aria-live="polite">
			<header>
				<div>
					<h3>监测任务</h3>
					<p>
						{active ? "本次运行" : "上次运行"}：{date(summary.created_at)}
						{expected > 0 ? ` · ${captured}/${expected} 条采集已存证` : ""}
					</p>
				</div>
				{active ? (
					<span className="status running">运行中</span>
				) : (
					<Button
						permission="monitor.run"
						variant="secondary"
						busy={busy}
						icon={<IconRefresh size={16} />}
						onClick={() => void onRerun()}
					>
						再次运行监测
					</Button>
				)}
			</header>
			<Progress percent={progress} size="small" status={active ? "active" : undefined} aria-label="采集进度" />
			<strong className={`run-status ${active ? "running" : "complete"}`}>{status}</strong>
			<RunCaptureLog captures={recentCaptures} active={active} />
		</section>
	);
}

export function Monitoring({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const { message } = App.useApp();
	const [selected, setSelected] = useState(project.batches[0]?.id ?? null);
	const [batchPage, setBatchPage] = useState(1);
	const visibleBatches = project.batches.slice((batchPage - 1) * 10, batchPage * 10);
	const [batch, setBatch] = useState<Batch | null>(null);
	const [trends, setTrends] = useState<TrendResponse | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [alertsPage, setAlertsPage] = useState<Paginated<DriftAlert>>({
		items: [],
		page: 1,
		pageSize: 10,
		total: 0,
		totalPages: 1,
	});
	const alerts = alertsPage.items;
	const [costs, setCosts] = useState<CostGroup[]>([]);
	const [runPlatforms, setRunPlatforms] = useState<ProviderId[]>(providerIds);
	const [runRepeats, setRunRepeats] = useState(3);
	const [scheduleEnabled, setScheduleEnabled] = useState(project.monitoringSchedule?.enabled ?? false);
	const [frequencyDays, setFrequencyDays] = useState(project.monitoringSchedule?.frequency_days ?? 7);
	const [schedulePlatforms, setSchedulePlatforms] = useState<ProviderId[]>(
		project.monitoringSchedule?.platforms?.length ? project.monitoringSchedule.platforms : providerIds,
	);
	const [scheduleRepeats, setScheduleRepeats] = useState(project.monitoringSchedule?.repeats ?? 3);
	const selectedBatch = project.batches.find((item) => item.id === selected);
	const load = useCallback(async () => {
		if (selected) setBatch(await api<Batch>(`/api/batches/${selected}`));
	}, [selected]);
	useEffect(() => {
		void load();
		api<Paginated<DriftAlert>>(
			`/api/projects/${project.id}/drift-alerts?page=${alertsPage.page}&pageSize=${alertsPage.pageSize}`,
		)
			.then(setAlertsPage)
			.catch(() => setAlertsPage((current) => ({ ...current, items: [] })));
		api<{ groups: CostGroup[] }>(`/api/projects/${project.id}/costs`)
			.then((result) => setCosts(result.groups))
			.catch(() => setCosts([]));
		if (selected)
			api<TrendResponse>(`/api/projects/${project.id}/trends/${selected}`)
				.then(setTrends)
				.catch(() => setTrends(null));
		const pollingMs = ["queued", "running"].includes(batch?.status ?? selectedBatch?.status ?? "") ? 3_000 : 8_000;
		const timer = window.setInterval(() => void load(), pollingMs);
		return () => window.clearInterval(timer);
	}, [alertsPage.page, alertsPage.pageSize, batch?.status, load, project.id, selected, selectedBatch?.status]);
	function acknowledgeAlert(alert: DriftAlert) {
		void post(`/api/drift-alerts/${alert.id}/acknowledge`).then(() => {
			message.success("漂移告警已确认");
			setAlertsPage((current) => ({
				...current,
				items: current.items.map((item) =>
					item.id === alert.id ? { ...item, acknowledged_at: new Date().toISOString() } : item,
				),
			}));
		});
	}
	async function saveSchedule() {
		setBusy(true);
		setError(null);
		try {
			await put(`/api/projects/${project.id}/monitoring-schedule`, {
				enabled: scheduleEnabled,
				frequencyDays,
				platforms: schedulePlatforms,
				repeats: scheduleRepeats,
			});
			message.success("周期监测计划已保存");
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "自动监测设置保存失败");
		} finally {
			setBusy(false);
		}
	}
	async function create(kind: "quick_audit" | "baseline" | "retest", compareToBatchId: string | null = selected) {
		setBusy(true);
		setError(null);
		try {
			const result = await post<{ id: string }>(
				`/api/projects/${project.id}/batches`,
				kind !== "retest"
					? { kind, platforms: runPlatforms, repeats: kind === "quick_audit" ? 1 : runRepeats }
					: { kind, compareToBatchId },
			);
			setBatch(null);
			setTrends(null);
			setSelected(result.id);
			message.success(
				kind === "quick_audit" ? "售前快审已开始运行" : kind === "baseline" ? "正式基线已创建" : "复测批次已创建",
			);
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "创建批次失败");
		} finally {
			setBusy(false);
		}
	}
	const pendingAlerts = alerts.filter((alert) => !alert.acknowledged_at);
	const alertColumns: TableProps<DriftAlert>["columns"] = [
		{ title: "平台", dataIndex: "provider_id", render: (value: string) => providerLabel(value) },
		{ title: "指标", dataIndex: "metric" },
		{
			title: "变化",
			render: (_, alert) => `${percentage(alert.previous_value)} → ${percentage(alert.current_value)}`,
		},
		{ title: "关联证据", render: (_, alert) => `${alert.evidence_ids.length} 条` },
		{ title: "时间", dataIndex: "created_at", render: (value: string) => date(value) },
		{
			title: "操作",
			render: (_, alert) => (
				<Button permission="monitor.run" variant="ghost" onClick={() => acknowledgeAlert(alert)}>
					确认
				</Button>
			),
		},
	];
	return (
		<Page
			breadcrumb={project.name}
			eyebrow="AI监测"
			title="五平台联网监测"
			description="快审每题 1 次；正式基线默认分三个时间窗口采样。失败平台不进入品牌率分母。"
			extra={
				<div className="monitor-head-actions">
					<Popover
						trigger="click"
						placement="bottomRight"
						content={
							<Form className="monitor-config-form" layout="vertical">
								<Form.Item label="本次监测平台">
									<PlatformCheckboxes value={runPlatforms} onChange={setRunPlatforms} />
								</Form.Item>
								<Form.Item label="基线重复次数">
									<Select
										value={runRepeats}
										onChange={setRunRepeats}
										options={[1, 2, 3, 5, 10].map((value) => ({ value, label: `每题 ${value} 次` }))}
									/>
								</Form.Item>
							</Form>
						}
					>
						<AntdButton icon={<IconAdjustmentsHorizontal size={16} />}>运行配置</AntdButton>
					</Popover>
					<div className="run-actions">
						<Button
							permission="monitor.run"
							className="run-retest"
							variant="secondary"
							busy={busy}
							onClick={() => create("retest")}
							disabled={selectedBatch?.kind !== "baseline"}
							title={selectedBatch?.kind !== "baseline" ? "只能选择正式基线作为复测锚点" : undefined}
						>
							按此条件复测
						</Button>
						<Button
							permission="monitor.run"
							className="run-audit"
							variant="secondary"
							busy={busy}
							disabled={!runPlatforms.length}
							onClick={() => create("quick_audit")}
						>
							运行售前快审
						</Button>
						<Button
							permission="monitor.run"
							className="run-baseline"
							busy={busy}
							disabled={!runPlatforms.length}
							icon={<IconPlus size={17} />}
							onClick={() => create("baseline")}
						>
							新建正式基线
						</Button>
					</div>
				</div>
			}
		>
			<RunActivityPanel
				batch={batch}
				summary={selectedBatch}
				busy={busy}
				onRerun={() =>
					selectedBatch?.kind === "quick_audit"
						? create("quick_audit")
						: create(
								"retest",
								selectedBatch?.kind === "baseline" ? selectedBatch.id : selectedBatch?.compare_to_batch_id,
							)
				}
			/>
			{error && <Alert className="monitor-error" type="error" showIcon message={error} />}
			{pendingAlerts.length > 0 && (
				<div className="monitor-alert-section">
					<div className="section-head compact">
						<div>
							<h3>
								<IconAlertTriangle size={16} /> 待处理漂移告警
							</h3>
						</div>
						<span>{pendingAlerts.length} 条</span>
					</div>
					<Table<DriftAlert>
						rowKey="id"
						size="small"
						columns={alertColumns}
						dataSource={pendingAlerts}
						pagination={false}
					/>
					<Pagination {...alertsPage} onPage={(page) => setAlertsPage((current) => ({ ...current, page }))} />
				</div>
			)}
			{costs.length > 0 && (
				<div className="cost-strip">
					{costs.map((group) => (
						<div key={`${group.providerId}-${group.operation}`}>
							<span>{providerLabel(group.providerId)}</span>
							<b>
								{group.requests} 次请求 · {group.totalTokens.toLocaleString("zh-CN")} Token
							</b>
							<small>
								{group.costKnownRequests === group.requests
									? `已知费用 $${(group.knownCostMicros / 1_000_000).toFixed(4)}`
									: "供应商未返回完整费用"}
							</small>
						</div>
					))}
				</div>
			)}
			<Collapse
				className="schedule-section"
				defaultActiveKey={scheduleEnabled ? ["schedule"] : []}
				items={[
					{
						key: "schedule",
						label: (
							<span className="schedule-summary">
								<IconChartLine size={18} /> 周期监测 <Tag>{scheduleEnabled ? "已启用" : "未启用"}</Tag> · 下一次运行{" "}
								{date(project.monitoringSchedule?.next_run_at)}
							</span>
						),
						children: (
							<>
								<p className="schedule-hint">
									<Switch
										checked={scheduleEnabled}
										checkedChildren="启用"
										unCheckedChildren="停用"
										onChange={setScheduleEnabled}
									/>
									云端 Worker 到期后冻结范围和平台配置，按时间窗口调用已启用 API。
								</p>
								<Form layout="inline" className="schedule-form">
									<Form.Item label="运行周期">
										<Select
											style={{ width: 110 }}
											value={frequencyDays}
											onChange={setFrequencyDays}
											options={[
												{ value: 1, label: "每天" },
												{ value: 7, label: "每周" },
												{ value: 14, label: "每两周" },
												{ value: 30, label: "每月" },
											]}
										/>
									</Form.Item>
									<Form.Item label="重复次数">
										<Select
											style={{ width: 100 }}
											value={scheduleRepeats}
											onChange={setScheduleRepeats}
											options={[1, 2, 3, 5].map((value) => ({ value, label: `${value} 次` }))}
										/>
									</Form.Item>
									<Form.Item label="监测平台">
										<PlatformCheckboxes value={schedulePlatforms} onChange={setSchedulePlatforms} />
									</Form.Item>
									<Form.Item>
										<Button
											permission="monitor.schedule"
											variant="secondary"
											busy={busy}
											disabled={!schedulePlatforms.length}
											onClick={saveSchedule}
										>
											保存计划
										</Button>
									</Form.Item>
								</Form>
							</>
						),
					},
				]}
			/>
			{project.batches.length === 0 ? (
				<Empty title="还没有采集批次" detail="先在平台设置中配置并启用至少一个联网 API，再运行售前快审或正式基线。" />
			) : (
				<>
					<div className="batch-strip">
						{visibleBatches.map((item) => (
							<button
								type="button"
								className={selected === item.id ? "active" : ""}
								key={item.id}
								onClick={() => {
									setBatch(null);
									setTrends(null);
									setSelected(item.id);
								}}
							>
								<span>{batchKindLabel(item.kind)}</span>
								<strong>{date(item.created_at)}</strong>
								<small className={`status ${item.status}`}>{item.status}</small>
							</button>
						))}
					</div>
					<Pagination
						page={batchPage}
						pageSize={10}
						total={project.batches.length}
						totalPages={Math.max(1, Math.ceil(project.batches.length / 10))}
						onPage={setBatchPage}
					/>
					{batch && <BatchMetrics batch={batch} />}
					{trends && <TrendChart trends={trends} />}
				</>
			)}
		</Page>
	);
}
