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
	Anchor,
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
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button, useBatch, usePermission } from "../access";
import { api, post } from "../api";
import {
	type AgentRun,
	type Batch,
	batchKindLabel,
	type EvidenceIndexEntry,
	metricLabels,
	type Paginated,
	type Project,
	providerLabel,
	type ReportAnalysis,
	type ReportPayload,
	type ReportShare,
	type ReportSnapshot,
	type ReportWorkflowResult,
	type ReportWorkflowState,
	sourceLabels,
} from "../types";
import { useWorkspaceNavigation } from "../ui/navigation";
import {
	BatchPicker,
	batchStatusLabel,
	date,
	downloadText,
	Empty,
	EvidenceRef,
	IdChip,
	Notice,
	Pagination,
	percentage,
	SectionTitle,
} from "../ui/primitives";
import { BatchMetrics, ComparisonDeltaChart } from "./charts";
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
			<SectionTitle title="管理层摘要" />
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
			<div className="ds-darkstrip">
				<div className="dm">
					<span>品牌提及率</span>
					<b>{percentage(overall.brandMentionRate as number | undefined)}</b>
				</div>
				<div className="dm">
					<span>首位推荐率</span>
					<b>{percentage(overall.firstRecommendationRate as number | undefined)}</b>
				</div>
				<div className="dm">
					<span>官网引用率</span>
					<b>{percentage(overall.citationRate as number | undefined)}</b>
				</div>
				<div className="dm">
					<span>平均提及位置</span>
					<b>{typeof overall.averageMentionPosition === "number" ? overall.averageMentionPosition.toFixed(1) : "-"}</b>
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
							<strong>01 整改前后对比</strong>
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

export const agentToolLabels: Record<string, string> = {
	read_project_context: "读取项目",
	read_batch_evidence_index: "建立证据索引",
	read_evidence: "核验原始证据",
	submit_draft: "校验草稿",
};

export const agentStatusLabels: Record<AgentRun["status"], string> = {
	queued: "排队中",
	running: "分析中",
	awaiting_approval: "待审批",
	approved: "已批准",
	rejected: "已拒绝",
	failed: "执行失败",
};

const purposeLabels: Record<string, string> = {
	report_narrative: "报告叙述",
	quality_review: "质量检查",
	diagnosis: "模型诊断",
	remediation: "整改规划",
	content_brief: "内容草稿",
	optimization_article: "优化文章",
};

export function agentPurposeLabel(purpose: string): string {
	return purposeLabels[purpose] ?? purpose;
}

export function agentRunPhase(run: AgentRun): string {
	if (run.status === "queued") return run.error_message ?? "等待 Agent Worker 领取任务";
	if (run.status === "awaiting_approval") return "结构化草稿已完成，等待人工审批";
	if (run.status === "approved") return "草稿已批准，可冻结到新的报告版本";
	if (run.status === "rejected") return "草稿已拒绝，不会进入报告版本";
	if (run.status === "failed") return run.error_message ?? "Agent 执行失败";
	const latest = run.tool_trace.at(-1);
	if (!latest) return "正在连接模型并准备分析";
	if (latest.tool === "submit_draft" && latest.type === "end" && latest.isError)
		return "草稿校验未通过，Agent 正在修正后重新提交";
	if (latest.type === "start") return `正在${agentToolLabels[latest.tool] ?? latest.tool}`;
	if (latest.tool === "read_project_context") return "项目范围已确认，正在建立证据索引";
	if (latest.tool === "read_batch_evidence_index") return "证据索引已建立，正在选择支撑证据";
	if (latest.tool === "read_evidence") return "原始证据已读取，正在形成结论";
	return "正在整理结构化草稿";
}

