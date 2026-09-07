import {
	IconAlertTriangle,
	IconCheck,
	IconChevronDown,
	IconDownload,
	IconFileText,
	IconLoader2,
	IconRoute,
} from "@tabler/icons-react";
import {
	Alert,
	Button as AntdButton,
	Descriptions,
	Dropdown,
	type MenuProps,
	Space,
	Steps,
	Table,
	type TableProps,
	Tabs,
	Tag,
} from "antd";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button, useBatch, usePermission } from "../access";
import { api, post } from "../api";
import {
	type AgentRun,
	agentStatusLabels,
	type Batch,
	batchKindLabel,
	captureStatusLabel,
	DEFAULT_PAGE_SIZE,
	type EvidenceIndexEntry,
	metricLabels,
	type Paginated,
	type PlatformMetrics,
	type Project,
	providerLabel,
	providerShortLabel,
	type ReportAnalysis,
	type ReportPayload,
	type ReportShare,
	type ReportSnapshot,
	type ReportWorkflowResult,
	type ReportWorkflowState,
	sourceCategoryLabel,
	sourceLabels,
	taskStatusLabel,
} from "../types";
import { MetricLabel } from "../ui/MetricLabel";
import { useWorkspaceNavigation } from "../ui/navigation";
import {
	BatchPicker,
	batchStatusLabel,
	date,
	downloadText,
	Empty,
	type EvidenceOpener,
	EvidenceRef,
	IdChip,
	Notice,
	Pagination,
	percentage,
	SectionTitle,
	shortDate,
} from "../ui/primitives";
import { AgentDraftContent, agentPurposeLabel, agentRunDuration, agentRunPhase, agentToolLabels } from "./AgentDraft";
import { BatchMetrics, ComparisonDeltaChart, platformUnavailable } from "./charts";
import { MeasurementExplanation } from "./MeasurementExplanation";
import { Page } from "./Page";
import "./Report.css";

export function ReportExecutiveOverview({
	batch,
	analysis,
	baselineBatch,
	pdfAction,
}: {
	batch: Batch;
	analysis: ReportAnalysis;
	baselineBatch: Batch | null;
	pdfAction?: ReactNode;
}) {
	const overall = batch.metrics.overall;
	return (
		<section className="report-executive-overview">
			<div className="executive-summary">
				<div>
					<h2>{analysis.executive.headline}</h2>
					<p className="ds-sub">{analysis.executive.summary}</p>
				</div>
				<div className={`evidence-level level-${analysis.executive.evidenceLevel}`}>
					<span>证据等级</span>
					<strong>{analysis.executive.evidenceLevel}</strong>
				</div>
			</div>
			<p className="validity-note">{analysis.executive.validityNote}</p>
			<MeasurementExplanation
				explanation={
					batch.measurement && ["queued", "running"].includes(batch.measurement.status)
						? null
						: (batch.metricExplanation ?? analysis.readerGuide)
				}
				batchId={batch.id}
			/>
			<div className="ds-darkstrip">
				<div className="dm">
					<MetricLabel metric="brandMentionRate" />
					<b>{percentage(overall.brandMentionRate as number | undefined)}</b>
				</div>
				<div className="dm">
					<MetricLabel metric="firstRecommendationRate" />
					<b>{percentage(overall.firstRecommendationRate as number | undefined)}</b>
				</div>
				<div className="dm">
					<MetricLabel metric="citationRate" />
					<b>{percentage(overall.citationRate as number | undefined)}</b>
				</div>
				<div className="dm">
					<MetricLabel metric="medianRecommendationRank" />
					<b>
						{typeof overall.medianRecommendationRank === "number" ? overall.medianRecommendationRank.toFixed(1) : "-"}
					</b>
				</div>
				<div className="dm">
					<span>有效样本</span>
					<b>
						{batch.metrics.validSamples}/{batch.metrics.expectedSamples}
					</b>
				</div>
			</div>
			{baselineBatch ? (
				<div className="report-card report-comparison-card">
					<div className="report-head">
						<div>
							<strong>整改前后对比</strong>
							<span>与基线使用完全相同的问法、平台与采样条件</span>
						</div>
						{pdfAction}
					</div>
					<ComparisonDeltaChart current={batch} baseline={baselineBatch} title="整改前后对比（百分点）" />
				</div>
			) : null}
		</section>
	);
}

export function ReportAgentRun({
	run,
	onApprove,
	onReject,
}: {
	run: AgentRun;
	onApprove(): Promise<void>;
	onReject(): Promise<void>;
}) {
	const failedChecks = run.tool_trace.filter((item) => item.type === "end" && item.isError);
	const active = run.status === "queued" || run.status === "running";
	const completedTrace = run.tool_trace.filter((item) => item.type === "end");
	const latestTrace = run.tool_trace.at(-1);
	const visibleTrace = latestTrace?.type === "start" ? [...completedTrace, latestTrace] : completedTrace;
	return (
		<article className={`agent-run agent-run-${run.status}`}>
			<div className="agent-run-status-icon" aria-hidden="true">
				{active ? (
					<IconLoader2 className="spin" size={18} />
				) : run.status === "failed" ? (
					<IconAlertTriangle size={18} />
				) : (
					<IconCheck size={18} />
				)}
			</div>
			<div className="agent-run-main">
				<header>
					<div>
						<b>{agentPurposeLabel(run.purpose)}</b>
						<span className={`agent-status status-${run.status}`}>{agentStatusLabels[run.status]}</span>
					</div>
					<small>
						{date(run.created_at)} · {agentRunDuration(run)}
					</small>
				</header>
				<p className="agent-phase">{agentRunPhase(run)}</p>
				<details className="agent-run-details" open={run.status === "failed"}>
					<summary>
						<IconChevronDown size={15} />
						运行详情
						{failedChecks.length > 0 && <span>{failedChecks.length} 次校验修正</span>}
					</summary>
					<div className="agent-run-facts">
						<span>
							模型 <b>{run.model}</b>
						</span>
						<span>
							尝试{" "}
							<b>
								{run.job_attempts ?? 0}/{run.job_max_attempts ?? 0}
							</b>
						</span>
						<span>
							Token <b>{run.usage?.totalTokens?.toLocaleString("zh-CN") ?? "运行中"}</b>
						</span>
					</div>
					{run.error_message && <Notice type="error" message={run.error_message} />}
					{visibleTrace.length > 0 && (
						<ol className="agent-tool-trace">
							{visibleTrace.map((trace) => (
								<li className={trace.isError ? "error" : ""} key={`${trace.at}-${trace.tool}-${trace.type}`}>
									<IconCheck size={14} />
									<div>
										<b>{agentToolLabels[trace.tool] ?? trace.tool}</b>
										<span>
											{trace.type === "start" ? "开始" : trace.isError ? "校验未通过" : "完成"} · {date(trace.at)}
										</span>
										{trace.detail && <p>{trace.detail}</p>}
									</div>
								</li>
							))}
						</ol>
					)}
					<AgentDraftContent run={run} />
				</details>
			</div>
			{run.status === "awaiting_approval" && (
				<div className="agent-run-actions">
					<Button permission="agent.approve" variant="ghost" onClick={() => void onReject()}>
						拒绝
					</Button>
					<Button permission="agent.approve" icon={<IconCheck size={16} />} onClick={() => void onApprove()}>
						批准
					</Button>
				</div>
			)}
		</article>
	);
}

