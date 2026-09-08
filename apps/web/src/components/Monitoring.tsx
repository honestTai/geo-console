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
	Form,
	Popover,
	Progress,
	Segmented,
	Select,
	Switch,
	Table,
	type TableProps,
	Tag,
	Timeline,
	type TimelineProps,
} from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, usePermission } from "../access";
import { api, post, put } from "../api";
import {
	type Batch,
	type BatchSummary,
	batchKindLabel,
	type Capture,
	type CostGroup,
	captureStatusLabel,
	DEFAULT_PAGE_SIZE,
	type DriftAlert,
	type MonitoringSchedule,
	type Paginated,
	type Project,
	type ProviderId,
	providerIds,
	providerLabel,
	providerShortLabel,
	type TrendResponse,
} from "../types";
import { batchStatusLabel, date, Empty, Pagination, percentage, SectionTitle, shortDate } from "../ui/primitives";
import { BatchMetrics, TrendChart } from "./charts";
import "./Monitoring.css";
import { Measurement } from "./Measurement";
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
	if (status === "partial") return "采集已结束 · 部分样本失败或未执行，已有证据保留";
	if (!active) return "采集已结束 · 语义解析状态请查看上方测量面板";
	return captured > 0 ? `采集中 · 已保存 ${captured} 条回答` : "任务已创建 · 等待采集";
}

export function captureLogMessage(capture: Capture): string {
	if (capture.status === "complete") return "回答与原始响应已保存";
	const label = captureStatusLabel(capture.status);
	return capture.failureMessage && capture.failureMessage !== label ? `${label} · ${capture.failureMessage}` : label;
}

const costOperationLabels: Record<string, string> = {
	hrouter_gpt: "GPT 分析",
};

/** 周期监测面板：启用开关 + 周期/重复次数/平台表单。 */
function SchedulePanel({
	schedule,
	enabled,
	onToggle,
	frequencyDays,
	onFrequencyChange,
	repeats,
	onRepeatsChange,
	platforms,
	onPlatformsChange,
	busy,
	onSave,
}: {
	schedule: MonitoringSchedule | null;
	enabled: boolean;
	onToggle(enabled: boolean): void;
	frequencyDays: number;
	onFrequencyChange(days: number): void;
	repeats: number;
	onRepeatsChange(repeats: number): void;
	platforms: ProviderId[];
	onPlatformsChange(platforms: ProviderId[]): void;
	busy: boolean;
	onSave(): void;
}) {
	const canSchedule = usePermission("monitor.schedule");
	return (
		<>
			<SectionTitle
				title={
					<>
						<IconChartLine size={16} /> 周期监测
					</>
				}
				description="按设定周期运行监测，使用届时已确认的问题和平台配置。"
				extra={
					<span className="schedule-summary">
						<Tag>{enabled ? "已启用" : "未启用"}</Tag>
						下一次运行 {date(schedule?.next_run_at)}
					</span>
				}
			/>
			<div className="schedule-section">
				<ScheduleFailureAlert schedule={schedule} />
				<p className="schedule-hint">
					<Switch
						disabled={!canSchedule || busy}
						checked={enabled}
						checkedChildren="启用"
						unCheckedChildren="停用"
						onChange={onToggle}
					/>
					{enabled ? "已启用自动监测" : "启用后按周期自动创建复测批次"}
				</p>
				<Form disabled={!canSchedule || busy} layout="inline" className="schedule-form">
					<Form.Item label="运行周期">
						<Select
							className="schedule-select"
							value={frequencyDays}
							onChange={onFrequencyChange}
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
							className="schedule-select"
							value={repeats}
							onChange={onRepeatsChange}
							options={[1, 2, 3, 5].map((value) => ({ value, label: `${value} 次` }))}
						/>
					</Form.Item>
					<Form.Item label="监测平台">
						<PlatformCheckboxes value={platforms} onChange={onPlatformsChange} />
					</Form.Item>
					<Form.Item>
						<Button
							permission="monitor.schedule"
							variant="secondary"
							busy={busy}
							disabled={!platforms.length}
							onClick={onSave}
						>
							保存计划
						</Button>
					</Form.Item>
				</Form>
			</div>
		</>
	);
}

