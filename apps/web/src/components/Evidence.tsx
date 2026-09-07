import { IconDownload, IconFileText, IconShieldCheck, IconWorldSearch } from "@tabler/icons-react";
import { Collapse, Segmented, Tag } from "antd";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button, useBatch } from "../access";
import { api } from "../api";
import { usePaginated } from "../hooks/usePagination";
import {
	type Capture,
	type Competitor,
	DEFAULT_PAGE_SIZE,
	type Paginated,
	type Project,
	providerIds,
	providerLabel,
	providerShortLabel,
	type WebSearchRecord,
	webSearchStatusLabels,
} from "../types";
import { answerInline, FormattedAnswer } from "../ui/markdown";
import type { EvidenceFocus } from "../ui/navigation";
import {
	BatchPicker,
	csvCell,
	date,
	downloadText,
	Empty,
	FilterBar,
	IdChip,
	Notice,
	Pagination,
	shortDate,
} from "../ui/primitives";
import "./Evidence.css";
import { AnswerAnalysis } from "./AnswerAnalysis";
import { Measurement } from "./Measurement";
import { Page } from "./Page";

export { answerInline, FormattedAnswer };

const PAGE_SIZE = DEFAULT_PAGE_SIZE;

type EvidenceKind = "captures" | "web_search" | "semantic";
const KIND_OPTIONS = [
	{ label: "AI 回答", value: "captures" },
	{ label: "联网搜索", value: "web_search" },
	{ label: "回答判断审核", value: "semantic" },
];

/** 判定提及时用的品牌口径：客户品牌 id 就是项目 id（与指标口径一致），竞品取批次冻结配置。 */
type BrandScope = { customerId: string; customerName: string; competitors: Competitor[] };

/**
 * 回答里的品牌命中按“客户品牌 / 竞品”拆开，避免把竞品的位置当成客户品牌的提及位置。
 */