type PromptMatrixRow = ReportAnalysis["promptRows"][number];
type TopicCoverageRow = ReportAnalysis["topicCoverage"][number];
type BaselineDeltaRow = {
	key: string;
	platform: string;
	metric: string;
	before: string;
	after: string;
	delta: string;
	positive: boolean;
	hasDelta: boolean;
};
type TaskRow = ReportPayload["tasks"][number];

const DELTA_METRICS = [
	["品牌提及率", "brandMentionRate"],
	["首位推荐率", "firstRecommendationRate"],
	["官网引用率", "citationRate"],
] as const;

function deltaRow(
	platform: string,
	label: string,
	key: (typeof DELTA_METRICS)[number][1],
	before: PlatformMetrics | undefined,
	after: PlatformMetrics | undefined,
	paired?: NonNullable<Batch["pairedComparison"]>[number]["result"],
): BaselineDeltaRow {
	const unavailable = platformUnavailable(before) || platformUnavailable(after) || !paired || paired.status !== "ready";
	const beforeValue = unavailable ? null : (paired?.previous ?? null);
	const afterValue = unavailable ? null : (paired?.current ?? null);
	const hasDelta = beforeValue !== null && afterValue !== null;
	const difference = hasDelta ? afterValue - beforeValue : 0;
	return {
		key: `${platform}-${key}`,
		platform: providerLabel(platform),
		metric: label,
		before: unavailable ? "不可用" : percentage(beforeValue),
		after: unavailable ? "不可用" : percentage(afterValue),
		delta: hasDelta
			? `${(difference * 100).toFixed(1)} 个百分点；95% 区间 ${paired?.interval?.map((v) => (v * 100).toFixed(1)).join(" – ") ?? "不足"}`
			: "-",
		positive: difference >= 0,
		hasDelta,
	};
}

/** 基线与复测逐平台指标差值；任一侧平台没有成功回答时整行标为不可用，不按 0 计算差值。 */
function buildDeltaRows(batch: Batch, baselineBatch: Batch): BaselineDeltaRow[] {
	return batch.config.platforms.flatMap((platform) =>
		DELTA_METRICS.map(([label, key]) =>
			deltaRow(
				platform,
				label,
				key,
				baselineBatch.metrics.perPlatform[platform],
				batch.metrics.perPlatform[platform],
				batch.pairedComparison?.find((p) => p.provider_id === platform && p.metric === key)?.result,
			),
		),
	);
}

const promptMatrixColumns: TableProps<PromptMatrixRow>["columns"] = [
	{
		title: "购买问题",
		key: "question",
		render: (_: unknown, row: PromptMatrixRow) => (
			<>
				<strong>{row.question}</strong>
				<br />
				<small className="muted">{row.intent}</small>
			</>
		),
	},
	{
		title: <MetricLabel metric="medianRecommendationRank" label="本题推荐名次中位数" />,
		key: "position",
		width: 96,
		render: (_: unknown, row: PromptMatrixRow) => (
			<span className={`rank rank-${row.bestTargetPosition ?? "none"}`}>
				{row.bestTargetPosition ? `第 ${row.bestTargetPosition}` : "无明确推荐名次"}
			</span>
		),
	},
	{
		title: (
			<>
				<MetricLabel metric="brandMentionRate" label="提及" /> /{" "}
				<MetricLabel metric="firstRecommendationRate" label="首位" />
			</>
		),
		key: "rates",
		width: 130,
		render: (_: unknown, row: PromptMatrixRow) =>
			`${percentage(row.targetMentionRate)} / ${percentage(row.firstRecommendationRate)}`,
	},
	{
		title: <MetricLabel metric="brandMentionRate" label="竞品提及情况" />,
		key: "competitors",
		render: (_: unknown, row: PromptMatrixRow) =>
			row.competitors.map((competitor) => (
				<span className="competitor-rank" key={competitor.id}>
					{competitor.name}：{percentage(competitor.mentionRate)}（未计算推荐名次）
				</span>
			)),
	},
	{
		title: (
			<MetricLabel
				label="来源记录数"
				help={{
					label: "来源记录数",
					meaning: "本题成功回答中返回的来源条目，包括最终引用和仅搜索记录。",
					formula: "本题各成功回答的来源条目数之和，同一网址在不同回答中出现会重复计数。",
					caution: "不是引用回答数，也不是独立网站数；请打开原回答区分最终引用。",
				}}
			/>
		),
		key: "sourceCount",
		dataIndex: "sourceCount",
		width: 90,
	},
	{
		title: <MetricLabel metric="captureCoverage" label="成功 / 计划" />,
		key: "samples",
		width: 80,
		render: (_: unknown, row: PromptMatrixRow) => `${row.completeSamples}/${row.plannedSamples}`,
	},
];

const topicCoverageColumns: TableProps<TopicCoverageRow>["columns"] = [
	{ title: "购买问题", key: "question", dataIndex: "question" },
	{
		title: "已确认主题",
		key: "terms",
		render: (_: unknown, row: TopicCoverageRow) => row.terms.map((term) => term.term).join("、") || "未设置标签",
	},
	{
		title: "客户已保存页面",
		key: "customer",
		render: (_: unknown, row: TopicCoverageRow) =>
			row.terms.map((term) => (
				<span className="coverage-state" key={term.term}>
					{term.term}：{term.customerEvidenceIds.length ? `${term.customerEvidenceIds.length} 页` : "未检出"}
					<EvidenceRef ids={term.customerEvidenceIds} index={[]} />
				</span>
			)),
	},
	{
		title: "竞品 / 引用页面",
		key: "external",
		render: (_: unknown, row: TopicCoverageRow) =>
			row.terms.map((term) => (
				<span className="coverage-state" key={term.term}>
					{term.term}：{term.externalEvidenceIds.length ? `${term.externalEvidenceIds.length} 页` : "未检出"}
					<EvidenceRef ids={term.externalEvidenceIds} index={[]} />
				</span>
			)),
	},
];