/** 待处理漂移告警区块：无告警时不占位。 */
function DriftAlertSection({
	alerts,
	page,
	onPage,
	onAcknowledge,
}: {
	alerts: DriftAlert[];
	page: Paginated<DriftAlert>;
	onPage(page: number): void;
	onAcknowledge(alert: DriftAlert): void;
}) {
	if (alerts.length === 0) return null;
	const columns: TableProps<DriftAlert>["columns"] = [
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
				<Button permission="monitor.run" variant="ghost" onClick={() => onAcknowledge(alert)}>
					确认
				</Button>
			),
		},
	];
	return (
		<div className="monitor-alert-section">
			<SectionTitle
				title={
					<>
						<IconAlertTriangle size={16} /> 待处理漂移告警
					</>
				}
				count={alerts.length}
			/>
			<Table<DriftAlert> rowKey="id" size="small" columns={columns} dataSource={alerts} pagination={false} />
			<Pagination {...page} onPage={onPage} />
		</div>
	);
}

/** 调用成本面板：按平台与用途的请求/Token 汇总卡。 */
function CostsPanel({ costs }: { costs: CostGroup[] }) {
	return (
		<>
			<SectionTitle title="调用成本" description="按平台与用途汇总的请求次数与 Token；供应商未返回费用时不估算。" />
			{costs.length === 0 ? (
				<Empty title="还没有调用记录" detail="运行监测或 Agent 任务后，这里按平台与用途汇总请求次数与 Token。" />
			) : (
				<div className="cost-strip">
					{costs.map((group) => (
						<div key={`${group.providerId}-${group.operation}`}>
							<span>
								{costOperationLabels[group.providerId] ?? providerLabel(group.providerId)}
								{group.operation && group.operation !== "capture" ? ` · ${group.operation.replace("agent:", "")}` : ""}
							</span>
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
		</>
	);
}

/** 同配置趋势面板：未选批次或没有可比批次时给空态。 */
function TrendsPanel({ trends }: { trends: TrendResponse | null }) {
	if (!trends)
		return <Empty title="还没有同配置趋势" detail="请选择批次；只有问题和采样配置一致的记录才能比较趋势。" />;
	return <TrendChart trends={trends} />;
}

/** 周期监测“已启用”但到期未能创建批次时的提示：不能让计划静默空转几周。 */
function ScheduleFailureAlert({ schedule }: { schedule: MonitoringSchedule | null }) {
	if (!schedule?.enabled || !schedule.last_error) return null;
	const failures = schedule.failure_count ?? 0;
	return (
		<Alert
			type="warning"
			showIcon
			className="schedule-error"
			title={`周期监测已启用，但上次到期未能创建批次（${date(schedule.last_error_at)}${
				failures > 1 ? `，已连续失败 ${failures} 次` : ""
			}）：${schedule.last_error}。系统每小时重试一次；修正后重新保存计划可清除此提示。`}
		/>
	);
}

/** 批次条一页的卡片数：横向卡片比表格占地大，不沿用列表默认页长。 */
const BATCH_PAGE_SIZE = 10;
/** 批次列表的兜底刷新间隔：覆盖 Agent、周期监测或其他成员在本页停留期间创建的批次。 */
const BATCH_LIST_REFRESH_MS = 30_000;

export function RunCaptureLog({ captures, active }: { captures: Capture[]; active: boolean }) {
	if (!captures.length)
		return (
			<Timeline
				items={[
					{
						color: "gray",
						content: <span>{active ? "冻结批次配置，等待首条采集证据" : "当前批次没有可展示的采集日志"}</span>,
					},
				]}
			/>
		);
	const items: NonNullable<TimelineProps["items"]> = captures.map((capture) => ({
		color: "gray",
		content: (
			<span>
				<time>{formatClock(capture.capturedAt)}</time> · {providerShortLabel(capture.engine)} ·{" "}
				{captureLogMessage(capture)}
			</span>
		),
	}));
	if (!active)
		items.push({
			color: "gray",
			content: <span>采集结束 · 最近 {captures.length} 条记录；回答分析另行处理</span>,
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
	const queue = batch?.captureProgress;
	const settled = queue ? queue.completed + queue.failed : captured;
	const progress = expected > 0 ? Math.min(100, Math.round((settled / expected) * 100)) : active ? 4 : 100;
	const waiting = active && queue && !queue.active && queue.next_at && new Date(queue.next_at).getTime() > Date.now();
	const recentCaptures = [...(batch?.captures ?? [])]
		.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
		.slice(-6);
	const status = waiting
		? `本时段已完成 · 下次采样 ${date(queue.next_at)}（冻结采样计划，不是卡住）`
		: runActivityStatus(batchStatus, active, captured);
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
					<span className="status running">{waiting ? "等待下一采样时段" : "运行中"}</span>
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
			{Boolean(queue?.blockedProviders.length) && (
				<Alert
					showIcon
					type="warning"
					title={`${queue?.blockedProviders.map(providerShortLabel).join("、")}余额或额度不足`}
					description="该平台剩余采集已停止，其他平台继续运行。已保存的回答不受影响。充值后需手动重新运行。"
				/>
			)}
			{Boolean(queue?.failed) && (
				<p className="muted">{queue?.failed} 条任务未产生新采集证据，计入失败覆盖，不作为零分或成功样本。</p>
			)}
			<RunCaptureLog captures={recentCaptures} active={active} />
		</section>
	);
}

function useMonitoringBatch(selected: string | null) {
	const [batch, setBatch] = useState<Batch | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const controllerRef = useRef<AbortController | null>(null);
	const load = useCallback(async () => {
		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;
		if (!selected) return;
		try {
			const value = await api<Batch>(`/api/batches/${selected}`, { signal: controller.signal });
			if (controller.signal.aborted) return;
			setBatch(value);
			setLoadError(null);
		} catch (reason) {
			if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : "监测数据加载失败");
		}
	}, [selected]);
	const cancel = useCallback(() => controllerRef.current?.abort(), []);
	return { batch, setBatch, loadError, load, cancel };
}
function whenCurrent<T>(signal: AbortSignal, action: (value: T) => void) {
	return (value: T) => {
		if (!signal.aborted) action(value);
	};
}

function monitoringDefaults(project: Project) {
	const schedule = project.monitoringSchedule;
	const enabledPlatforms = project.enabledPlatforms ?? [];
	return {
		enabledPlatforms,
		schedulePlatforms: schedule?.platforms?.length ? schedule.platforms : enabledPlatforms,
		scheduleEnabled: schedule?.enabled ?? false,
		frequencyDays: schedule?.frequency_days ?? 7,
		scheduleRepeats: schedule?.repeats ?? 3,
	};
}

export function Monitoring({
	project,
	refresh,
	focusBatchId = null,
	onConsumeFocus,
}: {
	project: Project;
	refresh(): Promise<void>;
	/** 从工作台等处跳转时要选中的批次；它可能还不在 project.batches 的旧快照里。 */
	focusBatchId?: string | null;
	onConsumeFocus?(): void;
}) {
	const { message } = App.useApp();
	const defaults = monitoringDefaults(project);
	const [selected, setSelected] = useState(focusBatchId ?? project.batches[0]?.id ?? null);
	const [batchPage, setBatchPage] = useState(1);
	const visibleBatches = project.batches.slice((batchPage - 1) * BATCH_PAGE_SIZE, batchPage * BATCH_PAGE_SIZE);
	const { batch, setBatch, loadError, load, cancel } = useMonitoringBatch(selected);
	const [trends, setTrends] = useState<TrendResponse | null>(null);
	// 调用成本/周期监测/批次记录/同配置趋势分面板互斥展示，避免长页堆叠。
	const [panel, setPanel] = useState<"batches" | "trends" | "schedule" | "costs">("batches");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [alertsPage, setAlertsPage] = useState<Paginated<DriftAlert>>({
		items: [],
		page: 1,
		pageSize: DEFAULT_PAGE_SIZE,
		total: 0,
		totalPages: 1,
	});
	const alerts = alertsPage.items;
	const [costs, setCosts] = useState<CostGroup[]>([]);
	const [runPlatforms, setRunPlatforms] = useState<ProviderId[]>(defaults.enabledPlatforms);
	const [runRepeats, setRunRepeats] = useState(3);
	const [scheduleEnabled, setScheduleEnabled] = useState(defaults.scheduleEnabled);
	const [frequencyDays, setFrequencyDays] = useState(defaults.frequencyDays);
	const [schedulePlatforms, setSchedulePlatforms] = useState<ProviderId[]>(defaults.schedulePlatforms);
	const [scheduleRepeats, setScheduleRepeats] = useState(defaults.scheduleRepeats);
	const selectedBatch = project.batches.find((item) => item.id === selected);

	useEffect(() => {
		void load();
		const scope = new AbortController();
		api<Paginated<DriftAlert>>(
			`/api/projects/${project.id}/drift-alerts?page=${alertsPage.page}&pageSize=${alertsPage.pageSize}`,
			{ signal: scope.signal },
		)
			.then(whenCurrent(scope.signal, setAlertsPage))
			.catch(whenCurrent(scope.signal, () => setAlertsPage((current) => ({ ...current, items: [] }))));
		api<{ groups: CostGroup[] }>(`/api/projects/${project.id}/costs`, { signal: scope.signal })
			.then(whenCurrent(scope.signal, (result: { groups: CostGroup[] }) => setCosts(result.groups)))
			.catch(whenCurrent(scope.signal, () => setCosts([])));
		if (selected)
			api<TrendResponse>(`/api/projects/${project.id}/trends/${selected}`, { signal: scope.signal })
				.then(whenCurrent(scope.signal, setTrends))
				.catch(whenCurrent(scope.signal, () => setTrends(null)));
		const pollingMs = ["queued", "running"].includes(batch?.status ?? selectedBatch?.status ?? "") ? 3_000 : 8_000;
		const timer = window.setInterval(() => void load(), pollingMs);
		return () => {
			scope.abort();
			window.clearInterval(timer);
			cancel();
		};
	}, [alertsPage.page, alertsPage.pageSize, batch?.status, load, project.id, selected, selectedBatch?.status, cancel]);
	// 跳转带来的焦点批次：选中后即消费，避免下次进入本页仍被强制选中。
	useEffect(() => {
		if (!focusBatchId) return;
		setBatch(null);
		setTrends(null);
		setSelected(focusBatchId);
		setBatchPage(1);
		onConsumeFocus?.();
	}, [focusBatchId, onConsumeFocus, setBatch]);
	// 首次进入时还没有批次、随后由 Agent/周期任务创建了批次：自动选中最新一条。
	const firstBatchId = project.batches[0]?.id ?? null;
	useEffect(() => {
		if (!selected && firstBatchId) setSelected(firstBatchId);
	}, [selected, firstBatchId]);
	// 批次详情轮询到的状态与列表快照不一致（如排队中 → 已完成）时同步列表，让批次条的状态标签跟上。
	const detailStatus = batch?.status ?? null;
	const summaryStatus = selectedBatch?.status ?? null;
	useEffect(() => {
		if (detailStatus && summaryStatus && detailStatus !== summaryStatus) void refresh().catch(() => undefined);
	}, [detailStatus, summaryStatus, refresh]);
	useEffect(() => {
		const timer = window.setInterval(() => void refresh().catch(() => undefined), BATCH_LIST_REFRESH_MS);
		return () => window.clearInterval(timer);
	}, [refresh]);
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
	return (
		<Page
			breadcrumb={project.name}
			eyebrow="AI 监测"
			title="五平台联网监测"
			description="快审每题采 1 次，正式基线分三个时段采样；失败平台不计入分母。"
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
							title={selectedBatch?.kind !== "baseline" ? "请先选择一条正式基线" : undefined}
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
			{batch && <Measurement batch={batch} onRefresh={() => void load()} />}
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
			{(error || loadError) && <Alert className="monitor-error" type="error" showIcon title={error ?? loadError} />}
			<DriftAlertSection
				alerts={pendingAlerts}
				page={alertsPage}
				onPage={(page) => setAlertsPage((current) => ({ ...current, page }))}
				onAcknowledge={acknowledgeAlert}
			/>
			<Segmented
				className="monitor-panel-switch"
				value={panel}
				onChange={(value) => setPanel(value as typeof panel)}
				options={[
					{ value: "batches", label: `批次记录 ${project.batches.length || ""}` },
					{ value: "trends", label: "同配置趋势" },
					{ value: "schedule", label: "周期监测" },
					{ value: "costs", label: `调用成本 ${costs.length || ""}` },
				]}
			/>
			{panel === "costs" && <CostsPanel costs={costs} />}
			{panel === "schedule" && (
				<SchedulePanel
					schedule={project.monitoringSchedule}
					enabled={scheduleEnabled}
					onToggle={setScheduleEnabled}
					frequencyDays={frequencyDays}
					onFrequencyChange={setFrequencyDays}
					repeats={scheduleRepeats}
					onRepeatsChange={setScheduleRepeats}
					platforms={schedulePlatforms}
					onPlatformsChange={setSchedulePlatforms}
					busy={busy}
					onSave={saveSchedule}
				/>
			)}
			{panel === "batches" && (
				<>
					<SectionTitle
						title="批次记录"
						count={project.batches.length || undefined}
						description="复测沿用所选正式基线的采样配置。"
					/>
					{project.batches.length === 0 ? (
						<Empty
							title="还没有采集批次"
							detail="先在平台设置中配置并启用至少一个联网 API，再运行售前快审或正式基线。"
						/>
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
										<strong>{shortDate(item.created_at)}</strong>
										<small className={`status ${item.status}`}>{batchStatusLabel(item.status)}</small>
									</button>
								))}
							</div>
							<Pagination
								page={batchPage}
								pageSize={BATCH_PAGE_SIZE}
								total={project.batches.length}
								totalPages={Math.max(1, Math.ceil(project.batches.length / BATCH_PAGE_SIZE))}
								onPage={setBatchPage}
							/>
							{batch && <BatchMetrics batch={batch} />}
						</>
					)}
				</>
			)}
			{panel === "trends" && <TrendsPanel trends={trends} />}
		</Page>
	);
}