function summarizeMentions(capture: Capture, brands: BrandScope) {
	const own = capture.brandMatches.filter((match) => match.brandId === brands.customerId);
	const competitorNames = new Map<string, string>();
	for (const match of capture.brandMatches) {
		if (match.brandId === brands.customerId || competitorNames.has(match.brandId)) continue;
		const competitor = brands.competitors.find((item) => item.id === match.brandId);
		competitorNames.set(match.brandId, competitor?.name ?? match.matchedAlias);
	}
	const positions = [...new Set(own.map((match) => match.position))].sort((left, right) => left - right);
	return {
		mentioned: own.length > 0,
		count: own.length,
		positions,
		bestPosition: positions[0] ?? null,
		competitors: [...competitorNames.values()],
	};
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 证据中心同时承载回答证据与联网搜索两类记录的定位、筛选与分页。
export function Evidence({
	project,
	focus = null,
	onConsumeFocus,
}: {
	project: Project;
	focus?: EvidenceFocus;
	onConsumeFocus?(): void;
}) {
	const [kind, setKind] = useState<EvidenceKind>(project.batches.length ? "captures" : "web_search");
	const [webFocusId, setWebFocusId] = useState<string | null>(null);
	const { selected, setSelected, batch } = useBatch(project, focus?.batchId ?? null);
	const [platform, setPlatform] = useState("all");
	const captures = useMemo(
		() => batch?.captures.filter((item) => platform === "all" || item.engine === platform) ?? [],
		[batch, platform],
	);
	const platformOptions = useMemo(
		() => [
			{ label: "全部", value: "all" },
			...[...new Set(batch?.config.platforms ?? providerIds)].map((id) => ({
				label: providerShortLabel(id),
				value: id,
			})),
		],
		[batch],
	);
	const [capturePage, setCapturePage] = useState(1);
	const [activeCaptureId, setActiveCaptureId] = useState<string | null>(null);
	// 从草稿/工作台的联网证据引用跳转过来：切到“联网搜索”分区并只显示该条记录。
	useEffect(() => {
		if (focus?.kind !== "web_search") return;
		setKind("web_search");
		setWebFocusId(focus.evidenceId);
		onConsumeFocus?.();
	}, [focus, onConsumeFocus]);
	// 从报告/诊断的证据引用跳转过来时定位到具体回答。
	useEffect(() => {
		if (!focus || focus.kind === "web_search") return;
		if (focus.batchId && focus.batchId !== selected) {
			setSelected(focus.batchId);
			return;
		}
		if (!batch || batch.id !== selected) return;
		const index = batch.captures.findIndex((item) => item.captureId === focus.evidenceId);
		if (index === -1) {
			const owner = project.batches.find((item) => item.id !== batch.id && focus.batchId === item.id);
			if (owner) setSelected(owner.id);
			return;
		}
		setKind("captures");
		setPlatform("all");
		setCapturePage(Math.floor(index / PAGE_SIZE) + 1);
		setActiveCaptureId(focus.evidenceId);
		onConsumeFocus?.();
	}, [focus, batch, selected, project.batches, setSelected, onConsumeFocus]);
	const visibleCaptures = captures.slice((capturePage - 1) * PAGE_SIZE, capturePage * PAGE_SIZE);
	const activeCapture = captures.find((item) => item.captureId === activeCaptureId) ?? visibleCaptures[0] ?? null;
	const brands: BrandScope = {
		customerId: project.id,
		customerName: project.name,
		competitors: batch?.config.competitors ?? project.competitors,
	};
	function pickPlatform(value: string) {
		setPlatform(value);
		setCapturePage(1);
		setActiveCaptureId(null);
	}
	function exportCsv() {
		const headers = [
			"证据ID",
			"平台",
			"问题",
			"采样次数",
			"状态",
			"回答",
			"最终引用URL",
			"检索或浏览来源URL",
			"平台检索拆解",
			"原始响应",
			"模型",
			"协议",
			"请求ID",
			"成本(微美元)",
			"采集时间",
			"失败原因",
		];
		const rows = captures.map((capture) => [
			capture.captureId,
			capture.engine,
			capture.prompt,
			capture.attempt,
			capture.status,
			capture.answerText,
			capture.sources
				.filter((source) => source.isCitation)
				.map((source) => source.url)
				.join("\n"),
			capture.sources
				.filter((source) => !source.isCitation)
				.map((source) => source.url)
				.join("\n"),
			capture.queryFanOut.join("\n"),
			capture.evidence.rawResponseObjectKey
				? `/artifacts/${capture.evidence.rawResponseObjectKey}`
				: capture.evidence.screenshotObjectKey
					? `/artifacts/${capture.evidence.screenshotObjectKey}`
					: "",
			capture.model,
			capture.protocol,
			capture.evidence.requestId,
			capture.costMicros,
			capture.capturedAt,
			capture.failureMessage,
		]);
		downloadText(
			`${project.name}-${selected ?? "证据"}.csv`,
			`﻿${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`,
			"text/csv;charset=utf-8",
		);
	}
	const kindSwitch = (
		<Segmented options={KIND_OPTIONS} value={kind} onChange={(value) => setKind(value as EvidenceKind)} />
	);
	if (kind === "semantic")
		return (
			<Page breadcrumb={project.name} eyebrow="证据中心" title="回答判断与人工审核">
				<FilterBar>
					{kindSwitch}
					<BatchPicker project={project} selected={selected} setSelected={setSelected} />
				</FilterBar>
				{batch ? (
					<Measurement key={batch.id} batch={batch} review />
				) : (
					<Empty title="请选择已有采集批次" detail="完成真实 API 采集后可查看和审核语义观察。" />
				)}
			</Page>
		);
	if (kind === "web_search")
		return (
			<Page
				breadcrumb={project.name}
				eyebrow="证据中心"
				title="联网搜索存证"
				description="Agent 每次联网搜索（含未触发与失败）都只追加记录；只有已完成的记录可被草稿引用。"
			>
				<FilterBar>{kindSwitch}</FilterBar>
				<WebSearchEvidence
					project={project}
					focusId={webFocusId}
					onClearFocus={() => setWebFocusId(null)}
					onConsumeFocus={onConsumeFocus}
				/>
			</Page>
		);
	if (!project.batches.length)
		return (
			<Page breadcrumb={project.name} eyebrow="证据中心" title="回答原文存证">
				<FilterBar>{kindSwitch}</FilterBar>
				<Empty title="还没有回答证据" detail="完成至少一个真实采集批次后，回答、来源和原始 API 响应会出现在这里。" />
			</Page>
		);
	return (
		<Page
			breadcrumb={project.name}
			eyebrow="证据中心"
			title="回答原文存证"
			description="原始回答与 API 响应写入后不可修改。"
			extra={
				<Button variant="secondary" icon={<IconDownload size={16} />} disabled={!captures.length} onClick={exportCsv}>
					导出证据 CSV
				</Button>
			}
		>
			<FilterBar extra={<span className="evidence-count">{captures.length ? `${captures.length} 条回答` : ""}</span>}>
				{kindSwitch}
				<BatchPicker
					project={project}
					selected={selected}
					setSelected={(id) => {
						setSelected(id);
						setCapturePage(1);
						setActiveCaptureId(null);
					}}
				/>
				<Segmented options={platformOptions} value={platform} onChange={(value) => pickPlatform(String(value))} />
			</FilterBar>
			{captures.length === 0 ? (
				<Empty title="批次尚无采集结果" detail="云端 Worker 可能仍在等待分时窗口，或平台配置需要处理。" />
			) : (
				<div className="evidence-layout">
					<div className="evidence-list">
						{visibleCaptures.map((capture) => {
							const mention = summarizeMentions(capture, brands);
							return (
								<button
									type="button"
									className={`evidence-card ${activeCapture?.captureId === capture.captureId ? "selected" : ""}`}
									key={capture.captureId}
									onClick={() => setActiveCaptureId(capture.captureId)}
								>
									<span className="evidence-card-head">
										<span className="ev-platform">{providerShortLabel(capture.engine)}</span>
										<span className="ev-meta">
											第 {capture.attempt} 次 · {shortDate(capture.capturedAt)}
										</span>
									</span>
									<strong>{capture.prompt}</strong>
									<span className={`ev-result ${capture.status === "complete" ? "ok" : "fail"}`}>
										{capture.status === "complete"
											? mention.mentioned
												? `提及客户品牌 · 位置 ${mention.bestPosition}`
												: mention.competitors.length
													? `未提及客户品牌 · 仅竞品 ${mention.competitors.join("、")}`
													: "未提及客户品牌"
											: `采集失败 · ${capture.failureMessage ?? capture.status}`}
									</span>
								</button>
							);
						})}
						<Pagination
							page={capturePage}
							pageSize={PAGE_SIZE}
							total={captures.length}
							totalPages={Math.max(1, Math.ceil(captures.length / PAGE_SIZE))}
							onPage={(page) => {
								setCapturePage(page);
								setActiveCaptureId(null);
							}}
						/>
					</div>
					<div className="evidence-detail-pane">
						{activeCapture ? (
							<EvidenceDetail capture={activeCapture} brands={brands} batchId={batch?.id} />
						) : (
							<Empty compact title="选择一条回答" detail="左侧点击任意回答查看原文、来源和原始响应。" />
						)}
					</div>
				</div>
			)}
		</Page>
	);
}

/** 联网搜索分区：左侧记录列表（服务端分页），右侧归纳文本、来源与检索拆解；从引用跳转时只显示被引用的那条。 */
function WebSearchEvidence({
	project,
	focusId,
	onClearFocus,
	onConsumeFocus,
}: {
	project: Project;
	focusId: string | null;
	onClearFocus(): void;
	onConsumeFocus?(): void;
}) {
	const page = usePaginated<WebSearchRecord>(
		(pageNumber, pageSize) => {
			const params = new URLSearchParams({ page: String(pageNumber), pageSize: String(pageSize) });
			if (focusId) params.set("id", focusId);
			return api<Paginated<WebSearchRecord>>(`/api/projects/${project.id}/web-searches?${params}`);
		},
		[project.id, focusId],
	);
	const [activeId, setActiveId] = useState<string | null>(null);
	const active = page.items.find((item) => item.id === activeId) ?? page.items[0] ?? null;
	useEffect(() => {
		if (focusId) onConsumeFocus?.();
	}, [focusId, onConsumeFocus]);
	if (!page.loading && !page.items.length)
		return (
			<Empty
				title={focusId ? "没有找到这条联网搜索记录" : "还没有联网搜索记录"}
				detail={
					focusId
						? "记录可能属于其他客户或已不存在。"
						: "在 AI 工作台让 Agent 联网出题，或建档分析核实竞品后，每次联网搜索都会出现在这里。"
				}
				action={
					focusId ? (
						<Button variant="secondary" onClick={onClearFocus}>
							显示全部记录
						</Button>
					) : undefined
				}
			/>
		);
	return (
		<>
			{focusId && <Notice message={`正在显示被引用的一条联网搜索记录。`} />}
			<div className="evidence-layout">
				<div className="evidence-list">
					{page.items.map((record) => (
						<button
							type="button"
							className={`evidence-card ${active?.id === record.id ? "selected" : ""}`}
							key={record.id}
							onClick={() => setActiveId(record.id)}
						>
							<span className="evidence-card-head">
								<span className="ev-platform">
									<IconWorldSearch size={12} /> 联网搜索
								</span>
								<span className="ev-meta">{shortDate(record.created_at)}</span>
							</span>
							<strong>{record.query}</strong>
							<span className={`ev-result ${record.status === "complete" ? "ok" : "fail"}`}>
								{record.status === "complete"
									? `${webSearchStatusLabels[record.status]} · ${record.sources.length} 个来源`
									: `${webSearchStatusLabels[record.status] ?? record.status}${record.failure_message ? ` · ${record.failure_message}` : ""}`}
							</span>
						</button>
					))}
					{focusId ? (
						<Button variant="link" size="small" onClick={onClearFocus}>
							显示全部记录
						</Button>
					) : (
						<Pagination {...page} onPage={(next) => void page.reload(next)} onPageSize={page.setPageSize} />
					)}
				</div>
				<div className="evidence-detail-pane">
					{active ? (
						<WebSearchDetail record={active} />
					) : (
						<Empty compact title="选择一条记录" detail="左侧点击任意联网搜索查看归纳文本与来源。" />
					)}
				</div>
			</div>
		</>
	);
}

function WebSearchDetail({ record }: { record: WebSearchRecord }) {
	const panels: EvidencePanel[] = [];
	if (record.answer_text)
		panels.push({
			key: "answer",
			label: `归纳文本（${record.answer_text.length} 字）`,
			children: (
				<div className="ed-answer-scroll">
					<FormattedAnswer value={record.answer_text} />
				</div>
			),
		});
	if (record.sources.length || record.search_queries.length)
		panels.push({
			key: "sources",
			label: `来源与检索拆解（来源 ${record.sources.length} 条）`,
			children: (
				<>
					{record.sources.length > 0 && (
						<div className="sources">
							<b>来源网址</b>
							{record.sources.map((source, index) => (
								<a href={source.url} target="_blank" rel="noreferrer" key={source.url}>
									{index + 1}. {source.title ?? source.url}
								</a>
							))}
						</div>
					)}
					{record.search_queries.length > 0 && (
						<div className="query-fanout">
							<b>实际检索词</b>
							<div>
								{record.search_queries.map((query) => (
									<span key={query}>{query}</span>
								))}
							</div>
						</div>
					)}
				</>
			),
		});
	return (
		<article className="evidence-detail">
			<div className="ed-head">
				<div className="ed-head-text">
					<span className="ev-platform">联网搜索 · HRouter</span>
					<strong>{record.query}</strong>
					<span className="ed-time">
						搜索于 {date(record.created_at)} · {record.model}
						{record.latency_ms ? ` · ${(record.latency_ms / 1000).toFixed(1)} 秒` : ""}
					</span>
				</div>
				<div className="ed-ids">
					<Tag className="ev-status-tag">{webSearchStatusLabels[record.status] ?? record.status}</Tag>
					<IdChip value={record.id} label="证据" />
					{record.session_id && <IdChip value={record.session_id} label="会话" />}
					{record.agent_run_id && <IdChip value={record.agent_run_id} label="草稿" />}
				</div>
			</div>
			{panels.length ? (
				<Collapse className="ed-collapse" defaultActiveKey={["answer", "sources"]} items={panels} />
			) : (
				<Notice type="error" message={record.failure_message ?? "本次联网搜索没有可展示的结果"} />
			)}
			<div className="ed-foot">
				<span className="ed-status">
					结论：
					{record.status === "complete"
						? "搜索已触发并返回归纳文本，可被草稿引用"
						: `${webSearchStatusLabels[record.status] ?? record.status}，不可被草稿引用`}
				</span>
				<span className="ed-tags">
					{record.failure_message ? record.failure_message : `实际检索 ${record.search_queries.length} 次`}
				</span>
			</div>
		</article>
	);
}

type EvidencePanel = { key: string; label: string; children: ReactNode };

function answerPanel(answerText: string): EvidencePanel {
	return {
		key: "answer",
		label: `回答原文（${answerText.length} 字）`,
		children: (
			<div className="ed-answer-scroll">
				<FormattedAnswer value={answerText} />
			</div>
		),
	};
}

function hasRawEvidence(capture: Capture): boolean {
	return (
		capture.sources.length > 0 ||
		capture.queryFanOut.length > 0 ||
		Boolean(capture.evidence.rawResponseObjectKey || capture.evidence.screenshotObjectKey)
	);
}

function RawEvidencePanel({ capture }: { capture: Capture }) {
	return (
		<>
			{capture.sources.length > 0 && (
				<div className="sources">
					<b>观察来源（最终引用与检索浏览分开标记）</b>
					{capture.sources.map((source) => (
						<a href={source.url} target="_blank" rel="noreferrer" key={`${source.position}-${source.url}`}>
							{source.position}. {source.title ?? source.domain}
							<Tag color={source.isCitation ? "green" : undefined}>
								{source.isCitation ? "最终回答引用" : "检索/浏览，未引用"}
							</Tag>
						</a>
					))}
				</div>
			)}
			{capture.sourceVisibility === "unavailable" && (
				<p className="muted">该平台本次未开放来源数据，引用率记为不可用，不按 0 计算。</p>
			)}
			{capture.queryFanOut.length > 0 && (
				<div className="query-fanout">
					<b>平台检索拆解</b>
					<div>
						{capture.queryFanOut.map((query) => (
							<span key={query}>{query}</span>
						))}
					</div>
				</div>
			)}
			{(capture.evidence.rawResponseObjectKey || capture.evidence.screenshotObjectKey) && (
				<a
					className="screenshot-link"
					href={`/artifacts/${capture.evidence.rawResponseObjectKey ?? capture.evidence.screenshotObjectKey}`}
					target="_blank"
					rel="noreferrer"
				>
					<IconFileText size={16} />
					{capture.captureMode === "llm_search_api" ? "查看原始 API 响应" : "查看历史页面截图"}
				</a>
			)}
		</>
	);
}

export function EvidenceDetail({
	capture,
	brands,
	batchId,
}: {
	capture: Capture;
	brands: BrandScope;
	batchId?: string;
}) {
	const mention = summarizeMentions(capture, brands);
	const panels: EvidencePanel[] = [];
	if (capture.answerText) panels.push(answerPanel(capture.answerText));
	if (hasRawEvidence(capture))
		panels.push({
			key: "raw",
			label: `来源与检索过程（观察 ${capture.sources.length} 条 · 最终引用 ${capture.sources.filter((source) => source.isCitation).length} 条）`,
			children: <RawEvidencePanel capture={capture} />,
		});
	return (
		<article className="evidence-detail">
			<div className="ed-head">
				<div className="ed-head-text">
					<span className="ev-platform">{providerLabel(capture.engine)}</span>
					<strong>{capture.prompt}</strong>
					<span className="ed-time">
						采集于 {date(capture.capturedAt)} · 第 {capture.attempt} 次采样 · {capture.model ?? "历史页面"} ·{" "}
						{capture.protocol ?? capture.captureMode}
					</span>
				</div>
				<div className="ed-ids">
					<IdChip value={capture.captureId} label="证据" />
					{capture.evidence.requestId && (
						<span className="ed-hash" title="供应商请求 ID，用于向平台追溯本次回答">
							<IconShieldCheck size={12} />
							<IdChip value={capture.evidence.requestId} label="请求" length={10} />
						</span>
					)}
				</div>
			</div>
			{batchId && capture.status === "complete" && capture.captureMode === "llm_search_api" && capture.answerText && (
				<AnswerAnalysis key={`${batchId}:${capture.captureId}`} batchId={batchId} capture={capture} />
			)}
			{capture.answerText ? (
				<Collapse className="ed-collapse" defaultActiveKey={["answer"]} items={panels} />
			) : (
				<Notice type="error" message={capture.failureMessage ?? "本次采集没有回答"} />
			)}
			<div className="ed-foot">
				<span className="ed-status">
					结论：
					{capture.status === "complete"
						? mention.mentioned
							? `${brands.customerName} 被提及 ${mention.count} 次`
							: `回答未提及 ${brands.customerName}`
						: (capture.failureMessage ?? "本次采集未完成")}
				</span>
				<span className="ed-tags">
					{mention.mentioned ? `提及位置 ${mention.positions.join("、")}` : "未提及"}
					{mention.competitors.length > 0 ? ` · 同时出现竞品 ${mention.competitors.join("、")}` : ""}
					{capture.sources.length > 0
						? ` · 观察来源 ${capture.sources.length} 条，最终引用 ${capture.sources.filter((source) => source.isCitation).length} 条`
						: ""}
					{capture.evidence.rawResponseObjectKey || capture.evidence.screenshotObjectKey ? " · 原文已存证" : ""}
				</span>
			</div>
		</article>
	);
}