export function agentRunDuration(run: AgentRun): string {
	const seconds = Math.max(
		0,
		Math.round((new Date(run.completed_at ?? Date.now()).getTime() - new Date(run.created_at).getTime()) / 1000),
	);
	return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatDraftValue(value: unknown): string {
	if (value == null) return "-";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map((item) => formatDraftValue(item)).join("；");
	const text = JSON.stringify(value) ?? "-";
	return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** 去掉平台附带的追踪片段（如 #ws_call_id=…），只显示可访问地址。 */
export const cleanSourceUrl = (url: string): string =>
	url.replace(/#(?:ws_call_id|call_id|ref|utm_[a-z]+)=[^#]*$/i, "").replace(/#$/, "");

const priorityLabels: Record<string, string> = { high: "高优先级", medium: "中优先级", low: "低优先级" };
const reputationLabels: Record<string, string> = {
	positive: "正面为主",
	mixed: "正负混合",
	negative: "负面为主",
	neutral: "中性",
	not_observed: "未观察到口碑",
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Purpose-specific approved schemas intentionally render in one auditable component.
export function AgentDraftContent({
	run,
	evidenceIndex,
	onOpenEvidence,
}: {
	run: AgentRun;
	evidenceIndex?: EvidenceIndexEntry[];
	onOpenEvidence?(captureId: string): void;
}) {
	if (!run.draft) return null;
	const refs = (ids: unknown) =>
		Array.isArray(ids) && ids.length ? (
			<EvidenceRef ids={ids.map(String)} index={evidenceIndex} onOpen={onOpenEvidence} compact />
		) : null;
	if (run.purpose === "report_narrative") {
		const limitations = Array.isArray(run.draft.limitations) ? run.draft.limitations.map(String) : [];
		const reputation = (run.draft.reputation ?? {}) as {
			overall?: string;
			summary?: string;
			positiveSignals?: Array<{ statement?: string; sourceUrls?: string[]; evidenceIds?: string[] }>;
			negativeSignals?: Array<{ statement?: string; sourceUrls?: string[]; evidenceIds?: string[] }>;
		};
		const recommendations = Array.isArray(run.draft.geoRecommendations)
			? (run.draft.geoRecommendations as Array<{
					priority?: string;
					title?: string;
					action?: string;
					rationale?: string;
					evidenceIds?: string[];
				}>)
			: [];
		const signals = [
			...(reputation.positiveSignals ?? []).map((signal) => ({ ...signal, polarity: "正面" })),
			...(reputation.negativeSignals ?? []).map((signal) => ({ ...signal, polarity: "负面" })),
		];
		return (
			<div className="agent-draft-content">
				<div>
					<span>报告摘要</span>
					<p>{String(run.draft.summary ?? "-")}</p>
				</div>
				<div>
					<span>管理层叙述</span>
					<p>{String(run.draft.executiveSummary ?? "-")}</p>
				</div>
				<div className="agent-reputation-preview">
					<span>AI 口碑 · {reputationLabels[reputation.overall ?? "not_observed"] ?? reputation.overall}</span>
					<p>{reputation.summary ?? "-"}</p>
					{signals.map((signal) => {
						const urls = [...new Set((signal.sourceUrls ?? []).map(cleanSourceUrl))];
						return (
							<div className="reputation-signal" key={`${signal.statement}-${urls.join("|")}`}>
								<Tag className={`reputation-polarity ${signal.polarity === "正面" ? "positive" : "negative"}`}>
									{signal.polarity}
								</Tag>
								<p>
									{signal.statement} {refs(signal.evidenceIds)}
								</p>
								<small>
									来源：
									{urls.length
										? urls.map((url) => (
												<a key={url} href={url} target="_blank" rel="noreferrer">
													{url.replace(/^https?:\/\//, "").slice(0, 60)}
												</a>
											))
										: "平台未开放来源"}
								</small>
							</div>
						);
					})}
				</div>
				{recommendations.length > 0 && (
					<div>
						<span>GEO 优化建议</span>
						<ol className="recommendation-list">
							{recommendations.map((item) => (
								<li key={`${item.title}-${item.action}`}>
									<b>
										<Tag>{priorityLabels[item.priority ?? ""] ?? item.priority}</Tag>
										{item.title}
									</b>
									<p>{item.action}</p>
									{item.rationale && <small>{item.rationale}</small>}
									{refs(item.evidenceIds)}
								</li>
							))}
						</ol>
					</div>
				)}
				{limitations.length > 0 && (
					<div>
						<span>证据局限</span>
						<ul>
							{limitations.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					</div>
				)}
			</div>
		);
	}
	if (run.purpose === "quality_review") {
		const issues = Array.isArray(run.draft.issues)
			? (run.draft.issues as Array<{ severity?: string; detail?: string }>)
			: [];
		return (
			<div className="agent-draft-content">
				<div>
					<span>检查结论 · {String(run.draft.verdict ?? "-")}</span>
					<p>{String(run.draft.summary ?? "-")}</p>
				</div>
				<div>
					<span>问题项 · {issues.length}</span>
					{issues.length ? (
						<ul>
							{issues.map((issue) => (
								<li key={`${issue.severity}:${issue.detail}`}>{issue.detail ?? "未说明"}</li>
							))}
						</ul>
					) : (
						<p>未发现需要阻止报告交付的问题。</p>
					)}
				</div>
			</div>
		);
	}
	return (
		<Descriptions
			className="agent-draft-descriptions"
			column={1}
			size="small"
			bordered
			items={Object.entries(run.draft).map(([key, value]) => ({
				key,
				label: key,
				children: formatDraftValue(value),
			}))}
		/>
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
type EvidenceIndexRow = Batch["captures"][number];

const DELTA_METRICS = [
	["品牌提及率", "brandMentionRate"],
	["首位推荐率", "firstRecommendationRate"],
	["官网引用率", "citationRate"],
] as const;

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
		title: "客户位置",
		key: "position",
		render: (_: unknown, row: PromptMatrixRow) => (
			<span className={`rank rank-${row.bestTargetPosition ?? "none"}`}>
				{row.bestTargetPosition ? `第 ${row.bestTargetPosition}` : "未出现"}
			</span>
		),
	},
	{
		title: "提及 / 首位",
		key: "rates",
		render: (_: unknown, row: PromptMatrixRow) =>
			`${percentage(row.targetMentionRate)} / ${percentage(row.firstRecommendationRate)}`,
	},
	{
		title: "竞品位置",
		key: "competitors",
		render: (_: unknown, row: PromptMatrixRow) =>
			row.competitors.map((competitor) => (
				<span className="competitor-rank" key={competitor.id}>
					{competitor.name}：{competitor.bestPosition ? `第 ${competitor.bestPosition}` : "未出现"}
				</span>
			)),
	},
	{ title: "来源", key: "sourceCount", dataIndex: "sourceCount" },
	{
		title: "样本",
		key: "samples",
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
				</span>
			)),
	},
];

const baselineDeltaColumns: TableProps<BaselineDeltaRow>["columns"] = [
	{ title: "平台", key: "platform", dataIndex: "platform" },
	{ title: "指标", key: "metric", dataIndex: "metric" },
	{ title: "基线", key: "before", dataIndex: "before" },
	{ title: "复测", key: "after", dataIndex: "after" },
	{
		title: "变化",
		key: "delta",
		render: (_: unknown, row: BaselineDeltaRow) => (
			<span className={row.positive ? "positive" : "negative"}>{row.hasDelta ? row.delta : "-"}</span>
		),
	},
];

const taskColumns: TableProps<TaskRow>["columns"] = [
	{ title: "整改项", key: "title", dataIndex: "title" },
	{
		title: "优先级",
		key: "priority",
		render: (_: unknown, task: TaskRow) => (task.priority === "high" ? "高" : "中"),
	},
	{ title: "状态", key: "status", dataIndex: "status" },
	{ title: "负责人", key: "owner", render: (_: unknown, task: TaskRow) => task.owner ?? "未分配" },
	{
		title: "发布与验收",
		key: "acceptance",
		render: (_: unknown, task: TaskRow) =>
			task.verified_snapshot_id ? "已验收" : task.published_url ? "待验收" : "未发布",
	},
];

const evidenceIndexColumns: TableProps<EvidenceIndexRow>["columns"] = [
	{
		title: "证据ID",
		key: "captureId",
		render: (_: unknown, capture: EvidenceIndexRow) => <code>{capture.captureId}</code>,
	},
	{
		title: "平台",
		key: "platform",
		render: (_: unknown, capture: EvidenceIndexRow) => providerLabel(capture.engine),
	},
	{ title: "问题", key: "prompt", dataIndex: "prompt" },
	{ title: "采样", key: "attempt", dataIndex: "attempt" },
	{ title: "状态", key: "status", dataIndex: "status" },
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
			<Table<ReportShare> rowKey="id" size="small" pagination={false} dataSource={shares} columns={columns} />
			<Pagination {...page} onPage={onPage} />
		</>
	);
}

type ReportDocContext = {
	batch: Batch;
	analysis: ReportAnalysis;
	report: ReportPayload;
	baselineBatch: Batch | null;
	openEvidence?(captureId: string): void;
};

type ReportDocColumnConfig = { number: string; title: string; content: ReactNode };

type ReportDocSectionConfig = {
	key: string;
	number?: string;
	title?: string;
	note?: ReactNode;
	extra?: ReactNode;
	className?: string;
	columns?: ReportDocColumnConfig[];
	content?: ReactNode;
	when?(context: ReportDocContext): boolean;
};

function ReportDocSection({ config }: { config: ReportDocSectionConfig }) {
	if (config.columns) {
		return (
			<div id={`report-section-${config.key}`} className="report-section split-report-section">
				{config.columns.map((column) => (
					<div key={column.number} id={`report-section-${config.key}-${column.number}`}>
						<div className="report-title-row">
							<div>
								<span>{column.number}</span>
								<h2>{column.title}</h2>
							</div>
						</div>
						{column.content}
					</div>
				))}
			</div>
		);
	}
	return (
		<div
			id={`report-section-${config.key}`}
			className={`report-section${config.className ? ` ${config.className}` : ""}`}
		>
			<div className="report-title-row">
				<div>
					{config.number ? <span>{config.number}</span> : null}
					<h2>{config.title}</h2>
				</div>
				{config.note ? <small>{config.note}</small> : null}
				{config.extra}
			</div>
			{config.content}
		</div>
	);
}

/** 报告正文目录：与 buildReportDocSections 的输出一一对应，columns 区块展开为子级锚点。 */
function reportDocAnchorItems(sections: ReportDocSectionConfig[]) {
	return sections.map((section) =>
		section.columns
			? {
					key: section.key,
					href: `#report-section-${section.key}`,
					title: `${section.columns[0].number} ${section.columns[0].title}`,
					children: section.columns.slice(1).map((column) => ({
						key: `${section.key}-${column.number}`,
						href: `#report-section-${section.key}-${column.number}`,
						title: `${column.number} ${column.title}`,
					})),
				}
			: {
					key: section.key,
					href: `#report-section-${section.key}`,
					title: section.number ? `${section.number} ${section.title}` : section.title,
				},
	);
}

function buildReportDocSections(context: ReportDocContext): ReportDocSectionConfig[] {
	const { batch, analysis, report, baselineBatch } = context;
	const websiteAudit = analysis.websiteAudit;
	const sourceRankings = analysis.sourceDomains.slice(0, 10).map((source, index) => (
		<div key={source.domain}>
			<span>{index + 1}</span>
			<b>{source.domain}</b>
			<small>{source.isOwned ? "客户官网" : `${source.category} · ${source.promptCount} 个问题`}</small>
			<strong>{source.citationCount}</strong>
		</div>
	));
	const perceptionExcerpts = analysis.perceptionExcerpts.map((excerpt) => (
		<blockquote key={`${excerpt.captureId}-${excerpt.text}`}>
			{excerpt.text}
			<footer>
				<EvidenceRef ids={[excerpt.captureId]} index={analysis.evidenceIndex} onOpen={context.openEvidence} />
			</footer>
		</blockquote>
	));
	const deltaRows: BaselineDeltaRow[] = baselineBatch
		? batch.config.platforms.flatMap((platform) => {
				const before = baselineBatch.metrics.perPlatform[platform];
				const after = batch.metrics.perPlatform[platform];
				return DELTA_METRICS.map(([label, key]) => {
					const beforeValue = before?.[key];
					const afterValue = after?.[key];
					const hasDelta = beforeValue != null && afterValue != null;
					return {
						key: `${platform}-${key}`,
						platform: providerLabel(platform),
						metric: label,
						before: percentage(beforeValue),
						after: percentage(afterValue),
						delta: hasDelta ? `${(((afterValue ?? 0) - (beforeValue ?? 0)) * 100).toFixed(1)} 个百分点` : "-",
						positive: (afterValue ?? 0) - (beforeValue ?? 0) >= 0,
						hasDelta,
					};
				});
			})
		: [];
	return [
		{
			key: "sampling",
			number: "01",
			title: "采样条件与平台表现",
			note: "所有条件写入冻结批次，不随项目后续编辑变化",
			content: (
				<>
					<dl className="report-facts">
						<div>
							<dt>平台</dt>
							<dd>{batch.config.platforms.join(" / ")}</dd>
						</div>
						<div>
							<dt>问题数</dt>
							<dd>{batch.config.prompts.length}</dd>
						</div>
						<div>
							<dt>每题重复</dt>
							<dd>{batch.config.repeats}</dd>
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
			),
		},
		{
			key: "prompt-matrix",
			number: "02",
			title: "逐问题竞争矩阵",
			note: "不是总分平均值，直接显示具体问题的输赢",
			content: (
				<Table<PromptMatrixRow>
					className="prompt-matrix"
					rowKey="promptId"
					size="small"
					pagination={false}
					dataSource={analysis.promptRows}
					columns={promptMatrixColumns}
				/>
			),
		},
		{
			key: "sources-perception",
			columns: [
				{
					number: "03",
					title: "引用信源榜",
					content: analysis.sourceDomains.length ? (
						<div className="source-ranking">{sourceRankings}</div>
					) : (
						<p className="muted">本批次回答没有展示可提取来源，系统没有补造引用。</p>
					),
				},
				{
					number: "04",
					title: "AI 如何描述品牌",
					content: analysis.perceptionExcerpts.length ? (
						<div className="perception-list">{perceptionExcerpts}</div>
					) : (
						<p className="muted">回答中没有可直接截取的品牌描述。</p>
					),
				},
			],
		},
		{
			key: "topic-coverage",
			number: "05",
			title: "客户、竞品与引用页主题覆盖",
			note: `客户页 ${analysis.webEvidenceSummary.customerPages} · 竞品页 ${analysis.webEvidenceSummary.competitorPages} · 引用页 ${analysis.webEvidenceSummary.citationPages}`,
			content: (
				<>
					{analysis.topicCoverage.some((row) => row.terms.length) ? (
						<Table<TopicCoverageRow>
							className="topic-coverage-table"
							rowKey="promptId"
							size="small"
							pagination={false}
							dataSource={analysis.topicCoverage}
							columns={topicCoverageColumns}
						/>
					) : (
						<p className="muted">当前问题没有已确认标签，系统不从问题文本猜测主题。</p>
					)}
					<p className="limitation">
						{analysis.webEvidenceSummary.customerPages
							? "这里是已保存网页快照的精确文本覆盖对比，用于定位可核验的内容缺口，不解释平台排序算法。"
							: "客户网页证据不足：系统尚未成功保存客户页面，因此只展示外部页面命中，不判定官网内容缺失。"}
					</p>
				</>
			),
		},
		{
			key: "website-audit",
			number: "06",
			title: "官网 GEO 技术基础",
			when: (current) => Boolean(current.analysis.websiteAudit),
			extra: websiteAudit ? <strong className="inline-score">{websiteAudit.result.score}/100</strong> : undefined,
			content: websiteAudit ? (
				<>
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
					<small>官网审计证据：{websiteAudit.id}</small>
				</>
			) : null,
		},
		{
			key: "baseline-delta",
			number: "07",
			title: "基线与复测变化",
			when: (current) => Boolean(current.baselineBatch),
			content: baselineBatch ? (
				<>
					<p>
						本次复测冻结并复用了基线批次 <code>{baselineBatch.id}</code>{" "}
						的客户、竞品、问题、平台、地区、重复次数和采集版本。
					</p>
					<Table<BaselineDeltaRow>
						rowKey="key"
						size="small"
						pagination={false}
						dataSource={deltaRows}
						columns={baselineDeltaColumns}
					/>
				</>
			) : null,
		},
		{
			key: "findings",
			number: baselineBatch ? "08" : "07",
			title: "证据诊断与整改路线",
			content: (
				<>
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
										index={analysis.evidenceIndex}
										onOpen={context.openEvidence}
										compact
									/>
								</small>
							</div>
						))
					) : (
						<p>报告已计算可见度与问题差距，但尚未把结论写入整改流程。进入“差距诊断”生成后即可转任务。</p>
					)}
					{report.tasks.length > 0 && (
						<Table<TaskRow>
							className="task-report-table"
							rowKey="id"
							size="small"
							pagination={false}
							dataSource={report.tasks}
							columns={taskColumns}
						/>
					)}
				</>
			),
		},
		{
			key: "attribution",
			number: baselineBatch ? "09" : "08",
			title: "真实业务结果",
			note: "与 AI 指标并列，不自动推断因果",
			content: report.attributionSummary.length ? (
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
			),
		},
		{
			key: "evidence-index",
			number: baselineBatch ? "10" : "09",
			title: "原始证据索引",
			content: (
				<Table<EvidenceIndexRow>
					className="evidence-index"
					rowKey="captureId"
					size="small"
					pagination={false}
					dataSource={batch.captures}
					columns={evidenceIndexColumns}
				/>
			),
		},
		{
			key: "limitations",
			title: "方法与局限",
			className: "limitation",
			content: (
				<p>
					联网 API
					的模型、索引与搜索策略属于平台黑盒，并具有随机性。报告仅描述冻结模型、问题集、地区和采样窗口下的真实结果；API
					回答不等同于对应 App 页面回答，也不证明单一整改与排名变化之间的因果关系。
				</p>
			),
		},
	];
}