const baselineDeltaColumns: TableProps<BaselineDeltaRow>["columns"] = [
	{ title: "平台", key: "platform", dataIndex: "platform" },
	{ title: "指标", key: "metric", dataIndex: "metric", render: (label: string) => <MetricLabel label={label} /> },
	{ title: "基线", key: "before", dataIndex: "before" },
	{ title: "复测", key: "after", dataIndex: "after" },
	{
		title: "变化",
		key: "delta",
		render: (_: unknown, row: BaselineDeltaRow) => (
			<span className={row.hasDelta ? (row.positive ? "positive" : "negative") : "muted"}>
				{row.hasDelta ? row.delta : "不可比"}
			</span>
		),
	},
];

const taskColumns: TableProps<TaskRow>["columns"] = [
	{ title: "整改项", key: "title", dataIndex: "title" },
	{
		title: "优先级",
		key: "priority",
		width: 90,
		render: (_: unknown, task: TaskRow) => (task.priority === "high" ? "高" : task.priority === "low" ? "低" : "中"),
	},
	{ title: "状态", key: "status", width: 100, render: (_: unknown, task: TaskRow) => taskStatusLabel(task.status) },
	{ title: "负责人", key: "owner", width: 120, render: (_: unknown, task: TaskRow) => task.owner ?? "未分配" },
	{
		title: "发布与验收",
		key: "acceptance",
		width: 110,
		render: (_: unknown, task: TaskRow) =>
			task.verified_snapshot_id ? "已验收" : task.published_url ? "待验收" : "未发布",
	},
];

const snapshotColumns: TableProps<ReportSnapshot>["columns"] = [
	{
		title: "版本",
		key: "title",
		render: (_: unknown, snapshot: ReportSnapshot) => (
			<>
				<b>{snapshot.title}</b>
				<br />
				<small className="muted snapshot-meta">
					{date(snapshot.created_at)} <IdChip value={snapshot.payload_hash} label="版本指纹" length={10} />
				</small>
			</>
		),
	},
	{
		title: "操作",
		key: "actions",
		render: (_: unknown, snapshot: ReportSnapshot) => (
			<Space size={4} wrap>
				<AntdButton type="link" size="small" href={`/api/reports/${snapshot.id}/export.csv`}>
					CSV
				</AntdButton>
				<AntdButton
					type="link"
					size="small"
					onClick={() =>
						api(`/api/reports/${snapshot.id}`).then((value) =>
							downloadText(`${snapshot.title}.json`, JSON.stringify(value, null, 2), "application/json;charset=utf-8"),
						)
					}
				>
					JSON
				</AntdButton>
				{snapshot.pdf_artifact_key && (
					<AntdButton
						type="link"
						size="small"
						href={`/artifacts/${snapshot.pdf_artifact_key}`}
						target="_blank"
						rel="noreferrer"
					>
						查看 PDF
					</AntdButton>
				)}
				{snapshot.word_artifact_key && (
					<AntdButton type="link" size="small" href={`/artifacts/${snapshot.word_artifact_key}`}>
						下载 Word
					</AntdButton>
				)}
			</Space>
		),
	},
];

function shareStatus(share: ReportShare): { active: boolean; label: string } {
	const expired = new Date(share.expires_at).getTime() <= Date.now();
	if (share.revoked_at) return { active: false, label: "已撤销" };
	if (expired) return { active: false, label: "已过期" };
	return { active: true, label: "分享中" };
}

function SnapshotAssetTable({
	snapshots,
	page,
	onPage,
}: {
	snapshots: ReportSnapshot[];
	page: Paginated<ReportSnapshot>;
	onPage(page: number): void;
}) {
	if (!snapshots.length) return <p className="report-assets-empty">当前批次尚未冻结报告版本。</p>;
	return (
		<>
			<Table<ReportSnapshot>
				rowKey="id"
				size="small"
				pagination={false}
				dataSource={snapshots}
				columns={snapshotColumns}
				scroll={{ x: 560 }}
			/>
			<Pagination {...page} onPage={onPage} />
		</>
	);
}

function ShareLinkTable({
	shares,
	latestSnapshotId,
	page,
	onPage,
	onRevoke,
}: {
	shares: ReportShare[];
	latestSnapshotId: string | null;
	page: Paginated<ReportShare>;
	onPage(page: number): void;
	onRevoke(shareId: string): void;
}) {
	if (!latestSnapshotId || !shares.length) return <p className="report-assets-empty">当前批次暂无分享链接。</p>;
	const columns: TableProps<ReportShare>["columns"] = [
		{
			title: "状态",
			key: "status",
			render: (_: unknown, share: ReportShare) => {
				const status = shareStatus(share);
				return <Tag>{status.label}</Tag>;
			},
		},
		{
			title: "创建",
			key: "created",
			render: (_: unknown, share: ReportShare) => (
				<>
					{share.created_by_email ?? "系统"}
					<br />
					<small className="muted">创建 {date(share.created_at)}</small>
				</>
			),
		},
		{ title: "到期", key: "expires", render: (_: unknown, share: ReportShare) => date(share.expires_at) },
		{
			title: "操作",
			key: "actions",
			render: (_: unknown, share: ReportShare) =>
				shareStatus(share).active ? (
					<Button permission="report.share" variant="ghost" onClick={() => onRevoke(share.id)}>
						撤销
					</Button>
				) : null,
		},
	];
	return (
		<>
			<Table<ReportShare>
				rowKey="id"
				size="small"
				pagination={false}
				dataSource={shares}
				columns={columns}
				scroll={{ x: 520 }}
			/>
			<Pagination {...page} onPage={onPage} />
		</>
	);
}