// The printable document stays in one component so its section numbering and conditional retest blocks remain auditable.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: report composition intentionally mirrors the printed document
export function Report({ project }: { project: Project }) {
	const { selected, setSelected, batch } = useBatch(project);
	const navigation = useWorkspaceNavigation();
	const canGenerate = usePermission("report.generate");
	const canShare = usePermission("report.share");
	const [baselineBatch, setBaselineBatch] = useState<Batch | null>(null);
	const [report, setReport] = useState<ReportPayload | null>(null);
	const [reportError, setReportError] = useState<string | null>(null);
	const [snapshotsPage, setSnapshotsPage] = useState<Paginated<ReportSnapshot>>({
		items: [],
		page: 1,
		pageSize: 10,
		total: 0,
		totalPages: 1,
	});
	const snapshots = snapshotsPage.items;
	const [agentRunsPage, setAgentRunsPage] = useState<Paginated<AgentRun>>({
		items: [],
		page: 1,
		pageSize: 10,
		total: 0,
		totalPages: 1,
	});
	const agentRuns = agentRunsPage.items;
	const [reportBusy, setReportBusy] = useState<string | null>(null);
	const [workflowState, setWorkflowState] = useState<ReportWorkflowState | null>(null);
	const [shareUrl, setShareUrl] = useState<string | null>(null);
	const [sharesPage, setSharesPage] = useState<Paginated<ReportShare>>({
		items: [],
		page: 1,
		pageSize: 10,
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
		if (workflowState === "documents_queued" && latest?.pdf_artifact_key && latest.word_artifact_key)
			setWorkflowState("ready");
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
		setWorkflowState(null);
		setReport(null);
		setReportError(null);
		api<ReportPayload>(`/api/batches/${selected}/report`)
			.then(setReport)
			.catch((reason) => setReportError(reason instanceof Error ? reason.message : "报告分析加载失败"));
	}, [selected]);
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
		return <Empty title="还没有报告数据" detail="完成基线后可打印单批次报告；完成同条件复测后可展示前后变化。" />;
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
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Polling preserves each explicit server-side PDF terminal state for the user.
	async function createDocuments() {
		if (!latestSnapshot) return;
		setReportBusy("pdf");
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
			if (!result.artifactKey) throw new Error("Report Worker 尚未在 2 分钟内完成 PDF 与 Word");
			await loadSnapshots();
			window.open(`/artifacts/${result.artifactKey}`, "_blank", "noopener,noreferrer");
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
			await Promise.all([loadAgentRuns(), loadSnapshots()]);
		} catch (reason) {
			setReportError(reason instanceof Error ? reason.message : "报告工作流启动失败");
		} finally {
			setReportBusy(null);
		}
	}
	const awaitingApproval = agentRuns.some((run) => run.status === "awaiting_approval");
	const reportReady = Boolean(latestSnapshot?.pdf_artifact_key && latestSnapshot.word_artifact_key);
	const docSections =
		batch && analysis && report
			? buildReportDocSections({
					batch,
					analysis,
					report,
					baselineBatch,
					openEvidence: (captureId) => navigation.openEvidence(captureId, selected),
				}).filter((section) => section.when?.({ batch, analysis, report, baselineBatch }) ?? true)
			: [];
	const workflowLabel = awaitingApproval
		? "等待人工审批"
		: hasActiveAgentRuns
			? "Agent 处理中"
			: reportReady
				? "生成新报告版本"
				: workflowState === "quality_blocked"
					? "重试质量检查"
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
		{ title: "质量检查", status: approvedQuality ? "finish" : approvedNarrative ? "process" : "wait" },
		{ title: "冻结版本", status: latestSnapshot ? "finish" : approvedQuality ? "process" : "wait" },
		{ title: "PDF / Word", status: reportReady ? "finish" : latestSnapshot ? "process" : "wait" },
	] as const;
	return (
		<Page
			className="report"
			breadcrumb={project.name}
			eyebrow="复测报告"
			title="效果报告与交付"
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
							<AntdButton icon={<IconChevronDown size={15} />} iconPosition="end">
								交付
							</AntdButton>
						</Dropdown>
					)}
				</>
			}
		>
			<div className="report-workflow no-print">
				<Steps size="small" items={[...workflowSteps]} />
			</div>
			{reportError && <Alert type="error" showIcon message={reportError} />}
			{batch && analysis ? (
				<ReportExecutiveOverview batch={batch} analysis={analysis} baselineBatch={baselineBatch} />
			) : null}
			<section className="agent-activity no-print">
				<SectionTitle
					title="Agent 任务"
					count={
						hasActiveAgentRuns
							? `${agentRuns.filter((run) => run.status === "queued" || run.status === "running").length} 个进行中`
							: `${agentRuns.length} 条`
					}
					description="报告叙述与质量检查由内置 Agent 基于本批次证据生成；批准后自动进入下一步。"
				/>
				{agentRuns.length ? (
					<div className="agent-run-list">
						{agentRuns.slice(0, 8).map((run) => (
							<ReportAgentRun
								key={run.id}
								run={run}
								onApprove={async () => {
									const result = await post<{ workflow: ReportWorkflowResult | null }>(
										`/api/agent-runs/${run.id}/approve`,
									);
									setWorkflowState(result.workflow?.state ?? null);
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
					<p className="agent-activity-empty">当前批次暂无 Agent 任务。</p>
				)}
				<Pagination {...agentRunsPage} onPage={(page) => void loadAgentRuns(page)} />
			</section>
			{approvedNarrative && (
				<section className="approved-agent-report">
					<SectionTitle
						title="口碑检测与 GEO 优化意见"
						description="已批准的 Agent 结论；引用编号可点击跳转到证据中心核对原文。"
						extra={<Tag>{approvedQuality ? "质量校验通过" : "等待质量校验"}</Tag>}
					/>
					<AgentDraftContent
						run={approvedNarrative}
						evidenceIndex={analysis?.evidenceIndex}
						onOpenEvidence={(captureId) => navigation.openEvidence(captureId, selected)}
					/>
				</section>
			)}
			<section className="report-assets no-print">
				<SectionTitle title="报告版本与分享" description="冻结版本不可修改；分享链接可设置过期并随时撤销。" />
				{shareUrl && <Alert type="success" showIcon message={`分享链接已复制：${shareUrl}`} />}
				<Tabs
					className="report-assets-tabs"
					items={[
						{
							key: "assets",
							label: `资产 (${selectedSnapshots.length})`,
							children: (
								<SnapshotAssetTable
									snapshots={selectedSnapshots}
									page={snapshotsPage}
									onPage={(page) => void loadSnapshots(page)}
								/>
							),
						},
						{
							key: "shares",
							label: `分享 (${shares.length})`,
							children: (
								<ShareLinkTable
									shares={shares}
									latestSnapshotId={latestSnapshotId}
									page={sharesPage}
									onPage={(page) => {
										if (latestSnapshotId) void loadShares(latestSnapshotId, page);
									}}
									onRevoke={revokeShare}
								/>
							),
						},
					]}
				/>
			</section>
			{docSections.length ? (
				<div className="report-doc-layout">
					<div className="report-doc-main">
						{docSections.map((section) => (
							<ReportDocSection key={section.key} config={section} />
						))}
					</div>
					<aside className="report-doc-anchor no-print">
						<Anchor items={reportDocAnchorItems(docSections)} />
					</aside>
				</div>
			) : (
				<div className="center">
					<IconLoader2 className="spin" />
					正在从真实证据生成报告
				</div>
			)}
		</Page>
	);
}