/** 原始证据索引：编号、平台、问题、采样与来源，全部可读，不出现 UUID。 */
function EvidenceIndexTable({ entries, onOpen }: { entries: EvidenceIndexEntry[]; onOpen: EvidenceOpener }) {
	const [page, setPage] = useState(1);
	const pageSize = 15;
	const rows = entries.slice((page - 1) * pageSize, page * pageSize);
	const columns: TableProps<EvidenceIndexEntry>["columns"] = [
		{
			title: "编号",
			key: "n",
			width: 72,
			render: (_: unknown, entry: EvidenceIndexEntry) => (
				<EvidenceRef ids={[entry.id]} index={entries} onOpen={onOpen} compact />
			),
		},
		{
			title: "来源",
			key: "source",
			width: 190,
			render: (_: unknown, entry: EvidenceIndexEntry) =>
				entry.kind === "capture" ? providerLabel(entry.platform ?? "") : (entry.platformLabel ?? "网页快照"),
		},
		{
			title: "问题 / 页面",
			key: "subject",
			render: (_: unknown, entry: EvidenceIndexEntry) =>
				entry.kind === "capture" ? (
					entry.question
				) : entry.url ? (
					<a href={entry.url} target="_blank" rel="noreferrer">
						{entry.title ?? entry.url}
					</a>
				) : (
					(entry.title ?? "-")
				),
		},
		{
			title: "采样",
			key: "attempt",
			width: 150,
			render: (_: unknown, entry: EvidenceIndexEntry) =>
				entry.kind === "capture"
					? `第 ${entry.attempt ?? 1} 次 · ${shortDate(entry.capturedAt)}`
					: shortDate(entry.capturedAt),
		},
		{
			title: "状态",
			key: "status",
			width: 110,
			render: (_: unknown, entry: EvidenceIndexEntry) =>
				entry.status ? (
					<span className={entry.status === "complete" ? "" : "evidence-index-failed"}>
						{captureStatusLabel(entry.status)}
					</span>
				) : (
					"已存证"
				),
		},
		{
			title: "引用网址",
			key: "sources",
			width: 240,
			render: (_: unknown, entry: EvidenceIndexEntry) =>
				entry.sourceUrls.length ? (
					<span className="evidence-index-sources">
						<a href={entry.sourceUrls[0]} target="_blank" rel="noreferrer">
							{entry.sourceUrls[0].replace(/^https?:\/\//, "").slice(0, 40)}
						</a>
						{entry.sourceUrls.length > 1 && <small>等 {entry.sourceUrls.length} 个</small>}
					</span>
				) : entry.kind === "capture" ? (
					<span className="muted">未展示最终引用</span>
				) : (
					"-"
				),
		},
	];
	return (
		<>
			<Table<EvidenceIndexEntry>
				className="evidence-index"
				rowKey="id"
				size="small"
				pagination={false}
				dataSource={rows}
				columns={columns}
				scroll={{ x: 900 }}
			/>
			<Pagination
				page={page}
				pageSize={pageSize}
				total={entries.length}
				totalPages={Math.max(1, Math.ceil(entries.length / pageSize))}
				onPage={setPage}
			/>
		</>
	);
}

type ReportTabKey = "overview" | "narrative" | "details" | "actions" | "evidence" | "assets";

// The report page mirrors the frozen document but splits it into page-level tabs so each screen stays readable.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: report composition intentionally keeps workflow, tabs and document sections in one auditable component
export function Report({ project }: { project: Project }) {
	const { selected, setSelected, batch } = useBatch(project);
	const navigation = useWorkspaceNavigation();
	const canGenerate = usePermission("report.generate");
	const canShare = usePermission("report.share");
	const [tab, setTab] = useState<ReportTabKey>("overview");
	const [baselineBatch, setBaselineBatch] = useState<Batch | null>(null);
	const [report, setReport] = useState<ReportPayload | null>(null);
	const [reportLoading, setReportLoading] = useState(false);
	const [reportError, setReportError] = useState<string | null>(null);
	const [continuationWarning, setContinuationWarning] = useState<string | null>(null);
	const [snapshotsPage, setSnapshotsPage] = useState<Paginated<ReportSnapshot>>({
		items: [],
		page: 1,
		pageSize: DEFAULT_PAGE_SIZE,
		total: 0,
		totalPages: 1,
	});
	const snapshots = snapshotsPage.items;
	const [agentRunsPage, setAgentRunsPage] = useState<Paginated<AgentRun>>({
		items: [],
		page: 1,
		pageSize: DEFAULT_PAGE_SIZE,
		total: 0,
		totalPages: 1,
	});
	const agentRuns = agentRunsPage.items;
	const [reportBusy, setReportBusy] = useState<string | null>(null);
	const [workflowState, setWorkflowState] = useState<ReportWorkflowState | null>(null);
	const reportSelection = useRef<string | null>(null);
	const [documentNotice, setDocumentNotice] = useState<string | null>(null);
	const [shareUrl, setShareUrl] = useState<string | null>(null);
	const [sharesPage, setSharesPage] = useState<Paginated<ReportShare>>({
		items: [],
		page: 1,
		pageSize: DEFAULT_PAGE_SIZE,
		total: 0,
		totalPages: 1,
	});
	const shares = sharesPage.items;
	const latestSnapshotId = snapshots.find((item) => item.batch_id === selected)?.id ?? null;
	const loadSnapshots = useCallback(
		async (page = snapshotsPage.page) => {
			const params = new URLSearchParams({ page: String(page), pageSize: String(snapshotsPage.pageSize) });
			if (selected) params.set("batchId", selected);
			setSnapshotsPage(await api<Paginated<ReportSnapshot>>(`/api/projects/${project.id}/reports?${params}`));
		},
		[project.id, selected, snapshotsPage.page, snapshotsPage.pageSize],
	);
	const loadAgentRuns = useCallback(
		async (page = agentRunsPage.page) => {
			const params = new URLSearchParams({
				page: String(page),
				pageSize: String(agentRunsPage.pageSize),
				purposes: "report_narrative,quality_review",
			});
			if (selected) params.set("batchId", selected);
			setAgentRunsPage(await api<Paginated<AgentRun>>(`/api/projects/${project.id}/agent-runs?${params}`));
		},
		[agentRunsPage.page, agentRunsPage.pageSize, project.id, selected],
	);
	const loadShares = useCallback(
		async (reportId: string, page = sharesPage.page) => {
			setSharesPage(
				await api<Paginated<ReportShare>>(
					`/api/reports/${reportId}/shares?page=${page}&pageSize=${sharesPage.pageSize}`,
				),
			);
		},
		[sharesPage.page, sharesPage.pageSize],
	);
	useEffect(() => {
		void loadSnapshots().catch(() => setSnapshotsPage((current) => ({ ...current, items: [] })));
		void loadAgentRuns().catch(() => setAgentRunsPage((current) => ({ ...current, items: [] })));
	}, [loadSnapshots, loadAgentRuns]);
	const hasActiveAgentRuns = agentRuns.some((run) => run.status === "queued" || run.status === "running");
	useEffect(() => {
		if (workflowState !== "analysis_pending" || !selected) return;
		const controller = new AbortController();
		let busy = false;
		const poll = async () => {
			if (busy) return;
			busy = true;
			try {
				const result = await api<ReportWorkflowResult>(`/api/batches/${selected}/report-workflow`, {
					method: "POST",
					body: "{}",
					signal: controller.signal,
				});
				if (!controller.signal.aborted) {
					setWorkflowState(result.state);
					await Promise.all([loadAgentRuns(), loadSnapshots()]);
				}
			} catch (e) {
				if (!controller.signal.aborted) setReportError(e instanceof Error ? e.message : "报告流程状态获取失败");
			} finally {
				busy = false;
			}
		};
		const timer = window.setInterval(() => void poll(), 5000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [workflowState, selected, loadAgentRuns, loadSnapshots]);

	useEffect(() => {
		if (!hasActiveAgentRuns) return;
		const timer = window.setInterval(() => void loadAgentRuns().catch(() => undefined), 2_000);
		return () => window.clearInterval(timer);
	}, [hasActiveAgentRuns, loadAgentRuns]);
	const pendingDocumentSnapshot = snapshots.find(
		(item) => item.batch_id === selected && (!item.pdf_artifact_key || !item.word_artifact_key),
	);
	useEffect(() => {
		if (workflowState !== "documents_queued" || !pendingDocumentSnapshot) return;
		const timer = window.setInterval(() => void loadSnapshots().catch(() => undefined), 2_000);
		return () => window.clearInterval(timer);
	}, [workflowState, pendingDocumentSnapshot, loadSnapshots]);
	useEffect(() => {
		const latest = snapshots.find((item) => item.batch_id === selected);
		if (workflowState === "documents_queued" && latest?.pdf_artifact_key && latest.word_artifact_key) {
			setWorkflowState("ready");
			setDocumentNotice(null);
		}
	}, [workflowState, snapshots, selected]);
	useEffect(() => {
		setShareUrl(null);
		if (!latestSnapshotId) {
			setSharesPage((current) => ({ ...current, items: [] }));
			return;
		}
		void loadShares(latestSnapshotId).catch(() => setSharesPage((current) => ({ ...current, items: [] })));
	}, [latestSnapshotId, loadShares]);
	useEffect(() => {
		if (!selected) return;
		// 切换批次时保留上一份报告直到新数据到达，由 Page 的延迟 loading 覆盖，避免先清空再重绘的抖动。
		let cancelled = false;
		if (reportSelection.current !== selected) {
			setWorkflowState(null);
			reportSelection.current = selected;
		}
		setReportError(null);
		setDocumentNotice(null);
		setReportLoading(true);
		api<ReportPayload>(`/api/batches/${selected}/report`)
			.then((value) => {
				if (batch?.measurement?.snapshotId && value.metricSnapshotId !== batch.measurement.snapshotId)
					throw new Error("指标版本已变化，请刷新报告");
				if (!cancelled) setReport(value);
			})
			.catch((reason) => {
				if (!cancelled) setReportError(reason instanceof Error ? reason.message : "报告分析加载失败");
			})
			.finally(() => {
				if (!cancelled) setReportLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [selected, batch?.measurement?.snapshotId]);
	useEffect(() => {
		if (!batch?.compare_to_batch_id) {
			setBaselineBatch(null);
			return;
		}
		api<Batch>(`/api/batches/${batch.compare_to_batch_id}`)
			.then(setBaselineBatch)
			.catch(() => setBaselineBatch(null));
	}, [batch?.compare_to_batch_id]);
	if (!project.batches.length)
		return (
			<Page breadcrumb={project.name} eyebrow="复测报告" title="报告与交付" description="选择一个已完成批次生成报告">
				<Empty title="还没有报告数据" detail="完成基线后可打印单批次报告；完成同条件复测后可展示前后变化。" />
			</Page>
		);
	const analysis = report?.analysis;
	const selectedSnapshots = snapshots.filter((item) => item.batch_id === selected);
	const latestSnapshot = selectedSnapshots[0];
	const approvedNarrative = agentRuns.find((run) => run.purpose === "report_narrative" && run.status === "approved");
	const approvedQuality = agentRuns.find(
		(run) =>
			run.purpose === "quality_review" &&
			run.status === "approved" &&
			run.draft?.verdict === "pass" &&
			run.draft.reviewedNarrativeRunId === approvedNarrative?.id,
	);
	// 绑定当前叙述的质检被批准但结论是 blocked：叙述本身有问题，下一步是重新生成叙述而不是再质检一次。
	const qualityBlocked =
		workflowState === "quality_blocked" ||
		(!approvedQuality &&
			agentRuns.some(
				(run) =>
					run.purpose === "quality_review" &&
					run.status === "approved" &&
					run.draft?.verdict === "blocked" &&
					run.draft.reviewedNarrativeRunId === approvedNarrative?.id,
			));
	const openEvidence: EvidenceOpener = (id, kind) => navigation.openEvidence(id, selected, kind);
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Polling preserves each explicit server-side PDF terminal state for the user.
	async function createDocuments() {
		if (!latestSnapshot) return;
		setReportBusy("pdf");
		setReportError(null);
		setDocumentNotice(null);
		try {
			let result = await post<{ status: "ready" | "queued"; artifactKey: string | null }>(
				`/api/reports/${latestSnapshot.id}/pdf`,
			);
			for (let attempt = 0; result.status !== "ready" && attempt < 120; attempt += 1) {
				await new Promise((resolve) => window.setTimeout(resolve, 1_000));
				const status = await api<{
					status: "ready" | "queued" | "failed" | "missing";
					artifactKey: string | null;
					wordArtifactKey: string | null;
					error: string | null;
				}>(`/api/reports/${latestSnapshot.id}/pdf`);
				if (status.status === "failed" || status.status === "missing") throw new Error(status.error ?? "PDF 生成失败");
				result = { status: status.status === "ready" ? "ready" : "queued", artifactKey: status.artifactKey };
			}
			if (result.status !== "ready") {
				// 两分钟只是前台等待上限，任务仍在 Report Worker 排队/执行：交给快照轮询接手，不报成失败。
				setWorkflowState("documents_queued");
				setDocumentNotice("PDF 与 Word 仍在后台生成（Report Worker 排队或渲染中），完成后会自动出现在“版本与分享”里。");
				return;
			}
			await loadSnapshots();
			if (result.artifactKey) window.open(`/artifacts/${result.artifactKey}`, "_blank", "noopener,noreferrer");
		} catch (reason) {
			setReportError(reason instanceof Error ? reason.message : "报告文档生成失败");
		} finally {
			setReportBusy(null);
		}
	}
	async function createShare() {
		if (!latestSnapshot) return;
		setReportBusy("share");
		try {
			const result = await post<{ id: string; token: string }>(`/api/reports/${latestSnapshot.id}/shares`, {
				expiresInDays: 30,
			});
			const url = `${window.location.origin}/share/${result.token}`;
			setShareUrl(url);
			await navigator.clipboard?.writeText(url);
			await loadShares(latestSnapshot.id);
			setTab("assets");
		} catch (reason) {
			setReportError(reason instanceof Error ? reason.message : "分享链接创建失败");
		} finally {
			setReportBusy(null);
		}
	}
	async function advanceReport() {
		if (!batch) return;
		setReportBusy("workflow");
		setReportError(null);
		try {
			const result = await post<ReportWorkflowResult>(`/api/batches/${batch.id}/report-workflow`, {
				restart: Boolean(latestSnapshot?.pdf_artifact_key && latestSnapshot.word_artifact_key),
			});
			setWorkflowState(result.state);
			if (result.state === "analysis_unavailable") setReportError("回答分析证据不足，请在证据中心审核或重新解析");
			await Promise.all([loadAgentRuns(), loadSnapshots()]);
			setTab("narrative");
		} catch (reason) {
			setReportError(reason instanceof Error ? reason.message : "报告工作流启动失败");
		} finally {
			setReportBusy(null);
		}
	}
	const awaitingApproval = agentRuns.some((run) => run.status === "awaiting_approval");
	const reportReady = Boolean(latestSnapshot?.pdf_artifact_key && latestSnapshot.word_artifact_key);
	const workflowLabel =
		workflowState === "analysis_pending"
			? "等待回答分析"
			: workflowState === "analysis_unavailable"
				? "证据不足"
				: awaitingApproval
					? "等待人工审批"
					: hasActiveAgentRuns
						? "HRouter Agent 处理中"
						: reportReady
							? "生成新报告版本"
							: qualityBlocked
								? "质检未通过 · 重新生成叙述"
								: approvedNarrative && !approvedQuality
									? "继续质量检查"
									: "生成并校验报告";
	const deliveryMenuItems = [
		canGenerate
			? {
					key: "pdf",
					icon: <IconDownload size={15} />,
					label: "生成 PDF + Word",
					disabled: !latestSnapshot || reportBusy === "pdf",
				}
			: null,
		canShare
			? {
					key: "share",
					icon: <IconRoute size={15} />,
					label: "创建分享链接",
					disabled: !latestSnapshot || reportBusy === "share",
				}
			: null,
	].filter((item) => item !== null);
	const handleDeliveryMenuClick: MenuProps["onClick"] = ({ key }) => {
		if (key === "pdf") void createDocuments();
		if (key === "share") void createShare();
	};
	const revokeShare = (shareId: string) => {
		if (!latestSnapshot) return;
		void api(`/api/report-shares/${shareId}`, { method: "DELETE" }).then(() => loadShares(latestSnapshot.id));
	};
	const workflowSteps = [
		{ title: "报告叙述", status: hasActiveAgentRuns ? "process" : approvedNarrative ? "finish" : "wait" },
		{
			title: "质量检查",
			status: approvedQuality ? "finish" : qualityBlocked ? "error" : approvedNarrative ? "process" : "wait",
		},
		{ title: "冻结版本", status: latestSnapshot ? "finish" : approvedQuality ? "process" : "wait" },
		{ title: "PDF / Word", status: reportReady ? "finish" : latestSnapshot ? "process" : "wait" },
	] as const;
	const websiteAudit = analysis?.websiteAudit ?? null;
	const deltaRows: BaselineDeltaRow[] = batch && baselineBatch ? buildDeltaRows(batch, baselineBatch) : [];
	const evidenceEntries = analysis?.evidenceIndex ?? [];
	const tabItems = [
		{
			key: "overview",
			label: "总览",
			children:
				batch && analysis && report ? (
					<>
						<ReportExecutiveOverview batch={batch} analysis={analysis} baselineBatch={baselineBatch} />
						<SectionTitle title="采样条件与平台表现" description="所有条件写入冻结批次，不随项目后续编辑变化。" />
						<dl className="report-facts">
							<div>
								<dt>平台</dt>
								<dd>{batch.config.platforms.map((platform) => providerShortLabel(platform)).join(" / ")}</dd>
							</div>
							<div>
								<dt>问题数</dt>
								<dd>{batch.config.prompts.length}</dd>
							</div>
							<div>
								<dt>每题重复</dt>
								<dd>{batch.config.repeats} 次</dd>
							</div>
							<div>
								<dt>有效 / 失败</dt>
								<dd>
									{batch.metrics.validSamples} / {batch.metrics.failedSamples}
								</dd>
							</div>
						</dl>
						<BatchMetrics batch={batch} />
					</>
				) : null,
		},
		{
			key: "narrative",
			label: `口碑与建议${agentRuns.length ? ` (${agentRuns.length})` : ""}`,
			children: (
				<>
					<section className="agent-activity">
						<SectionTitle
							title="AI 分析任务"
							count={
								hasActiveAgentRuns
									? `${agentRuns.filter((run) => run.status === "queued" || run.status === "running").length} 个进行中`
									: `${agentRuns.length} 条`
							}
							description="报告解读与质量检查由 AI 助手 基于本批次证据生成；批准后自动进入下一步。"
						/>
						{agentRuns.length ? (
							<div className="agent-run-list">
								{agentRuns.slice(0, 8).map((run) => (
									<ReportAgentRun
										key={run.id}
										run={run}
										onApprove={async () => {
											const result = await post<{
												workflow: ReportWorkflowResult | null;
												workflowError?: string | null;
											}>(`/api/agent-runs/${run.id}/approve`);
											setWorkflowState(result.workflow?.state ?? null);
											setContinuationWarning(
												result.workflowError
													? `草稿已批准，但后续步骤尚未启动：${result.workflowError}。请由具备相应权限的成员继续。`
													: null,
											);
											await Promise.all([loadAgentRuns(), loadSnapshots()]);
										}}
										onReject={async () => {
											await post(`/api/agent-runs/${run.id}/reject`);
											await loadAgentRuns();
										}}
									/>
								))}
							</div>
						) : (
							<p className="agent-activity-empty">当前批次暂无 AI 分析任务，点击右上角“生成并校验报告”开始。</p>
						)}
						<Pagination {...agentRunsPage} onPage={(page) => void loadAgentRuns(page)} />
					</section>
					{approvedNarrative ? (
						<section className="approved-agent-report">
							<SectionTitle
								title="口碑检测与 GEO 优化意见"
								description="已批准的 HRouter Agent 结论；每条结论后的引用可点击跳转到证据中心核对原文。"
								extra={<Tag>{approvedQuality ? "质量校验通过" : "等待质量校验"}</Tag>}
							/>
							<AgentDraftContent
								run={approvedNarrative}
								evidenceIndex={analysis?.evidenceIndex}
								onOpenEvidence={openEvidence}
							/>
						</section>
					) : (
						<Empty
							compact
							title="还没有已批准的报告叙述"
							detail="叙述批准后，这里会显示口碑判断、正负信号、来源状态与 GEO 优化建议。"
						/>
					)}
				</>
			),
		},
		{
			key: "details",
			label: "数据明细",
			children: analysis ? (
				<>
					<SectionTitle title="逐问题竞争矩阵" description="不是总分平均值，直接显示具体问题的输赢。" />
					<Table<PromptMatrixRow>
						className="prompt-matrix"
						rowKey="promptId"
						size="small"
						pagination={false}
						dataSource={analysis.promptRows}
						columns={promptMatrixColumns}
						scroll={{ x: 820 }}
					/>
					<div className="split-report-section">
						<div>
							<SectionTitle
								title="最终引用信源"
								description="仅统计最终回答明确引用的来源；检索或浏览记录不计入引用次数。"
							/>
							{analysis.sourceDomains.length ? (
								<div className="source-ranking">
									{analysis.sourceDomains.slice(0, 10).map((source, index) => (
										<div key={source.domain}>
											<span>{index + 1}</span>
											<b>{source.domain}</b>
											<small>
												{source.isOwned
													? "客户官网"
													: `${sourceCategoryLabel(source.category)} · ${source.promptCount} 个问题`}
											</small>
											<strong>{source.citationCount}</strong>
										</div>
									))}
								</div>
							) : (
								<p className="muted">
									本批次没有可核验的最终引用。检索与浏览来源可在证据中心查看，系统不会把它们当成引用。
								</p>
							)}
						</div>
						<div>
							<SectionTitle title="AI 如何描述品牌" />
							{analysis.perceptionExcerpts.length ? (
								<div className="perception-list">
									{analysis.perceptionExcerpts.map((excerpt) => (
										<blockquote key={`${excerpt.captureId}-${excerpt.text}`}>
											{excerpt.text}
											<footer>
												<EvidenceRef ids={[excerpt.captureId]} index={analysis.evidenceIndex} onOpen={openEvidence} />
											</footer>
										</blockquote>
									))}
								</div>
							) : (
								<p className="muted">回答中没有可直接截取的品牌描述。</p>
							)}
						</div>
					</div>
					<SectionTitle
						title="客户、竞品与引用页主题覆盖"
						description={`客户页 ${analysis.webEvidenceSummary.customerPages} · 竞品页 ${analysis.webEvidenceSummary.competitorPages} · 引用页 ${analysis.webEvidenceSummary.citationPages}`}
					/>
					{analysis.topicCoverage.some((row) => row.terms.length) ? (
						<Table<TopicCoverageRow>
							className="topic-coverage-table"
							rowKey="promptId"
							size="small"
							pagination={false}
							dataSource={analysis.topicCoverage}
							columns={topicCoverageColumns}
							scroll={{ x: 760 }}
						/>
					) : (
						<p className="muted">当前问题没有已确认标签，系统不从问题文本猜测主题。</p>
					)}
					<p className="limitation">
						{analysis.webEvidenceSummary.customerPages
							? "这里是已保存网页快照的精确文本覆盖对比，用于定位可核验的内容缺口，不解释平台排序算法。"
							: "客户网页证据不足：系统尚未成功保存客户页面，因此只展示外部页面命中，不判定官网内容缺失。"}
					</p>
					{websiteAudit && (
						<>
							<SectionTitle
								title="官网 GEO 技术基础"
								extra={<strong className="inline-score">{websiteAudit.result.score}/100</strong>}
							/>
							<div className="report-audit-checks">
								{websiteAudit.result.checks
									.filter((check) => check.status !== "skip")
									.map((check) => (
										<div key={check.id}>
											<span className={`check-state ${check.status}`}>
												{check.status === "pass" ? "通过" : check.status === "fail" ? "失败" : "警告"}
											</span>
											<b>{check.label}</b>
											<p>{check.detail}</p>
										</div>
									))}
							</div>
							<small className="report-finding-meta">
								审计证据
								<EvidenceRef ids={[websiteAudit.id]} index={analysis.evidenceIndex} />
								{date(websiteAudit.result.checkedAt)}
							</small>
						</>
					)}
					{batch && baselineBatch && (
						<>
							<SectionTitle
								title="基线与复测变化"
								description={`本次复测冻结并复用了「${batchKindLabel(baselineBatch.kind)} · ${date(baselineBatch.created_at)}」的客户、竞品、问题、平台、地区、重复次数和采集版本。`}
							/>
							<Table<BaselineDeltaRow>
								rowKey="key"
								size="small"
								pagination={false}
								dataSource={deltaRows}
								columns={baselineDeltaColumns}
								scroll={{ x: 640 }}
							/>
						</>
					)}
				</>
			) : null,
		},
		{
			key: "actions",
			label: `诊断与整改${report ? ` (${report.findings.length + report.tasks.length})` : ""}`,
			children: report ? (
				<>
					<SectionTitle
						title="证据诊断"
						description="由确定性规则与已批准的 HRouter Agent 诊断得出；每条结论附引用证据。"
					/>
					{report.findings.length ? (
						report.findings.map((finding) => (
							<div className="report-finding" key={finding.id}>
								<span>{finding.category}</span>
								<b>{finding.title}</b>
								<p>{finding.detail}</p>
								<p className="report-recommendation">建议：{finding.recommendation}</p>
								<small className="report-finding-meta">
									证据充分度 {Math.round(finding.confidence * 100)}%
									<EvidenceRef
										ids={finding.evidence_ids}
										index={analysis?.evidenceIndex}
										onOpen={openEvidence}
										max={6}
									/>
								</small>
							</div>
						))
					) : (
						<p className="muted">
							报告已计算可见度与问题差距，但尚未把结论写入整改流程。进入“差距诊断”生成后即可转任务。
						</p>
					)}
					<SectionTitle title="整改路线" count={report.tasks.length} />
					{report.tasks.length ? (
						<Table<TaskRow>
							className="task-report-table"
							rowKey="id"
							size="small"
							pagination={false}
							dataSource={report.tasks}
							columns={taskColumns}
							scroll={{ x: 640 }}
						/>
					) : (
						<p className="muted">还没有整改任务；在“整改中心”从已批准诊断创建任务后会同步到报告。</p>
					)}
					<SectionTitle title="真实业务结果" description="与 AI 指标并列，不自动推断因果。" />
					{report.attributionSummary.length ? (
						<div className="report-attribution">
							{report.attributionSummary.map((item) => (
								<div key={`${item.source_type}-${item.metric}`}>
									<span>{sourceLabels[item.source_type] ?? item.source_type}</span>
									<strong>{item.value.toLocaleString("zh-CN")}</strong>
									<b>{metricLabels[item.metric] ?? item.metric}</b>
									<small>
										{item.observations} 条真实观察 · 至 {date(item.last_observed_at)}
									</small>
								</div>
							))}
						</div>
					) : (
						<p className="muted">尚未导入 GA4、Search Console、表单或电话数据，本报告不声称已经带来访问或咨询。</p>
					)}
				</>
			) : null,
		},
		{
			key: "evidence",
			label: `证据索引${evidenceEntries.length ? ` (${evidenceEntries.length})` : ""}`,
			children: (
				<>
					<SectionTitle
						title="原始证据索引"
						description="报告中的每个 [n] 引用都对应这里的一条证据；点击编号可在证据中心查看回答原文与原始响应。"
					/>
					{evidenceEntries.length ? (
						<EvidenceIndexTable entries={evidenceEntries} onOpen={openEvidence} />
					) : (
						<p className="muted">当前批次还没有可索引的证据。</p>
					)}
					<p className="limitation">
						联网 API
						的模型、索引与搜索策略属于平台黑盒，并具有随机性。报告仅描述冻结模型、问题集、地区和采样窗口下的真实结果；API
						回答不等同于对应 App 页面回答，也不证明单一整改与排名变化之间的因果关系。
					</p>
				</>
			),
		},
		{
			key: "assets",
			label: `版本与分享${selectedSnapshots.length ? ` (${selectedSnapshots.length})` : ""}`,
			children: (
				<section className="report-assets">
					{shareUrl && <Alert type="success" showIcon title={`分享链接已复制：${shareUrl}`} />}
					<SectionTitle
						title="报告版本"
						description="冻结版本不可修改；每个版本都带内容指纹，可导出 CSV、JSON、PDF 与 Word。"
					/>
					<SnapshotAssetTable
						snapshots={selectedSnapshots}
						page={snapshotsPage}
						onPage={(page) => void loadSnapshots(page)}
					/>
					<SectionTitle
						title="分享链接"
						description="分享链接默认 30 天过期，可随时撤销；对方无需登录即可查看冻结版本。"
					/>
					<ShareLinkTable
						shares={shares}
						latestSnapshotId={latestSnapshotId}
						page={sharesPage}
						onPage={(page) => {
							if (latestSnapshotId) void loadShares(latestSnapshotId, page);
						}}
						onRevoke={revokeShare}
					/>
				</section>
			),
		},
	];
	return (
		<Page
			className="report"
			breadcrumb={project.name}
			eyebrow="复测报告"
			title="报告与交付"
			loading={reportLoading}
			description={
				batch
					? `${batchKindLabel(batch.kind)} · ${date(batch.created_at)} · ${batchStatusLabel(batch.status)} · 有效样本 ${batch.metrics.validSamples}/${batch.metrics.expectedSamples}`
					: "选择一个已完成批次生成报告"
			}
			extra={
				<>
					<BatchPicker project={project} selected={selected} setSelected={setSelected} />
					<Button
						permission="report.generate"
						icon={<IconFileText size={17} />}
						busy={reportBusy === "workflow" || workflowState === "documents_queued" || hasActiveAgentRuns}
						disabled={!batch || hasActiveAgentRuns || awaitingApproval || ["queued", "running"].includes(batch.status)}
						onClick={advanceReport}
					>
						{workflowLabel}
					</Button>
					{deliveryMenuItems.length > 0 && (
						<Dropdown trigger={["click"]} menu={{ items: deliveryMenuItems, onClick: handleDeliveryMenuClick }}>
							<AntdButton icon={<IconChevronDown size={15} />} iconPlacement="end">
								交付
							</AntdButton>
						</Dropdown>
					)}
				</>
			}
		>
			<div className="report-workflow">
				<Steps size="small" items={[...workflowSteps]} />
			</div>
			{continuationWarning && (
				<Alert
					type="warning"
					showIcon
					title={continuationWarning}
					closable
					onClose={() => setContinuationWarning(null)}
				/>
			)}
			{reportError && <Alert type="error" showIcon title={reportError} />}
			{documentNotice && <Alert type="info" showIcon title={documentNotice} />}
			{qualityBlocked && !hasActiveAgentRuns && (
				<Alert
					type="warning"
					showIcon
					title="质量检查未通过：点击“重新生成叙述”会生成新的报告叙述并重新质检；已通过的旧版本不受影响。"
				/>
			)}
			{!report && !reportError ? (
				<div className="center report-loading-placeholder">
					<IconLoader2 className="spin" />
					正在从真实证据生成报告
				</div>
			) : (
				<Tabs
					className="report-tabs"
					activeKey={tab}
					onChange={(key) => setTab(key as ReportTabKey)}
					items={tabItems}
				/>
			)}
		</Page>
	);
}
